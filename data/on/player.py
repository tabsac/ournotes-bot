# -*- coding: utf-8 -*-
"""Our Notes 玩家名片图（好友接口的公开资料）

入参 JSON（on_commands.js 组装）：
  { name, profileId, rank, rankExp, rankNextExp, friendMax, lastUpdatedAt,
    card: { name, charName, rarity, cardRank, awake, liveSkill, perfSkill, art },
    profileCard: { slot, name, images: [本地路径, ...] },
    note }
用法：python3 player.py --in payload.json --out out.png
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cardimg as C  # noqa: E402

W = 1000
PAD = 34
BG = (18, 20, 28)
PANEL = (28, 32, 44)
PANEL2 = (36, 41, 56)
LINE = (58, 64, 82)
TEXT = (232, 236, 246)
DIM = (146, 156, 176)
DIM2 = (104, 114, 136)
ACCENT = (94, 176, 255)
ACCENT2 = (255, 118, 168)
GOLD = (240, 196, 96)
RARITY_COLOR = {4: (226, 170, 60), 3: (150, 170, 230), 2: (150, 160, 175), 10: (120, 210, 190), 20: (220, 130, 200)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--fonts", nargs=2, default=None)
    args = ap.parse_args()
    d = json.load(open(args.src, encoding="utf-8"))
    F = C.pick_fonts(args.fonts)

    card = d.get("card") or {}
    pc = d.get("profileCard") or {}
    shots = [p for p in (pc.get("images") or []) if p and os.path.exists(p)]
    has_card = bool(card.get("art") and os.path.exists(card["art"]))
    card_h = 300 if has_card else 0
    H = 190 + (card_h + 40 if has_card else 0) + max(280, 190 * max(1, len(shots))) + 120
    img = Image.new("RGB", (W, H), BG)
    dr = ImageDraw.Draw(img)
    dr.rectangle([0, 0, W, 4], fill=ACCENT2)
    dr.text((PAD, 18), "玩家名片", font=F.get(26), fill=DIM)
    tag = "游戏内公开资料"
    tw = dr.textlength(tag, font=F.get(15))
    dr.text((W - PAD - tw, 24), tag, font=F.get(15), fill=DIM2)

    y = 64
    # ---------------- 名字 / ID / 等级
    dr.text((PAD, y), d.get("name") or "未知玩家", font=F.get(38), fill=TEXT)
    nw = dr.textlength(d.get("name") or "未知玩家", font=F.get(38))
    dr.text((PAD + nw + 12, y + 16), "#" + str(d.get("profileId") or "-"), font=F.get(20), fill=DIM)
    y += 52
    bits = []
    if d.get("rank"):
        bits.append("RANK %s" % d["rank"])
    if d.get("friendMax"):
        bits.append("好友上限 %s" % d["friendMax"])
    if d.get("lastUpdatedAt"):
        bits.append("资料更新 " + d["lastUpdatedAt"])
    dr.text((PAD, y), "　".join(bits), font=F.get(17), fill=DIM)
    y += 30
    if d.get("rankExp") is not None:
        exp = int(d.get("rankExp") or 0)
        nxt = d.get("rankNextExp")
        txt = "经验 %s" % exp
        if nxt and int(nxt) > exp:
            txt += " / %s" % nxt
        dr.text((PAD, y), txt, font=F.get(15), fill=DIM2)
        y += 26
    y += 6

    # ---------------- 资料卡（游戏内那张名片图）
    dr.text((PAD, y), "资料卡", font=F.get(19), fill=TEXT)
    if pc.get("name"):
        dr.text((PAD + 70, y + 4), pc["name"], font=F.get(15), fill=DIM)
    y += 30
    if shots:
        boxh = 190
        for i, p in enumerate(shots[:4]):
            bx = PAD + (i % 2) * (W - PAD * 2 + 12) // 2
            by = y + (i // 2) * (boxh + 14)
            bw = (W - PAD * 2 - 12) // 2
            dr.rounded_rectangle([bx - 2, by - 2, bx + bw + 2, by + boxh + 2], radius=10, fill=PANEL)
            try:
                im = Image.open(p).convert("RGB")
                sc = min(bw / im.width, boxh / im.height)
                im = im.resize((max(1, int(im.width * sc)), max(1, int(im.height * sc))), Image.LANCZOS)
                img.paste(im, (bx + (bw - im.width) // 2, by + (boxh - im.height) // 2))
            except Exception as e:
                dr.text((bx + 10, by + 10), "资料卡图片读取失败", font=F.get(14), fill=DIM2)
        y += ((len(shots[:4]) + 1) // 2) * (boxh + 14) + 8
    else:
        dr.rounded_rectangle([PAD, y, W - PAD, y + 60], radius=10, fill=PANEL)
        dr.text((PAD + 16, y + 18), "这位玩家还没有设置资料卡", font=F.get(16), fill=DIM2)
        y += 72

    # ---------------- 看板卡
    if has_card:
        dr.text((PAD, y), "看板卡", font=F.get(19), fill=TEXT)
        y += 30
        dr.rounded_rectangle([PAD, y, W - PAD, y + card_h], radius=12, fill=PANEL)
        art = Image.open(card["art"]).convert("RGB")
        ah = card_h - 24
        sc = min(190 / art.width, ah / art.height)
        art = art.resize((max(1, int(art.width * sc)), max(1, int(art.height * sc))), Image.LANCZOS)
        img.paste(art, (PAD + 12, y + 12))
        tx = PAD + 12 + art.width + 22
        dr.text((tx, y + 16), card.get("name") or "-", font=F.get(26), fill=TEXT)
        rc = RARITY_COLOR.get(int(card.get("rarity") or 0), DIM)
        rar = C.RARITY_LABEL.get(int(card.get("rarity") or 0), "")
        if rar:
            dr.text((tx, y + 56), rar, font=F.get(18), fill=rc)
        if card.get("charName"):
            dr.text((tx + (60 if rar else 0), y + 58), card["charName"], font=F.get(16), fill=DIM)
        rows = []
        if card.get("cardRank"):
            rows.append(("卡牌等级", "RANK %s" % card["cardRank"]))
        if card.get("awake"):
            rows.append(("觉醒", "%s 次" % card["awake"]))
        if card.get("liveSkill"):
            rows.append(("演出技能", "Lv.%s" % card["liveSkill"]))
        if card.get("perfSkill"):
            rows.append(("技巧技能", "Lv.%s" % card["perfSkill"]))
        ry = y + 92
        for k, v in rows:
            dr.text((tx, ry), k, font=F.get(15), fill=DIM2)
            dr.text((tx + 110, ry), str(v), font=F.get(16), fill=TEXT)
            ry += 28
        y += card_h + 16

    y += 6
    dr.line([PAD, y, W - PAD, y], fill=LINE)
    dr.text((PAD, y + 10), d.get("note") or "数据来自游戏内好友搜索能看到的那份公开资料。", font=F.get(13), fill=DIM2)
    y += 38
    img.crop((0, 0, W, min(H, y))).convert("RGB").save(args.out, quality=92)
    print(args.out)


if __name__ == "__main__":
    main()
