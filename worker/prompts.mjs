// 提示詞與請求組裝：Worker 與 eval/ 共用，確保評測的就是上線的內容。
// 原則：LLM 只輸出標籤，不輸出台詞原文。

export const TAGS = ['S', 'C', 'D', 'H', 'N'];

const FORMAT_SYSTEM = `你是「劇本格式分析器」。使用者會給你一份劇本的開頭（以及中後段的幾個片段），每行前面有行號，格式為「行號、Tab 字元、內容」。
你的工作是歸納這份劇本的格式，只輸出一個 JSON 物件，不要任何其他文字，也不要用 markdown 圍欄。

JSON 格式（下面是格式示範，名字都是虛構的；絕對不要把示範裡的名字抄進你的輸出，只能寫劇本裡真的出現過的）：
{
  "roles": [ { "id": "甲", "name": "甲先生", "aliases": ["小甲"], "gender": "m" } ],
  "rules": {
    "speaker_pos": "角色名出現的位置：prefix（行首，後面接冒號或空格）／own_line（獨立成行，常置中，台詞在下一行）／mixed／other",
    "direction": "舞台指示用的括號種類與樣子，例如：全形括號（）、半形括號()、整行括號",
    "heading": "場次標題的樣子，例如：「第X場　場名」「序場」「SCENE 3」，沒有就寫「無」",
    "noise": "封面、目錄、頁眉、頁碼、作者資訊等雜訊的樣子，沒有就寫「無」",
    "notes": "其他對逐行標記有幫助的觀察（可空）"
  }
}

roles 規則：
- 列出所有會說話的角色（含只在後段出現的，可從後段片段找）。「全體」「眾人」「四人」這類合說稱呼若單獨作為說話者出現，也當作一個角色。
- id：該角色在劇本裡最常用、最短的稱呼（1～6 個字元，不含「/」、引號、角落括號）。同一角色只能有一個 id，不同角色 id 不可重複。
- name：劇本裡出現過的全名；劇本裡沒有出現全名就與 id 相同，不要自己補。aliases：其他在劇本裡出現過的稱呼（簡稱、全名、英文名、暱稱），沒有就給空陣列 []。
- gender：m 男、f 女、n 不確定。只根據劇本內容（稱謂、他／她、角色描述）判斷，不要憑名字猜。
- 不要把場景人物表以外的路人、旁白當成角色，除非他們有台詞行。
- 所有字串都必須是劇本中出現過的原樣文字；不要翻譯、不要改寫。`;

const LABEL_SYSTEM = `你是「劇本逐行標記器」。使用者會給你角色清單、格式說明，以及一段劇本，每行前面有行號，格式為「行號、Tab 字元、內容」。
請對「每一行」輸出一行標記，格式固定為：
行號|標籤|角色
只輸出這些標記行，不要輸出任何其他文字、說明、markdown 圍欄；絕對不要重複或改寫劇本內容。

標籤只能是下列五種：
S  台詞行：一個角色開口說的話（這一行是他這段台詞的開頭）。「角色」欄必須填角色清單裡的 id；合說（兩人以上同時說）用「/」連接，例如 甲/乙。
C  續行：緊接在上一個 S 之後，是同一段台詞折行、換行後的後半。「角色」欄留空。
D  舞台指示：整行都是動作、燈光、音效、場景描述等非台詞說明（常整行被括號包住）。「角色」欄留空。
H  場次或幕的標題（如「第三場」「序場」「SCENE 2」「第一幕　場名」）。「角色」欄留空。只有真的把劇本分成場次的標題才標 H；劇名、副標題、網址、版權聲明、作者資訊不是 H（標 N）。很多劇本根本沒有場次標題（整齣連續進行），這時整份都不要出現 H，不要為了切段而硬標。
N  雜訊：頁碼、頁眉頁尾、封面、目錄、作者與版權資訊、人物表，以及「獨立成行、只寫角色名」的行（台詞在下一行）。「角色」欄留空。

判斷要點：
1. 角色名在行首、後接冒號或破折號（如「甲：你好」「甲（低聲）：你好」「Madison (yelling) – No!」「甲 你好」）→ 該行是 S，角色填 id（別名要對回 id）。
2. 角色名獨立成行（常置中），台詞在下一行 → 角色名那行標 N；下一行標 S 並填該角色；之後同一段台詞的折行標 C。
3. 台詞中途夾的括號指示（如「甲：（氣聲）喂~」）仍屬 S，不用另外處理。整行只有括號內說明才是 D。
   沒有括號、以敘述句寫成的舞台說明（如英文劇本的「She hesitates for a moment.」「兄走到門邊，手搭在門把上。」）也是 D；它通常出現在上一句台詞已經說完（句末有標點）之後，且不是任何角色開口說的話。
4. 沒有角色名、也不是整行指示的文字，如果緊接在 S 或 C 之後且語意是同一句話的後半（或單人獨白的下一行），標 C；如果是描述性的舞台說明，標 D。
5. 頁碼（如「- 3 -」「第3頁」）、重複出現的頁眉、封面與目錄標 N；頁碼或頁眉夾在台詞與續行中間時，它標 N，後面的續行仍標 C。
6. 輸入的每一行都必須有且只有一行輸出，行號與輸入完全一致，順序一致，不可漏、不可多、不可合併。
7. 角色欄只能使用角色清單裡的 id，不可自創。

範例（角色清單：甲、乙；名字是虛構的，只示範格式）：
輸入：
10\t第二場　暢談廣東話
11\t（甲和乙坐着。）
12\t甲：你食咗飯未呀？
13\t乙（笑）：未呀，等緊你。
14\t咁我哋一齊去食啦，好冇？
15\t- 3 -
16\t甲/乙：好呀！
輸出：
10|H|
11|D|
12|S|甲
13|S|乙
14|C|
15|N|
16|S|甲/乙

另一種版面的範例：
輸入：
20\t            甲
21\t你食咗飯未呀？
22\t            乙
23\t未呀，等緊你。咁我哋一齊
24\t去食啦。
輸出：
20|N|
21|S|甲
22|N|
23|S|乙
24|C|`;

const clip = (s, max = 200) => (s.length <= max ? s : s.slice(0, Math.floor(max * 0.7)) + '…' + s.slice(-Math.floor(max * 0.25)));

function renderLines(lines, clipLen) {
  return lines.map(([n, t]) => `${n}\t${clipLen ? clip(String(t), clipLen) : t}`).join('\n');
}

function renderRoles(roles) {
  return roles.map(r => `- ${r.id}：${[r.name, ...(r.aliases || [])].filter((x, i, a) => x && x !== r.id && a.indexOf(x) === i).join('、') || '（無別名）'}`).join('\n');
}

function renderRules(rules) {
  if (!rules || typeof rules !== 'object') return '（無）';
  const names = { speaker_pos: '角色名位置', direction: '舞台指示', heading: '場次標題', noise: '雜訊', notes: '備註' };
  return Object.keys(names).filter(k => rules[k]).map(k => `- ${names[k]}：${String(rules[k]).slice(0, 200)}`).join('\n') || '（無）';
}

// payload: { mode:'format'|'label', lines:[[n,text],…], roles?, rules? } → OpenAI 相容 messages
export function buildMessages(payload) {
  if (payload.mode === 'format') {
    return [
      { role: 'system', content: FORMAT_SYSTEM },
      { role: 'user', content: '劇本（行號、Tab 字元、內容）：\n' + renderLines(payload.lines, 240) }
    ];
  }
  if (payload.mode === 'label') {
    return [
      { role: 'system', content: LABEL_SYSTEM },
      { role: 'user', content: '角色清單：\n' + renderRoles(payload.roles || []) + '\n\n格式說明：\n' + renderRules(payload.rules) + '\n\n請標記以下每一行：\n' + renderLines(payload.lines, 200) }
    ];
  }
  throw new Error('unknown mode');
}

// OpenRouter 請求本體。env: { MODEL, PROVIDERS }
export function buildRequest(env, payload) {
  const providers = String(env.PROVIDERS || 'together,fireworks').split(',').map(s => s.trim()).filter(Boolean);
  const body = {
    model: env.MODEL,
    messages: buildMessages(payload),
    temperature: 0,
    max_tokens: payload.mode === 'format' ? 3000 : 8000,
    // 只允許清單內供應商，且要求不保留／不訓練
    provider: { order: providers, only: providers, allow_fallbacks: true, data_collection: 'deny' }
  };
  if (payload.mode === 'format') body.response_format = { type: 'json_object' };
  return body;
}

// 只放行結構化內容，避免把劇本原文透過 Worker 回傳。
// label：只保留「行號|標籤|角色」格式的行；format：解析 JSON 後只重組白名單欄位。
export function filterOutput(mode, text) {
  const t = String(text || '').replace(/^\s*```[a-z]*\s*|\s*```\s*$/gi, '').trim();
  if (mode === 'label') {
    const out = [];
    for (const raw of t.split(/\r?\n/)) {
      const m = raw.trim().match(/^L?(\d{1,7})\s*[|｜]\s*([SCDHN])\s*(?:[|｜]\s*([^|｜\n]{0,60}))?$/);
      if (m) out.push(`${m[1]}|${m[2]}|${(m[3] || '').trim()}`);
    }
    return out.join('\n');
  }
  if (mode === 'format') {
    let j;
    try { j = JSON.parse(t); } catch (e) {
      const a = t.indexOf('{'), b = t.lastIndexOf('}');
      if (a < 0 || b <= a) throw new Error('model did not return JSON');
      j = JSON.parse(t.slice(a, b + 1));
    }
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const roles = (Array.isArray(j.roles) ? j.roles : []).slice(0, 60).map(r => ({
      id: str(r && r.id, 12), name: str(r && r.name, 40),
      aliases: (Array.isArray(r && r.aliases) ? r.aliases : []).slice(0, 12).map(a => str(a, 40)).filter(Boolean),
      gender: ['m', 'f', 'n'].includes(r && r.gender) ? r.gender : 'n'
    })).filter(r => r.id);
    const rules = {};
    for (const k of ['speaker_pos', 'direction', 'heading', 'noise', 'notes']) rules[k] = str(j.rules && j.rules[k], 200);
    return JSON.stringify({ roles, rules });
  }
  throw new Error('unknown mode');
}
