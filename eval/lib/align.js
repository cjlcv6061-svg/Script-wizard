// 兩個行序列（解析器輸出行 vs 標準答案行）的 LCS 對齊。
// 用途：PDF／docx 抽出的行可能與標準答案略有出入（頁眉頁尾被移除、空白不同），
// 先對齊再比較標籤，才不會因為少一行而整段錯位。
const norm = s => String(s).replace(/[\s　]+/g, '');

// 回傳 {pred2gold: Int32Array（-1 表示對不上）, gold2pred: Int32Array, matched}
function alignLines(predTexts, goldTexts) {
  const a = predTexts.map(norm), b = goldTexts.map(norm);
  const n = a.length, m = b.length;
  const W = m + 1;
  const dp = new Uint16Array((n + 1) * W);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i * W + j] = a[i - 1] === b[j - 1]
        ? dp[(i - 1) * W + j - 1] + 1
        : Math.max(dp[(i - 1) * W + j], dp[i * W + j - 1]);
    }
  }
  const pred2gold = new Int32Array(n).fill(-1), gold2pred = new Int32Array(m).fill(-1);
  let i = n, j = m, matched = 0;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { pred2gold[i - 1] = j - 1; gold2pred[j - 1] = i - 1; matched++; i--; j--; }
    else if (dp[(i - 1) * W + j] >= dp[i * W + j - 1]) i--; else j--;
  }
  return { pred2gold, gold2pred, matched };
}
module.exports = { alignLines, norm };
