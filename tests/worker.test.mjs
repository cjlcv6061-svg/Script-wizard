// Worker 測試：CORS、body／行數上限、驗證、限流（每 IP／全站／隔日重置）、OpenRouter 請求內容
// （供應商允許清單、data_collection、溫度 0）、輸出過濾、錯誤對應（503/502）、日誌不含劇本內容。
import assert from 'node:assert';
import worker, { Limiter, validatePayload } from '../worker/src/index.mjs';

let n = 0;
const ok = (c, m) => { assert(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// ---- 假的 Durable Object 與 fetch ----
function makeEnv(over = {}) {
  const store = new Map();
  const state = { storage: { get: async k => store.get(k), put: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } } };
  const limiter = new Limiter(state);
  return {
    OPENROUTER_API_KEY: 'sk-test-SECRET', MODEL: 'vendor/model-x', PROVIDERS: 'together, fireworks',
    ALLOWED_ORIGIN: 'https://me.github.io', DAILY_PER_IP: '3', DAILY_TOTAL: '5', ALLOW_LOCALHOST: 'false',
    LIMITER: { idFromName: () => 'id', get: () => ({ fetch: (u, init) => limiter.fetch(new Request(u, init)) }) },
    ...over
  };
}
const upstreamCalls = [];
let upstreamImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '1|S|偉\n2|C|' } }] }) });
globalThis.fetch = async (url, init) => { upstreamCalls.push({ url: String(url), init }); return upstreamImpl(url, init); };
const logs = [];
const origLog = console.log; console.log = (...a) => logs.push(a.join(' '));

const ORIGIN = 'https://me.github.io';
const labelBody = (extra = {}) => ({ mode: 'label', lines: [[1, '偉：你好'], [2, '嗯']], roles: [{ id: '偉', name: '葉志偉', aliases: ['志偉'] }], rules: { speaker_pos: 'prefix' }, ...extra });
const post = (env, body, headers = {}, raw) => worker.fetch(new Request('https://w.test/parse', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', ...headers }, body: raw !== undefined ? raw : JSON.stringify(body) }), env, {});

(async () => {
  // ---- CORS ----
  {
    const env = makeEnv();
    let r = await worker.fetch(new Request('https://w.test/parse', { method: 'OPTIONS', headers: { origin: ORIGIN } }), env, {});
    ok(r.status === 204 && r.headers.get('access-control-allow-origin') === ORIGIN, '允許來源的預檢回 204 與 ACAO');
    r = await worker.fetch(new Request('https://w.test/parse', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), env, {});
    ok(r.status === 403 && !r.headers.get('access-control-allow-origin'), '其他來源的預檢 403');
    const before = upstreamCalls.length;
    r = await post(env, labelBody(), { origin: 'https://evil.example' });
    ok(r.status === 403 && upstreamCalls.length === before, '其他來源的 POST 403，且沒有打到上游');
    r = await post(env, labelBody(), { origin: 'http://localhost:8000' });
    ok(r.status === 403, '預設不允許 localhost');
    const env2 = makeEnv({ ALLOW_LOCALHOST: 'true' });
    r = await post(env2, labelBody(), { origin: 'http://localhost:8000' });
    ok(r.status === 200 && r.headers.get('access-control-allow-origin') === 'http://localhost:8000', 'ALLOW_LOCALHOST=true 才允許 localhost');
    const env3 = makeEnv({ ALLOWED_ORIGIN: 'https://me.github.io/' });
    r = await post(env3, labelBody());
    ok(r.status === 200, 'ALLOWED_ORIGIN 尾端斜線容錯');
  }

  // ---- 驗證與大小上限 ----
  {
    const env = makeEnv({ DAILY_PER_IP: '1000', DAILY_TOTAL: '1000' });
    upstreamImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"roles":[{"id":"偉"}],"rules":{}}' } }] }) });
    const code = async (b, h, raw) => (await post(env, b, h, raw)).status;
    eq(await code(null, {}, 'not json'), 400, '壞 JSON');
    eq(await code({ mode: 'x', lines: [[1, 'a']] }), 400, '壞 mode');
    eq(await code({ mode: 'format', lines: [] }), 400, '沒有行');
    eq(await code({ mode: 'format', lines: [[1, 'a', 'b']] }), 400, '壞行格式');
    eq(await code({ mode: 'format', lines: [['1', 'a']] }), 400, '行號必須是整數');
    eq(await code({ mode: 'label', lines: [[1, 'a']] }), 400, 'label 需要 roles');
    eq(await code({ mode: 'label', lines: [[1, 'a']], roles: [{ name: 'x' }] }), 400, 'role 需要 id');
    eq(await code({ mode: 'format', lines: Array.from({ length: 401 }, (_, i) => [i, 'x']) }), 413, '超過 400 行');
    eq(await code({ mode: 'format', lines: Array.from({ length: 400 }, (_, i) => [i, 'x']) }), 200, '剛好 400 行可以');
    eq(await code({ mode: 'format', lines: [[1, 'x']] }, { 'content-length': '200000' }), 413, 'content-length 超過 100KB');
    const big = JSON.stringify({ mode: 'format', lines: Array.from({ length: 200 }, (_, i) => [i, '字'.repeat(1900)]) });
    ok(new TextEncoder().encode(big).length > 100 * 1024, '（測試資料確實超過 100KB）');
    eq(await code(null, {}, big), 413, '實際 body 超過 100KB（無 content-length 標頭也擋）');
    let r = await worker.fetch(new Request('https://w.test/parse', { method: 'GET', headers: { origin: ORIGIN } }), env, {});
    eq(r.status, 405, 'GET /parse 405');
    r = await worker.fetch(new Request('https://w.test/nope', { headers: { origin: ORIGIN } }), env, {});
    eq(r.status, 404, '未知路徑 404');
    const v = validatePayload({ mode: 'format', lines: [[1, 'x'.repeat(5000)]] });
    eq(v.lines[0][1].length, 2000, '單行過長會截斷');
  }

  // ---- 未設定 ----
  {
    for (const over of [{ MODEL: 'REPLACE_ME_CONFIRM_ON_OPENROUTER' }, { OPENROUTER_API_KEY: '' }, { MODEL: '' }]) {
      const env = makeEnv(over); const before = upstreamCalls.length;
      const r = await post(env, labelBody());
      ok(r.status === 503 && (await r.json()).error === 'not_configured' && upstreamCalls.length === before, '未設定時 503 not_configured：' + JSON.stringify(over));
    }
    const h = await worker.fetch(new Request('https://w.test/health', { headers: { origin: ORIGIN } }), makeEnv({ MODEL: 'REPLACE_ME' }), {});
    eq((await h.json()).configured, false, '/health 回報未設定');
  }

  // ---- OpenRouter 請求內容 ----
  {
    const env = makeEnv({ DAILY_PER_IP: '100', DAILY_TOTAL: '100' });
    upstreamCalls.length = 0;
    const r = await post(env, labelBody());
    const call = upstreamCalls[0];
    ok(call.url === 'https://openrouter.ai/api/v1/chat/completions', '只打 OpenRouter：' + call.url);
    const req = JSON.parse(call.init.body);
    eq(call.init.headers.authorization, 'Bearer sk-test-SECRET', 'API key 由環境變數帶入');
    eq(req.model, 'vendor/model-x', '模型來自環境變數');
    eq(req.temperature, 0, '溫度 0');
    eq(req.provider, { order: ['together', 'fireworks'], only: ['together', 'fireworks'], allow_fallbacks: true, data_collection: 'deny' }, '供應商允許清單、不訓練不保留、不得路由到清單外');
    ok(!/:free$/.test(req.model), '不使用 :free 模型');
    ok(req.messages[1].content.includes('1\t偉：你好'), '行以「行號\\t內容」送出');
    const text = await r.text();
    ok(!text.includes('sk-test-SECRET'), '回應不含 API key');
    // format 模式要求 JSON
    await post(env, { mode: 'format', lines: [[1, '偉：你好']] });
    ok(JSON.parse(upstreamCalls[1].init.body).response_format.type === 'json_object', 'format 模式要求 JSON 輸出');
  }

  // ---- 輸出過濾：只回標籤／白名單欄位 ----
  {
    const env = makeEnv({ DAILY_PER_IP: '100', DAILY_TOTAL: '100' });
    upstreamImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '好的，以下是標記：\n```\n1|S|偉\n偉：你好，這是不該被回傳的劇本原文\n2|C|\n3|X|\n```' } }] }) });
    let r = await post(env, labelBody()); let j = await r.json();
    eq(j, { ok: true, mode: 'label', content: '1|S|偉\n2|C|' }, 'label：只留「行號|標籤|角色」格式的行');
    upstreamImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"roles":[{"id":"偉","name":"葉","aliases":["a"],"gender":"m","secret":"x"}],"rules":{"notes":"n","leak":"劇本原文"},"echo":"劇本原文"}' } }] }) });
    r = await post(env, { mode: 'format', lines: [[1, '偉：你好']] }); j = await r.json();
    const c = JSON.parse(j.content);
    eq(Object.keys(c), ['roles', 'rules'], 'format：只留白名單欄位');
    ok(!('secret' in c.roles[0]) && !('leak' in c.rules) && c.roles[0].gender === 'm', 'format：子欄位也過濾');
    upstreamImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '我不知道' } }] }) });
    r = await post(env, labelBody());
    ok(r.status === 502 && (await r.json()).error === 'bad_model_output', '模型輸出沒有任何標記 → 502');
    upstreamImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }) });
    r = await post(env, { mode: 'format', lines: [[1, 'x']] });
    eq(r.status, 502, 'format 不是 JSON → 502');
  }

  // ---- 上游失敗 → 503，不退而求其次 ----
  {
    const env = makeEnv({ DAILY_PER_IP: '100', DAILY_TOTAL: '100' });
    for (const impl of [async () => ({ ok: false, status: 503, json: async () => ({}) }), async () => ({ ok: false, status: 404, json: async () => ({ error: 'No allowed providers' }) }), async () => ({ ok: false, status: 429, json: async () => ({}) }), async () => { throw new Error('net'); }]) {
      upstreamImpl = impl; upstreamCalls.length = 0;
      const r = await post(env, labelBody());
      ok(r.status === 503 && (await r.json()).error === 'service_unavailable', '上游失敗回 503');
      ok(upstreamCalls.length === 1 && upstreamCalls.every(c => c.url.startsWith('https://openrouter.ai/')), '只打一次、且只打 OpenRouter（不自行改路由）');
    }
  }

  // ---- 限流 ----
  {
    upstreamImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '1|S|偉' } }] }) });
    const env = makeEnv({ DAILY_PER_IP: '3', DAILY_TOTAL: '5' });
    const s = [];
    for (let i = 0; i < 4; i++) s.push((await post(env, labelBody(), { 'cf-connecting-ip': '9.9.9.9' })).status);
    eq(s, [200, 200, 200, 429], '每 IP 每日 3 次，第 4 次 429');
    const r = await post(env, labelBody(), { 'cf-connecting-ip': '9.9.9.9' });
    ok(+r.headers.get('retry-after') >= 60 && (await r.json()).reason === 'ip', '429 帶 Retry-After 與原因 ip');
    eq((await post(env, labelBody(), { 'cf-connecting-ip': '8.8.8.8' })).status, 200, '別的 IP 不受影響');
    eq((await post(env, labelBody(), { 'cf-connecting-ip': '7.7.7.7' })).status, 200, '再一個 IP（全站第 5 次）');
    const g = await post(env, labelBody(), { 'cf-connecting-ip': '6.6.6.6' });
    ok(g.status === 429 && (await g.json()).reason === 'global', '全站每日上限到頂 429（原因 global）');
    // 429 不會打到上游
    const before = upstreamCalls.length;
    await post(env, labelBody(), { 'cf-connecting-ip': '9.9.9.9' });
    eq(upstreamCalls.length, before, '被限流的請求不會花到 API 費用');
  }
  {
    // 隔日重置（直接測 Limiter）
    const store = new Map(); const lim = new Limiter({ storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v) } });
    const call = async (ip, today) => (await (await lim.fetch(new Request('https://l/', { method: 'POST', body: JSON.stringify({ ip, today, perIp: 1, total: 10 }) }))).json());
    eq((await call('a', '2026-10-05')).ok, true, '第一次');
    eq((await call('a', '2026-10-05')).ok, false, '同日第二次被擋');
    eq((await call('a', '2026-10-06')).ok, true, '隔日重置');
    const d = store.get('d');
    ok(Object.keys(d.ips).length === 1 && d.day === '2026-10-06', '隔日只留當日計數');
  }

  // ---- 隱私：日誌不含劇本內容與原始 IP ----
  {
    const env = makeEnv({ DAILY_PER_IP: '100', DAILY_TOTAL: '100' });
    upstreamImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '1|S|偉' } }] }) });
    logs.length = 0;
    await post(env, { ...labelBody(), lines: [[1, '極機密劇本台詞XYZ']] }, { 'cf-connecting-ip': '203.0.113.77' });
    ok(logs.length === 1, '每次請求一行日誌');
    const l = JSON.parse(logs[0]);
    ok(!logs[0].includes('極機密') && !logs[0].includes('203.0.113.77'), '日誌不含劇本內容與原始 IP');
    ok(l.ip.length === 16 && l.lines === 1 && l.status === 200 && l.mode === 'label' && l.t, '日誌只有時間、IP 雜湊、行數、狀態碼（與模式）');
  }

  console.log = origLog;
  console.log(`✓ worker.test.mjs：${n} 項通過`);
})().catch(e => { console.log = origLog; console.error('✗', e.message ? e.message.slice(0, 2500) : e); process.exit(1); });
