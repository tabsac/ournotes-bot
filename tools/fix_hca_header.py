#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把这份"无 size 字段"的 HCA 头部重排成标准布局（magic + u32 size + data），
   用 pad chunk 补齐到原 header_size，载荷偏移保持不变。"""
import struct

src = '/tmp/initialbgm.hca'
out = '/tmp/initialbgm_std.hca'
d = open(src, 'rb').read()
assert d[:4] == b'HCA\x00'
hdr = struct.unpack('>H', d[6:8])[0]
i_fmt = d.find(b'fmt\x00', 8, hdr)
i_comp = d.find(b'comp', 8, hdr)
i_ciph = d.find(b'ciph', 8, hdr)
i_pad = d.find(b'pad\x00', 8, hdr)
print('header_size=%d | fmt@%d comp@%d ciph@%d pad@%d' % (hdr, i_fmt, i_comp, i_ciph, i_pad))
fmt = d[i_fmt + 4:i_comp]
comp = d[i_comp + 4:i_ciph]
ciph = d[i_ciph + 4:i_ciph + 6]
print('fmt  (%2d) %s' % (len(fmt), fmt.hex()))
print('comp (%2d) %s' % (len(comp), comp.hex()))
print('ciph (%2d) %s' % (len(ciph), ciph.hex()))

body = b'HCA\x00' + d[4:6] + struct.pack('>H', hdr)
for magic, data in ((b'fmt\x00', fmt), (b'comp', comp), (b'ciph', ciph)):
    body += magic + struct.pack('>I', 4 + len(data)) + data
want = hdr - len(body)                     # pad chunk 的总字节数
body += b'pad\x00' + struct.pack('>I', want - 4) + b'\x00' * (want - 8)
print('重建头部 %d 字节（目标 %d）' % (len(body), hdr))
assert len(body) == hdr, '头部长度不匹配'
body += d[hdr:]
open(out, 'wb').write(body)
print('已写出 %s，总长 %d' % (out, len(body)))
