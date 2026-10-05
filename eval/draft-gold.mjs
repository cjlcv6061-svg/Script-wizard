#!/usr/bin/env node
// 為真實劇本產生「標準答案草稿」，你只需要逐行修正，不必從零標：
//   node eval/draft-gold.mjs 劇本.docx > eval/real/劇本.gold.json
// 角色清單用「行首冒號前的稱呼出現 ≥3 次」推測；標籤用本機啟發式規則。請人工逐行校對後再當作標準答案。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loadTSP } = require('../tests/tsp-load.js');
const { extractFile } = require('./lib/extract-node.js');
const TSP = loadTSP();
const file = process.argv[2];
if (!file) { console.error('用法：node eval/draft-gold.mjs <劇本檔> > <id>.gold.json'); process.exit(2); }
const { lines } = TSP.buildLines(await extractFile(file, TSP));
const cnt = new Map();
for (const l of lines) { const m = l.text.match(/^([^：:（(\s]{1,12})\s*(?:[（(][^）)]*[）)])?\s*[：:]/); if (m) for (const t of m[1].split(/[、,，/／&＆和與及]/).filter(Boolean)) cnt.set(t, (cnt.get(t) || 0) + 1); }
const roles = [...cnt].filter(([, c]) => c >= 3).map(([id]) => ({ id, name: id, aliases: [] }));
const labels = TSP.heuristicLabels(lines, roles, false);
const gold = lines.map(l => { const v = labels.get(l.n); return { n: l.n, text: l.text, label: v.label, role: v.role }; });
console.log(JSON.stringify({ desc: '草稿：請逐行校對 label／role（S 台詞、C 續行、D 指示、H 標題、N 雜訊）', roles, gold }, null, 1));
