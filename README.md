# 台詞小精靈（通用版）

上傳任意劇本（docx／文字型 PDF／貼上文字），自動解析成結構化劇本，載入背誦介面。完整規格見 [SPEC.md](SPEC.md)。

## 目錄

| 路徑 | 內容 |
|---|---|
| `index.html` | 前端，單檔（背誦介面、首頁、儲存層、解析與校正） |
| `samples/ld.v2.json` | 《離地，到着》v2 範例劇本（可在首頁「匯入 JSON」載入） |
| `eval/` | 評測腳本與測試資料 |
| `worker/` | Cloudflare Worker（持有 API key、限流、轉發 LLM） |
| `tests/` | jsdom 測試（`npm test`） |

## 開發

```sh
npm install
npm test            # 語法檢查 + 儲存層測試 + 與原 app 的迴歸比對
python3 -m http.server 8000   # 本機預覽 http://localhost:8000/
```

## 進度

- [x] 步驟 1：Schema 與載入層（IndexedDB、動態角色、移除東京地圖）
- [x] 步驟 2：本機解析器（docx＝mammoth、PDF＝pdf.js 文字層、貼上；前處理與頁眉頁尾清理）
- [x] 步驟 3：兩段式標記管線（切塊、回應解析與一致性檢查、組回、內嵌指示、日文標記）與評測腳本（`eval/`）
  — 真實模型準確率尚未量測（需要你的 OpenRouter key，見 `eval/README.md`）
