# -*- coding: utf-8 -*-
"""
Our Notes 卡片图片构造器（网格图 + 详情图）。

网格图 grid ：按 角色[+星级] 筛选
  * 美术 = member_thumbnail（384x512，游戏成员列表真正显示的那张）
  * 左上 = 游戏原生属性图标；右下 = 游戏原生【文字】稀有度
  * 下方 = 卡名（简体文案）+ ID

详情图 detail：单卡
  * 左 = member_full 完整卡面（1440x1920）
  * 右 = 综合力 / 三维 / 等级上限 / 特训 / 突破 / 队长技 / 演出技 / 激奏技
  * 技能描述按游戏模板渲染：{effects[i].value/100:F1}% 逐个代入各级数值，
    <color=#66FF8C> 段落用绿色绘制（与游戏一致）；中文缺文案时回落到日文原文

用法：
  python cardimg.py grid --char 灯
  python cardimg.py grid --char 灯 --rarity SR
  python cardimg.py detail --id 51
"""
import argparse
import json
import os
import re
from PIL import Image, ImageDraw, ImageFont

BASE = os.environ.get("ON_BASE") or (r"C:\Users\13766\dsh-workspace" if os.name == "nt"
                                     else "/home/admin/bot/data/on")


def _pick(*cands):
    for c in cands:
        if os.path.isdir(c):
            return c
    return cands[0]


MASTER_DIR = _pick(os.path.join(BASE, "master"), os.path.join(BASE, "masterdata", "json"))
ART_DIR = _pick(os.path.join(BASE, "art", "thumb"), os.path.join(BASE, "on_cards", "out", "thumbnail"))
FULL_DIR = _pick(os.path.join(BASE, "art", "full"), os.path.join(BASE, "on_cards", "out", "full"))
UI_DIR = _pick(os.path.join(BASE, "ui"), os.path.join(BASE, "on_cards", "ui", "attr"))
FONT_CANDIDATES = [
    (r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc"),
    ("/usr/share/fonts/wqy-microhei/wqy-microhei.ttc", "/usr/share/fonts/wqy-microhei/wqy-microhei.ttc"),
    ("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
     "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    ("/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
     "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
]

RARITY_KEY = {"SSR": 4, "SR": 3, "R": 2, "BD": 10, "EX": 20, "4": 4, "3": 3, "2": 2}
RARITY_LABEL = {4: "SSR", 3: "SR", 2: "R", 10: "BD", 20: "EX"}
TYPE_COLOR = {1: (214, 66, 74), 2: (54, 112, 200), 3: (48, 158, 108),
              4: (216, 162, 44), 5: (138, 92, 214)}
TYPE_TEXT_KEY = {1: "CardType_Red_Name", 2: "CardType_Blue_Name", 3: "CardType_Green_Name",
                 4: "CardType_Yellow_Name", 5: "CardType_Purple_Name"}
ATTR_ICON = {1: "type1_red.png", 2: "type2_blue.png", 3: "type3_green.png",
             4: "type4_gold.png", 5: "type5_purple.png"}
RARITY_ART = {4: "rarity_SSR.png", 3: "rarity_SR.png", 2: "rarity_R.png"}
GREEN = (60, 200, 120)


# ---------------------------------------------------------------- 数据
def load(name):
    with open(os.path.join(MASTER_DIR, name + ".json"), encoding="utf-8") as f:
        return json.load(f)["_allData"]


class Data:
    def __init__(self):
        self.cards = load("MasterMemberCard")
        self.by_id = {c["_id"]: c for c in self.cards}
        self.chars = {c["_id"]: c for c in load("MasterCharacter")}
        self.bands = {b["_id"]: b for b in load("MasterBand")}
        self.text = {str(r["_id"]): r for r in load("MasterText")}
        self.level = load("MasterMemberCardLevel")
        self.level_limit = load("MasterMemberCardLevelLimit")
        self.awake = load("MasterMemberCardAwake")
        self.awake_res = load("MasterMemberCardAwakeResource")
        self.rank = load("MasterMemberCardRank")
        self.leader = {r["_id"]: r for r in load("MasterLeaderSkill")}
        self.leader_eff = load("MasterLeaderSkillEffect")
        self.live = {r["_id"]: r for r in load("MasterLiveSkill")}
        self.live_eff = load("MasterLiveSkillEffect")
        self.geki = {r["_id"]: r for r in load("MasterGekisouSkill")}
        self.geki_eff = load("MasterGekisouSkillEffect")
        self.cond_set = {r["_group"]: r for r in load("MasterSkillConditionSet")}
        self.cond = {r["_id"]: r for r in load("MasterSkillCondition")}

    def cond_values(self, group):
        """技能条件组 -> 第一条条件的参数值（如 LIFE 阀值 700）"""
        s = self.cond_set.get(group)
        if not s:
            return None
        for i in s.get("_conditionIds", []):
            c = self.cond.get(i)
            if c and c.get("_conditionValues"):
                return c["_conditionValues"]
        return None

    # 文案：中文缺失时回落日文原文（本作中文表有大量空值）
    def txt(self, text_id, lang="_simplifiedChinese"):
        r = self.text.get(str(text_id))
        if not r:
            return ""
        v = r.get(lang) or ""
        if not v and lang == "_simplifiedChinese":
            v = r.get("_japanese") or ""
        return v

    def zh(self, text_id):
        return self.txt(text_id)

    def char_name(self, cid):
        c = self.chars.get(cid)
        return self.zh(c["_nameTextID"]) if c else "?"

    def band_name(self, bid):
        b = self.bands.get(bid)
        return self.zh(b["_nameTextID"]) if b else ""


class Fonts:
    def __init__(self, bold_path, reg_path):
        self.bold_path, self.reg_path = bold_path, reg_path
        self._cache = {}

    def get(self, size, bold=True):
        key = (size, bold)
        if key not in self._cache:
            self._cache[key] = ImageFont.truetype(self.bold_path if bold else self.reg_path, size)
        return self._cache[key]


def pick_fonts(explicit=None):
    for bold, reg in ([tuple(explicit)] if explicit else FONT_CANDIDATES):
        if os.path.exists(bold) and os.path.exists(reg):
            return Fonts(bold, reg)
    raise SystemExit("找不到中文字体，请用 --fonts BOLD REG 指定")


# ---------------------------------------------------------------- 通用绘图
def hex_rgb(s, default=(120, 120, 120)):
    if not s or not isinstance(s, str) or not s.startswith("#"):
        return default
    s = s.lstrip("#")[:6]
    if len(s) != 6:
        return default
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def mix(c1, c2, t):
    return tuple(int(round(a + (b - a) * t)) for a, b in zip(c1, c2))


def vertical_gradient(w, h, top, bottom):
    img = Image.new("RGB", (1, h))
    px = img.load()
    for y in range(h):
        px[0, y] = mix(top, bottom, y / max(1, h - 1))
    return img.resize((w, h))


def rounded(im, radius):
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius, fill=255)
    out = im.convert("RGBA")
    out.putalpha(mask)
    return out


def wrap(draw, text, font, max_w, max_lines=99):
    lines, cur = [], ""
    for ch in text:
        if ch == "\n":
            lines.append(cur); cur = ""; continue
        if draw.textlength(cur + ch, font=font) <= max_w:
            cur += ch
        else:
            lines.append(cur); cur = ch
    lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and draw.textlength(last + "…", font=font) > max_w:
            last = last[:-1]
        lines[-1] = last + "…"
    return lines


def find_art(kind, cid):
    """美术文件查找：本地用 PNG，服务器部署时转成 JPG，两种都要能吃到。"""
    d = ART_DIR if kind == "thumb" else FULL_DIR
    for ext in (".png", ".jpg", ".jpeg"):
        p = os.path.join(d, f"{cid}{ext}")
        if os.path.exists(p):
            return p
    return None


def paste_icon(canvas, path, box_w):
    if not path or not os.path.exists(path):
        return None
    im = Image.open(path).convert("RGBA")
    h = round(im.height * box_w / im.width)
    return im.resize((box_w, h), Image.LANCZOS)


# ================================================================ 网格图
CELL_W, ART_W, ART_H, PAD = 336, 312, 416, 12
TEXT_H = 104
CELL_H = ART_H + TEXT_H
COLS, GAP, MARGIN = 3, 14, 26
HEADER_H = 118
FOOTER_H = 44


def render_grid(d, cards, out_path, title=None, subtitle=None, accent=None, fonts=None, scale=1.0):
    rows = (len(cards) + COLS - 1) // COLS
    w = MARGIN * 2 + CELL_W * COLS + GAP * (COLS - 1)
    h = HEADER_H + rows * CELL_H + (rows - 1) * GAP + FOOTER_H + MARGIN
    accent = accent or (110, 150, 200)
    canvas = vertical_gradient(w, h, mix(accent, (255, 255, 255), 0.86), (250, 250, 252)).convert("RGBA")
    dr = ImageDraw.Draw(canvas)

    dr.rectangle([0, 0, w, HEADER_H], fill=mix(accent, (255, 255, 255), 0.72))
    dr.rectangle([0, HEADER_H - 5, w, HEADER_H], fill=accent)
    dr.text((MARGIN, 20), title or "Our Notes 卡片", font=fonts.get(34, True), fill=(38, 42, 52))
    if subtitle:
        dr.text((MARGIN + 2, 68), subtitle, font=fonts.get(19, False), fill=(96, 102, 116))
    dr.text((w - MARGIN, 30), f"共 {len(cards)} 张", font=fonts.get(20, True),
            fill=mix(accent, (0, 0, 0), 0.35), anchor="ra")

    for i, card in enumerate(cards):
        r, c = divmod(i, COLS)
        x = MARGIN + c * (CELL_W + GAP)
        y = HEADER_H + r * (CELL_H + GAP)
        dr.rounded_rectangle([x, y, x + CELL_W, y + CELL_H], 16, fill=(255, 255, 255),
                             outline=mix(accent, (255, 255, 255), 0.55), width=2)
        ax = x + (CELL_W - ART_W) // 2
        ay = y + PAD
        tcol = TYPE_COLOR.get(card["_cardType"], (140, 140, 140))
        dr.rounded_rectangle([ax - 2, ay - 2, ax + ART_W + 1, ay + ART_H + 1], 12,
                             outline=mix(tcol, (255, 255, 255), 0.25), width=3)
        art_path = find_art("thumb", card["_id"])
        if art_path:
            art = Image.open(art_path).convert("RGB").resize((ART_W, ART_H), Image.LANCZOS)
            art = rounded(art, 10)
            canvas.paste(art, (ax, ay), art)
        else:
            dr.rectangle([ax, ay, ax + ART_W, ay + ART_H], fill=(226, 228, 234))
        icon = paste_icon(canvas, os.path.join(UI_DIR, ATTR_ICON.get(card["_cardType"], "")), 34)
        if icon:
            canvas.paste(icon, (ax + 8, ay + 8), icon)
        rar_art = paste_icon(canvas, os.path.join(UI_DIR, RARITY_ART.get(card["_rarity"], "")), 76)
        if rar_art:
            canvas.paste(rar_art, (ax + ART_W - 8 - rar_art.width, ay + ART_H - 6 - rar_art.height), rar_art)
        ty = ay + ART_H + 10
        tfont = fonts.get(21, True)
        for line in wrap(dr, d.zh(card["_subtitleTextID"]), tfont, CELL_W - 28, 2):
            dr.text((x + CELL_W / 2, ty), line, font=tfont, fill=(34, 38, 48), anchor="ma")
            ty += 27
        dr.text((x + 18, y + CELL_H - 24), f"ID:{card['_id']}", font=fonts.get(17, False),
                fill=(130, 134, 148), anchor="ls")

    dr.text((w / 2, h - FOOTER_H + 12), "Our Notes · 数据来自游戏主数据 (MasterMemberCard)",
            font=fonts.get(15, False), fill=(150, 154, 166), anchor="ma")
    if scale != 1.0:
        canvas = canvas.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    canvas.convert("RGB").save(out_path, quality=92)
    return out_path, canvas.size


# ================================================================ 技能描述渲染
TAG_RE = re.compile(r"<color=#([0-9A-Fa-f]{6})>|</color>")
PH_RE = re.compile(r"\{effects\[(\d+)\]\.([^}]+)\}")


def skill_effect_rows(d, kind, skill_id):
    table = {"leader": d.leader_eff, "live": d.live_eff, "geki": d.geki_eff}[kind]
    key = {"leader": "_leaderSkillID", "live": "_liveSkillID", "geki": "_gekisouSkillID"}[kind]
    rows = [r for r in table if r.get(key) == skill_id]
    rows.sort(key=lambda r: r["_level"])
    by_level = {}
    for r in rows:
        by_level.setdefault(r["_level"], []).append(r)
    return by_level


def render_effects(d, kind, skill_id, expr):
    """{effects[i].xxx} -> 各级数值用 / 连接（与游戏内展示一致）。"""
    by_level = skill_effect_rows(d, kind, skill_id)
    levels = sorted(by_level)
    if not levels:
        return "?"
    m = re.match(r"(\d+)\.(.*)$", expr)
    if not m:
        return "?"
    idx, tail = int(m.group(1)), m.group(2)
    vals = []
    for lv in levels:
        rows = by_level[lv]
        if idx >= len(rows):
            return "?"
        r = rows[idx]
        if tail.startswith("value/100"):
            v = r["_effectValue"] / 100.0
            vals.append(f"{v:g}")
        elif tail.startswith("value"):
            vals.append(f"{r['_effectValue']}")
        elif tail.startswith("time"):
            vals.append(f"{r.get('_activationTimeSecond', 0):g}")
        elif tail.startswith("con["):
            # 形如 con[0][0].values[0]：取该效果行所属条件组的第一个参数值
            g = r.get("_skillConditionGroup") or r.get("_skillTriggerConditionGroup") or 0
            cv = d.cond_values(g)
            m2 = re.search(r"values\[(\d+)\]", tail)
            if not cv:
                return "?"
            idx2 = int(m2.group(1)) if m2 else 0
            vals.append(f"{cv[idx2]}" if idx2 < len(cv) else "?")
        else:
            return "?"
    return "/".join(vals)


def desc_segments(d, kind, skill_id, template):
    """模板切成 [(文本, 是否绿色)]，并替换 effects 占位符。"""
    segs, pos, green = [], 0, False
    for m in TAG_RE.finditer(template):
        segs.append((template[pos:m.start()], green))
        green = bool(m.group(1))
        pos = m.end()
    segs.append((template[pos:], green))
    out = []
    for text, g in segs:
        out.append((PH_RE.sub(lambda mm: render_effects(d, kind, skill_id,
                                                        mm.group(1) + "." + mm.group(2)), text), g))
    return [(t, g) for t, g in out if t]


# ================================================================ 详情图
D_ART_W, D_ART_H = 540, 720
D_PANEL_W, D_PAD = 660, 26
D_W = D_PAD + D_ART_W + 20 + D_PANEL_W + D_PAD


def draw_rich(dr, x, y, segments, font, max_w, color=(52, 56, 66), green=GREEN):
    """按段绘制（绿色段用绿色），逐字换行，返回新的 y。"""
    line_h = font.size + 7
    cx = x
    for text, is_green in segments:
        col = green if is_green else color
        for ch in text:
            if ch == "\n":
                cx = x
                y += line_h
                continue
            w = dr.textlength(ch, font=font)
            if cx + w > x + max_w:
                cx = x
                y += line_h
            dr.text((cx, y), ch, font=font, fill=col)
            cx += w
    return y + line_h


def render_detail(d, card, out_path, fonts, scale=1.0):
    cid = card["_id"]
    tcol = TYPE_COLOR.get(card["_cardType"], (140, 140, 140))
    accent = hex_rgb(d.chars.get(card["_characterID"], {}).get("_mainColorCode"), tcol)

    panel = Image.new("RGBA", (D_PANEL_W, 2600), (0, 0, 0, 0))
    p = ImageDraw.Draw(panel)
    X = 26
    y = 8

    name_font = fonts.get(36, True)
    for line in wrap(p, d.zh(card["_subtitleTextID"]), name_font, D_PANEL_W - 200, 2):
        p.text((X, y), line, font=name_font, fill=(30, 34, 44))
        y += 44
    rar_art = paste_icon(panel, os.path.join(UI_DIR, RARITY_ART.get(card["_rarity"], "")), 132)
    if rar_art:
        panel.paste(rar_art, (D_PANEL_W - X - rar_art.width, 6), rar_art)
    y += 6

    icon = paste_icon(panel, os.path.join(UI_DIR, ATTR_ICON.get(card["_cardType"], "")), 40)
    if icon:
        panel.paste(icon, (X, y), icon)
    ch = d.chars.get(card["_characterID"], {})
    head = d.char_name(card["_characterID"])
    p.text((X + 52, y + 2), head, font=fonts.get(26, True), fill=(40, 44, 56))
    meta = " ・ ".join([x for x in [d.band_name(ch.get("_bandID")), ch.get("_bandPart", ""),
                                   d.txt(TYPE_TEXT_KEY.get(card["_cardType"], ""))] if x])
    p.text((X + 56 + p.textlength(head, font=fonts.get(26, True)), y + 10), meta,
           font=fonts.get(17, False), fill=(120, 126, 140))
    y += 52

    p.text((X, y), f"ID:{cid}　稀有度:{RARITY_LABEL.get(card['_rarity'], card['_rarity'])}"
                   f"　上线:{card['_startAt']}", font=fonts.get(17, False), fill=(130, 136, 150))
    y += 30
    p.line([X, y, D_PANEL_W - X, y], fill=(224, 226, 232), width=2)
    y += 16

    perf, tech, vis = card["_performancePowerMax"], card["_technicPowerMax"], card["_visualPowerMax"]
    total = perf + tech + vis
    p.text((X, y + 12), "综合力", font=fonts.get(20, True), fill=(90, 96, 110))
    p.text((X + 88, y - 8), f"{total}", font=fonts.get(46, True), fill=tcol)
    p.text((X + 96 + p.textlength(f"{total}", font=fonts.get(46, True)), y + 14),
           f"（{perf} / {tech} / {vis}）", font=fonts.get(18, False), fill=(120, 126, 140))
    y += 62
    best = max(perf, tech, vis)
    for label, val in (("表演值", perf), ("技巧值", tech), ("形象值", vis)):
        p.text((X, y), label, font=fonts.get(17, False), fill=(96, 102, 116))
        p.text((X + 80, y - 2), f"{val}", font=fonts.get(19, True), fill=(44, 48, 58))
        bx, bw = X + 176, 300
        p.rounded_rectangle([bx, y + 4, bx + bw, y + 16], 6, fill=(232, 234, 240))
        p.rounded_rectangle([bx, y + 4, bx + max(6, int(bw * val / best)), y + 16], 6, fill=tcol)
        y += 30
    y += 4
    p.line([X, y, D_PANEL_W - X, y], fill=(224, 226, 232), width=2)
    y += 16

    lim = sorted([r for r in d.level_limit if r["_rarity"] == card["_rarity"]],
                 key=lambda r: r["_awakeCount"])
    aw = sorted([r for r in d.awake if r["_group"] == card["_memberCardAwakeGroup"]],
                key=lambda r: r["_awakeCount"])
    rk = sorted([r for r in d.rank if r["_group"] == card["_memberCardRankGroup"]],
                key=lambda r: r["_rank"])
    title_font, body_font = fonts.get(19, True), fonts.get(17, False)
    body_w = D_PANEL_W - X * 2 - 12

    def block(title, lines):
        nonlocal y
        p.text((X, y), title, font=title_font, fill=(40, 44, 56))
        y += 28
        for segs in lines:
            y = draw_rich(p, X + 12, y, segs, body_font, body_w, color=(96, 102, 116))
        y += 8

    if lim:
        block("等级上限", [[("按特训次数解锁：", False)]
                          + [(f"{r['_awakeCount']}次→Lv.{r['_limitLevel']}　", False) for r in lim]])
    if aw:
        mats = {}
        for r in d.awake_res:
            if r["_group"] == card["_memberCardAwakeResourceGroup"]:
                mats.setdefault(r["_awakeCount"], []).append(r)
        seg = [("共 4 阶，每阶 +2.5%（满阶 +10%）。首次特训材料：", False)]
        for r in mats.get(min(mats), [])[:3] if mats else []:
            seg.append((f"{d.zh('Item_Name_%d' % r['_itemId'])}×{r['_count']}　", True))
        block("特训", [seg])
    if rk:
        item_name = d.zh("Item_Name_%d" % card["_rankUpItemID"])
        block("突破", [
            [("消耗：", False), (item_name, True), ("　", False),
             (" / ".join(str(r["_requiredRankUpItemCount"]) for r in rk), True), (" 个（R1→R5）", False)],
            [("每级 +2.5%（满 +10%）；队长技 ", False), ("Lv.1→Lv.5", True),
             ("；属性/擅长加成 ", False),
             (" / ".join(f"{r['_musicTypeBonusRate']/100:.0f}%" for r in rk), True)],
        ])
    p.line([X, y, D_PANEL_W - X, y], fill=(224, 226, 232), width=2)
    y += 16

    p.text((X, y), "技能", font=fonts.get(22, True), fill=(40, 44, 56))
    y += 34
    skills = [
        ("队长技", "leader", d.leader.get(card["_leaderSkillID"]), card["_leaderSkillID"]),
        ("演出技", "live", d.live.get(card["_liveSkillID"]), card["_liveSkillID"]),
        ("激奏技", "geki", d.geki.get(card["_gekisouSkillID"]), card["_gekisouSkillID"]),
    ]
    for label, kind, row, sid in skills:
        if not row:
            continue
        tag_font = fonts.get(16, True)
        tag_w = p.textlength(label, font=tag_font) + 18
        p.rounded_rectangle([X, y - 3, X + tag_w, y + 23], 8, fill=tcol)
        p.text((X + 9, y), label, font=tag_font, fill=(255, 255, 255))
        p.text((X + tag_w + 12, y - 3), d.zh(row["_nameTextID"]) or "(无名)",
               font=fonts.get(21, True), fill=(44, 48, 58))
        y += 34
        tmpl = d.txt(row["_descriptionTextFormatID"])
        if tmpl:
            y = draw_rich(p, X + 12, y, desc_segments(d, kind, sid, tmpl),
                          fonts.get(17, False), body_w, color=(96, 102, 116))
        y += 10

    panel = panel.crop((0, 0, D_PANEL_W, min(2600, y + 10)))

    H = max(D_ART_H + D_PAD * 2, panel.height + D_PAD * 2 + 34)
    canvas = vertical_gradient(D_W, H, mix(accent, (255, 255, 255), 0.88), (250, 250, 252)).convert("RGBA")
    dr = ImageDraw.Draw(canvas)
    dr.rectangle([0, 0, D_W, 8], fill=accent)
    art_path = find_art("full", cid)
    if art_path:
        art = Image.open(art_path).convert("RGB").resize((D_ART_W, D_ART_H), Image.LANCZOS)
        dr.rounded_rectangle([D_PAD - 3, D_PAD - 3, D_PAD + D_ART_W + 2, D_PAD + D_ART_H + 2], 16,
                             outline=mix(tcol, (255, 255, 255), 0.15), width=4)
        art = rounded(art, 14)
        canvas.paste(art, (D_PAD, D_PAD), art)
    dr.rounded_rectangle([D_PAD + D_ART_W + 20, D_PAD - 6, D_W - D_PAD + 6, D_PAD + panel.height + 6],
                         16, fill=(255, 255, 255), outline=mix(accent, (255, 255, 255), 0.5), width=2)
    canvas.paste(panel, (D_PAD + D_ART_W + 26, D_PAD + 2), panel)
    dr.text((D_W / 2, H - 24), "Our Notes · 数据来自游戏主数据（养成：等级 / 特训 / 突破 / 三技能）",
            font=fonts.get(15, False), fill=(158, 162, 174), anchor="ma")

    if scale != 1.0:
        canvas = canvas.resize((max(1, int(D_W * scale)), max(1, int(H * scale))), Image.LANCZOS)
    canvas.convert("RGB").save(out_path, quality=92)
    return out_path, canvas.size


# ---------------------------------------------------------------- 查询
def find_cards(d, query, rarity, card_type=None):
    q = (query or "").strip()
    hits = []
    for c in d.cards:
        ch = d.chars.get(c["_characterID"])
        names = {str(c["_characterID"])}
        if ch:
            for lang in ("_nameTextID", "_shortNameTextID"):
                if ch.get(lang):
                    for key in ("_simplifiedChinese", "_traditionalChinese", "_japanese", "_english"):
                        names.add(d.txt(ch[lang], key))
        names = {n.replace(" ", "") for n in names if n}
        if (not q or any(q == n or q in n for n in names)) and (rarity is None or c["_rarity"] == rarity) \
                and (card_type is None or c["_cardType"] == card_type):
            hits.append(c)
    return hits


def cmd_grid(d, fonts, args):
    if args.ids:
        ids = [int(x) for x in re.split(r"[,\s]+", args.ids) if x.strip()]
        cards = [d.by_id[x] for x in ids if x in d.by_id]
        if not cards:
            raise SystemExit("没有匹配的卡片")
        cards.sort(key=lambda c: (c["_characterID"], c["_rarity"]))
        accent = hex_rgb(d.chars.get(cards[0]["_characterID"], {}).get("_mainColorCode"), (110, 150, 200))
        out = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample_grid.png")
        path, size = render_grid(d, cards, out, args.title or "Our Notes",
                                 args.sub or "", accent, fonts, scale=args.scale)
        print(f"{path}  {size[0]}x{size[1]}  {os.path.getsize(path)/1024:.0f} KB  {len(cards)} 张")
        return
    rarity = None
    if args.rarity:
        key = args.rarity.strip().upper()
        if key not in RARITY_KEY:
            raise SystemExit(f"星级只能是 {'/'.join(RARITY_KEY)}")
        rarity = RARITY_KEY[key]
    if args.all:
        cards, title = list(d.cards), "Our Notes · 全部卡片"
    else:
        cards = find_cards(d, args.char, rarity)
        if not cards:
            raise SystemExit(f"「{args.char}」没有匹配的卡片" + (f"（星级 {args.rarity}）" if args.rarity else ""))
        cards.sort(key=lambda c: (c["_characterID"], c["_rarity"]))
        ch = d.chars.get(cards[0]["_characterID"])
        title = d.zh(ch["_nameTextID"]) if ch else args.char
    accent = hex_rgb(d.chars.get(cards[0]["_characterID"], {}).get("_mainColorCode"), (110, 150, 200))
    sub = []
    if not args.all:
        sub.append(d.band_name(d.chars[cards[0]["_characterID"]]["_bandID"]))
    sub.append(RARITY_LABEL.get(rarity, "全部星级") if rarity else "全部星级")
    out = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample_grid.png")
    path, size = render_grid(d, cards, out, title, " ・ ".join([s for s in sub if s]), accent, fonts,
                             scale=args.scale)
    print(f"{path}  {size[0]}x{size[1]}  {os.path.getsize(path)/1024:.0f} KB  {len(cards)} 张")


def cmd_detail(d, fonts, args):
    if args.id is None and args.char:
        hits = find_cards(d, args.char, None)
        if not hits:
            raise SystemExit(f"「{args.char}」没有匹配的卡片")
        card = max(hits, key=lambda c: c["_rarity"])
    else:
        card = d.by_id.get(args.id)
        if not card:
            raise SystemExit(f"没有 ID={args.id} 的卡片")
    out = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample_detail.png")
    path, size = render_detail(d, card, out, fonts, scale=args.scale)
    print(f"{path}  {size[0]}x{size[1]}  {os.path.getsize(path)/1024:.0f} KB  "
          f"id={card['_id']} {RARITY_LABEL.get(card['_rarity'])} {d.zh(card['_subtitleTextID'])}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["grid", "detail"])
    ap.add_argument("--char")
    ap.add_argument("--rarity")
    ap.add_argument("--ids", help="逗号分隔的卡片 ID 列表（按团体/颜色等筛完再渲染）")
    ap.add_argument("--title", help="网格标题（配合 --ids）")
    ap.add_argument("--sub", help="标题下的小字（配合 --ids）")
    ap.add_argument("--id", type=int)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--fonts", nargs=2)
    args = ap.parse_args()
    fonts = pick_fonts(args.fonts)
    d = Data()
    if args.mode == "grid":
        return cmd_grid(d, fonts, args)
    return cmd_detail(d, fonts, args)


if __name__ == "__main__":
    main()
