# -*- coding: utf-8 -*-
"""
Our Notes 谱面预览渲染器 v2（取代 chartimg.py）

本版改动（按用户 7 条规范）：
 1. 修正甩键方向：谱面数据 dir 只有 left/right，缺省 = 上滑(^)（之前误默认成右滑）
 2. 所有音符（tap / 长条起始 / 滑键）改为「边框 + 略微透明内部」
 3. 长条中段的小圆改成正菱形
 4. 方向箭头整体下移，下端略微与音符重合
 5. 按 BPM 在谱面上画节拍线（画在音符下方/之前）
 6. 左侧外侧留出边栏：每个音符位置画短线，并标注 4分/8分/16分/32分 节奏提示
 7. 分段改为「从下到上」排列：第 1 段在左下角，向上排满一列再向右

配色：tap #D4E2EB｜长条 #B2C1FF(中部半透明)｜左滑 #AFEECA｜右滑 #FAC1D0｜上滑 #FCDBAD｜小键 #DBD2FD
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

C_TAP = (0xD4, 0xE2, 0xEB)
C_LONG = (0xB2, 0xC1, 0xFF)
C_LEFT = (0xAF, 0xEE, 0xCA)
C_RIGHT = (0xFA, 0xC1, 0xD0)
C_UP = (0xFC, 0xDB, 0xAD)
C_SMALL = (0xDB, 0xD2, 0xFD)
C_BEAT = (58, 64, 80)
C_BARLINE = (96, 104, 126)
C_TICK = (150, 158, 176)

FIELD_W = 24.0
SS = 3                      # 超采样
GUT = 34                    # 左侧边栏（节奏标注用）
COL_W, COL_H, GAP = 168, 660, 12
COLS = 8
PAD, HEADER_H, ROW_GAP = 24, 108, 34
FILL_A = 168                # 内部透明度（约 66%）
EDGE_W = 3                  # 边框粗细(超采样前)

RHYTHM = [(480, "4分"), (240, "8分"), (120, "16分"), (60, "32分"), (30, "64分")]


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
    return {"bpm": bpm, "sig": sig, "notes": notes, "count": len(notes), "tmin": tmin, "tmax": tmax,
            "perBeat": per, "dur": (tmax - tmin) / per / bpm * 60.0,
            "fever": ev.get("fever") or [], "skill": ev.get("skill") or []}


def note_span(n):
    ts = []
    for nd in (n.get("node") or []):
        if isinstance(nd.get("t"), (int, float)):
            ts.append(nd["t"])
    if not ts and isinstance(n.get("t"), (int, float)):
        ts.append(n["t"])
    return (min(ts), max(ts)) if ts else None


def split_segments(notes, m, max_notes=30, max_bars=2):
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


RHYTHM_NUM = [(480, "4"), (240, "8"), (120, "16"), (60, "32"), (30, "64")]


def rhythm_label(tick, all_ticks):
    """按「与相邻音符间距的最小值」判定节奏细分：480→4　240→8　120→16　60→32　30→64"""
    best = None
    for x in all_ticks:
        if x == tick:
            continue
        g = abs(x - tick)
        if best is None or g < best:
            best = g
    if best is None:
        return "4"
    for div, name in RHYTHM_NUM:
        if best >= div:
            return name
    return "64"


def flick_dir(n):
    """甩键方向：dir 缺省 = 上滑（谱面数据只有 left/right）"""
    d = n.get("dir")
    if d == "left":
        return "left"
    if d == "right":
        return "right"
    if d == "up":
        return "up"
    return "up"


def color_of(direction):
    return {"left": C_LEFT, "right": C_RIGHT, "up": C_UP}[direction]


def note_box(d, x, y, w, col, hh=5):
    """边框 + 略微透明内部"""
    e = EDGE_W * SS / 2.0        # 边框画在外侧，避免吃掉音符宽度
    d.rounded_rectangle([x - w / 2 - e, y - hh - e, x + w / 2 + e, y + hh + e], 3 * SS,
                        fill=col + (FILL_A,), outline=col + (255,), width=int(EDGE_W * SS))


def chevron(d, cx, cy, size, direction, col, width):
    """'>' 形小箭头；下端略微与音符重合（cy 已下移）"""
    if direction == "up":
        d.line([(cx - size, cy + size * 0.55), (cx, cy - size * 0.45)], fill=col + (255,), width=width)
        d.line([(cx + size, cy + size * 0.55), (cx, cy - size * 0.45)], fill=col + (255,), width=width)
        return
    sgn = 1 if direction == "right" else -1
    d.line([(cx - sgn * size, cy - size * 0.8), (cx, cy)], fill=col + (255,), width=width)
    d.line([(cx - sgn * size, cy + size * 0.8), (cx, cy)], fill=col + (255,), width=width)


def draw_all(layer, segs, m, rows, used_cols):
    d = ImageDraw.Draw(layer, "RGBA")
    per = m["perBeat"]
    bar_ticks = per * m["sig"][0]
    for idx, (t0, t1, ns) in enumerate(segs):
        # 从左到右、从下到上：先填最下面一行（左→右），再往上一行；最后一段落在最上面一行最右
        col_i = idx % used_cols
        group = idx // used_cols
        row_i = rows - 1 - group
        rem = len(segs) % used_cols
        if rem and group == rows - 1:      # 最上面一行没填满 → 右对齐（最后一段在该行最右）
            col_i += used_cols - rem
        cx0 = (PAD + col_i * (COL_W + GAP)) * SS
        cy0 = (PAD + HEADER_H + row_i * (COL_H + ROW_GAP)) * SS
        W, H = (COL_W - GUT) * SS, COL_H * SS
        fx = cx0 + GUT * SS                       # 场地左边界
        span = max(t1 - t0, per * 4)
        d.rectangle([fx, cy0, fx + W, cy0 + H], fill=(26, 29, 38, 255))

        def sx(pos_unit):
            return fx + max(0.0, min(1.0, pos_unit / FIELD_W)) * W

        def sy(tt):          # 下=早，上=晚
            return cy0 + H - H * max(0.0, min(1.0, (tt - t0) / span))

        # 节拍线（音符下方）：小节线更亮
        bt = t0 - (t0 % per)
        while bt <= t1 + per:
            yy = sy(bt)
            if cy0 <= yy <= cy0 + H:
                strong = (bt % bar_ticks) == 0
                d.line([fx, yy, fx + W, yy], fill=(C_BARLINE if strong else C_BEAT) + (255,),
                       width=(2 * SS if strong else SS))
            bt += per
        # 车道线
        for li in range(7):
            lx = fx + li / 6.0 * W
            d.line([lx, cy0, lx, cy0 + H], fill=(54, 58, 72, 255), width=max(1, SS // 2))

        def nw(size_unit):
            return max(12.0 * SS, (size_unit or 8) / FIELD_W * W)

        labels = []
        all_ticks = []
        for _x in segs:
            for _nn in _x[2]:
                if isinstance(_nn.get("t"), (int, float)):
                    all_ticks.append(_nn["t"])
                for _nd in (_nn.get("node") or []):
                    if isinstance(_nd.get("t"), (int, float)):
                        all_ticks.append(_nd["t"])
        for n in ns:
            nodes = [nd for nd in (n.get("node") or [])
                     if isinstance(nd.get("t"), (int, float)) and isinstance(nd.get("pos"), (int, float))]
            if nodes:
                # 长条：连贯多边形（中部半透明），头尾与滑键用「边框+半透明内部」
                pts = []
                for a, b in zip(nodes, nodes[1:]):
                    x1, y1 = sx(a["pos"] + (a.get("size") or 8) / 2), sy(a["t"])
                    x2, y2 = sx(b["pos"] + (b.get("size") or 8) / 2), sy(b["t"])
                    h1, h2 = nw(a.get("size")) / 2, nw(b.get("size")) / 2
                    for i in range(12):
                        f = i / 12
                        pts.append((x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, h1 + (h2 - h1) * f))
                last = nodes[-1]
                pts.append((sx(last["pos"] + (last.get("size") or 8) / 2), sy(last["t"]),
                            nw(last.get("size")) / 2))
                top = [(x - h, y) for x, y, h in pts]
                bot = [(x + h, y) for x, y, h in pts]
                d.polygon(top + bot[::-1], fill=C_LONG + (0x8C,))
                # 头（起始键）
                hx, hy, hh = pts[0]
                note_box(d, hx, hy, hh * 2, C_LONG)
                # 尾
                tx, ty, th = pts[-1]
                end_dir = flick_dir(last) if last.get("type") == "flick" else None
                note_box(d, tx, ty, th * 2, color_of(end_dir) if end_dir else C_LONG)
                if end_dir:
                    chevron_down(d, tx, ty, th * 2, end_dir)
                # 中段：正菱形
                for nd in nodes[1:-1]:
                    px, py = sx(nd["pos"] + (nd.get("size") or 8) / 2), sy(nd["t"])
                    rr = 5 * SS
                    d.polygon([(px, py - rr), (px + rr, py), (px, py + rr), (px - rr, py)],
                              fill=C_SMALL + (255,), outline=C_LONG + (255,))
                labels.append((sy(nodes[0]["t"]), nodes[0]["t"]))
                continue
            if not isinstance(n.get("t"), (int, float)) or not isinstance(n.get("pos"), (int, float)):
                continue
            x, y = sx(n["pos"] + (n.get("size") or 8) / 2), sy(n["t"])
            w = nw(n.get("size"))
            typ = n.get("type") or "tap"
            if typ == "flick":
                dr_ = flick_dir(n)
                col = color_of(dr_)
                note_box(d, x, y, w, col)
                chevron_down(d, x, y, w, dr_)
            else:
                note_box(d, x, y, w, C_TAP)
            labels.append((y, n["t"]))

        # 左边栏：每个音符位置的短线与节奏标注（隐形延长线只画短线，不画整条）
        last_lab_y = None
        for _, tk in sorted(labels):
            yy = sy(tk)
            if not (cy0 - 4 * SS <= yy <= cy0 + H + 4 * SS):
                continue
            d.line([cx0 + 2 * SS, yy, cx0 + (GUT - 8) * SS, yy], fill=C_TICK + (255,), width=2 * SS)
            if last_lab_y is None or abs(yy - last_lab_y) > 16 * SS:
                d.text((cx0 + (GUT - 6) * SS, yy - 3 * SS), rhythm_label(tk, all_ticks),
                       font=fonts_global.get(12 * SS, False), fill=C_TICK + (255,), anchor="rs")
                last_lab_y = yy
        d.text((cx0 + (GUT + (COL_W - GUT) / 2) * SS, cy0 - 16 * SS), f"#{idx + 1}",
               font=fonts_global.get(15 * SS, False), fill=(136, 142, 156), anchor="ma")
        d.text((cx0 + (GUT + (COL_W - GUT) / 2) * SS, cy0 + H + 4 * SS),
               f"{t0 / per / m['bpm'] * 60:.0f}s", font=fonts_global.get(14 * SS, False),
               fill=(118, 124, 138), anchor="ma")


fonts_global = None


def chevron_down(d, x, y, w, direction, size=7, drop=9):
    """方向箭头：整体下移 drop 像素，下端略微与音符重合"""
    col = color_of(direction)
    if direction == "up":
        chevron(d, x, y - (drop - 2) * SS, size * SS, "up", col, 3 * SS)
        return
    sgn = 1 if direction == "right" else -1
    for i in range(3):
        cx = x + sgn * (w / 2 - 9 * SS - i * 9 * SS)
        chevron(d, cx, y - drop * SS, size * SS, direction, col, 3 * SS)


def render(song, diff, chart, aliases, fonts, out_path):
    global fonts_global
    fonts_global = fonts
    m = chart_meta(chart)
    segs = split_segments(m["notes"], m, max_notes=30, max_bars=2)
    n = len(segs)
    used_cols = min(COLS, max(1, n))          # 行内从左到右
    rows = max(1, (n + used_cols - 1) // used_cols)   # 行自下而上
    W = PAD * 2 + used_cols * COL_W + (used_cols - 1) * GAP
    H = PAD + HEADER_H + rows * (COL_H + ROW_GAP) + 56
    canvas = grad(W, H, (24, 26, 34), (14, 15, 20)).convert("RGBA")
    dr = ImageDraw.Draw(canvas)
    dr.rectangle([0, 0, W, 6], fill=DIFF_COLOR.get(diff, (120, 120, 120)))
    title = song.get("title_jp") or song.get("title") or ""
    dr.text((PAD + 6, PAD + 6), title, font=fonts.get(32, True), fill=(240, 242, 248))
    lv = next((c["display"] for c in song["charts"] if c["name"] == diff), "?")
    combo = next((c["combo"] for c in song["charts"] if c["name"] == diff), "?")
    dr.text((PAD + 8, PAD + 50),
            f"{diff}  Lv.{lv}    combo {combo}    BPM {m['bpm']:g}    键数 {m['count']}"
            f"    时长 {m['dur']:.1f}s    共 {len(segs)} 段（从下到上）",
            font=fonts.get(20, False), fill=(172, 178, 192))
    if aliases:
        dr.text((PAD + 8, PAD + 78), "别名：" + "、".join(aliases)[:110],
                font=fonts.get(16, False), fill=(142, 148, 162))

    layer = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    draw_all(layer, segs, m, rows, used_cols)
    canvas.alpha_composite(layer.resize((W, H), Image.LANCZOS))

    dr = ImageDraw.Draw(canvas)
    ty = H - 30
    tmin, tmax = m["tmin"], m["tmax"]
    dr.line([PAD, ty - 6, W - PAD, ty - 6], fill=(70, 74, 86), width=2)
    for a, b in (m["fever"] or []):
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            xa = PAD + (a - tmin) / (tmax - tmin) * (W - PAD * 2)
            xb = PAD + (b - tmin) / (tmax - tmin) * (W - PAD * 2)
            dr.rectangle([xa, ty - 10, xb, ty - 2], fill=(232, 172, 48))
    for s in (m["skill"] or []):
        if isinstance(s, (int, float)):
            xs = PAD + (s - tmin) / (tmax - tmin) * (W - PAD * 2)
            dr.line([xs, ty - 16, xs, ty], fill=(120, 200, 255), width=2)
    dr.text((W / 2, H - 14),
            "边框+半透明内部　Tap #D4E2EB　长条 #B2C1FF(中部半透明)　左滑 #AFEECA <<<　右滑 #FAC1D0 >>>"
            "　上滑 #FCDBAD ^　小键 #DBD2FD（正菱形）　左侧短线=节奏标注（4/8/16/32分）",
            font=fonts.get(13, False), fill=(140, 146, 160), anchor="ma")
    canvas.convert("RGB").save(out_path, quality=92)
    return out_path, canvas.size
