// 迴歸：同一份《離地》資料，「原始 app（第一個 commit 的 index.html）」與「新 app」逐場逐角色比對
// 渲染結果、場次列、測驗評分、語音分配與音調。需要 git 歷史；取不到原始版本時略過。
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { ROOT, readIndex, makeDom, waitFor, ev, sleep } = require('./helpers');

let legacyHtml;
try {
  const root = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: ROOT }).toString().trim().split('\n')[0];
  legacyHtml = execFileSync('git', ['show', root + ':index.html'], { cwd: ROOT, maxBuffer: 1 << 27 }).toString();
  if (!/My Red Tower/.test(legacyHtml)) throw new Error('first commit is not the legacy app');
} catch (e) {
  console.log('- legacy-compare：略過（取不到原始版本：' + e.message.split('\n')[0] + '）');
  process.exit(0);
}

const V1 = fs.readFileSync(path.join(ROOT, 'eval/fixtures/ld.v1.json'), 'utf8');
const V2 = fs.readFileSync(path.join(ROOT, 'samples/ld.v2.json'), 'utf8');
const VOICES = [
  { name: 'Sinji', lang: 'zh-HK' }, { name: 'Danny', lang: 'zh-HK' },
  { name: 'Hiujin', lang: 'zh-HK' }, { name: 'Tracy', lang: 'zh-HK' }, { name: 'Kyoko', lang: 'ja-JP' }
];
const ROLES = ['朗', '偉', '玲', 'K'];
const errors = [];

async function oldApp() {
  const c = makeDom(legacyHtml, { indexedDB: null, fetchMap: { 'script.json': V1 }, voices: VOICES, errors });
  await waitFor(() => ev(c.w, 'typeof SCENES!=="undefined" && SCENES.length>0'), 'old boot');
  return c.w;
}
async function newApp() {
  const c = makeDom(readIndex(), { voices: VOICES, errors });
  await waitFor(() => c.w.document.body.classList.contains('home-mode') && ev(c.w, 'typeof Store!=="undefined"'), 'new boot');
  const rec = await c.w.importScriptText(V2, 'ld.v2.json');
  await c.w.openScript(rec.id);
  return c.w;
}
// 原 app 的「四人」「男」不在四個主角色內，沒有專屬色（印章退回 var(--seal)）；
// 新 app 的 roles[] 會替它們依索引配色，這是唯一預期的差異，比對前先還原。
const EXTRA = { 'rgb(111, 163, 216)': 'var(--seal)', 'rgb(156, 204, 101)': 'var(--seal)' };
const lines = w => {
  let h = w.document.getElementById('lines').innerHTML;
  if (w.__isNew) for (const k of Object.keys(EXTRA)) h = h.split(k).join(EXTRA[k]);
  return h;
};
const nav = w => w.document.getElementById('sceneNav').innerHTML;
let n = 0;
const same = (a, b, msg) => {
  if (a !== b) {
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    throw new Error(`${msg}\n  舊: …${String(a).slice(Math.max(0, i - 80), i + 120)}\n  新: …${String(b).slice(Math.max(0, i - 80), i + 120)}`);
  }
  n++;
};

(async () => {
  const o = await oldApp(), nw = await newApp();
  nw.__isNew = true;

  const MODES = [
    ['預設', ''],
    ['顯示指示', 'showDir=true'],
    ['測驗模式', 'showDir=false; quizMode=true'],
    ['測驗+只練未掌握', 'quizMode=true; onlyUnmastered=true'],
    ['循環', 'quizMode=false; onlyUnmastered=false; loopOn=true; loopFrom=2; loopTo=7'],
    ['全回復', 'loopOn=false; loopFrom=null; loopTo=null; showDir=false; quizMode=false; onlyUnmastered=false']
  ];
  for (const role of ROLES) {
    // 兩邊各自選角（舊：同步；新：非同步）
    ev(o, `chooseRole(${JSON.stringify(role)})`);
    await nw.chooseRole(role);
    same(nav(o), nav(nw), `場次列 角色=${role}`);
    const total = ev(o, 'SCENES.length');
    same(total, ev(nw, 'SCENES.length'), '場數');
    for (const [label, code] of MODES) {
      if (code) { ev(o, code); ev(nw, code); }
      for (let i = 0; i < total; i++) {
        ev(o, `selectScene(${i})`); ev(nw, `selectScene(${i})`);
        same(lines(o), lines(nw), `渲染 角色=${role} 模式=${label} 場=${i}`);
        same(o.document.getElementById('sceneMeta').innerHTML, nw.document.getElementById('sceneMeta').innerHTML, '場次資訊');
        same(o.document.getElementById('rcpText').innerHTML, nw.document.getElementById('rcpText').innerHTML, '進度文字');
      }
    }
  }

  // 多角（合說）：偉+朗
  for (const w of [o, nw]) ev(w, 'hiddenChars=new Set(["偉","朗"]); buildNav(); selectScene(0)');
  same(nav(o), nav(nw), '多角場次列');
  for (let i = 0; i < 22; i++) { ev(o, `selectScene(${i})`); ev(nw, `selectScene(${i})`); same(lines(o), lines(nw), '多角渲染 場' + i); }

  // 評分／朗讀分段／標記清理
  for (const [a, t] of [['你好嗎', '你好嗎'], ['你好', '你好嗎'], ['係唔係', '係咪'], ['', '嗱~你切吖！'], ['影完嗱你切吖', '影完！嗱~你切吖！']]) {
    same(JSON.stringify(ev(o, `scoreAnswer(${JSON.stringify(a)},${JSON.stringify(t)})`)), JSON.stringify(ev(nw, `scoreAnswer(${JSON.stringify(a)},${JSON.stringify(t)})`)), '評分 ' + a);
  }
  const jp = 'better~⟦はい!チーズ⟧ ok';
  same(JSON.stringify(ev(o, `segmentByLang(${JSON.stringify(jp)})`)), JSON.stringify(ev(nw, `segmentByLang(${JSON.stringify(jp)})`)), '日文分段');
  same(ev(o, `sameSound('黎','嚟')`), ev(nw, `sameSound('黎','嚟')`), '同音判斷');

  // 語音分配、音調、朗讀名
  const voiceMap = w => JSON.stringify(ROLES.map(r => [r, ev(w, `roleVoice[${JSON.stringify(r)}]&&roleVoice[${JSON.stringify(r)}].name`)]));
  same(voiceMap(o), voiceMap(nw), '語音分配');
  same(JSON.stringify(ROLES.map(r => ev(o, `profileFor(${JSON.stringify(r)})`))), JSON.stringify(ROLES.map(r => ev(nw, `profileFor(${JSON.stringify(r)})`))), '音調');
  same(JSON.stringify(ROLES.map(r => ev(o, `SPOKEN_NAMES[${JSON.stringify(r)}]`))), JSON.stringify(ROLES.map(r => ev(nw, `SPOKEN_NAMES[${JSON.stringify(r)}]`))), '朗讀簡稱');
  same(JSON.stringify(ROLES.map(r => ev(o, `CHAR_COLOR[${JSON.stringify(r)}]`))), JSON.stringify(ROLES.map(r => ev(nw, `CHAR_COLOR[${JSON.stringify(r)}]`))), '角色顏色');

  assert.strictEqual(errors.length, 0, '頁面不得有未處理錯誤：\n' + errors.join('\n'));
  console.log(`✓ legacy-compare.test.js：${n} 項與原 app 完全一致`);
})().catch(e => { console.error('✗', e.message.slice(0, 2500)); process.exit(1); });
