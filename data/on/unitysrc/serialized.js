'use strict';
// SerializedFile (CAB-*) parsing: header, type table, object table, externals.
//
// Ported from the algorithm used by UnityPy (files/SerializedFile.py) so the
// versions coincide, including the quirk that version >= 22 re-reads
// metadata_size/file_size/data_offset with wider types.
//
// The object table is what makes everything else possible: it maps pathID ->
// (byteStart, byteSize, classID) with no need for a type tree.

const { Reader } = require('./reader');
const { parseBlob } = require('./typetree');

const CLASS_IDS = require('./classids');

class SerializedFile {
  constructor(buf, name = 'CAB') {
    this.name = name;
    this.buf = buf;
    const r = new Reader(buf, true);

    this.header = {};
    const h = this.header;
    h.metadataSize = r.u32();
    h.fileSize = r.u32();
    h.version = r.u32();
    h.dataOffset = r.u32();

    h.endian = '>';
    if (h.version >= 9) {
      h.endian = r.u8() ? '>' : '<';
      r.skip(3);
      if (h.version >= 22) {
        h.metadataSize = r.u32();
        h.fileSize = Number(r.i64());
        h.dataOffset = Number(r.i64());
        this.unknown = Number(r.i64());
      }
    } else {
      r.seek(h.fileSize - h.metadataSize);
      h.endian = r.u8() ? '>' : '<';
    }
    r.be = h.endian === '>';

    if (h.version >= 7) this.unityVersion = r.cstr();
    if (h.version >= 8) this.targetPlatform = r.i32();
    if (h.version >= 13) this.enableTypeTree = r.bool();

    const typeCount = r.i32();
    this.types = [];
    for (let i = 0; i < typeCount; i++) this.types.push(this.readType(r, h.version, false));

    this.bigIdEnabled = 0;
    if (h.version >= 7 && h.version < 14) this.bigIdEnabled = r.i32();

    const objectCount = r.i32();
    this.objects = [];
    for (let i = 0; i < objectCount; i++) this.objects.push(this.readObject(r, h.version));

    if (h.version >= 11) {
      const scriptCount = r.i32();
      this.scriptTypes = [];
      for (let i = 0; i < scriptCount; i++) {
        const localIndex = r.i32();
        let identifier;
        if (h.version < 14) identifier = r.i32();
        else {
          r.align(4);
          identifier = Number(r.i64());
        }
        this.scriptTypes.push({ localIndex, identifier });
      }
    }

    const extCount = r.i32();
    this.externals = [];
    for (let i = 0; i < extCount; i++) {
      const ext = {};
      if (h.version >= 6) ext.tempEmpty = r.cstr();
      if (h.version >= 5) {
        ext.guid = Buffer.from(r.bytes(16));
        ext.type = r.i32();
      }
      ext.path = r.cstr();
      this.externals.push(ext);
    }

    if (h.version >= 20) {
      const refTypeCount = r.i32();
      this.refTypes = [];
      for (let i = 0; i < refTypeCount; i++) this.refTypes.push(this.readType(r, h.version, true));
    }

    if (h.version >= 5) this.userInformation = r.cstr();
  }

  readType(r, version, isRefType) {
    const t = { classId: r.i32(), scriptTypeIndex: -1 };
    if (version >= 16) t.isStrippedType = r.bool();
    if (version >= 17) t.scriptTypeIndex = r.i16();

    if (version >= 13) {
      if (
        (isRefType && t.scriptTypeIndex >= 0) ||
        (version < 16 && t.classId < 0) ||
        (version >= 16 && t.classId === 114)
      ) {
        t.scriptId = Buffer.from(r.bytes(16));
      }
      t.oldTypeHash = Buffer.from(r.bytes(16));
    }

    if (this.enableTypeTree) {
      t.typeTree = parseBlob(r, version);
      if (version >= 21) {
        if (isRefType) {
          t.className = r.cstr();
          t.namespace = r.cstr();
          t.assemblyName = r.cstr();
        } else {
          const n = r.i32();
          t.typeDependencies = [];
          for (let i = 0; i < n; i++) t.typeDependencies.push(r.i32());
        }
      }
    }
    if (!t.className) t.className = CLASS_IDS[t.classId] || `ClassID_${t.classId}`;
    return t;
  }

  readObject(r, version) {
    let pathId;
    if (this.bigIdEnabled) pathId = r.i64();
    else if (version < 14) pathId = BigInt(r.i32());
    else {
      r.align(4);
      pathId = r.i64();
    }

    let byteStart = version >= 22 ? Number(r.i64()) : r.u32();
    byteStart += this.header.dataOffset;
    const byteSize = r.u32();
    const typeId = r.i32();

    let serializedType;
    let classId;
    if (version < 16) {
      classId = r.u16();
      serializedType = this.types.find((t) => t.classId === typeId);
    } else {
      serializedType = this.types[typeId];
      classId = serializedType ? serializedType.classId : -1;
    }

    if (version < 11) r.u16();
    if (version >= 11 && version < 17) r.i16();

    return {
      pathId,
      byteStart,
      byteSize,
      typeId,
      classId,
      className: CLASS_IDS[classId] || `ClassID_${classId}`,
      serializedType,
    };
  }

  /** raw bytes of one object's serialized data */
  objectData(obj) {
    return this.buf.subarray(obj.byteStart, obj.byteStart + obj.byteSize);
  }

  readerFor(obj) {
    const r = new Reader(this.buf, this.header.endian === '>');
    r.seek(obj.byteStart);
    r.limit = obj.byteStart + obj.byteSize;
    return r;
  }
}

// TypeTreeNode blob (version >= 12). Parsed rather than merely skipped so a
// bundle that DOES carry a type tree still loads.
function readTypeTreeBlob(r, version) {
  const numNodes = r.u32();
  const stringBufferSize = r.u32();
  const nodes = [];
  for (let i = 0; i < numNodes; i++) {
    nodes.push({
      version: r.u16(),
      level: r.u8(),
      typeFlags: r.u8(),
      typeStrOffset: r.u32(),
      nameStrOffset: r.u32(),
      byteSize: r.i32(),
      index: r.i32(),
      metaFlag: r.i32(),
    });
  }
  const rawStrings = r.bytes(stringBufferSize);
  const strings = [];
  let start = 0;
  for (let i = 0; i < rawStrings.length; i++) {
    if (rawStrings[i] === 0) {
      strings.push(rawStrings.toString('utf8', start, i));
      start = i + 1;
    }
  }
  for (const n of nodes) {
    n.type = strings[n.typeStrOffset] ?? '';
    n.name = strings[n.nameStrOffset] ?? '';
  }
  return nodes;
}

module.exports = { SerializedFile, readTypeTreeBlob };
