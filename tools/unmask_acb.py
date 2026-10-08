#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ACB 内嵌 AWB 的 HCA chunk magic 还原（游戏自己 XOR 0x80 混淆过）
   然后交给 vgmstream 用候选 key 正向验证。
   用法: python3 unmask_acb.py <in.acb> <out.acb>
"""
import sys, struct

def unmask_word(b):
    """chunk magic 还原：逐字节 XOR 0x80，只在该字节异或后成为可打印 ASCII 时才改
       （HCA\\0 的第 4 字节 0x00 -> 0x80 不可打印，保持不动，与实测一致）"""
    out = bytearray(b)
    for i in range(4):
        v = out[i] ^ 0x80
        if 0x20 <= v <= 0x7e:
            out[i] = v
    return bytes(out)

def main(src, dst):
    d = bytearray(open(src, 'rb').read())
    afs = d.find(b'AFS2')
    print('ACB 长度 %d，AFS2 @%d' % (len(d), afs))
    if afs < 0:
        print('未找到 AFS2'); return 1
    # AFS2 头
    magic = d[afs:afs + 4]
    ver, off_size, id_size, reserved, count = struct.unpack('>IIIII', d[afs + 4:afs + 24])
    print('AFS2 version=%d offset_size=%d id_size=%d count=%d' % (ver, off_size, id_size, count))
    if off_size not in (1, 2, 4) or count <= 0 or count > 4096:
        print('AFS2 头解析异常'); return 1
    p = afs + 24
    align = struct.unpack('>H', d[p:p + 2])[0]; p += 2
    offs = []
    for _ in range(count + 1):
        v = int.from_bytes(d[p:p + off_size], 'big'); p += off_size
        offs.append(v)
    print('alignment=%d，子文件 %d 个，首偏移=%d 末偏移=%d' % (align, count, offs[0], offs[-1]))
    base = afs                                  # 子文件偏移一般相对 AFS2 起点
    fixed = 0
    for k in range(count):
        start = base + offs[k]
        if start + 16 > len(d):
            break
        off = start
        chain = []
        for _ in range(16):
            if off + 8 > len(d):
                break
            raw = bytes(d[off:off + 4])
            size = struct.unpack('>I', d[off + 4:off + 8])[0]
            m = unmask_word(raw)
            if m != raw:
                d[off:off + 4] = m
                fixed += 1
            chain.append(m.decode('latin1').replace('\x00', '.'))
            if m[:3] in (b'ciph', b'loop', b'pad') or size < 8:
                break
            off += size
        print('  子文件#%-3d @%-8d chunk链: %s' % (k, offs[k], ' -> '.join(chain)))
    open(dst, 'wb').write(bytes(d))
    print('已还原 %d 个 magic -> %s' % (fixed, dst))
    return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
