// 诊断：不带搜索调一次，判断是密钥整体没额度，还是只是搜索额度没了
import { gemini, writeJson, readJson } from './lib.mjs';
const out = {};
try { const r = await gemini('只输出 JSON：{"ok":true}', { label: '探测-无搜索' }); out.plain = 'ok ' + r.model; } catch (e) { out.plain = e.message.slice(0, 300); }
writeJson('probe.json', { at: new Date().toISOString(), ...out });
