#!/usr/bin/env python3
"""Render game MasterStamp emotes and MasterDegree collectible stickers."""
import argparse
import json
import math
import os
import shutil
import sys
from PIL import Image, ImageDraw

ON = os.environ.get('ON_DIR', '/home/admin/bot/data/on')
sys.path.insert(0, ON)
import cardimg as C


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--kind', choices=['emote', 'degree'], required=True)
    parser.add_argument('--id', type=int)
    parser.add_argument('--char')
    parser.add_argument('--page', type=int, default=1)
    parser.add_argument('--ownership')
    parser.add_argument('--all', action='store_true')
    parser.add_argument('--out', required=True)
    a = parser.parse_args()
    data = C.Data()
    items = C.load('MasterStamp' if a.kind == 'emote' else 'MasterDegree')
    art = os.path.join(os.environ.get('COLLECTIBLE_ART_DIR', os.path.join(ON, 'art')), a.kind)
    by_id = {r['_id']: r for r in items}
    if a.id is not None:
        if a.id not in by_id:
            raise SystemExit('没有这个%s ID：%s' % ('表情' if a.kind == 'emote' else '贴纸', a.id))
        original = os.path.join(art, str(a.id) + '.png')
        if not os.path.isfile(original):
            raise SystemExit('该 ID 的原图尚未就绪，请稍后重试。')
        shutil.copyfile(original, a.out)
        return
    if a.char:
        q = a.char.replace(' ', '')
        ids = []
        for cid, ch in data.chars.items():
            names = [data.txt(ch.get(key), lang).replace(' ', '') for key in ('_nameTextID', '_shortNameTextID') for lang in ('_simplifiedChinese', '_traditionalChinese', '_japanese', '_english')]
            if any(n and (q == n or q in n) for n in names):
                ids.append(cid)
        if not ids:
            raise SystemExit('没有找到角色「%s」' % a.char)
        items = [r for r in items if set(r.get('_characterIds') or []).intersection(ids)]
    owner = json.load(open(a.ownership, encoding='utf-8')) if a.ownership else {}
    collection = owner.get('collection') or {}
    known = collection.get('known') is True
    counts = {int(r['id']): int(r['count']) for r in collection.get('counts', []) if isinstance(r, dict)} if known else {}
    owned = lambda r: counts.get(r['_id'], 0) > 0
    items.sort(key=lambda r: (0 if a.kind == 'degree' and known and owned(r) else 1, r.get('_orderNum', r.get('_priority', 0)), r['_id']))
    page_count = max(1, math.ceil(len(items) / 24))
    if not 1 <= a.page <= page_count:
        raise SystemExit('页码应为 1～%d；例：/on%s 页2' % (page_count, '表情' if a.kind == 'emote' else '贴纸'))
    selected = items if a.all else items[(a.page - 1) * 24:a.page * 24]
    groups = [('表情' if a.kind == 'emote' else '贴纸图鉴', selected)]
    if a.kind == 'degree' and known:
        groups = [('已有', [r for r in selected if owned(r)]), ('未拥有', [r for r in selected if not owned(r)])]
    groups = [(title, rows) for title, rows in groups if rows]
    cell, gap, pad, cols, label_h = (220, 18, 30, 10, 74) if a.kind == 'degree' else (180, 18, 26, 4, 56)
    player = owner.get('player') if a.kind == 'degree' else None
    profile_h = 190 if isinstance(player, dict) and player.get('profileId') else 0
    width = pad * 2 + cols * cell + (cols - 1) * gap
    height = profile_h + 158 + sum(46 + math.ceil(len(rows) / cols) * (cell + label_h + gap) for _, rows in groups) + 58
    canvas = Image.new('RGBA', (width, height), (246, 247, 250, 255))
    draw = ImageDraw.Draw(canvas)
    fonts = C.pick_fonts()
    if profile_h:
        draw.rounded_rectangle((pad, 20, width-pad, 178), 18, fill=(255,255,255,255), outline=(224,229,239))
        avatar_path = player.get('avatar')
        if avatar_path and os.path.isfile(avatar_path):
            with Image.open(avatar_path) as source:
                avatar = source.convert('RGBA')
                avatar.thumbnail((130,130), getattr(Image,'Resampling',Image).LANCZOS)
                canvas.alpha_composite(avatar,(pad+16+(130-avatar.width)//2,34+(130-avatar.height)//2))
        tx=pad+170
        draw.text((tx,34), str(player.get('name') or '未命名玩家')[:40], font=fonts.get(32,False), fill=(36,40,54))
        draw.text((tx,84), 'UID %s · RANK %s' % (player.get('profileId'), player.get('rank') or '—'), font=fonts.get(24,False), fill=(70,86,117))
        draw.text((tx,124), '更新日期：%s' % (player.get('lastUpdatedAt') or '未知'), font=fonts.get(22,False), fill=(99,109,131))
    title = '表情图鉴' if a.kind == 'emote' else '贴纸收藏'
    draw.text((pad, profile_h + 20), title, font=fonts.get(32, False), fill=(36, 40, 54))
    if a.kind == 'degree':
        subtitle = ('已有 %d 种 · 未拥有 %d 种' % (sum(owned(r) for r in items), sum(not owned(r) for r in items))) if known else '共 %d 张 · 发送 /on贴纸 ID 查看原图' % len(items)
    else:
        subtitle = '发送 /on表情 ID 查看原图'
    draw.text((pad, profile_h + 67), subtitle, font=fonts.get(21, False), fill=(89, 100, 120))
    detail = ('全部 %d 张 · %s' % (len(items), a.char or '全部分类')) if a.all else ('第 %d / %d 页 · 共 %d 张 · %s' % (a.page, page_count, len(items), a.char or '全部'))
    draw.text((pad, profile_h + 103), detail, font=fonts.get(19, False), fill=(100,110,130))
    y = profile_h + 153
    for heading, rows in groups:
        draw.text((pad, y), heading, font=fonts.get(25, False), fill=(46, 89, 133))
        y += 46
        for i, row in enumerate(rows):
            r, c = divmod(i, cols)
            x, top = pad + c * (cell + gap), y + r * (cell + label_h + gap)
            draw.rounded_rectangle((x, top, x + cell, top + cell), 12, fill=(255, 255, 255, 255), outline=(224, 229, 239))
            image_path = os.path.join(art, str(row['_id']) + '.png')
            if os.path.isfile(image_path):
                with Image.open(image_path) as source:
                    image = source.convert('RGBA')
                    if a.kind == 'degree':
                        # Treat the original preview as a square containing the texture.
                        # Portrait stickers keep the head, matching the reference preview.
                        edge = max(image.size)
                        square = Image.new('RGBA', (edge,edge), (0,0,0,0))
                        offset = ((edge-image.width)//2,(edge-image.height)//2)
                        square.alpha_composite(image,offset)
                        side = max(1,edge//2)
                        left, upper = (edge-side)//2, (edge-side)//2
                        if image.height > image.width:
                            bbox = image.getchannel('A').point(lambda value: 255 if value>25 else 0).getbbox()
                            if bbox:
                                upper = max(0,min(edge-side,bbox[1]+offset[1]-side//10))
                        image = square.crop((left,upper,left+side,upper+side))
                    image.thumbnail((cell - 14, cell - 14), getattr(Image, 'Resampling', Image).LANCZOS)
                    canvas.alpha_composite(image, (x + (cell - image.width) // 2, top + (cell - image.height) // 2))
            else:
                draw.text((x + 15, top + 76), '原图暂未就绪', font=fonts.get(18, False), fill=(125, 134, 151))
            name = (data.zh(row.get('_nameTextId')) or '').replace('[贴纸]', '').replace('【贴纸】', '')
            label = '#%s %s' % (row['_id'], name)
            limit = 11 if a.kind == 'degree' else 10
            draw.text((x+3,top+cell+4), label[:limit], font=fonts.get(18,False), fill=(53,61,78))
            if a.kind == 'degree' and len(label)>limit:
                draw.text((x+3,top+cell+27),label[limit:limit*2],font=fonts.get(18,False),fill=(53,61,78))
            if a.kind == 'degree' and known:
                draw.text((x + 3, top + cell + 50), ('已有 ×%d' % counts[row['_id']]) if owned(row) else '未拥有', font=fonts.get(17, False), fill=(46, 135, 104) if owned(row) else (135, 141, 155))
        y += math.ceil(len(rows) / cols) * (cell + label_h + gap)
    footer = '/on贴纸 ID 查看完整原图' if a.kind == 'degree' else '/on表情 ID 查看原图 · /on表情 页2 翻页'
    draw.text((pad,height-40),footer,font=fonts.get(18,False),fill=(99,109,131))
    if a.kind == 'degree':
        canvas.convert('RGB').save(a.out, format='JPEG', quality=90, optimize=True)
    else:
        canvas.convert('RGB').save(a.out)


if __name__ == '__main__':
    main()

