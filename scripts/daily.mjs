// 每天早上：抓近 3 天公开新闻 → AI 只能引用这些新闻挑出与他相关的事、拆声明 → 代码按来源数定级 → AI 分析 → 写入 data/items.json
// 若配置开启 use_search 且 Gemini 搜索额度可用，则改用 Google 搜索核查
import { readJson, writeJson, todayBJ, addDays, curProfile, profileText, gemini, PROMPT_V, LEVEL_RULES, analyzePrompt, feedbackText, cleanClaims, cleanAnalysis, capActions, loadItems, saveItems, newId } from './lib.mjs';
import { collectNews, pick, corpusText, gradeByRefs } from './news.mjs';

const today = todayBJ();
const runs = readJson('runs.json', { last_daily: null, log: [] });
if (runs.last_daily === today && !process.env.FORCE) { console.log(`今天（${today}）已更新过，跳过`); process.exit(0); }

const cfg = readJson('config.json', { min_items: 10, max_items: 16, topics: [], use_search: false, extra_keywords: [] });
const profile = curProfile();
const db = loadItems();
const reviews = readJson('reviews.json', { reviews: [] }).reviews;
const recent = db.items.filter(i => String(i.created_at).slice(0, 10) >= addDays(today, -10));
const recentTitles = recent.map(i => '- ' + (i.title || i.one_liner)).join('\n') || '（无）';

const log = { date: today, ok: false, added: 0, note: '' };
try {
  let cands = [], verifyModel = '', sources = [], mode = 'news';
  if (cfg.use_search) {
    try {
      const v = await gemini(searchPrompt(), { search: true, label: '核查（搜索）' });
      cands = (Array.isArray(v.out?.items) ? v.out.items : []).map(c => ({ ...c, title: String(c.title || '').slice(0, 40), claims: cleanClaims(c.claims, v.sources) })).filter(c => c.title && c.claims.length);
      verifyModel = v.model; sources = v.sources; mode = 'search';
    } catch (e) { console.error('搜索核查失败，改用新闻源：' + e.message.slice(0, 200)); }
  }
  if (!cands.length) {
    const news = await collectNews(72);
    log.news = news.stat; if (news.errors.length) log.news_errors = news.errors;
    const corpus = pick(news.list, cfg.extra_keywords || []);
    console.log(`抓到 ${news.list.length} 条新闻，相关 ${corpus.length} 条`, news.stat, news.errors);
    if (corpus.length < 15) throw new Error(`新闻源只抓到 ${corpus.length} 条相关新闻：${news.errors.join('；')}`);
    const v = await gemini(newsPrompt(corpus), { label: '筛选与拆声明' });
    const rawItems = Array.isArray(v.out?.items) ? v.out.items : (Array.isArray(v.out) ? v.out : []);
    log.debug = { raw: rawItems.length, sample: JSON.stringify(rawItems[0] || v.out).slice(0, 300) };
    cands = rawItems.map(c => {
      const claims = gradeByRefs(c.claims, corpus);
      const main = claims.flatMap(x => x.evidence).find(e => e.url) || {};
      return { title: String(c.title || '').slice(0, 40), url: main.url || '', source_type: '新闻报道', published_at: main.published_at || null, claims };
    }).filter(c => c.title && c.claims.some(x => x.kind === '事实' && x.level !== 'C'));
    log.debug.graded = cands.length;
    verifyModel = v.model + '（只引用抓取的新闻）';
  }
  const seen = new Set(recent.map(i => (i.title || '').replace(/\s/g, '')));
  cands = cands.filter(c => !seen.has(c.title.replace(/\s/g, ''))).slice(0, cfg.max_items + 4);
  (log.debug ||= {}).after_dedupe = cands.length;
  if (!cands.length) throw new Error('没有找到可用的新信息');

  const a = await gemini(analyzePrompt(today, profile, cands, feedbackText(db.items, reviews)), { label: '分析' });
  const results = Array.isArray(a.out?.results) ? a.out.results : (Array.isArray(a.out) ? a.out : []);
  log.debug.results = results.length; log.debug.rel = results.map(r => r?.relevance).join(',');
  const now = new Date().toISOString();
  let added = 0;
  cands.forEach((c, i) => {
    const r = results.find(x => Number(x?.idx) === i) || {};
    const an = cleanAnalysis(r, c.claims, profile, today);
    if (an.relevance === 0 && an.status === 'ok') return;
    db.items.push({
      id: newId('d', today), created_at: now, source: 'auto', title: c.title, url: String(c.url || ''), raw_text: '',
      source_type: String(c.source_type || ''), published_at: /^\d{4}-\d{2}-\d{2}$/.test(c.published_at || '') ? c.published_at : null,
      claims: c.claims, ...an,
      trace: { verify_model: verifyModel, analyze_model: a.model, prompt_version: `${mode === 'search' ? PROMPT_V.daily : '日更新闻源-v1.0'} / ${PROMPT_V.analyze}`, profile_version: profile.version, analysis_time: now },
      search_sources: sources.slice(0, 12)
    });
    added++;
  });
  capActions(db.items);
  saveItems(db);
  Object.assign(log, { ok: true, added, mode, note: added < cfg.min_items ? `只找到 ${added} 条合格信息` : '' });
  if (added >= Math.ceil(cfg.min_items / 2)) runs.last_daily = today;   // 太少就让补偿时段再跑
  console.log(`新增 ${added} 条`);
} catch (e) {
  log.note = /429/.test(e.message) ? 'Gemini 配额用完（429），等配额恢复后会自动补跑' : e.message.slice(0, 120); log.detail = e.message.slice(0, 2500);
  console.error(e); process.exitCode = 1;
} finally {
  runs.log = [log, ...runs.log].slice(0, 60);
  writeJson('runs.json', runs);
}

function newsPrompt(corpus) {
  return `你是“生活雷达”的信息编辑。今天是北京时间 ${today}。下面是过去 72 小时从公开新闻源抓到的新闻，每条有编号。
任务：从中挑出可能影响下面这个人生活决策的事，${cfg.max_items} 条左右，不少于 ${cfg.min_items} 条（素材实在不够可以少，不许编）。

这个人的画像：
${profileText(profile)}

优先方向：
${cfg.topics.map(t => '- ' + t).join('\n')}

规则：
- 只能使用下面列出的新闻里的事实，不得补充新闻里没有的数字、日期、机构。
- 同一件事的多条新闻合并成一条，并在 refs 里列出全部相关编号（不同媒体报道同一事实，可信度更高）。
- 每条拆成 1–3 条独立声明，kind 填“事实”“推测”“观点”；事实声明的 refs 必须列出支撑它的新闻编号；与其他报道明显矛盾的事实 level 填 "D"，其余 level 留空。
- 不收：他本人必然已经知道的事（自己的调休上班安排、已经过去的天气）；与已收录内容重复的事，除非有实质新进展（title 写“后续”）；纯国际政治、娱乐体育等与他生活无关的新闻。
- title 20 字以内。

已收录（标题）：
${recentTitles}

新闻：
${corpusText(corpus)}

只输出 JSON：{"items":[{"title":"","claims":[{"text":"","kind":"事实","refs":["N1","N5"],"level":null,"note":""}]}]}`;
}

function searchPrompt() {
  const since = addDays(today, -7);
  return `你是“生活雷达”的信息核查员。今天是北京时间 ${today}。请用 Google 搜索，找 ${since} 以来发布的、可能影响下面这个人生活决策的中文信息 ${cfg.max_items} 条（至少 ${cfg.min_items} 条）。
画像：
${profileText(profile)}
检索方向：
${cfg.topics.map(t => '- ' + t).join('\n')}
不收他本人必然已知的事、与已收录重复的事、只有自媒体来源或早于 ${since} 的旧闻。
已收录：
${recentTitles}
把每条拆成 1–3 条独立声明，逐条核查定级：
${LEVEL_RULES}
只输出 JSON：{"items":[{"title":"","url":"","source_type":"","published_at":"YYYY-MM-DD","claims":[{"text":"","kind":"事实|推测|观点","level":"A|B|C|D|null","note":"","evidence":[{"url":"","publisher":"","published_at":"YYYY-MM-DD","stance":"支持"}]}]}]}`;
}
