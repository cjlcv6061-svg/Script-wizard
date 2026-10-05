// 本機前處理（TSP）單元測試：編號行、頁碼樣式、頁眉頁尾清理、pdf.js 文字項目組行、掃描檔偵測
const assert = require('assert');
const { loadTSP } = require('./tsp-load');
const T = loadTSP();
let n = 0;
const ok = (c, m) => { assert(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// ---- textToLines ----
{
  const r = T.textToLines('﻿第一場\r\n\r\n  偉：你好　\n　\n朗：嗯\r\n');
  eq(r.map(l => l.text), ['第一場', '偉：你好', '朗：嗯'], '空行略過、行首尾空白（含全形空格）修剪');
  eq(r.map(l => l.n), [1, 2, 3], '編號連續');
  eq(r.map(l => l.src), [1, 3, 5], '保留原文實體行號（對應表）');
  eq(T.textToLines('').length, 0, '空字串');
}

// ---- 頁碼樣式 ----
for (const s of ['第3頁', '第 12 頁', '第三頁', '第3頁／共10頁', '第3頁 / 共 10 頁', 'Page 3', 'page 3 of 10', 'P.5', '3 / 10', '- 3 -', '— 12 —']) {
  ok(T.isPageNumberLine(s, true), '應視為頁碼：' + s);
}
for (const s of ['第一場', '第三場　求神', '偉：3', '3 個人', '我今年 3 歲', '', '（燈暗）']) {
  ok(!T.isPageNumberLine(s, true), '不應視為頁碼：' + s);
}
ok(!T.isPageNumberLine('3', false) && T.isPageNumberLine('3', true), '純數字只在 includeBare 時算頁碼');

// ---- cleanPdfPages ----
function makePages(np, bodyPerPage, header, footer) {
  const pages = [];
  let k = 0;
  for (let p = 1; p <= np; p++) {
    const pg = [];
    if (header) pg.push(header(p));
    for (let i = 0; i < bodyPerPage; i++) pg.push('偉：第' + (++k) + '句台詞');
    if (footer) pg.push(footer(p));
    pages.push(pg);
  }
  return pages;
}
{
  // 頁眉固定＋頁尾頁碼變動
  const pages = makePages(8, 10, () => '《離地，到着》草稿 v3', p => '- ' + p + ' -');
  const r = T.cleanPdfPages(pages);
  ok(r.removed.length === 16, '8 頁各移除頁眉＋頁尾：' + r.removed.length);
  ok(r.pages.every(p => p.length === 10 && p.every(l => l.startsWith('偉：'))), '內文完整保留');
  eq(T.residualPageNumbers(T.pagesToLines(r.pages)), 0, '頁碼殘留 0');
}
{
  // 純數字頁碼（無「-」）需靠重複出現判定
  const r = T.cleanPdfPages(makePages(6, 8, null, p => String(p)));
  ok(r.removed.length === 6 && r.removed.every(x => x.reason === 'pageno'), '純數字頁尾被移除，原因 pageno');
}
{
  // 奇偶頁不同頁眉
  const r = T.cleanPdfPages(makePages(10, 6, p => p % 2 ? '單數頁眉' : '雙數頁眉', p => '第 ' + p + ' 頁'));
  ok(r.removed.length === 20, '奇偶頁不同頁眉也能移除：' + r.removed.length);
}
{
  // 台詞形狀的行不當頁眉刪（即使重複）
  const pages = makePages(6, 5, () => '偉：好', null);
  const r = T.cleanPdfPages(pages);
  ok(r.removed.length === 0, '「角色：台詞」形狀的重複行不刪');
}
{
  // 內文中的場次編號行（純數字）不在邊緣重複 → 保留
  const pages = [['1', '偉：甲', '朗：乙', '偉：丙'], ['朗：丁', '偉：戊', '朗：己', '偉：庚'], ['朗：辛', '偉：壬', '朗：癸', '偉：子']];
  const r = T.cleanPdfPages(pages);
  ok(r.pages[0][0] === '1', '孤立的數字行不被誤刪');
}
{
  // 單頁文件：只刪明確的「第N頁」型態
  const r = T.cleanPdfPages([['偉：甲', '朗：乙', '第 1 頁']]);
  ok(r.removed.length === 1 && r.pages[0].length === 2, '單頁只刪明確頁碼');
  const r2 = T.cleanPdfPages([['偉：甲', '朗：乙', '1']]);
  ok(r2.removed.length === 0, '單頁的純數字不刪（無從判斷）');
}
{
  // 兩層頁眉
  const r = T.cleanPdfPages(makePages(6, 6, p => '機密\n'.trim() + ' ' + 'X', p => 'Page ' + p + ' of 6'));
  ok(r.removed.length === 12, '頁眉＋英文頁尾');
}

// ---- itemsToLines ----
{
  const it = (str, x, y, w, fs = 11) => ({ str, transform: [fs, 0, 0, fs, x, y], width: w });
  const lines = T.itemsToLines([
    it('朗：', 60, 700, 22), it('你好', 82, 700, 22),          // 同一行兩個項目，無縫隙
    it('第二行', 60, 683, 33),
    it('Hello', 60, 666, 30), it('world', 95, 666, 30),        // 有縫隙 → 補空白
    it('頂行', 60, 760, 22)                                     // 亂序輸入（y 最大在最前）
  ].reverse());
  eq(lines, ['頂行', '朗：你好', '第二行', 'Hello world'], '依 y 由上到下、x 由左到右組行');
  eq(T.itemsToLines([it('   ', 10, 10, 5)]), [], '全空白項目不產生行');
}

// ---- 掃描檔偵測 ----
ok(T.looksScanned([[], [], []]), '沒有文字 → 掃描檔');
ok(T.looksScanned([['3'], ['4']]), '只有頁碼 → 掃描檔');
ok(!T.looksScanned([['偉：你好嗎，今日天氣好好呀，你去咗邊度呀？'], ['朗：我哋去睇戲啦，你想睇咩戲呀？']]), '有文字不是掃描檔');

// ---- buildLines ----
{
  const r = T.buildLines({ text: '第一場\n\n偉：甲\n朗：乙' });
  ok(r.lines.length === 3 && r.stats.removed === 0 && !r.scanned, 'text 輸入');
  eq(T.toWire(r.lines), [[1, '第一場'], [2, '偉：甲'], [3, '朗：乙']], 'toWire');
  const p = T.buildLines({ pages: makePages(5, 6, () => '頁眉', p => '- ' + p + ' -') });
  ok(p.lines.length === 30 && p.removed.length === 10 && p.lines[0].page === 1 && p.lines[29].page === 5, 'pages 輸入：清頁眉頁尾並記頁碼');
  let threw = false;
  try { T.buildLines({ text: Array(T.MAX_LINES + 2).fill('偉：甲').join('\n') }); } catch (e) { threw = true; }
  ok(threw, '超過行數上限會拒絕');
}

// ---- 內文連號頁碼 ----
{
  const body = [];
  for (let p = 1; p <= 6; p++) { for (let i = 0; i < 5; i++) body.push('偉：第' + p + '頁第' + i + '句'); body.push('- ' + p + ' -'); }
  const r = T.buildLines({ text: body.join('\n') });
  ok(r.lines.length === 30 && r.removed.length === 6 && r.removed.every(x => x.reason === 'pageno-seq'), '貼上文字中的連號頁碼被移除');
  ok(r.lines[29].n === 30, '移除後重新編號');
  ok(r.lines.every(l => !/^- \d+ -$/.test(l.text)), '沒有殘留');
  // 不連號、次數不足、純數字 都不動
  const keep = T.buildLines({ text: ['偉：甲', '- 3 -', '朗：乙', '- 9 -', '偉：丙', '- 2 -', '朗：丁'].join('\n') });
  ok(keep.removed.length === 0, '不連號的不刪');
  const bare = T.buildLines({ text: ['1', '偉：甲', '2', '朗：乙', '3', '偉：丙', '4', '朗：丁'].join('\n') });
  ok(bare.removed.length === 0, '純數字（可能是場次編號）不刪');
  const two = T.buildLines({ text: ['偉：甲', '第 1 頁', '朗：乙', '第 2 頁'].join('\n') });
  ok(two.removed.length === 0, '只出現 2 次不夠判斷');
}

console.log(`✓ parser.test.js：${n} 項通過`);
