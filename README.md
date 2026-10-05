# 台詞小精靈（通用版）

上傳任意劇本（Word `.docx`、文字型 PDF、貼上文字），自動解析成結構化劇本，載入背誦介面（隱藏自己的台詞、朗讀對戲、測驗、接話、循環播放、成績）。
規格見 [SPEC.md](SPEC.md)。前端是單一 `index.html`；劇本只存在使用者自己的瀏覽器（IndexedDB）；解析時文字會送到 Cloudflare Worker → OpenRouter 的 LLM，LLM 只回標籤，台詞由本機依行號取回，所以不會改字、漏句、幻覺。

網址（GitHub Pages）：`https://cjlcv6061-svg.github.io/Script-wizard/`

## 目錄

| 路徑 | 內容 |
|---|---|
| `index.html` | 前端單檔：背誦介面（沿用原 app）、首頁、儲存層（IndexedDB）、解析核心 `PARSER-CORE`、校正核心 `EDITOR-CORE`、校正頁、PWA 註冊 |
| `vendor/` | mammoth 1.8.0、pdf.js 3.11.174（原樣放入，見 `vendor/README.md`） |
| `manifest.webmanifest`、`sw.js`、`icons/` | PWA：可加入主畫面、離線使用 |
| `worker/` | Cloudflare Worker：CORS、限流、轉發 OpenRouter、輸出過濾（見 `worker/README.md`） |
| `eval/` | 評測：合成劇本產生器、docx/PDF 產生、評測腳本、mock 模型（見 `eval/README.md`） |
| `samples/ld.v2.json` | 《離地，到着》v2 範例劇本（首頁「匯入 JSON」可載入） |
| `tests/` | 自動測試（`npm test`） |

## 使用流程

1. **首頁**：我的劇本（開啟／校正／重新命名／匯出／刪除）、「新增劇本」、「匯入 JSON」。
2. **新增**：選 docx／PDF／txt，或貼上文字（掃描 PDF 會提示不支援）。
3. **同意畫面**（首次）：說明文字會送到第三方 AI 服務。
4. **解析進度**：第一段歸納格式、第二段分塊標記；顯示塊數與失敗塊數；可取消。相同內容（SHA-256）直接用本機快取，不重複呼叫。
5. **預覽校正**：逐行列表，橘色邊框＝待人工校正（可一鍵跳下一個）；改標籤（台詞／指示／雜訊）、改角色（可合說）、改文字、與上一行合併、在游標處拆行、插入／移除場次分隔、角色重新命名／合併／設性別／刪除未使用角色。每次修改即時寫回 IndexedDB。
6. **選角**：依角色清單選要背的角色，進入背誦介面。

清除瀏覽器資料會讓劇本消失；換裝置或備份請用「匯出」（v2 JSON，可選含成績）。

## 開發與測試

```sh
npm install
npm test           # 語法檢查 + 單元／整合 + 與原 app 的迴歸比對 + 真瀏覽器端到端（需 Chromium、wrangler）
npm run fixtures   # 產生評測用的合成劇本與 docx/PDF（需要 python-docx、reportlab）
python3 -m http.server 8000   # 本機預覽 http://localhost:8000/
```

`npm test` 包含：與原 app 逐場逐角色比對渲染結果（1626 項完全一致）、解析管線（含重試／後備／fatal 中止）、Worker（CORS、上限、限流、請求內容、輸出過濾、日誌）、Chromium 手機尺寸的校正頁與離線、以及「真 Worker（workerd）＋ 假 OpenRouter」的 docx 上傳 → 解析 → 校正 → 背誦端到端。缺少 Chromium／wrangler 時，對應測試會自動略過。

## 站長待辦（Claude Code 無法代做）

1. **GitHub Pages**：Settings → Pages → Deploy from a branch，選要發布的分支與 `/ (root)`。（目前 repo 只有 `claude/new-session-woeij2` 一個分支，也是預設分支。）
2. **Cloudflare / OpenRouter / 部署 Worker**：照 [worker/README.md](worker/README.md)；`OPENROUTER_API_KEY` 只用 `wrangler secret put` 在終端機貼上。
3. **填 Worker 網址**：部署後把 `https://tsj-parse.<你的子網域>.workers.dev` 填進 `index.html` 的 `TSJ_CONFIG.WORKER_URL`（目前已填 `https://tsj-parse.scriptwizard.workers.dev`）。
4. **確認模型與供應商**：到 OpenRouter 模型頁確認 DeepSeek V4.1 Flash 的現行模型 ID 填進 `MODEL`（沒改時 Worker 回 503 `not_configured`）；確認 `PROVIDERS` 內供應商標示為不訓練、不保留提示詞；依官方條款修訂同意畫面的隱私聲明。
5. **用真實劇本評測**：把 ≥10 份真實劇本與人工標準答案放進 `eval/real/`，用 `MODEL`、`PROVIDERS` 與上線相同的設定跑 `node eval/run.mjs --mode live --real eval/real --docs`。**目前沒有任何真實模型的準確率數字**（開發環境連不到 OpenRouter）。
6. 待你決定：每 IP／全站每日上限初值（現為 60／600）、角色顏色調色盤（現沿用原暖色系，`ROLE_PALETTE`）、深色模式（現沿用原 app：只有深色）。

## 與規格的差異與取捨

- **mammoth／pdf.js 放在 `vendor/`**，不走 CDN：離線可用、PWA 可快取、同源；pdf.js 以 `isEvalSupported:false` 載入。
- **第一段格式歸納**除了前 200 行，劇本更長時再取 5 個 40 行的中後段片段（總共 ≤ 400 行），讓只在後段登場的角色也進得了角色清單。
- **獨立成行的角色名**（置中式版面）標 `N`，其下一行才是 `S`；提示詞已寫明。
- **標記失敗的塊**：重試一次後仍失敗，改用本機啟發式規則先標，並標為「待人工校正」（規格只說標為待校正）。
- **限流用 Durable Object（SQLite 版）**，不用 KV：KV 免費方案每天只有 1,000 次寫入，不夠記 600 次請求的計數；DO 計數是原子的、免費方案可用。
- **資料格式**在 v2 上多了兩個選用欄位：`{x:"文字"}`（被標為雜訊的行，供校正頁還原；背誦時忽略）與 `rv:true`（待校正）。`scenes[].lines` 的 `s／t／r／d／seg` 與原格式相同。
- **日文語音標記**是本機規則：以《離地》既有標記校準，72 行中 59 行完全一致；差異主要在歌詞行與粵語／日文交界（例如「我連こんにちは」）。需要時可在校正頁直接編輯 `⟦…⟧`。
- 第一版不做：登入、雲端存檔、OCR、專屬分享連結、瀏覽器內本機模型。劇本語言先固定當粵語朗讀（`meta.lang` 已存，尚未用來切換語音）。
- PDF：支援橫排與直排（欄由右到左；兩頁拼一張的版面依右到左讀）、不內嵌字型的繁中 PDF（靠 `vendor/cmaps/`）。雙欄橫排 PDF 的閱讀順序可能錯亂，請改用 Word 或貼上文字。圖片 PDF（掃描檔）仍不支援。
