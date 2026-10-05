// 模擬模型：依標準答案回覆，可注入標記錯誤與「回應格式壞掉」，用來驗證管線、重試與後備邏輯，
// 以及在沒有 API key 時跑評測流程。結果不代表真實模型的準確率。
const { alignLines } = require('./align');
const { ROLES } = require('../synth');

const GENDER = { 朗: 'm', 偉: 'm', 玲: 'f', K: 'f' };
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// opts: { errRate:每行標錯機率, failRate:每次回應壞掉機率, seed, alwaysFail }
function makeMock(lines, gold, opts = {}) {
  const errRate = opts.errRate || 0, failRate = opts.failRate || 0;
  const al = alignLines(lines.map(l => l.text), gold.map(g => g.text));
  const lab = new Map();
  lines.forEach((l, i) => { const gi = al.pred2gold[i]; lab.set(l.n, gi >= 0 ? { label: gold[gi].label, role: gold[gi].role } : { label: 'N', role: '' }); });
  const calls = { format: 0, label: 0 };
  const rng = mulberry32(opts.seed || 1);
  const ids = ROLES.map(r => r.id);
  async function callApi(payload) {
    if (opts.fatal && calls.format + calls.label >= opts.fatal.after) { const e = new Error('rate limited'); e.fatal = true; e.status = 429; throw e; }
    if (payload.mode === 'format') {
      calls.format++;
      if (opts.alwaysFail) return '{not json';
      return JSON.stringify({ roles: ROLES.map(r => ({ id: r.id, name: r.name, aliases: r.alias.filter(a => a !== r.id), gender: GENDER[r.id] || 'n' })), rules: { speaker_pos: 'mock' } });
    }
    calls.label++;
    const rows = payload.lines.map(([n]) => {
      const v = lab.get(n) || { label: 'N', role: '' };
      let { label, role } = v;
      if (errRate && rng() < errRate) {
        const pick = ['S', 'C', 'D', 'N'].filter(x => x !== label);
        label = pick[Math.floor(rng() * pick.length)];
        role = label === 'S' ? ids[Math.floor(rng() * ids.length)] : '';
      }
      return [n, label, label === 'S' ? role : ''];
    });
    let out = rows.map(r => r.join('|'));
    if (opts.alwaysFail || (failRate && rng() < failRate)) {
      const kind = Math.floor(rng() * 3);
      if (kind === 0) out.splice(Math.floor(rng() * out.length), 3);                 // 漏行
      else if (kind === 1) out[Math.floor(rng() * out.length)] = rows[0][0] + '|S|不存在的角色';   // 角色不在清單
      else out.push(out[0]);                                                          // 重複
    }
    return '```\n' + out.join('\n') + '\n```';
  }
  return { callApi, calls };
}
module.exports = { makeMock };
