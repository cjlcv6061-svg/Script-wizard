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
  eq(T.parseFormat('{"roles":[{"id":"Madison","name":"Madison","aliases":["Madison –","Madison:","—","Mad"]}],"rules":{}}').roles[0].aliases, ['Mad'], '別名連尾端的冒號／破折號一起寫時去掉，剩空字串的丟掉');
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


// ---- 候選稱呼表與分類結果 ----
{
  const L = (n, text) => ({ n, text });
  const mk = arr => arr.map((x, i) => L(i + 1, x));
  const rl = (...ids) => ids.map(id => ({ id, name: id, aliases: [], gender: 'n' }));
  const src = [];
  for (let i = 0; i < 12; i++) src.push('兄：甲' + i, '妹：乙' + i);
  src.push('護士：請借過', '護士：讓一讓', '護士：小心', 'SD Cue：煙花聲效', 'SD Cue：轉場音樂', '楊：你好', '楊：再見', '路人：喂');       // 路人只出現 1 次
  const d = T.detectPrefix(mk(src), rl('兄', '妹'));
  eq(d.candidates.map(c => [c[0], c[1]]), [['護士', 3], ['SD Cue', 2], ['楊', 2], ['路人', 1]], '候選稱呼：行首出現過、模型沒列出的稱呼，依次數排序（只出現 1 次的也列，已知角色不列）');
  eq(d.candidates.map(c => c[2]), ['護士：請借過', 'SD Cue：煙花聲效', '楊：你好', '路人：喂'], '每個候選附第一次出現的那一行當例句');
  // 句子裡的逗號不是合說分隔符：台詞續行「無人需要我留低，好自由，跟住我同自己講：「…」」不會被拆成三個候選稱呼；「、」「／」合說仍然認得
  const comma = src.concat(['無人需要我留低，好自由，跟住我同自己講：「實仲有」', 'Well, hmm: okay then', '兄、妹：一齊講']);
  const dc = T.detectPrefix(mk(comma), rl('兄', '妹'));
  eq(dc.candidates.map(c => c[0]).filter(x => /好自由|跟住|無人|hmm|Well/.test(x)), [], '逗號不拆候選稱呼');
  eq(T.detectPrefix(mk(src.concat(['兄、妹：一齊講'])), rl('兄', '妹')).prefixLines, 24 + 1, '「兄、妹：」合說仍然算前綴行');
  // 結尾帶編號的稱呼（路人1、村民２）認得；開頭是數字的（時間）不是稱呼
  const numd = src.concat(['路人1：喂', '路人2：你好', '村民２：嗨', '12:30 見面', '3：45 開始']);
  eq(T.detectPrefix(mk(numd), rl('兄', '妹')).candidates.map(c => c[0]).filter(x => /路人|村民|12|3/.test(x)).sort(), ['村民２', '路人', '路人1', '路人2'], '稱呼結尾可帶編號（路人 是前面 src 裡原有的）；「12:30」「3：45」不是稱呼');
  // 中英混合的稱呼（亞Toy、呂VO、魔老VO）也認得
  const mixed = []; for (let i = 0; i < 14; i++) mixed.push('呂同學：句' + i, '魔老：回' + i);
  mixed.push('亞Toy  ：呀妳要玩具', '亞Toy  ：笑妹妹', '呂VO    ：係呢頭先', '魔老VO：係傳說嚟架', 'VO\t：特別新聞');
  eq(T.detectPrefix(mk(mixed), rl('呂同學', '魔老')).candidates.map(c => [c[0], c[1]]), [['亞Toy', 2], ['呂VO', 1]], '中英混合的稱呼：亞Toy、呂VO 進候選；「魔老VO」去掉畫外音標記就是已知角色魔老，不用問；單獨的「VO」是旁白，由規則決定、也不問模型');
  eq(T.splitSpeakerPrefix('呂VO    ：係呢', T.buildSurfaceMap([{ id: '呂VO', name: '呂VO', aliases: [] }])).ids, ['呂VO'], '中英混合的稱呼也能剝前綴');
  // 畫外音（琳V.O.）、旁白／VO 本身、逗號合說（輝，華：）：行首有就是台詞，不問模型、不標待校正
  {
    const rl3 = [{ id: '輝', name: '王家輝', aliases: [] }, { id: '華', name: '張美華', aliases: [] }, { id: '琳', name: '王家琳', aliases: [] }];
    const body = []; for (let i = 0; i < 14; i++) body.push('輝：句' + i, '華：回' + i);
    body.push('輝，華：阿嫲！', '琳V.O.\t：喂亞哥，亞伯走咗！', '琳 O.S.：外面有人', 'VO\t：特別新聞報告：「今日下午發生火警」', '旁白：夜晚，下著雨。', '無人需要我留低，好自由，跟住我同自己講：「實仲有」');
    const ls = mk(body), pf = T.detectPrefix(ls, rl3);
    ok(pf.on, '前綴格式');
    ok(pf.roles.some(r => r.id === 'VO') && pf.roles.some(r => r.id === '旁白'), '旁白、VO 單獨出現一次也成為角色（不靠出現次數）：' + pf.roles.map(r => r.id));
    ok(!pf.candidates.some(c => c[0] === 'VO' || c[0] === '旁白'), '旁白、VO 不問模型');
    const lab = new Map(ls.map(l => [l.n, { label: 'N', role: '' }]));
    T.applyPrefix(ls, lab, pf.roles, pf.sep);
    const got = n => lab.get(ls[n].n);
    eq([got(28).label, got(28).role], ['S', '輝/華'], '「輝，華：」逗號合說（兩個都是已知角色）');
    eq([got(29).label, got(29).role], ['S', '琳'], '「琳V.O.」是琳在畫外說話');
    eq([got(30).label, got(30).role], ['S', '琳'], '「琳 O.S.」也是');
    eq([got(31).label, got(31).role], ['S', 'VO'], '單獨的「VO：」');
    eq([got(32).label, got(32).role], ['S', '旁白'], '「旁白：」');
    ok(got(33).label === 'N', '句子裡的逗號不是合說：「無人需要我留低，好自由，…：」不被當前綴');
    ok([28, 29, 30, 31, 32].every(n => !got(n).rv), '這幾行是確定的，不標待校正');
  }
  // 劇本只是整份文件的一部分（論文）：前綴行占比被稀釋（<25%），但很多（≥100 且 ≥10%）且集中在已知角色上，也啟用前綴規則
  {
    const rl6 = [{ id: '阿宏', name: '阿宏', aliases: [] }, { id: '阿燈', name: '阿燈', aliases: [] }];
    const doc = []; for (let i = 0; i < 150; i++) doc.push('阿宏：句' + i, '阿燈：回' + i);
    for (let i = 0; i < 900; i++) doc.push('這是論文的說明文字第' + i + '行，沒有說話者。');
    ok(T.detectPrefix(mk(doc), rl6).on, '300 行前綴／1200 行（25%）：啟用');
    const diluted = doc.concat(Array.from({ length: 1300 }, (_, i) => '論文說明文字續' + i + '，沒有說話者。'));
    ok(T.detectPrefix(mk(diluted), rl6).on, '300 行前綴／2500 行（12%，≥100 且 ≥10%）：啟用');
    const tooDiluted = doc.concat(Array.from({ length: 4000 }, (_, i) => '論文說明文字續' + i + '，沒有說話者。'));
    ok(!T.detectPrefix(mk(tooDiluted), rl6).on, '300 行前綴／5200 行（<10%）：不啟用');
    const fewPrefix = []; for (let i = 0; i < 40; i++) fewPrefix.push('阿宏：句' + i, '阿燈：回' + i);
    for (let i = 0; i < 400; i++) fewPrefix.push('說明文字第' + i + '行，沒有說話者。');
    ok(!T.detectPrefix(mk(fewPrefix), rl6).on, '只有 80 行前綴（<100）：不因寬鬆規則啟用');
  }
  // 劇本以外的內容：離台詞很遠的指示／標題改雜訊；論述裡孤立的引文改雜訊（劇本裡夾在台詞中間的引號台詞留著）
  {
    const mkl = arr => arr.map((t, i) => ({ n: i + 1, text: t }));
    const rows = [];                                                    // [文字, 標籤]
    for (let i = 0; i < 6; i++) rows.push(['這是論文前言第' + i + '行說明。', 'D']);
    rows.push(['前言章節標題', 'H']);
    for (let i = 0; i < 70; i++) rows.push(['這是論文前言填充行' + i + '。', 'D']);
    rows.push(['第一場', 'H'], ['（燈亮。）', 'D']);
    for (let i = 0; i < 30; i++) rows.push(['甲：第' + i + '句。', 'S'], ['乙：好。', 'S']);
    rows.push(['乙：「他說他不來了。」', 'S'], ['甲：真的？', 'S'], ['（甲轉身離開。）', 'D']);
    for (let i = 0; i < 80; i++) rows.push(['這是論文論述第' + i + '行。', 'D']);
    rows.push(['甲：「我記得他說過這句話。」', 'S'], ['這是引文後面的續行。', 'C']);
    for (let i = 0; i < 70; i++) rows.push(['論述結尾文字' + i + '。', 'D']);
    const lines = mkl(rows.map(r => r[0])), labels = new Map(rows.map((r, i) => [i + 1, { label: r[1], role: r[1] === 'S' ? r[0].split('：')[0] : '' }]));
    const r = T.trimNonScript(lines, labels), at = t => labels.get(lines.findIndex(l => l.text === t) + 1).label;
    eq(at('這是論文前言第0行說明。'), 'N', '離台詞很遠的前言指示改雜訊');
    eq(at('前言章節標題'), 'N', '離台詞很遠的標題改雜訊');
    eq(at('第一場'), 'H', '緊鄰台詞的場次標題留著');
    eq(at('（燈亮。）'), 'D', '夾在台詞旁的舞台指示留著');
    eq(at('（甲轉身離開。）'), 'D', '台詞後的舞台指示留著');
    eq(at('乙：「他說他不來了。」'), 'S', '夾在台詞中間的引號台詞留著');
    eq(at('甲：「我記得他說過這句話。」'), 'N', '論述裡孤立的引文改雜訊');
    eq(at('這是引文後面的續行。'), 'N', '引文後面離劇本很遠的續行改雜訊');
    ok(r.quotes === 1 && r.far > 100, '回報：引文 1 行、遠離劇本 ' + r.far + ' 行');
    // 台詞很少（<50）：整份不動
    const few = mkl(['（說明）', '甲：好。', '（說明）']), fl = new Map([[1, { label: 'D', role: '' }], [2, { label: 'S', role: '甲' }], [3, { label: 'D', role: '' }]]);
    eq(T.trimNonScript(few, fl), { quotes: 0, far: 0 }, '台詞少於 50 行：不動');
    // 台詞行大多以引號起頭的劇本：不當引文
    const qr = []; for (let i = 0; i < 60; i++) qr.push(['甲：「第' + i + '句。」', 'S']); for (let i = 0; i < 80; i++) qr.push(['說明' + i, 'D']); qr.push(['乙：「孤立的一句。」', 'S']);
    const ql = mkl(qr.map(x => x[0])), qlab = new Map(qr.map((x, i) => [i + 1, { label: x[1], role: x[1] === 'S' ? x[0].split('：')[0] : '' }]));
    eq(T.trimNonScript(ql, qlab).quotes, 0, '台詞大多以引號起頭（≥10%）：不當引文');
  }
  // 縮寫合說：「老人甲/乙：」＝老人甲＋老人乙（後面的稱呼借用第一個稱呼的開頭）
  {
    const rl5 = [{ id: '老人甲', name: '老人甲', aliases: [] }, { id: '老人乙', name: '老人乙', aliases: [] }, { id: '魔老', name: '魔老', aliases: [] }];
    const body = []; for (let i = 0; i < 14; i++) body.push('老人甲：句' + i, '魔老：回' + i);
    body.push('老人甲/乙：咪係！', '老人甲/丁：冇呢個人');
    const ls = mk(body), pf = T.detectPrefix(ls, rl5), lab = new Map(ls.map(l => [l.n, { label: 'N', role: '' }]));
    T.applyPrefix(ls, lab, pf.roles, pf.sep);
    eq([lab.get(ls[28].n).label, lab.get(ls[28].n).role], ['S', '老人甲/老人乙'], '「老人甲/乙：」縮寫合說');
    ok(lab.get(ls[29].n).label !== 'S' || lab.get(ls[29].n).rv, '「老人甲/丁」找不到「老人丁」：不當成確定的台詞');
  }
  // 破折號貼著字的寫法（「Madison- So?」「Alexandre –I don't」）：稱呼是已知角色、破折號至少一邊有空白
  {
    const rl4 = [{ id: 'Madison', name: 'Madison', aliases: [] }, { id: 'Alexandre', name: 'Alexandre', aliases: [] }];
    const body = []; for (let i = 0; i < 14; i++) body.push('Madison – Line ' + i, 'Alexandre – Reply ' + i);
    body.push('Madison- So? Would you consider it?', "Alexandre –I don't know about that", 'Madison-based companies are rich', 'Well- that is a thought');
    const ls = mk(body), pf = T.detectPrefix(ls, rl4);
    eq(pf.sep, 'dash', '破折號風格');
    const lab = new Map(ls.map(l => [l.n, { label: 'N', role: '' }]));
    T.applyPrefix(ls, lab, pf.roles, pf.sep);
    const got = n => lab.get(ls[n].n);
    eq([got(28).label, got(28).role], ['S', 'Madison'], '「Madison- So?」（破折號前沒空白、後面有）');
    eq([got(29).label, got(29).role], ['S', 'Alexandre'], '「Alexandre –I…」（破折號前有空白、後面沒有）');
    ok(got(30).label === 'N', '「Madison-based …」（沒有空白）不是前綴');
    ok(got(31).label === 'N', '「Well- that」不是已知角色');
  }
  eq(T.detectPrefix(mk(src), rl('兄', '妹', '護士')).candidates.map(c => c[0]), ['SD Cue', '楊', '路人'], '已知角色不再是候選');

  // parseRoleVerdicts
  const cands = [['護士', 3, ''], ['SD Cue', 2, ''], ['楊', 2, ''], ['路人', 2, '']];
  const known = [{ id: '楊淑華', name: '楊淑華', aliases: [] }];
  const v = T.parseRoleVerdicts('好的，結果如下：\n```\n護士|R|\nSD Cue ｜ N ｜\n楊|A|楊淑華\n路人|A|不存在的角色\n陌生人|R|\n護士|N|\n```', cands, known);
  eq([...v], [['護士', { k: 'R' }], ['SD Cue', { k: 'N' }], ['楊', { k: 'A', to: '楊淑華' }]], '解析：只認候選表裡的稱呼；對應角色不在清單的 A 整筆忽略；重複的以第一筆為準；全形直線與空白容忍');
  eq(T.parseRoleVerdicts('護士|r|', cands, known).get('護士'), { k: 'R' }, '類別大小寫不拘');
  eq(T.parseRoleVerdicts('', cands, known).size + T.parseRoleVerdicts('我不知道', cands, known).size, 0, '空白或不是格式的回應：沒有任何判斷');

  // applyRoleVerdicts
  const base = [{ id: '兄', name: '兄', aliases: [] }, { id: '楊淑華', name: '楊淑華', aliases: [] }, { id: '機', name: '機', aliases: [] }, { id: '護士', name: '護士', aliases: [] }];
  const r1 = T.applyRoleVerdicts(base, new Map([['新角', { k: 'R' }], ['護士', { k: 'R' }], ['機', { k: 'N' }], ['SD Cue', { k: 'N' }]]), ['護士']);
  eq(r1.roles.map(r => r.id), ['兄', '楊淑華', '機', '護士', '新角'], 'R：補進清單（已在清單的不重複）；N 只撤銷「自動補進」的角色，模型第一段列的不動');
  eq(r1.stats, { role: 1, alias: 0, noise: 2 }, '統計');
  const r2 = T.applyRoleVerdicts(base, new Map([['護士', { k: 'N' }], ['楊', { k: 'A', to: '楊淑華' }], ['楊2', { k: 'A', to: '沒這個人' }]]), ['護士']);
  eq(r2.roles.map(r => r.id), ['兄', '楊淑華', '機'], 'N 撤銷自動補進的「護士」');
  eq(r2.roles.find(r => r.id === '楊淑華').aliases, ['楊'], 'A：併成別名；對應角色不存在的忽略');
  const r3 = T.applyRoleVerdicts([{ id: '兄', name: '兄', aliases: [] }, { id: '楊', name: '楊', aliases: [] }, { id: '楊淑華', name: '楊淑華', aliases: [] }], new Map([['楊', { k: 'A', to: '楊淑華' }]]), ['楊']);
  eq(r3.roles.map(r => r.id), ['兄', '楊淑華'], 'A：撤銷自動補進的同名角色，改成別名（不會變成兩個角色）');
  eq(T.applyRoleVerdicts(base, new Map(), []).roles, base, '沒有判斷：維持原狀');
  // 角色總數上限 120：超過的 R 不再補進
  const many = Array.from({ length: 119 }, (_, i) => ({ id: '角' + i, name: '角' + i, aliases: [] }));
  const rr = T.applyRoleVerdicts(many, new Map([['甲', { k: 'R' }], ['乙', { k: 'R' }], ['丙', { k: 'R' }]]), []);
  eq([rr.roles.length, rr.stats.role], [120, 1], '角色總數上限 120：只補進第一個，其餘略過');
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
  // 網址當成 H：擋掉；沒有台詞的場次併回相鄰場次
  {
    const en = [{ id: 'Madison', name: 'Madison', aliases: [] }, { id: 'Alexandre', name: 'Alexandre', aliases: [] }];
    const ls2 = [L(1, 'This text is free.'), L(2, 'https://comediatheque.net'), L(3, 'Madison (yelling) – No!'), L(4, 'Alexandre – Hands up!')];
    const r5 = T.assemble(ls2, lab([1, 'D'], [2, 'H'], [3, 'S', 'Madison'], [4, 'S', 'Alexandre']), en);
    eq(r5.scenes.length, 1, '網址行不是場次標題，不會切出場次');
    eq(r5.scenes[0].lines[1], { x: 'https://comediatheque.net', }, '被擋掉的 H 當雜訊保留');
    eq(T.assemble([L(1, '© 2023 某某'), L(2, '偉：甲')], lab([1, 'H'], [2, 'S', '偉']), roles).scenes.length, 1, '版權行不是標題');
    eq(T.assemble([L(1, 'x'.repeat(60)), L(2, '偉：甲')], lab([1, 'H'], [2, 'S', '偉']), roles).scenes.length, 1, '過長的行不是標題');
    // 封面誤標成 H、之後才是真的場次：無台詞的封面場次併入下一場
    const r6 = T.assemble([L(1, '封面'), L(2, '作者資訊'), L(3, '第一場　求神'), L(4, '偉：甲'), L(5, '第二場　暢談'), L(6, '朗：乙')], lab([1, 'H'], [2, 'D'], [3, 'H'], [4, 'S', '偉'], [5, 'H'], [6, 'S', '朗']), roles);
    eq(r6.scenes.map(s => s.no), ['第一場', '第二場'], '封面誤切出的、沒有台詞的場次併入下一場，真正的場次保留');
    ok(r6.scenes[0].lines[0].d === '作者資訊' && r6.scenes.every(s => s.lines.some(l => l.s)), '每個場次都至少有一句台詞');
  }
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


// ---- 前綴優先：偵測與覆寫 ----
{
  const L = (n, text) => ({ n, text });
  const mk = arr => arr.map((t, i) => L(i + 1, t));
  const rl = (...ids) => ids.map(id => ({ id, name: id, aliases: [], gender: 'n' }));
  // 中文冒號格式：模型漏掉的角色（媽）補上；合說「兄／妹：」逐個計數，不會變成一個叫「兄／妹」的角色
  const zh = [];
  for (let i = 0; i < 8; i++) zh.push('兄：甲' + i, '妹：乙' + i);
  for (let i = 0; i < 6; i++) zh.push('媽：丙' + i);
  zh.push('兄／妹：丁', '（燈暗）', '走到窗邊。');
  const d1 = T.detectPrefix(mk(zh), rl('兄', '妹'));
  ok(d1.on && d1.added.join() === '媽' && d1.roles.map(r => r.id).join() === '兄,妹,媽', '前綴格式：補上模型漏掉的角色');
  ok(d1.prefixLines === 23, '前綴行數（合說算一行）：' + d1.prefixLines);
  // 模型的 id 沒有依據、別名卻是行首前綴（真實 dogshouse：id「眉」、別名「妹」，文字寫「妹：」）→ 以前綴為準
  {
    const rr = [{ id: '格', name: '陳立格', aliases: ['格子'], gender: 'm' }, { id: '眉', name: '陳立眉', aliases: ['眉', '妹'], gender: 'f' }];
    const d = T.detectPrefix(mk(zh), rr);
    eq(d.roles.map(r => [r.id, r.gender]), [['格', 'm'], ['妹', 'f'], ['兄', 'n'], ['媽', 'n']], '無依據的 id 換成前綴（妹），補上沒列出的角色（兄、媽）');
    eq(d.roles[1].aliases, ['眉'], '舊 id 降為別名');
    // 全名與簡稱的關係（id「偉」、前綴「葉志偉」）是正常的，不動
    const zz = []; for (let i = 0; i < 12; i++) zz.push('葉志偉：甲' + i, '朗：乙' + i);
    eq(T.detectPrefix(mk(zz), [{ id: '偉', name: '葉志偉', aliases: [] }, { id: '朗', name: '朗', aliases: [] }]).roles.map(r => r.id), ['偉', '朗'], '全名／簡稱：id 不動');
  }
  // 簡稱：行首寫「楊：」、模型列的是全名「楊淑華」→ 當別名，不新增第二個角色；有歧義（兩個角色都含這個字）才新增
  {
    const zy = []; for (let i = 0; i < 12; i++) zy.push('楊：甲' + i, '良：乙' + i, '張：丙' + i);
    const d = T.detectPrefix(mk(zy), [{ id: '淑華', name: '楊淑華', aliases: [] }, { id: '良', name: '王良', aliases: [] }, { id: '美華', name: '張美華', aliases: [] }, { id: '太', name: '張太', aliases: [] }]);
    eq([d.added, d.roles[0].aliases], [['張'], ['楊']], '「楊」只屬於楊淑華 → 別名；「張」同時屬於張美華與張太 → 有歧義，新增角色');
    eq(T.splitSpeakerPrefix('楊：你好', T.buildSurfaceMap(d.roles)).ids, ['淑華'], '行首「楊：」對回角色「淑華」');
  }
  // 前綴風格：台詞用冒號、人物表用破折號（「王家輝 – 王良的大姪兒，男，10歲」是簡介，不是台詞）→ 只認冒號
  {
    const cast = ['人物表', '王家輝 – 王良的大姪兒，男，10歲', '王家怡 – 王良的大姪女，8歲', '王良 – 劇中的亞伯，男，40歲'];
    const dlg = []; for (let i = 0; i < 12; i++) dlg.push('輝：第' + i + '句', '良：回應' + i, '怡：插話' + i);
    const ls = mk(cast.concat(dlg));
    const rs = [{ id: '輝', name: '王家輝', aliases: [] }, { id: '良', name: '王良', aliases: [] }, { id: '怡', name: '王家怡', aliases: [] }];
    const d = T.detectPrefix(ls, rs);
    eq([d.on, d.sep], [true, 'colon'], '冒號占絕大多數 → 前綴風格 colon');
    const lab = new Map(ls.map(l => [l.n, { label: /^[輝良怡]：/.test(l.text) ? 'S' : 'D', role: /^輝/.test(l.text) ? '輝' : /^良/.test(l.text) ? '良' : '怡' }]));
    for (const n of [2, 3, 4]) lab.set(n, { label: 'S', role: '輝' });      // 模型把人物表的簡介行誤標成台詞
    const st = T.applyPrefix(ls, lab, d.roles, d.sep);
    eq([2, 3, 4].map(n => lab.get(n).label), ['D', 'D', 'D'], '人物表的「名字 – 簡介」不被當成台詞（模型誤標的改用規則：指示）');
    eq(st.demoted, 3, '降級 3 行');
    // 不分風格（sep 未指定）時，簡介行會被當成前綴——這正是要避免的
    const lab2 = new Map([[2, { label: 'S', role: '輝' }]]);
    eq(T.applyPrefix(mk(['x', '王家輝 – 王良的大姪兒，男，10歲']), lab2, d.roles).forced + T.applyPrefix(mk(['x', '王家輝 – 王良的大姪兒，男，10歲']), new Map(), d.roles).forced, 1, '（對照）不指定風格時簡介行會被強制標成台詞');
    // 人物表「角色名／演員／演員」：前綴格式下，單獨成行的角色名不會讓下一行（演員名）變成台詞
    const tbl = mk(['兄', 'Matthew', 'John', '妹', 'Iris', 'Vivian'].concat(dlg));
    const labT = new Map(tbl.map(l => [l.n, { label: /^[輝良怡]：/.test(l.text) ? 'S' : 'N', role: /^輝/.test(l.text) ? '輝' : /^良/.test(l.text) ? '良' : '怡' }]));
    for (const n of [2, 3, 5, 6]) labT.set(n, { label: 'S', role: '輝' });      // 模型把演員名誤標成台詞
    T.applyPrefix(tbl, labT, d.roles.concat([{ id: '兄', name: '兄', aliases: [] }, { id: '妹', name: '妹', aliases: [] }]), 'colon');
    eq([2, 3, 5, 6].map(n => labT.get(n).label), ['D', 'D', 'D', 'D'], '演員名不會因為上一行是角色名就被規則標成台詞');
    // 全是破折號的劇本（window.pdf 那種）：風格 dash，行為不變
    const en = []; for (let i = 0; i < 12; i++) en.push('Madison – line ' + i, 'Alexandre – reply ' + i);
    eq(T.detectPrefix(mk(en), rl('Madison', 'Alexandre')).sep, 'dash', '全是破折號 → dash');
    // 兩種風格都大量使用 → mixed，兩種都認
    const mx = []; for (let i = 0; i < 10; i++) mx.push('兄：甲' + i, '妹 – 乙' + i);
    eq(T.detectPrefix(mk(mx), rl('兄', '妹')).sep, 'mixed', '兩種風格各占一半 → mixed');
  }
  // 太少見的稱呼（3 次）不補成角色
  eq(T.detectPrefix(mk(zh.filter(x => !/^媽：丙[345]/.test(x))), rl('兄', '妹')).added, [], '只出現 3 次的稱呼不補成角色');
  // 英文破折號格式：偶然出現的「Well – 」不當角色；網址不當角色
  const en = [];
  for (let i = 0; i < 12; i++) en.push('Madison – line ' + i, 'Alexandre – reply ' + i);
  en.push('Well – maybe.', 'Well – no.', 'Well – yes.', 'https://example.org/a', 'https://example.org/b', 'https://example.org/c');
  const d2 = T.detectPrefix(mk(en), rl('Madison'));
  ok(d2.on && d2.added.join() === 'Alexandre', '英文破折號：補 Alexandre，不補 Well／https：' + JSON.stringify(d2.added));
  // 不是前綴格式 → 關閉，一切照舊
  const own = []; for (let i = 0; i < 30; i++) own.push(i % 2 ? '兄' : '妹', '這是第' + i + '句，沒有冒號'); 
  eq(T.detectPrefix(mk(own), rl('兄', '妹')).on, false, '角色名獨立成行的劇本：不啟用');
  const few = ['兄：甲', '妹：乙', '兄：丙']; for (let i = 0; i < 40; i++) few.push('第' + i + '行描述文字');
  eq(T.detectPrefix(mk(few), rl('兄', '妹')).on, false, '前綴行太少（<10 行或 <25%）：不啟用');
  const time = []; for (let i = 0; i < 20; i++) time.push('12:30 見', '第' + i + '段敘述文字');
  time.push('他說：好', '他說：不', '他說：嗯', '他說：行');
  eq(T.detectPrefix(mk(time), rl('兄')).on, false, '時間、敘述文字裡偶爾的「他說：」不啟用');

  // applyPrefix：有前綴 → 強制台詞；沒前綴卻標成台詞 → 規則標並待校正；夾著別人前綴 → 待校正
  const lines = mk(['兄：你好', '妹：（笑）喂。', '意識到妹後停止動作。', '兄：我只是忍不住。妹：人就要有人樣。', '兄／妹：（同時）好餓', '（燈暗）']);
  const roles2 = rl('兄', '妹');
  const labels = new Map([[1, { label: 'C', role: '' }], [2, { label: 'N', role: '' }], [3, { label: 'S', role: '兄' }], [4, { label: 'C', role: '' }], [5, { label: 'S', role: '妹' }], [6, { label: 'D', role: '' }]]);
  const st = T.applyPrefix(lines, labels, roles2);
  eq([1, 2, 5].map(n => labels.get(n)), [{ label: 'S', role: '兄' }, { label: 'S', role: '妹' }, { label: 'S', role: '兄/妹' }], '前綴行強制為台詞，角色以前綴為準（含合說）');
  eq(labels.get(3), { label: 'D', role: '', rv: true }, '沒有前綴卻被標成台詞的行：改用規則標，並標為待校正');
  eq(labels.get(4), { label: 'S', role: '兄', rv: true }, '前綴被標成續行 → 強制台詞；夾著別人前綴 → 待校正');
  eq(labels.get(6), { label: 'D', role: '' }, '正常的指示不動');
  eq(st, { forced: 4, demoted: 1, flagged: 1 }, '統計：' + JSON.stringify(st));
  // 模型標對的行完全不動（連物件都不換）
  const good = new Map([[1, { label: 'S', role: '兄' }]]); const ref = good.get(1);
  T.applyPrefix(mk(['兄：你好']), good, roles2);
  ok(good.get(1) === ref, '標對的行不動');
  // adoptRoles：模型標了清單外的角色，行首真的寫著才採納
  {
    const textOf = new Map([[1, '母：我回來了。'], [2, '路人：你好'], [3, '兄：嗨']]);
    const rs = rl('兄', '妹'), compact = [];
    const pp = T.parseLabels('1|S|母\n2|S|甲乙\n3|S|兄');
    T.adoptRoles(pp, textOf, rs, compact);
    eq(rs.map(r => r.id), ['兄', '妹', '母'], '行首寫著「母：」→ 採納；模型編的「甲乙」（行首是「路人：」）不採納');
    eq(compact, [{ id: '母', name: '母', aliases: [] }], '同步更新送給後續塊的角色清單');
    eq(T.checkLabels(T.parseLabels('1|S|母\n2|S|甲乙\n3|S|兄'), [1, 2, 3, 4], rs).soft.map(x => x.n).sort(), [2, 4], 'checkLabels：角色不明與缺漏是 soft，其餘行不受影響');
    eq(T.checkLabels(T.parseLabels('1|S|兄\n1|C|\n2|X|'), [1, 2], rs).soft.map(x => x.n).sort(), [1, 2], 'checkLabels：重複與標籤不在集合內也只是那一行有問題（soft），不再讓整塊作廢');
    eq(T.checkLabels(T.parseLabels('1|S|兄（青年）\n2|S|妹（低聲） / 兄\n3|S|兄'), [1, 2, 3], rs).soft, [], '角色欄連括號註記一起抄進來（「兄（青年）」）：去掉註記後比對');
    const ann = T.parseLabels('1|S|兄（青年）\n2|S|妹（低聲） / 兄'); T.checkLabels(ann, [1, 2], rs);
    eq([ann.map.get(1).role, ann.map.get(2).role], ['兄', '妹/兄'], '註記去掉後角色正規化為 id');
    const ex = T.checkLabels(T.parseLabels('1|S|兄\n2|C|\n3|D|\n9|S|兄'), [1, 2, 3], rs);
    eq([ex.soft.length, ex.extra], [0, ['多出 L9']], 'checkLabels：多出不在這一塊的行號只記為 extra，不算錯');
  }
  // tidyRoles：沒有台詞的角色不留；名稱在原文出現過就保留
  {
    const lines2 = mk(['兄：你好', '妹：嗨', '葉志偉是他的名字']);
    const lab = new Map([[1, { label: 'S', role: '兄' }], [2, { label: 'S', role: '妹' }], [3, { label: 'D', role: '' }]]);
    const t = T.tidyRoles(lines2, lab, [{ id: '兄', name: '葉志偉', aliases: ['志偉', '大哥'] }, { id: '妹', name: '陳立妹', aliases: [] }, { id: '麻', name: '麻', aliases: [] }]);
    eq(t.roles.map(r => [r.id, r.name, r.aliases]), [['兄', '葉志偉', ['志偉']], ['妹', '妹', []]], '原文出現過的名稱／別名保留，沒出現過的丟掉；沒有台詞的角色不留');
    // 單字名稱：本身是行首前綴才算有依據
    const t2 = T.tidyRoles(mk(['妹：嗨', '兄：好']), new Map([[1, { label: 'S', role: '眉' }], [2, { label: 'S', role: '兄' }]]), [{ id: '眉', name: '妹', aliases: ['妹'] }, { id: '兄', name: '格', aliases: [] }]);
    eq(t2.roles.map(r => [r.id, r.name, r.aliases]), [['眉', '妹', ['妹']], ['兄', '兄', []]], '單字名稱：是行首前綴（妹）就保留，否則（格）改回 id');
    eq([t.dropped, t.renamed], [['麻'], ['妹']], '回報移除與改名');
  }
  // 行首有稱呼但不在角色清單（次要角色「護士：」），模型卻填了別的角色 → 標待校正（角色無從核對）
  {
    const lab3 = new Map([[1, { label: 'S', role: '兄' }]]);
    const st3 = T.applyPrefix(mk(['護士：請借過']), lab3, roles2);
    eq([lab3.get(1), st3.flagged], [{ label: 'S', role: '兄', rv: true }, 1], '行首稱呼不在清單：保留模型的標記但標待校正');
  }
  // 「（指示）角色名：」常見寫法不算夾帶前綴，也不被強制改標
  const lab2 = new Map([[1, { label: 'D', role: '' }]]);
  eq(T.applyPrefix(mk(['（二人靜默） 兄： 好']), lab2, roles2), { forced: 0, demoted: 0, flagged: 0 }, '指示在前、角色名在後：交給模型，不強制');
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
  // 重試：回應壞掉（漏掉一半，超過可容忍的比例）時重試一次，多數通過；兩次都壞的塊用本機規則後備並標待校正
  {
    const { r, mock, lines, v } = await run('wrapped', { failRate: 0.45, failKind: 3, seed: 3 }, { concurrency: 1 });
    ok(r.stats.retried > 0, '有重試');
    ok(mock.calls.label > r.stats.chunks, '重試多打了請求：' + mock.calls.label + ' > ' + r.stats.chunks);
    ok(r.stats.failedChunks === r.stats.failedChunkNos.length, '失敗塊號清單');
    if (r.stats.failedChunks) ok(r.stats.review > 0, '失敗塊的行被標為待校正');
    const s = scoreLabels(lines, r.labels, v.gold);
    ok(s.acc > 0.95, '後備後行級準確率仍高：' + s.acc.toFixed(4));
  }
  // 全部壞掉（每塊都漏掉一半，超過可容忍的比例）：整份都走後備，仍產出劇本，不中止
  {
    const { r, lines, v } = await run('colon-fw', { failRate: 1, failKind: 3, seed: 5 });
    eq(r.stats.failedChunks, r.stats.chunks, '全部失敗塊（每塊都漏掉一半）');
    ok(r.scenes.length === 22 && scoreLabels(lines, r.labels, v.gold).acc > 0.95, '後備仍組出 22 場，行級 >95%');
    const surf = T.buildSurfaceMap(r.roles);
    ok(lines.every(l => { const x = r.labels.get(l.n); return x.rv || (x.label === 'S' && T.splitSpeakerPrefix(l.text, surf)); }), '每一行都帶待校正旗標；唯一的例外是行首前綴明確的台詞（規則確定，不必人工看）');
    ok(r.stats.review > 200 && r.stats.review < lines.length - 900, '其餘不確定的行全標待校正：' + r.stats.review);
  }
  // 只有少數行有問題（漏行／角色不在清單）：其餘行照用模型的標記，只有問題行走後備並標待校正，不整塊作廢
  for (const [kind, what] of [['drop', '漏行'], ['role', '角色不在清單']]) {
    const v = vs['colon-fw'], lines = T.buildLines({ text: v.text }).lines, mock = makeMock(lines, v.gold, {});
    const wrap = async p => { const out = await mock.callApi(p); if (p.mode === 'format') return out;
      return kind === 'role' ? out.replace(/\|S\|[^\n|]+/, '|S|不存在的角色') : out.replace(/\n\d+\|[A-Z]\|[^\n]*\n\d+\|[A-Z]\|[^\n]*\n\d+\|[A-Z]\|[^\n]*(?=\n)/, ''); };   // 每次回應少 3 行
    const r = await T.runPipeline({ lines, callApi: wrap, concurrency: 1 });
    eq(r.stats.failedChunks, 0, what + '：沒有整塊失敗');
    ok(r.stats.partialLines > 0 && r.stats.partialLines <= 5 * 3, what + '：只有少數行走後備：' + r.stats.partialLines);
    ok(r.stats.review <= r.stats.partialLines + 2 && r.stats.review < 60, what + '：待校正的只會是走後備的行（前綴明確的台詞由規則確認，不必標）：' + r.stats.review + ' ≤ ' + r.stats.partialLines);
    ok(scoreLabels(lines, r.labels, v.gold).acc > 0.99 && r.scenes.length === 22, what + '：行級準確率仍 >99%、22 場');
    ok(mock.calls.label === r.stats.chunks, what + '：問題很少就不重試（' + mock.calls.label + ' 次請求）');
  }
  // 模型繼續往後多編了幾百列：多出的列忽略，送出的行照用，不重試、不失敗
  {
    const v = vs['colon-fw'], lines = T.buildLines({ text: v.text }).lines, mock = makeMock(lines, v.gold, {});
    const wrap = async p => { const out = await mock.callApi(p); if (p.mode === 'format') return out; const last = Math.max(...p.lines.map(x => x[0])); return out.replace(/\n```\s*$/, '') + '\n' + Array.from({ length: 400 }, (_, i) => (last + 1 + i) + '|S|偉').join('\n') + '\n```'; };
    const r = await T.runPipeline({ lines, callApi: wrap, concurrency: 1 });
    ok(r.stats.failedChunks === 0 && r.stats.partialLines === 0 && r.stats.retried === 0, '多回 400 列：整塊照用（失敗 ' + r.stats.failedChunks + '、重試 ' + r.stats.retried + '）');
    ok(scoreLabels(lines, r.labels, v.gold).acc === 1, '標記與沒有多列時完全一致');
  }
  // 問題行太多（>25%）→ 重試一次、仍太多整塊失敗；不到 25% → 直接採用，不重試（溫度 0 時重試通常是同一個答案，慢的供應商一次要好幾分鐘）
  {
    const v = vs['colon-fw'], lines = T.buildLines({ text: v.text }).lines, mock = makeMock(lines, v.gold, {});
    let calls = 0;
    const drop = frac => async p => { const out = await mock.callApi(p); if (p.mode === 'format') return out; calls++; const rows = out.split('\n'); return rows.filter((x, i) => i < 1 || i % Math.max(1, Math.round(1 / frac)) !== 0 || !/^\d/.test(x)).join('\n'); };
    calls = 0; const r1 = await T.runPipeline({ lines, callApi: drop(0.5), concurrency: 1 });
    ok(r1.stats.failedChunks === r1.stats.chunks && calls === 2 * r1.stats.chunks, '漏掉一半的行：每塊重試一次後整塊失敗（請求 ' + calls + ' 次）');
    calls = 0; const r2 = await T.runPipeline({ lines, callApi: drop(0.1), concurrency: 1 });
    ok(r2.stats.failedChunks === 0 && r2.stats.partialLines > 0 && calls === r2.stats.chunks, '漏掉約 10% 的行：直接採用、不重試（請求 ' + calls + ' 次 = ' + r2.stats.chunks + ' 塊）');
  }
  // 重複列、標籤怪異的列：只有那幾行走後備，不整塊作廢
  {
    const v = vs['colon-fw'], lines = T.buildLines({ text: v.text }).lines, mock = makeMock(lines, v.gold, {});
    const wrap = async p => { const out = await mock.callApi(p); return p.mode === 'format' ? out : out.replace(/\n```\s*$/, '') + '\n' + out.split('\n').find(x => /^\d+\|/.test(x)).replace(/\|[A-Z]\|.*/, '|X|') + '\n```'; };      // 加一列重複行號、標籤是 X
    const r = await T.runPipeline({ lines, callApi: wrap, concurrency: 1 });
    ok(r.stats.failedChunks === 0 && r.stats.retried === 0, '重複列＋怪標籤：沒有整塊失敗、沒有重試（失敗 ' + r.stats.failedChunks + '、重試 ' + r.stats.retried + '）');
    ok(scoreLabels(lines, r.labels, v.gold).acc > 0.99, '行級準確率仍 >99%');
  }
  // 第一段壞掉兩次：行首有前綴的劇本改用前綴找出角色表、繼續；沒有前綴的劇本才丟錯。429 → 立即中止（fatal）
  {
    let threw = null;
    try { await run('centered', { alwaysFail: true }); } catch (e) { threw = e; }
    ok(threw && /無法辨識劇本格式/.test(threw.message), '第一段兩次都壞、也沒有行首前綴可用：丟出明確錯誤');
    {
      const v1 = vs['colon-fw'], lines1 = T.buildLines({ text: v1.text }).lines, mock1 = makeMock(lines1, v1.gold, {});
      const noFormat = async p => { if (p.mode === 'format') return '{not json'; return mock1.callApi(p); };
      const r1 = await T.runPipeline({ lines: lines1, callApi: noFormat, concurrency: 1 });
      ok(['K', '偉', '朗', '玲'].every(id => r1.roles.some(x => x.id === id)), '第一段壞掉：角色表改由行首前綴找出，四個主要角色都在：' + r1.roles.map(x => x.id));      // 另外會多出「四人」「男」這類合說稱呼（行首真的這樣寫）
      const acc1 = scoreLabels(lines1, r1.labels, v1.gold).acc;
      ok(r1.stats.failedChunks === 0 && acc1 > 0.97 && r1.scenes.length === 22, '第一段壞掉仍完整解析：22 場、行級 >97%（' + (acc1 * 100).toFixed(2) + '%）');
    }
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

  // 前綴優先（本次真實檔案暴露的問題）：模型把「兄：…」標成續行／雜訊、把舞台指示標成台詞、編出錯的角色名與 speaker_pos。
  // 劇本內容為自編的合成文字。
  {
    const gold = [['第一場　廚房', 'H', ''], ['（燈亮。兄蹲在冰箱前面翻東西。）', 'D', '']];
    for (let i = 0; i < 6; i++) {
      gold.push(['兄：第' + i + '個問題是冰箱裡什麼都沒有', 'S', '兄']);
      gold.push(['妹：昨天不是才買過菜嗎', 'S', '妹']);
    }
    gold.push(['兄：買是買了，可是你把雞蛋都', 'S', '兄'], ['吃光了。', 'C', ''], ['妹站起來，走到流理台前面看了一眼。', 'D', ''],
      ['兄：兩顆？盒子是空的。妹：那是你自己吃的。', 'S', '兄'], ['兄／妹：（同時）好餓。', 'S', '兄/妹']);
    for (let i = 0; i < 4; i++) gold.push(['妹：第' + i + '次了', 'S', '妹'], ['兄：我知道', 'S', '兄']);
    gold.push(['母：我回來了。', 'S', '母'], ['母：飯煮好了。', 'S', '母']);       // 模型第一段沒列出的次要角色（只出現 2 次）
    const lines = T.buildLines({ text: gold.map(g => g[0]).join('\n') }).lines;
    eq(lines.length, gold.length, '合成劇本逐行對應');
    let k = 0;
    const badModel = async p => {
      if (p.mode === 'format') return JSON.stringify({ roles: [{ id: '兄', name: '格', aliases: ['立朗'] }, { id: '妹', name: '眉' }, { id: '麻', name: '拔' }], rules: { speaker_pos: 'own_line' } });
      sent.push(p.rules.speaker_pos);
      return p.lines.map(([n, text]) => {
        if (/^[兄妹]／?[兄妹]?：/.test(text)) { k++; return k % 3 === 0 ? n + '|C|' : k % 3 === 1 ? n + '|N|' : n + '|S|妹'; }   // 前綴行被標成續行／雜訊／錯的角色
        if (/^（燈亮|^妹站起來/.test(text)) return n + '|S|兄';                                                                  // 舞台指示被標成台詞
        const g = gold[n - 1]; return n + '|' + g[1] + '|' + g[2];
      }).join('\n');
    };
    const sent = [];
    const r = await T.runPipeline({ lines, callApi: badModel, concurrency: 1 });
    const bad = lines.filter((l, i) => { const g = gold[i], p = r.labels.get(l.n); return g[1] === 'S' ? !(p.label === 'S' && p.role === g[2]) : p.label !== g[1]; });
    eq(bad.map(l => l.text), [], '壞模型 + 前綴優先：每一行的標記都回到正確（台詞角色、指示、續行、標題）');
    ok(r.stats.prefix && r.stats.prefix.forced > 10 && r.stats.prefix.demoted === 2 && r.stats.prefix.flagged === 1, '覆寫統計：' + JSON.stringify(r.stats.prefix));
    ok(sent.length > 0 && sent.every(x => /^prefix/.test(x)), '送給標記步驟的 speaker_pos 已改為 prefix（不沿用模型判錯的 own_line）：' + sent[0]);
    const sl = r.scenes.flatMap(s => s.lines).filter(l => l.s !== undefined);
    ok(sl.length === gold.filter(g => g[1] === 'S').length, '台詞數 = 前綴行數：' + sl.length);
    ok(!sl.some(l => /[兄妹]：/.test(l.t) && l.rv !== true), '沒有夾帶別人前綴卻未標待校正的台詞');
    eq(r.stats.review, 3, '待校正只有：2 行被降級的指示 + 1 行夾帶前綴的台詞（實際 ' + r.stats.review + '）');
    eq(r.stats.failedChunks + r.stats.partialLines, 0, '清單外的次要角色「母」行首真的寫著 → 採納進角色清單，不讓整塊失敗');
    eq(r.roles.map(x => [x.id, x.name]), [['兄', '兄'], ['妹', '妹'], ['母', '母']], '角色清單：沒有任何台詞的假角色（麻）不留；原文裡找不到的名稱（格、眉）改回 id');
    eq([r.stats.prefix.dropped, r.stats.prefix.renamed], [['麻'], ['兄', '妹']], '統計：移除與改名的角色');
  }
  // 英文破折號：模型漏掉 Alexandre → 由前綴補上；壞標記同樣被修正
  {
    const gold = [];
    for (let i = 0; i < 8; i++) gold.push(['Madison – line number ' + i + ' goes here.', 'S', 'Madison'], ['Alexandre – reply number ' + i + ' goes here.', 'S', 'Alexandre']);
    gold.push(['Madison – Yes.', 'S', 'Madison'], ['She takes a few steps into the room.', 'D', ''], ['Alexandre – Well – I do not know.', 'S', 'Alexandre']);
    const lines = T.buildLines({ text: gold.map(g => g[0]).join('\n') }).lines;
    const model = async p => p.mode === 'format'
      ? JSON.stringify({ roles: [{ id: 'Madison', name: 'Madison', aliases: [] }], rules: { speaker_pos: 'own_line' } })
      : p.lines.map(([n, text]) => n + '|' + (/^Alexandre/.test(text) ? 'C|' : /^She/.test(text) ? 'S|Madison' : 'S|Madison')).join('\n');
    const r = await T.runPipeline({ lines, callApi: model, concurrency: 1 });
    eq(r.roles.map(x => x.id), ['Madison', 'Alexandre'], '漏掉的角色由前綴補上');
    const ok1 = lines.every((l, i) => { const p = r.labels.get(l.n), g = gold[i]; return g[1] === 'S' ? p.label === 'S' && p.role === g[2] : p.label === g[1]; });
    ok(ok1, '英文：壞模型標記全部被前綴規則修正');
  }
  // 標記對的模型在前綴劇本上不受影響：不強制、不降級、不新增待校正
  {
    const { r } = await run('colon-fw', {});
    ok(r.stats.prefix && r.stats.prefix.forced === 0 && r.stats.prefix.demoted === 0 && r.stats.prefix.flagged === 0, '完美模型：前綴覆寫一行都不動：' + JSON.stringify(r.stats.prefix));
    eq((await run('centered', {})).r.stats.prefix, null, '角色名獨立成行的劇本不啟用前綴模式');
  }
  // 上游暫時忙碌（retryable）：退避重試，不把前面已完成的塊作廢；重試用完才中止；非 retryable 的 fatal 仍立即中止
  {
    const v = vs['colon-fw'], lines = T.buildLines({ text: v.text }).lines, mock = makeMock(lines, v.gold, {});
    const busy = () => Object.assign(new Error('busy'), { fatal: true, retryable: true, status: 503 });
    let n = 0; const waits = [];
    const flaky = async p => { n++; if (n % 3 === 0 && n < 14) throw busy(); return mock.callApi(p); };       // 每第 3 次呼叫暫時失敗
    const r = await T.runPipeline({ lines, callApi: flaky, concurrency: 1, retryDelays: [0, 0, 0], onProgress: p => { if (p.stage === 'retry') waits.push(p.attempt); } });
    ok(r.stats.failedChunks === 0 && scoreLabels(lines, r.labels, v.gold).acc === 1 && waits.length >= 2, '暫時失敗後重試成功，結果與沒有失敗時完全一致（重試 ' + waits.length + ' 次）');
    let calls = 0, threw = null;
    try { await T.runPipeline({ lines, callApi: async () => { calls++; throw busy(); }, concurrency: 1, retryDelays: [0, 0, 0] }); } catch (e) { threw = e; }
    ok(threw && threw.fatal && calls === 4, '一直失敗：試 1 次＋重試 3 次後中止（' + calls + ' 次呼叫）');
    calls = 0; threw = null;
    try { await T.runPipeline({ lines, callApi: async () => { calls++; throw Object.assign(new Error('quota'), { fatal: true, status: 429 }); }, concurrency: 1, retryDelays: [0, 0, 0] }); } catch (e) { threw = e; }
    ok(threw && threw.status === 429 && calls === 1, '本站每日上限（非 retryable）：不重試，立即中止');
  }

  // 候選稱呼分類（真實 docx 暴露的問題）：次要角色（護士）、簡稱（楊＝楊淑華）、不是角色的標記（SD Cue）。
  // 模型第一段只列了主要角色；標記步驟的模型只能用清單內的角色，清單外的行行首稱呼它一律標成雜訊。
  {
    const gold = [];
    for (let i = 0; i < 12; i++) gold.push('兄：第' + i + '句台詞內容', '妹：第' + i + '句回應內容');
    gold.push('護士：請借過一下', '護士：讓一讓好嗎', '護士：小心地上', 'SD Cue：煙花聲效', 'SD Cue：轉場音樂', '楊：你好呀今天', '楊：再見啦明天', '楊：多謝你呀', '楊：好的沒問題');
    const lines = T.buildLines({ text: gold.join('\n') }).lines;
    const mk = opts => {
      const seen = { roles: 0, labelRoles: null };
      const callApi = async p => {
        if (p.mode === 'format') return JSON.stringify({ roles: [{ id: '兄', name: '兄' }, { id: '妹', name: '妹' }, { id: '楊淑華', name: '楊淑華' }], rules: { speaker_pos: 'prefix' } });
        if (p.mode === 'roles') { seen.roles++; if (opts.rolesFail) throw opts.rolesFail; return opts.rolesAnswer || '護士|R|\nSD Cue|N|\n楊|A|楊淑華'; }
        seen.labelRoles = p.roles.map(r => r.id);
        return p.lines.map(([n, text]) => {
          const m = text.match(/^([^：]+)：/); const who = m && m[1];
          if (who === '兄' || who === '妹') return n + '|S|' + who;
          if (who === '楊') return n + '|S|' + (p.roles.some(r => r.id === '楊淑華') ? '楊淑華' : 'x');
          if (who === '護士') return p.roles.some(r => r.id === '護士') ? n + '|S|護士' : n + '|N|';
          return n + '|N|';
        }).join('\n');
      };
      return { callApi, seen };
    };
    const run1 = async opts => { const m = mk(opts); const r = await T.runPipeline({ lines, callApi: m.callApi, concurrency: 1, retryDelays: [0, 0, 0] }); return { r, m }; };
    const rolesOf = r => r.scenes.flatMap(s => s.lines).filter(l => l.s !== undefined).map(l => l.s);
    const cnt = a => a.reduce((o, x) => (o[x] = (o[x] || 0) + 1, o), {});
    // 有分類：護士是角色、SD Cue 不是、楊併入楊淑華
    const { r, m } = await run1({});
    eq(m.seen.roles, 1, '候選稱呼分類只多一次請求');
    eq(cnt(rolesOf(r)), { 兄: 12, 妹: 12, 護士: 3, 楊淑華: 4 }, '護士 3 句成為台詞、楊 4 句併入楊淑華、SD Cue 不是台詞（沒有任何一句消失）');
    eq(r.roles.map(x => x.id).sort(), ['兄', '妹', '楊淑華', '護士'].sort(), '角色清單：護士補進、楊沒有變成第二個角色、SD Cue 不是角色');
    eq([r.stats.roleClassify.candidates, r.stats.roleClassify.answered, r.stats.roleClassify.role, r.stats.roleClassify.alias, r.stats.roleClassify.noise], [3, 3, 1, 1, 1], '統計：候選 3 個、回答 3 個；護士（只出現 3 次，低於 ≥5 次的自動門檻）由模型判斷後補進角色、楊併入別名、SD Cue 不是角色');
    ok(m.seen.labelRoles.includes('護士') && !m.seen.labelRoles.includes('SD Cue'), '送去標記的角色清單包含護士、不含 SD Cue');
    // 沒有這一步（Worker 還沒更新→400）：照舊，不會讓解析失敗；護士只出現 3 次、低於門檻，仍被標成雜訊
    const { r: r0 } = await run1({ rolesFail: Object.assign(new Error('bad_mode'), { fatal: true, status: 400 }) });
    ok(r0.stats.failedChunks === 0 && r0.stats.roleClassify.answered === 0 && !rolesOf(r0).includes('護士'), '分類請求被拒（400）：略過這一步，解析照常完成');
    // 模型回不出可用的答案：略過；一般錯誤（非 fatal）：重試一次後略過
    const { r: r1 } = await run1({ rolesAnswer: '我不確定' });
    ok(r1.stats.roleClassify.answered === 0 && r1.stats.failedChunks === 0, '回應不是格式：略過');
    const { r: r2, m: m2 } = await run1({ rolesFail: new Error('boom') });
    ok(r2.stats.roleClassify.answered === 0 && m2.seen.roles === 2, '一般錯誤：試 2 次後略過（' + m2.seen.roles + ' 次）');
    // 本站每日上限（429）仍然立即中止
    let threw = null; try { await run1({ rolesFail: Object.assign(new Error('quota'), { fatal: true, status: 429 }) }); } catch (e) { threw = e; }
    ok(threw && threw.status === 429, '分類請求遇到本站每日上限（429）：中止');
    // 完美模型的前綴劇本沒有候選 → 完全不多一次請求
    const v = vs['colon-fw'], ls = T.buildLines({ text: v.text }).lines, mock = makeMock(ls, v.gold, {});
    await T.runPipeline({ lines: ls, callApi: mock.callApi });
    eq(mock.calls.roles, 0, '沒有候選稱呼的劇本：不多一次分類請求');
  }

  // 大型群戲（70 個說話者）：整份角色清單不受 Worker 單次 60 個的限制；每個標記請求只送這一塊用得到的角色（≤60）
  {
    const gold = [];
    for (let i = 0; i < 40; i++) gold.push('主甲：第' + i + '句', '主乙：第' + i + '句回應');
    for (let r = 0; r < 70; r++) { gold.push('配角' + r + '：你好呀今天', '配角' + r + '：再見啦明天'); gold.push('主甲：中間插話' + r); }
    const lines = T.buildLines({ text: gold.join('\n') }).lines;
    const sentRoles = [];
    const callApi = async p => {
      if (p.mode === 'format') return JSON.stringify({ roles: [{ id: '主甲', name: '主甲' }, { id: '主乙', name: '主乙' }], rules: { speaker_pos: 'prefix' } });
      if (p.mode === 'roles') return p.candidates.map(c => c[0] + '|R|').join('\n');
      sentRoles.push(p.roles.length);
      const ids = new Set(p.roles.map(r => r.id));
      return p.lines.map(([n, text]) => { const w = text.split('：')[0]; return n + (ids.has(w) ? '|S|' + w : '|N|'); }).join('\n');
    };
    const r = await T.runPipeline({ lines, callApi, concurrency: 1, chunkSize: 150 });
    const sl = r.scenes.flatMap(s => s.lines).filter(l => l.s !== undefined);
    eq(sl.length, gold.length, '70 個配角、全部 ' + gold.length + ' 句台詞都保留（沒有任何一句變成雜訊）');
    ok(r.roles.length === 72, '角色清單 72 個（兩個主角＋70 個配角），不受 60 個的限制：' + r.roles.length);
    ok(sentRoles.length > 1 && sentRoles.every(n => n <= 60), '每個標記請求的角色清單都 ≤60：' + sentRoles.join(','));
    ok(Math.max(...sentRoles) < 72, '大型群戲時每塊只送用得到的角色，不是整份清單');
  }
  // 歌曲區塊：歌詞（歌手標記行、標題行、緊鄰的短行）整段收成 {song, lyrics}，不當台詞、不標待校正
  {
    const g = [];
    for (let i = 0; i < 12; i++) { g.push('甲：第' + i + '句，你今日點呀？', '乙：我好好呀，多謝你關心。'); }
    g.push('（音樂起。）', '歌曲一：出發之歌', '曲：王小明\t詞：李大文', '(合)\t出發吧出發吧，', '(甲)\t向前行向前行，', '不怕路途遠，', '齊齊向前進！', '（音樂完。）');
    for (let i = 0; i < 6; i++) { g.push('甲：唱完好開心' + i + '。', '乙：我哋再嚟過。'); }
    g.push('SD Cue：歌曲二音樂', '(乙)\t再唱一首歌，', '(甲)\t唱到天亮。', '二\t乙)\t第二節開始，', '直到永遠。');
    g.push('甲：夠啦，收工。', '乙：好呀。', '這是一段很長的舞台敘述文字，不是歌詞，因為它超過了四十個字所以不會被當作歌詞吸進去，應該保持原來的標記。');
    const lines = T.buildLines({ text: g.join('\n') }).lines;
    const callApi = async p => {
      if (p.mode === 'format') return JSON.stringify({ roles: [{ id: '甲', name: '甲' }, { id: '乙', name: '乙' }], rules: { speaker_pos: 'prefix' } });
      if (p.mode === 'roles') return p.candidates.map(c => c[0] + '|N|').join('\n');
      const ids = new Set(p.roles.map(r => r.id));
      return p.lines.map(([n, text]) => {
        const w = text.split('：')[0];
        if (ids.has(w)) return n + '|S|' + w;
        return n + (/^[（(].*[）)]$/.test(text) ? '|D|' : /[一-鿿]/.test(text) && text.length > 40 ? '|D|' : '|N|');
      }).join('\n');
    };
    const r = await T.runPipeline({ lines, callApi, concurrency: 1, chunkSize: 150 });
    const L = r.scenes.flatMap(s => s.lines), songs = L.filter(l => l.song !== undefined);
    eq(songs.length, 2, '兩首歌（模型把歌詞全標成雜訊也一樣找得到）');
    eq(songs[0], { song: '出發之歌', lyrics: ['(合)　出發吧出發吧，', '(甲)　向前行向前行，', '不怕路途遠，', '齊齊向前進！'] }, '第一首：標題取冒號後的字、歌詞保留歌手標記、作曲行不進歌詞');
    eq(songs[1].lyrics, ['(乙)　再唱一首歌，', '(甲)　唱到天亮。', '二　乙)　第二節開始，', '直到永遠。'], '第二首：沒有標題；音效提示 SD Cue 不進歌詞；段落編號開頭的歌手標記也算');
    eq(songs[1].song, '', '沒有標題就留空');
    eq(L.filter(l => l.s !== undefined).length, 12 * 2 + 6 * 2 + 2, '所有台詞行（含歌曲前後）都保留');
    ok(L.some(l => l.x === '曲：王小明\t詞：李大文'), '緊接標題的作曲行當雜訊保留，不吞掉');
    ok(L.some(l => l.x !== undefined && /^SD Cue/.test(l.x)), '音效提示行當雜訊保留');
    ok(L.some(l => l.d !== undefined && /舞台敘述/.test(l.d)), '超過 40 字的長敘述不被吸進歌詞');
    eq(r.stats.songs, 2, 'stats.songs');
    eq(r.stats.review, 0, '歌曲區塊不產生待校正行');
    ok(L.some(l => l.d === '（音樂起。）') && L.some(l => l.d === '（音樂完。）'), '整行括號的舞台指示留在原處，不被吸進歌詞');
  }
  // 沒有歌手標記、沒有標題的歌詞：前一行以音樂提示結尾，接著連續的短行；括號回聲行夾在歌詞中間也算；英文長歌詞行；演員名單與劇末標記不算
  {
    const g = [];
    for (let i = 0; i < 14; i++) g.push('甲：第' + i + '句話。', '乙：我知道呀。');
    g.push('乙：我哋一齊唱啦。（音樂再起。）', '來吧一齊唱', '讓歌聲飛翔', '（輕輕和唱）', '終必飛到天邊外', 'Jingle Bells Jingle Bells, jingle with the sleigh', 'Rachael, Kit, Tim, Moshan, Vivian, Judy, John, Billy, Brian', '全劇完');
    g.push('甲：好聽。', '（燈暗。）', '乙：收工。');
    const lines = T.buildLines({ text: g.join('\n') }).lines;
    const callApi = async p => {
      if (p.mode === 'format') return JSON.stringify({ roles: [{ id: '甲', name: '甲' }, { id: '乙', name: '乙' }], rules: { speaker_pos: 'prefix' } });
      if (p.mode === 'roles') return p.candidates.map(c => c[0] + '|N|').join('\n');
      const ids = new Set(p.roles.map(r => r.id));
      let prev = 'N';
      return p.lines.map(([n, text]) => { const w = text.split('：')[0]; const lab = ids.has(w) ? 'S|' + w : (prev === 'S' || prev === 'C') && !/^[（(]/.test(text) ? 'C|' : 'N|'; prev = lab[0]; return n + '|' + lab; }).join('\n');
    };
    const r = await T.runPipeline({ lines, callApi, concurrency: 1, chunkSize: 150 });
    const L = r.scenes.flatMap(s => s.lines), songs = L.filter(l => l.song !== undefined);
    eq(songs.length, 1, '音樂提示後的歌詞收成一首');
    eq(songs[0].lyrics, ['來吧一齊唱', '讓歌聲飛翔', '（輕輕和唱）', '終必飛到天邊外', 'Jingle Bells Jingle Bells, jingle with the sleigh'], '括號回聲行夾在歌詞中間算歌詞；「終必…」不是劇末標記；英文長歌詞行（含空白超過 40 字元）算；演員名單與「全劇完」不算');
    ok(L.some(l => l.s === '乙' && /我哋一齊唱啦/.test(l.t)), '前一行的台詞仍在，歌詞沒有被併進它的續行');
    ok(!L.some(l => l.s !== undefined && /來吧一齊唱|Jingle/.test(l.t)), '歌詞沒有變成台詞');
  }
  // 不是音樂劇的劇本：不誤判成歌曲（離地範例劇本各版面、模型完美）
  {
    for (const id of ['colon-fw', 'wrapped', 'centered']) {
      const { r } = await run(id, {});
      eq(r.stats.songs, 0, id + '：沒有歌曲區塊');
    }
  }
  // 台詞（模型標 S）與前一句台詞的續行（C）不被吸進歌曲
  {
    const g = [];
    for (let i = 0; i < 12; i++) g.push('甲：你好' + i + '，今日點呀？', '乙：好好呀，多謝。');
    g.push('甲：我有一個很長的故事要講，', '從前有座山，', '(合)\t啦啦啦，', '(合)\t啦啦啦啦。');
    const lines = T.buildLines({ text: g.join('\n') }).lines;
    const callApi = async p => {
      if (p.mode === 'format') return JSON.stringify({ roles: [{ id: '甲', name: '甲' }, { id: '乙', name: '乙' }], rules: { speaker_pos: 'prefix' } });
      if (p.mode === 'roles') return p.candidates.map(c => c[0] + '|N|').join('\n');
      const ids = new Set(p.roles.map(r => r.id));
      return p.lines.map(([n, text]) => { const w = text.split('：')[0]; return n + (ids.has(w) ? '|S|' + w : text === '從前有座山，' ? '|C|' : '|N|'); }).join('\n');
    };
    const r = await T.runPipeline({ lines, callApi, concurrency: 1, chunkSize: 150 });
    const L = r.scenes.flatMap(s => s.lines), song = L.find(l => l.song !== undefined);
    eq(song.lyrics, ['(合)　啦啦啦，', '(合)　啦啦啦啦。'], '前一句台詞的續行「從前有座山，」不被吸進歌詞');
    ok(L.some(l => l.s === '甲' && /從前有座山/.test(l.t)), '續行仍接在台詞後面');
  }
  // 進度回報
  {
    const seen = [];
    await run('colon-fw', {}, { onProgress: p => seen.push(p.stage + ':' + p.done + '/' + p.total) });
    ok(seen[0] === 'format:0/1' && seen.includes('format:1/1') && seen[seen.length - 1] === 'label:5/5', '進度事件：' + seen.join(' '));
  }
  console.log(`✓ pipeline.test.js：${n} 項通過`);
})().catch(e => { console.error('✗', e.message ? e.message.slice(0, 2500) : e); process.exit(1); });
