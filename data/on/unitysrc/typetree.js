'use strict';
// Unity TypeTree: parse the blob and read object data generically.
//
// This build keeps the type tree (SerializedFile._enable_type_tree == true), which
// means object layouts do NOT have to be hardcoded per class: every field can be
// located by NAME out of the tree. That is what makes a generic exporter possible.
//
// Ported from UnityPy's helpers/TypeTreeNode.py + TypeTreeHelper.py.

const COMMON_STRINGS = require('./commonstrings.json');

const K_ALIGN_BYTES = 0x4000;

/** string offsets with the high bit clear index the blob's string buffer;
 *  with the high bit set they index Unity's fixed table of common strings. */
function readBlobString(buf, value) {
  if ((value & 0x80000000) === 0) {
    let end = value;
    while (end < buf.length && buf[end] !== 0) end++;
    return buf.toString('utf8', value, end);
  }
  const off = value & 0x7fffffff;
  return COMMON_STRINGS[String(off)] ?? String(off);
}

function parseBlob(reader, version) {
  const nodeCount = reader.i32();
  const stringBufferSize = reader.i32();
  if (nodeCount < 0 || nodeCount > 1e7) throw new Error(`implausible type tree node count ${nodeCount}`);

  const nodeSize = version >= 19 ? 32 : 24;
  const raw = reader.bytes(nodeSize * nodeCount);
  const strBuf = reader.bytes(stringBufferSize);
  const be = reader.be;

  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    const o = i * nodeSize;
    nodes.push({
      version: be ? raw.readInt16BE(o) : raw.readInt16LE(o),
      level: raw[o + 2],
      typeFlags: raw[o + 3],
      typeStrOffset: be ? raw.readUInt32BE(o + 4) : raw.readUInt32LE(o + 4),
      nameStrOffset: be ? raw.readUInt32BE(o + 8) : raw.readUInt32LE(o + 8),
      byteSize: be ? raw.readInt32BE(o + 12) : raw.readInt32LE(o + 12),
      index: be ? raw.readInt32BE(o + 16) : raw.readInt32LE(o + 16),
      metaFlag: be ? raw.readInt32BE(o + 20) : raw.readInt32LE(o + 20),
      children: [],
    });
  }
  for (const n of nodes) {
    n.type = readBlobString(strBuf, n.typeStrOffset);
    n.name = readBlobString(strBuf, n.nameStrOffset);
  }

  // Rebuild the hierarchy from the flat, depth-first, level-tagged list.
  const fakeRoot = { level: -1, children: [], type: '', name: '' };
  const stack = [fakeRoot];
  let parent = fakeRoot;
  let prev = fakeRoot;
  for (const node of nodes) {
    if (node.level > prev.level) {
      stack.push(parent);
      parent = prev;
    } else if (node.level < prev.level) {
      while (node.level <= parent.level) parent = stack.pop();
    }
    parent.children.push(node);
    prev = node;
  }
  return fakeRoot.children[0];
}

function isAligned(metaFlag) {
  return ((metaFlag || 0) & K_ALIGN_BYTES) !== 0;
}

// primitive readers; `size` is the fixed width (null = variable)
const PRIMITIVES = {
  SInt8: { size: 1, read: (r) => r.i8() },
  UInt8: { size: 1, read: (r) => r.u8() },
  char: { size: 1, read: (r) => r.u8() },
  short: { size: 2, read: (r) => r.i16() },
  SInt16: { size: 2, read: (r) => r.i16() },
  'unsigned short': { size: 2, read: (r) => r.u16() },
  UInt16: { size: 2, read: (r) => r.u16() },
  int: { size: 4, read: (r) => r.i32() },
  SInt32: { size: 4, read: (r) => r.i32() },
  'unsigned int': { size: 4, read: (r) => r.u32() },
  UInt32: { size: 4, read: (r) => r.u32() },
  'Type*': { size: 4, read: (r) => r.u32() },
  'long long': { size: 8, read: (r) => r.i64() },
  SInt64: { size: 8, read: (r) => r.i64() },
  'unsigned long long': { size: 8, read: (r) => r.u64() },
  UInt64: { size: 8, read: (r) => r.u64() },
  FileSize: { size: 8, read: (r) => r.u64() },
  float: { size: 4, read: (r) => r.f32() },
  double: { size: 8, read: (r) => r.f64() },
  bool: { size: 1, read: (r) => r.bool() },
  string: { size: null, read: readAlignedString },
  TypelessData: { size: null, read: readLengthPrefixedBytes },
};

function readAlignedString(r) {
  const len = r.i32();
  if (len > 0 && len <= r.remaining) {
    const s = r.bytes(len).toString('utf8');
    r.align(4);
    return s;
  }
  return '';
}

/**
 * Same layout as readAlignedString but returns the raw bytes.
 *
 * Some assets (TextAsset especially) are declared as `string` in the type tree yet
 * hold arbitrary binary. Decoding those as UTF-8 would replace invalid sequences
 * with U+FFFD and silently corrupt the payload, so callers that need the exact
 * bytes ask for this instead.
 */
function readAlignedBytes(r) {
  const len = r.i32();
  if (len > 0 && len <= r.remaining) {
    const b = Buffer.from(r.bytes(len));
    r.align(4);
    return b;
  }
  return Buffer.alloc(0);
}

function readLengthPrefixedBytes(r) {
  const len = r.i32();
  if (len < 0 || len > r.remaining) throw new Error(`bad TypelessData length ${len}`);
  return Buffer.from(r.bytes(len));
}

/** Bulk-read `count` fixed-width primitives. Returns a Buffer for 1-byte types. */
function readPrimitiveArray(type, count, r) {
  const p = PRIMITIVES[type];
  if (!p || p.size === null) return null;
  if (p.size === 1) return Buffer.from(r.bytes(count));
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = p.read(r);
  return out;
}

function readValue(node, reader, opts = {}) {
  let align = isAligned(node.metaFlag);
  let value;

  if (node.type === 'string') {
    value = opts.rawStrings ? readAlignedBytes(reader) : readAlignedString(reader);
  } else if (PRIMITIVES[node.type]) {
    value = PRIMITIVES[node.type].read(reader);
  } else if (node.type === 'pair') {
    value = [readValue(node.children[0], reader, opts), readValue(node.children[1], reader, opts)];
  } else if (node.children.length > 0 && node.children[0].type === 'Array') {
    const arrNode = node.children[0];
    if (isAligned(arrNode.metaFlag)) align = true;
    const size = reader.i32();
    if (size < 0) throw new Error(`negative array length ${size} for ${node.name}`);
    const subtype = arrNode.children[1];
    if (!subtype) throw new Error(`array node without element type (${node.name})`);
    const bulk = subtype.children.length === 0 && subtype.type !== 'string' ? readPrimitiveArray(subtype.type, size, reader) : null;
    if (bulk) {
      value = bulk;
    } else {
      value = new Array(size);
      for (let i = 0; i < size; i++) value[i] = readValue(subtype, reader, opts);
    }
  } else {
    value = {};
    for (const child of node.children) {
      value[child.name] = readValue(child, reader, opts);
    }
  }

  if (align) reader.align(4);
  return value;
}


/** depth-first search for a descendant field by name */
function findNode(node, name) {
  if (node.name === name) return node;
  for (const c of node.children) {
    const hit = findNode(c, name);
    if (hit) return hit;
  }
  return null;
}

/** every descendant whose name matches, with its path */
function findAll(node, name, path = [], out = []) {
  const here = [...path, node.name];
  if (node.name === name) out.push({ node, path: here });
  for (const c of node.children) findAll(c, name, here, out);
  return out;
}

module.exports = { parseBlob, readValue, findNode, findAll, isAligned, readAlignedString, readAlignedBytes, PRIMITIVES };
