#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从主数据重建 data/on/index.json（角色 / 卡牌索引，供 /on查卡 用）。

主数据每次更新后都要重跑一次 —— `tools/on_master.js --apply` 现在会自动调用本脚本。
输出结构与旧的 index.json 完全一致（字段、别名规则、排序都照搬）：

    {generated, rarityLabel, typeName, characters[], cards[]}

别名规则（和原来一致）：角色的中文名/短名/日文/英文原文，去掉空格，再按 "/" 与空格切词
（长度 > 1 的词也算），加上角色 ID 本身。这样「灯 / 高松灯 / Tomori / 1」都能命中。
"""
import json
import os
import sys
import time

ON = os.environ.get('ON_DIR', '/home/admin/bot/data/on')
sys.path.insert(0, ON)
import cardimg as C  # noqa: E402


def build():
    d = C.Data()
    chars = []
    for cid in sorted(d.chars):
        ch = d.chars[cid]
        cards = [c for c in d.cards if c['_characterID'] == cid]
        if not cards:
            continue
        aliases = {str(cid)}
        for lang in ('_nameTextID', '_shortNameTextID'):
            tid = ch.get(lang)
            if not tid:
                continue
            for key in ('_simplifiedChinese', '_traditionalChinese', '_japanese', '_english'):
                v = d.txt(tid, key)
                if not v:
                    continue
                aliases.add(v)
                aliases.add(v.replace(' ', ''))
                for part in v.replace('/', ' ').split():
                    if len(part) > 1:
                        aliases.add(part)
        chars.append({
            'id': cid,
            'name': d.zh(ch['_nameTextID']),
            'band': d.band_name(ch.get('_bandID')),
            'color': ch.get('_mainColorCode', ''),
            'aliases': sorted(a for a in aliases if a),
            'cards': [{'id': c['_id'], 'rarity': c['_rarity'],
                       'title': d.zh(c['_subtitleTextID']),
                       'type': c['_cardType']}
                      for c in sorted(cards, key=lambda x: x['_rarity'])],
        })
    return {
        'generated': time.strftime('%Y-%m-%d %H:%M:%S'),
        'rarityLabel': {'2': 'R', '3': 'SR', '4': 'SSR', '10': 'BD', '20': 'EX'},
        'typeName': {str(k): d.zh(v) for k, v in C.TYPE_TEXT_KEY.items()},
        'characters': chars,
        'cards': [{'id': c['_id'], 'char': c['_characterID'], 'rarity': c['_rarity'],
                   'type': c['_cardType'], 'title': d.zh(c['_subtitleTextID'])}
                  for c in d.cards],
    }


def main():
    idx = build()
    out = os.path.join(ON, 'index.json')
    tmp = out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(idx, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, out)
    sys.stdout.write('index.json: %d 角色, %d 卡牌 -> %s\n'
                     % (len(idx['characters']), len(idx['cards']), out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
