// 每天早上：联网找近 7 天与画像相关的信息 → 核查定级 → 分析 → 写入 data/items.json
import { readJson, writeJson, todayBJ, addDays, curProfile, profileText, gemini, PROMPT_V, LEVEL_RULES, analyzePrompt, feedbackText, cleanClaims, cleanAnalysis, capActions, loadItems, saveItems, newId } from './lib.mjs';

const today = todayBJ();
const runs = readJson('runs.json', { last_daily: null, log: [] });
if (runs.last_daily === today && !process.env.FORCE) { console.log(`今天（${today}）已更新过，跳过`); process.exit(0); }

const cfg = readJson('config.json', { min_items: 10, max_items: 16, topics: [] });
const profile = curProfile();
const db = loadItems();
const reviews = readJson('reviews.json', { reviews: [] }).reviews;
const since = addDays(today, -7);
const recent = db.items.filter(i => String(i.created_at).slice(0, 10) >= addDays(today, -10));
const openActions = db.items.filter(i => i.action?.status === '待办').map(i => `- ${i.action.do}（${i.one_liner}）`).join('\n');

// 1. 核查：联网找候选并逐条定级
const want = cfg.max_items;
const p1 = `你是“生活雷达”的信息核查员。今天是北京时间 ${today}。请用 Google 搜索，找 ${since} 以来发布的、可能影响下面这个人生活决策的中文信息 ${want} 条（至少 ${cfg.min_items} 条）。

这个人的画像：
${profileText(profile)}

检索方向（宽一点，但每条都要和他有关）：
${cfg.topics.map(t => '- ' + t).join('\n')}

不要收：
- 他本人必然已经知道的事（自己的调休上班安排、已经过去的天气）；
- 与下面已收录内容重复的事，除非有实质新进展（新进展要在 title 里写“后续”）；
- 无法打开原文、只有自媒体来源、或发布日期早于 ${since} 的旧闻。

已收录（标题）：
${recent.map(i => '- ' + (i.title || i.one_liner)).join('\n') || '（无）'}

把每条信息拆成 1–3 条独立声明，逐条核查定级：
${LEVEL_RULES}

只输出 JSON（不要别的文字）：
{"items":[{"title":"20 字以内","url":"最主要的原文链接","source_type":"官方公告|新闻报道|统计数据|行业报道","published_at":"YYYY-MM-DD","claims":[{"text":"","kind":"事实|推测|观点","level":"A|B|C|D|null","note":"","evidence":[{"url":"","publisher":"","published_at":"YYYY-MM-DD","stance":"支持"}]}]}]}`;

const log = { date: today, ok: false, added: 0, note: '' };
try {
  const v = await gemini(p1, { search: true, label: '核查' });
  let cands = (Array.isArray(v.out?.items) ? v.out.items : (Array.isArray(v.out) ? v.out : []))
    .map(c => ({ ...c, title: String(c.title || '').slice(0, 40), claims: cleanClaims(c.claims, v.sources) }))
    .filter(c => c.title && c.claims.length);
  const seen = new Set(recent.map(i => (i.title || '').replace(/\s/g, '')));
  cands = cands.filter(c => !seen.has(c.title.replace(/\s/g, '')));
  if (!cands.length) throw new Error('核查阶段没有拿到可用条目');

  // 2. 分析：只推理，不联网
  const a = await gemini(analyzePrompt(today, profile, cands, feedbackText(db.items, reviews)), { label: '分析' });
  const results = Array.isArray(a.out?.results) ? a.out.results : [];
  const now = new Date().toISOString();
  let added = 0;
  cands.forEach((c, i) => {
    const r = results.find(x => Number(x?.idx) === i) || {};
    const an = cleanAnalysis(r, c.claims, profile, today);
    if (an.relevance === 0 && an.status === 'ok') return;   // 与他无关的不收
    db.items.push({
      id: newId('d', today), created_at: now, source: 'auto', title: c.title, url: String(c.url || ''), raw_text: '',
      source_type: String(c.source_type || ''), published_at: /^\d{4}-\d{2}-\d{2}$/.test(c.published_at || '') ? c.published_at : null,
      claims: c.claims, ...an,
      trace: { verify_model: v.model, analyze_model: a.model, prompt_version: `${PROMPT_V.daily} / ${PROMPT_V.analyze}`, profile_version: profile.version, analysis_time: now },
      search_sources: v.sources.slice(0, 12)
    });
    added++;
  });
  capActions(db.items);
  saveItems(db);
  Object.assign(log, { ok: true, added, note: added < cfg.min_items ? `只找到 ${added} 条合格信息` : '' , model: v.model });
  runs.last_daily = today;
  console.log(`新增 ${added} 条`);
} catch (e) {
  log.note = /429/.test(e.message) ? 'Gemini 配额用完（429），等配额恢复后会自动补跑' : e.message.slice(0, 120); log.detail = e.message.slice(0, 2500); console.error(e);
  process.exitCode = 1;
} finally {
  runs.log = [log, ...runs.log].slice(0, 60);
  writeJson('runs.json', runs);
}
