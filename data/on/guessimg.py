#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""猜卡用的卡面局部切片：从整张卡面里随机剪一小块，放大后发出去当谜面。

  guessimg.py --id 51 --size 160 --out /tmp/g.png [--scale 3] [--seed 12345]
  guessimg.py --id 51 --show            只打印选中的框，不写文件

选块策略：优先在中部区域（角色一般在这儿）随机取 size×size，
算一下这块的像素标准差，太平（纯色背景/渐变）就重抽，最多 12 次；实在不行取正中间。
"""
import argparse
import os
import random
import sys

from PIL import Image, ImageStat

ON = os.environ.get('ON_DIR', '/home/admin/bot/data/on')
FULL_DIRS = [os.path.join(ON, 'art', 'full'), os.path.join(ON, 'on_cards', 'out', 'full')]


def full_art(card_id):
    for d in FULL_DIRS:
        for ext in ('.png', '.jpg', '.jpeg'):
            p = os.path.join(d, '%s%s' % (card_id, ext))
            if os.path.exists(p):
                return p
    return None


def pick_box(im, size, rng, tries=12):
    w, h = im.size
    size = max(24, min(size, min(w, h)))
    x0, x1 = int(w * 0.18), int(w * 0.82) - size
    y0, y1 = int(h * 0.10), int(h * 0.80) - size
    if x1 <= x0:
        x0, x1 = 0, max(0, w - size)
    if y1 <= y0:
        y0, y1 = 0, max(0, h - size)
    best = None
    for _ in range(tries):
        x = rng.randint(x0, max(x0, x1))
        y = rng.randint(y0, max(y0, y1))
        crop = im.crop((x, y, x + size, y + size))
        sd = sum(ImageStat.Stat(crop.convert('L')).stddev)
        if best is None or sd > best[0]:
            best = (sd, x, y)
        if sd > 18:                      # 够有信息量就不用再抽
            return (x, y, sd)
    _, x, y = best
    return (x, y, best[0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--id', type=int, required=True)
    ap.add_argument('--size', type=int, default=160, help='切片边长（原图 1440x1920，默认 160）')
    ap.add_argument('--scale', type=float, default=3.0, help='放大倍数')
    ap.add_argument('--out')
    ap.add_argument('--seed', type=int)
    ap.add_argument('--show', action='store_true')
    a = ap.parse_args()

    p = full_art(a.id)
    if not p:
        print('没有卡片 %s 的完整卡面' % a.id)
        return 2
    im = Image.open(p).convert('RGB')
    rng = random.Random(a.seed) if a.seed is not None else random.Random()
    x, y, sd = pick_box(im, a.size, rng)
    crop = im.crop((x, y, x + a.size, y + a.size))
    print('卡片 %s：%s 取框 (%d,%d) %dx%d 标准差 %.1f' % (a.id, os.path.basename(p), x, y, a.size, a.size, sd))
    if a.show:
        return 0
    if a.scale != 1.0:
        crop = crop.resize((int(a.size * a.scale), int(a.size * a.scale)), Image.LANCZOS)
    if not a.out:
        print('要 --out <png>')
        return 2
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    crop.save(a.out)
    print('写出 %s %dx%d' % (a.out, crop.size[0], crop.size[1]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
