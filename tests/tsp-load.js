// 從 index.html 抽出 PARSER-CORE（TSP）與 EDITOR-CORE（TSE）區塊並執行（評測腳本與測試共用，確保測的就是上線的程式碼）
const fs = require('fs');
const path = require('path');

function block(html, name) {
  const a = html.indexOf(name + ':BEGIN');
  const b = html.indexOf(name + ':END');
  if (a < 0 || b < 0) throw new Error('index.html 找不到 ' + name + ' 標記');
  const start = html.indexOf('*/', a) + 2;           // BEGIN 標記在標題註解內，程式碼從註解結束後開始
  const end = html.lastIndexOf('/*', b);             // END 標記自成一個註解
  return html.slice(start, end);
}
const read = p => fs.readFileSync(p || path.join(__dirname, '..', 'index.html'), 'utf8');

function loadTSP(htmlPath) {
  return new Function(block(read(htmlPath), 'PARSER-CORE') + '\nreturn TSP;')();
}
// TSE 依賴 TSP，兩個區塊放在同一個作用域一起執行
function loadTSE(htmlPath) {
  const html = read(htmlPath);
  return new Function(block(html, 'PARSER-CORE') + '\n' + block(html, 'EDITOR-CORE') + '\nreturn {TSP, TSE};')();
}
module.exports = { loadTSP, loadTSE };
