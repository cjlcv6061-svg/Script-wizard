// 手機尺寸 Chromium：歌曲區塊 {song, lyrics}——背誦畫面顯示歌詞卡片（不編號、不隱藏）、
// 校正頁顯示／修改歌名與歌詞、拆成一般行、把一般行改成歌詞並併進相鄰的歌。
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { ROOT } = require('./helpers');

let chromium;
try { ({ chromium } = require('playwright-core')); } catch (e) { console.log('- songs.browser：略過（沒有 playwright-core）'); process.exit(0); }
const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const exe = [path.join(base, 'chromium')].find(p => fs.existsSync(p));
if (!exe) { console.log('- songs.browser：略過（找不到 Chromium）'); process.exit(0); }

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
  schema: 2, meta: { title: '歌曲測試', lang: 'yue' },
  roles: [{ id: '偉', name: '葉志偉', aliases: [], gender: 'm', spoken: '偉' }, { id: '朗', name: '陳立朗', aliases: [], gender: 'm', spoken: '朗' }],
  scenes: [{ no: '第一場', name: '甲', season: '', place: '', lines: [
    { s: '偉', t: '你好呀。' },
    { d: '（音樂起）' },
    { song: '出發之歌', lyrics: ['(合)　出發吧出發吧，', '(偉)　向前行向前行，', '齊齊向前進！'] },
    { s: '朗', t: '唱得好。' },
    { d: '多一句歌詞' }
  ] }]
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
  page.on('dialog', d => d.accept());
  fs.mkdirSync(path.join(ROOT, 'eval/out'), { recursive: true });
  const shot = name => page.screenshot({ path: path.join(ROOT, 'eval/out', name) });

  await page.goto(URL_);
  await page.waitForFunction(() => document.body.classList.contains('home-mode'));
  const recId = await page.evaluate(async t => (await importScriptText(t, 'x.json')).id, JSON.stringify(SCRIPT));
  const stored = () => page.evaluate(async id => (await Store.get('scripts', id)).data, recId);
  ok(await page.evaluate(id => Store.get('scripts', id).then(r => countScriptLines(r.data)), recId) === 2, '台詞行數不含歌曲與指示（2 句）');
  await page.evaluate(() => renderHome());

  // ---- 校正頁 ----
  await page.click('.script-card .ghost-btn:nth-child(2)');
  await page.waitForSelector('#rvBody .rv-row');
  ok((await page.$$('#rvBody .rv-row.k-Y')).length === 1, '校正頁有 1 個歌曲區塊');
  ok(/歌曲/.test(await page.textContent('.rv-row.k-Y .rv-chip')) && /出發之歌（3 行）/.test(await page.textContent('.rv-row.k-Y .rv-text')), '標籤「歌曲」與歌名、行數');
  await shot('s1_review_song.png');
  await page.click('.rv-row.k-Y');
  await page.waitForSelector('.rv-row.k-Y .rv-songtitle');
  await page.fill('.rv-row.k-Y .rv-songtitle', '新歌名');
  await page.fill('.rv-row.k-Y textarea', '第一句\n第二句\n第三句\n第四句');
  await shot('s2_review_song_edit.png');
  await page.click('.rv-row.k-Y .rv-btns .primary-solid');
  await page.waitForFunction(() => /新歌名（4 行）/.test(document.querySelector('.rv-row.k-Y .rv-text').textContent));
  let d = await stored();
  ok(JSON.stringify(d.scenes[0].lines[2]) === JSON.stringify({ song: '新歌名', lyrics: ['第一句', '第二句', '第三句', '第四句'] }), '改歌名與歌詞已寫回 IndexedDB');

  // 一般行（最後那行指示）→ 歌詞：前面不是歌，自成一個歌曲區塊
  await page.click('.rv-row.k-D:last-child');
  await page.waitForSelector('.rv-row.open .rv-seg');
  await page.click('.rv-row.open .rv-seg button[data-k="Y"]');
  await page.click('.rv-row.open .rv-btns .primary-solid');
  await page.waitForFunction(() => document.querySelectorAll('.rv-row.k-Y').length === 2);
  d = await stored();
  ok(d.scenes[0].lines[4].song === '' && d.scenes[0].lines[4].lyrics.join() === '多一句歌詞', '一般行改成歌詞後自成歌曲區塊');

  // 拆成一般行
  await page.click('.rv-row.k-Y >> nth=1');                              // 後來由一般行改成的那首（1 句）
  await page.waitForSelector('.rv-row.k-Y.open .rv-songtitle');
  await page.click('.rv-row.k-Y.open .rv-btns button:nth-child(3)');   // 儲存、取消、拆成一般行
  await page.waitForFunction(() => document.querySelectorAll('.rv-row.k-Y').length === 1);
  d = await stored();
  ok(d.scenes[0].lines.filter(l => l.d !== undefined).length === 2 && d.scenes[0].lines.filter(l => l.song !== undefined).length === 1, '拆成一般行：1 句歌詞變回 1 行指示（加原有 1 行共 2）');
  await page.evaluate(() => { document.querySelector('#rvDone').click(); });

  // ---- 背誦畫面 ----
  await page.waitForSelector('#roleGrid .role-pick');
  await page.click('#roleGrid .role-pick:nth-child(1)');
  await page.waitForSelector('#lines .line');
  const lines = await page.evaluate(() => SCENES[0].lines.map(l => Object.keys(l).join()));
  ok(lines.includes('song,lyrics'), '劇本載入後仍有歌曲區塊：' + lines.join(' | '));
  await page.evaluate(() => { renderLines(); });
  const card = await page.evaluate(() => { const e = document.querySelector('#lines .line.song'); return e && { head: e.querySelector('.song-head').textContent, rows: e.querySelectorAll('.song-lyrics div').length, hasNo: !!e.querySelector('.line-no'), isSun: e.classList.contains('sun') }; });
  ok(card && /♪ 新歌名/.test(card.head) && card.rows === 4 && !card.hasNo && !card.isSun, '背誦畫面顯示歌曲卡片：' + JSON.stringify(card));
  const nums = await page.evaluate(() => [...document.querySelectorAll('#lines .line .line-no')].map(e => e.textContent));
  ok(nums.join() === '1,2', '句號只編台詞行（歌曲與指示不編）：' + nums.join());
  await shot('s3_recite_song.png');
  await browser.close(); site.close();
  assert.strictEqual(errors.length, 0, '頁面不得有未處理錯誤：\n' + errors.join('\n'));
  console.log(`✓ songs.browser.test.js：${n} 項通過`);
  process.exit(0);
})().catch(e => { console.error('✗', e.message ? e.message.slice(0, 3000) : e); process.exit(1); });
