#!/usr/bin/env python3
"""由 eval/synth.js 產生的合成劇本，輸出 docx 與 PDF 測試檔（附標準答案）。

用法：
    node eval/synth.js eval/out/synth
    python3 eval/build_docs.py eval/out/synth eval/out/docs
需要：pip install python-docx reportlab；系統有 WenQuanYi Zen Hei 字型（或用 --font 指定）。

PDF 的頁眉、頁尾、頁碼是畫在頁面邊緣的（真實 PDF 的情況），不是內文行；
標準答案裡也把它們依閱讀順序列為 N 行，供評測時對齊（被前處理移除的 N 行不算錯）。
"""
import argparse
import json
import os

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

DEFAULT_FONT = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'


def load(indir, vid):
    with open(os.path.join(indir, vid + '.gold.json'), encoding='utf-8') as f:
        return json.load(f)


def save_gold(outdir, vid, desc, roles, gold):
    for i, g in enumerate(gold):
        g['n'] = i + 1
    with open(os.path.join(outdir, vid + '.gold.json'), 'w', encoding='utf-8') as f:
        json.dump({'id': vid, 'desc': desc, 'roles': roles, 'gold': gold}, f, ensure_ascii=False, indent=1)


def make_docx(indir, outdir, src, vid, desc, centered_label=None):
    d = load(indir, src)
    doc = Document()
    for g in d['gold']:
        p = doc.add_paragraph()
        r = p.add_run(g['text'])
        if g['label'] == 'H':
            r.bold = True
        if centered_label and g['label'] == centered_label:
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    doc.save(os.path.join(outdir, vid + '.docx'))
    save_gold(outdir, vid, desc, d['roles'], d['gold'])


# 測試字型（文泉驛正黑）沒有的字，換成字型有的近似字；PDF 與標準答案同步替換，確保比對的是抽取能力而非缺字
SUBST = {'\U00028cd2': '屌', '\u22ef': '…', '\U000269f2': '脷', '\U00028d99': '隻'}


def subst(s):
    for a, b in SUBST.items():
        s = s.replace(a, b)
    return s


def make_pdf(indir, outdir, src, vid, desc, header_fn, footer_fn, per_page=36, font=DEFAULT_FONT):
    d = load(indir, src)
    pdfmetrics.registerFont(TTFont('Zen', font, subfontIndex=0))
    W, H = 900, 842
    c = canvas.Canvas(os.path.join(outdir, vid + '.pdf'), pagesize=(W, H))
    gold = []
    body = [dict(g, text=subst(g['text'])) for g in d['gold']]
    face = pdfmetrics.getFont('Zen').face
    missing = {ch for g in body for ch in g['text'] if ord(ch) not in face.charToGlyph}
    if missing:
        print('警告：字型缺字，請加進 SUBST：', ''.join(sorted(missing)))
    pages = [body[i:i + per_page] for i in range(0, len(body), per_page)]
    for pi, rows in enumerate(pages, 1):
        h = header_fn(pi)
        f = footer_fn(pi)
        if h:
            c.setFont('Zen', 9)
            c.drawString(60, H - 36, h)
            gold.append({'text': h, 'label': 'N', 'role': ''})
        c.setFont('Zen', 11)
        y = H - 80
        for g in rows:
            c.drawString(60, y, g['text'])
            gold.append({'text': g['text'], 'label': g['label'], 'role': g['role']})
            y -= 17
        if f:
            c.setFont('Zen', 9)
            c.drawString(W / 2 - 20, 30, f)
            gold.append({'text': f, 'label': 'N', 'role': ''})
        c.showPage()
    c.save()
    save_gold(outdir, vid, desc, d['roles'], gold)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('indir', nargs='?', default='eval/out/synth')
    ap.add_argument('outdir', nargs='?', default='eval/out/docs')
    ap.add_argument('--font', default=DEFAULT_FONT)
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)

    make_docx(a.indir, a.outdir, 'colon-fw', 'docx-colon', 'docx：角色簡稱＋全形冒號')
    make_docx(a.indir, a.outdir, 'centered', 'docx-centered', 'docx：角色名置中獨立成行', centered_label='N')
    make_pdf(a.indir, a.outdir, 'wrapped', 'pdf-wrapped', 'PDF：折行台詞，每頁頁眉＋頁尾「- n -」',
             lambda p: '《離地，到着》劇本草稿 v3', lambda p: '- %d -' % p, font=a.font)
    make_pdf(a.indir, a.outdir, 'centered-wrapped', 'pdf-centered', 'PDF：置中角色名，奇偶頁不同頁眉，頁尾「第 n 頁」',
             lambda p: '《離地，到着》· 單數頁' if p % 2 else '劇本草稿 v3 · 雙數頁', lambda p: '第 %d 頁' % p, font=a.font)
    make_pdf(a.indir, a.outdir, 'noisy', 'pdf-messy', 'PDF：封面、目錄、內文頁碼雜訊再加頁眉頁尾',
             lambda p: '《離地，到着》機密　內部排練用', lambda p: 'Page %d of 99' % p, per_page=40, font=a.font)
    print('已輸出到', a.outdir, sorted(os.listdir(a.outdir)))


if __name__ == '__main__':
    main()
