#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""当期活动一览图，供 /on活动 用。

数据来源：MasterEvent（期间 / 活动曲 / 素材名）、MasterEventEffect（加成）、
MasterEventPickUpCard（Pick Up）、MasterEventAchievementReward + MasterReward + MasterItem（点数奖励）。
素材（活动 Top / Logo）走 tools/export_asset.js 从 bundle 里解出来，缓存在 data/on/art/event/。

    eventimg.py --out /path/event.png       画图
    eventimg.py --text                      只输出文字（图挂了时的兜底）
"""
import argparse
import json
import os
import subprocess
import sys
import time

from PIL import Image, ImageDraw, ImageFilter

ON = os.environ.get('ON_DIR', '/home/admin/bot/data/on')
sys.path.insert(0, ON)
import cardimg as C  # noqa: E402


def _root():
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
EVENT_ART = os.path.join(ON, 'art', 'event')
W = 1240
MARGIN = 30
RARITY = {4: 'SSR', 3: 'SR', 2: 'R', 10: 'BD', 20: 'EX'}
RARITY_COLOR = {'SSR': (255, 214, 120), 'SR': (150, 200, 255), 'R': (200, 206, 220),
                'BD': (255, 170, 200), 'EX': (190, 160, 255)}
BONUS_KIND = {2: '成员卡', 3: '留影卡'}
TYPE_ICON = {1: 'type1_red.png', 2: 'type2_blue.png', 3: 'type3_green.png',
             4: 'type4_gold.png', 5: 'type5_purple.png'}      # data/on/ui/ 里的属性图标


def load(name):
    return C.load(name)


def parse_dt(s):
    if not s or s == 'null':
        return None
    for f in ('%Y/%m/%d %H:%M:%S', '%Y/%m/%d %H:%M', '%Y/%m/%d'):
        try:
            return time.mktime(time.strptime(s, f))
        except ValueError:
            continue
    return None


class Texts:
    def __init__(self):
        self.t = {str(r['_id']): r for r in load('MasterText')}

    def __call__(self, tid):
        r = self.t.get(str(tid)) or {}
        return (r.get('_simplifiedChinese') or r.get('_japanese') or '').strip()


def pick_event(now=None):
    now = time.time() if now is None else now
    evs = load('MasterEvent')
    run = [e for e in evs if (parse_dt(e.get('_startAt')) or 0) <= now and (parse_dt(e.get('_endAt')) or 0) >= now]
    return (run or evs)[-1] if (run or evs) else None


def event_asset(asset, cache_name, sub='event'):
    """素材（活动主视觉 / 团队 logo …）：本地缓存优先，否则调 node 从 bundle 解出来"""
    if not asset:
        return None
    out = os.path.join(ON, 'art', sub, cache_name + '.png')
    if not (os.path.exists(out) and os.path.getsize(out) > 512):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        ex = os.path.join(ROOT, 'tools', 'export_asset.js')
        p = subprocess.run(['node', ex, '--asset', asset, '--out', out],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode != 0 or not os.path.exists(out):
            sys.stderr.write('活动素材导出失败 %s: %s\n' % (asset, p.stderr.decode('utf-8', 'ignore').strip()[:160]))
            return None
    try:
        return Image.open(out).convert('RGBA')
    except Exception as e:  # noqa: BLE001
        sys.stderr.write('活动素材打不开 %s: %s\n' % (out, e))
        return None


def gather():
    """把一张活动图要用的数据全捞出来"""
    tx = Texts()
    ev = pick_event()
    if not ev:
        return None
    st, en = parse_dt(ev.get('_startAt')), parse_dt(ev.get('_endAt'))

    # 加成
    cards = {c['_id']: c for c in load('MasterMemberCard')}
    bands = {b['_id']: b for b in load('MasterBand')}
    chars = {c['_id']: c for c in load('MasterCharacter')}
    sups = {s['_id']: s for s in load('MasterSupportCard')}
    color_names = {1: tx('CardType_Red_Name'), 2: tx('CardType_Blue_Name'), 3: tx('CardType_Green_Name'),
                   4: tx('CardType_Yellow_Name'), 5: tx('CardType_Purple_Name')}

    def card_label(cid):
        c = cards.get(cid)
        if not c:
            return '卡%s' % cid
        ch = chars.get(c['_characterID'])
        return '%s（%s）' % (tx(c['_subtitleTextID']), tx(ch['_nameTextID']) if ch else '')

    bonus = {}          # (kind, who) -> item
    for r in load('MasterEventEffect'):
        if r.get('_eventId') != ev['_id']:
            continue
        kind = BONUS_KIND.get(r.get('_resourceTypeConstraint'), '其它')
        icon = None
        if r.get('_memberCardId'):
            who = card_label(r['_memberCardId'])
        elif r.get('_supportCardId'):
            s = sups.get(r['_supportCardId'])
            who = tx(s['_nameTextID']) if s else ('留影卡%s' % r['_supportCardId'])
        elif r.get('_bandId'):
            b = bands.get(r['_bandId'])
            who = (tx(b['_nameTextID']) if b else ('团体%s' % r['_bandId'])) + '（团体）'
            icon = ('band', r['_bandId'])
        elif r.get('_cardType'):
            who = (color_names.get(r['_cardType']) or ('属性%s' % r['_cardType'])) + '（属性）'
            icon = ('type', r['_cardType'])
        elif r.get('_characterId'):
            ch = chars.get(r['_characterId'])
            who = (tx(ch['_nameTextID']) if ch else ('角色%s' % r['_characterId'])) + '（角色）'
        else:
            continue
        lo = r.get('_rank1EffectValue') or 0
        hi = r.get('_rank5EffectValue') or lo
        item = {'who': who, 'lo': lo / 100.0, 'hi': hi / 100.0, 'type': r.get('_eventBonusType'), 'icon': icon}
        item['kind'] = kind
        key = (kind, who)
        if key not in bonus or (item['type'] == 0 and bonus[key]['type'] != 0):
            bonus[key] = item

    # Pick Up
    picks = []
    for r in load('MasterEventPickUpCard'):
        if r.get('_eventId') != ev['_id']:
            continue
        rid, rt = r.get('_resourceId'), r.get('_resourceType')
        if rt == 2 and rid in cards:
            c = cards[rid]
            ch = chars.get(c['_characterID'])
            picks.append({'kind': '卡', 'id': rid, 'name': tx(c['_subtitleTextID']),
                          'char': tx(ch['_nameTextID']) if ch else '', 'rarity': RARITY.get(c['_rarity'], '')})
        elif rt == 3 and rid in sups:
            sc = sups[rid]
            # 留影卡：名字取 _descriptionTextID（卡名，如「圆圆小憩」），_nameTextID 是角色/组合名（如「都子＆律」）
            names = '、'.join(tx(chars[i]['_nameTextID']) for i in (sc.get('_characterIDs') or []) if i in chars)
            picks.append({'kind': '留影', 'id': rid, 'name': tx(sc['_descriptionTextID']),
                          'char': names, 'rarity': RARITY.get(sc.get('_rarity'), '')})

    # 点数奖励
    rewards = {r['_id']: r for r in load('MasterReward')}
    items = {i['_id']: i for i in load('MasterItem')}
    miles = []
    for r in sorted(load('MasterEventAchievementReward'), key=lambda x: x.get('_eventPoint') or 0):
        if r.get('_eventId') != ev['_id']:
            continue
        goods = []
        for rid in (r.get('_rewardIds') or []):
            w = rewards.get(rid)
            if not w:
                continue
            it = items.get(w.get('_resourceId'))
            nm = tx(it['_nameTextId']) if it else ('道具%s' % w.get('_resourceId'))
            goods.append('%s×%s' % (nm, w.get('_resourceCount')))
        if goods:
            miles.append({'pt': r.get('_eventPoint'), 'goods': '、'.join(goods)})

    # 活动曲：MasterChallengeMusic 里挂在这个活动下的曲子（可能不止一首），
    # 列表为空时退回 MasterEvent._musicId
    songs_by_id = {}
    try:
        for sg in json.load(open(os.path.join(ON, 'songs.json')))['songs']:
            songs_by_id[str(sg.get('id'))] = sg
    except Exception:  # noqa: BLE001
        pass
    music_ids = []
    for r in load('MasterChallengeMusic'):
        if r.get('_eventId') == ev['_id'] and r.get('_liveMusicId'):
            if str(r['_liveMusicId']) not in music_ids:
                music_ids.append(str(r['_liveMusicId']))
    if not music_ids and ev.get('_musicId'):
        music_ids = [str(ev['_musicId'])]
    songs = []
    for mid in music_ids:
        sg = songs_by_id.get(mid)
        if not sg:
            continue
        songs.append({'id': sg.get('id'), 'title': sg.get('title') or sg.get('title_jp'),
                      'jacket': sg.get('jacket'),
                      'charts': [(c.get('name'), c.get('level')) for c in (sg.get('charts') or []) if c]})
    song = songs[0] if songs else None

    return {
        'id': ev['_id'],
        'name': tx(ev['_nameTextId']),
        'start': (ev.get('_startAt') or '')[:16], 'end': (ev.get('_endAt') or '')[:16],
        'left_sec': int(en - time.time()) if en else None,
        'top': ('Image/Event/' + (ev.get('_backgroundAsset') or '')) if ev.get('_backgroundAsset') else '',
        'logo': ('Image/Event/' + (ev.get('_logoAsset') or '')) if ev.get('_logoAsset') else '',
        'bonus': list(bonus.values()),
        'picks': picks,
        'miles': miles,
        'item': tx(items[ev['_eventItemId']]['_nameTextId']) if ev.get('_eventItemId') in items else '',
        'song': song,
        'songs': songs,
    }


def text_of(info):
    L = ['【%s】（%s ~ %s）' % (info['name'], info['start'], info['end'])]
    if info['left_sec'] is not None:
        L.append('剩余：%d 天 %d 小时' % (info['left_sec'] // 86400, info['left_sec'] % 86400 // 3600))
    for i, sg in enumerate(info.get('songs') or []):
        lv = '　'.join('%s %s' % (n, l) for n, l in sg['charts'])
        L.append('%s：%s（%s）' % ('活动曲' if len(info['songs']) == 1 else '活动曲%d' % (i + 1), sg['title'], lv))
    if info['picks']:
        L.append('Pick Up：' + '、'.join('%s %s（%s）' % (p['rarity'], p['name'], p['char']) for p in info['picks']))
    for kind in ('成员卡', '留影卡'):
        rows = sorted([b for b in info['bonus'] if b.get('kind') == kind], key=lambda z: -z['hi'])
        if rows:
            L.append('%s加成：%s' % (kind, '、'.join('%s +%g%%~%g%%' % (b['who'], b['lo'], b['hi']) for b in rows)))
    if info['miles']:
        L.append('点数奖励：' + '　'.join('%s pt %s' % (m['pt'], m['goods']) for m in info['miles'][:8]))
    return '\n'.join(L)


def gradient_mask(canvas, top_y, color=(9, 11, 20), ramp_frac=0.15):
    """从 top_y 一直铺到画布最底下：最上面 ramp_frac（默认 15%）由 alpha 0 渐变到 255，
    再往下整片 100% 纯色。信息（日期 / 活动道具 / 活动曲…）随后画在这层遮罩之上。"""
    w, h = canvas.size
    top_y = max(0, min(int(top_y), h - 1))
    band_h = h - top_y
    band = Image.new('RGBA', (w, band_h), color + (0,))
    px = band.load()
    ramp = max(1, int(band_h * ramp_frac))
    for y in range(band_h):
        a = 255 if y >= ramp else int(round(255 * y / ramp))
        for x in range(w):
            px[x, y] = (color[0], color[1], color[2], a)
    canvas.alpha_composite(band, (0, top_y))
    return top_y


def render(info, out_path, fonts, scale=1.0):
    picks = info['picks']
    bonus = info['bonus']
    miles = info['miles'][:9]
    songs = info.get('songs') or []
    top = event_asset(info['top'], 'top_' + str(info['id'])) or event_asset(info['logo'], 'logo_' + str(info['id']))
    HEAD = 112
    # 封面铺满整幅宽度
    top_h = 0
    if top is not None:
        top_h = round(top.height * W / top.width)
        top = top.resize((W, top_h), Image.LANCZOS).convert('RGBA')
    JACKET = 84                                      # 活动曲曲绘（横排）
    overlay_h = 46 + 34 + JACKET + 34                # 期间/道具一行 + 曲绘行 + 曲名行
    pick_h = 306 if picks else 0        # 卡面区 220 + 名字/角色两行（居中放置后标签统一在下方，留够高度）
    kinds = len({b['kind'] for b in bonus}) or 1
    bonus_h = 40 + (32 * kinds) + 30 * max(1, len(bonus)) + 10
    mile_h = 40 + 30 * ((len(miles) + 2) // 3)
    H = HEAD + (top_h if top_h else 0) + 26 + pick_h + bonus_h + mile_h + 90

    canvas = C.vertical_gradient(W, H, (26, 30, 48), (14, 16, 26)).convert('RGBA')
    dr = ImageDraw.Draw(canvas)
    dr.rectangle([0, 0, W, HEAD], fill=(20, 22, 36))
    dr.rectangle([0, HEAD - 4, W, HEAD], fill=(150, 120, 226))
    dr.text((MARGIN, 24), '当期活动', font=fonts.get(40, True), fill=(244, 246, 255))
    dr.text((MARGIN + 2, 74), info['name'], font=fonts.get(26, True), fill=(255, 214, 120))
    dr.text((W - MARGIN, 34), info['end'], font=fonts.get(24, True), fill=(200, 208, 230), anchor='ra')
    if info['left_sec'] is not None:
        d, h = info['left_sec'] // 86400, info['left_sec'] % 86400 // 3600
        dr.text((W - MARGIN, 72), '剩余 %d 天 %d 小时' % (d, h), font=fonts.get(20, False), fill=(150, 162, 186), anchor='ra')

    y = HEAD
    if top is not None:
        canvas.paste(top, (0, y), top)
        # 遮罩：从封面下部一直铺到整张图的最下面；最上 15% 由透明渐入，其余 100% 纯色。
        # 下面所有内容（日期 / 活动道具 / 活动曲 / Pick Up / 加成 / 点数奖励）都画在它上面。
        gradient_mask(canvas, y + top_h - overlay_h - 40)
        oy = y + top_h - overlay_h - 6
        dr.text((MARGIN, oy), '%s ~ %s' % (info['start'], info['end']), font=fonts.get(23, True), fill=(232, 238, 250))
        if info['item']:
            dr.text((W - MARGIN, oy), '活动道具：' + info['item'], font=fonts.get(23, True), fill=(190, 216, 255), anchor='ra')
        oy += 34
        # 活动曲：横着并列排布，只给曲绘 + 曲名（不要难度）
        cell = (W - MARGIN * 2) // max(1, len(songs))
        for i, sg in enumerate(songs):
            x = MARGIN + i * cell
            jk = None
            for ext in ('.jpg', '.png', '.jpeg'):
                cand = os.path.join(ON, 'art', 'jacket', (sg.get('jacket') or '') + ext)
                if os.path.exists(cand):
                    jk = cand
                    break
            if jk:
                art = C.rounded(Image.open(jk).convert('RGB').resize((JACKET, JACKET), Image.LANCZOS), 8)
                canvas.paste(art, (x, oy), art)
            label = '活动曲' if len(songs) == 1 else '活动曲%d' % (i + 1)
            dr.text((x + JACKET + 12, oy + 8), label, font=fonts.get(19, True), fill=(255, 214, 120))
            for k, line in enumerate(C.wrap(dr, sg['title'], fonts.get(23, True), cell - JACKET - 24, 2)):
                dr.text((x + JACKET + 12, oy + 32 + k * 26), line, font=fonts.get(23, True), fill=(248, 250, 255))
        y += top_h
    y += 26

    if picks:
        dr.text((MARGIN, y), 'Pick Up', font=fonts.get(24, True), fill=(255, 214, 120))
        y += 40
        # 角色卡是竖版（162x216）、留影卡是横版（216x122），并排时按「竖直居中」对齐，
        # 名字那一行放在统一的基线上，不然一个顶格一个居中会很乱
        area_h = 220          # 卡面区域高度（按最高的竖版卡算）
        label_y = y + area_h + 8
        x = MARGIN + 6
        for p in picks:
            art = None
            if p['kind'] == '卡':
                f = C.find_art('thumb', p['id'])
                if f:
                    art = C.rounded(Image.open(f).convert('RGB').resize((162, 216), Image.LANCZOS), 10)
            else:
                f = os.path.join(ON, 'art', 'support', str(p['id']) + '.jpg')
                if os.path.exists(f):
                    sw = round(216 * 16 / 9)      # 横版留影卡按「纵向与角色卡等长」放大：高 216 → 宽 384
                    art = C.rounded(Image.open(f).convert('RGB').resize((sw, 216), Image.LANCZOS), 10)
            if art is not None:
                canvas.paste(art, (x, y + (area_h - art.height) // 2), art)      # 中心对齐
            dr.text((x, label_y), '%s %s' % (p['rarity'], p['name']), font=fonts.get(20, True), fill=(240, 244, 252))
            dr.text((x, label_y + 26), p['char'], font=fonts.get(18, False), fill=(152, 164, 188))
            x += 236
        y += pick_h

    if bonus:
        dr.text((MARGIN, y), '加成（界限突破 0 → 4）', font=fonts.get(24, True), fill=(150, 196, 250))
        y += 40
        for kind in ('成员卡', '留影卡'):
            rows = sorted([b for b in bonus if b['kind'] == kind], key=lambda z: -z['hi'])
            if not rows:
                continue
            dr.text((MARGIN + 6, y), kind, font=fonts.get(22, True), fill=(255, 214, 120))
            y += 32
            for b in rows:
                # 属性加成画属性图标、团队加成画团队 logo，都缩放到和这一行文字一样高
                ic = None
                src = b.get('icon')
                if src and src[0] == 'type':
                    pth = os.path.join(ON, 'ui', TYPE_ICON.get(src[1], ''))
                    if os.path.exists(pth):
                        ic = Image.open(pth).convert('RGBA')
                elif src and src[0] == 'band':
                    ic = event_asset('Band/%s/band_logo' % src[1], 'band_' + str(src[1]), sub='band')
                if ic is not None:
                    ih = 24
                    iw = max(1, round(ic.width * ih / ic.height))
                    ic = ic.resize((iw, ih), Image.LANCZOS)
                    canvas.paste(ic, (MARGIN + 34, y - 2), ic)
                    tx0 = MARGIN + 34 + iw + 8
                else:
                    tx0 = MARGIN + 34
                dr.text((tx0, y), b['who'], font=fonts.get(21, True), fill=(236, 240, 250))
                dr.text((MARGIN + 700, y), '+%g%% → +%g%%' % (b['lo'], b['hi']), font=fonts.get(21, True),
                        fill=(150, 226, 170))
                y += 30

    if miles:
        dr.text((MARGIN, y), '点数奖励', font=fonts.get(24, True), fill=(150, 196, 250))
        y += 40
        for i, m in enumerate(miles):
            col, row = i % 3, i // 3
            x = MARGIN + 6 + col * 396
            dr.text((x, y + row * 30), '%s pt' % m['pt'], font=fonts.get(21, True), fill=(255, 214, 120))
            for line in C.wrap(dr, m['goods'], fonts.get(20, False), 300, 1):
                dr.text((x + 92, y + row * 30), line, font=fonts.get(20, False), fill=(220, 226, 238))

    dr.text((W / 2, H - 30), 'Our Notes · 数据来自游戏主数据（MasterEvent / MasterEventEffect）',
            font=fonts.get(16, False), fill=(120, 130, 150), anchor='ma')
    if scale != 1.0:
        canvas = canvas.resize((max(1, int(W * scale)), max(1, int(H * scale))), Image.LANCZOS)
    canvas.convert('RGB').save(out_path)
    return out_path, canvas.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out')
    ap.add_argument('--text', action='store_true')
    ap.add_argument('--scale', type=float, default=1.0)
    ap.add_argument('--fonts', nargs=2)
    a = ap.parse_args()
    info = gather()
    if not info:
        print('现在没有进行中的活动。')
        return 3
    if a.text or not a.out:
        print(text_of(info))
        return 0
    fonts = C.pick_fonts(a.fonts)
    out, size = render(info, a.out, fonts, a.scale)
    print('活动图 %s %dx%d' % (out, size[0], size[1]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
