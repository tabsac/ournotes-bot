#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 catalog 生成「cue sheet → CRI 音频包 URL」映射

规律（用户实测 + 本地复现）：
    URL = <base>/cri_assets_ + <catalog location> + "_" + <internalId 的 32 位哈希>
例：VoiceSystem_01 → location cri/sound/voicesystem_01 + hash 67752781… →
    <base>/cri_assets_cri/sound/voicesystem_01_67752781e724d3b0fa1f04c2d6cc37d1
（没有 .bundle 后缀，所以不在 .bundle inventory 里）

只覆盖其中一套打包方式：01–10 / 21–25 这类 cue sheet 的 ACB 是**独立 raw 资源**，
catalog 里有 location；11–20 那批（VoiceSystem_11…20、VoiceLive_11…20）的 catalog 里
没有 location，ACB 是**内嵌在 bundle 里**的（cri_assets_cri_sound_<sheet>_<hash>.bundle
里的 MonoBehaviour），所以本脚本产出的映射里就没有它们 —— 这部分由指令侧回退到
bundle 路线（见 tools/verify_voicepacks.js 的校验）。

catalog 的字符串格式是 [u32 长度][字节]（不是 7-bit 变长长度 —— 这点踩过坑）。

    cri_url.py --catalog <bin> [--out data/on/cri_url.json] [--check]
"""
import argparse
import json
import os
import re
import struct
import subprocess
import sys

HEX32 = re.compile(r'^[0-9a-f]{32}$')


def strings_of(d):
    """按文件顺序取出所有 [u32 len][bytes] 字符串"""
    out = []
    o, n = 0, len(d)
    while o < n - 5:
        L = struct.unpack_from('<I', d, o)[0]
        if 4 <= L <= 400 and o + 4 + L <= n and all(32 <= c < 127 for c in d[o + 4:o + 4 + L]):
            out.append(d[o + 4:o + 4 + L].decode('latin1'))
            o += 4 + L
            continue
        o += 1
    return out


def build_map(catalog_path, on_dir):
    d = open(catalog_path, 'rb').read()
    strs = strings_of(d)
    # internalId = <名字小写>_<32hex>
    internals = {}
    for s in strs:
        if len(s) > 34 and s[-33] == '_' and HEX32.match(s[-32:]):
            internals.setdefault(s[:-33], set()).add(s[-32:])
    # location：以 /<名字小写> 结尾的路径（不带 .bundle）
    locs = {}
    for s in strs:
        if '/' in s and ' ' not in s and not s.endswith('.bundle'):
            locs.setdefault(s.rsplit('/', 1)[1], set()).add(s)
    # 配对：location 与自己相邻（前一条或后一条）的 32hex 必须属于该 internalId
    all_locs = set()
    for v in locs.values():
        all_locs |= v
    by_loc = {}
    for i, s in enumerate(strs):
        if s not in all_locs:
            continue
        base = s.rsplit('/', 1)[1]
        for j in (i - 1, i + 1):
            if 0 <= j < len(strs) and HEX32.match(strs[j]) and strs[j] in internals.get(base, ()):
                by_loc.setdefault(base, set()).add((s, strs[j]))
    songs = json.load(open(os.path.join(on_dir, 'songs.json')))
    cdn = songs['cdn']
    m = {}
    for name, pairs in by_loc.items():
        m[name] = [{'location': loc, 'hash': h,
                    'url': '%s/cri_assets_%s_%s' % (cdn, loc, h)} for loc, h in sorted(pairs)]
    return m, cdn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--catalog', default='/home/admin/bot/data/on/catalog.bin')
    ap.add_argument('--on', default=os.environ.get('ON_DIR') or '/home/admin/bot/data/on')
    ap.add_argument('--out', default='/home/admin/bot/data/on/cri_url.json')
    ap.add_argument('--check', action='store_true', help='抽 3 个实测 HTTP 状态')
    a = ap.parse_args()
    m, base = build_map(a.catalog, a.on)
    print('cue sheet 映射 %d 个 → %s' % (len(m), a.out))
    json.dump(m, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    for k in list(m)[:5]:
        print('  %-22s %s' % (k, m[k][0]['url'].replace(base, '…')))
    if a.check:
        songs = json.load(open(os.path.join(a.on, 'songs.json')))
        for name in ('VoiceSystem_01', 'VoiceSystem_10', 'VoiceLive', 'VoiceLocation'):
            if name not in m:
                print('  %-22s (映射里没有)' % name); continue
            url = m[name][0]['url']
            p = subprocess.Popen(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code} %{size_download}',
                                  '-u', songs['auth'], '-m', '60', url], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            out, _ = p.communicate()
            print('  %-22s %s' % (name, out.decode().strip()))
    return 0


if __name__ == '__main__':
    sys.exit(main())
