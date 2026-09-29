#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""贴纸图鉴：/on贴纸 <角色> 出该角色的贴纸网格图。

贴纸图片来自 art/stamp/<资源名>.png（由本地 unity-node 从游戏包里导出；
MasterStamp._stampAsset 形如 Stamp/illust/stamp_illust_tomori_001，取最后一段即可）。
"""
import argparse
import os
import sys

from PIL import Image, ImageDraw

ON = os.environ.get('ON_DIR', '/home/admin/bot/data/on')
sys.path.insert(0, ON)
import cardimg as C  # noqa: E402

STAMP_DIR = os.path.join(ON, 'art', 'stamp')
COLS = 4
CELL = 256
GAP = 18
PAD = 26
LABEL_H = 34
TITLE_H = 96


def resolve_char(d, q):
    s = (q or '').strip()
    if not s:
        return None
    for cid in sorted(d.chars):
        ch = d.chars[cid]
        names = []
        for t in ('_nameTextID', '_shortNameTextID'):
            for k in ('_simplifiedChinese', '_traditionalChinese', '_japanese', '_english'):
                v = d.txt(ch.get(t), k)
                if v:
                    names.append(v.replace(' ', ''))
        if any(s == n or s in n for n in names):
            return ch
    return None


def stamp_path(s):
    leaf = (s.get('_stampAsset') or '').rsplit('/', 1)[-1]
    if not leaf:
        return None
    p = os.path.join(STAMP_DIR, leaf + '.png')
    return p if os.path.exists(p) else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--char')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    d = C.Data()
    stamps = C.load('MasterStamp')

    if a.char:
        ch = resolve_char(d, a.char)
        if not ch:
            raise SystemExit('没有找到角色「%s」' % a.char)
        items = [s for s in stamps if ch['_id'] in (s.get('_characterIds') or [])]
        title = d.zh(ch['_nameTextID'])
    else:
        ch = None
        items = list(stamps)
        title = '全部贴纸'

    have = [s for s in items if stamp_path(s)]
    if not have:
        raise SystemExit('没有可用的贴纸图（art/stamp 里缺）')

    fonts = C.pick_fonts()
    accent = C.hex_rgb(ch.get('_mainColorCode'), (110, 150, 200)) if ch else (110, 150, 200)
    rows = (len(have) + COLS - 1) // COLS
    W = PAD * 2 + COLS * CELL + (COLS - 1) * GAP
    H = TITLE_H + rows * (CELL + LABEL_H) + (rows - 1) * GAP + PAD
    canvas = Image.new('RGB', (W, H), (246, 247, 250))
    dr = ImageDraw.Draw(canvas)

    dr.rectangle([0, 0, W, 8], fill=accent)
    dr.text((PAD, 30), title, font=fonts.get(34, False), fill=(38, 40, 48))
    dr.text((W - PAD, 44), '共 %d 张' % len(have), font=fonts.get(20, False),
            fill=(140, 146, 160), anchor='ra')

    for i, s in enumerate(have):
        r, c = divmod(i, COLS)
        x = PAD + c * (CELL + GAP)
        y = TITLE_H + r * (CELL + LABEL_H + GAP)
        dr.rounded_rectangle([x - 6, y - 6, x + CELL + 6, y + CELL + 6], 16,
                             fill=(255, 255, 255), outline=(226, 229, 236), width=2)
        canvas.paste(Image.open(stamp_path(s)).convert('RGB'), (x, y))
        nm = d.zh(s.get('_nameTextId')) or ''
        dr.text((x + CELL / 2, y + CELL + 20), nm[:18], font=fonts.get(17, False),
                fill=(70, 74, 86), anchor='ma')

    canvas.convert('RGB').save(a.out, quality=92)
    print('%s  %dx%d  %s  %d 张' % (a.out, W, H, title, len(have)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
