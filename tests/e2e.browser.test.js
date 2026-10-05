// 端到端：真瀏覽器（Chromium）＋ 真 Worker（wrangler dev / workerd）＋ 本機假 OpenRouter。
// 驗證：貼上文字 → 同意畫面 → 兩段式解析進度 → 組回存檔 → 選角；相同內容走快取不再呼叫；
//       上游失敗 → 503 提示；超過每日上限 → 429 提示。需要 playwright-core、Chromium、worker/node_modules（wrangler）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const { ROOT } = require('./helpers');
const { loadTSP } = require('./tsp-load');
const { variants } = require('../eval/synth');

let chromium;
try { ({ chromium } = require('playwright-core')); } catch (e) { console.log('- e2e.browser：略過（沒有 playwright-core）'); process.exit(0); }
const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const exe = [path.join(base, 'chromium')].find(p => fs.existsSync(p));
if (!exe) { console.log('- e2e.browser：略過（找不到 Chromium）'); process.exit(0); }
const wranglerBin = path.join(ROOT, 'worker/node_modules/.bin/wrangler');
if (!fs.existsSync(wranglerBin)) { console.log('- e2e.browser：略過（worker/ 尚未 npm install，沒有 wrangler）'); process.exit(0); }

const TSP = loadTSP();
const V = Object.fromEntries(variants().map(v => [v.id, v]));
let n = 0;
const ok = (c, m) => { assert(c, m); n++; };

// ---- 假 OpenRouter：用本機啟發式規則當「模型」----
const upstream = { calls: [], fail: false };
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    if (req.url.startsWith('/__fail')) { upstream.fail = req.method === 'POST' ? (+new URL(req.url, 'http://x').searchParams.get('status') || 500) : 0; res.end('ok'); return; }
    const body = JSON.parse(b);
    upstream.calls.push(body);
    if (upstream.fail) { res.writeHead(upstream.fail); return res.end('{"error":{"code":' + upstream.fail + ',"message":"upstream failed"}}'); }
    const sys = body.messages[0].content, user = body.messages[1].content;
    const rows = user.split('\n').map(l => l.match(/^(\d+)\t(.*)$/)).filter(Boolean).map(m => ({ n: +m[1], text: m[2] }));
    let content;
    if (/格式分析器/.test(sys)) {
      const cnt = new Map();
      for (const l of rows) { const m = l.text.match(/^([^：:（(\s]{1,12})\s*[：:]/); if (m) for (const t of m[1].split(/[、,，/／]/).filter(Boolean)) cnt.set(t, (cnt.get(t) || 0) + 1); }
      content = JSON.stringify({ roles: [...cnt].filter(([, c]) => c >= 3).map(([id]) => ({ id, name: id, aliases: [], gender: 'n' })), rules: { speaker_pos: 'prefix' } });
    } else {
      const roles = [...user.matchAll(/^- ([^：\n]+)：/gm)].map(m => ({ id: m[1], name: m[1], aliases: [] }));
      const lab = TSP.heuristicLabels(rows, roles, false);
      content = rows.map(l => `${l.n}|${lab.get(l.n).label}|${lab.get(l.n).role}`).join('\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const site = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html');
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
const listen = (srv, port) => new Promise(r => srv.listen(port || 0, '127.0.0.1', () => r(srv.address().port)));

(async () => {
  const mockPort = await listen(mock), sitePort = await listen(site);
  const WPORT = 8791;
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'tsj-wr-'));
  const wr = spawn(wranglerBin, ['dev', '--local', '--port', String(WPORT), '--persist-to', persist,
    '--var', 'OPENROUTER_API_KEY:sk-e2e', '--var', 'MODEL:vendor/e2e', '--var', 'ALLOW_LOCALHOST:true',
    '--var', 'UPSTREAM_URL:http://127.0.0.1:' + mockPort + '/api/v1/chat/completions',
    '--var', 'DAILY_PER_IP:12', '--var', 'DAILY_TOTAL:1000'], { cwd: path.join(ROOT, 'worker'), detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  let wlog = '';
  wr.stdout.on('data', d => wlog += d); wr.stderr.on('data', d => wlog += d);
  const kill = () => { try { process.kill(-wr.pid, 'SIGKILL'); } catch (e) {} };
  process.on('exit', kill);
  const t0 = Date.now();
  while (!/Ready on/.test(wlog)) { if (Date.now() - t0 > 90000) { kill(); throw new Error('wrangler dev 沒有啟動：\n' + wlog.slice(-1500)); } await new Promise(r => setTimeout(r, 300)); }

  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });   // 手機尺寸
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  const URL_ = `http://127.0.0.1:${sitePort}/index.html?worker=http://127.0.0.1:${WPORT}`;
  await page.goto(URL_);
  await page.waitForFunction(() => document.body.classList.contains('home-mode'));

  async function paste(text, title) {
    await page.click('#homeAddBtn');
    await page.fill('#addPaste', text);
    await page.waitForFunction(() => !document.getElementById('addNext').disabled);
    if (title) await page.fill('#addTitle', title);
  }
  const stage = () => page.textContent('#parseStage');

  // ---- 1. 上游失敗 → 503 → 明確提示，可返回 ----
  await fetch(`http://127.0.0.1:${mockPort}/__fail`, { method: 'POST' });
  await paste(V['blank-sep'].text, '失敗測試');
  await page.click('#addNext');
  await page.waitForSelector('#consentModal', { state: 'visible' });
  ok(/第三方 AI 服務/.test(await page.textContent('#consentModal')), '首次解析顯示同意畫面（含第三方 AI 服務說明）');
  await page.click('#consentNo');
  ok(await page.evaluate(() => document.getElementById('consentModal').style.display === 'none' && document.body.classList.contains('add-mode')), '按取消停在新增畫面');
  await page.click('#addNext'); await page.click('#consentOk');
  await page.waitForFunction(() => document.getElementById('parseErr').style.display === 'block', null, { timeout: 60000 });
  ok(/服務暫時無法使用/.test(await page.textContent('#parseErr')) && await stage() === '解析失敗', '上游全失敗 → 顯示「服務暫時無法使用」');
  ok((await page.evaluate(() => Store.all('scripts'))).length === 0, '失敗不留下劇本');
  await page.click('#parseBack');
  ok(await page.evaluate(() => document.body.classList.contains('add-mode')), '失敗後可返回');
  // 上游 429（免費額度／供應商限流）→ 與一般 503 不同的明確提示
  await fetch(`http://127.0.0.1:${mockPort}/__fail?status=429`, { method: 'POST' });
  await page.click('#addNext');
  await page.waitForFunction(() => document.getElementById('parseErr').style.display === 'block', null, { timeout: 60000 });
  ok(/被限流/.test(await page.textContent('#parseErr')) && !/服務暫時無法使用/.test(await page.textContent('#parseErr')), '上游 429 → 顯示「AI 模型服務目前被限流」');
  await page.click('#parseBack');
  await fetch(`http://127.0.0.1:${mockPort}/__fail`, { method: 'DELETE' });
  upstream.calls.length = 0;

  // ---- 2. 完整流程（同意已記住，不再詢問）----
  await page.goto(URL_);
  await page.waitForFunction(() => document.body.classList.contains('home-mode'));
  const docx = path.join(ROOT, 'eval/out/docs/docx-colon.docx');
  if (fs.existsSync(docx)) {
    await page.click('#homeAddBtn');
    await page.setInputFiles('#addFile', docx);                       // 真的上傳 docx
    await page.waitForFunction(() => !document.getElementById('addNext').disabled);
    await page.fill('#addTitle', '端到端測試');
  } else await paste(V['colon-fw'].text, '端到端測試');
  await page.click('#addNext');
  await page.waitForFunction(() => document.body.classList.contains('review-mode'), null, { timeout: 90000 });
  ok(await page.evaluate(() => document.querySelectorAll('#rvBody .rv-scene').length === 22 && document.querySelectorAll('#rvBody .rv-row').length > 1000), '解析完成後先進校正頁（22 個場次、逐行列出）');
  await page.click('#rvDone');
  await page.waitForFunction(() => !document.body.classList.contains('nonapp'));
  ok(await page.evaluate(() => document.getElementById('roleOverlay').style.display === 'flex'), '按「完成」後進入選角畫面');
  const calls1 = upstream.calls.length;
  ok(calls1 === 6, '第一段 1 次 + 第二段 5 塊 = 6 次上游請求（實際 ' + calls1 + '）');
  const sizes = upstream.calls.map(c => c.messages[1].content.split('\n').filter(l => /^\d+\t/.test(l)).length);
  ok(sizes.every(s => s <= 400), '每次請求 ≤ 400 行：' + sizes.join(','));
  ok(upstream.calls.every(c => c.temperature === 0 && c.provider.data_collection === 'deny' && c.provider.only.join() === 'together,fireworks'), '請求帶供應商允許清單、data_collection:deny、溫度 0');
  const rec = (await page.evaluate(() => Store.all('scripts')))[0];
  ok(rec.title === '端到端測試' && rec.data.scenes.length === 22, '存成 22 場劇本：' + rec.data.scenes.length);
  ok(rec.data.roles.map(r => r.id).sort().join() === ['K', '偉', '朗', '玲'].sort().join(), '角色清單：' + rec.data.roles.map(r => r.id));
  const sLines = rec.data.scenes.flatMap(s => s.lines).filter(l => l.s !== undefined).length;
  ok(sLines >= 1150 && sLines <= 1164, '1164 句台詞（假模型為本機啟發式，容許少數誤標）幾乎全部組回：' + sLines);
  ok((await page.evaluate(() => Store.all('parseCache'))).length === 1, '解析結果存入 parseCache');
  ok(await page.evaluate(() => SCENES.length === 22 && document.querySelectorAll('#roleGrid .role-pick').length >= 4), '背誦介面載入 22 場、動態選角卡');
  await page.click('#roleGrid .role-pick:nth-child(1)');
  await page.waitForFunction(() => document.getElementById('roleOverlay').style.display === 'none', null, { timeout: 5000 }).catch(() => { throw new Error('選角後選角畫面沒有關閉：' + errors.join(' | ')); });
  await page.waitForSelector('#lines .line');
  ok(await page.evaluate(() => document.querySelectorAll('#lines .line').length > 20), '選角後進入背誦介面並顯示台詞');

  // ---- 3. 相同內容走快取，不再呼叫 ----
  await page.click('#homeBtn');
  await page.waitForFunction(() => document.body.classList.contains('home-mode'));
  await paste(V['colon-fw'].text, '同內容再解析一次');
  await page.click('#addNext');
  await page.waitForFunction(() => document.body.classList.contains('review-mode'), null, { timeout: 30000 });
  ok(upstream.calls.length === calls1, '相同內容不重複呼叫（仍是 ' + upstream.calls.length + ' 次）');
  ok((await page.evaluate(() => Store.all('scripts'))).length === 2, '快取命中仍建立新劇本');

  // ---- 4. 超過每日上限 → 429 提示（DAILY_PER_IP=12，已用 1(失敗)+6=7；不同內容需 1+7 次，第 13 次起 429）----
  await page.click('#rvBack');   // 此時停在校正頁，用「‹ 我的劇本」回首頁
  await page.waitForFunction(() => document.body.classList.contains('home-mode'));
  await paste(V['wrapped'].text, '會超額');
  await page.click('#addNext');
  await page.waitForFunction(() => document.getElementById('parseErr').style.display === 'block', null, { timeout: 60000 }).catch(async e => {
    throw new Error('429 測試逾時：stage=' + await stage() + ' detail=' + await page.textContent('#parseDetail') + ' body=' + await page.evaluate(() => document.body.className) + ' 上游請求數=' + upstream.calls.length + '\n' + errors.join('\n') + '\n--- wrangler 日誌尾端 ---\n' + wlog.slice(-2500));
  });
  ok(/解析次數已用完/.test(await page.textContent('#parseErr')), '超過上限 → 顯示明確的 429 訊息：' + await page.textContent('#parseErr'));
  ok((await page.evaluate(() => Store.all('scripts'))).length === 2, '中止後不留下半成品劇本');
  // 取消
  await page.click('#parseBack');

  await browser.close(); kill();
  mock.close(); site.close();
  assert.strictEqual(errors.length, 0, '頁面不得有未處理錯誤：\n' + errors.join('\n'));
  console.log(`✓ e2e.browser.test.js：${n} 項通過`);
  process.exit(0);
})().catch(e => { console.error('✗', e.message ? e.message.slice(0, 3000) : e); process.exit(1); });
