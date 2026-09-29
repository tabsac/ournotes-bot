# -*- coding: utf-8 -*-
"""
Our Notes 谱面预览渲染器（独立模块，按用户规范）

规范：
  * 不要判定线
  * 长条：内部半透明、连贯、无锯齿（3 倍超采样后缩小）
  * 音符上方用 > 形小箭头区分 左滑(<<<) 右滑(>>>) 上滑(^)
  * 配色：tap #D4E2EB；长条前部 #B2C1FF；尾部与中间 #B2C1FF（中间半透明）
          左滑 #AFEECA；右滑 #FAC1D0；小键 #DBD2FD
  * 场地：24 单位宽、车道间距 4（6 条道）；横向分段，段内时间从下(早)到上(晚)

数据：谱面 JSON（gzip 解出的 notes/events）+ songs.json（曲目信息）
"""
import json
import os
from PIL import Image, ImageDraw, ImageFont

BASE = os.environ.get("ON_BASE") or ("/home/admin/bot/data/on" if os.name != "nt"
                                     else r"C:\Users\13766\dsh-workspace\on_cards")


def _pick(*c):
    for x in c:
        if os.path.isdir(x):
            return x
    return c[0]


DATA_DIR = _pick(os.path.join(BASE, "data"), BASE, "/home/admin/bot/data/on")
if not os.path.exists(os.path.join(DATA_DIR, "songs.json")):
    DATA_DIR = "/home/admin/bot/data/on" if os.name != "nt" else BASE
FONT_CANDIDATES = [
    (r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc"),
    ("/usr/share/fonts/wqy-microhei/wqy-microhei.ttc", "/usr/share/fonts/wqy-microhei/wqy-microhei.ttc"),
    ("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"),
]
DIFF_COLOR = {"EASY": (86, 196, 120), "NORMAL": (74, 144, 226), "HARD": (232, 172, 48), "EXPERT": (226, 82, 92)}

C_TAP = (0xD4, 0xE2, 0xEB)          # tap
C_LONG = (0xB2, 0xC1, 0xFF)         # 长条前部/尾部
C_LONG_MID = (0xB2, 0xC1, 0xFF, 0x8C)  # 长条中部（半透明）
C_LEFT = (0xAF, 0xEE, 0xCA)         # 左滑
C_RIGHT = (0xFA, 0xC1, 0xD0)        # 右滑
C_UP = (0xFC, 0xDB, 0xAD)           # 上滑
C_SMALL = (0xDB, 0xD2, 0xFD)        # 小键

FIELD_W = 24.0
SS = 3                              # 超采样倍数


class Fonts:
    def __init__(self, b, r):
        self.b, self.r, self.c = b, r, {}

    def get(self, size, bold=True):
        k = (size, bold)
        if k not in self.c:
            self.c[k] = ImageFont.truetype(self.b if bold else self.r, size)
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


def chart_meta(chart):
    sc = chart.get("score") or {}
    ev = sc.get("events") or {}
    bpm = (ev.get("bpm") or [{"t": 0, "bpm": 120}])[0].get("bpm", 120)
    sig = (ev.get("sig") or [{"t": 0, "sig": [4, 4]}])[0].get("sig") or [4, 4]
    notes = sc.get("notes") or []
    ticks = []
    for n in notes:
        if isinstance(n.get("t"), (int, float)):
            ticks.append(n["t"])
        for nd in (n.get("node") or []):
            if isinstance(nd.get("t"), (int, float)):
                ticks.append(nd["t"])
    tmin, tmax = (min(ticks), max(ticks)) if ticks else (0, 1)
    per = 480.0
    return {"bpm": bpm, "sig": sig, "notes": notes, "count": len(notes),
            "tmin": tmin, "tmax": tmax, "perBeat": per,
            "dur": (tmax - tmin) / per / bpm * 60.0,
            "fever": ev.get("fever") or [], "skill": ev.get("skill") or []}


def note_span(n):
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
    return (min(ts), max(ts)) if ts else None


def split_segments(notes, m, max_notes=30, max_bars=4):
    items = []
    for n in notes:
        s = note_span(n)
        if s:
            items.append((s[0], s[1], n))
    items.sort(key=lambda x: x[0])
    bar = m["perBeat"] * m["sig"][0] * max_bars
    segs, cur, t0 = [], [], None
    for st, en, n in items:
        if t0 is None:
            t0 = st
        if cur and (len(cur) >= max_notes or st - t0 > bar):
            segs.append((t0, max(x[1] for x in cur), [x[2] for x in cur]))
            cur, t0 = [], st
        cur.append((st, en, n))
    if cur:
        segs.append((t0, max(x[1] for x in cur), [x[2] for x in cur]))
    return segs


def chevron(dr, cx, cy, size, direction, color, width):
    """小箭头：left/right 为 << / >>，up 为 ^"""
    if direction == "up":
        dr.line([(cx - size, cy + size * 0.6), (cx, cy - size * 0.6)], fill=color, width=width)
        dr.line([(cx + size, cy + size * 0.6), (cx, cy - size * 0.6)], fill=color, width=width)
        return
    sgn = 1 if direction == "right" else -1
    dr.line([(cx - sgn * size, cy - size * 0.8), (cx, cy)], fill=color, width=width)
    dr.line([(cx - sgn * size, cy + size * 0.8), (cx, cy)], fill=color, width=width)


def draw_notes(layer, segs, m, fonts):
    """在超采样图层上绘制所有段（场地线、长条、音符）"""
    S = SS
    d = ImageDraw.Draw(layer, "RGBA")
    pad, header_h = 24, 108
    COLS, COL_W, COL_H, GAP = 8, 132, 660, 12

    for idx, (t0, t1, ns) in enumerate(segs):
        r, c = divmod(idx, COLS)
        cx0 = (pad + c * (COL_W + GAP)) * S
        cy0 = (pad + header_h + r * (COL_H + 34)) * S
        W = COL_W * S
        H = COL_H * S
        span = max(t1 - t0, m["perBeat"] * 4)
        d.rectangle([cx0, cy0, cx0 + W, cy0 + H], fill=(26, 29, 38, 255))
        for li in range(7):
            lx = cx0 + li / 6.0 * W
            d.line([lx, cy0, lx, cy0 + H], fill=(54, 58, 72, 255), width=max(1, S // 2))

        def sx(pos_unit):
            return cx0 + max(0.0, min(1.0, pos_unit / FIELD_W)) * W

        def sy(tt):          # 下=早、上=晚
            return cy0 + H - H * max(0.0, min(1.0, (tt - t0) / span))

        def nw(size_unit):
            return max(12.0 * S, (size_unit or 8) / FIELD_W * W)

        for n in ns:
            nodes = [nd for nd in (n.get("node") or [])
                     if isinstance(nd.get("t"), (int, float)) and isinstance(nd.get("pos"), (int, float))]
            if nodes:
                # 长条/滑条：连贯多边形（上下边缘），中部半透明、头尾实色
                pts = []
                for a, b in zip(nodes, nodes[1:]):
                    x1, y1 = sx(a["pos"] + (a.get("size") or 8) / 2), sy(a["t"])
                    x2, y2 = sx(b["pos"] + (b.get("size") or 8) / 2), sy(b["t"])
                    h1, h2 = nw(a.get("size")) / 2, nw(b.get("size")) / 2
                    steps = 12
                    for i in range(steps):
                        f = i / steps
                        pts.append((x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, h1 + (h2 - h1) * f))
                pts.append((sx(nodes[-1]["pos"] + (nodes[-1].get("size") or 8) / 2),
                            sy(nodes[-1]["t"]), nw(nodes[-1].get("size")) / 2))
                top = [(x - h, y) for x, y, h in pts]
                bot = [(x + h, y) for x, y, h in pts]
                d.polygon(top + bot[::-1], fill=C_LONG_MID)
                # 头尾实色帽
                hx, hy, hh = pts[0]
                d.rounded_rectangle([hx - hh, hy - 5 * S, hx + hh, hy + 5 * S], 3 * S, fill=C_LONG)
                tx, ty, th = pts[-1]
                end = nodes[-1]
                if end.get("type") == "flick":
                    col = C_LEFT if end.get("dir") == "left" else C_RIGHT
                else:
                    col = C_LONG
                d.rounded_rectangle([tx - th, ty - 5 * S, tx + th, ty + 5 * S], 3 * S, fill=col)
                # 中间节点用小键颜色点出
                for nd in nodes[1:-1]:
                    px, py = sx(nd["pos"] + (nd.get("size") or 8) / 2), sy(nd["t"])
                    r2 = 4 * S
                    d.ellipse([px - r2, py - r2, px + r2, py + r2], fill=C_SMALL)
                continue
            if not isinstance(n.get("t"), (int, float)) or not isinstance(n.get("pos"), (int, float)):
                continue
            x, y = sx(n["pos"] + (n.get("size") or 8) / 2), sy(n["t"])
            w = nw(n.get("size"))
            typ = n.get("type") or "tap"
            if typ == "flick":
                dr_ = n.get("dir") or "right"
                col = C_LEFT if dr_ == "left" else (C_RIGHT if dr_ == "right" else C_UP)
                d.rounded_rectangle([x - w / 2, y - 5 * S, x + w / 2, y + 5 * S], 3 * S, fill=col)
                # 音符上方的小箭头
                if dr_ == "up":
                    chevron(d, x, y - 16 * S, 8 * S, "up", col, 3 * S)
                else:
                    sgn = 1 if dr_ == "right" else -1
                    for i in range(3):
                        cxx = x + sgn * (w / 2 - 8 * S - i * 9 * S)
                        chevron(d, cxx, y - 13 * S, 7 * S, dr_, col, 3 * S)
            else:
                d.rounded_rectangle([x - w / 2, y - 5 * S, x + w / 2, y + 5 * S], 3 * S, fill=C_TAP)
        d.text((cx0 + W / 2, cy0 - 16 * S), f"#{idx + 1}", font=fonts.get(15 * S, False),
               fill=(136, 142, 156), anchor="ma")
        d.text((cx0 + W / 2, cy0 + H + 4 * S), f"{t0 / m['perBeat'] / m['bpm'] * 60:.0f}s",
               font=fonts.get(14 * S, False), fill=(118, 124, 138), anchor="ma")
    return COLS, COL_W, COL_H, GAP, pad, header_h


def render(song, diff, chart, aliases, fonts, out_path):
    m = chart_meta(chart)
    segs = split_segments(m["notes"], m, max_notes=30, max_bars=2)   # 2 小节/段：纵向时间映射×2（音符更稀松）
    COLS, COL_W, COL_H, GAP, pad, header_h = 8, 132, 660, 12, 24, 108
    rows = max(1, (len(segs) + COLS - 1) // COLS)
    W = pad * 2 + min(len(segs), COLS) * COL_W + (min(len(segs), COLS) - 1) * GAP
    H = pad + header_h + rows * (COL_H + 34) + 56
    canvas = grad(W, H, (24, 26, 34), (14, 15, 20)).convert("RGBA")
    dr = ImageDraw.Draw(canvas)
    dr.rectangle([0, 0, W, 6], fill=DIFF_COLOR.get(diff, (120, 120, 120)))
    title = song.get("title_jp") or song.get("title") or ""
    dr.text((pad + 6, pad + 6), title, font=fonts.get(32, True), fill=(240, 242, 248))
    lv = next((c["display"] for c in song["charts"] if c["name"] == diff), "?")
    combo = next((c["combo"] for c in song["charts"] if c["name"] == diff), "?")
    dr.text((pad + 8, pad + 50),
            f"{diff}  Lv.{lv}    combo {combo}    BPM {m['bpm']:g}    键数 {m['count']}"
            f"    时长 {m['dur']:.1f}s    共 {len(segs)} 段",
            font=fonts.get(20, False), fill=(172, 178, 192))
    if aliases:
        dr.text((pad + 8, pad + 78), "别名：" + "、".join(aliases)[:110],
                font=fonts.get(16, False), fill=(142, 148, 162))

    # 超采样图层：只画场地与音符，最后缩小获得平滑边缘
    layer = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    draw_notes(layer, segs, m, fonts)
    layer = layer.resize((W, H), Image.LANCZOS)
    canvas.alpha_composite(layer)

    # 底部整曲时间轴（副歌 / 技能）
    dr = ImageDraw.Draw(canvas)
    ty = H - 30
    tmin, tmax = m["tmin"], m["tmax"]
    dr.line([pad, ty - 6, W - pad, ty - 6], fill=(70, 74, 86), width=2)
    for a, b in (m["fever"] or []):
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            xa = pad + (a - tmin) / (tmax - tmin) * (W - pad * 2)
            xb = pad + (b - tmin) / (tmax - tmin) * (W - pad * 2)
            dr.rectangle([xa, ty - 10, xb, ty - 2], fill=(232, 172, 48))
    for s in (m["skill"] or []):
        if isinstance(s, (int, float)):
            xs = pad + (s - tmin) / (tmax - tmin) * (W - pad * 2)
            dr.line([xs, ty - 16, xs, ty], fill=(120, 200, 255), width=2)
    dr.text((W / 2, H - 14),
            "平面轨道·6 条道　Tap #D4E2EB　长条 #B2C1FF(中部半透明)　左滑 #AFEECA <<<　右滑 #FAC1D0 >>>　上滑 #FCDBAD ^　小键 #DBD2FD",
            font=fonts.get(13, False), fill=(140, 146, 160), anchor="ma")
    canvas.convert("RGB").save(out_path, quality=92)
    return out_path, canvas.size
