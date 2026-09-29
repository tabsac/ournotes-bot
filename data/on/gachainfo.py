#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""当期招募（卡池）数据，供 /on卡池 用；文本输出由本文件给，图片由 gachaimg.py 用同一份数据画。

数据来源：MasterGacha（时间/横幅/概率组）、MasterGachaLot（稀有度权重）、
MasterGachaPrize（Pick Up 卡）、MasterGachaProduct（抽数与价格）。
概率 = 组内权重 / 组内权重和，按「成员卡 / 留影卡」分开列。

    gachainfo.py            文本一览（图片渲染失败时的兜底）
    gachainfo.py --json     collect() 的原始结构，便于排查
"""
import argparse
import json
import os
import sys
import time

ON = os.environ.get('ON_DIR', '/home/admin/bot/data/on')
sys.path.insert(0, ON)
import cardimg as C  # noqa: E402

RARITY = {4: 'SSR', 3: 'SR', 2: 'R', 10: 'BD', 20: 'EX'}
RESTYPE = {2: '成员卡', 3: '留影卡'}


def parse_dt(s):
    if not s or s == 'null':
        return None
    for f in ('%Y/%m/%d %H:%M:%S', '%Y/%m/%d %H:%M', '%Y/%m/%d'):
        try:
            return time.mktime(time.strptime(s, f))
        except ValueError:
            continue
    return None


def pretty(s):
    """'2026/09/01 00:00:00' → '2026/09/01'"""
    return (s or '').split(' ')[0]


def collect(now=None):
    """当期卡池结构：featured（有 Pick Up 卡的）+ others（其它在开），文本与图片共用。"""
    d = C.Data()
    gacha = C.load('MasterGacha')
    lot = C.load('MasterGachaLot')
    prize = C.load('MasterGachaPrize')

    now = time.time() if now is None else now
    alive = []
    for g in gacha:
        st, en = parse_dt(g.get('_startAt')), parse_dt(g.get('_endAt'))
        if st and st > now:
            continue
        # 只有「限定期间」的招募参与展示：没有结束时间（常驻 / 券池）的不进列表
        if en is None:
            continue
        if en >= now:
            alive.append(g)

    def card_of(cid):
        c = d.by_id.get(cid)
        if not c:
            return None
        ch = d.chars.get(c['_characterID'])
        return {'id': c['_id'], 'title': d.zh(c['_subtitleTextID']),
                'char': d.zh(ch['_nameTextID']) if ch else '',
                'rarity': c['_rarity'], 'type': c['_cardType']}

    def rates(g):
        rows = [r for r in lot if r['_lotGroupId'] == g['_lotGroupId']]
        total = sum(r['_weight'] for r in rows) or 1
        out = []
        for kind in dict.fromkeys(RESTYPE.get(r['_resourceTypeConstraint'], str(r['_resourceTypeConstraint']))
                                  for r in rows):
            rs = [(RARITY.get(r['_rarityConstraint'], '?'), 100.0 * r['_weight'] / total)
                  for r in rows
                  if RESTYPE.get(r['_resourceTypeConstraint'], str(r['_resourceTypeConstraint'])) == kind]
            rs.sort(key=lambda x: -x[1])
            out.append((kind, rs))
        return out

    def pickups(g):
        groups = {r['_prizeGroupId'] for r in lot if r['_lotGroupId'] == g['_lotGroupId']}
        seen, out = set(), []
        for p in prize:
            if p['_pickUpType'] != 2 or p['_groupId'] not in groups:
                continue
            if p['_resourceId'] in seen:
                continue
            seen.add(p['_resourceId'])
            c = card_of(p['_resourceId'])
            if c:
                out.append(c)
        return out

    def entry(g, with_ups):
        e = {'id': g['_id'], 'name': d.zh(g['_nameTextId']),
             'start': pretty(g.get('_startAt')), 'end': pretty(g.get('_endAt')),
             'banner': g.get('_bannerAssetName') or '', 'logo': g.get('_logoAssetName') or '',
             'limited': bool(g.get('_isLimited'))}
        if with_ups:
            e['rates'] = rates(g)
            e['pickups'] = pickups(g)
        return e

    featured, others = [], []
    for g in alive:
        if pickups(g):
            featured.append(entry(g, True))
        else:
            others.append(entry(g, False))

    ends = sorted({g['end'] for g in featured if g.get('end') and g['end'] != 'null'})
    return {'featured': featured, 'others': others, 'until': ends[-1] if ends else '',
            'total': len(alive)}


def text_of(info):
    """原来那版文本一览（图片渲染失败时的兜底）"""
    L = []
    span = '（至 %s）' % info['until'] if info.get('until') else ''
    L.append('当期招募%s' % span)
    for g in info['featured']:
        L.append('')
        L.append('【%s】' % g['name'])
        if g.get('start') or g.get('end'):
            L.append('　期间：%s ~ %s' % (g.get('start') or '?', g.get('end') or '?'))
        for kind, rows in g.get('rates') or []:
            L.append('　%s：%s' % (kind, '　'.join('%s %.1f%%' % (r, p) for r, p in rows)))
        ps = g.get('pickups') or []
        up = [c for c in ps if c['rarity'] == 4] or ps
        L.append('　Pick Up：')
        for c in up:
            L.append('　　%s %s%s' % (RARITY.get(c['rarity'], ''), c['title'],
                                     ('（%s）' % c['char']) if c['char'] else ''))
    if info['others']:
        L.append('')
        L.append('其他在开：' + '　'.join(g['name'] for g in info['others']))
    L.append('')
    L.append('数据来自游戏主数据，随主数据更新自动刷新。')
    return '\n'.join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true', help='打印 collect() 的原始结构')
    a = ap.parse_args()
    info = collect()
    if not info['total']:
        print('现在没有正在开的招募。')
        return 0
    if a.json:
        print(json.dumps(info, ensure_ascii=False, indent=1))
        return 0
    print(text_of(info))
    return 0


if __name__ == '__main__':
    sys.exit(main())
