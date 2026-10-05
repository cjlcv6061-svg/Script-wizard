// 台詞小精靈 解析 Worker：持有 API key、限流、轉發到 OpenRouter、只回標籤。
// 端點：POST /parse   body：{ mode:'format'|'label', lines:[[n,"text"],…], roles?:[…], rules?:{…} }
//       GET  /health
import { buildRequest, filterOutput, dataCollection } from '../prompts.mjs';

const MAX_BODY = 100 * 1024;      // 單次請求 body ≤ 100KB
const MAX_LINES = 400;            // 單次請求行數 ≤ 400
const MAX_LINE_LEN = 2000;
const UPSTREAM = 'https://openrouter.ai/api/v1/chat/completions';

const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

function corsHeaders(origin, env) {
  const allowed = new Set([String(env.ALLOWED_ORIGIN || '').replace(/\/+$/, '')]);
  const localhost = String(env.ALLOW_LOCALHOST) === 'true' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
  if (origin && (allowed.has(origin) || localhost)) {
    return { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' };
  }
  return null;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 驗證並整理請求內容；不合格回傳錯誤字串
export function validatePayload(p) {
  if (!p || typeof p !== 'object') return { error: 'bad_body' };
  if (p.mode !== 'format' && p.mode !== 'label') return { error: 'bad_mode' };
  if (!Array.isArray(p.lines) || !p.lines.length) return { error: 'no_lines' };
  if (p.lines.length > MAX_LINES) return { error: 'too_many_lines' };
  const lines = [];
  for (const x of p.lines) {
    if (!Array.isArray(x) || x.length !== 2 || !Number.isInteger(x[0]) || x[0] < 0 || typeof x[1] !== 'string') return { error: 'bad_line' };
    lines.push([x[0], x[1].slice(0, MAX_LINE_LEN)]);
  }
  const out = { mode: p.mode, lines };
  if (p.mode === 'label') {
    if (!Array.isArray(p.roles) || !p.roles.length || p.roles.length > 60) return { error: 'bad_roles' };
    out.roles = p.roles.map(r => ({
      id: String(r && r.id || '').slice(0, 12),
      name: String(r && r.name || '').slice(0, 40),
      aliases: (Array.isArray(r && r.aliases) ? r.aliases : []).slice(0, 12).map(a => String(a).slice(0, 40))
    }));
    if (out.roles.some(r => !r.id)) return { error: 'bad_roles' };
    const rules = {};
    for (const k of ['speaker_pos', 'direction', 'heading', 'noise', 'notes']) rules[k] = String(p.rules && p.rules[k] || '').slice(0, 200);
    out.rules = rules;
  }
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });
    }
    // 有 Origin（瀏覽器）但不在允許清單 → 403。沒有 Origin（curl 等）不在此擋，靠限流與花費上限保護。
    if (origin && !cors) return json({ error: 'forbidden_origin' }, 403);
    const H = cors || {};

    if (url.pathname === '/health') {
      return json({ ok: true, configured: configured(env), data_collection: dataCollection(env) }, 200, H);     // 讓站長確認目前的資料政策（deny＝不用會拿資料的端點）
    }
    if (url.pathname !== '/parse') return json({ error: 'not_found' }, 404, H);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { ...H, allow: 'POST, OPTIONS' });

    if (!configured(env)) return json({ error: 'not_configured' }, 503, H);

    // ---- body 大小與內容 ----
    const len = +request.headers.get('content-length') || 0;
    if (len > MAX_BODY) return json({ error: 'body_too_large' }, 413, H);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY) return json({ error: 'body_too_large' }, 413, H);
    let body;
    try { body = JSON.parse(raw); } catch (e) { return json({ error: 'bad_json' }, 400, H); }
    const payload = validatePayload(body);
    if (payload.error) return json({ error: payload.error }, payload.error === 'too_many_lines' ? 413 : 400, H);

    // ---- 限流：每 IP 每日、全站每日（UTC 日）----
    const today = new Date().toISOString().slice(0, 10);
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const ipHash = (await sha256Hex(ip + '|' + (env.IP_SALT || '') + '|' + today)).slice(0, 16);
    const limiter = env.LIMITER.get(env.LIMITER.idFromName('global'));
    const lim = await (await limiter.fetch('https://limiter/check', {
      method: 'POST',
      body: JSON.stringify({ ip: ipHash, today, perIp: +env.DAILY_PER_IP || 60, total: +env.DAILY_TOTAL || 600 })
    })).json();
    const log = (status, extra) => console.log(JSON.stringify({ t: new Date().toISOString(), ip: ipHash, mode: payload.mode, lines: payload.lines.length, status, ...extra }));
    if (!lim.ok) {
      log(429, { reason: lim.reason });
      return json({ error: 'rate_limited', reason: lim.reason }, 429, { ...H, 'retry-after': String(secondsToUtcMidnight()) });
    }

    // ---- 轉發到 OpenRouter（只允許清單內供應商；不記錄 body）----
    let upstream;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 110000);
      upstream = await fetch(env.UPSTREAM_URL || UPSTREAM, {   // UPSTREAM_URL 只供本機端到端測試覆寫，正式環境不要設
        method: 'POST',
        signal: ac.signal,
        headers: { authorization: 'Bearer ' + env.OPENROUTER_API_KEY, 'content-type': 'application/json', 'x-title': 'tsj-script-parser' },
        body: JSON.stringify(buildRequest(env, payload))
      });
      clearTimeout(timer);
    } catch (e) {
      log(503, { upstream: 'network', upstream_msg: e && e.name === 'AbortError' ? 'timeout（上游超過 110 秒沒有回應）' : 'network error' });
      return json({ error: 'service_unavailable' }, 503, H);
    }
    // 供應商全數失敗、額度用盡、被限流…一律回 503；不會也不可能路由到清單外（請求帶 provider.only）
    if (!upstream.ok) {
      log(503, { upstream: upstream.status, ...upstreamErrorInfo(await readJsonSafe(upstream), payload, env) });
      // 429＝OpenRouter／上游供應商限流（免費額度、共用端點忙碌…），與本站的每日上限無關；前端據此顯示不同的提示
      return json({ error: upstream.status === 429 ? 'upstream_rate_limited' : 'service_unavailable' }, 503, H);
    }
    let content;
    try {
      const j = await upstream.json();
      content = filterOutput(payload.mode, j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content);
    } catch (e) {
      log(502, { reason: 'bad_output' });
      return json({ error: 'bad_model_output' }, 502, H);
    }
    if (!content) { log(502, { reason: 'empty_output' }); return json({ error: 'bad_model_output' }, 502, H); }
    log(200);
    return json({ ok: true, mode: payload.mode, content }, 200, H);
  }
};

// 上游失敗時才記錄原因，供站長診斷（429 是額度還是上游限流、404 是模型或供應商不對…）。
// 只取 error.code／供應商名稱／error.message，並截短；訊息裡若出現本次請求的劇本內容或 API key，整段丟掉。
async function readJsonSafe(res) {
  try { return await Promise.race([res.json(), new Promise(r => setTimeout(() => r(null), 3000))]); } catch (e) { return null; }
}
function upstreamErrorInfo(j, payload, env) {
  const e = j && typeof j === 'object' ? (j.error && typeof j.error === 'object' ? j.error : { message: j.error }) : {};
  const take = (v, n) => (typeof v === 'string' || typeof v === 'number') ? String(v).replace(/\s+/g, ' ').trim().slice(0, n) : '';
  const out = {};
  const code = take(e.code, 40); if (code) out.upstream_code = code;
  const prov = take(e.metadata && e.metadata.provider_name, 40); if (prov) out.upstream_provider = prov;
  const msg = take(e.message, 160);
  if (msg) {
    const script = payload.lines.map(l => l[1]).join('\n');
    let leak = !!(env.OPENROUTER_API_KEY && msg.includes(env.OPENROUTER_API_KEY)) || payload.lines.some(l => l[1].length >= 4 && msg.includes(l[1]));
    for (let i = 0; !leak && i + 12 <= msg.length; i++) if (script.includes(msg.slice(i, i + 12))) leak = true;
    out.upstream_msg = leak ? '[redacted]' : msg;
  }
  return out;
}

function configured(env) {
  return !!(env.OPENROUTER_API_KEY && env.MODEL && !/^REPLACE_ME/.test(env.MODEL) && env.LIMITER);
}
function secondsToUtcMidnight() {
  const n = new Date();
  return Math.max(60, Math.ceil((Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime()) / 1000));
}

// 限流計數器（Durable Object）：同一時間只處理一個請求，所以計數是原子的。
// 只存「當日、IP 雜湊 → 次數」，隔日第一個請求時整份重置；不存任何劇本內容。
export class Limiter {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const { ip, today, perIp, total } = await request.json();
    let d = await this.state.storage.get('d');
    if (!d || d.day !== today) d = { day: today, all: 0, ips: {} };
    const n = d.ips[ip] || 0;
    let res;
    if (d.all >= total) res = { ok: false, reason: 'global' };
    else if (n >= perIp) res = { ok: false, reason: 'ip' };
    else { d.all++; d.ips[ip] = n + 1; res = { ok: true, ipCount: n + 1, all: d.all }; }
    await this.state.storage.put('d', d);
    return new Response(JSON.stringify(res), { headers: { 'content-type': 'application/json' } });
  }
}
