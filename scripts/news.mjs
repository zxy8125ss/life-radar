// 新闻源：直接抓公开滚动新闻，给 AI 当“只能引用这些”的素材；可信度由代码按来源数量判定
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' };
async function get(url, opt = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try { const r = await fetch(url, { ...opt, headers: { ...UA, ...(opt.headers || {}) }, signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.text(); }
  finally { clearTimeout(t); }
}
const clean = s => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const bjStr = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

export async function collectNews(hours = 72) {
  const lo = Date.now() - hours * 3600e3, out = [], stat = {};
  const add = (src, n) => { stat[src] = (stat[src] || 0) + 1; out.push(n); };
  const tries = [
    ['新浪滚动', async () => {
      for (const lid of [2510, 2669, 2516, 2509]) for (let p = 1; p <= 4; p++) {
        const j = JSON.parse(await get(`https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=${lid}&num=50&page=${p}`));
        const list = j?.result?.data || []; if (!list.length) break;
        for (const n of list) { const t = Number(n.ctime) * 1000; if (t < lo) continue; add('新浪滚动', { time: t, title: clean(n.title), text: clean(n.intro || n.summary), publisher: clean(n.media_name) || '新浪', url: n.url || n.wapurl || '' }); }
        if (Number(list.at(-1).ctime) * 1000 < lo) break;
      }
    }],
    ['新浪财经7×24', async () => {
      for (let p = 1; p <= 8; p++) {
        const j = JSON.parse(await get(`https://zhibo.sina.com.cn/api/zhibo/feed?page=${p}&page_size=100&zhibo_id=152&tag_id=0&dire=f&dpc=1`));
        const list = j?.result?.data?.feed?.list || []; if (!list.length) break;
        for (const n of list) { const t = Date.parse(String(n.create_time).replace(' ', 'T') + '+08:00'); if (t < lo) continue; const x = clean(n.rich_text); add('新浪财经7×24', { time: t, title: x.slice(0, 60), text: x, publisher: '新浪财经', url: '' }); }
        if (Date.parse(String(list.at(-1).create_time).replace(' ', 'T') + '+08:00') < lo) break;
      }
    }],
    ['华尔街见闻', async () => {
      let cursor = '';
      for (let p = 0; p < 6; p++) {
        const j = JSON.parse(await get(`https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&limit=100${cursor ? '&cursor=' + cursor : ''}`));
        const list = j?.data?.items || []; if (!list.length) break;
        for (const n of list) { const t = n.display_time * 1000; if (t < lo) continue; const x = clean(n.content_text || n.title); add('华尔街见闻', { time: t, title: x.slice(0, 60), text: x, publisher: '华尔街见闻', url: n.uri || '' }); }
        cursor = j.data.next_cursor; if (!cursor || list.at(-1).display_time * 1000 < lo) break;
      }
    }],
    ['中新网', async () => {
      for (const f of ['scroll-news', 'china', 'society', 'finance']) {
        const x = await get(`https://www.chinanews.com.cn/rss/${f}.xml`);
        for (const it of x.split(/<item>/).slice(1)) {
          const g = tag => clean((it.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1]);
          const t = Date.parse(g('pubDate')); if (!(t >= lo)) continue;
          add('中新网', { time: t, title: g('title'), text: g('description'), publisher: '中国新闻网', url: g('link') });
        }
      }
    }]
  ];
  const errors = [];
  await Promise.all(tries.map(async ([name, fn]) => { try { await fn(); } catch (e) { errors.push(`${name}：${e.message}`); } }));
  // 去重
  const seen = new Set(), res = [];
  for (const n of out.sort((a, b) => b.time - a.time)) {
    if (!n.title || n.title.length < 6) continue;
    const k = n.title.replace(/[^一-龥\w]/g, '').slice(0, 18); if (seen.has(k)) continue; seen.add(k);
    res.push({ ...n, when: bjStr(n.time) });
  }
  return { list: res, stat, errors };
}

// 按画像关键词粗筛，控制喂给模型的长度
const BASE = /湖南|长沙|常德|澧县|石门|株洲|湘潭|岳阳|益阳|张家界|油价|成品油|汽油|柴油|充电|新能源车|混动|高速|收费|限行|交通管制|地铁|天气|降温|暴雨|寒潮|预警|禁渔|钓鱼|水位|公积金|社保|医保|个税|养老金|房贷|LPR|利率|降息|降准|存款|贴息|补贴|以旧换新|消费券|物价|CPI|猪肉|菜价|鸡蛋|水电|燃气|电价|新规|施行|实施|通知|国务院|发改委|人社部|财政部|央行|住建|就业|劳动|工资|加班|年假|AI|人工智能|大模型|办公|企业|裁员|招聘|PMI|快递|网购|诈骗|ETC/;
export function pick(list, extra = [], max = 320) {
  const re = extra.length ? new RegExp(BASE.source + '|' + extra.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')) : BASE;
  const hit = list.filter(n => re.test(n.title + n.text));
  return hit.slice(0, max).map((n, i) => ({ ...n, id: 'N' + (i + 1) }));
}
export const corpusText = arr => arr.map(n => `[${n.id}] ${n.when}｜${n.publisher}｜${n.title}${n.text && n.text !== n.title ? '：' + n.text.slice(0, 120) : ''}`).join('\n');

// 用引用的新闻编号给声明定级：不同发布方 ≥2 → A；1 → B；没有 → C；模型标 D（冲突）保留
export function gradeByRefs(claims, corpus) {
  const byId = new Map(corpus.map(n => [n.id, n]));
  return (Array.isArray(claims) ? claims : []).map((c, i) => {
    const kind = ['事实', '推测', '观点'].includes(c?.kind) ? c.kind : '观点';
    const refs = [...new Set((Array.isArray(c?.refs) ? c.refs : []).map(String))].filter(id => byId.has(id));
    const evidence = refs.map(id => { const n = byId.get(id); return { url: n.url, publisher: n.publisher, published_at: n.when.slice(0, 10), stance: '支持', note: n.title.slice(0, 60), ref: id }; });
    const pubs = new Set(evidence.map(e => e.publisher));
    let level = null, note = String(c?.note || '');
    if (kind === '事实') {
      if (c?.level === 'D') level = 'D';
      else if (pubs.size >= 2) level = 'A';
      else if (pubs.size === 1) level = 'B';
      else { level = 'C'; note = (note + ' 抓取的新闻里没有找到出处').trim(); }
    }
    return { idx: i, text: String(c?.text || ''), kind, level, note, evidence };
  }).filter(c => c.text);
}
