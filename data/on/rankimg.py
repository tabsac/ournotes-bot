#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""难度排行图：/on难度排行 [ex|hd|nor|ez] [整数难度]

版式参考 Moenotes 的难度表：左边一个难度色块（带小数的难度），右边一张白卡里排该难度的
封面缩略图。按难度从大到小分组（同一小数的曲目排在一起），每组内按物量从多到少。

  /on难度排行 25        -> EXPERT 25.0~25.9
  /on难度排行 ex 25     -> 同上
  /on难度排行 hd        -> HARD 全部难度段
"""
import argparse
import collections
import json
import os
import sys

from PIL import Image, ImageDraw

ON = os.environ.get('ON_DIR', '/home/admin/bot/data/on')
sys.path.insert(0, ON)
import cardimg as C  # noqa: E402

SONGS = os.path.join(ON, 'songs.json')
JACKET = os.path.join(ON, 'art', 'jacket')
DIFFS = ('EASY', 'NORMAL', 'HARD', 'EXPERT')
DIFF_COLOR = {'EASY': (86, 196, 120), 'NORMAL': (74, 144, 226),
              'HARD': (232, 172, 48), 'EXPERT': (226, 82, 92)}

W = 1200
PAD = 28
BADGE_W, BADGE_H = 108, 56
GAP_X = 18
THUMB = 112
TITLE_H = 36
CELL_W = 128
CELL_H = THUMB + TITLE_H
CGAP = 8
CARD_PAD = 10
HEADER_H = 132
GROUP_GAP = 16
FOOTER_H = 54


def load_songs():
    with open(SONGS, encoding='utf-8') as f:
        return json.load(f)['songs']


def rows_for(songs, diff, level):
    out = []
    for s in songs:
        for c in (s.get('charts') or []):
            if c.get('name') != diff:
                continue
            d = c.get('display')
            if d is None:
                continue
            if level is None or int(d) == level:
                out.append((float(d), c.get('combo') or 0, c.get('level') or 0, s))
    out.sort(key=lambda x: (-x[0], -x[1], x[3]['id']))
    return out


def jacket_img(song, size):
    p = os.path.join(JACKET, str(song.get('jacket') or '') + '.jpg')
    if not os.path.exists(p):
        p = os.path.join(JACKET, 'jacket_temporary.jpg')
    if not os.path.exists(p):
        return Image.new('RGB', (size, size), (222, 226, 234))
    return Image.open(p).convert('RGB').resize((size, size), Image.LANCZOS)


def ellipsize(draw, text, font, max_w):
    if draw.textlength(text, font=font) <= max_w:
        return text
    while text and draw.textlength(text + '…', font=font) > max_w:
        text = text[:-1]
    return text + '…'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--diff', default='EXPERT')
    ap.add_argument('--level', type=int)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    diff = a.diff.upper()
    if diff not in DIFFS:
        raise SystemExit('难度只能是 %s' % ' / '.join(DIFFS))
    songs = load_songs()
    rows = rows_for(songs, diff, a.level)
    if not rows:
        avail = collections.Counter()
        for s in songs:
            for c in (s.get('charts') or []):
                if c.get('name') == diff and c.get('display') is not None:
                    avail[int(c['display'])] += 1
        raise SystemExit('%s 没有 Lv.%s 的曲目。可选：%s'
                         % (diff, a.level if a.level is not None else '?',
                            '、'.join('%d(%d)' % (k, avail[k]) for k in sorted(avail, reverse=True))))

    groups = collections.OrderedDict()
    for d, combo, lv, s in rows:
        groups.setdefault(d, []).append((combo, s))

    fonts = C.pick_fonts()
    color = DIFF_COLOR[diff]
    card_x = PAD + BADGE_W + GAP_X
    card_w = W - PAD - card_x
    per_row = max(1, int((card_w - CARD_PAD * 2 + CGAP) // (CELL_W + CGAP)))

    # 先量高度
    geom = []
    for d, items in groups.items():
        nrow = (len(items) + per_row - 1) // per_row
        h = CARD_PAD * 2 + nrow * CELL_H + (nrow - 1) * CGAP
        geom.append((d, items, nrow, h))

    H = HEADER_H + sum(h + GROUP_GAP for _, _, _, h in geom) + FOOTER_H
    canvas = Image.new('RGB', (W, H), (247, 248, 251))
    dr = ImageDraw.Draw(canvas, 'RGBA')
    dr.rectangle([0, 0, W, 8], fill=color)

    lv_txt = ('Lv.%d' % a.level) if a.level is not None else '全部难度'
    dr.text((PAD + 4, 26), '%s 难度排行' % diff, font=fonts.get(38, True), fill=(34, 36, 44))
    dr.text((PAD + 6, 78), '%s　按难度从高到低（含小数）　共 %d 首' % (lv_txt, len(rows)),
            font=fonts.get(20, False), fill=(132, 138, 152))
    dr.text((W - PAD, 40), 'Our Notes', font=fonts.get(24, True), fill=color, anchor='ra')

    y = HEADER_H
    for d, items, nrow, h in geom:
        # 白卡
        dr.rounded_rectangle([card_x, y, card_x + card_w, y + h], 14,
                             fill=(255, 255, 255), outline=(226, 229, 236), width=2)
        # 左侧难度色块
        by = y + (h - BADGE_H) / 2
        dr.rounded_rectangle([PAD, by, PAD + BADGE_W, by + BADGE_H], 12, fill=color)
        label = ('%.1f' % d)
        dr.text((PAD + BADGE_W / 2, by + BADGE_H / 2), label,
                font=fonts.get(30, True), fill=(255, 255, 255), anchor='mm')
        dr.text((PAD + BADGE_W / 2, by + BADGE_H + 14), '%d 首' % len(items),
                font=fonts.get(15, False), fill=(150, 156, 170), anchor='ma')

        for i, (combo, s) in enumerate(items):
            r, c = divmod(i, per_row)
            x = card_x + CARD_PAD + c * (CELL_W + CGAP)
            yy = y + CARD_PAD + r * (CELL_H + CGAP)
            th = jacket_img(s, THUMB)
            canvas.paste(th, (int(x), int(yy)))
            dr.rectangle([x, yy, x + THUMB, yy + THUMB], outline=(228, 231, 238), width=1)
            name = s.get('title') or s.get('title_jp') or ''
            name = ellipsize(dr, name, fonts.get(14, False), CELL_W - 4)
            dr.text((x + THUMB / 2, yy + THUMB + 8), name,
                    font=fonts.get(14, False), fill=(64, 68, 80), anchor='ma')
        y += h + GROUP_GAP

    dr.text((PAD + 4, H - 34), '数据来自游戏主数据（MasterLiveMusicScore 的难度值）',
            font=fonts.get(15, False), fill=(158, 162, 174))

    canvas.convert('RGB').save(a.out, quality=92)
    print('%s  %dx%d  %s %s  %d 首 / %d 组' % (a.out, W, H, diff, lv_txt, len(rows), len(groups)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
