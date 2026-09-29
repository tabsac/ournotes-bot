#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""当期招募（卡池）一览图，供 /on卡池 用。

版式（深色底，和游戏横幅一个色调）：
  * 顶部标题「当期招募」+ 截止日期
  * 每个 Pick Up 卡池一块：封面横幅（Gacha/Banner，从 bundle 里解出来的原图）压上期间条，
    下面依次是卡池名、概率行（成员卡 / 留影卡）、Pick Up 卡片缩略图 + 卡名 + 角色名
  * 页脚：其他在开的卡池名

数据来自 gachainfo.collect()（和文本输出同一份）。封面图缓存 data/on/art/gacha/，
由 tools/export_asset.js 从 bundle 里导出。

    gachaimg.py --out /path/out.png [--scale 1.0] [--fonts BOLD REG]
"""
import argparse
import os
import subprocess
import sys

from PIL import Image, ImageDraw

ON = os.environ.get('ON_DIR', '/home/admin/bot/data/on')
sys.path.insert(0, ON)
import cardimg as C  # noqa: E402
import gachainfo as G  # noqa: E402


def _root():
    """机器人根目录（含 tools/export_asset.js 的那层）"""
    p = os.path.abspath(ON)
    for _ in range(4):
        if os.path.exists(os.path.join(p, 'tools', 'export_asset.js')):
            return p
        np = os.path.dirname(p)
        if np == p:
            break
        p = np
    return os.path.dirname(os.path.abspath(ON))


ROOT = _root()

W = 1240
MARGIN = 30
RARITY_COLOR = {'SSR': (255, 214, 120), 'SR': (150, 200, 255), 'R': (200, 206, 220),
                'BD': (255, 170, 200), 'EX': (190, 160, 255)}
THUMB_W, THUMB_H, THUMB_GAP = 190, 252, 20
BW = 900                       # 封面宽（游戏原图 420x180，等比放大）
BH = round(BW * 180 / 420)
PAD = 22                       # 卡片内边距
GAP_BANNER = 18                # 封面 → 卡池名
NAME_H = 46                    # 卡池名一行
RATE_H = 42                    # 概率行
UP_LABEL_H = 38                # 「Pick Up」小标题
UP_TEXT_H = 8 + 52 + 28        # 缩略图下：卡名两行 + 角色名
HEADER_H = 112


def card_height(with_ups):
    h = PAD + BH + GAP_BANNER + NAME_H
    if with_ups:
        h += RATE_H + UP_LABEL_H + THUMB_H + UP_TEXT_H
    return h + PAD


def rounded(im, radius):
    mask = Image.new('L', im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius, fill=255)
    out = im.convert('RGBA')
    out.putalpha(mask)
    return out


def gradient(w, h, top, bottom):
    strip = Image.new('RGB', (1, h))
    px = strip.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(int(round(a + (b - a) * t)) for a, b in zip(top, bottom))
    return strip.resize((w, h))


def cover(asset, cache_dir):
    """封面 / LOGO：本地缓存优先，否则调 node 从 bundle 里导出"""
    if not asset:
        return None
    name = asset.rsplit('/', 1)[-1]
    out = os.path.join(cache_dir, name + '.png')
    if not os.path.exists(out) or os.path.getsize(out) < 512:
        os.makedirs(cache_dir, exist_ok=True)
        ex = os.path.join(ROOT, 'tools', 'export_asset.js')
        p = subprocess.run(['node', ex, '--asset', asset, '--out', out],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode != 0 or not os.path.exists(out):
            sys.stderr.write('封面导出失败 %s: %s\n' % (asset, p.stderr.decode('utf-8', 'ignore').strip()[:200]))
            return None
    try:
        return Image.open(out).convert('RGBA')
    except Exception as e:  # noqa: BLE001
        sys.stderr.write('封面打不开 %s: %s\n' % (out, e))
        return None


def draw_section(canvas, dr, g, fonts, top, with_ups, cache_dir):
    """一个卡池一块；返回块底部的 y（不含块间距）"""
    bottom = top + card_height(with_ups)
    dr.rounded_rectangle([MARGIN, top, W - MARGIN, bottom], 18, fill=(30, 38, 54),
                         outline=(58, 72, 100), width=2)
    # ---- 封面
    bx = (W - BW) // 2
    by = top + PAD
    img = cover(g.get('banner'), cache_dir)
    if img is not None:
        img = rounded(img.resize((BW, BH), Image.LANCZOS), 14)
        canvas.paste(img, (bx, by), img)
    else:
        dr.rounded_rectangle([bx, by, bx + BW, by + BH], 14, fill=(46, 56, 78))
        dr.text((W / 2, by + BH / 2), '封面缺失（%s）' % (g.get('banner') or '无'),
                font=fonts.get(20, False), fill=(170, 178, 196), anchor='mm')
    # 封面图上压一条期间条
    strip = Image.new('RGBA', (BW, 54), (8, 12, 22, 170))
    canvas.paste(strip, (bx, by + BH - 54), strip)
    dr.text((bx + 18, by + BH - 40), '活动期间　%s ~ %s' % (g.get('start') or '?', g.get('end') or '?'),
            font=fonts.get(22, True), fill=(240, 244, 252))
    if with_ups and g.get('pickups'):
        dr.text((bx + BW - 18, by + BH - 40), 'Pick Up %d 张' % len(g['pickups']),
                font=fonts.get(22, True), fill=(255, 214, 120), anchor='ra')
    # ---- 卡池名
    ty = by + BH + GAP_BANNER
    dr.text((W / 2, ty), g['name'], font=fonts.get(34, True), fill=(246, 248, 255), anchor='ma')
    ty += NAME_H
    # ---- 概率
    if with_ups:
        x = MARGIN + 46
        for kind, rows in g.get('rates') or []:
            label = '%s　' % kind
            dr.text((x, ty + 4), label, font=fonts.get(23, True), fill=(150, 196, 250))
            x += dr.textlength(label, font=fonts.get(23, True)) + 4
            for r, p in rows:
                seg = '%s %.1f%%' % (r, p)
                dr.text((x, ty + 4), seg, font=fonts.get(23, True), fill=RARITY_COLOR.get(r, (220, 226, 238)))
                x += dr.textlength(seg, font=fonts.get(23, True)) + 22
        ty += RATE_H
    # ---- Pick Up 缩略图
    if with_ups:
        ups = g.get('pickups') or []
        dr.text((MARGIN + 46, ty), 'Pick Up', font=fonts.get(24, True), fill=(255, 214, 120))
        ty += UP_LABEL_H
        span = len(ups) * THUMB_W + max(0, len(ups) - 1) * THUMB_GAP
        x = (W - span) // 2
        for c in ups:
            p = C.find_art('thumb', c['id'])
            if p:
                art = rounded(Image.open(p).convert('RGB').resize((THUMB_W, THUMB_H), Image.LANCZOS), 10)
                canvas.paste(art, (x, ty), art)
            else:
                dr.rounded_rectangle([x, ty, x + THUMB_W, ty + THUMB_H], 10, fill=(52, 62, 84))
            badge = C.paste_icon(canvas, os.path.join(C.UI_DIR, C.RARITY_ART.get(c['rarity'], '')), 68)
            if badge:
                canvas.paste(badge, (x + THUMB_W - badge.width - 6, ty + THUMB_H - badge.height - 4), badge)
            ny = ty + THUMB_H + 10
            for line in C.wrap(dr, c['title'], fonts.get(21, True), THUMB_W + 8, 2):
                dr.text((x + THUMB_W / 2, ny), line, font=fonts.get(21, True), fill=(238, 242, 250), anchor='ma')
                ny += 26
            dr.text((x + THUMB_W / 2, ny + 4), c['char'] or '　', font=fonts.get(18, False),
                    fill=(152, 164, 188), anchor='ma')
            x += THUMB_W + THUMB_GAP
    return bottom


def render(info, out_path, fonts, scale=1.0, cache_dir=None):
    cache_dir = os.path.abspath(cache_dir or os.path.join(C.ART_DIR, '..', 'gacha'))
    featured = info['featured'] or info['others']
    with_ups = bool(info['featured'])
    ch = card_height(with_ups)

    footer_lines = 0
    if info['others']:
        footer_lines = 1 + len(C.wrap(ImageDraw.Draw(Image.new('RGB', (10, 10))),
                                      '　'.join(g['name'] for g in info['others']),
                                      fonts.get(20, False), W - MARGIN * 2, 6))
    H = HEADER_H + 14 + sum(ch + 26 for _ in featured) + footer_lines * 30 + 76
    canvas = gradient(W, H, (24, 32, 48), (14, 18, 28)).convert('RGBA')
    dr = ImageDraw.Draw(canvas)

    # ---- 顶栏
    dr.rectangle([0, 0, W, HEADER_H], fill=(18, 24, 38))
    dr.rectangle([0, HEADER_H - 4, W, HEADER_H], fill=(96, 150, 226))
    dr.text((MARGIN, HEADER_H / 2 - 32), '当期招募', font=fonts.get(44, True), fill=(244, 247, 255))
    sub = ('Pick Up 卡池 %d 个' % len(info['featured'])) if with_ups else ('在开卡池 %d 个' % info['total'])
    if info['others']:
        sub += '　其他在开 %d 个' % len(info['others'])
    dr.text((MARGIN + 2, HEADER_H / 2 + 20), sub, font=fonts.get(20, False), fill=(150, 162, 186))
    if info.get('until'):
        dr.text((W - MARGIN, HEADER_H / 2 - 10), '至 ' + info['until'], font=fonts.get(30, True),
                fill=(255, 214, 120), anchor='ra')

    y = HEADER_H + 14
    for g in featured:
        y = draw_section(canvas, dr, g, fonts, y, with_ups, cache_dir) + 26

    # ---- 页脚：其他在开
    if info['others']:
        dr.text((MARGIN, y), '其他在开', font=fonts.get(22, True), fill=(180, 200, 232))
        y += 32
        for line in C.wrap(dr, '　'.join(g['name'] for g in info['others']), fonts.get(20, False),
                           W - MARGIN * 2, 6):
            dr.text((MARGIN, y), line, font=fonts.get(20, False), fill=(150, 162, 186))
            y += 30
    dr.text((W / 2, H - 30), 'Our Notes · 数据来自游戏主数据（MasterGacha）',
            font=fonts.get(16, False), fill=(120, 130, 150), anchor='ma')

    if scale != 1.0:
        canvas = canvas.resize((max(1, int(W * scale)), max(1, int(H * scale))), Image.LANCZOS)
    canvas.convert('RGB').save(out_path)
    return out_path, canvas.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--scale', type=float, default=1.0)
    ap.add_argument('--fonts', nargs=2)
    a = ap.parse_args()
    fonts = C.pick_fonts(a.fonts)
    info = G.collect()
    if not info['total']:
        print('现在没有正在开的招募。')
        return 3
    out, size = render(info, a.out, fonts, a.scale)
    print('卡池图 %s %dx%d' % (out, size[0], size[1]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
