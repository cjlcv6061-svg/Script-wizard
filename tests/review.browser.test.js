// 手機尺寸 Chromium：校正頁（改標籤／角色／合併／拆行／場次分隔／角色管理／待校正跳轉／雜訊）、
// 每次修改即時寫回 IndexedDB、完成後進入背誦；PWA（manifest、service worker、離線重新載入）。
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { ROOT } = require('./helpers');

let chromium;
try { ({ chromium } = require('playwright-core')); } catch (e) { console.log('- review.browser：略過（沒有 playwright-core）'); process.exit(0); }
const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const exe = [path.join(base, 'chromium')].find(p => fs.existsSync(p));
if (!exe) { console.log('- review.browser：略過（找不到 Chromium）'); process.exit(0); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const site = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html');
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
let n = 0;
const ok = (c, m) => { assert(c, m); n++; };

const SCRIPT = {
  schema: 2, meta: { title: '校正測試', lang: 'yue' },
  roles: [{ id: '偉', name: '葉志偉', aliases: [], gender: 'm', spoken: '偉' }, { id: '朗', name: '陳立朗', aliases: [], gender: 'm', spoken: '朗' }, { id: '路人', name: '路人', aliases: [], gender: 'n', spoken: '路人' }, { id: '多餘', name: '多餘', aliases: [], gender: 'n', spoken: '多餘' }],
  scenes: [
    { no: '第一場', name: '甲', season: '', place: '', lines: [{ s: '偉', t: '你好，', rv: true }, { s: '偉', t: '朗呀' }, { x: '- 3 -' }, { d: '（燈暗）' }, { s: '偉/朗', t: 'ok' }, { s: '路人', t: '哈囉哈囉', rv: true }] },
    { no: '第二場', name: '乙', season: '', place: '', lines: [{ s: '朗', t: '再見' }, { s: '朗', t: '真係', r: '（笑）真係' }] }
  ]
};

(async () => {
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const URL_ = 'http://127.0.0.1:' + site.address().port + '/index.html';
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  const dialogs = [];
  let promptAnswer = null;
  page.on('dialog', d => { dialogs.push(d.message()); if (d.type() === 'prompt') d.accept(promptAnswer || ''); else d.accept(); });
  const shot = (name) => page.screenshot({ path: path.join(ROOT, 'eval/out', name) });
  fs.mkdirSync(path.join(ROOT, 'eval/out'), { recursive: true });

  await page.goto(URL_);
  await page.waitForFunction(() => document.body.classList.contains('home-mode'));
  const recId = await page.evaluate(async t => (await importScriptText(t, 'x.json')).id, JSON.stringify(SCRIPT));
  const stored = () => page.evaluate(async id => (await Store.get('scripts', id)).data, recId);
  await page.evaluate(() => renderHome());
  await shot('m1_home.png');

  // ---- 進入校正 ----
  await page.click('.script-card .ghost-btn:nth-child(2)');       // 校正
  await page.waitForSelector('#rvBody .rv-row');
  ok(await page.evaluate(() => document.body.classList.contains('review-mode') && document.body.classList.contains('nonapp')), '進入校正頁');
  ok(await page.textContent('#rvPend') === '2', '待校正 2 行');
  ok((await page.$$('#rvBody .rv-row')).length === 8 - 1, '預設隱藏雜訊行（8 行 - 1 雜訊 = 7）');
  ok((await page.$$('#rvBody .rv-row.rv')).length === 2, '待校正行以橘色邊框標示');
  await shot('m2_review.png');

  // ---- 待校正一鍵跳轉 ----
  await page.click('#rvNext');
  ok(await page.evaluate(() => document.querySelector('.rv-row.flash') && document.querySelector('.rv-row.flash').classList.contains('rv')), '跳到並閃爍第一個待校正行');
  await page.click('#rvNext');
  ok(await page.evaluate(() => document.querySelector('.rv-row.flash').dataset.li) === '5', '再按跳到下一個待校正行');

  // ---- 改標籤：台詞 → 指示（存檔即寫回 IndexedDB）----
  await page.click('.rv-row[data-si="0"][data-li="0"]');
  await page.waitForSelector('.rv-edit');
  await shot('m3_editor.png');
  await page.click('.rv-seg button[data-k="D"]');
  await page.click('.rv-btns .primary-solid');
  ok(await page.evaluate(() => document.querySelector('.rv-row[data-si="0"][data-li="0"]').classList.contains('k-D')), '台詞改成指示');
  let d = await stored();
  ok(JSON.stringify(d.scenes[0].lines[0]) === '{"d":"你好，"}', '即時寫回 IndexedDB：' + JSON.stringify(d.scenes[0].lines[0]));
  ok(await page.textContent('#rvPend') === '1', '已改的行不再待校正');

  // ---- 改角色（合說）----
  await page.click('.rv-row[data-si="0"][data-li="1"]');
  await page.click('.rv-rolechip[data-id="朗"]');                 // 偉 + 朗
  await page.click('.rv-btns .primary-solid');
  d = await stored();
  ok(d.scenes[0].lines[1].s === '偉/朗', '改成合說：' + d.scenes[0].lines[1].s);

  // ---- 與上一行合併 ----
  await page.click('.rv-row[data-si="0"][data-li="4"]');          // 偉/朗 ok（前面隔著指示 d、雜訊）
  await page.click('text=與上一行合併');
  d = await stored();
  ok(d.scenes[0].lines.length === 5 && d.scenes[0].lines[3].d === '（燈暗）ok', '與上一行合併（指示接台詞 → 指示）：' + JSON.stringify(d.scenes[0].lines[3]));

  // ---- 拆成兩行 ----
  await page.click('.rv-row[data-si="1"][data-li="0"]');
  await page.evaluate(() => { const t = document.querySelector('.rv-edit textarea'); t.focus(); t.setSelectionRange(1, 1); });
  await page.click('text=在游標處拆成兩行');
  d = await stored();
  ok(d.scenes[1].lines.length === 3 && d.scenes[1].lines[0].t === '再' && d.scenes[1].lines[1].t === '見', '依游標拆成兩行');

  // ---- 場次分隔：插入、改名、併回 ----
  await page.click('.rv-row[data-si="1"][data-li="2"]');
  promptAnswer = '第三場　新場次';
  await page.click('text=在此行前插入場次');
  d = await stored();
  ok(d.scenes.length === 3 && d.scenes[2].no === '第三場' && d.scenes[2].name === '新場次' && d.scenes[2].lines.length === 1, '插入場次分隔');
  await page.fill('#rvBody section:nth-child(3) .f-place', '東京');
  await page.dispatchEvent('#rvBody section:nth-child(3) .f-place', 'change');
  d = await stored();
  ok(d.scenes[2].place === '東京', '場次欄位修改寫回');
  await page.click('#rvBody section:nth-child(3) .rv-scene-head .ghost-btn');   // 併入上一場
  d = await stored();
  ok(d.scenes.length === 2 && d.scenes[1].lines.length === 3, '移除場次分隔（併入上一場）');

  // ---- 雜訊行 ----
  await page.click('#rvNoise');
  ok((await page.$$('#rvBody .rv-row.k-X')).length === 1, '顯示雜訊行');
  await page.click('.rv-row.k-X');
  await page.click('.rv-seg button[data-k="D"]');
  await page.click('.rv-btns .primary-solid');
  d = await stored();
  ok(d.scenes[0].lines.some(l => l.d === '- 3 -') && !d.scenes[0].lines.some(l => l.x), '雜訊行還原成指示');

  // ---- 角色面板 ----
  await page.click('#rvRoles');
  await page.waitForSelector('#rolesList .r-row');
  await shot('m4_roles.png');
  const rows = await page.$$('#rolesList .r-row');
  ok(rows.length === 4, '列出 4 個角色');
  // 刪除：只有沒用到的「多餘」可刪
  const delStates = await page.$$eval('#rolesList .r-row', rs => rs.map(r => r.querySelector('.danger').disabled));
  ok(JSON.stringify(delStates) === JSON.stringify([true, true, true, false]), '有台詞的角色不能刪除：' + delStates);
  await page.click('#rolesList .r-row:nth-child(4) .danger');
  d = await stored();
  ok(d.roles.length === 3, '刪除沒有台詞的角色');
  // 重新命名：路人 → 群眾（代號與台詞同步改寫）
  await page.fill('#rolesList .r-row:nth-child(3) .r-id', '群眾');
  await page.dispatchEvent('#rolesList .r-row:nth-child(3) .r-id', 'change');
  d = await stored();
  ok(d.roles[2].id === '群眾' && d.scenes[0].lines.find(l => l.s === '群眾'), '重新命名並改寫所有台詞');
  // 性別
  await page.selectOption('#rolesList .r-row:nth-child(2) select:nth-of-type(1)', 'f');
  d = await stored();
  ok(d.roles[1].gender === 'f', '設定性別');
  // 合併：朗 → 偉
  await page.selectOption('#rolesList .r-row:nth-child(2) select:nth-of-type(2)', '偉');
  d = await stored();
  ok(d.roles.map(r => r.id).join() === '偉,群眾' && !JSON.stringify(d.scenes).includes('"朗"') && d.scenes[1].lines[0].s === '偉', '合併角色並改寫所有行：' + d.roles.map(r => r.id));
  ok(dialogs.some(m => /合併給/.test(m)), '合併前有確認');
  // 新增角色
  await page.fill('#newRoleId', '新人');
  await page.click('#newRoleBtn');
  d = await stored();
  ok(d.roles.some(r => r.id === '新人'), '新增角色');
  await page.click('#rolesClose');

  // ---- 重新載入後修改仍在 ----
  await page.reload();
  await page.waitForFunction(() => document.body.classList.contains('home-mode'));
  await page.evaluate(id => openReview(id), recId);
  await page.waitForSelector('#rvBody .rv-row');
  ok((await page.$$('#rvBody .rv-scene')).length === 2 && await page.textContent('#rvTitle') === '校正測試', '重新載入後校正結果還在');

  // ---- 完成 → 背誦 ----
  await page.click('#rvDone');
  await page.waitForSelector('#roleGrid .role-pick');
  ok((await page.$$('#roleGrid .role-pick')).length === 3, '選角畫面依校正後的角色產生（偉、群眾、新人）');
  await page.click('#roleGrid .role-pick:nth-child(1)');
  await page.waitForSelector('#lines .line');
  ok(await page.evaluate(() => SCENES.every(s => s.lines.every(l => l.x === undefined)) && SCENES[0].lines.length > 0), '背誦用的資料不含雜訊行');
  await shot('m5_rehearsal.png');

  // ---- PWA ----
  const man = await (await fetch(URL_.replace('index.html', 'manifest.webmanifest'))).json();
  ok(man.display === 'standalone' && man.icons.length >= 3 && man.start_url === './', 'manifest 內容');
  for (const ic of man.icons) ok((await fetch(URL_.replace('index.html', ic.src))).status === 200, '圖示存在：' + ic.src);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).includes('tsj-v1') && !!(await (await caches.open('tsj-v1')).match('index.html')));
  const cached = await page.evaluate(async () => (await (await caches.open('tsj-v1')).keys()).map(r => new URL(r.url).pathname.replace(/^\//, '')));
  ok(['index.html', 'manifest.webmanifest', 'vendor/pdf.min.js', 'vendor/mammoth.browser.min.js'].every(f => cached.includes(f)), 'service worker 已預先快取外殼與函式庫：' + cached.length + ' 個檔案');
  await page.reload();                                              // 讓頁面由 SW 控制
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await ctx.setOffline(true);
  await page.goto(URL_ + '?offline=1');
  await page.waitForFunction(() => document.body.classList.contains('home-mode'));
  ok((await page.$$('.script-card')).length === 1, '離線重新載入：頁面與劇本都在');
  await ctx.setOffline(false);

  await browser.close(); site.close();
  assert.strictEqual(errors.length, 0, '頁面不得有未處理錯誤：\n' + errors.join('\n'));
  console.log(`✓ review.browser.test.js：${n} 項通過`);
  process.exit(0);
})().catch(e => { console.error('✗', e.message ? e.message.slice(0, 3000) : e); process.exit(1); });
