// Node 版取文字（評測離線重跑用）：docx 用 mammoth、PDF 用 pdf.js（與前端同版本），再交給 TSP.buildLines
const fs = require('fs');

async function extractDocx(file) {
  const mammoth = require('mammoth');
  const r = await mammoth.extractRawText({ buffer: fs.readFileSync(file) });
  return { text: r.value };
}
async function extractPdf(file, TSP) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, useSystemFonts: false, verbosity: 0,
    cMapUrl: require('path').join(__dirname, '../../vendor/cmaps/'), cMapPacked: true }).promise;
  const pageItems = [];
  for (let p = 1; p <= doc.numPages; p++) pageItems.push((await (await doc.getPage(p)).getTextContent()).items);
  return { pages: TSP.pdfItemsToPages(pageItems) };      // 和前端 extractPdf 同一個入口：雙欄版面、名字欄由整份文件決定
}
async function extractFile(file, TSP) {
  if (/\.pdf$/i.test(file)) return extractPdf(file, TSP);
  if (/\.docx$/i.test(file)) return extractDocx(file);
  return { text: fs.readFileSync(file, 'utf8') };
}
module.exports = { extractFile };
