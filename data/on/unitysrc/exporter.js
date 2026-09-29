'use strict';
// Turn an object inside a bundle into a file the user can actually look at.
//
// Every exporter locates its fields BY NAME through the type tree, so no class
// layout is hardcoded and a Unity upgrade that reorders fields will not silently
// corrupt output.

const path = require('path');

const { decodeTexture } = require('./decoders/texture');
const { encodePNG } = require('./decoders/png');

const TEXT_EXT = [
  ['.json', /^\s*[[{]/],
  ['.xml', /^\s*</],
  ['.csv', /^[^\n]*,[^\n]*\n/],
];

function safeName(s, fallback = 'unnamed') {
  const cleaned = String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, 120);
}

function isMostlyText(buf) {
  if (!buf.length) return false;
  const n = Math.min(buf.length, 4096);
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0x80) printable++;
  }
  return printable / n > 0.95;
}

function guessTextExtension(buf, name) {
  for (const [ext, re] of TEXT_EXT) {
    if (re.test(buf.subarray(0, 200).toString('utf8'))) return ext;
  }
  return '.txt';
}

// ---------------------------------------------------------------- TextAsset
// Read with rawStrings so a binary TextAsset survives byte for byte; the type
// tree declares m_Script as `string`, but the payload is not necessarily UTF-8.
function exportTextAsset(bundle, entry, value) {
  const data = Buffer.isBuffer(value.m_Script)
    ? value.m_Script
    : typeof value.m_Script === 'string'
      ? Buffer.from(value.m_Script, 'utf8')
      : Buffer.alloc(0);
  const name = Buffer.isBuffer(value.m_Name) ? value.m_Name.toString('utf8') : String(value.m_Name || '');
  const text = isMostlyText(data);
  const ext = text ? guessTextExtension(data, name) : '.bytes';
  return { ext, data, kind: text ? 'text' : 'binary', name: safeName(name) };
}

// ---------------------------------------------------------------- Texture2D
async function exportTexture(bundle, entry, value) {
  const res = await decodeTexture(bundle, value);
  return {
    ext: '.png',
    data: encodePNG(res.width, res.height, res.rgba),
    kind: 'image',
    name: safeName(value.m_Name),
    meta: {
      width: res.width,
      height: res.height,
      format: res.format,
      formatName: res.formatName,
      decoder: res.method,
    },
  };
}

// ---------------------------------------------------------------- Sprite
function spriteSettings(settingsRaw) {
  return {
    packed: (settingsRaw & 1) !== 0,
    packingMode: (settingsRaw >> 1) & 0xf,
    packingRotation: (settingsRaw >> 5) & 0xf,
    meshType: (settingsRaw >> 9) & 0xf,
  };
}

/**
 * Crop a rectangle out of an atlas texture into a standalone RGBA image.
 *
 * Unity stores the rect with a BOTTOM-UP Y axis, so the top of the sprite in the
 * atlas is at (texH - rect.y - rect.height). Rotations follow Unity's
 * SpritePackingRotation: 0/4 = none, 1 = flip H, 2 = flip V, 3 = rotate 180.
 */
function cropSprite(rgba, texW, texH, rect, rotation) {
  const rw = Math.round(rect.width);
  const rh = Math.round(rect.height);
  const rx = Math.round(rect.x);
  const ry = Math.round(rect.y);
  const out = Buffer.alloc(rw * rh * 4);
  const top = texH - ry - rh;

  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      let sx = x;
      let sy = y;
      if (rotation === 1) sx = rw - 1 - x;
      else if (rotation === 2) sy = rh - 1 - y;
      else if (rotation === 3) {
        sx = rw - 1 - x;
        sy = rh - 1 - y;
      }
      const gx = rx + sx;
      const gy = top + sy;
      if (gx < 0 || gy < 0 || gx >= texW || gy >= texH) continue;
      const s = (gy * texW + gx) * 4;
      const d = (y * rw + x) * 4;
      out[d] = rgba[s];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2];
      out[d + 3] = rgba[s + 3];
    }
  }
  return { rgba: out, width: rw, height: rh };
}


async function exportSprite(bundle, entry, value) {
  const rd = value.m_RD || {};
  const pptr = rd.texture || rd.alphaTexture;
  if (!pptr) throw new Error('sprite has no texture reference');

  // resolve the PPtr inside this bundle
  const target = bundle.listObjects().find((o) => o.obj.pathId === BigInt(pptr.m_PathID));
  if (!target) throw new Error(`sprite texture pathID ${pptr.m_PathID} not found in bundle`);
  const texValue = bundle.readObject(target);
  const res = await decodeTexture(bundle, texValue);

  const rect = rd.textureRect || value.m_Rect;
  const { packed, packingRotation } = spriteSettings(rd.settingsRaw || 0);
  // Unity 6000 的 settingsRaw 位布局与旧版不同：本游戏卡面包 packed=false 但
  // packingRotation=2（实际确实被旋转了），故改为「只要 rotation 非 0/4 就应用」
  const rotation = (packingRotation === 0 || packingRotation === 4) ? 4 : packingRotation;

  let rgba = res.rgba;
  let width = res.width;
  let height = res.height;

  const isFullTexture =
    Math.round(rect.x) === 0 && Math.round(rect.y) === 0 &&
    Math.round(rect.width) === res.width && Math.round(rect.height) === res.height && rotation === 4;

  if (!isFullTexture) {
    const cropped = cropSprite(res.rgba, res.width, res.height, rect, rotation);
    rgba = cropped.rgba;
    width = cropped.width;
    height = cropped.height;
  }

  return {
    ext: '.png',
    data: encodePNG(width, height, rgba),
    kind: 'image',
    name: safeName(value.m_Name),
    meta: {
      width,
      height,
      sourceTexture: texValue.m_Name,
      sourceSize: `${res.width}x${res.height}`,
      textureRect: `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
      packed,
      packingRotation,
      formatName: res.formatName,
    },
  };
}

// ---------------------------------------------------------------- Mesh -> OBJ
const VERTEX_FORMAT = { 0: 'f32', 1: 'f16', 2: 'unorm8', 3: 'snorm8', 4: 'unorm16', 5: 'snorm16', 10: 'u32', 11: 's32' };
const CHANNEL = { 0: 'position', 1: 'normal', 2: 'tangent', 3: 'color', 4: 'uv0', 5: 'uv1', 6: 'uv2', 7: 'uv3' };
const COMPONENTS = { 1: 1, 2: 2, 3: 3, 4: 4 };
const FORMAT_SIZE = { f32: 4, f16: 2, unorm8: 1, snorm8: 1, unorm16: 2, snorm16: 2, u32: 4, s32: 4 };

function readHalf(buf, off) {
  const h = buf.readUInt16LE(off);
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

function readComponent(buf, off, format) {
  switch (format) {
    case 'f32': return buf.readFloatLE(off);
    case 'f16': return readHalf(buf, off);
    case 'unorm8': return buf[off] / 255;
    case 'snorm8': return Math.max(buf.readInt8(off) / 127, -1);
    case 'unorm16': return buf.readUInt16LE(off) / 65535;
    case 'snorm16': return Math.max(buf.readInt16LE(off) / 32767, -1);
    case 'u32': return buf.readUInt32LE(off);
    case 's32': return buf.readInt32LE(off);
    default: return 0;
  }
}

function readVec(buf, base, ch) {
  const step = FORMAT_SIZE[ch.fmt];
  const out = new Array(ch.dim);
  for (let k = 0; k < ch.dim; k++) out[k] = readComponent(buf, base + k * step, ch.fmt);
  return out;
}

function exportMesh(bundle, entry, value) {
  const vd = value.m_VertexData;
  if (!vd) throw new Error('mesh has no m_VertexData');
  const vertexCount = vd.m_VertexCount;
  const channels = vd.m_Channels || [];
  const data = Buffer.isBuffer(vd.m_DataSize) ? vd.m_DataSize : Buffer.from(vd.m_DataSize || []);

  // ChannelInfo has only {stream, offset, format, dimension} — the CHANNEL INDEX
  // IS THE ARRAY POSITION (0 = vertex, 1 = normal, 2 = tangent, 3 = color,
  // 4 = uv0, ...). There is no explicit `channel` field to read.
  //
  // The per-vertex stride is the SUM of every channel's size (i.e. the highest
  // offset+size), NOT the size of one channel: each channel carries its own
  // offset into the vertex. Using the position channel's own size as the stride
  // silently reads misaligned garbage.
  const DEFAULT_DIM = { 0: 3, 1: 3, 2: 4, 3: 4, 4: 2, 5: 2 };
  const chan = channels.map((ch, idx) => {
    const fmt = VERTEX_FORMAT[ch.format];
    const dim = ch.dimension || DEFAULT_DIM[idx] || 1;
    const size = fmt ? FORMAT_SIZE[fmt] * dim : 0;
    return { idx, fmt, dim, offset: ch.offset, size, name: CHANNEL[idx] };
  });
  const vertexStride = chan.reduce((m, c) => Math.max(m, c.offset + c.size), 0);
  const pos = chan.find((c) => c.idx === 0 && c.fmt);
  const uv = chan.find((c) => c.idx === 4 && c.fmt);
  if (!pos) throw new Error(`mesh has no position channel (channels=${channels.length})`);
  if (!vertexStride) throw new Error('mesh vertex stride resolved to 0');

  const positions = [];
  const uvs = [];
  for (let i = 0; i < vertexCount; i++) {
    const base = i * vertexStride + pos.offset;
    positions.push(readVec(data, base, pos));
    if (uv && uv.offset + uv.size <= vertexStride) uvs.push(readVec(data, i * vertexStride + uv.offset, uv));
  }

  // index buffer: might be bytes + m_IndexFormat, or an array of shorts
  let indices = [];
  const ib = value.m_IndexBuffer;
  const indexFormat = value.m_IndexFormat !== undefined ? value.m_IndexFormat : 0;
  if (Buffer.isBuffer(ib) && ib.length) {
    const wide = indexFormat === 1;
    const count = Math.floor(ib.length / (wide ? 4 : 2));
    for (let i = 0; i < count; i++) indices.push(wide ? ib.readUInt32LE(i * 4) : ib.readUInt16LE(i * 2));
  } else if (Array.isArray(ib) && ib.length) {
    indices = ib.map((v) => Number(v));
  }

  const lines = [`# ${value.m_Name}`, `# vertices=${vertexCount} indices=${indices.length}`];
  for (const p of positions) lines.push(`v ${p[0]} ${p[1]} ${p[2]}`);
  const hasUv = uvs.length === positions.length;
  if (hasUv) for (const t of uvs) lines.push(`vt ${t[0]} ${t[1]}`);
  const subMeshes = value.m_SubMeshes || [];
  if (indices.length) {
    for (const sm of subMeshes) {
      const first = sm.firstByte / 2;
      const count = sm.indexCount;
      for (let i = 0; i < count; i += 3) {
        const a = indices[first + i] + 1;
        const b = indices[first + i + 1] + 1;
        const c = indices[first + i + 2] + 1;
        lines.push(hasUv ? `f ${a}/${a} ${b}/${b} ${c}/${c}` : `f ${a} ${b} ${c}`);
      }
    }
  }

  return {
    ext: '.obj',
    data: Buffer.from(lines.join('\n') + '\n', 'utf8'),
    kind: 'model',
    name: safeName(value.m_Name),
    meta: { vertices: vertexCount, indices: indices.length, subMeshes: subMeshes.length, hasUv },
  };
}

// ---------------------------------------------------------------- AudioClip
function wavHeader(dataLength, channels, sampleRate, bitsPerSample) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataLength, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
  h.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataLength, 40);
  return h;
}

function exportAudioClip(bundle, entry, value) {
  const res = value.m_Resource || {};
  const sampleData = bundle.readStream(res, Buffer.alloc(0));
  const name = safeName(value.m_Name);

  // m_CompressionFormat: 0 = PCM, 1 = Vorbis, 2 = FMOD, 3 = ADPCM
  const format = value.m_CompressionFormat;
  if (format === 0 && sampleData.length) {
    const channels = value.m_Channels || 1;
    const bits = value.m_BitsPerSample || 16;
    return {
      ext: '.wav',
      data: Buffer.concat([wavHeader(sampleData.length, channels, value.m_Frequency || 44100, bits), sampleData]),
      kind: 'audio',
      name,
      meta: { channels, sampleRate: value.m_Frequency, bitsPerSample: bits, compression: 'PCM' },
    };
  }
  if (!sampleData.length) throw new Error(`audio has no sample data (compression format ${format})`);
  return {
    ext: '.audio.raw',
    data: sampleData,
    kind: 'audio',
    name,
    meta: {
      compression: format,
      note: 'compressed (Vorbis/FMOD/ADPCM) — raw payload only; needs vgmstream/UnityPy to decode',
      channels: value.m_Channels,
      sampleRate: value.m_Frequency,
    },
  };
}

// ---------------------------------------------------------------- Font
function exportFont(bundle, entry, value) {
  const data = Buffer.isBuffer(value.m_FontData) ? value.m_FontData : Buffer.alloc(0);
  if (!data.length) throw new Error('font has no m_FontData');
  const isOtf = data.subarray(0, 4).toString('ascii') === 'OTTO';
  return { ext: isOtf ? '.otf' : '.ttf', data, kind: 'font', name: safeName(value.m_Name) };
}

// ---------------------------------------------------------------- Shader / MonoBehaviour / misc
function exportText(bundle, entry, value) {
  const text = value.m_Script;
  const data = typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.isBuffer(text) ? text : Buffer.from(JSON.stringify(value, jsonReplacer, 1));
  return { ext: '.shader.txt', data, kind: 'text', name: safeName(value.m_Name) };
}

function jsonReplacer(key, v) {
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) return { __bytes: v.length, hex: v.subarray(0, 64).toString('hex') + (v.length > 64 ? '…' : '') };
  return v;
}

function exportJson(bundle, entry, value) {
  return {
    ext: '.json',
    data: Buffer.from(JSON.stringify(value, jsonReplacer, 1), 'utf8'),
    kind: 'data',
    name: safeName(value.m_Name || `${entry.className}_${entry.obj.pathId}`),
  };
}

// ---------------------------------------------------------------- dispatch
const EXPORTERS = {
  TextAsset: exportTextAsset,
  Texture2D: exportTexture,
  Sprite: exportSprite,
  Mesh: exportMesh,
  AudioClip: exportAudioClip,
  Font: exportFont,
  Shader: exportText,
};

/**
 * @returns {Promise<{ext,data,kind,name,meta?,skipped?:string}>}
 */
async function exportObject(bundle, entry) {
  // TextAsset needs the payload as raw bytes, not UTF-8-decoded text.
  const opts = entry.className === 'TextAsset' ? { rawStrings: true } : {};
  const value = bundle.readObject(entry, opts);
  const fn = EXPORTERS[entry.className];
  if (fn) return fn(bundle, entry, value);
  return exportJson(bundle, entry, value);
}

module.exports = {
  exportObject,
  exportTextAsset,
  exportTexture,
  exportSprite,
  exportMesh,
  exportAudioClip,
  exportFont,
  exportJson,
  safeName,
  jsonReplacer,
  EXPORTERS,
};
