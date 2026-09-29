'use strict';
// LZ4 block-format decompressor.
//
// Unity stores AssetBundle blocks as raw LZ4 *blocks* (not the LZ4 frame format),
// so the `lz4` npm packages that expect a frame header cannot read them. The block
// format is small enough to implement directly and has no dependencies.

/**
 * @param {Buffer} src compressed block
 * @param {number} destSize exact uncompressed size (stored in the block table)
 * @returns {Buffer}
 */
function decompressBlock(src, destSize) {
  const dst = Buffer.allocUnsafe(destSize);
  let sp = 0;
  let dp = 0;

  while (sp < src.length) {
    const token = src[sp++];

    // literal run
    let litLen = token >>> 4;
    if (litLen === 15) {
      let b;
      do {
        b = src[sp++];
        litLen += b;
      } while (b === 255);
    }
    if (litLen > 0) {
      src.copy(dst, dp, sp, sp + litLen);
      sp += litLen;
      dp += litLen;
    }

    if (sp >= src.length) break; // last block ends with literals

    // match copy
    const offset = src.readUInt16LE(sp);
    sp += 2;
    if (offset === 0) throw new Error('lz4: zero match offset');

    let matchLen = token & 0x0f;
    if (matchLen === 15) {
      let b;
      do {
        b = src[sp++];
        matchLen += b;
      } while (b === 255);
    }
    matchLen += 4;

    let mp = dp - offset;
    if (mp < 0) throw new Error('lz4: match offset before start of output');
    // byte-by-byte: matches may overlap the region being written
    for (let i = 0; i < matchLen; i++) dst[dp++] = dst[mp++];
  }

  if (dp !== destSize) {
    throw new Error(`lz4: produced ${dp} bytes, expected ${destSize}`);
  }
  return dst;
}

module.exports = { decompressBlock };
