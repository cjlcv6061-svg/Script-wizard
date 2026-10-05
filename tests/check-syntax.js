// 抽出 index.html 內的 <script> 並用 node --check 驗證語法
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT } = require('./helpers');

function checkHtml(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, i = 0;
  while ((m = re.exec(html))) {
    const tmp = path.join(os.tmpdir(), `check-${process.pid}-${i++}.js`);
    fs.writeFileSync(tmp, m[1]);
    try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
    catch (e) { console.error(`✗ ${file} <script>#${i}\n` + e.stderr); process.exit(1); }
    finally { fs.unlinkSync(tmp); }
  }
  console.log(`✓ ${file}: ${i} inline script(s) pass node --check`);
}
checkHtml('index.html');
