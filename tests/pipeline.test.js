// 兩段式標記管線：回應解析與一致性檢查、本機規則（內嵌指示、日文標記、前綴、標題）、組回、
// 以及用 mock 模型驗證重試、後備與中止行為。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadTSP } = require('./tsp-load');
const { variants, ROLES, loadScenes } = require('../eval/synth');
const { makeMock } = require('../eval/lib/mock');
const { scoreLabels, scoreScript } = require('../eval/lib/score');
const T = loadTSP();
let n = 0;
const ok = (c, m) => { assert(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

const roles = ROLES.map(r => ({ id: r.id, name: r.name, aliases: r.alias.filter(a => a !== r.id) }));

// ---- parseLabels / validateLabels ----
{
  const p = T.parseLabels('```\n1|S|偉\nL2 | c |\n3｜D｜\n聽起來不錯\n2|S|朗\n```');
  eq([...p.map.keys()], [1, 2, 3], '解析行號');
  eq(p.map.get(2), { label: 'C', role: '' }, '標籤大小寫與空角色');
  eq(p.dup, [2], '偵測重複');
  eq(p.bad.length, 1, '無法解析的行被記錄');
  eq(T.validateLabels(T.parseLabels('1|S|偉\n2|C|\n3|D|'), [1, 2, 3], roles), [], '正常通過');
  ok(T.validateLabels(T.parseLabels('1|S|偉\n3|D|'), [1, 2, 3], roles).some(e => /缺漏 L2/.test(e)), '缺漏');
  ok(T.validateLabels(T.parseLabels('1|S|偉\n1|C|\n2|C|'), [1, 2], roles).some(e => /重複 L1/.test(e)), '重複');
  ok(T.validateLabels(T.parseLabels('1|S|偉\n2|X|'), [1, 2], roles).some(e => /標籤不在集合內/.test(e)), '標籤不在集合內');
  ok(T.validateLabels(T.parseLabels('1|S|路人甲'), [1], roles).some(e => /角色不在清單內/.test(e)), '角色不在清單內');
  ok(T.validateLabels(T.parseLabels('1|S|'), [1], roles).some(e => /角色不在清單內/.test(e)), 'S 沒填角色');
  ok(T.validateLabels(T.parseLabels('1|S|偉\n9|C|'), [1], roles).some(e => /多出 L9/.test(e)), '多出不在輸入內的行號');
  const al = T.parseLabels('1|S|葉志偉 / 立朗\n2|C|偉'); // 別名對回 id；非 S 的角色清空
  eq(T.validateLabels(al, [1, 2], roles), [], '別名可對回 id');
  eq([al.map.get(1).role, al.map.get(2).role], ['偉/朗', ''], '角色正規化為 id，C 的角色清空');
}

// ---- parseFormat ----
{
  const f = T.parseFormat('```json\n{"roles":[{"id":"朗/x","name":"陳立朗","aliases":["立朗","朗","立朗"],"gender":"m"},{"id":"朗x"},{"id":""}],"rules":{"speaker_pos":"prefix"}}\n```');
  eq(f.roles.map(r => r.id), ['朗x'], '角色 id 去掉非法字元；撞名者丟棄');
  let threw = 0;
  for (const bad of ['not json', '{"roles":[]}', '{"x":1}']) { try { T.parseFormat(bad); } catch (e) { threw++; } }
  eq(threw, 3, '壞格式丟錯');
}

// ---- 本機規則 ----
{
  eq(T.stripDirections('（向 Kumi）喂！你影快啲啦'), { t: '喂！你影快啲啦', had: true }, '開頭指示');
  eq(T.stripDirections('影完！(Kumi 拿着叉等待着。)'), { t: '影完！', had: true }, '結尾半形指示');
  eq(T.stripDirections('哦…（擺了另一個 post）咁？'), { t: '哦…咁？', had: true }, '中間指示');
  eq(T.stripDirections('甲（乙（丙）丁）戊'), { t: '甲戊', had: true }, '巢狀括號');
  eq(T.stripDirections('我想吃牛排。( 頓 ) 你跟麻出去'), { t: '我想吃牛排。你跟麻出去', had: true }, '夾在中文之間的指示連同空白一起拿掉');
  eq(T.stripDirections('Hello (waves) world'), { t: 'Hello world', had: true }, '英文指示兩側只留一個空白');
  eq(T.stripDirections('冇指示嘅台詞'), { t: '冇指示嘅台詞', had: false }, '沒有指示');

  // 日文標記：以《離地》既有標記校準
  let lines = 0, exact = 0;
  for (const sc of loadScenes()) for (const l of sc.lines) {
    if (l.t === undefined) continue;
    const gm = /⟦/.test(l.t);
    const got = T.markJapanese(l.t.replace(/[⟦⟧]/g, ''));
    if (gm || /⟦/.test(got)) { lines++; if (got === l.t) exact++; }
  }
  ok(exact / lines >= 0.8, `日文標記與既有標記完全一致 ${exact}/${lines}（≥80%）`);
  eq(T.markJapanese('買咗邊款お守り？唔好亂買呀'), '買咗邊款⟦お守り⟧？唔好亂買呀', '敬語前綴前面的粵語不吞');
  eq(T.markJapanese('夏休み一齊去鬼屋玩囉!'), '⟦夏休み⟧一齊去鬼屋玩囉!', '後面的粵語不吞');
  eq(T.markJapanese('我哋走啦，唔該晒'), '我哋走啦，唔該晒', '純粵語不動');
  eq(T.markJapanese('已有⟦すみません⟧'), '已有⟦すみません⟧', '已有標記不重複標');

  const surf = T.buildSurfaceMap(roles);
  eq(T.splitSpeakerPrefix('偉：你好', surf), { rest: '你好', pre: '偉：', dir: '', ids: ['偉'] }, '簡稱＋全形冒號');
  eq(T.splitSpeakerPrefix('葉志偉: 你好', surf), { rest: '你好', pre: '葉志偉: ', dir: '', ids: ['偉'] }, '全名＋半形冒號');
  eq(T.splitSpeakerPrefix('朗（低聲）：你好', surf), { rest: '你好', pre: '朗（低聲）：', dir: '（低聲）', ids: ['朗'] }, '前綴帶指示');
  eq(T.splitSpeakerPrefix('偉、朗：好呀', surf).ids, ['偉', '朗'], '合說');
  eq(T.splitSpeakerPrefix('我同你講：你好', surf), null, '台詞裡的冒號不當前綴');
  eq(T.splitSpeakerPrefix('12:30 見', surf), null, '時間不當前綴');
  const en = T.buildSurfaceMap([{ id: 'Madison', name: 'Madison', aliases: [] }, { id: 'Alexandre', name: 'Alexandre', aliases: [] }]);
  eq(T.splitSpeakerPrefix('Madison (yelling) – No!', en), { rest: 'No!', pre: 'Madison (yelling) – ', dir: '(yelling)', ids: ['Madison'] }, '英文：角色名＋指示＋破折號');
  eq(T.splitSpeakerPrefix('Alexandre – Hands up!', en).ids, ['Alexandre'], '破折號');
  eq(T.splitSpeakerPrefix('ALEXANDRE: Hi', en).ids, ['Alexandre'], '大小寫不拘');
  eq(T.splitSpeakerPrefix('Madison and Alexandre – Yes', en).ids, ['Madison', 'Alexandre'], 'and 連接的合說');
  eq(T.splitSpeakerPrefix('The window – across the courtyard', en), null, '不是角色的破折號不當前綴');
  eq(T.splitSpeakerPrefix('Madison is here – really', en), null, '句中的破折號不當前綴');

  // 場次標題：原劇本 22 場全部還原
  const bad = [];
  for (const sc of loadScenes()) {
    const meta = [sc.season, sc.place].filter(Boolean).join('　');
    const h = sc.no + (sc.name ? '　' + sc.name : '') + (meta ? '　' + meta : '');
    const p = T.parseHeading(h);
    if (p.no !== sc.no || p.name !== sc.name || p.season !== sc.season || p.place !== sc.place) bad.push([h, p]);
  }
  ok(bad.length <= 2, '場次標題解析（22 場）失敗 ' + bad.length + '：' + JSON.stringify(bad.slice(0, 3)));
  eq(T.parseHeading('=== 第三場　分類 ===　『夏』　大阪'), { no: '第三場', name: '分類', season: '『夏』', place: '大阪' }, '裝飾標題');
  eq(T.parseHeading('SCENE 2').no, 'SCENE2', '英文標題');
}

// ---- 切塊 / 取樣 ----
{
  const mk = k => Array.from({ length: k }, (_, i) => ({ n: i + 1, text: 'x' + i }));
  const c = T.chunkLines(mk(700), 300, 10);
  eq(c.map(x => [x.start, x.end, x.from, x.to]), [[0, 300, 0, 310], [300, 600, 290, 610], [600, 700, 590, 700]], '切塊與重疊');
  eq(T.chunkLines(mk(610), 300, 10).length, 2, '太小的尾塊併回前一塊');
  ok(T.chunkLines(mk(1452), 300, 10).every(x => x.to - x.from <= 400), '每塊不超過 Worker 單次 400 行上限');
  eq(T.sampleForFormat(mk(300)).length, 300, '短劇本全送');
  const s = T.sampleForFormat(mk(1452));
  ok(s.length <= 400 && s[0].n === 1 && s[199].n === 200 && s[s.length - 1].n === 1452, '長劇本：前 200 行 + 後段片段（含結尾）');
}

// ---- 組回的邊界情況 ----
{
  const L = (n, text) => ({ n, text });
  const lab = (...xs) => new Map(xs.map(([n, label, role]) => [n, { label, role: role || '' }]));
  // 孤兒 C、只有指示的 S、連續兩行標題、雜訊保留為 x
  const lines = [L(1, '第一場'), L(2, '求神'), L(3, '接上文'), L(4, '偉：（沉默）'), L(5, '偉：你好，'), L(6, '- 3 -'), L(7, '再見'), L(8, 'Kumi：Hello'), L(9, 'world')];
  const r = T.assemble(lines, lab([1, 'H'], [2, 'H'], [3, 'C'], [4, 'S', '偉'], [5, 'S', '偉'], [6, 'N'], [7, 'C'], [8, 'S', 'K'], [9, 'C']), roles);
  eq(r.scenes.length, 1, '連續兩行標題併成一個場次');
  eq([r.scenes[0].no, r.scenes[0].name], ['第一場', '求神'], '標題合併後解析');
  const ls = r.scenes[0].lines;
  eq(ls[0], { d: '接上文', rv: true }, '孤兒續行轉成待校正的指示');
  eq(ls[1], { d: '偉：（沉默）' }, '只剩指示的台詞轉成指示（保留原文）');
  eq(ls[2], { s: '偉', t: '你好，再見' }, '續行併入，中間夾的雜訊不影響');
  eq(ls[3], { x: '- 3 -' }, '雜訊保留為 x（校正頁可還原）');
  eq(ls[4], { s: 'K', t: 'Hello world' }, '英文續行補空白');
  const rj = T.assemble([L(1, 'Alexandre – value here,'), L(2, 'believe me.')], lab([1, 'S', 'Alexandre'], [2, 'C']), [{ id: 'Alexandre', name: 'Alexandre', aliases: [] }]);
  eq(rj.scenes[0].lines[0], { s: 'Alexandre', t: 'value here, believe me.' }, '標點結尾的英文續行也補空白，且剝掉破折號前綴');
  eq(r.stats.orphanC, 1, '統計孤兒續行');
  // 無標題：全部進單一場景
  const r2 = T.assemble([L(1, '偉：甲'), L(2, '朗：乙')], lab([1, 'S', '偉'], [2, 'S', '朗']), roles);
  eq(r2.scenes.length, 1, '無標題劇本放進單一場景');
  // 模型漏標：缺的行視為待校正的雜訊
  const r3 = T.assemble([L(1, '偉：甲'), L(2, '???')], lab([1, 'S', '偉']), roles);
  eq(r3.scenes[0].lines[1], { x: '???' }, '缺標記的行保留為雜訊');
  // 內嵌指示 → r
  const r4 = T.assemble([L(1, '朗（笑）：喂！（揮手）你好')], lab([1, 'S', '朗']), roles);
  eq(r4.scenes[0].lines[0], { s: '朗', t: '喂！你好', r: '（笑）喂！（揮手）你好' }, '前綴指示＋內嵌指示 → r 保留原文');
}

(async () => {
  const vs = Object.fromEntries(variants().map(v => [v.id, v]));
  const run = (id, mockOpts, extra) => {
    const v = vs[id];
    const lines = T.buildLines({ text: v.text }).lines;
    const mock = makeMock(lines, v.gold, mockOpts);
    return T.runPipeline(Object.assign({ lines, callApi: mock.callApi }, extra)).then(r => ({ r, lines, mock, v }));
  };

  // 完美模型：全部版面行級 100%，組回無損
  for (const id of ['colon-fw', 'fullname-halfcolon', 'wrapped', 'centered', 'centered-wrapped', 'noisy']) {
    const { r, lines, v } = await run(id, {});
    const s = scoreLabels(lines, r.labels, v.gold), e = scoreScript(r.scenes, loadScenes());
    ok(s.acc === 1, `${id}：行級準確率 100%（${(s.acc * 100).toFixed(2)}）`);
    ok(e.fidelity === 1, `${id}：組回後與原劇本逐行相同（${(e.fidelity * 100).toFixed(2)}）`);
    ok(r.stats.failedChunks === 0 && r.stats.review === 0, `${id}：沒有失敗塊／待校正行`);
    eq(r.scenes.length, 22, `${id}：22 個場次`);
  }
  // 重試：回應常壞掉，重試一次後多數通過；兩次都壞的塊用本機規則後備並標待校正
  {
    const { r, mock, lines, v } = await run('wrapped', { failRate: 0.45, seed: 3 }, { concurrency: 1 });
    ok(r.stats.retried > 0, '有重試');
    ok(mock.calls.label > r.stats.chunks, '重試多打了請求：' + mock.calls.label + ' > ' + r.stats.chunks);
    ok(r.stats.failedChunks === r.stats.failedChunkNos.length, '失敗塊號清單');
    if (r.stats.failedChunks) ok(r.stats.review > 0, '失敗塊的行被標為待校正');
    const s = scoreLabels(lines, r.labels, v.gold);
    ok(s.acc > 0.95, '後備後行級準確率仍高：' + s.acc.toFixed(4));
  }
  // 全部壞掉：整份都走後備，仍產出劇本，不中止
  {
    const { r, lines, v } = await run('colon-fw', { alwaysFail: false, failRate: 1, seed: 5 });
    eq(r.stats.failedChunks, r.stats.chunks, '全部失敗塊');
    ok(r.stats.review > 1000, '全部標為待校正：' + r.stats.review);
    ok(r.scenes.length === 22 && scoreLabels(lines, r.labels, v.gold).acc > 0.95, '後備仍組出 22 場，行級 >95%');
    ok(r.scenes.every(sc => sc.lines.every(l => l.x !== undefined || l.rv)), '每一行都帶 rv 旗標');
  }
  // 第一段壞掉兩次 → 丟錯；429 → 立即中止（fatal）
  {
    let threw = null;
    try { await run('colon-fw', { alwaysFail: true }); } catch (e) { threw = e; }
    ok(threw && /無法辨識劇本格式/.test(threw.message), '第一段兩次都壞：丟出明確錯誤');
    threw = null;
    try { await run('colon-fw', { fatal: { after: 2 } }); } catch (e) { threw = e; }
    ok(threw && threw.fatal && threw.status === 429, '429 立即中止，不當成塊失敗');
    const v = vs['wrapped'], lines = T.buildLines({ text: v.text }).lines;
    const mock = makeMock(lines, v.gold, { fatal: { after: 3 } });
    const events = []; let failedAt = -1;
    try { await T.runPipeline({ lines, callApi: mock.callApi, concurrency: 3, onProgress: p => events.push(p) }); } catch (e) { threw = e; failedAt = events.length; }
    await new Promise(r => setTimeout(r, 20));      // 讓還在飛的請求跑完
    eq(events.length, failedAt, 'fatal 之後不再回報進度（否則會蓋掉錯誤畫面）');
    ok(mock.calls.format + mock.calls.label <= 3 + 3, '遇到 fatal 後不再派發新塊（共 ' + (mock.calls.format + mock.calls.label) + ' 次請求，劇本有 7 塊）');
  }
  // 進度回報
  {
    const seen = [];
    await run('colon-fw', {}, { onProgress: p => seen.push(p.stage + ':' + p.done + '/' + p.total) });
    ok(seen[0] === 'format:0/1' && seen.includes('format:1/1') && seen[seen.length - 1] === 'label:5/5', '進度事件：' + seen.join(' '));
  }
  console.log(`✓ pipeline.test.js：${n} 項通過`);
})().catch(e => { console.error('✗', e.message ? e.message.slice(0, 2500) : e); process.exit(1); });
