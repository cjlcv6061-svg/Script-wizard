# 真實劇本評測資料

把你手上的真實劇本（≥10 份，格式各異：docx、PDF、貼上的純文字，含版面最亂的幾份）放在這裡，
每份旁邊放同名的 `.gold.json` 標準答案：

```
eval/real/
  劇本A.docx
  劇本A.gold.json
  劇本B.pdf
  劇本B.gold.json
```

標準答案草稿可以先自動產生再人工校對：

```sh
node eval/draft-gold.mjs eval/real/劇本A.docx > eval/real/劇本A.gold.json
```

`gold` 是逐行陣列，`{ "text": "行文字", "label": "S|C|D|H|N", "role": "角色id（只有 S 需要）" }`，
行的順序與前處理後的編號行一致（頁眉頁尾被自動移除的 N 行不算錯）。

```sh
node eval/run.mjs --real eval/real --mode heuristic          # 本機基準線
OPENROUTER_API_KEY=... MODEL=... node eval/run.mjs --real eval/real --mode live
```

注意：劇本內容可能涉及保密，`eval/real/` 的檔案預設不要 commit（見 `.gitignore`）。
