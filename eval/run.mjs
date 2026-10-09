#!/usr/bin/env node
// 評測：用合成劇本（含 docx／PDF）與標準答案，跑兩段式標記管線，輸出行級準確率與錯誤行清單。
//
//   node eval/run.mjs --mode heuristic            # 不用模型：本機啟發式基準線（不需要 key）
//   node eval/run.mjs --mode mock --err 0.02      # 模擬模型（驗證管線；不代表真實準確率）
//   OPENROUTER_API_KEY=... MODEL=<模型ID> node eval/run.mjs --mode live
//
// 選項：--variants colon-fw,noisy|all  --docs（加入 eval/out/docs 的 docx／PDF）  --concurrency 3
//       --err 每行標錯率  --fail 回應壞掉率（mock）  --out 報告前綴  --no-cache
// live 模式必須與上線相同的「模型＋供應商允許清單」：MODEL、PROVIDERS（預設 together,fireworks）。
// 回應會快取在 eval/out/cache/，同樣的請求不重複計費，也能離線重跑。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildRequest, filterOutput } from '../worker/prompts.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const { loadTSP } = require('../tests/tsp-load.js');
const { variants, ROLES, loadScenes } = require('./synth.js');
const { scoreLabels, scoreScript } = require('./lib/score.js');
const { makeMock } = require('./lib/mock.js');
const { extractFile } = require('./lib/extract-node.js');
const TSP = loadTSP();

// ---------- 參數 ----------
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i < 0 ? def : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const mode = opt('mode', 'heuristic');
const want = String(opt('variants', 'all'));
const withDocs = !!opt('docs', false);
const concurrency = +opt('concurrency', 3);
const errRate = +opt('err', 0), failRate = +opt('fail', 0);
const outPrefix = String(opt('out', path.join(HERE, 'out', 'report')));
const useCache = !opt('no-cache', false);

// ---------- live：直接呼叫 OpenRouter（與 Worker 共用提示詞與請求組裝）----------
function liveApi() {
  const env = { MODEL: process.env.MODEL || opt('model', ''), PROVIDERS: process.env.PROVIDERS || 'together,fireworks' };
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { console.error('live 模式需要環境變數 OPENROUTER_API_KEY（在本機 shell export，不要寫進檔案）'); process.exit(2); }
  if (!env.MODEL) { console.error('live 模式需要 MODEL（OpenRouter 模型 ID；上線前請到模型頁確認現行 ID，並確認 PROVIDERS 內供應商不訓練、不保留提示詞）'); process.exit(2); }
  const cacheDir = path.join(HERE, 'out', 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
  const usage = { calls: 0, cached: 0, promptTokens: 0, completionTokens: 0 };
  async function callApi(payload) {
    const body = buildRequest(env, payload);
    const h = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const cf = path.join(cacheDir, h + '.json');
    if (useCache && fs.existsSync(cf)) { usage.cached++; return JSON.parse(fs.readFileSync(cf, 'utf8')).content; }
    let lastErr;
    for (let a = 0; a < 4; a++) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (res.status === 429 || res.status >= 500) { lastErr = new Error('HTTP ' + res.status); await new Promise(r => setTimeout(r, 1500 * (a + 1))); continue; }
        const j = await res.json();
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + JSON.stringify(j).slice(0, 300));
        const raw = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        usage.calls++; usage.promptTokens += (j.usage && j.usage.prompt_tokens) || 0; usage.completionTokens += (j.usage && j.usage.completion_tokens) || 0;
        const content = filterOutput(payload.mode, raw);
        fs.writeFileSync(cf, JSON.stringify({ content, model: j.model, provider: j.provider }));
        return content;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }
  return { callApi, usage, env };
}

// ---------- 來源 ----------
const groundTruth = loadScenes();
const sources = [];
for (const v of variants()) if (want === 'all' || want.split(',').includes(v.id)) sources.push({ id: v.id, kind: 'txt', desc: v.desc, gold: v.gold, input: () => ({ text: v.text }) });
if (withDocs) {
  const dir = path.join(HERE, 'out', 'docs');
  if (!fs.existsSync(dir)) { console.error('找不到 eval/out/docs，請先執行 npm run fixtures'); process.exit(2); }
  for (const f of fs.readdirSync(dir).filter(f => /\.(docx|pdf)$/.test(f)).sort()) {
    const id = f.replace(/\.[^.]+$/, '');
    if (want !== 'all' && !want.split(',').includes(id)) continue;
    const g = JSON.parse(fs.readFileSync(path.join(dir, id + '.gold.json'), 'utf8'));
    sources.push({ id, kind: f.endsWith('.pdf') ? 'pdf' : 'docx', desc: g.desc, gold: g.gold, partial: !!g.partial, input: () => extractFile(path.join(dir, f), TSP) });
  }
}
// 真實劇本：--real <目錄>，每份 <id>.docx|.pdf|.txt 旁放 <id>.gold.json（{roles?, gold:[{text,label,role}]}，格式同合成劇本）
const realDir = opt('real', false);
if (realDir && realDir !== true) {
  for (const f of fs.readdirSync(realDir).filter(f => /\.(docx|pdf|txt)$/i.test(f)).sort()) {
    const id = f.replace(/\.[^.]+$/, '');
    const gf = path.join(realDir, id + '.gold.json');
    if (!fs.existsSync(gf)) { console.error(`略過 ${f}：缺少 ${id}.gold.json`); continue; }
    const g = JSON.parse(fs.readFileSync(gf, 'utf8'));
    sources.push({ id: 'real-' + id, kind: /\.pdf$/i.test(f) ? 'pdf' : /\.docx$/i.test(f) ? 'docx' : 'txt', desc: g.desc || '真實劇本', gold: g.gold, real: true, input: () => extractFile(path.join(realDir, f), TSP) });
  }
}
if (!sources.length) { console.error('沒有符合的測試資料'); process.exit(2); }

function realRoles(src) { return [...new Set(src.gold.filter(g => g.label === 'S').flatMap(g => g.role.split('/')))].map(id => ({ id, name: id, aliases: [] })); }

// ---------- 執行 ----------
const live = mode === 'live' ? liveApi() : null;
const results = [];
const t0 = Date.now();
for (const src of sources) {
  const built = TSP.buildLines(await src.input());
  const lines = built.lines;
  let labels, scenes, stats = {};
  if (mode === 'heuristic') {
    const roles = src.real ? realRoles(src) : ROLES.map(r => ({ id: r.id, name: r.name, aliases: r.alias.filter(a => a !== r.id) }));
    labels = TSP.heuristicLabels(lines, roles, false);
    scenes = TSP.assemble(lines, labels, roles).scenes;
  } else {
    const api = mode === 'mock' ? makeMock(lines, src.gold, { errRate, failRate, seed: 7 }) : live;
    const r = await TSP.runPipeline({ lines, callApi: api.callApi, concurrency });
    labels = r.labels; scenes = r.scenes; stats = r.stats;
  }
  const lab = scoreLabels(lines, labels, src.gold);
  const e2e = (src.real || src.partial) ? { fidelity: NaN, textFidelity: NaN, scenes: { assembled: scenes.length, original: 0 } } : scoreScript(scenes, groundTruth);   // 真實劇本、只用了原劇本一部分的版面（partial）沒有可對照的完整原劇本
  results.push({ id: src.id, kind: src.kind, desc: src.desc, lines: lines.length, preRemoved: built.removed.length, label: lab, e2e, stats });
  const pct = x => (x * 100).toFixed(2).padStart(6) + '%';
  console.log(`${src.id.padEnd(20)} ${String(lines.length).padStart(5)} 行  行級 ${pct(lab.acc)}  對齊行 ${pct(lab.accAligned)}  ` +
    ['S', 'C', 'D', 'H', 'N'].map(L => `${L}:${lab.perLabel[L].recall == null ? ' - ' : (lab.perLabel[L].recall * 100).toFixed(1)}`).join(' ') +
    `  端到端 ${isNaN(e2e.fidelity) ? '   n/a ' : pct(e2e.fidelity)}${stats.failedChunks ? `  失敗塊 ${stats.failedChunks}/${stats.chunks}` : ''}`);
}

// ---------- 彙總（docx 與 PDF 分開統計）----------
const group = k => results.filter(r => r.kind === k);
function summarize(rs) { const t = rs.reduce((a, r) => a + r.label.total, 0), c = rs.reduce((a, r) => a + r.label.correct, 0); return { files: rs.length, lines: t, acc: t ? c / t : null }; }
const summary = { txt: summarize(group('txt')), docx: summarize(group('docx')), pdf: summarize(group('pdf')) };
console.log('\n彙總（行級準確率＝標籤與角色皆對）：');
for (const [k, s] of Object.entries(summary)) if (s.files) console.log(`  ${k.padEnd(5)} ${s.files} 份  ${s.lines} 行  ${(s.acc * 100).toFixed(2)}%`);
const target = 0.95;
const below = results.filter(r => r.label.acc < target);
console.log(below.length ? `\n低於 ${target * 100}% 的版面：${below.map(r => r.id).join('、')}（低於 95% 才考慮升級模型）` : `\n全部版面 ≥ ${target * 100}%`);
if (live) console.log(`\n用量：呼叫 ${live.usage.calls} 次（快取 ${live.usage.cached}），輸入 ${live.usage.promptTokens} / 輸出 ${live.usage.completionTokens} tokens；模型 ${live.env.MODEL}，供應商 ${live.env.PROVIDERS}`);
if (mode === 'mock') console.log('\n※ mock 模式：結果只驗證管線與重試／後備邏輯，不代表真實模型的準確率。');

// ---------- 報告 ----------
fs.mkdirSync(path.dirname(outPrefix), { recursive: true });
const report = { mode, model: live ? live.env : null, errRate, failRate, ms: Date.now() - t0, summary, results: results.map(r => ({ ...r, label: { ...r.label, errors: r.label.errors.slice(0, 200) } })) };
fs.writeFileSync(outPrefix + '.json', JSON.stringify(report, null, 1));
const md = ['# 評測報告', '', `模式：${mode}${live ? `（${live.env.MODEL}；${live.env.PROVIDERS}）` : ''}`, '',
  '| 版面 | 類別 | 行數 | 行級準確率 | S | C | D | H | N | 端到端 |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...results.map(r => `| ${r.id} | ${r.kind} | ${r.lines} | ${(r.label.acc * 100).toFixed(2)}% | ` + ['S', 'C', 'D', 'H', 'N'].map(L => r.label.perLabel[L].recall == null ? '-' : (r.label.perLabel[L].recall * 100).toFixed(1)).join(' | ') + ` | ${isNaN(r.e2e.fidelity) ? 'n/a' : (r.e2e.fidelity * 100).toFixed(2) + '%'} |`),
  '', '## 錯誤行（每個版面前 15 筆）', '',
  ...results.flatMap(r => [`### ${r.id}`, '', ...r.label.errors.slice(0, 15).map(e => `- #${e.i} 答案 \`${e.gold}\` → 預測 \`${e.pred}\`：${e.text}`), ''])];
fs.writeFileSync(outPrefix + '.md', md.join('\n'));
console.log(`\n報告：${path.relative(process.cwd(), outPrefix)}.json / .md`);
