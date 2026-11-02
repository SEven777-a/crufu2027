# -*- coding: utf-8 -*-
"""把 icons_raw 的 Gemini 原圖轉成 app 用的頭像圖組。

用法（在專案根目錄）：
    py app\\build_avatars.py 11 30        處理 11～30 號

每組：
    icons_raw\\runner<N>.jpg（深灰底大頭） → app\\icons\\runner<N>.png（128×128）
    icons_raw\\run<N>.jpg（洋紅底奔跑）   → app\\icons\\run<N>.png（透明底，高 256）
另外輸出 icons_raw\\_preview_<起>-<迄>.png 總覽圖，方便核對。
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
RAW, OUT = ROOT / "icons_raw", ROOT / "app" / "icons"


def bust(n):
    im = Image.open(RAW / f"runner{n}.jpg").convert("RGB")
    im.resize((128, 128), Image.LANCZOS).save(OUT / f"runner{n}.png", optimize=True)


def runner(n):
    im = Image.open(RAW / f"run{n}.jpg").convert("RGBA")
    px = im.load()
    w, h = im.size
    # 洋紅底去背：從四邊往內填，偏洋紅的都當背景（含 Gemini 偶爾畫的淡紫地面陰影、JPEG 邊緣色偏）；
    # 只吃跟外框連通的部分，人物身上的粉紅色不會被誤刪
    # 紅藍接近、綠明顯偏低＝洋紅系（含深洋紅邊緣、淡紫陰影）；粉紅頭髮、腮紅的綠不夠低，不會被吃掉
    magenta = lambda p: p[0] > 30 and p[2] > 30 and -40 < p[2] - p[0] < 100 and p[1] < 0.7 * min(p[0], p[2])
    seen = bytearray(w * h)
    stack = [(x, y) for x in range(w) for y in (0, h - 1)] + [(x, y) for y in range(h) for x in (0, w - 1)]
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y * w + x]:
            continue
        seen[y * w + x] = 1
        if not magenta(px[x, y]):
            continue
        px[x, y] = (0, 0, 0, 0)
        stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    # Gemini 偶爾在腳下畫一圈淡紫地面陰影，跟背景不連通；最下面 12% 的紫色系一律清掉（鞋子是白、褲子是深色，不受影響）
    box = im.getbbox()
    for y in range(box[3] - int((box[3] - box[1]) * 0.12), box[3]):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a and b > g + 30 and r > g + 15:
                px[x, y] = (0, 0, 0, 0)
    im = im.crop(im.getbbox())
    s = 256 / im.height
    im = im.resize((max(1, round(im.width * s)), 256), Image.LANCZOS)
    # 縮小後邊緣半透明：二值化，像素風邊緣才會清楚
    a = im.getchannel("A").point(lambda v: 255 if v >= 128 else 0)
    im.putalpha(a)
    im.save(OUT / f"run{n}.png", optimize=True)


def preview(a, b):
    ns = list(range(a, b + 1))
    cols = 5
    rows = (len(ns) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * 200, rows * 170), "#e5e7eb")
    d = ImageDraw.Draw(sheet)
    for i, n in enumerate(ns):
        x, y = (i % cols) * 200, (i // cols) * 170
        sheet.paste(Image.open(OUT / f"runner{n}.png").resize((80, 80)), (x + 8, y + 30))
        r = Image.open(OUT / f"run{n}.png")
        r = r.resize((round(r.width * 130 / r.height), 130), Image.NEAREST)
        sheet.paste(r, (x + 95, y + 30), r)
        d.text((x + 8, y + 8), f"{n}", fill="#111")
    sheet.save(RAW / f"_preview_{a}-{b}.png")


if __name__ == "__main__":
    a, b = int(sys.argv[1]), int(sys.argv[2])
    for n in range(a, b + 1):
        bust(n); runner(n); print(f"{n} ✓")
    preview(a, b)
    print(f"總覽：icons_raw\\_preview_{a}-{b}.png")
