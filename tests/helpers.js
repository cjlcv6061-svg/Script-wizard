// 測試共用工具：用 jsdom 載入 index.html，注入 fake-indexeddb，等待啟動完成
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');
const { webcrypto } = require('node:crypto');

const ROOT = path.join(__dirname, '..');

function readIndex(file = 'index.html') {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(fn, what = 'condition', ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what);
    await sleep(15);
  }
}

// opts: { indexedDB, voices, fetchMap, errors }
function makeDom(html, opts = {}) {
  const errors = opts.errors || [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e && e.stack || e)));
  vc.on('error', (...a) => errors.push(a.join(' ')));
  const dom = new JSDOM(html, {
    url: 'https://example.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.scrollTo = () => {};
      w.Element.prototype.scrollIntoView = () => {};
      w.confirm = () => true;
      w.prompt = () => null;
      w.URL.createObjectURL = () => 'blob:x';
      w.URL.revokeObjectURL = () => {};
      w.HTMLAnchorElement.prototype.click = function () { w.__lastDownload = { href: this.href, name: this.download }; };
      w.TextEncoder = TextEncoder;
      Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
      if (opts.indexedDB !== null) w.indexedDB = opts.indexedDB || new IDBFactory();
      if (opts.fetchMap) {
        w.fetch = async (u) => {
          const k = String(u).replace(/\?.*$/, '');
          if (!(k in opts.fetchMap)) return { ok: false, status: 404, json: async () => { throw new Error('404'); } };
          return { ok: true, status: 200, json: async () => JSON.parse(opts.fetchMap[k]) };
        };
      }
      if (opts.voices) {
        const vs = opts.voices.map(v => Object.assign({ voiceURI: v.name }, v));
        w.SpeechSynthesisUtterance = function (t) { this.text = t; };
        Object.defineProperty(w, 'speechSynthesis', {
          value: { getVoices: () => vs, speak() {}, cancel() {}, onvoiceschanged: null },
          configurable: true
        });
      }
    }
  });
  return { dom, w: dom.window, errors };
}

// 在頁面全域範圍求值（可存取頂層 let/const）
const ev = (w, code) => w.eval(code);

module.exports = { ROOT, readIndex, makeDom, waitFor, sleep, ev };
