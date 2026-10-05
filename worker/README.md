# 解析 Worker（SPEC 第 6、12 節）

持有 OpenRouter API key、限流、轉發到 LLM，**只回標籤與角色格式，不回劇本原文**。

| 端點 | 說明 |
|---|---|
| `POST /parse` | body：`{ mode:"format"\|"label", lines:[[n,"text"],…], roles?, rules? }`；回 `{ ok, mode, content }` |
| `GET /health` | `{ ok, configured }`（不含任何祕密） |

## 行為

- CORS：只允許 `ALLOWED_ORIGIN`（只填來源，不含路徑）。有 `Origin` 但不符 → 403；沒有 `Origin`（curl 等）不在此擋，靠限流與 OpenRouter 後台金額上限保護。
- 限制：body ≤ 100KB、行數 ≤ 400。
- 限流（UTC 日）：每 IP `DAILY_PER_IP`（預設 60）、全站 `DAILY_TOTAL`（預設 600），超限回 `429` 並帶 `Retry-After`。計數用 Durable Object（SQLite 版，免費方案可用、計數原子）；只存「IP 雜湊→次數」，隔日重置。被限流的請求不會呼叫上游。
- LLM：OpenRouter，溫度 0；請求固定帶 `provider: { order, only, allow_fallbacks:true, data_collection:"deny" }`，`only` = `PROVIDERS` 允許清單，**不會**路由到清單外；不使用 `:free` 模型。清單內全部失敗 → 回 `503`（前端顯示「服務暫時無法使用」）。
- 輸出過濾：`label` 只放行 `行號|標籤|角色` 格式的行；`format` 只重組白名單欄位。
- 隱私：不記錄 body；日誌只有時間、IP 雜湊、模式、行數、狀態碼。
- 換模型或換供應商只改環境變數（`MODEL`、`PROVIDERS`），不改程式碼。

## 站長要做的設定（Claude Code 沒辦法代做）

1. **Cloudflare**：註冊免費帳號，在終端機執行 `npx wrangler login`（瀏覽器授權）。
2. **OpenRouter**：註冊、充值 10 美元、建立 API key、在後台設定金額上限；在帳號隱私設定關閉「允許記錄提示詞與回覆」。
3. 編輯 `wrangler.toml`：
   - `ALLOWED_ORIGIN` → `https://<GH_USER>.github.io`
   - `MODEL` → 到 OpenRouter 模型頁確認 DeepSeek V4.1 Flash 的**現行模型 ID**（程式不寫死；沒改時 Worker 回 503 `not_configured`）
   - `PROVIDERS` → 到該模型頁的 Providers 分頁，確認清單內供應商標示為不訓練、不保留提示詞；更換清單時須重新確認
4. 部署：
   ```sh
   cd worker && npm install
   npx wrangler deploy
   npx wrangler secret put OPENROUTER_API_KEY    # 貼上 key；不經過聊天、不寫進任何檔案
   ```
5. 把部署後的網址（`https://tsj-parse.<子網域>.workers.dev`）填進 `index.html` 的 `TSJ_CONFIG.WORKER_URL`。
6. 上線前依 OpenRouter 與所選供應商的官方條款確認資料保留與訓練政策，據此修訂同意畫面的隱私聲明。

## 本機開發

```sh
cd worker && npm install
printf 'OPENROUTER_API_KEY=sk-...\nMODEL=<模型ID>\nALLOW_LOCALHOST=true\n' > .dev.vars    # .dev.vars 已在 .gitignore
npx wrangler dev          # http://localhost:8787
# 前端：python3 -m http.server 8000，開 http://localhost:8000/?worker=http://localhost:8787
```

`UPSTREAM_URL` 只供自動化測試把上游換成假伺服器，正式環境不要設。

## 測試

`npm test`（根目錄）會跑 `tests/worker.test.mjs`（單元：CORS、上限、限流、請求內容、輸出過濾、日誌）
與 `tests/e2e.browser.test.js`（Chromium ＋ 真的 workerd ＋ 假 OpenRouter 的端到端）。
