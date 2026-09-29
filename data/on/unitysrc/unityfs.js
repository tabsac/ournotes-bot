'use strict';
// UnityFS container parsing: header -> compressed block table -> blocks -> files.
//
// Layout (UnityFS, version >= 6):
//   "UnityFS\0" | version u32 | unityVersion cstr | unityRevision cstr
//   size i64 | compressedBlocksInfoSize u32 | uncompressedBlocksInfoSize u32 | flags u32
//   [version >= 7] align 16
//   blocksInfo (compressed, size = compressedBlocksInfoSize)
//   [compression != none] align 16
//   block data (each block compressed independently)
//
// flags: bits 0-5 compression (0 none, 1 LZMA, 2 LZ4, 3 LZ4HC), 0x40 blocksInfo
// combined with directory info, 0x80 blocksInfoAtTheEnd, 0x200 blockInfoNeedsPadding.

const { Reader } = require('./reader');
const { decompressBlock } = require('./lz4');

const COMPRESSION = { 0: 'none', 1: 'lzma', 2: 'lz4', 3: 'lz4hc' };

function parseUnityFS(buf) {
  const r = new Reader(buf, true);
  const signature = r.cstr();
  if (signature !== 'UnityFS' && signature !== 'UnityWeb') {
    throw new Error(`not a UnityFS bundle (signature=${JSON.stringify(signature)})`);
  }
  const version = r.u32();
  const unityVersion = r.cstr();
  const unityRevision = r.cstr();
  const size = r.i64();
  const compressedBlocksInfoSize = r.u32();
  const uncompressedBlocksInfoSize = r.u32();
  const flags = r.u32();

  const compression = COMPRESSION[flags & 0x3f] ?? `unknown(${flags & 0x3f})`;
  const blocksAndDirectoryCombined = (flags & 0x40) !== 0;
  const blocksInfoAtTheEnd = (flags & 0x80) !== 0;
  const blockInfoNeedsPadding = (flags & 0x200) !== 0;

  if (version >= 7) r.align(16);

  // The block table may sit at the end of the file (flag 0x80); for these bundles
  // it is inline, but honour the flag so the parser matches the spec.
  const blocksInfoStart = blocksInfoAtTheEnd
    ? buf.length - compressedBlocksInfoSize
    : r.pos;

  const compressedBlocksInfo = buf.subarray(blocksInfoStart, blocksInfoStart + compressedBlocksInfoSize);
  let blocksInfo = compressedBlocksInfo;
  if (compression !== 'none') {
    blocksInfo = decompressAny(compressedBlocksInfo, uncompressedBlocksInfoSize, compression);
  }

  const bi = new Reader(blocksInfo, true);
  const dataHash = blocksAndDirectoryCombined ? bi.bytes(16) : null;

  const blockCount = bi.u32();
  const blocks = [];
  for (let i = 0; i < blockCount; i++) {
    blocks.push({
      uncompressedSize: bi.u32(),
      compressedSize: bi.u32(),
      flags: bi.u16(),
    });
  }

  const nodeCount = bi.u32();
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      offset: bi.i64(),
      size: bi.i64(),
      flags: bi.u32(),
      path: bi.cstr(),
    });
  }

  // Data blocks start after the block table, aligned.
  let dataPos = blocksInfoAtTheEnd ? 0 : blocksInfoStart + compressedBlocksInfoSize;
  if (compression !== 'none') {
    dataPos = dataPos + ((16 - (dataPos % 16)) % 16);
  }

  const files = new Map();
  const blockData = [];
  let p = dataPos;
  for (const b of blocks) {
    const raw = buf.subarray(p, p + b.compressedSize);
    p += b.compressedSize;
    blockData.push(decompressAny(raw, b.uncompressedSize, COMPRESSION[b.flags & 0x3f] ?? compression));
  }

  // nodes address into the concatenation of all decompressed blocks
  const all = Buffer.concat(blockData);
  for (const n of nodes) {
    const off = Number(n.offset);
    const len = Number(n.size);
    files.set(n.path, all.subarray(off, off + len));
  }

  return {
    signature,
    version,
    unityVersion,
    unityRevision,
    size: Number(size),
    flags,
    compression,
    blocksAndDirectoryCombined,
    blocksInfoAtTheEnd,
    blockInfoNeedsPadding,
    dataHash,
    blocks,
    nodes,
    files,
  };
}

function decompressAny(src, destSize, compression) {
  switch (compression) {
    case 'lz4':
    case 'lz4hc':
      return decompressBlock(src, destSize);
    case 'none':
      return src;
    case 'lzma':
      throw new Error('lzma blocks are not supported by this parser');
    default:
      throw new Error(`unknown compression ${compression}`);
  }
}

module.exports = { parseUnityFS, COMPRESSION };
