#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ACB → 按 cue 名取音轨并解码（layout 由用户实测给出）

ACB 的 @UTF 头（表起点 base）：
  0x00 "@UTF" | 0x04 u32BE table_size | 0x0C u32BE strings_offset | 0x10 u32BE data_offset
  0x14 u32BE table_name_offset | 0x1C u32BE row_count | 0x20 起列定义（5B/列）
  字符串表 = base+8+strings_offset；data 区 = base+8+data_offset
列定义 = u8 type（低半字节：0=u8 2=u16 4=u32 a=string b=blob）+ u32BE name_offset（相对字符串表）
嵌套表：data 区里按 32 字节对齐的 @UTF（Cue / CueName / Waveform / …），表头同构
AFS2 v2（小端）：+0x04 ver +0x05 offset_size +0x06 id_size +0x08 u32LE num_files
                  +0x0C u16LE alignment +0x0E u16LE subkey
                  随后 ids / offsets / sizes（各 num_files 个，按各自 size 小端）
cue → 音轨：CueName[name] → CueIndex；Waveform[CueIndex].MemoryAwbId → AFS2 里同 id 的块

    acb_cues.py --acb x.acb --list
    acb_cues.py --acb x.acb --select Growth_Tomori_LevelUP_01 [--out cue.hca]
    acb_cues.py --acb x.acb --select <name> --wav out.wav      # 直接调 hca_dec 解码
"""
import argparse
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TYPE_SIZE = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 0x0a: 4, 0x0b: 8}


class Acb:
    def __init__(self, path):
        self.d = open(path, 'rb').read()

    def u32(self, o): return struct.unpack_from('>I', self.d, o)[0]
    def u16(self, o): return struct.unpack_from('>H', self.d, o)[0]
    def u32le(self, o): return struct.unpack_from('<I', self.d, o)[0]
    def u16le(self, o): return struct.unpack_from('<H', self.d, o)[0]

    def cstr(self, o):
        e = self.d.index(b'\0', o)
        return self.d[o:e].decode('utf8', 'replace')

    def utf(self, base):
        d = self.d
        assert d[base:base + 4] == b'@UTF', 'no @UTF at %d' % base
        size = self.u32(base + 4)
        strings = base + 8 + self.u32(base + 0x0C)
        data = base + 8 + self.u32(base + 0x10)
        name = self.cstr(strings + self.u32(base + 0x14))
        nrows = self.u32(base + 0x1C)
        rowlen_hdr = self.u16(base + 0x1A)
        ncols_hdr = self.u16(base + 0x18)
        base_p = base + 0x20

        def read_cols(n):
            out = []
            for i in range(n):
                q = base_p + 5 * i
                if q + 5 > len(d):
                    return None
                typ = d[q] & 0x0f
                if typ not in TYPE_SIZE:
                    return None
                pos = strings + self.u32(q + 1)
                if pos >= len(d) or not (32 <= d[pos] < 127):
                    return None
                nm = self.cstr(pos)
                if not nm or len(nm) > 48 or ' ' in nm:
                    return None
                out.append((typ, nm))
            return out

        cols = None
        if 1 <= ncols_hdr <= 48:
            cand = read_cols(ncols_hdr)
            # 自检：列宽之和必须等于头里的 rowlen
            if cand and sum(TYPE_SIZE[t] for t, _ in cand) == rowlen_hdr:
                cols = cand
        if cols is None:                     # 退回到「一直读到名字解不出来」
            cols = []
            q = base_p
            while q + 5 <= base + size and len(cols) < 64:
                typ = d[q] & 0x0f
                if typ not in TYPE_SIZE:
                    break
                pos = strings + self.u32(q + 1)
                if pos >= len(d) or not (32 <= d[pos] < 127):
                    break
                nm = self.cstr(pos)
                if not nm or len(nm) > 48 or ' ' in nm:
                    break
                cols.append((typ, nm))
                q += 5
        rowlen = sum(TYPE_SIZE[t] for t, _ in cols)
        p = base_p + 5 * len(cols)
        rows = []
        rp = p
        try:
          for _ in range(nrows):
              row = []
              for typ, _nm in cols:
                  if typ == 0:
                      row.append(d[rp])
                  elif typ == 2:
                      row.append(self.u16(rp))
                  elif typ == 4:
                      row.append(self.u32(rp))
                  elif typ == 0x0a:
                      row.append(self.cstr(strings + self.u32(rp)))
                  else:
                      row.append(None)
                  rp += TYPE_SIZE[typ]
              rows.append(row)
        except Exception:
            rows = []                      # 顶层 Header 的行含 blob/内联数据，解不动也无所谓
        return {'base': base, 'size': size, 'name': name, 'cols': [c[1] for c in cols],
                'nrows': nrows, 'rowlen': rowlen, 'strings': strings, 'data': data, 'rows': rows}

    def nested(self, limit=400000):
        """data 区里按 32 字节对齐的嵌套表"""
        root = self.utf(0)
        out = []
        o = root['data']
        end = min(len(self.d), root['data'] + limit)
        while o < end - 4:
            if self.d[o:o + 4] == b'@UTF':
                try:
                    t = self.utf(o)
                    if t['size'] > 8:
                        out.append(t)
                        o += max(32, ((t['size'] + 31) // 32) * 32)
                        continue
                except Exception:
                    pass
            o += 32
        return root, out

    def afs2(self):
        a = self.d.find(b'AFS2')
        if a < 0:
            raise ValueError('no AFS2')
        ver, osz, isz = self.d[a + 4], self.d[a + 5], self.d[a + 6]
        n = self.u32le(a + 8)
        subkey = self.u16le(a + 0x0E)
        p = a + 0x10
        ids = [int.from_bytes(self.d[p + i * isz: p + (i + 1) * isz], 'little') for i in range(n)]
        p += n * isz
        offs = [int.from_bytes(self.d[p + i * osz: p + (i + 1) * osz], 'little') for i in range(n)]
        p += n * osz
        sizes = [int.from_bytes(self.d[p + i * osz: p + (i + 1) * osz], 'little') for i in range(n)]
        return {'base': a, 'ver': ver, 'num': n, 'subkey': subkey, 'ids': ids, 'offs': offs, 'sizes': sizes}

    def cues(self):
        """[{name, cueIndex, subIdx, offset, size}]"""
        _root, tables = self.nested()
        by = {t['name']: t for t in tables}
        cn = by.get('CueName')
        wf = by.get('Waveform')
        cue = by.get('Cue')
        afs = self.afs2()
        id2block = {v: i for i, v in enumerate(afs['ids'])}
        out = []
        if cn and wf:
            for i, row in enumerate(cn['rows']):
                nm, idx = row[0], row[1]
                # AFS2 的 id 就是 0,1,2,… 连续，与 CueIndex 同序；Waveform 的 MemoryAwbId 列
                # 在这个 build 里读出来是别的字段，所以直接用「同索引」取块（用户提示的常规做法）
                sub = idx
                blk = id2block.get(sub) if sub in id2block else (sub if isinstance(sub, int) and sub < afs['num'] else None)
                out.append({
                    'name': nm, 'cueIndex': idx, 'memoryAwbId': sub, 'block': blk,
                    'offset': afs['offs'][blk] if blk is not None else None,
                    'size': block_size(afs, blk) if blk is not None else None,
                })
        elif cue:
            for i, row in enumerate(cue['rows']):
                out.append({'name': 'cue#%d' % i, 'cueIndex': row[0], 'memoryAwbId': None,
                            'block': i if i < len(afs['offs']) else None,
                            'offset': afs['offs'][i] if i < len(afs['offs']) else None,
                            'size': afs['sizes'][i] if i < len(afs['sizes']) else None})
        return out, afs, by


def block_size(afs, blk):
    """块大小 = 下一个 offset − 本 offset；最后一块用文件末尾"""
    offs = afs['offs']
    if blk is None or blk >= len(offs):
        return None
    if blk + 1 < len(offs):
        d = offs[blk + 1] - offs[blk]
        return d if d > 0 else None
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--acb', required=True)
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--select')
    ap.add_argument('--out')
    ap.add_argument('--wav')
    a = ap.parse_args()
    acb = Acb(a.acb)
    cues, afs, tables = acb.cues()
    print('AFS2 @%d ver=%d 文件数=%d subkey=0x%04x；嵌套表：%s'
          % (afs['base'], afs['ver'], afs['num'], afs['subkey'], ','.join(tables)))
    print('cue 数 = %d' % len(cues))
    if a.list:
        for c in cues[:40]:
            print('  %-40s cueIndex=%-4s awbId=%-4s block=%-4s size=%s'
                  % (c['name'], c['cueIndex'], c['memoryAwbId'], c['block'], c['size']))
        if len(cues) > 40:
            print('  …')
        return 0
    if not a.select:
        return 0
    hit = next((c for c in cues if c['name'] == a.select), None)
    if not hit:
        print('没有 cue %r（可用 --list 看名字）' % a.select, file=sys.stderr)
        return 1
    print('选中 %s → block=%s offset=%s size=%s subkey=0x%04x'
          % (hit['name'], hit['block'], hit['offset'], hit['size'], afs['subkey']))
    start = afs['base'] + hit['offset']
    blob = acb.d[start:start + hit['size']]
    if a.out:
        open(a.out, 'wb').write(blob)
        print('已写出 %s（%d 字节）' % (a.out, len(blob)))
    if a.wav:
        tmp = a.out or '/tmp/_cue.hca'
        open(tmp, 'wb').write(blob)
        p = subprocess.Popen([os.path.join(HERE, 'hca_dec'), tmp, a.wav, '%04x' % afs['subkey']],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        log, _ = p.communicate()
        print('hca_dec rc=%d %s' % (p.returncode, log.decode('utf-8', 'replace').strip().replace('\n', ' | ')[-300:]))
        return p.returncode
    return 0


if __name__ == '__main__':
    sys.exit(main())
