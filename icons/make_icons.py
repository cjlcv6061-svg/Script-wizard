#!/usr/bin/env python3
"""產生 PWA 圖示（icons/*.png）。需要 Pillow 與 WenQuanYi Zen Hei（或用 --font 指定任一 CJK 字型）。"""
import argparse
from PIL import Image, ImageDraw, ImageFont

BG, SEAL, INK = (28, 21, 15), (216, 85, 58), (243, 236, 224)


def icon(size, font, maskable=False):
    img = Image.new('RGB', (size, size), BG)
    d = ImageDraw.Draw(img)
    # maskable：重要內容要在中央 80% 安全區內
    box = size * (0.56 if maskable else 0.70)
    x0 = (size - box) / 2
    d.rounded_rectangle([x0, x0, x0 + box, x0 + box], radius=box * 0.2, fill=SEAL)
    f = ImageFont.truetype(font, int(box * 0.66), index=0)
    d.text((size / 2, size / 2), '詞', font=f, fill=INK, anchor='mm')
    return img


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--font', default='/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc')
    a = ap.parse_args()
    for name, size, mask in [('icon-192.png', 192, False), ('icon-512.png', 512, False), ('icon-maskable-512.png', 512, True), ('apple-touch-icon.png', 180, False)]:
        icon(size, a.font, mask).save('icons/' + name, optimize=True)
        print('icons/' + name)
