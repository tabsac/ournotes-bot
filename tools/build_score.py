#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按游戏表推算每首曲子每个难度的「单局效益（分数）」与「效率（分数/秒）」。

公式（全部取自主数据）：
  效益 = BASE × Σ_{i=1..C} (1 + comboBonus(i)) × (1 + skillBonus)
    · C           = MasterLiveMusicScore._fullComboCount（该谱面的连击数，权威值）
    · comboBonus  = MasterLiveComboScoreBonus（每 10 连 +1%，超过 100 连每 10 连 +0.5%，累计封顶 +30%）
    · skillBonus  = 演出技能得分 UP 的等效加成（默认 +43%，与社区榜「技能占比 ~30%」一致）
    · BASE        = 单连击基础分，按「满技能满连击 ≈ 该曲 SSS 线」校准（默认 7000）
  时长 = 谱面最后一个 tick 按 bpm 事件逐段积分（chart3.chart_meta）
  效率 = 效益 / 时长

输出 data/on/score.json ：{ "params": {...}, "rows": [ {id, diff, level, combo, dur, benefit, eff} ] }
用法：python3 tools/build_score.py
"""
import json, os, sys, glob

ON = os.environ.get('ON_DIR') or '/home/admin/bot/data/on'
sys.path.insert(0, ON)
import chart3  # noqa: E402

BASE = 7000.0          # 单连击基础分（按 SSS 线校准；改这一个数就能整体缩放）
SKILL_BONUS = 0.43     # 满技能演出技能的等效得分加成


def combo_bonus_table():
    """[(所需连击, 加成)] —— 只取 _comboBonusType = 0（普通演出）"""
    rows = json.load(open(os.path.join(ON, 'master', 'MasterLiveComboScoreBonus.json')))['_allData']
    out = [(int(r['_requiredComboCount']), float(r['_bonusFactor']))
           for r in rows if int(r.get('_comboBonusType') or 0) == 0]
    out.sort()
    return out


def combo_sum(count, table):
    """Σ_{i=1..count} (1 + bonus(i))：bonus 是「过档累加」"""
    total = 0.0
    bonus = 0.0
    k = 0
    for i in range(1, int(count) + 1):
        while k < len(table) and table[k][0] <= i:
            bonus += table[k][1]
            k += 1
        total += 1.0 + bonus
    return total


def main():
    table = combo_bonus_table()
    songs = json.load(open(os.path.join(ON, 'songs.json')))['songs']
    combo_of = {(s['id'], c['name']): (c.get('combo'), c.get('display'))
                for s in songs for c in (s.get('charts') or [])}
    rows = []
    miss_chart = 0
    for f in sorted(glob.glob(os.path.join(ON, 'chart', '*.json'))):
        base = os.path.basename(f)[:-5]
        try:
            sid_s, diff = base.rsplit('_', 1)
            sid = int(sid_s)
        except Exception:
            continue
        combo, level = combo_of.get((sid, diff), (None, None))
        if not combo:
            continue
        try:
            chart = json.load(open(f, encoding='utf-8'))
            m = chart3.chart_meta(chart)
        except Exception:
            miss_chart += 1
            continue
        dur = float(m['dur'])
        if dur <= 1:
            continue
        benefit = BASE * combo_sum(combo, table) * (1.0 + SKILL_BONUS)
        rows.append({
            'id': sid, 'diff': diff, 'level': level, 'combo': int(combo),
            'dur': round(dur, 2), 'benefit': round(benefit), 'eff': round(benefit / dur, 1),
        })
    rows.sort(key=lambda r: -r['benefit'])
    out = {
        'params': {'base': BASE, 'skillBonus': SKILL_BONUS, 'comboTable': table,
                   'note': '效益 = 单局理论最高分（按主数据表推算），效率 = 效益/时长'},
        'rows': rows,
    }
    path = os.path.join(ON, 'score.json')
    with open(path, 'w', encoding='utf-8') as fp:
        json.dump(out, fp, ensure_ascii=False, indent=1)
    print('写出 %s：%d 条（跳过的谱面 %d）' % (path, len(rows), miss_chart))
    for r in rows[:5]:
        print('  %6d %-7s Lv%-5s combo %4d  %6.1fs  效益 %9d  效率 %8.1f' % (
            r['id'], r['diff'], r['level'], r['combo'], r['dur'], r['benefit'], r['eff']))


if __name__ == '__main__':
    main()
