// 由《離地，到着》v1 劇本反向生成多種排版的合成劇本，附逐行標準答案（金標準）。
// 每個變體：{ id, desc, text, gold:[{n, text, label, role}], roles }
//   label ∈ S 台詞 / C 續行 / D 舞台指示 / H 場次標題 / N 雜訊（含獨立的角色名行）
//   n 與 TSP.buildLines 的編號一致（空行不編號）。
// 用法：node eval/synth.js [輸出目錄]   → 每個變體寫出 <id>.txt 與 <id>.gold.json
const fs = require('fs');
const path = require('path');

const FIXTURE = path.join(__dirname, 'fixtures', 'ld.v1.json');
const ROLES = [
  { id: '朗', name: '陳立朗', alias: ['立朗', '朗'] },
  { id: '偉', name: '葉志偉', alias: ['志偉', '偉'] },
  { id: '玲', name: '阮玲', alias: ['阮玲', '玲'] },
  { id: 'K', name: '何樂瑩', alias: ['Kumi', 'K'] },
  { id: '四人', name: '四人', alias: ['四人'] },
  { id: '男', name: '男', alias: ['男'] }
];
const byId = Object.fromEntries(ROLES.map(r => [r.id, r]));
const stripMarks = s => (s || '').replace(/[⟦⟧]/g, '');

function loadScenes() { return JSON.parse(fs.readFileSync(FIXTURE, 'utf8')); }

// 說話者 id（可含 /）→ 版面上的寫法
function surface(s, mode) {
  const parts = s.split('/');
  const f = id => {
    const r = byId[id];
    if (!r) return id;
    if (mode === 'full') return r.name;
    if (mode === 'short') return r.alias[0] === id ? id : r.alias[0];
    return id;
  };
  return parts.map(f).join(mode === 'full' ? '、' : '／');
}

function sceneHeading(sc, style) {
  const meta = [sc.season, sc.place].filter(Boolean).join('　');
  if (style === 'banner') return '=== ' + sc.no + '　' + (sc.name || '') + ' ===' + (meta ? '　' + meta : '');
  return sc.no + (sc.name ? '　' + sc.name : '') + (meta ? '　' + meta : '');
}

// 依字數折行（續行）。回傳行陣列。
function wrapText(s, width) {
  if (s.length <= width) return [s];
  const out = [];
  let rest = s;
  while (rest.length > width) { out.push(rest.slice(0, width)); rest = rest.slice(width); }
  if (rest) out.push(rest);
  return out;
}

class Builder {
  constructor() { this.rows = []; }
  // blankAfter：此行後面插空行（不編號）
  add(text, label, role, blankAfter) { this.rows.push({ text, label, role: role || '', blankAfter: !!blankAfter }); }
  build(id, desc) {
    const gold = [];
    const out = [];
    for (const r of this.rows) {
      out.push(r.text);
      gold.push({ n: gold.length + 1, text: r.text.trim(), label: r.label, role: r.role });
      if (r.blankAfter) out.push('');
    }
    return { id, desc, text: out.join('\n') + '\n', gold, roles: ROLES };
  }
}

// ---------- 各變體 ----------
function colon(scenes, o) {
  const b = new Builder();
  for (const sc of scenes) {
    b.add(sceneHeading(sc, o.heading), 'H', '', o.blank);
    for (const ln of sc.lines) {
      if (ln.d !== undefined) { b.add(stripMarks(ln.d), 'D', '', o.blank); continue; }
      const body = stripMarks(o.withDirs && ln.r ? ln.r : ln.t);
      const nameTxt = surface(ln.s, o.names);
      let head = nameTxt + o.colon + o.gap;
      const lines = o.wrap ? wrapText(body, o.wrap) : [body];
      b.add(head + lines[0], 'S', ln.s, o.blank && lines.length === 1);
      for (let i = 1; i < lines.length; i++) b.add(lines[i], 'C', ln.s, o.blank && i === lines.length - 1);
    }
  }
  return b;
}

function centered(scenes, o) {
  const b = new Builder();
  for (const sc of scenes) {
    b.add(sceneHeading(sc, 'plain'), 'H', '', true);
    for (const ln of sc.lines) {
      if (ln.d !== undefined) { b.add(stripMarks(ln.d), 'D', '', false); continue; }
      const nameTxt = surface(ln.s, o.names);
      b.add(' '.repeat(12) + nameTxt, 'N', '', false);          // 獨立的角色名行：不屬於台詞內容
      const body = stripMarks(o.withDirs && ln.r ? ln.r : ln.t);
      const lines = o.wrap ? wrapText(body, o.wrap) : [body];
      b.add(lines[0], 'S', ln.s, lines.length === 1);
      for (let i = 1; i < lines.length; i++) b.add(lines[i], 'C', ln.s, i === lines.length - 1);
    }
  }
  return b;
}

// 帶雜訊：封面、目錄、頁眉頁尾頁碼（可能插在台詞與續行之間）
function noisy(scenes) {
  const b = colon(scenes, { heading: 'plain', names: 'short', colon: '：', gap: '', withDirs: true, wrap: 26, blank: false });
  const body = b.rows;
  const out = new Builder();
  const head = (t) => out.add(t, 'N', '', false);
  head('《離地，到着》');
  head('劇本草稿 v3');
  head('編劇：某某某　　聯絡：example@example.com');
  head('目錄');
  scenes.forEach((sc, i) => head(sc.no + '　' + (sc.name || '') + ' ........ ' + (i * 3 + 2)));
  head('— 本劇本僅供排練使用 —');
  let page = 1, count = 0;
  const PAGE = 38;
  for (const r of body) {
    out.add(r.text, r.label, r.role, false);
    if (++count % PAGE === 0) {
      head('- ' + page + ' -');
      page++;
      head('《離地，到着》劇本草稿 v3');
    }
  }
  head('- ' + page + ' -');
  return out;
}

function variants() {
  const scenes = loadScenes();
  const V = [];
  V.push(colon(scenes, { heading: 'plain', names: 'id', colon: '：', gap: '', withDirs: false }).build('colon-fw', '角色簡稱＋全形冒號，無內嵌指示'));
  V.push(colon(scenes, { heading: 'plain', names: 'full', colon: ':', gap: ' ', withDirs: true }).build('fullname-halfcolon', '角色全名＋半形冒號＋空格，台詞內嵌指示（含指示原文）'));
  V.push(colon(scenes, { heading: 'banner', names: 'short', colon: '：', gap: '', withDirs: true, blank: true }).build('blank-sep', '角色別名，每段後空一行，場次標題用 === 裝飾'));
  V.push(colon(scenes, { heading: 'plain', names: 'id', colon: '：', gap: '', withDirs: true, wrap: 24 }).build('wrapped', '長台詞折行成續行（C）'));
  V.push(centered(scenes, { names: 'full', withDirs: true, wrap: 0 }).build('centered', '角色名置中獨立成行，下一行是台詞'));
  V.push(centered(scenes, { names: 'short', withDirs: false, wrap: 30 }).build('centered-wrapped', '置中角色名＋折行'));
  V.push(noisy(scenes).build('noisy', '封面、目錄、頁眉頁尾頁碼混在台詞與續行之間'));
  return V;
}

module.exports = { variants, ROLES, loadScenes };

if (require.main === module) {
  const dir = process.argv[2] || path.join(__dirname, 'out', 'synth');
  fs.mkdirSync(dir, { recursive: true });
  for (const v of variants()) {
    fs.writeFileSync(path.join(dir, v.id + '.txt'), v.text);
    fs.writeFileSync(path.join(dir, v.id + '.gold.json'), JSON.stringify({ id: v.id, desc: v.desc, roles: v.roles, gold: v.gold }, null, 1));
    const c = {}; v.gold.forEach(g => { c[g.label] = (c[g.label] || 0) + 1; });
    console.log(v.id.padEnd(20), String(v.gold.length).padStart(5), '行', JSON.stringify(c), '—', v.desc);
  }
}
