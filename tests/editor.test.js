// 校正操作核心（TSE）：改標籤／角色／文字、與上一行合併、拆行、場次分隔、角色重新命名／合併／刪除、待校正
const assert = require('assert');
const { loadTSE } = require('./tsp-load');
const { TSE } = loadTSE();
let n = 0;
const ok = (c, m) => { assert(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const mk = () => ({
  schema: 2, meta: { title: 't' },
  roles: [{ id: '偉', name: '葉志偉', aliases: ['志偉'], gender: 'm', spoken: '偉' }, { id: '朗', name: '陳立朗', aliases: [], gender: 'm', spoken: '朗' }, { id: '路人', name: '路人', aliases: [], gender: 'n', spoken: '路人' }],
  scenes: [
    { no: '第一場', name: 'a', season: '', place: '', lines: [{ s: '偉', t: '你好，' }, { s: '偉', t: '朗呀', rv: true }, { x: '- 3 -' }, { d: '（燈暗）' }, { s: '偉/朗', t: 'ok' }] },
    { no: '第二場', name: 'b', season: '', place: '', lines: [{ s: '朗', t: '再見' }, { s: '朗', t: '真係', r: '（笑）真係' }] }
  ]
});

// ---- makeLine / setLine ----
eq(TSE.makeLine('S', ['偉'], '（笑）你好（揮手）'), { s: '偉', t: '你好', r: '（笑）你好（揮手）' }, '台詞：指示拆出 t，r 保留原文');
eq(TSE.makeLine('S', ['偉', '朗'], '好呀'), { s: '偉/朗', t: '好呀' }, '合說');
eq(TSE.makeLine('S', ['偉'], '（沉默）'), { d: '（沉默）' }, '只剩指示 → 轉成指示行');
eq(TSE.makeLine('S', ['偉'], 'すみません'), { s: '偉', t: '⟦すみません⟧' }, '自動日文標記');
eq(TSE.makeLine('S', ['偉'], '我係⟦あ⟧人'), { s: '偉', t: '我係⟦あ⟧人' }, '使用者自己標的日文範圍保留');
eq(TSE.makeLine('S', ['偉'], '（笑）⟦はい⟧'), { s: '偉', t: '⟦はい⟧', r: '（笑）はい' }, 'r 不含標記');
eq(TSE.makeLine('D', [], '⟦x⟧（燈亮）'), { d: 'x（燈亮）' }, '指示不留標記');
eq(TSE.makeLine('X', [], '- 3 -'), { x: '- 3 -' }, '雜訊');
eq(TSE.makeLine('S', ['偉'], '好耐無見\u22EF\u22EF你好嗎'), { s: '偉', t: '好耐無見……你好嗎' }, '中線省略號 ⋯ 正規化成 …（朗讀與比對的標點表只認 …）');
eq(TSE.makeLine('S', ['偉'], '（笑）好耐無見\u22EF\u22EF'), { s: '偉', t: '好耐無見……', r: '（笑）好耐無見\u22EF\u22EF' }, 'r 保留原文的 ⋯');
eq(TSE.makeLine('D', [], '燈暗\u22EF\u22EF'), { d: '燈暗……' }, '指示也正規化');
eq(TSE.makeLine('Y', null, '唱到\u22EF\u22EF\n再唱').lyrics, ['唱到……', '再唱'], '歌詞也正規化');
eq(TSE.makeLine('X', [], '\u22EF'), { x: '\u22EF' }, '雜訊保留原樣');
assert.throws(() => TSE.makeLine('S', [], '甲'), /角色/); n++;
// 【】 指示括號：劇本的 meta.dirPairs 有 '【】'，校正頁重建台詞時才剝掉（和組回時一致）；沒有就照舊
{
  const mkd = pairs => ({ schema: 2, meta: Object.assign({ title: 't' }, pairs ? { dirPairs: pairs } : {}), roles: [], scenes: [{ no: '全劇', name: '', season: '', place: '', lines: [{ s: '偉', t: '好', r: '【笑】好' }, { s: '偉', t: '嘅' }] }] });
  eq(TSE.makeLine('S', ['偉'], '【笑】你好【揮手】', ['【】']), { s: '偉', t: '你好', r: '【笑】你好【揮手】' }, 'makeLine 帶 pairs：剝掉 【】');
  eq(TSE.makeLine('S', ['偉'], '【笑】你好'), { s: '偉', t: '【笑】你好' }, '沒有 pairs：照舊');
  eq(TSE.makeLine('S', ['偉'], '【沉默】', ['【】']), { d: '【沉默】' }, '只剩指示 → 轉成指示行');
  const d = mkd(['【】']);
  TSE.setLine(d, 0, 1, 'S', ['偉'], '【嘆氣】嘅');
  eq(d.scenes[0].lines[1], { s: '偉', t: '嘅', r: '【嘆氣】嘅' }, 'setLine 讀 data.meta.dirPairs');
  TSE.mergePrev(d, 0, 1);
  eq(d.scenes[0].lines[0], { s: '偉', t: '好嘅', r: '【笑】好【嘆氣】嘅' }, 'mergePrev：合併後兩邊的 【】 都剝掉');
  const e = mkd(['【】']);
  TSE.splitAt(e, 0, 0, 'S', ['偉'], '【笑】好呀，你呢', 6);
  eq(e.scenes[0].lines.slice(0, 2), [{ s: '偉', t: '好呀，', r: '【笑】好呀，' }, { s: '偉', t: '你呢' }], 'splitAt：拆開後各自剝掉 【】');
  const f = mkd(null);
  TSE.setLine(f, 0, 1, 'S', ['偉'], '【嘆氣】嘅');
  eq(f.scenes[0].lines[1], { s: '偉', t: '【嘆氣】嘅' }, '沒有 meta.dirPairs：照舊');
}
{
  const d = mk();
  TSE.setLine(d, 0, 3, 'S', ['朗'], '（燈暗）後話');
  eq(d.scenes[0].lines[3], { s: '朗', t: '後話', r: '（燈暗）後話' }, '指示 → 台詞');
  TSE.setLine(d, 0, 0, 'X', [], '你好，');
  eq(d.scenes[0].lines[0], { x: '你好，' }, '台詞 → 雜訊');
  eq(TSE.fullText({ s: '偉', t: '好', r: '（笑）好' }), '（笑）好', '編輯框用含指示的原文');
}

// ---- 合併 ----
{
  const d = mk();
  eq(TSE.mergePrev(d, 0, 1), 0, '回傳合併後索引');
  eq(d.scenes[0].lines[0], { s: '偉', t: '你好，朗呀' }, '台詞接台詞');
  eq(d.scenes[0].lines.length, 4, '少一行');
}
{
  const d = mk();
  d.scenes[0].lines = [{ s: '偉', t: '甲' }, { x: '- 3 -' }, { s: '偉', t: '乙' }];
  eq(TSE.mergePrev(d, 0, 2), 0, '略過中間雜訊');
  eq(d.scenes[0].lines, [{ s: '偉', t: '甲乙' }, { x: '- 3 -' }], '雜訊行留在原處');
  const e = mk();
  eq(TSE.mergePrev(e, 0, 0), -1, '場內第一行不能與上一行合併');
  eq(TSE.mergePrev(e, 1, 0), -1, '不跨場次合併');
  const f = mk(); f.scenes[0].lines = [{ d: '（甲）' }, { s: '偉', t: '乙' }];
  eq(TSE.mergePrev(f, 0, 1), 0, '指示接台詞');
  eq(f.scenes[0].lines[0], { d: '（甲）乙' }, '前一行是指示 → 併成指示');
  const g = mk(); g.scenes[0].lines = [{ s: '偉', t: 'Hello', rv: true }, { s: '偉', t: 'world' }];
  TSE.mergePrev(g, 0, 1);
  eq(g.scenes[0].lines[0], { s: '偉', t: 'Hello world' }, '英文補空白，且合併後不再標待校正');
  const h = mk(); h.scenes[0].lines = [{ s: '偉', t: '好', r: '（笑）好' }, { s: '偉', t: '呀（揮手）' }];
  TSE.mergePrev(h, 0, 1);
  eq(h.scenes[0].lines[0], { s: '偉', t: '好呀', r: '（笑）好呀（揮手）' }, '合併時重算 t／r');
}

// ---- 拆行 ----
{
  const d = mk();
  eq(TSE.splitLine(d, 1, 0, 1), 1, '回傳新行索引');
  eq(d.scenes[1].lines.slice(0, 2), [{ s: '朗', t: '再' }, { s: '朗', t: '見' }], '依游標拆成兩行');
  const e = mk();
  assert.throws(() => TSE.splitLine(e, 1, 0, 0), /游標/); n++;
  assert.throws(() => TSE.splitLine(e, 1, 0, 2), /游標/); n++;
}
{
  const e = mk();
  TSE.splitLine(e, 1, 1, 3);
  eq(e.scenes[1].lines[1], { d: '（笑）' }, '拆出只剩指示的一段 → 變成指示行');
  eq(e.scenes[1].lines[2], { s: '朗', t: '真係' }, '另一段仍是台詞');
  const f = mk(); f.scenes[0].lines = [{ d: '（甲乙）' }];
  TSE.splitLine(f, 0, 0, 2); eq(f.scenes[0].lines, [{ d: '（甲' }, { d: '乙）' }], '指示拆行');
}

// ---- 場次 ----
{
  const d = mk();
  eq(TSE.insertSceneBefore(d, 0, 2, '第三場　補場'), 1, '在第 3 行前插入分隔，回傳新場次索引');
  eq(d.scenes.map(s => s.no), ['第一場', '第三場', '第二場'], '場次順序');
  eq(d.scenes[1].name, '補場', '標題解析 name');
  eq(d.scenes[0].lines.length, 2, '原場次只剩前兩行');
  eq(d.scenes[1].lines.length, 3, '新場次拿到其餘行');
  const e = mk();
  TSE.insertSceneBefore(e, 0, 1, '第二場');
  eq(e.scenes[1].no, '第二場#2', '撞名時自動加後綴，避免成績鍵衝突');
  assert.throws(() => TSE.insertSceneBefore(e, 0, 0, 'x'), /第一行/); n++;
  const f = mk();
  eq(TSE.removeSceneBreak(f, 1), 0, '移除分隔併入上一場');
  eq(f.scenes.length, 1, '場次減一');
  eq(f.scenes[0].lines.length, 7, '行數相加');
  assert.throws(() => TSE.removeSceneBreak(f, 0), /上一場/); n++;
  const g = mk();
  TSE.setSceneField(g, 1, 'name', '新名'); eq(g.scenes[1].name, '新名', '改場名');
  assert.throws(() => TSE.setSceneField(g, 1, 'no', '第一場'), /同名/); n++;
  assert.throws(() => TSE.setSceneField(g, 1, 'no', ' '), /空白/); n++;
  TSE.setSceneField(g, 1, 'no', '第二場A'); eq(g.scenes[1].no, '第二場A', '改場次編號');
}

// ---- 角色 ----
{
  const d = mk();
  const u = TSE.roleUsage(d);
  eq([u.get('偉'), u.get('朗'), u.get('路人')], [3, 3, 0], '角色用量（合說各算一次）');
  TSE.renameRole(d, '偉', '志偉', '葉志偉（改）');
  eq(d.roles[0].id, '志偉', '改 id');
  eq(d.scenes[0].lines[4].s, '志偉/朗', '所有行（含合說）同步改寫');
  eq(d.roles[0].spoken, '志偉', 'spoken 跟著改');
  assert.throws(() => TSE.renameRole(d, '朗', '志偉'), /合併/); n++;
  TSE.renameRole(d, '朗', '朗', '陳立朗(改)'); eq(d.roles[1].name, '陳立朗(改)', '只改全名');
  TSE.setGender(d, '朗', 'f'); eq(d.roles[1].gender, 'f', '性別');
  TSE.setGender(d, '朗', 'x'); eq(d.roles[1].gender, 'n', '無效性別 → n');
}
{
  const d = mk();
  TSE.mergeRoles(d, '朗', '偉');
  eq(d.roles.map(r => r.id), ['偉', '路人'], '合併後來源角色消失');
  eq(d.scenes[0].lines[4].s, '偉', '合說「偉/朗」合併成「偉」，不重複');
  eq(d.scenes[1].lines[0].s, '偉', '其他行改寫');
  ok(d.roles[0].aliases.includes('朗') && d.roles[0].aliases.includes('陳立朗') && d.roles[0].aliases.includes('志偉'), '來源的稱呼併入別名');
  assert.throws(() => TSE.mergeRoles(d, '偉', '偉'), /自己/); n++;
}
{
  const d = mk();
  assert.throws(() => TSE.deleteRole(d, '偉'), /還有台詞/); n++;
  TSE.deleteRole(d, '路人'); eq(d.roles.length, 2, '只能刪除沒有台詞的角色');
  const r = TSE.addRole(d, '新角', '', 'f'); eq([r.id, r.name, r.gender], ['新角', '新角', 'f'], '新增角色');
  assert.throws(() => TSE.addRole(d, '新角'), /已有/); n++;
  assert.throws(() => TSE.addRole(d, ' '), /空白/); n++;
}

// ---- 歌曲區塊 ----
{
  const d = { schema: 2, meta: {}, roles: [{ id: '偉', name: '偉', aliases: [], gender: 'n', spoken: '偉' }], scenes: [{ no: '一', name: '', season: '', place: '', lines: [
    { s: '偉', t: '你好' }, { d: '（音樂起）' }, { song: '歌一', lyrics: ['啦啦啦', '噠噠噠'] }, { s: '偉', t: '再見' }, { x: '噪音' }] }] };
  eq(TSE.kindOf(d.scenes[0].lines[2]), 'Y', '歌曲的種類是 Y');
  eq(TSE.fullText(d.scenes[0].lines[2]), '啦啦啦\n噠噠噠', '歌曲的完整文字＝每行一句歌詞');
  eq(TSE.makeLine('Y', null, ' 甲 \n\n乙 '), { song: '', lyrics: ['甲', '乙'] }, '歌詞文字拆成多行、去空行');
  assert.throws(() => TSE.makeLine('Y', null, '  \n '), /歌詞不能空白/); n++;
  eq(TSE.mergePrev(d, 0, 3), -1, '歌曲區塊不與台詞合併');
  assert.throws(() => TSE.splitLine(d, 0, 2, 1), /不能拆行/); n++;
  TSE.setSong(d, 0, 2, ' 新歌名 ', '甲\n乙\n丙');
  eq(d.scenes[0].lines[2], { song: '新歌名', lyrics: ['甲', '乙', '丙'] }, '改歌名與歌詞');
  assert.throws(() => TSE.setSong(d, 0, 0, 'x', 'y'), /不是歌曲區塊/); n++;
  // 一般行 → 歌詞：前面緊接歌曲就併進去
  d.scenes[0].lines.splice(3, 0, { d: '丁丁丁' });
  eq(TSE.lineToSong(d, 0, 3), 2, '併進前一首歌');
  eq(d.scenes[0].lines[2].lyrics, ['甲', '乙', '丙', '丁丁丁'], '歌詞接在後面');
  eq(d.scenes[0].lines.length, 5, '原本那行被移除');
  // 前後都不是歌 → 自成一個歌曲區塊
  eq(TSE.lineToSong(d, 0, 0, '孤單的一句'), 0, '自成歌曲區塊');
  eq(d.scenes[0].lines[0], { song: '', lyrics: ['孤單的一句'] }, '新歌曲區塊');
  // 後面緊接歌曲
  const e = { scenes: [{ lines: [{ d: '前' }, { song: 'X', lyrics: ['後'] }] }] };
  eq(TSE.lineToSong(e, 0, 0), 0, '併進後一首歌');
  eq(e.scenes[0].lines, [{ song: 'X', lyrics: ['前', '後'] }], '歌詞接在前面');
  // 拆成一般行：每句一行指示
  eq(TSE.songToLines(d, 0, 2), 2, '拆開');
  eq(d.scenes[0].lines.slice(2, 6).map(l => l.d), ['甲', '乙', '丙', '丁丁丁'], '歌詞變成指示行');
  eq(TSE.roleUsage(d).get('偉'), 1, '歌曲區塊不計入角色使用數（剩下的台詞只有「再見」）');
}

// ---- 待校正 ----
{
  const d = mk();
  eq(TSE.pending(d), [{ si: 0, li: 1 }], '列出待校正行');
  TSE.clearRv(d, 0, 1); eq(TSE.pending(d), [], '標記已確認');
}
console.log(`✓ editor.test.js：${n} 項通過`);
