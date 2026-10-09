// 儲存層／載入層測試：匯入 v1+v2、開啟、選角、成績依劇本＋角色分開、重新載入後仍在、匯出入、刪除
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { IDBFactory } = require('fake-indexeddb');
const { ROOT, readIndex, makeDom, waitFor, ev, sleep } = require('./helpers');

const V1 = fs.readFileSync(path.join(ROOT, 'eval/fixtures/ld.v1.json'), 'utf8');
const V2 = fs.readFileSync(path.join(ROOT, 'samples/ld.v2.json'), 'utf8');
const html = readIndex();

const allErrors = [];
async function boot(indexedDB) {
  const ctx = makeDom(html, { indexedDB, errors: allErrors });
  await waitFor(() => ctx.w.document.body.classList.contains('home-mode') && ev(ctx.w, 'typeof Store!=="undefined"'), 'home');
  await sleep(20);
  return ctx;
}
const text = (w, id) => w.document.getElementById(id).textContent;
let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };

(async () => {
  const idb = new IDBFactory();

  // ---- 0. 粵拼字典：口語句末助詞「㗎」（gaa3）要在字典裡，同音判斷才認得它和「架」是同音 ----
  {
    const { w: w0 } = await boot(new IDBFactory());
    ok(ev(w0, 'sameSound("㗎","架")') === true && ev(w0, 'sameSound("㗎","嘅")') === false, '「㗎」與「架」同音、與「嘅」不同音');
    ok(ev(w0, 'sameSound("黎","嚟")') === true, '原本的同音判斷不變');
  }

  // ---- 1. 空首頁 ----
  let { w } = await boot(idb);
  ok(w.document.querySelector('.home-empty'), '空首頁顯示提示');
  ok(ev(w, 'Store.persistent') === true, '使用 IndexedDB');

  // ---- 2. 匯入 v1 純陣列 ----
  const r1 = await w.importScriptText(V1, 'ld.v1.json');
  ok(r1.title === 'ld.v1', 'v1 以檔名當標題');
  ok(r1.data.schema === 2 && r1.data.scenes.length === 22, 'v1 轉成 v2，22 場');
  ok(JSON.stringify(r1.data.roles.map(r => r.id)) === JSON.stringify(['玲', '朗', '偉', 'K', '四人', '男']) ||
     r1.data.roles.length === 6, 'v1 從 s 欄位推出 6 個角色：' + r1.data.roles.map(r => r.id));

  // ---- 3. 匯入 v2 ----
  const r2 = await w.importScriptText(V2, 'ld.v2.json');
  ok(r2.title === '離地，到着', 'v2 標題取 meta.title');
  ok(r2.data.roles.find(r => r.id === 'K').spoken === 'Kumi', 'roles.spoken 保留');
  await w.renderHome();
  ok(w.document.querySelectorAll('.script-card').length === 2, '首頁兩份劇本');

  // ---- 4. 開啟 v2、選角 ----
  await w.openScript(r2.id);
  ok(!w.document.body.classList.contains('home-mode'), '離開首頁模式');
  ok(w.document.getElementById('roleOverlay').style.display === 'flex', '進入選角畫面');
  ok(w.document.querySelectorAll('#roleGrid .role-pick').length === 6, '選角卡依 roles[] 動態產生');
  ok(text(w, 'landTitle') === '離地，到着' && text(w, 'scriptTitle') === '離地，到着', '劇名取自 meta.title');
  ok(ev(w, 'document.querySelectorAll("#pickerOptsBox input").length') === 6, '多角選單動態產生');
  await w.chooseRole('偉');
  ok(ev(w, 'myRole') === '偉' && ev(w, '[...hiddenChars].join()') === '偉', '選角後 hiddenChars={偉}');
  ok(w.document.getElementById('roleOverlay').style.display === 'none', '選角後關閉選角畫面');
  ok(text(w, 'roleName') === '葉志偉', '角色晶片顯示全名');

  // ---- 5. 成績依劇本＋角色分開 ----
  ev(w, 'recordAttempt("第一場", 4, "偉", 100)');
  ev(w, 'setRecall("第一場", 4, "yes")');
  await sleep(30);
  await w.chooseRole('朗');
  ok(ev(w, 'Object.keys(STATS.best).length') === 0, '換角色後成績為空（依角色分開）');
  ev(w, 'recordAttempt("第一場", 5, "朗", 80)');
  await sleep(30);
  // 另一份劇本同角色名也互不影響
  await w.openScript(r1.id);
  await w.chooseRole('偉');
  ok(ev(w, 'Object.keys(STATS.best).length') === 0, '另一份劇本的同名角色成績獨立');

  // ---- 6. 重新載入後成績仍在 ----
  ({ w } = await boot(idb));
  await w.openScript(r2.id);
  ok(ev(w, 'myRole') === '朗', '記住上次選的角色（lastRole）');
  ok(ev(w, 'STATS.best["第一場|5"]') === 80, '重新載入後 朗 的成績還在');
  await w.chooseRole('偉');
  ok(ev(w, 'STATS.best["第一場|4"]') === 100 && ev(w, 'STATS.recall["第一場|4"]') === 'yes', '重新載入後 偉 的成績與記得標記還在');

  // ---- 7. 匯出（含成績）→ 匯入還原 ----
  const exported = await w.exportScript(r2.id, true);
  ok(exported.schema === 2 && exported.progress.length === 2, '匯出含兩個角色的成績');
  const r3 = await w.importScriptText(JSON.stringify(exported), 'x.json');
  await w.openScript(r3.id);
  await w.chooseRole('偉');
  ok(ev(w, 'STATS.best["第一場|4"]') === 100, '匯入後成績還原');
  const noProg = await w.exportScript(r2.id, false);
  ok(!('progress' in noProg), '不含成績的匯出沒有 progress');

  // ---- 8. 重新命名／刪除 ----
  w.prompt = () => '新名字';
  await w.renameScript(r3.id);
  const rec = await ev(w, `Store.get('scripts','${r3.id}')`);
  ok(rec.title === '新名字' && rec.data.meta.title === '新名字', '重新命名同步 meta.title');
  await w.deleteScript(r3.id);
  ok(!(await ev(w, `Store.get('scripts','${r3.id}')`)), '刪除劇本');
  const left = (await ev(w, `Store.all('progress')`)).filter(p => p.scriptId === r3.id);
  ok(left.length === 0, '刪除劇本同時刪除成績');

  // ---- 9. 壞資料 ----
  for (const bad of ['not json', '{}', '[]', '[{"no":"x","lines":[]}]', '"str"']) {
    let threw = false;
    try { await w.importScriptText(bad, 'bad.json'); } catch (e) { threw = true; }
    ok(threw, '拒絕壞資料：' + bad);
  }

  // ---- 10. 無 IndexedDB 時退回記憶體 ----
  const m = await boot(null);
  ok(ev(m.w, 'Store.persistent') === false, '無 IndexedDB 時退回記憶體');
  ok(m.w.document.getElementById('homeMemWarn').style.display === 'block', '顯示無法持久儲存的警告');
  const rm = await m.w.importScriptText(V2, 'a.json');
  await m.w.openScript(rm.id); await m.w.chooseRole('玲');
  ev(m.w, 'recordAttempt("序場", 1, "玲", 90)'); await sleep(10);
  ok(ev(m.w, 'STATS.best["序場|1"]') === 90, '記憶體模式也能運作');

  // ---- 11. 劇本內容含 HTML：一律當文字，不得執行 ----
  {
    const evil = '<img src=x onerror=window.__pwned=1>';
    const bad = { schema: 2, meta: { title: evil }, roles: [{ id: 'A', name: evil, aliases: [], gender: 'n' }, { id: evil, name: '<b id=pwn2>x</b>' }],
      scenes: [{ no: evil, name: evil, season: evil, place: evil, lines: [{ s: 'A', t: evil }, { d: evil }, { s: 'A', t: '再試' }] }] };
    const rec = await w.importScriptText(JSON.stringify(bad), 'evil.json');
    await w.renderHome();
    await w.openScript(rec.id); await w.chooseRole('A');
    ev(w, 'recordAttempt(SCENES[0].no, 0, "A", 50)');
    ev(w, 'openStats()');
    ev(w, 'setNowPlaying("A")');
    ev(w, 'document.getElementById("pickerBtn").click()');
    await sleep(30);
    ok(!w.__pwned && !w.document.querySelector('img[src="x"]') && !w.document.getElementById('pwn2'), '含 HTML 的劇名／場次／角色名／台詞一律當文字顯示');
    await w.openReview(rec.id);
    ok(!w.__pwned && !w.document.querySelector('img[src="x"]'), '校正頁同樣不執行 HTML');
  }

  assert.strictEqual(allErrors.length, 0, '頁面不得有未處理錯誤：\n' + allErrors.join('\n'));
  console.log(`✓ storage.test.js：${pass} 項通過`);
})().catch(e => { console.error('✗', e); process.exit(1); });
