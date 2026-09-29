#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hca_decode.py - Our Notes (BanG Dream! Our Notes) audio decoder.

Locates the HCA inside an ACB / AWB / bare HCA and decodes it to WAV with
`tools/hca_dec` (clHCA driven directly -- see tools/hca_dec.c for the full story).

    hca_decode.py <in.acb|awb|hca> <out.wav>    decode
    hca_decode.py --info <in>                   print the header, decode nothing

Three things that made every off-the-shelf attempt fail (all handled in hca_dec):

1. Do NOT "restore" the chunk magics.  They are only |0x80'd ('HCA\\0' -> c8 c3 c1 00),
   which clHCA already unmasks with & 0x7f7f7f7f.  The header carries a CRC16
   (poly 0x8005, MSB-first, init 0) over the header AS STORED in its last two bytes,
   so rewriting the magics -> HCA_ERROR_CHECKSUM -> vgmstream's opaque
   "HCA: unknown format (report)".

2. The payload is enciphered with a PER-FILE substitution table derived from the
   AWB's AFS2 subkey (the standard CRI scheme):
       eff   = <基础密钥，见 secrets.json 的 hcaBaseKey> * ((subkey << 16) | ((uint16_t)~subkey + 2))
       table = cipher_init56(eff)          # clHCA's 56-bit keycode cipher
       plain[i] = table[cipher[i]]         # for i >= header_size
   For initialbgm (subkey 0xbd94) this reproduces the table read live from the
   running game byte-for-byte (256/256).

3. Each 682-byte block ends with its own CRC16, and clHCA checks it BEFORE
   deciphering -- i.e. the CRC covers the CIPHERTEXT.  After substituting the
   payload every block's CRC has to be rebuilt, or every block fails with
   HCA_ERROR_CHECKSUM.

Note: vgmstream-cli r2117 is NOT used.  On these files it silently emits ~97%
zero samples while clHCA driven directly decodes the full track cleanly, so it
appeared to work while producing near-silence.
"""
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HCA_DEC = os.path.join(HERE, 'hca_dec')
MASK = 0x7F7F7F7F
VERSIONS = (0x0101, 0x0102, 0x0103, 0x0200, 0x0300)


def rd32(d, o):
    return struct.unpack_from('>I', d, o)[0]


def rd16(d, o):
    return struct.unpack_from('>H', d, o)[0]


def find_hca(d):
    """Locate the HCA inside an HCA / AWB / ACB buffer."""
    for o in range(0, max(0, len(d) - 0x20)):
        if (rd32(d, o) & MASK) != 0x48434100:
            continue
        ver, hdr = rd16(d, o + 4), rd16(d, o + 6)
        if ver not in VERSIONS or not (0x20 <= hdr <= 0x800) or o + hdr > len(d):
            continue
        if (rd32(d, o + 8) & MASK) != 0x666D7400:
            continue
        info = {'offset': o, 'version': ver, 'header_size': hdr,
                'channels': d[o + 12], 'rate': int.from_bytes(d[o + 13:o + 16], 'big'),
                'blocks': rd32(d, o + 16), 'delay': rd16(d, o + 20),
                'padding': rd16(d, o + 22)}
        cm = rd32(d, o + 24) & MASK
        if cm not in (0x636F6D70, 0x64656300):
            continue
        info['frame_size'] = rd16(d, o + 28)
        if not (8 <= info['frame_size'] <= 0x2000) or info['blocks'] == 0:
            continue
        if not (1 <= info['channels'] <= 8) or not (8000 <= info['rate'] <= 192000):
            continue
        if o + hdr + info['blocks'] * info['frame_size'] > len(d):
            continue
        if d[o + hdr:o + hdr + 2] != b'\xff\xff':
            continue
        # AFS2 subkey (u16 LE at +0x0E) when the AWB header sits just in front
        a = d.find(b'AFS2', 0, max(0, o))
        info['subkey'] = 0
        if 0 <= a and (o - a) <= 64:
            info['subkey'] = d[a + 0x0E] | (d[a + 0x0F] << 8)
        p, lim = o + 0x28, o + hdr
        info['ciph_type'] = 0
        while p + 4 <= lim:
            m = rd32(d, p) & MASK
            if m == 0x63697068:
                info['ciph_type'] = rd16(d, p + 4)
                break
            if m == 0x70616400:
                break
            p += 2
        info['duration'] = (info['blocks'] * 1024 - info['delay']
                            - info['padding']) / float(info['rate'])
        return info
    raise ValueError('no HCA found in %d bytes' % len(d))


def decode(src_path, dst_wav):
    """Decode to WAV. Raises if the stream did not decode cleanly."""
    p = subprocess.Popen([HCA_DEC, src_path, dst_wav],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    log, _ = p.communicate()
    log = log.decode('utf-8', 'replace')
    if p.returncode != 0 or not os.path.exists(dst_wav):
        raise RuntimeError('hca_dec rc=%d: %s' % (p.returncode, log.strip()[-300:]))
    return log


def main(argv):
    if len(argv) < 2:
        sys.stderr.write(__doc__)
        return 2
    if argv[1] == '--info':
        d = open(argv[2], 'rb').read()
        info = find_hca(d)
        for k in ('offset', 'version', 'header_size', 'channels', 'rate', 'blocks',
                  'frame_size', 'delay', 'padding', 'ciph_type', 'subkey'):
            sys.stdout.write('%-12s %s\n' % (k, info.get(k)))
        sys.stdout.write('%-12s %.3f s\n' % ('duration', info['duration']))
        return 0
    if len(argv) < 3:
        sys.stderr.write('usage: %s <in> <out.wav>\n' % argv[0])
        return 2
    log = decode(argv[1], argv[2])
    for line in log.strip().split('\n'):
        sys.stderr.write('[hca] %s\n' % line.split('hca_dec: ')[-1])
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
