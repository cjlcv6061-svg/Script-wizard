# 評測（SPEC 第 10 節）

## 資料

| 來源 | 內容 |
|---|---|
| `fixtures/ld.v1.json` | 《離地，到着》v1 劇本（22 場）。**免費金標準**：可反向生成原始文字 |
| `synth.js` | 由上面反向生成 7 種排版（冒號式、全形冒號、全名＋半形冒號、角色名置中獨立行、折行續行、空行分隔、封面／目錄／頁碼雜訊），附逐行標準答案 |
| `build_docs.py` | 把合成劇本輸出成 docx 與 PDF（頁眉、頁尾、頁碼畫在頁面邊緣，奇偶頁不同頁眉） |
| `real/` | 你手上的真實劇本與人工標準答案（見 `real/README.md`；預設不 commit） |

```sh
npm run fixtures                 # 產生 eval/out/synth 與 eval/out/docs（需要 python-docx、reportlab）
```

## 執行

```sh
node eval/run.mjs --mode heuristic --docs     # 不用模型：本機啟發式基準線（不需要 key）
node eval/run.mjs --mode mock --err 0.02      # 模擬模型：驗證管線、重試與後備（不代表真實準確率）
OPENROUTER_API_KEY=... MODEL=<模型ID> node eval/run.mjs --mode live --docs   # 真實模型
```

- `--variants colon-fw,noisy` 只跑部分版面；`--real eval/real` 加入真實劇本；`--no-cache` 不使用回應快取。
- live 模式用與 Worker **同一份**提示詞與請求組裝（`worker/prompts.mjs`）、同一份解析管線（抽自 `index.html` 的 PARSER-CORE），
  所以評測的就是上線的東西。**必須用與正式上線相同的「模型＋供應商允許清單」**（`MODEL`、`PROVIDERS`）。
- 回應快取在 `eval/out/cache/`（以請求內容的 SHA-256 為鍵）：同樣的請求不重複計費，可離線重跑。
- API key 只從環境變數讀，不寫入任何檔案。

## 指標

- **行級準確率**：標籤（S/C/D/H/N）與角色皆對才算對；docx、PDF、純文字分開統計。前處理已移除的頁眉頁尾（答案為 N）算對。
- 另列各標籤召回、混淆矩陣、錯誤行清單（`eval/out/report.{json,md}`）。
- **端到端還原度**：組回後的劇本與原劇本逐行（角色＋台詞）相同的比例。
- 假設：小模型 ≥95%，剩餘錯誤集中在舞台指示與多角色合說行；低於 95% 才升級模型。

## 目前結果（沒有真實模型的 key，以下只是基準與管線驗證）

合成劇本是規律排版，**比真實劇本乾淨很多**，高分不代表真實劇本也能高分，真實準確率要用 `real/` 與 live 模式量。

| 模式 | 說明 | 結果 |
|---|---|---|
| heuristic | 本機規則，角色清單由答案給定 | 純文字 99.2%、docx 99.7%、PDF 97.0%（最差：雜訊版 N 召回 39%，頁碼以外的雜訊要靠 LLM） |
| mock（完美） | 模型標籤＝答案 | 12 份全部 100%，組回與原劇本逐行相同（PDF 99.6%，差在測試字型缺字的替換） |
| mock（err 2%、壞回應 30%） | 驗證重試與後備 | 97.9–98.4%，失敗塊自動改用本機規則並標為待校正 |
