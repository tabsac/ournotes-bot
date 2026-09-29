'use strict';
// Texture2D -> RGBA8 -> PNG.
//
// Two families of formats:
//   * uncompressed (RGBA32/ARGB32/RGB24/BGRA32/RGBA4444/ARGB4444/RGB565/Alpha8/R8)
//     decoded here directly;
//   * block-compressed (ASTC / BCn / ETC / PVRTC) handed to texture2ddecoder-wasm,
//     which is the wasm build of AssetStudio's Texture2DDecoder — the same C++
//     the Python `texture2ddecoder` package wraps, so the two can be compared
//     byte for byte.
//
// The pixel payload usually lives in the bundle's .resS stream (m_StreamData),
// not inline, so the caller passes the Bundle to resolve it.

const TEXTURE_FORMATS = require('../textureformats');

let wasm = null;
function loader() {
  if (!wasm) wasm = require('texture2ddecoder-wasm');
  return wasm;
}

// Unity TextureFormat -> decoder. Values taken from UnityPy's TextureFormat enum
// (48-53 = ASTC_RGB_*, 54-59 = ASTC_RGBA_*, block sizes 4/5/6/8/10/12).
// `blocks: true` means the payload is padded to whole 16-byte blocks.
const BLOCK_FORMATS = {
  10: { fn: 'decode_bc1', bw: 4, bh: 4, blocks: true },
  12: { fn: 'decode_bc3', bw: 4, bh: 4, blocks: true },
  24: { fn: 'decode_bc6', bw: 4, bh: 4, blocks: true },
  25: { fn: 'decode_bc7', bw: 4, bh: 4, blocks: true },
  26: { fn: 'decode_bc4', bw: 4, bh: 4, blocks: true },
  27: { fn: 'decode_bc5', bw: 4, bh: 4, blocks: true },
  30: { fn: 'decode_pvrtc', bpp: 2, arg: true },
  31: { fn: 'decode_pvrtc', bpp: 2, arg: false },
  32: { fn: 'decode_pvrtc', bpp: 4, arg: true },
  33: { fn: 'decode_pvrtc', bpp: 4, arg: false },
  34: { fn: 'decode_etc1', bw: 4, bh: 4, blocks: true },
  35: { fn: 'decode_atc_rgb4', bw: 4, bh: 4, blocks: true },
  36: { fn: 'decode_atc_rgba8', bw: 4, bh: 4, blocks: true },
  41: { fn: 'decode_eacr', bw: 4, bh: 4, blocks: true },
  42: { fn: 'decode_eacr_signed', bw: 4, bh: 4, blocks: true },
  43: { fn: 'decode_eacrg', bw: 4, bh: 4, blocks: true },
  44: { fn: 'decode_eacrg_signed', bw: 4, bh: 4, blocks: true },
  45: { fn: 'decode_etc2', bw: 4, bh: 4, blocks: true },
  46: { fn: 'decode_etc2a1', bw: 4, bh: 4, blocks: true },
  47: { fn: 'decode_etc2a8', bw: 4, bh: 4, blocks: true },
};

const ASTC_SIZES = { 48: 4, 49: 5, 50: 6, 51: 8, 52: 10, 53: 12, 54: 4, 55: 5, 56: 6, 57: 8, 58: 10, 59: 12, 66: 4, 67: 5, 68: 6, 69: 8, 70: 10 };
for (const [fmt, n] of Object.entries(ASTC_SIZES)) {
  BLOCK_FORMATS[fmt] = { fn: 'decode_astc', bw: n, bh: n, blocks: true, astc: true };
}

// Crunch-compressed DXT/ETC: unpack with the wasm helper, then decode as the
// underlying format.
const CRUNCHED = { 28: 10, 29: 12, 64: 34, 65: 47 };


function formatName(fmt) {
  return TEXTURE_FORMATS[String(fmt)] || `Unknown_${fmt}`;
}

/** Extract the raw pixel payload for a Texture2D object. */
function rawImageData(bundle, tex) {
  const inline = Buffer.isBuffer(tex['image data']) ? tex['image data'] : Buffer.alloc(0);
  const streamed = bundle.readStream(tex.m_StreamData, inline);
  return streamed.length ? streamed : inline;
}

function toRGBA(format, raw, width, height) {
  const n = width * height;
  const out = Buffer.alloc(n * 4);
  switch (format) {
    case 4: // RGBA32
      raw.copy(out, 0, 0, Math.min(raw.length, out.length));
      return out;
    case 14: // BGRA32
      for (let i = 0; i < n; i++) {
        out[i * 4 + 0] = raw[i * 4 + 2];
        out[i * 4 + 1] = raw[i * 4 + 1];
        out[i * 4 + 2] = raw[i * 4 + 0];
        out[i * 4 + 3] = raw[i * 4 + 3];
      }
      return out;
    case 5: // ARGB32
      for (let i = 0; i < n; i++) {
        out[i * 4 + 0] = raw[i * 4 + 1];
        out[i * 4 + 1] = raw[i * 4 + 2];
        out[i * 4 + 2] = raw[i * 4 + 3];
        out[i * 4 + 3] = raw[i * 4 + 0];
      }
      return out;
    case 3: // RGB24
      for (let i = 0; i < n; i++) {
        out[i * 4 + 0] = raw[i * 3 + 0];
        out[i * 4 + 1] = raw[i * 3 + 1];
        out[i * 4 + 2] = raw[i * 3 + 2];
        out[i * 4 + 3] = 255;
      }
      return out;
    case 1: // Alpha8
      for (let i = 0; i < n; i++) {
        out[i * 4 + 0] = 255;
        out[i * 4 + 1] = 255;
        out[i * 4 + 2] = 255;
        out[i * 4 + 3] = raw[i];
      }
      return out;
    case 63: // R8
      for (let i = 0; i < n; i++) {
        out[i * 4 + 0] = raw[i];
        out[i * 4 + 1] = raw[i];
        out[i * 4 + 2] = raw[i];
        out[i * 4 + 3] = 255;
      }
      return out;
    case 7: { // RGB565
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let i = 0; i < n; i++) {
        const v = view.getUint16(i * 2, true);
        out[i * 4 + 0] = ((v >> 11) & 0x1f) * 255 / 31 | 0;
        out[i * 4 + 1] = ((v >> 5) & 0x3f) * 255 / 63 | 0;
        out[i * 4 + 2] = (v & 0x1f) * 255 / 31 | 0;
        out[i * 4 + 3] = 255;
      }
      return out;
    }
    case 13: // RGBA4444
      for (let i = 0; i < n; i++) {
        const v = raw.readUInt16LE(i * 2);
        out[i * 4 + 0] = ((v >> 12) & 0xf) * 17;
        out[i * 4 + 1] = ((v >> 8) & 0xf) * 17;
        out[i * 4 + 2] = ((v >> 4) & 0xf) * 17;
        out[i * 4 + 3] = (v & 0xf) * 17;
      }
      return out;
    case 2: // ARGB4444
      for (let i = 0; i < n; i++) {
        const v = raw.readUInt16LE(i * 2);
        out[i * 4 + 3] = ((v >> 12) & 0xf) * 17;
        out[i * 4 + 0] = ((v >> 8) & 0xf) * 17;
        out[i * 4 + 1] = ((v >> 4) & 0xf) * 17;
        out[i * 4 + 2] = (v & 0xf) * 17;
      }
      return out;
    default:
      return null;
  }
}

/**
 * @returns {Promise<{width:number,height:number,format:number,formatName:string,rgba:Buffer,method:string}>}
 */
async function decodeTexture(bundle, tex) {
  const width = tex.m_Width;
  const height = tex.m_Height;
  const format = tex.m_TextureFormat;
  let raw = rawImageData(bundle, tex);

  if (!width || !height) throw new Error(`texture has no dimensions (${width}x${height})`);
  if (!raw.length) throw new Error('texture has no image data (neither inline nor in .resS)');

  // Crunch: unpack first, then decode as the underlying format
  if (CRUNCHED[format]) {
    const w = loader();
    const unpacked = await w.unpack_unity_crunch(raw) || await w.unpack_crunch(raw);
    if (!unpacked) throw new Error('crunch unpack failed');
    return decodeTexture(
      { readStream: () => Buffer.alloc(0) },
      { ...tex, m_TextureFormat: CRUNCHED[format], 'image data': Buffer.from(unpacked), m_StreamData: { path: '', offset: 0, size: 0 } },
    );
  }

  const direct = toRGBA(format, raw, width, height);
  if (direct) {
    return { width, height, format, formatName: formatName(format), rgba: direct, method: 'direct' };
  }

  const spec = BLOCK_FORMATS[format];
  if (spec) {
    const w = loader();
    const fn = w[spec.fn];
    if (typeof fn !== 'function') throw new Error(`decoder ${spec.fn} not exported by texture2ddecoder-wasm`);

    let need;
    if (spec.blocks) {
      need = Math.ceil(width / spec.bw) * Math.ceil(height / spec.bh) * 16;
    } else {
      // PVRTC is 2 or 4 bits per pixel, not a 16-byte block grid
      need = Math.ceil((width * height * spec.bpp) / 8);
    }
    if (raw.length < need) {
      throw new Error(`block data too small for ${formatName(format)} ${width}x${height}: ${raw.length} < ${need}`);
    }
    const payload = raw.subarray(0, need);
    const px = spec.fn === 'decode_pvrtc'
      ? await fn(payload, width, height, spec.arg)
      : spec.astc
        ? await fn(payload, width, height, spec.bw, spec.bh)
        : await fn(payload, width, height);
    if (!px) throw new Error(`${spec.fn} returned null`);
    // texture2ddecoder-wasm 输出的是 **BGRA**（库文档原文：The returned Uint8Array
    // contains BGRA pixel data），而 encodePNG 按 RGBA 写，这里必须换 R/B。
    // 不换的症状：卡面整体偏暖（蓝外套→棕、金色背景↔蓝色背景），
    // 且粉色头发会显示成淡紫 —— 用"背面/封面文字"看不出来，但对照游戏截图立刻暴露。
    const rgba = Buffer.from(px);
    for (let i = 0; i < rgba.length; i += 4) {
      const b = rgba[i];
      rgba[i] = rgba[i + 2];
      rgba[i + 2] = b;
    }
    return { width, height, format, formatName: formatName(format), rgba, method: spec.fn };
  }

  throw new Error(`unsupported texture format ${format} (${formatName(format)}), ${raw.length} bytes`);
}

module.exports = { decodeTexture, formatName, rawImageData, toRGBA, BLOCK_FORMATS };
