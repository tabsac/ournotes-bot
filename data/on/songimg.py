# -*- coding: utf-8 -*-
"""
Our Notes 曲目图片渲染器（服务器端，只依赖 songs.json + 已导出的美术，启动快）

  songimg.py song  --id 100001 [--chart chart.json] [--aliases aliases.json] --out x.png
      曲目卡：封面 + 作曲/作词/编曲/MV/时长/发布时间/BPM/主唱 + 四难度（等级+连击数）+ 别名

  songimg.py chart --id 100001 --diff EXPERT --chart chart.json [--aliases ...] --out x.png
      谱面预览：按 t 纵向、pos 横向绘制键位（普通键/长条），带 BPM、节拍线、难度信息

数据来源：主数据（MasterLiveMusic / MasterLiveMusicScore / MasterVideo / MasterText），
谱面 JSON 由 gzip 解压 live_musicscore 的 TextAsset 得到。
"""
import argparse
import json
import os
from PIL import Image, ImageDraw, ImageFont

BASE = os.environ.get("ON_BASE") or (r"C:\Users\13766\dsh-workspace\on_cards"
                                     if os.name == "nt" else "/home/admin/bot/data/on")


def _pick(*c):
    for x in c:
        if os.path.isdir(x):
            return x
    return c[0]


DATA_DIR = _pick(os.path.join(BASE, "data"), BASE, "/home/admin/bot/data/on")
if not os.path.exists(os.path.join(DATA_DIR, "songs.json")):
    DATA_DIR = "/home/admin/bot/data/on" if os.name != "nt" else BASE
ART_DIR = _pick(os.path.join(DATA_DIR, "art"), os.path.join(BASE, "out"))
UI_DIR = _pick(os.path.join(DATA_DIR, "ui"), os.path.join(BASE, "ui", "attr"))
FONT_CANDIDATES = [
    (r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc"),
    ("/usr/share/fonts/wqy-microhei/wqy-microhei.ttc", "/usr/share/fonts/wqy-microhei/wqy-microhei.ttc"),
    ("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"),
]
TYPE_COLOR = {1: (214, 66, 74), 2: (54, 112, 200), 3: (48, 158, 108), 4: (216, 162, 44), 5: (138, 92, 214)}
ATTR_ICON = {1: "type1_red.png", 2: "type2_blue.png", 3: "type3_green.png", 4: "type4_gold.png", 5: "type5_purple.png"}
DIFF_COLOR = {"EASY": (86, 196, 120), "NORMAL": (74, 144, 226), "HARD": (232, 172, 48), "EXPERT": (226, 82, 92)}
# 音符配色（按游戏实拍：Tap 浅蓝白；Flick 按方向 粉=右 / 绿=左 / 黄=上；滑条飘带=蓝紫）
NOTE_COLORS = {
    "tap": ((214, 240, 255), (120, 190, 235)),
    "flick_right": ((255, 152, 190), (226, 92, 148)),
    "flick_left": ((132, 232, 168), (52, 176, 116)),
    "flick_up": ((255, 214, 92), (226, 160, 40)),
    "long": ((150, 170, 240), (96, 116, 200)),
}


class Fonts:
    def __init__(self, bold, reg):
        self.bold, self.reg, self.c = bold, reg, {}

    def get(self, size, bold=True):
        k = (size, bold)
        if k not in self.c:
            self.c[k] = ImageFont.truetype(self.bold if bold else self.reg, size)
        return self.c[k]


def pick_fonts():
    for b, r in FONT_CANDIDATES:
        if os.path.exists(b) and os.path.exists(r):
            return Fonts(b, r)
    raise SystemExit("找不到中文字体")


def mix(c1, c2, t):
    return tuple(int(round(a + (b - a) * t)) for a, b in zip(c1, c2))


def grad(w, h, top, bottom):
    im = Image.new("RGB", (1, h))
    px = im.load()
    for y in range(h):
        px[0, y] = mix(top, bottom, y / max(1, h - 1))
    return im.resize((w, h))


def rounded(im, r):
    m = Image.new("L", im.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], r, fill=255)
    o = im.convert("RGBA")
    o.putalpha(m)
    return o


def wrap(dr, text, font, max_w, max_lines=99):
    lines, cur = [], ""
    for ch in text:
        if dr.textlength(cur + ch, font=font) <= max_w:
            cur += ch
        else:
            lines.append(cur)
            cur = ch
    lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = lines[-1][:-1] + "…"
    return lines


def load_songs():
    for p in (os.path.join(DATA_DIR, "songs.json"), os.path.join(BASE, "songs.json")):
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return json.load(f)
    raise SystemExit("找不到 songs.json")


def load_aliases(path):
    if path and os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def art_path(kind, name):
    for ext in (".jpg", ".png"):
        p = os.path.join(ART_DIR, kind, name + ext)
        if os.path.exists(p):
            return p
    return None


def paste_img(canvas, path, box, radius=12):
    if not path or not os.path.exists(path):
        return None
    im = Image.open(path).convert("RGB").resize(box, Image.LANCZOS)
    im = rounded(im, radius)
    return im


# ================================================================ 谱面几何
def chart_meta(chart):
    ev = (chart.get("score") or {}).get("events") or {}
    bpm = ev.get("bpm") or [{"t": 0, "bpm": 120}]
    sig = (ev.get("sig") or [{"t": 0, "sig": [4, 4]}])[0].get("sig") or [4, 4]
    notes = (chart.get("score") or {}).get("notes") or []
    ticks = []
    for n in notes:
        if isinstance(n.get("t"), (int, float)):
            ticks.append(n["t"])
        for nd in (n.get("node") or []):
            if isinstance(nd.get("t"), (int, float)):
                ticks.append(nd["t"])
    tmin, tmax = (min(ticks), max(ticks)) if ticks else (0, 1)
    per_beat = 480.0
    b = bpm[0].get("bpm", 120)
    dur = (tmax - tmin) / per_beat / b * 60.0
    return {"bpm": b, "sig": sig, "tmin": tmin, "tmax": tmax, "dur": dur,
            "notes": notes, "count": len(notes), "perBeat": per_beat}


# ================================================================ 曲目卡
def render_song(song, meta_by_diff, aliases, fonts, out_path):
    W = 1120
    pad = 26
    jacket_box = (360, 360)
    body_h = jacket_box[1] + 8
    # 难度区高度
    diff_h = 132
    alias_lines = None
    alias_text = "、".join(aliases) if aliases else ""
    header_h = 96
    H = pad * 2 + header_h + body_h + 18 + diff_h + 18 + (54 + 26 * (len(wrap_str(alias_text)) if alias_text else 1))
    canvas = grad(W, H, (243, 244, 250), (252, 252, 255)).convert("RGBA")
    dr = ImageDraw.Draw(canvas)
    tcol = TYPE_COLOR.get(song.get("typeId"), (120, 130, 150))
    dr.rectangle([0, 0, W, 8], fill=tcol)

    # 标题栏
    dr.rounded_rectangle([pad, pad, W - pad, pad + header_h], 16, fill=(255, 255, 255),
                         outline=(228, 230, 238), width=2)
    title = song.get("title_jp") or song.get("title") or ""
    sub = song.get("title") if title != song.get("title") else song.get("title_en", "")
    dr.text((pad + 22, pad + 18), f"【{song['id']}】{title}", font=fonts.get(34, True), fill=(32, 36, 46))
    meta_line = " ・ ".join([x for x in [(song.get("band") or [{}])[0].get("name", ""),
                                        (song.get("type") or "") + "属性" if song.get("type") else "",
                                        f"读音 {song['phonetic']}" if song.get("phonetic") and song["phonetic"] != title else ""] if x])
    dr.text((pad + 24, pad + 62), meta_line, font=fonts.get(18, False), fill=(120, 126, 140))
    icon = None
    if song.get("typeId") in ATTR_ICON:
        icon = paste_img(canvas, os.path.join(UI_DIR, ATTR_ICON[song["typeId"]]), (54, 54), 0)
    if icon:
        canvas.paste(icon, (W - pad - 78, pad + 20), icon)

    # 封面 + 信息
    y = pad + header_h + 18
    jk = paste_img(canvas, art_path("jacket", song.get("jacket", "")), jacket_box, 14)
    if jk:
        canvas.paste(jk, (pad, y), jk)
    else:
        dr.rectangle([pad, y, pad + jacket_box[0], y + jacket_box[1]], fill=(228, 230, 236))
    ix = pad + jacket_box[0] + 26
    iw = W - pad - ix
    rows = [
        ("作曲", song.get("composer") or "-"),
        ("作词", song.get("lyricist") or "-"),
        ("编曲", song.get("arranger") or "-"),
        ("MV", (f"有 ({song['mv']['w']}×{song['mv']['h']})" if song.get("mv") else "无")),
        ("发布时间", (song.get("releaseAt") or "").strip()),
    ]
    ry = y + 6
    for label, val in rows:
        dr.text((ix, ry), label, font=fonts.get(21, True), fill=(96, 102, 116))
        dr.text((ix + 130, ry), val, font=fonts.get(21, False), fill=(36, 40, 50))
        ry += 38
    # 难度里的 BPM / 时长（取最高难度那张谱面）
    best = None
    for d in ("EXPERT", "HARD", "NORMAL", "EASY"):
        if d in meta_by_diff:
            best = meta_by_diff[d]
            break
    if best:
        dr.text((ix, ry), "BPM", font=fonts.get(21, True), fill=(96, 102, 116))
        dr.text((ix + 130, ry), f"{best['bpm']:g}", font=fonts.get(21, False), fill=(36, 40, 50))
        ry += 38
        dr.text((ix, ry), "时长", font=fonts.get(21, True), fill=(96, 102, 116))
        dr.text((ix + 130, ry), f"{best['dur']:.1f} 秒（{int(best['dur']//60)}分{best['dur']%60:.1f}秒）",
                font=fonts.get(21, False), fill=(36, 40, 50))
        ry += 38
    # 主唱
    dr.text((ix, ry), "主唱", font=fonts.get(21, True), fill=(96, 102, 116))
    vx = ix + 130
    for v in (song.get("vocals") or [])[:6]:
        av = paste_img(canvas, art_path("thumb", str(v.get("avatarCard") or "")), (46, 61), 8)
        if av:
            canvas.paste(av, (vx, ry - 6), av)
            vx += 52
    dr.text((vx + 4, ry), "、".join(v["name"] for v in (song.get("vocals") or [])[:6]),
            font=fonts.get(19, False), fill=(60, 66, 78))

    # 难度框
    y = pad + header_h + 18 + body_h + 18
    charts = song.get("charts") or []
    box_w = (W - pad * 2 - 18 * (max(1, len(charts)) - 1)) // max(1, len(charts))
    for i, c in enumerate(charts):
        bx = pad + i * (box_w + 18)
        col = DIFF_COLOR.get(c["name"], (120, 120, 120))
        dr.rounded_rectangle([bx, y, bx + box_w, y + 56], 12, fill=col)
        dr.text((bx + 16, y + 10), c["name"], font=fonts.get(22, True), fill=(255, 255, 255))
        lv = f"{c['display']:g}" if isinstance(c["display"], (int, float)) else str(c["level"])
        dr.text((bx + box_w - 16, y + 6), lv, font=fonts.get(32, True), fill=(255, 255, 255), anchor="ra")
        dr.text((bx + box_w / 2, y + 72), f"{c['combo']} combo", font=fonts.get(19, True), fill=(70, 76, 90), anchor="ma")
    # 别名
    ay = y + diff_h
    dr.rounded_rectangle([pad, ay, W - pad, ay + 44 + 24 * max(0, len(wrap_str(alias_text)) - 1)], 12,
                         fill=(255, 255, 255), outline=(230, 232, 240), width=2)
    dr.text((pad + 18, ay + 12), "别名", font=fonts.get(20, True), fill=(96, 102, 116))
    if alias_text:
        yy = ay + 13
        for line in wrap(dr, alias_text, fonts.get(19, False), W - pad * 2 - 110):
            dr.text((pad + 100, yy), line, font=fonts.get(19, False), fill=(52, 58, 70))
            yy += 24
    else:
        dr.text((pad + 100, ay + 13), "（无，可用 /on添加别名 曲名 别名 添加）",
                font=fonts.get(19, False), fill=(150, 154, 166))
    canvas.convert("RGB").save(out_path, quality=92)
    return out_path, canvas.size


def wrap_str(text, width=60):
    return [text[i:i + width] for i in range(0, max(1, len(text)), width)] if text else [""]


# ================================================================ 谱面预览
def note_t(n):
    t = n.get("t")
    if isinstance(t, (int, float)):
        return t
    for nd in (n.get("node") or []):
        if isinstance(nd.get("t"), (int, float)):
            return nd["t"]
    return None


def note_span(n):
    """返回 (起始t, 结束t, [pos...])"""
    ts, ps = [], []
    for nd in (n.get("node") or []):
        if isinstance(nd.get("t"), (int, float)):
            ts.append(nd["t"])
        if isinstance(nd.get("pos"), (int, float)):
            ps.append(nd["pos"])
    if not ts and isinstance(n.get("t"), (int, float)):
        ts.append(n["t"])
        if isinstance(n.get("pos"), (int, float)):
            ps.append(n["pos"])
    if not ts:
        return None
    return (min(ts), max(ts), ps)


def split_segments(notes, m, max_notes=26, max_bars=4):
    """分段：每段不超过 max_notes 个音符、不超过 max_bars 小节（防挤、且段长可控）"""
    items = []
    for n in notes:
        s = note_span(n)
        if s:
            items.append((s[0], s[1], n))
    items.sort(key=lambda x: x[0])
    bar_ticks = m["perBeat"] * m["sig"][0] * max_bars
    segs, cur, t0 = [], [], None
    for st, en, n in items:
        if t0 is None:
            t0 = st
        if cur and (len(cur) >= max_notes or st - t0 > bar_ticks):
            segs.append((t0, max(x[1] for x in cur), [x[2] for x in cur]))
            cur, t0 = [], st
        cur.append((st, en, n))
    if cur:
        segs.append((t0, max(x[1] for x in cur), [x[2] for x in cur]))
    return segs


NOTE_TEX_CACHE = {}


def note_tex(name):
    """读取音符材质贴图（游戏真实材质：发光渐变带 alpha）"""
    if name in NOTE_TEX_CACHE:
        return NOTE_TEX_CACHE[name]
    for d in (os.path.join(ART_DIR, "note"), os.path.join(DATA_DIR, "art", "note"),
              os.path.join(BASE, "note_out"), os.path.join(BASE, "on_cards", "note_out")):
        p = os.path.join(d, name)
        if os.path.exists(p):
            NOTE_TEX_CACHE[name] = Image.open(p).convert("RGBA")
            return NOTE_TEX_CACHE[name]
    NOTE_TEX_CACHE[name] = None
    return None


def blit_tex(canvas, tex_name, box, tint=None, alpha=1.0):
    """按 box 贴材质贴图（可染色/调透明度）；返回是否命中贴图"""
    tex = note_tex(tex_name)
    if tex is None:
        return False
    w, h = max(1, int(box[2] - box[0])), max(1, int(box[3] - box[1]))
    im = tex.resize((w, h), Image.LANCZOS)
    if tint:
        col = Image.new("RGBA", (w, h), tint + (255,))
        col.putalpha(im.getchannel("A"))
        im = col
    if alpha < 1.0:
        im.putalpha(im.getchannel("A").point(lambda v: int(v * alpha)))
    canvas.alpha_composite(im, (int(box[0]), int(box[1])))
    return True


def _render_chart_delegate(song, diff, chart, aliases, fonts, out_path, ease=None):
    """谱面预览委托给独立模块 chartimg（无判定线/长条半透明无锯齿/>形方向箭头/指定配色）"""
    import importlib, sys
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    return importlib.import_module("chart3").render(song, diff, chart, aliases, fonts, out_path, ease)


def render_chart(song, diff, chart, aliases, fonts, out_path):
    """谱面预览：横向分段，每段按游戏实际的梯形透视渲染。

    几何依据（主数据 + 资源包实测）：
      * 场地：宽 24 单位，车道间距 4，中心 12（tut_flick 用 8/12/16，timing_adjust 中心 12）
      * 音符：tick 时间；tap={t,pos,size}；flick=+type:"flick"（可能有 dir=left/right）；
              long={type:"long",node:[{t,pos,size,ease?}]}，末节点也可能是 flick
      * 显示：梯形透视（lane_mesh 为四边形网格 + 相机透视；lane_base 顶端收敛成一点）
    """
    m = chart_meta(chart)
    segs = split_segments(m["notes"], m, max_notes=30, max_bars=4)
    COLS, COL_W, COL_H, GAP = 8, 132, 660, 12
    rows = max(1, (len(segs) + COLS - 1) // COLS)
    pad = 22
    header_h = 104
    row_h = COL_H + 32
    W = pad * 2 + min(len(segs), COLS) * COL_W + (min(len(segs), COLS) - 1) * GAP
    H = pad + header_h + rows * row_h + 54
    canvas = grad(W, H, (26, 28, 36), (16, 17, 22)).convert("RGBA")
    dr = ImageDraw.Draw(canvas)
    dr.rectangle([0, 0, W, 6], fill=DIFF_COLOR.get(diff, (120, 120, 120)))
    title = song.get("title_jp") or song.get("title") or ""
    dr.text((pad + 6, pad + 6), title, font=fonts.get(30, True), fill=(240, 242, 248))
    lv = next((c["display"] for c in song["charts"] if c["name"] == diff), "?")
    combo = next((c["combo"] for c in song["charts"] if c["name"] == diff), "?")
    info = (f"{diff}  Lv.{lv}    combo {combo}    BPM {m['bpm']:g}    "
            f"键数 {m['count']}    时长 {m['dur']:.1f}s    共 {len(segs)} 段")
    dr.text((pad + 8, pad + 48), info, font=fonts.get(19, False), fill=(170, 176, 190))
    if aliases:
        dr.text((pad + 8, pad + 74), "别名：" + "、".join(aliases)[:100],
                font=fonts.get(16, False), fill=(140, 146, 160))

    FIELD_W = 24.0
    for idx, (t0, t1, ns) in enumerate(segs):
        r, c = divmod(idx, COLS)
        cx0 = pad + c * (COL_W + GAP)
        cy0 = pad + header_h + r * row_h
        span = max(t1 - t0, m["perBeat"] * 4)
        y_top, y_bot = cy0 + 14, cy0 + COL_H - 14
        y_judge = y_bot - 10

        # 场地（平面矩形）+ 车道线
        dr.rectangle([cx0, y_top, cx0 + COL_W, y_bot], fill=(26, 29, 38))
        for li in range(7):
            lx = cx0 + li / 6.0 * COL_W
            dr.line([lx, y_top, lx, y_bot], fill=(54, 58, 72), width=1)
        # 水平判定线（紫）—— 恢复到平面版
        dr.line([cx0, y_judge, cx0 + COL_W, y_judge], fill=(158, 126, 224), width=3)
        def sx(pos_unit):
            return cx0 + max(0.0, min(1.0, pos_unit / FIELD_W)) * COL_W

        def sy(tt):
            # 时间轴：下=早、上=晚（与游戏观感一致：越早的音符越靠近判定处）
            return y_bot - (y_bot - y_top) * max(0.0, min(1.0, (tt - t0) / span))

        def note_w(size_unit):
            return max(12.0, (size_unit or 8) / FIELD_W * COL_W)

        for n in ns:
            nodes = [nd for nd in (n.get("node") or [])
                     if isinstance(nd.get("t"), (int, float)) and isinstance(nd.get("pos"), (int, float))]
            if nodes:
                # Long / 滑条：按节点之间的真实时长画成实体条带（宽度 = size），端帽区分起止与甩尾
                for a, b in zip(nodes, nodes[1:]):
                    x1, y1 = sx(a["pos"] + (a.get("size") or 8) / 2), sy(a["t"])
                    x2, y2 = sx(b["pos"] + (b.get("size") or 8) / 2), sy(b["t"])
                    h1, h2 = note_w(a.get("size")) / 2, note_w(b.get("size")) / 2
                    steps = max(2, int(abs(y2 - y1) / 4) + 1)
                    for i in range(steps):
                        f = i / steps
                        xx = x1 + (x2 - x1) * f
                        yy = y1 + (y2 - y1) * f
                        hh = h1 + (h2 - h1) * f
                        dr.rectangle([xx - hh, yy - 3, xx + hh, yy + 3], fill=(96, 214, 160))
                for nd, is_end in ((nodes[0], False), (nodes[-1], True)):
                    xx = sx(nd["pos"] + (nd.get("size") or 8) / 2)
                    yy = sy(nd["t"])
                    ww = note_w(nd.get("size"))
                    flick_end = is_end and nd.get("type") == "flick"
                    col = (255, 150, 190) if flick_end else ((236, 242, 250) if not is_end else (170, 245, 205))
                    dr.rounded_rectangle([xx - ww / 2, yy - 5, xx + ww / 2, yy + 5], 3, fill=col)
                continue
            if not isinstance(n.get("t"), (int, float)) or not isinstance(n.get("pos"), (int, float)):
                continue
            x, y = sx(n["pos"] + (n.get("size") or 8) / 2), sy(n["t"])
            w = note_w(n.get("size"))
            typ = n.get("type") or "tap"
            col = (255, 150, 190) if typ == "flick" else (238, 242, 250)
            dr.rounded_rectangle([x - w / 2, y - 4, x + w / 2, y + 4], 3, fill=col)
            if typ == "flick":
                d = n.get("dir")
                if d == "left":
                    dr.polygon([(x - w / 2 - 7, y), (x - w / 2, y - 5), (x - w / 2, y + 5)], fill=col)
                elif d == "right":
                    dr.polygon([(x + w / 2 + 7, y), (x + w / 2, y - 5), (x + w / 2, y + 5)], fill=col)
        dr.text((cx0 + COL_W / 2, cy0 - 4), f"#{idx + 1}", font=fonts.get(15, False),
                fill=(136, 142, 156), anchor="ma")
        dr.text((cx0 + COL_W / 2, cy0 + COL_H + 2), f"{t0 / m['perBeat'] / m['bpm'] * 60:.0f}s",
                font=fonts.get(14, False), fill=(118, 124, 138), anchor="ma")
    # 底部整曲时间轴
    ev = (chart.get("score") or {}).get("events") or {}
    tmin, tmax = m["tmin"], m["tmax"]
    ty = H - 28
    dr.line([pad, ty - 6, W - pad, ty - 6], fill=(70, 74, 86), width=2)
    for a, b in (ev.get("fever") or []):
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            xa = pad + (a - tmin) / (tmax - tmin) * (W - pad * 2)
            xb = pad + (b - tmin) / (tmax - tmin) * (W - pad * 2)
            dr.rectangle([xa, ty - 9, xb, ty - 3], fill=(232, 172, 48))
    for s in (ev.get("skill") or []):
        if isinstance(s, (int, float)):
            xs = pad + (s - tmin) / (tmax - tmin) * (W - pad * 2)
            dr.line([xs, ty - 14, xs, ty - 1], fill=(120, 200, 255), width=2)
    dr.text((W / 2, H - 13), "场地24单位 / 车道间距4　白=Tap　粉=Flick(方向箭头)　绿带=Long·滑条(长度=实际持续)　紫线=判定线",
            font=fonts.get(13, False), fill=(142, 148, 162), anchor="ma")
    canvas.convert("RGB").save(out_path, quality=92)
    return out_path, canvas.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["song", "chart"])
    ap.add_argument("--id", type=int, required=True)
    ap.add_argument("--diff", default="EXPERT")
    ap.add_argument("--chart")
    ap.add_argument("--aliases")
    ap.add_argument("--ease", default=None,
                    choices=["linear", "quad", "cubic", "smooth"],
                    help="长条曲线族；linear=全画直线（对比用）")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    fonts = pick_fonts()
    data = load_songs()
    song = next((s for s in data["songs"] if s["id"] == a.id), None)
    if not song:
        raise SystemExit(f"没有 ID={a.id} 的曲目")
    al = load_aliases(a.aliases).get(str(a.id), [])
    if a.mode == "song":
        meta = {}
        if a.chart and os.path.exists(a.chart):
            with open(a.chart, encoding="utf-8") as f:
                meta["EXPERT"] = chart_meta(json.load(f))
        elif a.chart:
            pass
        p, size = render_song(song, meta, al, fonts, a.out)
    else:
        if not a.chart or not os.path.exists(a.chart):
            raise SystemExit("缺少谱面 JSON（--chart）")
        with open(a.chart, encoding="utf-8") as f:
            ch = json.load(f)
        p, size = _render_chart_delegate(song, a.diff, ch, al, fonts, a.out, getattr(a, 'ease', None))
    print(f"{p}  {size[0]}x{size[1]}  {os.path.getsize(p)/1024:.0f} KB  {song.get('title')}")


if __name__ == "__main__":
    main()
