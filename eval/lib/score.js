// 評測計分：行級準確率（標籤＋角色皆對才算對）、混淆矩陣、錯誤行清單、端到端還原度。
const { alignLines, norm } = require('./align');
const { ROLES } = require('../synth');

// 預測角色 → 標準答案角色 id（模型自選的 id 可能是全名或別名；合說以 / 連接）
const GOLD_SURF = new Map();
for (const r of ROLES) { GOLD_SURF.set(r.id, r.id); GOLD_SURF.set(r.name, r.id); r.alias.forEach(a => { if (!GOLD_SURF.has(a)) GOLD_SURF.set(a, r.id); }); }
const mapRole = s => String(s || '').split('/').map(x => GOLD_SURF.get(x.trim()) || x.trim()).filter(Boolean).join('/');
const roleKey = s => mapRole(s).split('/').sort().join('/');

// lines: 前處理後的行 [{n,text}]；labels: Map n→{label,role}；gold: [{text,label,role}]
function scoreLabels(lines, labels, gold) {
  const al = alignLines(lines.map(l => l.text), gold.map(g => g.text));
  const conf = {};
  const bump = (g, p) => { conf[g] = conf[g] || {}; conf[g][p] = (conf[g][p] || 0) + 1; };
  let correct = 0, aligned = 0, alignedCorrect = 0, preRemoved = 0, missing = 0, roleWrong = 0;
  const errs = [];
  gold.forEach((g, gi) => {
    const pi = al.gold2pred[gi];
    if (pi < 0) {
      if (g.label === 'N') { preRemoved++; correct++; bump('N', 'N'); }
      else { missing++; bump(g.label, '（遺失）'); errs.push({ i: gi, text: g.text.slice(0, 60), gold: g.label + (g.role ? ':' + g.role : ''), pred: '（前處理遺失）' }); }
      return;
    }
    aligned++;
    const p = labels.get(lines[pi].n) || { label: '?', role: '' };
    bump(g.label, p.label);
    const ok = p.label === g.label && (g.label !== 'S' || roleKey(p.role) === roleKey(g.role));
    if (ok) { correct++; alignedCorrect++; }
    else {
      if (p.label === g.label && g.label === 'S') roleWrong++;
      errs.push({ i: gi, text: g.text.slice(0, 60), gold: g.label + (g.role ? ':' + g.role : ''), pred: p.label + (p.role ? ':' + mapRole(p.role) : '') });
    }
  });
  const perLabel = {};
  for (const L of ['S', 'C', 'D', 'H', 'N']) {
    const row = conf[L] || {}; const tot = Object.values(row).reduce((a, b) => a + b, 0);
    perLabel[L] = { total: tot, recall: tot ? (row[L] || 0) / tot : null };
  }
  return { acc: correct / gold.length, accAligned: aligned ? alignedCorrect / aligned : 0, total: gold.length, correct, aligned, preRemoved, missing, roleWrong, perLabel, confusion: conf, errors: errs };
}

// 端到端：組回的劇本 vs 原劇本（逐行 [S|角色|台詞] 或 [D|指示]；台詞忽略日文標記與空白）
const noMarks = s => String(s || '').replace(/[⟦⟧]/g, '');
function flattenOriginal(scenes) {
  const out = [];
  for (const sc of scenes) for (const l of sc.lines) out.push(l.d !== undefined ? 'D|' + noMarks(l.d) : 'S|' + roleKey(l.s) + '|' + noMarks(l.t));
  return out;
}
function flattenAssembled(scenes) {
  const out = [];
  for (const sc of scenes) for (const l of sc.lines) {
    if (l.x !== undefined) continue;
    out.push(l.d !== undefined ? 'D|' + noMarks(l.d) : 'S|' + roleKey(l.s) + '|' + noMarks(l.t));
  }
  return out;
}
function scoreScript(assembledScenes, originalScenes) {
  const a = flattenAssembled(assembledScenes), o = flattenOriginal(originalScenes);
  const al = alignLines(a, o);
  // 只比台詞文字（不看角色），看出是組回或角色對應哪裡出問題
  const strip = x => x.replace(/^S\|[^|]*\|/, 'S|');
  const al2 = alignLines(a.map(strip), o.map(strip));
  return {
    originalLines: o.length, assembledLines: a.length,
    fidelity: al.matched / o.length,            // 角色＋文字完全吻合的比例
    textFidelity: al2.matched / o.length,       // 只看文字
    scenes: { assembled: assembledScenes.length, original: originalScenes.length }
  };
}
module.exports = { scoreLabels, scoreScript, mapRole, roleKey };
