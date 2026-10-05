# 第三方函式庫（原樣放入，未修改）

| 檔案 | 來源 | 版本 | 授權 |
|---|---|---|---|
| `mammoth.browser.min.js` | npm `mammoth` | 1.8.0 | BSD-2-Clause（`LICENSE.mammoth`） |
| `pdf.min.js`、`pdf.worker.min.js` | npm `pdfjs-dist` | 3.11.174 | Apache-2.0（`LICENSE.pdfjs`） |

放在同源目錄而不用 CDN：離線可用（PWA 可快取）、不依賴第三方主機。
pdf.js 以 `isEvalSupported:false` 載入，避開 3.x 已知的字型 eval 風險（CVE-2024-4367）。
