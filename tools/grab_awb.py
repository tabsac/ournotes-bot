#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 catalog 找出完整版(非 short)音频包 -> 下载 -> 解 bundle -> 抠 AWB(AFS2) -> 解析头
   用法: python3 grab_awb.py <song_key> <out.awb>
"""
import gzip, io, json, os, re, struct, subprocess, sys

CAT = '/home/admin/bot/data/on/catalog.bin'
BASE = 'https://l14-prod-hk-patch-sirius.gamerfusiontech.com/prod/hk_27f3c91e8b62d6056c7a19f2e83b6d10/asset/Android'
AUTH = 'sirius:pXrQcRvnwkux6hp89OpgFHytDjm2DTM'
sys.path.insert(0, '/home/admin/bot/data/on/unitysrc')


def main(key, out):
    cat = io.open(CAT, 'rb').read().decode('latin1')
    names = sorted(set(re.findall(r'[A-Za-z0-9_\-\.\(\)]{6,140}\.bundle', cat)))
    cand = [n for n in names if 'cri_assets_cri_sound' in n and key.lower() in n.lower() and '_short' not in n]
    print('含 %s 的完整音频包 %d 个:' % (key, len(cand)))
    for n in cand[:6]:
        print('   ', n)
    if not cand:
        return 2
    name = cand[0]
    raw = '/tmp/full_' + key + '.bundle'
    subprocess.check_call(['curl', '-sS', '-u', AUTH, '--max-time', '180', '-o', raw, BASE + '/' + name])
    print('下载 %s (%d 字节)' % (name, os.path.getsize(raw)))
    js = ("const C=require('/home/admin/bot/data/on/unitysrc/crypto.js'),fs=require('fs');"
          "const n=process.argv[1],buf=fs.readFileSync(process.argv[2]);"
          "const d=C.decryptBundle(buf,n).data;const i=d.indexOf('AFS2');"
          "console.log('bundle 解密头='+JSON.stringify(d.slice(0,8).toString('latin1'))+' AFS2@'+i);"
          "fs.writeFileSync(process.argv[3], d.subarray(i<0?0:i));")
    subprocess.check_call(['node', '-e', js, name, raw, out])
    awb = io.open(out, 'rb').read()
    if not awb.startswith(b'AFS2'):
        print('未抠到 AFS2'); return 3
    print('AWB 字节数', len(awb))
    io.open(out, 'wb').write(awb)
    ver, off_size, id_size, res = awb[4], awb[5], awb[6], awb[7]
    count = struct.unpack('>I', awb[8:12])[0]
    align = struct.unpack('>H', awb[12:14])[0]
    print('AWB video=%d off_size=%d id_size=%d count=%d align=%d' % (ver, off_size, id_size, count, align))
    if not (1 <= off_size <= 4 and 0 < count <= 8192):
        print('AFS2 头仍不可解 —— 该容器也可能被混淆')
        return 4
    p = 14 + (2 if ver >= 2 else 0)
    offs = [int.from_bytes(awb[p + i * off_size:p + (i + 1) * off_size], 'big') for i in range(min(count + 1, 8))]
    print('前几个子文件偏移:', offs)
    for k in range(min(count, 2)):
        st = offs[k]
        off = st
        chain = []
        for _ in range(10):
            if off + 8 > len(awb):
                break
            rawm = awb[off:off + 4]
            size = struct.unpack('>I', awb[off + 4:off + 8])[0]
            mm = bytes(((x ^ 0x80) if 0x20 <= (x ^ 0x80) <= 0x7e else x) for x in rawm)
            chain.append('%s(掩码)/%s(还原) size=%d' % (rawm.hex(), mm.decode('latin1').replace('\0', '.'), size))
            if size < 8:
                break
            off += size
        print('  子文件#%d @%d:' % (k, st))
        for c in chain:
            print('     ', c)
    print('AWB 已写出 ->', out, os.path.getsize(out), '字节')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
