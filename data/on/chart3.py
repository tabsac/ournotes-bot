# -*- coding: utf-8 -*-
"""
Our Notes 谱面预览 v3（chart3.py）

关键修正：
  * 内存：超采样改为「每段一个小图层」再缩小合成（原先是整幅画布 3× → 服务器 OOM 被杀，表现为“退出码 null”）
  * 布局：只有左右分段（单行），列内时间从下到上连贯，段与段从左到右相接
  * Fever（黄）/ Skill（蓝）不再画成整曲底部时间轴，而是画在每列**右侧侧条**上、按时间对齐到对应轨道；
    第一列侧条的开头（列底 = 曲子起点）有竖排小字 "Fever" / "Skill" 作提示
  * 小节线走**拍号事件**（sig）：拍号变了就从那里起新小节（3/4、5/4、12/4 不再被当成 4/4）；
    没有拍号事件就按 4/4 由 BPM 推。秒数（时长、每列起始秒）按 **bpm 事件逐段积分**，变速谱也准
  * **长条/描繪按 ease 画曲线**：段起点带 `ease:"out"/"in"` 的段，位移按缓动曲线走（时间仍线性），
    没有 ease 的段照旧直线 —— 所以同一条长条里的曲线段与折线段能各画各的。
    `EASE_MODE` / `--ease linear|quad|cubic|smooth` 切换曲线族

沿用规范：无判定线；音符=边框+略透明内部（边框画外侧，不吃宽度）；长条中部半透明连贯无锯齿；
长条中段=正菱形；> 形箭头（左<<< #AFEECA / 右>>> #FAC1D0 / 上^ #FCDBAD）下移贴住音符；
            "Tap #D4E2EB（边框+半透明）　左滑 #AFEECA <<<　右滑 #FAC1D0 >>>　上滑 #FCDBAD ^　长条 #B2C1FF（重叠不透明度叠加，永不 100%；长条节点 = 同色正菱形）　小键 = 宽度 <= 1.5 格（size<=6）；所有 flick 均为正常 flick（边框键 + 箭头）　小键 #D4E2EB（与正常按键同宽、上下约 30% 高；无边框、实心；不占节奏端点）　描繪音符 = 细轨道 + 沿途小键"
按与相邻音符间距的最小值判定)，数字标在短线上方。
"""
import os
from PIL import Image, ImageChops, ImageDraw, ImageFont

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
C_TICK = (152, 160, 178)
C_FEVER = (232, 172, 48)      # 黄：Fever 区间
C_SKILL = (120, 200, 255)     # 蓝：Skill 触发点

FIELD_W = 24.0
PER_BEAT = 480.0          # 每拍 tick 数（谱面固定分辨率；BPM 只决定秒数，不改 tick 网格）
SS = 3
GUT = 46                  # 左侧刻度区：数字在线的左端，右端留给 Fever 竖排字 + 黄线
SIDE = 0                  # 标注直接贴着轨道左边缘（不另留条），刻度线延伸到黄线旁边
COL_W, COL_H, GAP = 168, 640, 10
PX_PER_BAR = 320          # 固定纵向比例：列高 = 小节数 × 320（列越长图越高，不压缩）
PAD, HEADER_H = 24, 106
FILL_A = 170
EDGE_W = 2
RHYTHM_NUM = [(480, "4"), (240, "8"), (120, "16"), (60, "32"), (30, "64")]


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


def bpm_list(ev):
    """[(tick, bpm)] 升序。没有 bpm 事件 → 按 120 算（拿不到别的参考）"""
    out = []
    for e in (ev.get("bpm") or []):
        if isinstance(e, dict) and isinstance(e.get("t"), (int, float)) and e.get("bpm"):
            out.append((float(e["t"]), float(e["bpm"])))
    out.sort()
    return out or [(0.0, 120.0)]


def sig_list(ev):
    """[(tick, [分子, 分母])] 升序。没有拍号事件 → 按 4/4 算（即每 4 拍一小节）"""
    out = []
    for e in (ev.get("sig") or []):
        s = e.get("sig") if isinstance(e, dict) else None
        if (isinstance(e, dict) and isinstance(e.get("t"), (int, float))
                and isinstance(s, (list, tuple)) and len(s) == 2 and s[0]):
            out.append((float(e["t"]), [int(s[0]), int(s[1])]))
    out.sort()
    return out or [(0.0, [4, 4])]


def sec_at(tick, bpms):
    """tick → 秒：按 bpm 事件逐段积分（变速谱也准）"""
    sec = 0.0
    for i, (t0, b) in enumerate(bpms):
        if tick <= t0:
            break
        t1 = bpms[i + 1][0] if i + 1 < len(bpms) else None
        end = tick if t1 is None else min(tick, t1)
        sec += (end - t0) / PER_BEAT / b * 60.0
        if t1 is None or tick <= t1:
            break
    return sec


def bar_ticks(sigs, t_end):
    """小节线位置：每个拍号事件都从小节头开始（拍号在中间变了就到那里收尾）；
       没有拍号事件时按 4/4（每 4 拍）推"""
    out, cur, i, guard = [], 0.0, 0, 0
    while cur <= t_end and guard < 200000:
        guard += 1
        while i + 1 < len(sigs) and sigs[i + 1][0] <= cur + 1e-6:
            i += 1
        out.append(cur)
        nxt = cur + PER_BEAT * sigs[i][1][0]
        if i + 1 < len(sigs) and cur < sigs[i + 1][0] < nxt - 1e-6:
            nxt = sigs[i + 1][0]
        cur = nxt
    return out


def chart_meta(chart):
    sc = chart.get("score") or {}
    ev = sc.get("events") or {}
    bpms = bpm_list(ev)
    sigs = sig_list(ev)
    bpm, sig = bpms[0][1], sigs[0][1]
    notes = sc.get("notes") or []
    ticks = []
    for n in notes:
        if isinstance(n.get("t"), (int, float)):
            ticks.append(n["t"])
        for nd in (n.get("node") or []):
            if isinstance(nd.get("t"), (int, float)):
                ticks.append(nd["t"])
    tmin, tmax = (min(ticks), max(ticks)) if ticks else (0, 1)
    rhythm = rhythm_ticks(notes)
    return {"bpm": bpm, "sig": sig, "bpms": bpms, "sigs": sigs,
            "bars": bar_ticks(sigs, tmax + PER_BEAT * sig[0]),
            "notes": notes, "count": len(notes), "tmin": tmin, "tmax": tmax,
            "perBeat": PER_BEAT, "dur": sec_at(tmax, bpms) - sec_at(tmin, bpms),
            "fever": ev.get("fever") or [], "skill": ev.get("skill") or [],
            "allTicks": rhythm or sorted(ticks)}


def plan_columns(m, target_cols=18, min_bars=2, max_bars=8):
    """按小节线切列（每列 min_bars..max_bars 个小节）；小节线来自拍号事件，
       所以 3/4、5/4、12/4 这些段落不会被当成 4/4"""
    bars = m["bars"]
    total = max(1, len(bars) - 1)
    bpc = int(round(total / float(target_cols)))
    bpc = max(min_bars, min(max_bars, bpc))
    cols, i = [], 0
    while i < len(bars) - 1:
        j = min(i + bpc, len(bars) - 1)
        cols.append((bars[i], bars[j], i + 1, j - i))
        i = j
    return cols, bpc


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
    lim = m["perBeat"] * m["sig"][0] * max_bars
    segs, cur, t0 = [], [], None
    for st, en, n in items:
        if t0 is None:
            t0 = st
        if cur and (len(cur) >= max_notes or st - t0 > lim):
            segs.append((t0, max(x[1] for x in cur), [x[2] for x in cur]))
            cur, t0 = [], st
        cur.append((st, en, n))
    if cur:
        segs.append((t0, max(x[1] for x in cur), [x[2] for x in cur]))
    return segs


def rhythm_label(tick, all_ticks):
    """按「与上一个/下一个音符间距的最小值」换算音符时值：
         整除数：1920/gap → /4 /8 /16 /12 /24 …（三连音会得到 /12、/24）
         非整除：约成最简分数 → 3/8、5/8 这类
    """
    best = None
    for x in all_ticks:
        if x == tick:
            continue
        g = abs(x - tick)
        if g and (best is None or g < best):
            best = g
    if not best:
        return "/4"
    whole = 1920.0
    import math
    if abs(whole / best - round(whole / best)) < 1e-6:
        n = int(round(whole / best))
        if 2 <= n <= 128:
            return "/%d" % n
    n, d = int(round(best)), int(whole)
    g = math.gcd(n, d)
    n, d = n // g, d // g
    if d <= 32 and n != 1:
        return "%d/%d" % (n, d)
    # 兜底：取最近的整除数
    cand = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]
    return "/%d" % min(cand, key=lambda k: abs(whole / k - best))


def flick_dir(n):
    d = n.get("dir")
    if d in ("left", "right", "up"):
        return d
    return "up"


def color_of(d):
    return {"left": C_LEFT, "right": C_RIGHT, "up": C_UP}[d]


def _in_span(n, c0, c1):
    """音符是否与列的时间范围相交"""
    s = note_span(n)
    return bool(s) and s[1] >= c0 and s[0] < c1


# ---- 长条 / 描繪 路径的缓动 ----------------------------------------------------
# 谱面数据里每段起点带 ease："out"（缓出）/ "in"（缓入）/ 没有就是直线段。
# 段内：时间线性推进，位移按缓动比例走 —— 这就是游戏里长条是弯的的原因。
# EASE_MODE 只决定“用哪一族曲线”，可用 --ease 切换；linear = 忽略 ease，全画直线（对比用）
EASE_MODE = 'quad'
EASE_FAMILY = {
    'quad':   {'out': lambda u: 1 - (1 - u) ** 2, 'in': lambda u: u ** 2},
    'cubic':  {'out': lambda u: 1 - (1 - u) ** 3, 'in': lambda u: u ** 3},
    'smooth': {'out': lambda u: __import__('math').sin(u * 3.141592653589793 / 2),
               'in': lambda u: 1 - __import__('math').cos(u * 3.141592653589793 / 2)},
}


    # 段内进度 u(0..1) → 位移比例；kind 是段起点带的 ease（None/linear = 直线）
def ease_ratio(kind, u):
    if EASE_MODE == 'linear' or not kind:
        return u
    if isinstance(kind, (list, tuple)):          # 数据里出现过 ["out", "in"] 这类写法
        kind = kind[0] if kind else None
        if not kind or kind == 'linear':
            return u
    fn = (EASE_FAMILY.get(EASE_MODE) or EASE_FAMILY['quad']).get(kind)
    return fn(u) if fn else u


RHYTHM_MERGE = 1920.0 / 64.0       # 比 64 分音符还近 = 同一时刻（手同时按下的和弦）


def rhythm_ticks(notes):
    """真正的节奏端点：独立 tap/flick + long 链的首尾节点。

    不参与：
      · guide / trace（描繪）—— **不管是独立的小键，还是链的首尾节点**。
        数据里「小键」就是 node 为空的 trace/guide（例如 100040 里一串每 40 tick 一个的
        独立 trace）。以前它们会掉进「独立音符」那一支被当成节奏点；guide 的链首节点又常
        和旁边的真实音符只差 1 tick，于是被标成 /64 这种假时值。
      · long 链的中间节点与插入的插值节点。
    另外：间距小于 1/64 的端点合并成一个（同时按下的和弦只算一个节奏点）。
    """
    ts = []
    for n in notes:
        typ = n.get("type") or "tap"
        nds = n.get("node") or []
        if typ in ("guide", "trace"):
            continue                                  # 描繪一律不参与
        if typ == "long" and nds:
            for k in (0, len(nds) - 1):
                t = nds[k].get("t")
                if isinstance(t, (int, float)):
                    ts.append(t)
        elif isinstance(n.get("t"), (int, float)):
            ts.append(n["t"])
    out = []
    for t in sorted(set(ts)):
        if out and t - out[-1] < RHYTHM_MERGE:
            continue                                  # 和弦：同一时刻只留一个
        out.append(t)
    return out


def draw_segment(layer, seg, m, fonts, all_ticks):
    """单列绘制（两遍式）：
       第一遍：把所有长条多边形乘进同一张掩膜（重叠 → 不透明度相乘，不叠加到 100%）
       第二遍：把掩膜按长条色贴上去，再画端帽 / 正菱形 / tap / 甩键 / 左侧节奏标注
    """
    t0, t1, ns = seg
    S = SS
    W, H = layer.width, layer.height
    d = ImageDraw.Draw(layer, "RGBA")
    fx = (GUT + SIDE) * S                     # 轨道左边缘（左侧就是刻度区，标注贴着它画）
    fw = W - fx
    per = m["perBeat"]
    bset = {round(b, 6) for b in m["bars"]}       # 小节线 tick（拍号事件决定）
    span = max(t1 - t0, per * 4)
    d.rectangle([fx, 0, fx + fw, H], fill=(26, 29, 38, 255))           # 轨道

    def sx(p):
        return fx + max(0.0, min(1.0, p / FIELD_W)) * fw

    # 列内上下各留一点边：列首/列尾的音符与甩键箭头本来会被图层边缘切掉
    INSET = 20 * S if H > 80 * S else 0

    def sy(tt):
        f = max(0.0, min(1.0, (tt - t0) / span))
        return (H - INSET) - (H - 2 * INSET) * f

    # Fever 字样：**图层最下方**（先画），后面画的刻度线、音符都会盖在它上面
    for a, b in (m["fever"] or []):
        if (isinstance(a, (int, float)) and isinstance(b, (int, float))
                and b > t0 and t0 <= a <= t1):
            fnt = fonts.get(11 * S, False)
            _, th = vtext_size("Fever", fnt)
            y0 = sy(a) - 6 * S
            if y0 - th < 2 * S:                      # 上方放不下 → 改写到起点下方
                vtext(layer, ((GUT - 17) * S, min(H - 2 * S, sy(a) + 6 * S)), "Fever",
                      fnt, C_FEVER + (255,), end=True)
            else:
                vtext(layer, ((GUT - 17) * S, y0), "Fever", fnt, C_FEVER + (255,))

    # 节拍线（音符下方）
    bt = t0 - (t0 % per)
    while bt <= t1 + per:
        yy = sy(bt)
        if 0 <= yy <= H:
            strong = round(bt, 6) in bset
            d.line([fx, yy, fx + fw, yy], fill=(C_BARLINE if strong else C_BEAT) + (255,),
                   width=(2 * S if strong else S))
        bt += per
    for li in range(7):
        lx = fx + li / 6.0 * fw
        d.line([lx, 0, lx, H], fill=(54, 58, 72, 255), width=max(1, S // 2))

    def nw(sz):
        return max(11.0 * S, (sz or 8) / FIELD_W * fw * 0.85)


    # ---------- 第一组：长条 / 描繪轨道 ----------
    def expand_chain(nodes):
        """展开节点链：pos 为 "auto"/缺失的按前后锚点线性插值（描繪音符自己的逻辑）"""
        out = []
        i, n = 0, len(nodes)
        while i < n:
            nd = nodes[i]
            if isinstance(nd.get("pos"), (int, float)):
                out.append(dict(nd))
                i += 1
                continue
            j = i                                   # 找后面第一个数值锚点
            while j < n and not isinstance(nodes[j].get("pos"), (int, float)):
                j += 1
            if not out or j >= n:                   # 前面没有锚点/后面也没锚点：跳过
                i = j if j > i else i + 1
                continue
            a, b = out[-1], nodes[j]
            step = j - i + 1
            kind = a.get("ease")
            for k in range(1, step):
                f = k / float(step)
                out.append({"t": a["t"] + (b["t"] - a["t"]) * f,
                            "pos": a["pos"] + (b["pos"] - a["pos"]) * ease_ratio(kind, f),
                            "size": a.get("size") or 4, "_auto": True})
            i = j                                   # 锚点留给下一轮追加，避免重复插值
        return out

    # 小键的判据是「node 为空的 trace/guide」，不是宽度：
    # size=6 是普通键最常见的宽度（8339 个 tap 里 5005 个是 6），按宽度判会把大量普通 tap 画成细条
    chains = []
    for n in ns:
        typ = n.get("type") or "tap"
        if typ not in ("long", "guide", "trace"):
            continue
        raw = [x for x in (n.get("node") or []) if isinstance(x.get("t"), (int, float))]
        nodes = [nd for nd in expand_chain(raw) if isinstance(nd.get("pos"), (int, float))]
        if len(nodes) < 2:
            continue
        guide = typ in ("guide", "trace")          # 描繪 = 细轨道；滑動/长条 = 宽长条
        pts = []
        for a, b in zip(nodes, nodes[1:]):
            kind = a.get("ease")
            pa = a["pos"] + (a.get("size") or 8) / 2
            pb = b["pos"] + (b.get("size") or 8) / 2
            h1 = nw(4.0) / 2 if guide else nw(a.get("size")) / 2
            h2 = nw(4.0) / 2 if guide else nw(b.get("size")) / 2
            # 直线段 6 步够了；曲线段多采几个点，否则看着还是折线
            steps = 6 if (EASE_MODE == 'linear' or not kind or kind == 'linear') else 18
            for i in range(steps):
                f = i / float(steps)
                pts.append((sx(pa + (pb - pa) * ease_ratio(kind, f)),
                            sy(a["t"] + (b["t"] - a["t"]) * f),
                            h1 + (h2 - h1) * f))
        last = nodes[-1]
        pts.append((sx(last["pos"] + (last.get("size") or 8) / 2), sy(last["t"]),
                    nw(4.0) / 2 if guide else nw(last.get("size")) / 2))
        top = [(x - h, y) for x, y, h in pts]
        bot = [(x + h, y) for x, y, h in pts]
        # 逐条 source-over 叠加：两层 55% → 80% → 91%…（递增但永不达 100%）
        t2 = Image.new("RGBA", layer.size, (0, 0, 0, 0))
        ImageDraw.Draw(t2).polygon(top + bot[::-1],
                                   fill=C_LONG + (0x50 if guide else 0x8C,))
        layer.alpha_composite(t2)
        chains.append((guide, nodes))

    def box(x, y, w, col, hh=5):
        """普通音符：边框 + 半透明内部（仅 tap / 长条起点 / 终点甩尾）"""
        e = EDGE_W * S / 2.0
        d.rounded_rectangle([x - w / 2 - e, y - hh * S - e, x + w / 2 + e, y + hh * S + e], 3 * S,
                            fill=col + (FILL_A,), outline=col + (255,), width=EDGE_W * S)

    def chev(cx, cy, size, direction, col):
        if direction == "up":
            d.line([(cx - size, cy + size * 0.55), (cx, cy - size * 0.45)], fill=col + (255,), width=2 * S)
            d.line([(cx + size, cy + size * 0.55), (cx, cy - size * 0.45)], fill=col + (255,), width=2 * S)
        else:
            sgn = 1 if direction == "right" else -1
            d.line([(cx - sgn * size, cy - size * 0.8), (cx, cy)], fill=col + (255,), width=2 * S)
            d.line([(cx - sgn * size, cy + size * 0.8), (cx, cy)], fill=col + (255,), width=2 * S)

    def arrows(x, y, w, direction):
        col = color_of(direction)
        drop = 9 * S
        if direction == "up":
            chev(x, y - drop + 2 * S, 7 * S, "up", col)
            return
        sgn = 1 if direction == "right" else -1
        for i in range(3):
            chev(x + sgn * (w / 2 - 9 * S - i * 9 * S), y - drop, 6 * S, direction, col)

    # ---------- 第二组：链上的键（小键 = 窄的、没有边框的音符）----------
    def small_key(x, y, w, col=C_TAP):
        """小键：与正常按键同宽、上下更窄；无边框、内部实心（不半透明）"""
        hh = 1.5 * S                                # 上下窄：半高 1.5 单位（正常 5，约 30%）
        d.rounded_rectangle([x - w / 2, y - hh, x + w / 2, y + hh], 3 * S, fill=col + (255,))

    def long_node(x, y, rr):
        """长条节点：正菱形，与长条同色"""
        d.polygon([(x, y - rr), (x + rr, y), (x, y + rr), (x - rr, y)], fill=C_LONG + (255,))

    labels = []
    for guide, nodes in chains:
        for i, nd in enumerate(nodes):
            if nd.get("visible") is False:
                continue                            # 隐藏锚点不是音符，不画
            x, y = sx(nd["pos"] + (nd.get("size") or 8) / 2), sy(nd["t"])
            sz = nd.get("size") or 8
            fl = nd.get("type") == "flick"
            if fl:                                  # 所有甩键：一律正常 flick（边框键 + 箭头）
                fdr = flick_dir(nd)
                box(x, y, nw(sz), color_of(fdr))
                arrows(x, y, nw(sz), fdr)
            elif guide:                             # 描繪/轨道：沿途一串小键
                small_key(x, y, nw(sz))
            elif 0 < i < len(nodes) - 1:            # 长条节点：正菱形（长条色）
                long_node(x, y, min(nw(sz) / 2, 5.0 * S))
            elif i == 0:                            # 长条起点：边框 + 半透明内部
                box(x, y, nw(sz), C_LONG)
            elif fl:                                # 终点甩尾：箭头色
                ed = flick_dir(nd)
                box(x, y, nw(sz), color_of(ed))
                arrows(x, y, nw(sz), ed)
            else:                                   # 普通终点：无边框收尾
                d.rounded_rectangle([x - nw(sz) / 2, y - 4 * S, x + nw(sz) / 2, y + 4 * S],
                                    3 * S, fill=C_LONG + (0xC0,))
            if nd is nodes[0] or nd is nodes[-1]:    # 只有链的首尾才是节奏端点
                pass

    for n in ns:                                    # 独立 tap / 甩键
        if (n.get("node") or []):
            continue
        if not isinstance(n.get("t"), (int, float)) or not isinstance(n.get("pos"), (int, float)):
            continue
        x, y = sx(n["pos"] + (n.get("size") or 8) / 2), sy(n["t"])
        w = nw(n.get("size"))
        typ = n.get("type") or "tap"
        if typ == "flick":                          # 所有 flick 都是正常 flick
            drc = flick_dir(n)
            box(x, y, w, color_of(drc))
            arrows(x, y, w, drc)
        elif typ in ("trace", "guide"):             # 小键 = node 为空的 trace/guide
            small_key(x, y, w)
        else:                                       # 普通 tap：边框 + 半透明（size 6 / 8 都算普通键）
            box(x, y, w, C_TAP)

    # ---------- 第三组：左列刻度（只取节奏端点，小键/中间节点不参与）----------
    def skill_label(y_line, size=9):
        """skill 小字：默认写在短线下方；贴到列底就翻到线上方，保证不被切"""
        fnt = fonts.get(size * S, False)
        bx = fnt.getbbox("skill")
        h = bx[3] - bx[1]
        y = y_line + 11 * S + h
        if y > H - 2 * S:
            y = y_line - 5 * S
        d.text(((GUT - 5) * S, y), "skill", font=fnt, fill=C_SKILL + (255,), anchor="rs")

    rhy = [t for t in rhythm_ticks(ns)]
    rhy_set = {round(t, 6) for t in rhy}
    skill_pts = sorted({round(s, 6) for s in (m["skill"] or []) if isinstance(s, (int, float))})
    skill_set = set(skill_pts)
    # 音符处：短线 + 节奏时值；小节分界处：更长更粗，并标注当前小节 #n
    # skill 正好落在这条线上 → 线直接变蓝，skill 字写在线的下方
    last_y = None
    for tk in rhy:
        yy = sy(tk)
        if not (-4 * S <= yy <= H + 4 * S):
            continue
        if round(tk, 6) in bset:
            continue                                # 小节线在下面单独画
        is_sk = round(tk, 6) in skill_set
        d.line([2 * S, yy, (GUT - 5) * S, yy],
               fill=(C_SKILL if is_sk else C_TICK) + (255,), width=2 * S)
        if is_sk:
            skill_label(yy)
        if last_y is None or abs(yy - last_y) > 16 * S:
            d.text(((GUT - 22) * S, yy - 3 * S), rhythm_label(tk, all_ticks),
                   font=fonts.get(12 * S, False), fill=C_TICK + (255,), anchor="rs")
            last_y = yy
    for bi, tk in enumerate(m["bars"]):
        if tk < t0 - 1e-6 or tk > t1 + 1e-6:
            continue
        yy = sy(tk)
        if not (-4 * S <= yy <= H + 4 * S):
            continue
        is_sk = round(tk, 6) in skill_set
        d.line([2 * S, yy, (GUT - 5) * S, yy],
               fill=(C_SKILL if is_sk else C_BARLINE) + (255,), width=3 * S)
        if is_sk:
            skill_label(yy)
        d.text(((GUT - 20) * S, yy - 4 * S), "#%d" % (bi + 1),
               font=fonts.get(13 * S, True), fill=(212, 218, 232), anchor="rs")

    # ---------- 第四组：Fever 竖线（黄）+ 没落在任何刻度线上的 skill 短线 ----------
    for a, b in (m["fever"] or []):
        if not (isinstance(a, (int, float)) and isinstance(b, (int, float))) or b <= t0 or a >= t1:
            continue
        ya, yb = sy(min(b, t1)), sy(max(a, t0))
        d.rectangle([(GUT - 4) * S, min(ya, yb), (GUT - 1) * S, max(ya, yb)], fill=C_FEVER + (255,))
    for sk in skill_pts:
        if not (t0 <= sk <= t1) or sk in rhy_set or sk in bset:
            continue                                # 落在刻度线上的已经在上面变蓝了
        y = sy(sk)
        d.line([2 * S, y, (GUT - 5) * S, y], fill=C_SKILL + (255,), width=2 * S)
        skill_label(y)
    for sk in (m["skill"] or []):                   # skill 是区间时：紧挨黄线左侧画蓝竖线
        if not (isinstance(sk, (list, tuple)) and len(sk) >= 2):
            continue
        a, b = sk[0], sk[1]
        if not (isinstance(a, (int, float)) and isinstance(b, (int, float))) or b <= t0 or a >= t1:
            continue
        ya, yb = sy(min(b, t1)), sy(max(a, t0))
        d.rectangle([(GUT - 7) * S, min(ya, yb), (GUT - 4) * S, max(ya, yb)], fill=C_SKILL + (255,))
    return layer


def vtext_size(text, font):
    """竖排（旋转 90°）之后的像素尺寸 (宽, 高)"""
    bx = font.getbbox(text)
    return (bx[3] - bx[1]) + 8, (bx[2] - bx[0]) + 8


def vtext(img, xy, text, font, fill, end=False):
    """竖排小字（旋转 90°，从下往上读）。
       end=False：xy 是文字的**起点**（最下面那个字），文字向上排；
       end=True ：xy 是文字的**末端**，文字向下排（上方放不下时用）。"""
    bx = font.getbbox(text)
    w, h = bx[2] - bx[0], bx[3] - bx[1]
    tmp = Image.new("RGBA", (w + 8, h + 8), (0, 0, 0, 0))
    ImageDraw.Draw(tmp).text((4 - bx[0], 4 - bx[1]), text, font=font, fill=fill)
    im = tmp.rotate(90, expand=True)
    y = int(xy[1]) if end else int(xy[1]) - im.height
    img.alpha_composite(im, (int(xy[0]), max(0, y)))


def render(song, diff, chart, aliases, fonts, out_path, ease=None):
    global EASE_MODE
    if ease:
        EASE_MODE = ease
    m = chart_meta(chart)
    cols, bpc = plan_columns(m)
    n = max(1, len(cols))
    col_h = int(bpc * PX_PER_BAR)       # 纵向比例固定：列高 = 小节数 × 320 → 列越长图越高
    W = PAD * 2 + n * (COL_W + SIDE) + (n - 1) * GAP
    H = PAD + HEADER_H + col_h + 46
    canvas = grad(W, H, (24, 26, 34), (14, 15, 20)).convert("RGBA")
    dr = ImageDraw.Draw(canvas)
    dr.rectangle([0, 0, W, 6], fill=DIFF_COLOR.get(diff, (120, 120, 120)))
    title = song.get("title_jp") or song.get("title") or ""
    dr.text((PAD + 6, PAD + 6), title, font=fonts.get(32, True), fill=(240, 242, 248))
    lv = next((c["display"] for c in song["charts"] if c["name"] == diff), "?")
    combo = next((c["combo"] for c in song["charts"] if c["name"] == diff), "?")
    bs = sorted({round(b, 2) for _, b in m["bpms"]})
    bpm_txt = ("%g" % bs[0]) if len(bs) == 1 else ("%g~%g" % (bs[0], bs[-1]))
    sg = sorted({tuple(s) for _, s in m["sigs"]})
    sig_txt = ("%d/%d" % tuple(sg[0])) if len(sg) == 1 else (
        "%d/%d~%d/%d" % (sg[0][0], sg[0][1], sg[-1][0], sg[-1][1]))
    dr.text((PAD + 8, PAD + 50),
            f"{diff}  Lv.{lv}    combo {combo}    BPM {bpm_txt}    拍号 {sig_txt}    键数 {m['count']}"
            f"    时长 {m['dur']:.1f}s    共 {len(cols)} 列（每列 {bpc} 小节·从左到右，列内从下到上）",
            font=fonts.get(20, False), fill=(172, 178, 192))
    if aliases:
        dr.text((PAD + 8, PAD + 78), "别名：" + "、".join(aliases)[:110],
                font=fonts.get(16, False), fill=(142, 148, 162))

    # 每段一个小图层（SS 倍）后再缩小合成 —— 内存安全（每段约 4MB）
    top = PAD + HEADER_H
    for i, (c0, c1, bar_no, nbar) in enumerate(cols):
        lay = Image.new("RGBA", ((COL_W + SIDE) * SS, col_h * SS), (0, 0, 0, 0))
        draw_segment(lay, (c0, c1, [n for n in m["notes"] if _in_span(n, c0, c1)]), m, fonts, m["allTicks"])
        smo = lay.resize((COL_W + SIDE, col_h), Image.LANCZOS)
        x = PAD + i * (COL_W + SIDE + GAP)
        canvas.alpha_composite(smo, (x, top))
        lane_mid = x + GUT + SIDE + (COL_W - GUT) / 2            # 轨道中心（表头/秒数对齐它）
        dr.text((lane_mid, top - 16), f"#{bar_no}，#{bar_no + nbar}",
                font=fonts.get(14, False), fill=(136, 142, 156), anchor="ma")
        dr.text((lane_mid, top + col_h + 4),
                f"{sec_at(c0, m['bpms']):.0f}s", font=fonts.get(12, False),
                fill=(118, 124, 138), anchor="ma")

    dr.text((W / 2, H - 14),
            "Tap #D4E2EB（边框+半透明）　左滑 #AFEECA <<<　右滑 #FAC1D0 >>>　上滑 #FCDBAD ^　长条 #B2C1FF（重叠不透明度叠加，永不 100%）　小键 #DBD2FD（窄、无边框）　描繪音符 = 细轨道 + 沿轨小键"
            "左列刻度 = 节奏时值（/4 /8 /16 /12 /24 /32 /64）；小节线按拍号事件走（没有拍号就按 4/4 由 BPM 推），并标注 #小节号；"
            "轨道左侧：黄竖线 = Fever 区间（每段开头写 Fever）；skill 落在小节/节奏刻度线上时那条线变蓝、下方写 skill，没落上就单独画一条蓝短线",
            font=fonts.get(13, False), fill=(140, 146, 160), anchor="ma")
    canvas.convert("RGB").save(out_path, quality=92)
    return out_path, canvas.size


# ---------------------------------------------------------------- 谱面统计（/on查谱面）
def chart_stats(chart):
    """谱面数据一览。音符分类口径与绘图一致：
       node 为空的 trace/guide 就是「小键」，有 node 的才是「描繪」。"""
    m = chart_meta(chart)
    notes = m["notes"]
    n_tap = n_flick = n_long = n_trace = n_small = 0
    nodes = 0
    for n in notes:
        t = n.get("type") or "tap"
        nds = n.get("node") or []
        if t in ("guide", "trace"):
            if nds:
                n_trace += 1
            else:
                n_small += 1
        elif t == "long":
            n_long += 1
            nodes += len(nds)
        elif t == "flick":
            n_flick += 1
        else:
            n_tap += 1
    sig = m["sig"]
    bars = sum(1 for b in m["bars"] if b <= m["tmax"])       # 拍号事件决定小节线
    bs = sorted({round(b, 2) for _, b in m["bpms"]})
    bpm_txt = ("%g" % bs[0]) if len(bs) == 1 else ("%g~%g" % (bs[0], bs[-1]))
    sgs = sorted({tuple(s) for _, s in m["sigs"]})
    sig_txt = ("%d/%d" % tuple(sgs[0])) if len(sgs) == 1 else (
        "%d/%d~%d/%d" % (sgs[0][0], sgs[0][1], sgs[-1][0], sgs[-1][1]))
    total = len(notes)
    return {
        "total": total,
        "tap": n_tap,
        "flick": n_flick,
        "long": n_long,
        "longNodes": nodes,
        "trace": n_trace,
        "small": n_small,
        "bpm": m["bpm"],
        "bpmText": bpm_txt,
        "sig": sig_txt,
        "bars": bars,
        "seconds": m["dur"],
        "firstTick": m["tmin"],
        "lastTick": m["tmax"],
        "rhythmTicks": len(rhythm_ticks(notes)),
        "fever": len(m["fever"] or []),
        "skill": len(m["skill"] or []),
    }


if __name__ == "__main__":
    import argparse
    import json as _json
    ap = argparse.ArgumentParser(description="谱面统计 / 预览")
    ap.add_argument("cmd", choices=["stats"])
    ap.add_argument("--chart", required=True)
    a = ap.parse_args()
    print(_json.dumps(chart_stats(_json.load(open(a.chart, encoding="utf-8"))), ensure_ascii=False))
