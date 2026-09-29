'use strict';
// One AssetBundle, end to end: encrypted file -> UnityFS -> CAB -> objects.
//
// Nothing here is hardcoded per asset class: the type tree is present in these
// bundles, so every field is located by name.

const fs = require('fs');
const path = require('path');

const { parseUnityFS } = require('./unityfs');
const { SerializedFile } = require('./serialized');
const { readValue, findNode } = require('./typetree');
const { decryptBundle, looksPlaintext } = require('./crypto');

class Bundle {
  constructor(filePath, rawBuffer) {
    this.path = filePath;
    this.name = path.basename(filePath);

    const { data, encrypted } = looksPlaintext(rawBuffer)
      ? { data: rawBuffer, encrypted: false }
      : decryptBundle(rawBuffer, this.name);
    this.wasEncrypted = encrypted;
    this.container = parseUnityFS(data);

    /** @type {{name: string, sf: SerializedFile, buffer: Buffer}[]} */
    this.serializedFiles = [];
    for (const [nodeName, buf] of this.container.files) {
      if (nodeName.endsWith('.resS') || nodeName.endsWith('.resource')) continue;
      try {
        this.serializedFiles.push({ name: nodeName, sf: new SerializedFile(buf, nodeName), buffer: buf });
      } catch (err) {
        this.serializedFiles.push({ name: nodeName, error: err, buffer: buf });
      }
    }
    this._objectIndex = null;
  }

  static load(filePath) {
    return new Bundle(filePath, fs.readFileSync(filePath));
  }

  static fromBuffer(buf, name) {
    return new Bundle(name, buf);
  }

  get cab() {
    return this.serializedFiles.find((f) => !f.error) || null;
  }

  /** flat list of every object in every serialized file */
  listObjects() {
    if (this._objectIndex) return this._objectIndex;
    const out = [];
    for (const file of this.serializedFiles) {
      if (file.error) continue;
      for (const obj of file.sf.objects) {
        out.push({ file: file.name, sf: file.sf, obj, className: obj.className, classId: obj.classId });
      }
    }
    this._objectIndex = out;
    return out;
  }

  /** raw bytes of an object, straight out of the CAB */
  rawObject(entry) {
    return entry.sf.objectData(entry.obj);
  }

  /**
   * Parse an object's fields through its type tree.
   * @param {{sf: SerializedFile, obj: object}} entry
   */
  readObject(entry, opts) {
    const { sf, obj } = entry;
    const type = obj.serializedType;
    if (!type || !type.typeTree) {
      throw new Error(`no type tree for ${obj.className} (classID ${obj.classId})`);
    }
    const reader = sf.readerFor(obj);
    const value = readValue(type.typeTree, reader, opts || {});
    value.__bytesRead = reader.pos - obj.byteStart;
    value.__byteSize = obj.byteSize;
    return value;
  }

  /**
   * Streaming data for Texture2D/AudioClip: read `size` bytes at `offset` from the
   * .resS node named in m_StreamData.path.
   */
  readStream(streamData, inlineFallback) {
    if (!streamData || !streamData.path || !streamData.size) {
      return Buffer.isBuffer(inlineFallback) ? inlineFallback : Buffer.alloc(0);
    }
    const wanted = streamData.path;
    // paths look like "archive:/CAB-xxxx/CAB-xxxx.resS"; match on basename
    const base = wanted.split('/').pop();
    for (const [nodeName, buf] of this.container.files) {
      if (nodeName === base || nodeName.endsWith(base)) {
        const off = Number(streamData.offset);
        const size = Number(streamData.size);
        return buf.subarray(off, off + size);
      }
    }
    return Buffer.alloc(0);
  }

  /** container paths from the AssetBundle object, when present */
  get containerPaths() {
    const ab = this.listObjects().find((e) => e.className === 'AssetBundle');
    if (!ab) return [];
    try {
      const v = this.readObject(ab);
      return (v.m_Container || []).map((p) => p.first || p.second);
    } catch (err) {
      return [];
    }
  }
}

module.exports = { Bundle };
