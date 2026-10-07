// 生活雷达：数据读写、Gemini 调用、规则校验（日更与投喂共用）
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const P = f => path.join(ROOT, 'data', f);
export const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(P(f), 'utf8')); } catch { return d; } };
export const writeJson = (f, v) => { fs.mkdirSync(path.dirname(P(f)), { recursive: true }); fs.writeFileSync(P(f), JSON.stringify(v, null, 1) + '\n'); };

// 北京时间
export const bj = (d = new Date()) => new Date(d.getTime() + 8 * 3600e3);
export const todayBJ = () => bj().toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

export const PROFILE_LABEL = {
  city: '常住城市', family: '家庭情况', vehicle_type: '车辆类型', monthly_mileage: '月均里程', long_trip: '长途用车',
  funds: '持仓基金', occupation: '职业', industry: '所在行业', housing: '住房情况', notes: '其他'
};
export const curProfile = () => { const p = readJson('profile.json', { versions: [] }); return p.versions.slice().sort((a, b) => b.version - a.version)[0] || { version: 0, content: {} }; };
export const profileText = p => Object.entries(p.content || {}).map(([k, v]) => `${k}（${PROFILE_LABEL[k] || k}）：${v}`).join('\n') || '（画像为空）';

// ---------- Gemini ----------
const KEY = process.env.GEMINI_API_KEY || '';
const MODELS = [...new Set([process.env.GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-3.5-flash-lite'].filter(Boolean))];
export function parseJson(t) {
  const s = String(t).replace(/```json|```/g, '');
  const a = s.search(/[\[{]/), b = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (a < 0 || b < a) throw new Error('输出中没有 JSON');
  return JSON.parse(s.slice(a, b + 1));
}
// search=true：开启 Google 搜索（核查阶段）；false：只推理（分析阶段）
export async function gemini(text, { search = false, label = 'Gemini', images = [] } = {}) {
  if (!KEY) throw new Error('缺少 GEMINI_API_KEY（在仓库 Settings → Secrets → Actions 里添加）');
  const errs = [];
  const parts = [{ text }, ...images.map(i => ({ inline_data: { mime_type: i.mime, data: i.b64 } }))];
  for (const m of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const body = { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.3 } };
        if (search) body.tools = [{ google_search: {} }]; else body.generationConfig.responseMimeType = 'application/json';
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body) });
        if (r.ok) {
          const j = await r.json(); const c = j.candidates?.[0] || {};
          const t = (c.content?.parts || []).map(p => p.text || '').join('');
          if (t.trim()) {
            const sources = (c.groundingMetadata?.groundingChunks || []).map(g => g.web).filter(Boolean).map(w => ({ title: w.title || '', uri: w.uri || '' }));
            console.log(`${label}：${m}，引用 ${sources.length} 个搜索结果`);
            return { out: parseJson(t), model: j.modelVersion || m, sources };
          }
          console.error(`${label}：${m} 空回复`); errs.push(`${m} 空回复 ${JSON.stringify(j).slice(0, 160)}`);
        } else { const t = (await r.text()).slice(0, 200); console.error(`${label}：${m} ${r.status} ${t}`); errs.push(`${m} ${r.status} ${t}`); }
      } catch (e) { console.error(`${label}：${m} ${e.message}`); errs.push(`${m} ${e.message}`); }
      await new Promise(res => setTimeout(res, 15000));
    }
  }
  throw new Error('Gemini 不可用：' + errs.slice(-3).join(' | '));
}

// ---------- 提示词 ----------
export const PROMPT_V = { verify: '核查-v1.0', analyze: '分析-v1.0', daily: '日更-v1.0' };
export const LEVEL_RULES = `可信度只针对 kind=事实 的声明：A=至少两个权威来源（官方公告、统计数据、主流媒体）一致；B=有权威来源但口径或时间有差异；C=只有单一来源、自媒体或无法核实；D=与权威来源明确冲突。推测、观点 level 填 null。
每条证据写真实打开过的原文 url、发布方 publisher、原文发布日期 published_at（YYYY-MM-DD）、stance（支持/反对/部分）。不编造链接、机构或日期，找不到就少写，宁可降级。
知乎、抖音、公众号、微博等自媒体只能作为线索，单靠它们最高 C。旧闻翻炒要在 note 里写明原始日期。`;

export function analyzePrompt(today, profile, cands, feedback) {
  return `你是“生活雷达”的个人决策分析师，读者只有下面画像里这一个人。今天是北京时间 ${today}。
目标：判断每条已核查的信息是否与他有关、可能如何影响他、他现在是否需要行动。证据不足时“暂不判断”是正确答案，不是失败。

画像（v${profile.version}，键名（含义）：内容）：
${profileText(profile)}

用户过往反馈（必须照此调整）：
${feedback || '（暂无）'}

规则：
1. relevance 0–3：0 与他无明显关系；1 知道即可；2 有明确影响；3 可能影响近期决策。relevance_reason 一句话说明与他的关系，必须引用画像内容；profile_refs 填引用的画像键名（只能用上面出现的键）。
2. 只有 kind=事实 且 level 为 A 或 B 的声明能作为依据（用 idx 引用）。
3. 四个维度“用车与油价”“理财与基金”“物价与家庭消费”“工作与行业”只是检查清单。每个影响必须写满 path 四环：fact 事实 → direct 直接影响 → intermediate 中间变量 → user_effect 对他的实际影响；任何一环缺依据就不输出该影响。量级很小就不输出，量级要讲清。confidence：高/中/低。
4. 行动建议 action 的门槛，必须同时满足才写，否则 action 为 null：
   (a) relevance=3，依据为 A/B 事实，所依据影响的置信度为中或高；
   (b) 他大概率不知道或想不到这件事；
   (c) 照做和不做有实际差别（省钱、避险、抓住期限、避免损失），并能在 basis 里写出差别大概多大；
   (d) 不是常识提醒，也不是复述他本人已知的日程（比如自己的调休上班）。
   宁可全部为 null。action 格式：{do 具体动作, trigger 触发条件, basis 依据与得失量级, confidence 高/中/低, review_on YYYY-MM-DD}。建议不是预测，不用“一定”“必然”“肯定会”“必将”。理财只给观察、复核类动作，不给买卖方向。
5. 来源冲突、无法确认真实、数据不足、路径不完整或画像不足时 status="undetermined"，impacts=[]、action=null，undetermined 写 {reason, missing}。
6. one_liner：一句话，发生了什么、对他意味着什么，不超过 40 字，不写套话。

待分析（JSON 数组，每条有 idx 和 claims）：
${JSON.stringify(cands.map((c, i) => ({ idx: i, title: c.title, source_type: c.source_type, published_at: c.published_at, claims: (c.claims || []).map(({ idx, text, kind, level, note }) => ({ idx, text, kind, level, note })) })), null, 1)}

只输出 JSON：{"results":[{"idx":0,"status":"ok","one_liner":"","relevance":1,"relevance_reason":"","profile_refs":[],"impacts":[{"dimension":"","direction":"利好|利空|中性","strength":1,"horizon":"1周内|1-3个月|半年以上","path":{"fact":"","direct":"","intermediate":"","user_effect":""},"based_on":[0],"confidence":"中"}],"action":null,"undetermined":null}]}`;
}

// 用户反馈：复盘结果和被忽略的建议，喂回分析提示词
export function feedbackText(items, reviews) {
  const lines = [];
  for (const it of items) if (it.action && it.action.status === '忽略') lines.push(`- 他忽略了建议「${it.action.do}」，同类建议不要再给`);
  for (const r of reviews.slice(-30)) {
    const it = items.find(x => x.id === r.item_id); if (!it) continue;
    if (r.rating === '不值得') lines.push(`- 「${it.one_liner}」他认为不值得打扰${r.note ? '：' + r.note : ''}`);
    else if (r.attribution) lines.push(`- 「${it.one_liner}」复盘归因：${r.attribution}${r.note ? '；' + r.note : ''}`);
    else if (r.note) lines.push(`- 「${it.one_liner}」备注：${r.note}`);
  }
  for (const it of items) for (const n of it.validation_notes || []) if (n.startsWith('用户反馈')) lines.push('- ' + n);
  return [...new Set(lines)].slice(-25).join('\n');
}

// ---------- 规则校验（AI 输出不可信，代码兜底） ----------
const BANNED = ['一定会', '必然', '肯定会', '必将', '毫无疑问', '绝对会'];
const LV = ['A', 'B', 'C', 'D'];
export function cleanClaims(raw, sources = []) {
  const hosts = new Set(sources.map(s => String(s.title || '').toLowerCase().replace(/^www\./, '')).filter(Boolean));
  return (Array.isArray(raw) ? raw : []).map((c, i) => {
    const kind = ['事实', '推测', '观点'].includes(c?.kind) ? c.kind : '观点';
    const evidence = (Array.isArray(c?.evidence) ? c.evidence : []).map(e => ({ url: String(e?.url || ''), publisher: String(e?.publisher || ''), published_at: isDate(e?.published_at) ? e.published_at : null, stance: ['支持', '反对', '部分'].includes(e?.stance) ? e.stance : '支持', note: String(e?.note || '') })).filter(e => e.url || e.publisher);
    let level = kind === '事实' && LV.includes(c?.level) ? c.level : null;
    let note = String(c?.note || '');
    if (level && (level === 'A' || level === 'B')) {
      const grounded = evidence.some(e => { try { const h = new URL(e.url).hostname.replace(/^www\./, ''); return [...hosts].some(x => h.endsWith(x) || x.endsWith(h)); } catch { return false; } });
      if (!evidence.length) { level = 'C'; note += '（没有给出证据，降为 C）'; }
      else if (level === 'A' && evidence.length < 2) { level = 'B'; note += '（只有一个来源，降为 B）'; }
      else if (sources.length && !grounded) note += '（证据链接未出现在本次搜索结果中，请自行点开核对）';
    }
    return { idx: i, text: String(c?.text || ''), kind, level, note: note.trim(), evidence };
  }).filter(c => c.text);
}

export function cleanAnalysis(r, claims, profile, today) {
  r = r && typeof r === 'object' ? r : {};
  const notes = [];
  const keys = new Set(Object.keys(profile.content || {}));
  const ok = n => { const c = claims[Number(n)]; return c && c.kind === '事实' && (c.level === 'A' || c.level === 'B'); };
  let relevance = Math.max(0, Math.min(3, Math.round(Number(r.relevance) || 0)));
  const profile_refs = (Array.isArray(r.profile_refs) ? r.profile_refs : []).map(String).filter(k => keys.has(k));
  if (!profile_refs.length && relevance > 1) { relevance = 1; notes.push('未引用画像字段，相关度降为 1'); }
  const status = r.status === 'undetermined' ? 'undetermined' : 'ok';
  let impacts = [], action = null;
  if (status === 'ok') {
    (Array.isArray(r.impacts) ? r.impacts : []).forEach(i => {
      const p = i?.path || {};
      const full = ['fact', 'direct', 'intermediate', 'user_effect'].every(k => String(p[k] || '').trim());
      const basis = (Array.isArray(i?.based_on) ? i.based_on : []).filter(ok).map(Number);
      if (!full || !basis.length) { notes.push(`影响「${i?.dimension || ''}」链条不完整或没有 A/B 依据，已删除`); return; }
      impacts.push({ dimension: String(i.dimension || ''), direction: ['利好', '利空', '中性'].includes(i.direction) ? i.direction : '中性', strength: Math.max(1, Math.min(3, Number(i.strength) || 1)), horizon: String(i.horizon || ''), path: { fact: String(p.fact), direct: String(p.direct), intermediate: String(p.intermediate), user_effect: String(p.user_effect) }, based_on: basis, confidence: ['高', '中', '低'].includes(i.confidence) ? i.confidence : '低' });
    });
    const a = r.action;
    if (a && String(a.do || '').trim()) {
      const rank = { 高: 3, 中: 2, 低: 1 };
      const txt = [a.do, a.trigger, a.basis].join(' ');
      if (relevance !== 3) notes.push('相关度不足 3，删除建议');
      else if (!impacts.length || impacts.every(i => i.confidence === '低')) notes.push('建议缺少中高置信度的影响依据，已删除');
      else if (BANNED.some(w => txt.includes(w))) notes.push('建议含确定性用语，已删除');
      else {
        const cap = Math.max(...impacts.map(i => rank[i.confidence]));
        const conf = Math.min(rank[a.confidence] || cap, cap);
        action = { do: String(a.do), trigger: String(a.trigger || ''), basis: String(a.basis || ''), confidence: ['', '低', '中', '高'][conf], review_on: isDate(a.review_on) && a.review_on >= today ? a.review_on : addDays(today, 14), status: '待办' };
      }
    }
  }
  return {
    status, one_liner: String(r.one_liner || '').slice(0, 80),
    undetermined: status === 'undetermined' ? { reason: String(r.undetermined?.reason || '数据不足'), missing: String(r.undetermined?.missing || '') } : null,
    relevance, relevance_reason: String(r.relevance_reason || ''), profile_refs, impacts, action, validation_notes: notes
  };
}

// 全库同时待办的建议最多 3 条：按相关度、复盘日期保留
export function capActions(items) {
  const open = items.filter(i => i.action && i.action.status === '待办').sort((a, b) => String(a.action.review_on).localeCompare(String(b.action.review_on)));
  open.slice(3).forEach(i => { i.action.status = '已降级'; (i.validation_notes ||= []).push('待办建议超过 3 条，降为知道即可'); });
}

export const loadItems = () => readJson('items.json', { updated_at: null, items: [] });
export function saveItems(db) {
  db.items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (db.items.length > 600) db.items = db.items.slice(0, 600);
  db.updated_at = new Date().toISOString();
  writeJson('items.json', db);
}
export const newId = (prefix, today) => `${prefix}${today.replace(/-/g, '')}-${Math.random().toString(36).slice(2, 7)}`;
