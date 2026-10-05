// 從 index.html 抽出 PARSER-CORE 區塊並執行，回傳 TSP（評測腳本與測試共用，確保測的就是上線的程式碼）
const fs = require('fs');
const path = require('path');

function loadTSP(htmlPath) {
  const html = fs.readFileSync(htmlPath || path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('PARSER-CORE:BEGIN');
  const b = html.indexOf('PARSER-CORE:END');
  if (a < 0 || b < 0) throw new Error('index.html 找不到 PARSER-CORE 標記');
  const start = html.indexOf('*/', a) + 2;           // BEGIN 標記在標題註解內，程式碼從註解結束後開始
  const end = html.lastIndexOf('/*', b);             // END 標記自成一個註解
  const code = html.slice(start, end);
  return new Function(code + '\nreturn TSP;')();
}
module.exports = { loadTSP };
