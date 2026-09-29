#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""效益 / 效率排行图

  /on效益排行 [ex|hd|nor|ez] [整数难度]   —— 效益 = 单局理论最高分（按主数据表推算）
  /on效率排行 [ex|hd|nor|ez] [整数难度]   —— 效率 = 效益 / 时长（分/秒）

数据来自 tools/build_score.py 生成的 data/on/score.json。
版式参考社区榜：排名 | 歌曲 | 难度 | 效益 | 时长 | 效率
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageDraw

ON = os.environ.get('ON_DIR', '/home/admin/bot/data/on')
sys.path.insert(0, ON)
import cardimg as C  # noqa: E402

DIFFS = ('EASY', 'NORMAL', 'HARD', 'EXPERT')
DIFF_COLOR = {'EASY': (86, 196, 120), 'NORMAL': (74, 144, 226),
              'HARD': (232, 172, 48), 'EXPERT': (226, 82, 92)}
W = 1180
PAD = 26
HEADER_H = 128
ROW_H = 46
TOPN = 40

COL = [('排名', 96, 'c'), ('歌曲', 470, 'l'), ('难度', 118, 'c'),
       ('效益', 168, 'r'), ('时长', 120, 'r'), ('效率', 130, 'r')]


def load_json(name, default=None):
    p = os.path.join(ON, name)
    if not os.path.exists(p):
        return default
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def ellipsize(draw, text, font, max_w):
    if draw.textlength(text, font=font) <= max_w:
        return text
    while text and draw.textlength(text + '…', font=font) > max_w:
        text = text[:-1]
    return text + '…'


def rank_color(i):
    if i == 1:
        return (232, 172, 48)
    if i == 2:
        return (168, 176, 190)
    if i == 3:
        return (198, 138, 92)
    return (108, 116, 132)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--by', choices=['benefit', 'eff'], default='benefit')
    ap.add_argument('--diff', default='EXPERT')
    ap.add_argument('--level', type=int)
    ap.add_argument('--top', type=int, default=TOPN)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    diff = a.diff.upper()
    if diff not in DIFFS:
        raise SystemExit('难度只能是 %s' % ' / '.join(DIFFS))
    data = load_json('score.json')
    if not data or not data.get('rows'):
        raise SystemExit('缺少 score.json，请先跑 tools/build_score.py')
    songs = {s['id']: s for s in (load_json('songs.json') or {}).get('songs', [])}

    rows = [r for r in data['rows'] if r['diff'] == diff
            and (a.level is None or int(r['level'] or 0) == a.level)]
    if not rows:
        raise SystemExit('%s 没有 Lv.%s 的数据' % (diff, a.level if a.level is not None else '?'))
    key = 'benefit' if a.by == 'benefit' else 'eff'
    rows.sort(key=lambda r: -r[key])
    total = len(rows)
    rows = rows[:max(1, a.top)]

    fonts = C.pick_fonts()
    color = DIFF_COLOR[diff]
    head_h = HEADER_H
    H = head_h + ROW_H * len(rows) + 58
    im = Image.new('RGB', (W, H), (255, 255, 255))
    dr = ImageDraw.Draw(im)

    # 顶部难度色条 + 标题
    dr.rectangle([0, 0, W, 8], fill=color)
    title = '歌曲效益排行' if a.by == 'benefit' else '歌曲效率排行'
    sub = '单局理论最高分' if a.by == 'benefit' else '单局理论最高分 ÷ 时长'
    dr.text((PAD, 26), title, font=fonts.get(38, True), fill=(28, 32, 42))
    dr.text((PAD + (dr.textlength(title, font=fonts.get(38, True))) + 16, 40),
            '（%s）' % sub, font=fonts.get(19, False), fill=(120, 126, 140))
    p = data.get('params') or {}
    dr.text((PAD, 76),
            '%s%s    %d 首（表内前 %d）    效益 = 基础分 %g × Σ(1+连击加成) × (1+技能 %d%%)'
            % (diff, ('  Lv.%d' % a.level) if a.level is not None else '',
               total, len(rows), p.get('base', 0), round(100 * (p.get('skillBonus') or 0))),
            font=fonts.get(15, False), fill=(132, 138, 152))

    # 表头
    y = head_h - 30
    x = PAD
    for name, w, al in COL:
        if al == 'c':
            dr.text((x + w / 2, y), name, font=fonts.get(17, True), fill=(96, 102, 116), anchor='ma')
        elif al == 'r':
            dr.text((x + w - 12, y), name, font=fonts.get(17, True), fill=(96, 102, 116), anchor='ra')
        else:
            dr.text((x + 12, y), name, font=fonts.get(17, True), fill=(96, 102, 116))
        x += w
    dr.line([PAD, head_h - 10, W - PAD, head_h - 10], fill=(214, 218, 226), width=2)

    # 行
    for i, r in enumerate(rows, 1):
        ry = head_h + (i - 1) * ROW_H
        if i % 2 == 0:
            dr.rectangle([PAD - 6, ry, W - PAD + 6, ry + ROW_H - 4], fill=(248, 249, 252))
        x = PAD
        # 排名
        dr.text((x + 48, ry + ROW_H / 2 - 10), '%d' % i, font=fonts.get(24, True),
                fill=rank_color(i), anchor='ma')
        x += COL[0][1]
        # 歌曲
        s = songs.get(r['id']) or {}
        name = s.get('title_jp') or s.get('title') or str(r['id'])
        sub2 = s.get('title') if name != s.get('title') else s.get('title_en', '')
        dr.text((x + 12, ry + 4), ellipsize(dr, name, fonts.get(21, True), COL[1][1] - 24),
                font=fonts.get(21, True), fill=(30, 34, 44))
        dr.text((x + 12, ry + 26), ellipsize(dr, str(sub2 or ''), fonts.get(14, False), COL[1][1] - 24),
                font=fonts.get(14, False), fill=(126, 132, 146))
        x += COL[1][1]
        # 难度
        lv = r['level']
        chip = '%s %s' % (diff[:2], ('%g' % lv) if lv is not None else '-')
        cw = dr.textlength(chip, font=fonts.get(16, True)) + 22
        cx = x + (COL[2][1] - cw) / 2
        dr.rounded_rectangle([cx, ry + 9, cx + cw, ry + 37], 13, fill=color)
        dr.text((cx + cw / 2, ry + 15), chip, font=fonts.get(16, True), fill=(255, 255, 255), anchor='ma')
        x += COL[2][1]
        # 效益 / 时长 / 效率
        dr.text((x + COL[3][1] - 12, ry + 10), '{:,}'.format(r['benefit']), font=fonts.get(20, True),
                fill=(46, 52, 64), anchor='ra')
        x += COL[3][1]
        sec = r['dur']
        dr.text((x + COL[4][1] - 12, ry + 11), '%d:%02d' % (sec // 60, round(sec % 60)),
                font=fonts.get(19, False), fill=(70, 76, 90), anchor='ra')
        x += COL[4][1]
        dr.text((x + COL[5][1] - 12, ry + 10), '{:,.0f}'.format(r['eff']), font=fonts.get(20, True),
                fill=(196, 92, 46) if a.by == 'eff' else (46, 52, 64), anchor='ra')

    dr.text((W / 2, H - 30),
            '效益 = 单局理论最高分（基础分 × 连击加成累计 × 技能加成）；效率 = 效益 ÷ 时长　—— 用 /on谱面预览 <曲名> 看具体谱面',
            font=fonts.get(14, False), fill=(142, 148, 162), anchor='ma')
    im.save(a.out, quality=92)
    return a.out, im.size


if __name__ == '__main__':
    p, size = main()
    print('%s  %dx%d' % (p, size[0], size[1]))
