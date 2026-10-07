// 处理 App 提交的 Issue：投喂、建议状态、复盘、画像
import fs from 'node:fs';
import { collectNews, pick, corpusText, gradeByRefs } from './news.mjs';
import { readJson, writeJson, todayBJ, curProfile, gemini, PROMPT_V, LEVEL_RULES, analyzePrompt, feedbackText, cleanClaims, cleanAnalysis, capActions, loadItems, saveItems, newId, isDate } from './lib.mjs';

const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const issue = ev.issue;
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const gh = (method, p, body) => fetch(`https://api.github.com/repos/${REPO}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json' }, body: body ? JSON.stringify(body) : undefined });
const reply = t => gh('POST', `/issues/${issue.number}/comments`, { body: t });
const close = () => gh('PATCH', `/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });

// 仓库是公开的：只处理仓库主人自己提交的内容
const owner = REPO.split('/')[0];
if (issue.user?.login !== owner) { console.log('不是仓库主人提交，忽略'); process.exit(0); }
if (ev.comment && (ev.comment.user?.login !== owner || String(ev.comment.body).trim() !== '重试' || issue.state !== 'open')) { console.log('不是重试评论，忽略'); process.exit(0); }

const m = String(issue.body || '').match(/```lr1\s*([\s\S]*?)```/);
if (!m) { console.log('没有 lr1 数据块'); process.exit(0); }
let msg; try { msg = JSON.parse(m[1]); } catch { await reply('数据格式不对，没有处理。请回到 App 重新提交。'); process.exit(0); }

const today = todayBJ();
const db = loadItems();
const reviewsDb = readJson('reviews.json', { reviews: [] });
const find = id => db.items.find(i => i.id === id);

try {
  if (msg.type === 'feed') await feed(msg);
  else if (msg.type === 'action') {
    const it = find(msg.item_id); if (!it?.action) throw new Error('找不到这条建议');
    it.action.status = ['已执行', '忽略'].includes(msg.status) ? msg.status : it.action.status;
    it.action.status_at = new Date().toISOString();
    saveItems(db); await reply(`已记为「${it.action.status}」。`);
  } else if (msg.type === 'review') {
    const it = find(msg.item_id); if (!it) throw new Error('找不到这条信息');
    const pick = (v, ok, d) => ok.includes(v) ? v : d;
    const r = {
      item_id: it.id, fact_result: pick(msg.fact_result, ['正确', '错误'], '正确'), impact_result: pick(msg.impact_result, ['正确', '错误', '无法验证'], '无法验证'),
      action_result: pick(msg.action_result, ['有用', '没用', '未执行', '不适用'], '不适用'), rating: pick(msg.rating, ['值得', '一般', '不值得'], '一般'),
      note: String(msg.note || '').slice(0, 500), late: !!msg.late, reviewed_at: new Date().toISOString(),
      trace: it.trace || null
    };
    r.attribution = r.fact_result === '错误' ? '事实找错了' : r.impact_result === '错误' ? '推理错了' : (r.impact_result === '正确' && r.action_result === '没用') ? '建议没用' : (r.impact_result === '正确' && r.action_result === '未执行') ? '建议有效但没执行' : '';
    reviewsDb.reviews = reviewsDb.reviews.filter(x => x.item_id !== it.id).concat(r);
    if (it.action && ['待办', '已执行'].includes(it.action.status)) it.action.status = '已复盘';
    writeJson('reviews.json', reviewsDb); saveItems(db);
    await reply(`复盘已记录${r.attribution ? '，归因：' + r.attribution : ''}。`);
  } else if (msg.type === 'profile') {
    const p = readJson('profile.json', { versions: [] });
    const cur = curProfile();
    const content = {};
    for (const [k, v] of Object.entries(msg.content || {})) if (String(v || '').trim()) content[k] = String(v).trim().slice(0, 300);
    p.versions.push({ version: cur.version + 1, created_at: new Date().toISOString(), content });
    writeJson('profile.json', p);
    await reply(`画像已保存为 v${cur.version + 1}，之后的分析按新画像来。`);
  } else throw new Error('未知类型 ' + msg.type);
  await close();
} catch (e) {
  console.error(e);
  await reply(`处理失败：${e.message}\n\n可以在 App 里重新提交，或者在这条下面评论“重试”。`);
  process.exitCode = 1;
}

async function feed(msg) {
  const text = String(msg.text || '').slice(0, 12000), url = String(msg.url || '');
  // 截图：在 GitHub 页面粘贴到正文的图片
  const images = [];
  for (const u of (String(issue.body).match(/https:\/\/github\.com\/user-attachments\/assets\/[\w-]+|https:\/\/[\w.-]*githubusercontent\.com\/[^\s)"']+\.(?:png|jpe?g|webp|gif)/gi) || []).slice(0, 3)) {
    try { const r = await fetch(u, { headers: { authorization: `Bearer ${TOKEN}` } }); const mime = r.headers.get('content-type') || ''; if (r.ok && mime.startsWith('image/')) images.push({ mime, b64: Buffer.from(await r.arrayBuffer()).toString('base64') }); else console.log('截图读取失败', r.status, mime); } catch (e) { console.log('截图读取失败', e.message); }
  }
  if (!text && !url && !images.length) throw new Error('没有内容：请贴正文，或在 GitHub 页面粘贴截图');
  const profile = curProfile();
  const p1 = `你是“生活雷达”的事实核查员。今天是北京时间 ${today}。用户转来一条信息（正文、链接或截图）。请先读出全部内容，再用 Google 搜索逐条核查。
把它拆成独立声明，逐条标注类型并定级：
${LEVEL_RULES}
只输出 JSON：{"title":"20 字以内","source_type":"信息本身的来源类型，如知乎回答、新闻报道、官方公告、聊天截图、不明","published_at":"信息里能看到的发布日期 YYYY-MM-DD 或 null","claims":[{"text":"","kind":"事实|推测|观点","level":"A|B|C|D|null","note":"","evidence":[{"url":"","publisher":"","published_at":"","stance":"支持|反对|部分"}]}]}

${text ? '【正文】\n' + text : ''}
${url ? '【链接】' + url : ''}
${images.length ? '【截图】见附图' : ''}`;
  const cfg = readJson('config.json', { use_search: false });
  let v = null, claims = [];
  if (cfg.use_search) {
    try { v = await gemini(p1, { search: true, label: '核查（搜索）', images }); claims = cleanClaims(v.out?.claims, v.sources); }
    catch (e) { console.error('搜索核查失败，改用新闻源：' + e.message.slice(0, 200)); v = null; }
  }
  if (!v) {
    let page = '';
    if (url) { try { const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) }); if (r.ok) page = (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 6000); } catch (_) {} }
    const news = await collectNews(168);
    const corpus = pick(news.list, [], 400);
    const p2 = `你是“生活雷达”的事实核查员。今天是北京时间 ${today}。用户转来一条信息（正文、链接或截图）。你不能上网，只能用下面抓到的近 7 天新闻作为独立证据。
先读出全部内容，再拆成独立声明：kind 填“事实”“推测”“观点”；事实声明的 refs 列出能证实它的新闻编号（必须是同一件事，没有就留空）；与新闻明显矛盾的事实 level 填 "D" 并在 note 写明矛盾点；与你掌握的长期常识明显冲突的也标 "D"。不编造。
只输出 JSON：{"title":"20 字以内","source_type":"信息本身的来源类型，如知乎回答、新闻报道、官方公告、聊天截图、不明","published_at":"信息里能看到的发布日期 YYYY-MM-DD 或 null","claims":[{"text":"","kind":"事实","refs":[],"level":null,"note":""}]}

${text ? '【正文】\n' + text : ''}
${url ? '【链接】' + url : ''}${page ? '\n【链接页面文字（这是信息本身，不算独立证据）】\n' + page : ''}
${images.length ? '【截图】见附图' : ''}

【近 7 天新闻】
${corpusText(corpus)}`;
    v = await gemini(p2, { label: '核查（新闻源）', images });
    claims = gradeByRefs(v.out?.claims, corpus);
    v.model += '（只引用抓取的新闻）'; v.sources = [];
  }
  const cand = { title: String(v.out?.title || text.slice(0, 20) || '截图'), source_type: String(v.out?.source_type || '不明'), published_at: isDate(v.out?.published_at) ? v.out.published_at : null, claims };
  const a = await gemini(analyzePrompt(today, profile, [cand], feedbackText(db.items, reviewsDb.reviews)), { label: '分析' });
  const r = (Array.isArray(a.out?.results) ? a.out.results : [])[0] || {};
  const an = cleanAnalysis(r, claims, profile, today);
  const now = new Date().toISOString();
  const item = { id: newId('f', today), created_at: now, source: 'feed', issue: issue.number, title: cand.title, url, raw_text: text, has_image: images.length > 0,
    source_type: cand.source_type, published_at: cand.published_at, claims, ...an,
    trace: { verify_model: v.model, analyze_model: a.model, prompt_version: `${PROMPT_V.verify} / ${PROMPT_V.analyze}`, profile_version: profile.version, analysis_time: now },
    search_sources: v.sources.slice(0, 12) };
  db.items.push(item); capActions(db.items); saveItems(db);
  const verdict = an.status === 'undetermined' ? `暂不判断：${an.undetermined.reason}，缺 ${an.undetermined.missing}` : item.action ? `需要行动：${item.action.do}` : an.relevance >= 2 ? '值得关注，暂无需行动' : an.relevance === 1 ? '知道就行' : '与你无关';
  await reply(`**${an.one_liner || cand.title}**\n\n${verdict}\n\n${claims.map(c => `- ${c.kind === '事实' ? '[' + c.level + '] ' : '[' + c.kind + '] '}${c.text}`).join('\n')}\n\n打开 App 看完整分析。`);
}
