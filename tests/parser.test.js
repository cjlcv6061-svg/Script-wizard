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

// ---- 帶頁碼的頁眉頁尾：頁碼 ＝ 頁序 ＋ 常數（劇本合集每份劇本各有自己的偶數頁頁眉，每種只出現約 10 次）----
{
  const body = (p, n = 8) => Array.from({ length: n }, (_, i) => '台詞' + p + '號第' + String.fromCharCode(0x4e00 + p) + String.fromCharCode(0x4e00 + i * 3) + '行內容');
  const bodyOf = pages => pages.flat().filter(l => l.startsWith('台詞'));
  // (1) 合集：偶數頁頂端「頁碼 編劇 《劇名》」（兩份劇本，各 ~10 次），奇數頁底端「頁碼 劇本創作比賽 得獎劇本集」
  {
    const head = p => p + (p < 22 ? ' 甲編劇 《甲劇》' : ' 乙編劇 《乙劇》');
    const pages = []; for (let p = 1; p <= 40; p++) pages.push(p % 2 ? body(p).concat([p + ' 劇本創作比賽 得獎劇本集']) : [head(p)].concat(body(p)));
    const r = T.cleanPdfPages(pages);
    const hdr = r.removed.filter(x => x.reason === 'pageno-hdr');
    eq(hdr.length, 20, '20 個偶數頁頁眉（兩種形狀、各 10 頁）都被移除，原因 pageno-hdr');
    ok(hdr.every(x => /《[甲乙]劇》/.test(x.text)), '移除的都是頁眉');
    eq(r.pages.flat().length, 40 * 8, '剩下的只有內文（奇數頁頁尾由原本的重複規則移除）');
    eq(bodyOf(r.pages).length, 40 * 8, '內文一行不少');
    eq(T.numberedEdgeDrops(pages.map(p => p.slice()), 3).size > 0, true, 'numberedEdgeDrops 單獨呼叫也找得到');
  }
  // (2) 頁碼從頭重編：兩段各自成立
  {
    const pages = []; for (let p = 1; p <= 20; p++) pages.push([((p - 1) % 10 + 1) + ' 紅樓夢 草稿'].concat(body(p)));
    const r = T.cleanPdfPages(pages);
    eq(r.removed.length, 20, '頁碼在第 11 頁重編為 1：兩段（各 10 頁）都成立');
  }
  // (3) 英文「N | Title」
  {
    const pages = []; for (let p = 1; p <= 12; p++) pages.push(body(p).concat([p + ' | The Glass Menagerie']));
    eq(T.cleanPdfPages(pages).removed.length, 12, '英文「N | Title」');
  }
  // (4) 不能誤刪：場次號循環、含數字的台詞、一頁一場「第N場」、頁碼不連續、只有 2 頁吻合
  {
    const cyc = []; for (let p = 1; p <= 30; p++) cyc.push(['第' + (p % 7 + 1) + '場 重複出現的標題'].concat(body(p)));
    eq(T.numberedEdgeDrops(cyc, 3).size, 0, '場次標題（第N場）不當頁眉');
    const dlg = []; for (let p = 1; p <= 30; p++) dlg.push(['阿明：我要去' + (p % 3 + 1) + '號房'].concat(body(p)));
    eq(T.numberedEdgeDrops(dlg, 3).size, 0, '含數字的台詞不當頁眉');
    const scn = []; for (let p = 1; p <= 30; p++) scn.push(['第' + p + '場'].concat(body(p)));
    eq(T.numberedEdgeDrops(scn, 3).size, 0, '一頁一場、場次號剛好等於頁序：不刪');
    const rnd = []; for (let p = 1; p <= 30; p++) rnd.push([((p * 7) % 11 + 1) + ' 附註'].concat(body(p)));
    eq(T.numberedEdgeDrops(rnd, 3).size, 0, '數字與頁序無關：不刪');
    const two = []; for (let p = 1; p <= 30; p++) two.push((p <= 2 ? [p + ' 草稿'] : [(p * 5 % 9 + 20) + ' 草稿']).concat(body(p)));
    eq(T.numberedEdgeDrops(two, 3).size, 0, '只有 2 頁吻合（<3）：不刪');
    const mid = []; for (let p = 1; p <= 30; p++) mid.push(body(p, 5).concat(['內文裡有 ' + p + ' 個字的行']).concat(body(p, 5)));
    eq(T.numberedEdgeDrops(mid, 3).size, 0, '數字在行中間、不在邊緣：不刪');
  }
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

// ---- 左欄說話者／右欄台詞（沒有冒號）、字距空白 ----
{
  const it = (str, x, y, w, fs = 12) => ({ str, transform: [fs, 0, 0, fs, x, y], width: w });
  const rowsOf = (n, name, body) => { const o = []; for (let i = 0; i < n; i++) { const y = 700 - i * 20; o.push(it(name[i % name.length], 113.6, y, 27.6), it(' ', 141.2, y, 11.5), it(body + i, 152.7, y, 100)); } return o; };
  const col = T.itemsToLines(rowsOf(8, ['阿 宏', '阿 南'], '學 長 去 哪 '));
  ok(col.length === 8 && col.every(l => /^阿 [宏南]：/.test(l)), '名字欄＋台詞欄的版面：名字後補「：」：' + col[0]);
  // 續行（只有台詞欄）不補
  const withCont = T.itemsToLines(rowsOf(8, ['阿宏'], '台詞').concat([it('接下去的一行', 152.7, 500, 80)]));
  ok(withCont[withCont.length - 1] === '接下去的一行', '只有台詞欄的續行不補冒號');
  // 只有幾行、或不是固定欄位：不補
  const few = T.itemsToLines(rowsOf(3, ['阿宏'], '台詞'));
  ok(few.every(l => !/：/.test(l)), '少於 4 行不算欄位版面：' + few[0]);
  const ragged = []; for (let i = 0; i < 8; i++) ragged.push(it('阿宏', 100 + i * 7, 700 - i * 20, 24), it('台詞' + i, 160 + i * 11, 700 - i * 20, 60));
  ok(T.itemsToLines(ragged).every(l => !/：/.test(l)), '名字欄／台詞欄 x 不固定：不補');
  // 整份文件判斷名字欄：長段台詞的頁面名字行少（<20%），單頁判斷會放棄；台詞欄 x 隨名字長度不同也要認得
  {
    const dense = rowsOf(14, ['阿 宏', '阿 南'], '台 詞 ');
    const sparse = []; let y = 700;
    sparse.push(it('曾 母', 113.6, y, 27.6), it(' ', 141.2, y, 11.5), it('今 天 是 好 日 子', 152.7, y, 200)); y -= 20;
    for (let i = 0; i < 12; i++) { sparse.push(it('接 下 去 的 長 段 台 詞 第 ' + i + ' 行', 113.6, y, 250)); y -= 20; }
    sparse.push(it('肉 圓 阿 伯', 113.6, y, 58.8), it(' ', 172.4, y, 11.5), it('來 喔 燒 的 喔', 183.9, y, 100));
    ok(T.itemsToLines(sparse).every(l => !/：/.test(l)), '單頁：名字行太少，不補（這是舊行為）');
    const keys = T.detectNameColumns([dense, dense, sparse]);
    ok(keys.has(114) && keys.size === 1, '全文判斷出名字欄 x=114：' + [...keys]);
    const withKeys = T.itemsToLines(sparse, { nameKeys: keys });
    ok(/^曾 母：/.test(withKeys[0]) && /^肉 圓 阿 伯：/.test(withKeys[withKeys.length - 1]), '稀疏頁也補上冒號，四字名（台詞欄 x 不同）也算：' + withKeys[withKeys.length - 1]);
    ok(withKeys.slice(1, -1).every(l => !/：/.test(l)), '長段台詞的續行不補');
    const scattered = []; for (let i = 0; i < 20; i++) scattered.push(it('阿宏', 100 + i * 9, 700 - i * 20, 24), it('台詞' + i, 170 + i * 9, 700 - i * 20, 60));
    eq(T.detectNameColumns([scattered]).size, 0, '名字欄位置散亂：不判定');
    const fewRows = T.detectNameColumns([rowsOf(5, ['阿宏'], '台詞')]);
    eq(fewRows.size, 0, '全文只有 5 個候選（<12）：不判定');
  }
  // 目錄（第X場　標題 …… 頁碼）不是說話者欄
  const toc = []; for (let i = 0; i < 8; i++) toc.push(it('第' + '一二三四五六七八'[i] + '場', 100, 700 - i * 20, 40), it('標題' + i + ' ........ ' + (i * 3 + 5), 160, 700 - i * 20, 120));
  ok(T.itemsToLines(toc).every(l => !/：/.test(l)), '目錄的「第X場」不補冒號');
  // 已有冒號的名字不重複補
  const colon = []; for (let i = 0; i < 6; i++) colon.push(it('阿宏：', 100, 700 - i * 20, 36), it('台詞' + i, 150, 700 - i * 20, 60));
  ok(T.itemsToLines(colon).every(l => /^阿宏：[^：]/.test(l)), '名字已帶冒號就不補');
  // 字距空白：整份文件多數是「字 字」才去空白
  const spaced = []; for (let i = 0; i < 40; i++) spaced.push('阿 宏 ： ( 嚇 醒 ) 學 長 你 怎 麼 在 這 。 約 5 0 歲 L e t ’ s ！');
  const sp = T.buildLines({ pages: [spaced.slice(0, 20), spaced.slice(20)] }).lines;
  eq(sp[0].text, '阿宏：(嚇醒)學長你怎麼在這。約50歲L e t ’ s！', '去掉字距空白（英文字母之間保留）');
  const normal = []; for (let i = 0; i < 60; i++) normal.push('阿宏：你好呀，今日點呀？ Hello world ' + i);
  eq(T.buildLines({ pages: [normal.slice(0, 30), normal.slice(30)] }).lines[0].text, '阿宏：你好呀，今日點呀？ Hello world 0', '一般文件（沒有字距）完全不動');
}

console.log(`✓ parser.test.js：${n} 項通過`);
