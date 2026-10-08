#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""主数据表 .bin -> JSON
  布局（已由 Frida 抓取 + 240/240 验证）:
    文件头 64 字节 = A1 || IV（明文，A1 是固定前缀，IV 随文件）
    其余 = Rijndael-256-CBC(Nb=8，不是 AES) 密文
    -> 去 PKCS#7（32 字节对齐）-> gzip -> JSON
  用法: python3 master_decrypt.py <in.bin> <out.json>
"""
import sys, os, gzip

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rijndael import Rijndael

KEY = bytes.fromhex("0532791c510a08eb7ede6b46c6ba71ea9aa2a3cfb678a595f89d67c8a5e493b6")
IV = bytes.fromhex("9b94c91e242a562e97fcd505b75a5129b2b80632a269034cf942ec7293d489a1")
HEADER = 64
A1 = bytes.fromhex("b50b23a5fd628c3dc386f7488f81d6b0450b8c89671574f55a3ad815f10b8e30")


def decrypt(raw):
    if len(raw) < HEADER + 32:
        raise ValueError("文件太短: %d" % len(raw))
    if raw[:32] != A1:
        raise ValueError("文件头不是 A1 前缀，可能不是主数据表")
    pt = Rijndael(KEY, 256).decrypt_cbc(raw[HEADER:], IV)
    n = pt[-1]
    if 1 <= n <= 32 and pt[-n:] == bytes([n]) * n:
        pt = pt[:-n]
    if pt[:2] == b"\x1f\x8b":
        pt = gzip.decompress(pt)
    return pt


def main(a, b):
    pt = decrypt(open(a, "rb").read())
    open(b, "wb").write(pt)
    ok = pt.lstrip()[:1] in (b"{", b"[")
    print("OK %s -> %s (%d 字节, JSON=%s)" % (os.path.basename(a), os.path.basename(b), len(pt), ok))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
