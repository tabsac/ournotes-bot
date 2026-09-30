#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""留影卡（MasterSupportCard）图：网格 + 详情，和 cardimg 的查卡一个路子。

  supportimg.py grid [--char 角色] [--ids 1,2,3] --out /tmp/s.png
  supportimg.py detail --id 64 --out /tmp/s.png

美术：
  art/support/<id>.jpg        512x288   缩略图（snap_thumbnail）
  art/support_full/<id>.jpg   1280x720  完整图（snap_full，原图 1920x1080）
"""
import argparse
import json
import os
import re
import sys

from PIL import Image, ImageDraw

ON = os.environ.get('ON_DIR', '/home/admin/bot/data/on')
sys.path.insert(0, ON)
import cardimg as C  # noqa: E402

RARITY = {4: 'SSR', 3: 'SR', 2: 'R', 10: 'BD', 20: 'EX'}
GREEN = (96, 214, 140)
ACCENT = (150, 120, 226)

GAP, MARGIN = 18, 26
TOTAL_W = 1094                    # 画布总宽固定，列数只改变每格宽度
ART_W, ART_H = 512, 288           # 2 列时的卡面尺寸（16:9）
TEXT_H = 104
CELL_H = ART_H + TEXT_H
HEADER_H = 118
FOOTER_H = 44
DETAIL_W = 1280


def load(name):
    return C.load(name)


class Support:
    def __init__(self):
        self.cards = load('MasterSupportCard')
        self.by_id = {c['_id']: c for c in self.cards}
        self.chars = {c['_id']: c for c in load('MasterCharacter')}
        self.text = {str(r['_id']): r for r in load('MasterText')}
        self.skill = {r['_id']: r for r in load('MasterSupportSkill')}
        self.geki = {r['_id']: r for r in load('MasterGekisouSupportSkill')}
        self.eff = load('MasterSupportSkillEffect')
        self.rank = load('MasterSupportCardRank')

    def zh(self, tid):
        r = self.text.get(str(tid)) or {}
        v = (r.get('_simplifiedChinese') or r.get('_japanese') or '')
        v = v.replace('\u2028', '\n').replace('\u2029', '\n').replace('\r', '')
        v = re.sub(r'[ \t]+\n', '\n', v)
        return v.strip()

    def title(self, card):
        """卡名（如「圆圆小憩」）：留影卡是 _descriptionTextID"""
        return self.zh(card['_descriptionTextID']) or ('留影 %s' % card['_id'])

    def who(self, card):
        """角色名（多个用、连起来）"""
        names = [self.zh(self.chars[i]['_nameTextID']) for i in (card.get('_characterIDs') or []) if i in self.chars]
        return '、'.join(n for n in names if n)

    def color_name(self, card):
        return self.zh('CardType_%s_Name' % {1: 'Red', 2: 'Blue', 3: 'Green', 4: 'Yellow', 5: 'Purple'}.get(card.get('_cardType'), 'Red'))

    def skill_desc(self, kind, sid):
        """技能名 + 描述：把模板里的 {effects[i].xxx}（含 /100:F0 这类格式和简单三元）
        用**最高等级**那一级的数值代进去，颜色标签清掉。条件/目标路径这类复杂占位符留「—」。"""
        table = self.skill if kind == 'support' else self.geki
        eff_table = self.eff if kind == 'support' else load('MasterGekisouSupportSkillEffect')
        key = '_supportSkillID' if kind == 'support' else '_gekisouSupportSkillID'
        sk = table.get(sid)
        if not sk:
            return None
        name = self.zh(sk['_nameTextID'])
        tpl = self.zh(sk.get('_descriptionTextFormatID') or '')
        tpl = re.sub(r'</?color[^>]*>', '', tpl)
        rows = [r for r in eff_table if r.get(key) == sid]
        fields = {}
        if rows:
            top = max(r.get('_level') or 0 for r in rows)
            lvl = sorted([r for r in rows if (r.get('_level') or 0) == top], key=lambda r: r['_id'])
            for i, r in enumerate(lvl):
                fields[(i, 'value')] = r.get('_effectValue')
                fields[(i, 'limitCount')] = r.get('_effectLimitCount')
                fields[(i, 'time')] = r.get('_activationTimeSecond')
                fields[(i, 'maxEffectValue')] = r.get('_maxEffectValue')

        def num(i, f):
            return fields.get((i, f))

        # 三元：{0 < effects[0].time ? "A" : "B"}（分支里可以是 quoted 文本或 effects[j].f ~ "后缀"）
        def tern(m):
            lhs, i, f, yes, no = m.group(1), int(m.group(2)), m.group(3), m.group(4).strip(), m.group(5).strip()
            v = num(i, f)
            if v is None:
                return no.strip('"')
            pick = yes if float(lhs) < float(v) else no
            return self._branch(pick, fields)
        tpl = re.sub(r'\{\s*([0-9.]+)\s*<\s*effects\[(\d+)\]\.([A-Za-z]+)\s*\?\s*([^{}]*?)\s*:\s*([^{}]*?)\s*\}', tern, tpl)
        # 数值 + 格式：{effects[0].value/100:F0}
        def fmt(m):
            i, f, div, spec = int(m.group(1)), m.group(2), m.group(3), m.group(4)
            v = num(i, f)
            if v is None:
                return '—'
            v = float(v) / (float(div) if div else 1.0)
            if spec is not None:
                return '%.*f' % (int(spec), v)
            return ('%g' % v)
        tpl = re.sub(r'\{effects\[(\d+)\]\.([A-Za-z]+)(?:/([0-9.]+))?(?::F(\d+))?\}', fmt, tpl)
        tpl = re.sub(r'\{[^{}]*\}', '—', tpl)            # 条件/目标这类复杂占位符
        tpl = re.sub(r'[ \t]+\n', '\n', tpl)
        return {'name': name, 'desc': tpl.strip()}

    @staticmethod
    def _branch(text, fields):
        """三元分支可能是 "文本"、effects[j].f ~ "后缀" 或 effects[j].f"""
        t = text.strip()
        m = re.fullmatch(r'effects\[(\d+)\]\.([A-Za-z]+)\s*~\s*"([^"]*)"', t)
        if m:
            v = fields.get((int(m.group(1)), m.group(2)))
            return ('%g%s' % (v, m.group(3))) if isinstance(v, (int, float)) else m.group(3)
        m = re.fullmatch(r'effects\[(\d+)\]\.([A-Za-z]+)', t)
        if m:
            v = fields.get((int(m.group(1)), m.group(2)))
            return ('%g' % v) if isinstance(v, (int, float)) else '—'
        return t.strip('"')


def find_support_art(cid, full=False):
    d = os.path.join(ON, 'art', 'support_full' if full else 'support')
    for ext in ('.jpg', '.png'):
        p = os.path.join(d, str(cid) + ext)
        if os.path.exists(p):
            return p
    return None


def render_grid(sup, cards, out_path, fonts, title=None, sub=None, cols=2):
    cols = max(1, int(cols))
    cell_w = int((TOTAL_W - MARGIN * 2 - GAP * (cols - 1)) / cols)
    art_w = cell_w
    art_h = round(art_w * 9 / 16)
    text_h = 100
    cell_h = art_h + text_h
    COLS, CELL_W = cols, cell_w
    rows = (len(cards) + COLS - 1) // COLS
    w = MARGIN * 2 + CELL_W * COLS + GAP * (COLS - 1)
    h = HEADER_H + rows * cell_h + (rows - 1) * GAP + FOOTER_H + MARGIN
    canvas = C.vertical_gradient(w, h, C.mix(ACCENT, (255, 255, 255), 0.88), (250, 250, 252)).convert('RGBA')
    dr = ImageDraw.Draw(canvas)
    dr.rectangle([0, 0, w, HEADER_H], fill=C.mix(ACCENT, (255, 255, 255), 0.74))
    dr.rectangle([0, HEADER_H - 5, w, HEADER_H], fill=ACCENT)
    dr.text((MARGIN, 20), title or '留影一览', font=fonts.get(34, True), fill=(38, 42, 52))
    if sub:
        dr.text((MARGIN + 2, 68), sub, font=fonts.get(19, False), fill=(96, 102, 116))
    dr.text((w - MARGIN, 30), '共 %d 张' % len(cards), font=fonts.get(20, True),
            fill=C.mix(ACCENT, (0, 0, 0), 0.35), anchor='ra')

    for i, c in enumerate(cards):
        r, col = divmod(i, COLS)
        x = MARGIN + col * (CELL_W + GAP)
        y = HEADER_H + r * (CELL_H + GAP)
        dr.rounded_rectangle([x, y, x + CELL_W, y + cell_h], 16, fill=(255, 255, 255),
                             outline=C.mix(ACCENT, (255, 255, 255), 0.55), width=2)
        p = find_support_art(c['_id'])
        if p:
            art = C.rounded(Image.open(p).convert('RGB').resize((art_w, art_h), Image.LANCZOS), 12)
            canvas.paste(art, (x + (CELL_W - art_w) // 2, y + 8), art)
        else:
            dr.rectangle([x + (CELL_W - art_w) // 2, y + 8, x + (CELL_W + art_w) // 2, y + 8 + art_h], fill=(226, 228, 234))
        ty = y + art_h + 20
        tfont = fonts.get(22, True)
        for line in C.wrap(dr, sup.title(c), tfont, CELL_W - 28, 2):
            dr.text((x + CELL_W / 2, ty), line, font=tfont, fill=(34, 38, 48), anchor='ma')
            ty += 28
        dr.text((x + 18, y + cell_h - 24), '%s（%s）' % (sup.who(c), RARITY.get(c['_rarity'], '')),
                font=fonts.get(18, False), fill=(120, 126, 142))
        dr.text((x + CELL_W - 18, y + cell_h - 24), 'ID:%s' % c['_id'], font=fonts.get(17, False),
                fill=(130, 134, 148), anchor='ra')

    dr.text((w / 2, h - FOOTER_H + 12), 'Our Notes · 留影（MasterSupportCard）',
            font=fonts.get(15, False), fill=(150, 154, 166), anchor='ma')
    canvas.convert('RGB').save(out_path)
    return out_path, canvas.size


def render_detail(sup, card, out_path, fonts):
    art = find_support_art(card['_id'], full=True) or find_support_art(card['_id'])
    art_w = DETAIL_W - MARGIN * 2
    art_h = round(art_w * 9 / 16)
    if art:
        im = Image.open(art).convert('RGB').resize((art_w, art_h), Image.LANCZOS)
        im = C.rounded(im, 14)
    else:
        im = None
    skills = [sup.skill_desc('support', card.get('_supportSkillId01')),
              sup.skill_desc('support', card.get('_supportSkillId02')),
              sup.skill_desc('geki', card.get('_gekisouSupportSkillId01')),
              sup.skill_desc('geki', card.get('_gekisouSupportSkillId02'))]
    skills = [s for s in skills if s and s['name']]
    diary = sup.zh(card.get('_diaryTextID') or '')
    HEAD = 96
    lines = []
    for s in skills:
        lines.append(('skill', s))
    H = HEAD + (art_h + 24 if im else 0) + 150 + sum(70 + 26 * (s['desc'].count('\n') + s['desc'].count('　') // 30 + 1) for _, s in lines) + (60 + 30 * min(6, diary.count('\n') + 1) if diary else 0) + 60
    canvas = C.vertical_gradient(DETAIL_W, H, C.mix(ACCENT, (255, 255, 255), 0.9), (250, 250, 252)).convert('RGBA')
    dr = ImageDraw.Draw(canvas)
    dr.rectangle([0, 0, DETAIL_W, HEAD], fill=C.mix(ACCENT, (255, 255, 255), 0.74))
    dr.rectangle([0, HEAD - 5, DETAIL_W, HEAD], fill=ACCENT)
    dr.text((MARGIN, 16), sup.title(card), font=fonts.get(34, True), fill=(38, 42, 52))
    dr.text((MARGIN + 2, 60), '留影卡 · ID:%s · %s' % (card['_id'], RARITY.get(card['_rarity'], '')),
            font=fonts.get(20, False), fill=(96, 102, 116))
    y = HEAD + 20
    if im:
        canvas.paste(im, (MARGIN, y), im)
        y += art_h + 20
    dr.rounded_rectangle([MARGIN, y, DETAIL_W - MARGIN, y + 128], 14, fill=(255, 255, 255),
                         outline=C.mix(ACCENT, (255, 255, 255), 0.5), width=2)
    dr.text((MARGIN + 24, y + 18), '角色', font=fonts.get(20, True), fill=(120, 126, 142))
    dr.text((MARGIN + 130, y + 16), sup.who(card), font=fonts.get(26, True), fill=(40, 44, 56))
    dr.text((MARGIN + 24, y + 66), '属性', font=fonts.get(20, True), fill=(120, 126, 142))
    dr.text((MARGIN + 130, y + 64), sup.color_name(card), font=fonts.get(24, True),
            fill=C.TYPE_COLOR.get(card.get('_cardType'), (120, 120, 120)))
    pw, tw, vw = card.get('_performancePowerMax'), card.get('_technicPowerMax'), card.get('_visualPowerMax')
    dr.text((DETAIL_W - MARGIN - 24, y + 16), '上限　表演 %s　技巧 %s　形象 %s' % (pw, tw, vw),
            font=fonts.get(22, True), fill=(60, 66, 80), anchor='ra')
    dr.text((DETAIL_W - MARGIN - 24, y + 64), '等级组 %s　突破组 %s' % (card.get('_supportCardLevelGroup'), card.get('_supportCardRankGroup')),
            font=fonts.get(20, False), fill=(120, 126, 142), anchor='ra')
    y += 150
    if skills:
        dr.text((MARGIN, y), '技能', font=fonts.get(24, True), fill=C.mix(ACCENT, (0, 0, 0), 0.2))
        y += 40
        for kind, s in lines:
            label = '支援技' if kind == 'skill' or not s else ('支援技' if card.get('_supportSkillId01') == None else '支援技')
            dr.rounded_rectangle([MARGIN, y, DETAIL_W - MARGIN, y + 24 + 26 * (s['desc'].count('\n') + 1) + 16], 12,
                                 fill=(246, 244, 252), outline=C.mix(ACCENT, (255, 255, 255), 0.6), width=1)
            dr.text((MARGIN + 18, y + 12), s['name'], font=fonts.get(23, True), fill=(52, 46, 78))
            yy = y + 44
            for line in C.wrap(dr, s['desc'], fonts.get(20, False), DETAIL_W - MARGIN * 2 - 36, 8):
                dr.text((MARGIN + 18, yy), line, font=fonts.get(20, False), fill=(70, 74, 90))
                yy += 26
            y = yy + 18
    if diary:
        dr.text((MARGIN, y), '日记', font=fonts.get(24, True), fill=C.mix(ACCENT, (0, 0, 0), 0.2))
        y += 38
        for line in C.wrap(dr, diary, fonts.get(20, False), DETAIL_W - MARGIN * 2, 6):
            dr.text((MARGIN + 4, y), line, font=fonts.get(20, False), fill=(84, 88, 104))
            y += 30
    dr.text((DETAIL_W / 2, H - 30), 'Our Notes · 数据来自游戏主数据（MasterSupportCard）',
            font=fonts.get(16, False), fill=(150, 154, 166), anchor='ma')
    canvas.convert('RGB').save(out_path)
    return out_path, canvas.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['grid', 'detail'])
    ap.add_argument('--char')
    ap.add_argument('--ids')
    ap.add_argument('--id', type=int)
    ap.add_argument('--title')
    ap.add_argument('--cols', type=int, default=2)
    ap.add_argument('--out', required=True)
    ap.add_argument('--fonts', nargs=2)
    a = ap.parse_args()
    fonts = C.pick_fonts(a.fonts)
    sup = Support()
    if a.mode == 'detail':
        card = sup.by_id.get(a.id)
        if not card:
            print('没有 ID=%s 的留影卡' % a.id)
            return 2
        out, size = render_detail(sup, card, a.out, fonts)
        print('留影详情 %s %dx%d' % (out, size[0], size[1]))
        return 0

    cards = sup.cards
    title, sub = '留影一览', None
    if a.ids:
        want = [int(x) for x in re.split(r'[,\s]+', a.ids) if x.strip().isdigit()]
        cards = [c for c in cards if c['_id'] in want]
    elif a.char:
        hit = [c for c in cards if any(sup.zh(sup.chars[i]['_nameTextID']) == a.char for i in (c.get('_characterIDs') or []) if i in sup.chars)]
        cards = hit
        title, sub = a.char, '留影卡 · 共 %d 张' % len(cards)
    cards = sorted(cards, key=lambda c: (c['_id']))
    if not cards:
        print('没有符合条件的留影卡')
        return 3
    out, size = render_grid(sup, cards, a.out, fonts, title, sub, a.cols)
    print('留影网格 %s %dx%d' % (out, size[0], size[1]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
