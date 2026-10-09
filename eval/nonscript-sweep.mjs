#!/usr/bin/env node
// 「遠離劇本」門檻（trimNonScript 的 NONSCRIPT_FAR，預設 60）的敏感度掃描。
//
//   node eval/nonscript-sweep.mjs            # 只用內建的《離地》合成排版（不需要 npm run fixtures）
//   node eval/nonscript-sweep.mjs --docs     # 另外加入 eval/out/docs 的 docx／PDF 標準答案（需先 npm run fixtures）
//
// 規則：指示／續行／標題行，前後 FAR 行內都沒有任何台詞或歌詞 → 改雜訊（見 index.html 的 trimNonScript）。
// 兩種風險方向相反，所以分開量：
//   (A) 誤傷：劇本裡真的有的指示／續行被清掉（內容消失，雖然校正頁的雜訊列找得回來）。
//       用標準答案的標籤餵給 trimNonScript，被改成 N 的行就是誤傷。
//   (B) 殘留：論述／前言緊鄰劇本的部分清不掉。論述在劇本前後各殘留 FAR-1 行。
// 另外量「最小會被清掉的」長獨白（一個 S 後面接 M 行折行續行）與長舞台指示塊，這兩個是誤傷的實際門檻。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { loadTSP } = require('../tests/tsp-load.js');
const { variants } = require('./synth.js');
const T = loadTSP();

const FARS = [10, 20, 30, 40, 60, 90, 120];
const withDocs = process.argv.includes('--docs');

// ---------- 資料：標準答案的標籤序列 ----------
const sets = [];
for (const v of variants()) sets.push({ id: v.id, gold: v.gold });
if (withDocs) {
  const dir = path.join(HERE, 'out', 'docs');
  if (!fs.existsSync(dir)) { console.error('找不到 eval/out/docs，請先執行 npm run fixtures'); process.exit(2); }
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.gold.json')).sort()) sets.push({ id: f.replace('.gold.json', ''), gold: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).gold });
}

const mk = (texts) => texts.map((t, i) => ({ n: i + 1, text: t }));
// gold: [{text,label,role}] → lines + labels（N 行當作雜訊；只看 S/C/D/H/Y 會不會被誤清）
function fromGold(gold) {
  const lines = mk(gold.map(g => g.text));
  const labels = new Map(gold.map((g, i) => [i + 1, { label: g.label, role: g.role || '' }]));
  return { lines, labels };
}

// ---------- (A) 誤傷：真實劇本（標準答案）被清掉多少 ----------
function lost(gold, far) {
  const { lines, labels } = fromGold(gold);
  const before = new Map([...labels].map(([n, v]) => [n, v.label]));
  T.trimNonScript(lines, labels, far);
  let cut = 0;
  for (const [n, v] of labels) if (before.get(n) !== 'N' && v.label === 'N') cut++;
  return cut;
}
// 標準答案裡，D/C/H 行到最近台詞（S）的距離分布
function distStats(gold) {
  const N = gold.length, d = new Array(N).fill(Infinity);
  let last = -Infinity;
  for (let i = 0; i < N; i++) { if (gold[i].label === 'S') last = i; d[i] = i - last; }
  last = Infinity;
  for (let i = N - 1; i >= 0; i--) { if (gold[i].label === 'S') last = i; d[i] = Math.min(d[i], last - i); }
  const xs = gold.map((g, i) => (g.label === 'D' || g.label === 'C' || g.label === 'H') ? d[i] : null).filter(x => x !== null && x !== Infinity).sort((a, b) => a - b);
  return { n: xs.length, p50: xs[Math.floor(xs.length * 0.5)], p99: xs[Math.floor(xs.length * 0.99)], max: xs[xs.length - 1] };
}

// ---------- 合成情境：量實際門檻 ----------
const dlg = k => { const rows = []; for (let i = 0; i < k; i++) rows.push(['甲：第' + i + '句。', 'S'], ['乙：好。', 'S']); return rows; };
function run(rows, far) {
  const lines = mk(rows.map(r => r[0])), labels = new Map(rows.map((r, i) => [i + 1, { label: r[1], role: r[1] === 'S' ? r[0].split('：')[0] : '' }]));
  T.trimNonScript(lines, labels, far);
  return rows.map((r, i) => [r, labels.get(i + 1).label]);
}
// 一個 S 後面接 M 行折行續行（長獨白）：最小的 M 使得有續行被清掉
function minMonologue(far) {
  for (let m = 1; m <= 600; m++) {
    const rows = dlg(30).concat([['甲：獨白開頭', 'S']], Array.from({ length: m }, (_, i) => ['獨白續行' + i, 'C']), dlg(30));
    if (run(rows, far).some(([r, l]) => r[1] === 'C' && l === 'N')) return m;
  }
  return null;
}
// 兩段對話之間 G 行舞台指示：最小的 G 使得有指示被清掉
function minDirectionBlock(far) {
  for (let g = 1; g <= 600; g++) {
    const rows = dlg(30).concat(Array.from({ length: g }, (_, i) => ['（指示' + i + '）', 'D']), dlg(30));
    if (run(rows, far).some(([r, l]) => r[1] === 'D' && l === 'N')) return g;
  }
  return null;
}
// 劇本前面 P 行前言（全標成指示）：殘留幾行
function leakFront(far, P = 300) {
  const rows = Array.from({ length: P }, (_, i) => ['這是前言第' + i + '行。', 'D']).concat(dlg(30));
  return run(rows, far).filter(([r, l]) => r[1] === 'D' && l === 'D').length;
}

// ---------- 輸出 ----------
const pad = (s, n) => String(s).padEnd(n);
console.log('標準答案裡的 D/C/H 行到最近台詞的距離（行）：');
for (const s of sets) { const d = distStats(s.gold); console.log('  ' + pad(s.id, 20), 'n=' + pad(d.n, 5), 'p50=' + pad(d.p50, 3), 'p99=' + pad(d.p99, 3), 'max=' + d.max); }
console.log('\n門檻掃描：');
console.log(pad('FAR', 5), pad('誤傷（標準答案被清掉的行，全部排版合計）', 42), pad('最小會被清的獨白', 18), pad('最小會被清的指示塊', 20), '前言殘留（300 行前言）');
for (const far of FARS) {
  const lostAll = sets.reduce((a, s) => a + lost(s.gold, far), 0);
  console.log(pad(far, 5), pad(lostAll, 42), pad(minMonologue(far) + ' 行', 18), pad(minDirectionBlock(far) + ' 行', 20), leakFront(far) + ' 行');
}
console.log('\n目前預設 FAR=60。誤傷欄為 0 代表這些排版裡沒有任何真實的指示／續行被誤清；');
console.log('「最小會被清的獨白／指示塊」＝ 2×FAR（兩側各 FAR 行內都沒有台詞才清，所以要 2 倍長度）；前言殘留＝ FAR-1。');
