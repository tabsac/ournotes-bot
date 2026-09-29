#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""当期招募（卡池）一览，供 /on卡池 用。

数据来源：MasterGacha（时间/横幅/概率组）、MasterGachaLot（稀有度权重）、
MasterGachaPrize（Pick Up 卡）、MasterGachaProduct（抽数与价格）。
概率 = 组内权重 / 组内权重和，按「成员卡 / 留影卡」分开列。
"""
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


def main():
    d = C.Data()
    gacha = C.load('MasterGacha')
    lot = C.load('MasterGachaLot')
    prize = C.load('MasterGachaPrize')

    now = time.time()
    alive, dead = [], []
    for g in gacha:
        st, en = parse_dt(g.get('_startAt')), parse_dt(g.get('_endAt'))
        if st and st > now:
            continue
        (alive if (en is None or en >= now) else dead).append(g)
    if not alive:
        print('现在没有正在开的招募。')
        return 0

    def card_of(cid):
        c = d.by_id.get(cid)
        if not c:
            return None
        ch = d.chars.get(c['_characterID'])
        return {'title': d.zh(c['_subtitleTextID']),
                'char': d.zh(ch['_nameTextID']) if ch else '',
                'rarity': c['_rarity']}

    def rates(g):
        rows = [r for r in lot if r['_lotGroupId'] == g['_lotGroupId']]
        total = sum(r['_weight'] for r in rows) or 1
        out = {}
        for r in rows:
            key = RESTYPE.get(r['_resourceTypeConstraint'], str(r['_resourceTypeConstraint']))
            out.setdefault(key, []).append((RARITY.get(r['_rarityConstraint'], '?'),
                                            100.0 * r['_weight'] / total))
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

    featured = [g for g in alive if pickups(g)]
    others = [g for g in alive if g not in featured]

    L = []
    span = ''
    ends = sorted({g['_endAt'][:10] for g in featured if g.get('_endAt') and g['_endAt'] != 'null'})
    if ends:
        span = '（至 %s）' % ends[-1]
    L.append('🎴 当期招募%s' % span)

    for g in featured:
        L.append('')
        L.append('【%s】' % d.zh(g['_nameTextId']))
        for kind, rows in sorted(rates(g).items()):
            rows.sort(key=lambda x: -x[1])
            L.append('　%s：%s' % (kind, '　'.join('%s %.1f%%' % (r, p) for r, p in rows)))
        ps = pickups(g)
        up = [c for c in ps if c['rarity'] == 4] or ps
        L.append('　Pick Up：')
        for c in up:
            L.append('　　%s %s%s' % (RARITY.get(c['rarity'], ''), c['title'],
                                     ('（%s）' % c['char']) if c['char'] else ''))

    if others:
        L.append('')
        L.append('其他在开：' + '　'.join(d.zh(g['_nameTextId']) for g in others))
    L.append('')
    L.append('数据来自游戏主数据，随主数据更新自动刷新。')
    print('\n'.join(L))
    return 0


if __name__ == '__main__':
    sys.exit(main())
