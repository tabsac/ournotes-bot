# -*- coding: utf-8 -*-
"""B25 成绩卡图 —— 按**网页版「下载图片（PNG）」那张图**的版式复刻（PIL 实现）。

网页端那张是 canvas 画的，尺寸常量（逻辑坐标）：
  列数 l=5、边距 n=44、间距 r=18、卡片 268x348、头部区 c=144、页脚区 f=96、导出放大 m=1.5
  → 逻辑画布 1500 x (144 + rows*348 + (rows-1)*18 + 96)，再 ×1.5 输出
本实现按同一套常量绘制（头像/RANK/ID/Rating/HSR + 卡片网格 + 三行页脚），
差别只在字体（服务器上只有文泉驿微米黑，没有系统 UI 粗体，用描边模拟加粗）。

入参 JSON = 云端那条 b25 的 payload 原文。
用法：python3 b25img.py --in payload.json --out out.png [--title ...]
"""
import argparse
import glob
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cardimg as C  # noqa: E402

# ---- 与网页端一致的版式常量
COLS = 5
MARGIN = 44
GAP = 18
CARD_W = 268
CARD_H = 348
HEAD_H = 144
FOOT_H = 96
SCALE = 1.5

BG_A = (18, 18, 26)        # #12121a
BG_B = (29, 27, 46)        # #1d1b2e
CARD_BG = (36, 35, 48)     # rgba(255,255,255,.06) 叠在渐变上的近似
TEXT = (255, 255, 255)
DIM = (165, 163, 191)      # #a5a3bf
DIM2 = (143, 141, 168)     # #8f8da8
DIM3 = (124, 122, 149)     # #7c7a95
DIM4 = (106, 104, 128)     # #6a6880
GOLD = (255, 214, 107)     # #ffd66b
GREEN = (126, 224, 168)    # #7ee0a8（AP）
BLUE = (127, 198, 255)     # #7fc6ff（FC）
VALUE = (231, 230, 242)    # #e7e6f2
COUNTED = (207, 206, 224)  # #cfcee0
CHIP_BG = (56, 51, 92)     # rgba(118,103,222,.28) 近似
CHIP_FG = (189, 178, 255)  # #bdb2ff

DIFF_PILL = {
    "expert": ((78, 44, 52), (255, 107, 107)),
    "hard": ((80, 68, 42), (255, 214, 107)),
    "normal": ((40, 70, 56), (126, 224, 168)),
    "easy": ((38, 62, 80), (127, 198, 255)),
}
DIFF_LABEL = {"easy": "EASY", "normal": "NORMAL", "hard": "HARD", "expert": "EXPERT", "master": "MASTER"}


def font(size, bold=False):
    """服务器只有 wqy-microhei；没有粗体字重，粗体用描边模拟"""
    for p in ("/usr/share/fonts/wqy-microhei/wqy-microhei.ttc",
              "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def text(dr, xy, s, size, fill, bold=False, anchor=None):
    f = font(size, bold)
    if bold:      # 轻微描边模拟 bold
        x, y = xy
        for dx, dy in ((1, 0), (0, 1), (1, 1)):
            dr.text((x + dx, y + dy), s, font=f, fill=fill, anchor=anchor)
    dr.text(xy, s, font=f, fill=fill, anchor=anchor)


def tw(dr, s, size, bold=False):
    return dr.textlength(s, font=font(size, bold))


def rounded(dr, box, r, fill=None, outline=None, width=1):
    dr.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def vertical_gradient(w, h, top, bottom):
    base = Image.new("RGB", (1, h))
    d = ImageDraw.Draw(base)
    for y in range(h):
        t = y / max(1, h - 1)
        d.point((0, y), fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return base.resize((w, h))


def jacket_of(entry):
    """data/on/art/jacket 里按 music_id 找封面"""
    mid = entry.get("music_id")
    if mid is None:
        return None
    for pat in ("*_%s.jpg" % mid, "*_%s.png" % mid):
        hit = sorted(glob.glob(os.path.join(HERE, "art", "jacket", pat)))
        if hit:
            return hit[0]
    return None


def avatar_of(payload):
    """头像：优先用 player.avatar_card_id / favorite_card_id 的成员卡面（cardimg.find_art）"""
    pl = payload.get("player") or {}
    for key in ("avatar_card_id", "favorite_card_id"):
        cid = pl.get(key)
        if cid:
            try:
                p = C.find_art("thumb", int(cid))
                if p and os.path.exists(p):
                    return p
            except Exception:
                pass
    return None


def fit_square(path, size):
    """读图并居中裁成正方形"""
    im = Image.open(path).convert("RGB")
    sc = size / min(im.width, im.height)
    im = im.resize((max(1, int(im.width * sc)), max(1, int(im.height * sc))), Image.LANCZOS)
    left = (im.width - size) // 2
    top = (im.height - size) // 2
    return im.crop((left, top, left + size, top + size))


def ellipse(dr, box, fill):
    dr.ellipse(box, fill=fill)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--title", default=None)
    ap.add_argument("--foot-extra", default=None, help="页脚追加一行（例如 更新日期 / 网站）")
    args = ap.parse_args()

    d = json.load(open(args.src, encoding="utf-8"))
    stats = d.get("stats") or {}
    player = d.get("player") or {}
    entries = [e for e in (d.get("entries") or []) if isinstance(e, dict)]
    name = d.get("playerName") or player.get("name") or "（未命名）"

    rows = max(1, -(-len(entries) // COLS))
    W = MARGIN * 2 + CARD_W * COLS + GAP * (COLS - 1)
    foot_extra_h = 22 if args.foot_extra else 0      # 多一行就把画布加高，别把字画到画布外
    H = HEAD_H + rows * CARD_H + (rows - 1) * GAP + FOOT_H + foot_extra_h

    canvas = vertical_gradient(W, H, BG_A, BG_B)
    canvas = canvas.resize((int(W * SCALE), int(H * SCALE)), Image.LANCZOS)
    img = Image.new("RGB", canvas.size)
    img.paste(canvas)
    dr = ImageDraw.Draw(img)

    def S(v):                       # 逻辑坐标 → 输出像素
        return v * SCALE

    # ---------------- 头部
    av_size = 104
    av = avatar_of(d)
    ax, ay = MARGIN, MARGIN
    if av:
        try:
            im = fit_square(av, int(S(av_size)))
            mask = Image.new("L", im.size, 0)
            ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1],
                                                   radius=int(S(16)), fill=255)
            img.paste(im, (int(S(ax)), int(S(ay))), mask)
        except Exception:
            rounded(dr, [S(ax), S(ay), S(ax + av_size), S(ay + av_size)], S(16), fill=(46, 45, 60))
    else:
        rounded(dr, [S(ax), S(ay), S(ax + av_size), S(ay + av_size)], S(16), fill=(46, 45, 60))

    nx = ax + av_size + 16
    text(dr, (S(nx), S(ay + 14)), name, int(S(29)), TEXT, bold=True)

    # RANK 胶囊（exp → 等级；用现成的 cardimg 里没有，就按经验表粗略折算：这里只显示 exp 档位）
    chip_y = ay + 56
    exp = player.get("exp") or 0
    rank = None
    if player.get("player_rank_raw"):
        rank = player.get("player_rank_raw")             # 游戏给的原始等级，最可信
    else:
        try:
            tbl = json.load(open(os.path.join(HERE, "art", "player_rank.json"), encoding="utf-8"))
            for r in tbl:
                if exp >= r[1]:
                    rank = r[0]
        except Exception:
            rank = None      # 没有权威等级表就不显示，宁缺勿错
    cx = nx
    if rank:
        label = "RANK %s" % rank
        w = tw(dr, label, int(S(15)), True) + S(26)
        rounded(dr, [S(cx), S(chip_y - 2), S(cx) + w, S(chip_y + 22)], S(9), fill=CHIP_BG)
        text(dr, (S(cx + 10), S(chip_y + 2)), label, int(S(15)), CHIP_FG, bold=True)
        cx += (w / SCALE) + 10
    uid = d.get("accountId") or player.get("account_id")
    if uid:
        text(dr, (S(cx), S(chip_y + 4)), "ID %s" % uid, int(S(15)), DIM)
    text(dr, (S(nx), S(chip_y + 32)),
         "共 %s 首有记录　FC %s / AP %s" % (stats.get("total_songs") or stats.get("count") or len(entries),
                                            stats.get("fc_count", "-"), stats.get("ap_count", "-")),
         int(S(14)), DIM)

    # Rating（右对齐）
    right = W - MARGIN
    text(dr, (S(right), S(MARGIN + 4)), "Rating", int(S(15)), DIM, anchor="ra")
    text(dr, (S(right), S(MARGIN + 32)), str(stats.get("rating_avg", "-")), int(S(56)), GOLD, bold=True, anchor="ra")
    text(dr, (S(right), S(MARGIN + 92)), "%s 首等级平均" % (stats.get("count") or len(entries)),
         int(S(14)), DIM2, anchor="ra")
    if stats.get("level_avg") is not None:
        text(dr, (S(right), S(MARGIN + 110)),
             "等级 %s - %s" % (stats.get("level_min"), stats.get("level_max")), int(S(13)), DIM2, anchor="ra")

    # HSR 框（HIGH SCORE RATING + 牌子）
    total_rating = stats.get("total_rating") or 0
    V, Tt = 250, 90
    # 与网页端一致：HSR 框紧跟在「名字 / RANK+ID / 记录数」这一块的右侧，
    # 而不是靠右——否则会与右边的 Rating 大数字重叠（踩过）。
    _counts = "共 %s 首有记录　FC %s / AP %s" % (
        stats.get("total_songs") or stats.get("count") or len(entries),
        stats.get("fc_count", "-"), stats.get("ap_count", "-"))
    _name_w = tw(dr, name, int(S(29)), True) / SCALE
    _counts_w = tw(dr, _counts, int(S(14))) / SCALE
    _id_w = (tw(dr, "ID %s" % uid, int(S(15))) / SCALE) if uid else 0
    _left_block = max(_name_w, _id_w, _counts_w, 130)
    box_x = min(nx + _left_block + 8, right - 150 - V)
    rounded(dr, [S(box_x), S(MARGIN + 6), S(box_x + V), S(MARGIN + 6 + Tt)], S(12), fill=(35, 33, 54))
    # 牌子：按档位（银 105500 / 金 211000）画一个圆作为近似
    medal = (176, 176, 186)
    if total_rating >= 211000:
        medal = (240, 196, 96)
    elif total_rating >= 105500:
        medal = (198, 200, 210)
    else:
        medal = (196, 138, 82)
    cx0, cy0 = box_x + 26, MARGIN + 6 + 32
    ellipse(dr, [S(cx0 - 14), S(cy0 - 14), S(cx0 + 14), S(cy0 + 14)], medal)
    for k in range(6):                       # 六颗星
        sx = cx0 - 35 + k * 14
        ellipse(dr, [S(sx - 2), S(cy0 + 26), S(sx + 2), S(cy0 + 30)], GOLD if k < 6 else (90, 90, 100))
    text(dr, (S(box_x + V - 16), S(MARGIN + 6 + 22)), "HIGH SCORE RATING", int(S(11)), (200, 196, 230), anchor="ra")
    text(dr, (S(box_x + V - 16), S(MARGIN + 6 + 46)), "{:,}".format(int(total_rating)), int(S(25)), TEXT,
         bold=True, anchor="ra")

    # ---------------- 卡片网格
    for i, e in enumerate(entries):
        col, row = i % COLS, i // COLS
        x = MARGIN + col * (CARD_W + GAP)
        y = HEAD_H + row * (CARD_H + GAP)
        rounded(dr, [S(x), S(y), S(x + CARD_W), S(y + CARD_H)], S(14), fill=CARD_BG)
        text(dr, (S(x + 12), S(y + 13)), str(i + 1), int(S(13)), (160, 160, 175), bold=True)

        # 难度胶囊（右上）
        dk = str(e.get("difficulty") or "").lower()
        bg, fg = DIFF_PILL.get(dk, ((60, 60, 74), (207, 206, 224)))
        label = e.get("difficulty_label") or DIFF_LABEL.get(dk, dk.upper())
        pw = tw(dr, label, int(S(11)), True) + S(15)
        px = x + CARD_W - 12 - pw / SCALE
        rounded(dr, [S(px), S(y + 10), S(px) + pw, S(y + 10 + 11 * 1.9)], S(int(S(8))), fill=bg)
        text(dr, (S(px + 7), S(y + 14)), label, int(S(11)), fg, bold=True)

        # 封面
        jk = jacket_of(e)
        jw = CARD_W - 24
        if jk:
            try:
                im = fit_square(jk, int(S(jw)))
                mask = Image.new("L", im.size, 0)
                ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1],
                                                       radius=int(S(10)), fill=255)
                img.paste(im, (int(S(x + 12)), int(S(y + 38))), mask)
            except Exception:
                rounded(dr, [S(x + 12), S(y + 38), S(x + 12 + jw), S(y + 38 + jw)], S(10), fill=(52, 51, 66))
        else:
            rounded(dr, [S(x + 12), S(y + 38), S(x + 12 + jw), S(y + 38 + jw)], S(10), fill=(52, 51, 66))

        # 曲名（自适应缩小 + 省略）
        nm = str(e.get("name") or "-")
        size = 15
        while size > 10 and tw(dr, nm, int(S(size)), True) > S(jw):
            size -= 1
            nm = nm if tw(dr, nm, int(S(size)), True) <= S(jw) else nm
        while tw(dr, nm + "…", int(S(size)), True) > S(jw) and len(nm) > 1:
            nm = nm[:-1]
        if tw(dr, nm, int(S(size)), True) > S(jw):
            nm = nm + "…"
        text(dr, (S(x + 12), S(y + 290)), nm, int(S(size)), TEXT, bold=True)

        # 计入值（原值 → 计入值）
        vy = y + 319
        val = str(e.get("value", "-"))
        cnt = str(e.get("counted", "-"))
        col_v = GREEN if e.get("ap") else (BLUE if e.get("fc") else VALUE)
        text(dr, (S(x + 12), S(vy)), val, int(S(20)), col_v, bold=True)
        vx = x + 12 + tw(dr, val, int(S(20)), True) / SCALE + 7
        text(dr, (S(vx), S(vy + 4)), "→", int(S(15)), DIM2)
        vx += tw(dr, "→", int(S(15))) / SCALE + 7
        text(dr, (S(vx), S(vy)), cnt, int(S(20)), COUNTED, bold=True)

        # AP / FC 徽章（右）
        if e.get("ap") or e.get("fc"):
            tag = "ALL PERFECT" if e.get("ap") else "FULL COMBO"
            tb = (86, 50, 66) if e.get("ap") else (42, 66, 88)
            tc = (255, 138, 190) if e.get("ap") else BLUE
            w2 = tw(dr, tag, int(S(12)), True) + S(17)
            rounded(dr, [S(x + CARD_W - 12) - w2, S(vy + 1), S(x + CARD_W - 12), S(vy + 1 + 12 * 1.9)],
                    S(int(S(9))), fill=tb)
            text(dr, (S(x + CARD_W - 12) - w2 + S(8), S(vy + 5)), tag, int(S(12)), tc, bold=True)

    # ---------------- 页脚（与网页端同样的三行说明）
    q = H - FOOT_H + 22
    lines = [
        "AP 记谱面等级原值；FC 记「原值 − %s」。只统计 FC / AP，「完成」不计入。Rating = 卡片这 %s 首计入值的平均，排名不看分数。"
        % (d.get("fcPenalty", 1), len(entries)),
        "选曲：账号包里游玩记录（打过就有、只增不减）中计入值最高的 25 首；同值时原值高的在前，再同按乐曲 ID 排。",
        "FC / AP 依据账号包 ClearedStatus 推断，未经官方确认，仅供参考。　Our Notes 配队助手",
    ]
    for i, ln in enumerate(lines):
        text(dr, (S(MARGIN), S(q + i * 22)), ln, int(S(13)), DIM3 if i < 2 else DIM4)
    if args.foot_extra:
        text(dr, (S(MARGIN), S(q + 3 * 22)), args.foot_extra, int(S(13)), DIM4)

    ext = os.path.splitext(args.out)[1].lower()
    if ext in (".jpg", ".jpeg"):
        # QQ 上传友好：JPEG q90（同样的 1.5× 尺寸，体积约为 PNG 的 1/6）
        img.convert("RGB").save(args.out, "JPEG", quality=90, optimize=True, progressive=True)
    else:
        img.save(args.out, optimize=True)
    print("%s  %dx%d  %d B" % (args.out, img.width, img.height, os.path.getsize(args.out)))


if __name__ == "__main__":
    main()
