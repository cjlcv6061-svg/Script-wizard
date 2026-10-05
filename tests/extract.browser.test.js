// 真瀏覽器（Chromium）端到端：用 vendor/ 的 mammoth 與 pdf.js 讀 docx／PDF／txt／貼上，
// 與合成劇本的標準答案比對，並量測 PDF 頁碼殘留。需要 playwright-core 與 Chromium；缺少時略過。
// 測試檔由 eval/synth.js + eval/build_docs.py 產生（需要 python-docx、reportlab）。
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { ROOT } = require('./helpers');
const { alignLines } = require('../eval/lib/align');

function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const cands = [path.join(base, 'chromium')];
  try { for (const d of fs.readdirSync(base)) if (/^chromium-/.test(d)) cands.push(path.join(base, d, 'chrome-linux', 'chrome')); } catch (e) {}
  return cands.find(p => { try { return fs.statSync(p).isFile() || fs.statSync(p).isSymbolicLink(); } catch (e) { return false; } });
}
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (e) { console.log('- extract.browser：略過（沒有 playwright-core）'); process.exit(0); }
const exe = findChromium();
if (!exe) { console.log('- extract.browser：略過（找不到 Chromium）'); process.exit(0); }

const SYN = path.join(ROOT, 'eval/out/synth'), DOCS = path.join(ROOT, 'eval/out/docs');
if (!fs.existsSync(path.join(DOCS, 'pdf-wrapped.pdf')) || !fs.existsSync(path.join(DOCS, 'pdf-cns1-v.pdf'))) {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'eval/synth.js'), SYN], { stdio: 'pipe' });
    execFileSync('python3', [path.join(ROOT, 'eval/build_docs.py'), SYN, DOCS], { stdio: 'pipe', cwd: ROOT });
  } catch (e) { console.log('- extract.browser：略過（無法產生測試檔：' + String(e.stderr || e.message).split('\n').slice(-3).join(' ') + '）'); process.exit(0); }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html');
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

let n = 0;
const ok = (c, m) => { assert(c, m); n++; };

(async () => {
  await new Promise(r => server.listen(0, r));
  const url = 'http://localhost:' + server.address().port + '/index.html';
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const errors = [];
  async function fresh() {
    const ctx = await browser.newContext();
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());   // 沙箱外部字型不可用，與功能無關
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url);
    await page.click('#homeAddBtn');
    return page;
  }
  const getSrc = page => page.evaluate(() => SRC && { kind: SRC.kind, lines: SRC.lines.map(l => l.text), removed: SRC.removed.map(r => r.text + '|' + r.reason), stats: SRC.stats });

  // ---- 檔案：與標準答案對齊 ----
  const report = [];
  for (const id of ['docx-colon', 'docx-centered', 'pdf-wrapped', 'pdf-centered', 'pdf-messy', 'pdf-cns1-h', 'pdf-cns1-v']) {
    const file = path.join(DOCS, id + (id.startsWith('pdf') ? '.pdf' : '.docx'));
    const gold = JSON.parse(fs.readFileSync(path.join(DOCS, id + '.gold.json'), 'utf8')).gold;
    const page = await fresh();
    await page.setInputFiles('#addFile', file);
    await page.waitForFunction(() => !document.getElementById('addNext').disabled || document.getElementById('addStatus').classList.contains('bad'), null, { timeout: 60000 });
    const src = await getSrc(page);
    ok(src, id + '：有讀到內容');
    const al = alignLines(src.lines, gold.map(g => g.text));
    // 內容行（非 N）全部都要被讀到
    const content = gold.map((g, i) => ({ g, i })).filter(x => x.g.label !== 'N');
    const hit = content.filter(x => al.gold2pred[x.i] >= 0).length;
    const cover = hit / content.length;
    // 多出來的行（抽出但不在答案裡）
    const extra = al.pred2gold.filter(v => v < 0).length;
    const pageNoLeft = src.stats.residualPageNo;
    report.push(`${id.padEnd(14)} 行數 ${String(src.lines.length).padStart(4)}／答案 ${gold.length}  內容涵蓋 ${(cover * 100).toFixed(2)}%  多餘行 ${extra}  移除頁眉頁尾 ${src.removed.length}  殘留頁碼行 ${pageNoLeft}`);
    ok(cover >= 0.995, `${id}：內容涵蓋率 ${(cover * 100).toFixed(2)}% 應 ≥ 99.5%`);
    ok(extra <= 3, `${id}：不應多出行（${extra}）`);
    if (id.startsWith('pdf-cns1')) {
      ok(src.lines.length >= 70, `${id}：不內嵌字型的繁中 PDF 要能抽出文字（${src.lines.length} 行；沒有 CMap 會是 0 行）`);
      ok(pageNoLeft === 0 && src.removed.length >= 3, `${id}：頁眉頁尾／頁碼已移除（${src.removed.length}）`);
    }
    if (id === 'pdf-wrapped' || id === 'pdf-centered') {
      ok(pageNoLeft === 0, `${id}：頁碼殘留應為 0（${pageNoLeft}）`);
      ok(src.removed.length >= 2 * 15, `${id}：頁眉頁尾被移除（${src.removed.length}）`);
    }
    await page.context().close();
  }
  console.log(report.join('\n'));

  // ---- 貼上 / txt / 編碼 / 錯誤 ----
  {
    const page = await fresh();
    await page.fill('#addPaste', '第一場\n\n偉：你好\n朗：你好\n');
    await page.waitForFunction(() => !document.getElementById('addNext').disabled);
    const s = await getSrc(page);
    ok(s.kind === 'text' && s.lines.length === 3, '貼上文字');
    await page.context().close();
  }
  {
    const tmp = path.join(ROOT, 'eval/out/tmp'); fs.mkdirSync(tmp, { recursive: true });
    execFileSync('python3', ['-c', `open(${JSON.stringify(path.join(tmp, 'big5.txt'))},'wb').write('偉：你好\\n'.encode('big5'))`]);
    fs.writeFileSync(path.join(tmp, 'u16.txt'), Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('偉：你好\n朗：再見\n', 'utf16le')]));
    fs.writeFileSync(path.join(tmp, 'old.doc'), 'x');
    const page = await fresh();
    await page.setInputFiles('#addFile', path.join(tmp, 'big5.txt'));
    await page.waitForFunction(() => !document.getElementById('addNext').disabled);
    ok((await getSrc(page)).lines[0] === '偉：你好', 'Big5 txt 正確解碼');
    await page.setInputFiles('#addFile', path.join(tmp, 'u16.txt'));
    await page.waitForFunction(() => SRC && SRC.lines.length === 2);
    ok((await getSrc(page)).lines[1] === '朗：再見', 'UTF-16 txt 正確解碼');
    await page.setInputFiles('#addFile', path.join(tmp, 'old.doc'));
    await page.waitForFunction(() => document.getElementById('addStatus').classList.contains('bad'));
    ok(/\.docx/.test(await page.textContent('#addStatus')), '.doc 給出明確提示');
    // 掃描 PDF（只有圖形、沒有文字）
    execFileSync('python3', ['-c', `
from reportlab.pdfgen import canvas
c=canvas.Canvas(${JSON.stringify(path.join(tmp, 'scan.pdf'))}); c.rect(50,50,300,300,fill=1); c.showPage(); c.rect(60,60,200,200,fill=1); c.save()`]);
    await page.setInputFiles('#addFile', path.join(tmp, 'scan.pdf'));
    await page.waitForFunction(() => document.getElementById('addStatus').classList.contains('bad') && /抽不出文字/.test(document.getElementById('addStatus').textContent), null, { timeout: 30000 });
    ok(true, '圖片 PDF 提示「抽不出文字」');
    await page.context().close();
  }
  await browser.close();
  server.close();
  assert.strictEqual(errors.length, 0, '頁面不得有未處理錯誤：\n' + errors.join('\n'));
  console.log(`✓ extract.browser.test.js：${n} 項通過`);
})().catch(e => { console.error('✗', e.message.slice(0, 3000)); try { server.close(); } catch (_) {} process.exit(1); });
