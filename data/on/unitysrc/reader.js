'use strict';
// Big/little-endian binary reader with the alignment helper Unity needs.

class Reader {
  constructor(buf, bigEndian = true) {
    this.buf = buf;
    this.pos = 0;
    this.be = bigEndian;
  }

  get length() {
    return this.buf.length;
  }

  get remaining() {
    return this.buf.length - this.pos;
  }

  seek(pos) {
    this.pos = pos;
  }

  skip(n) {
    this.pos += n;
  }

  align(n) {
    const rem = this.pos % n;
    if (rem !== 0) this.pos += n - rem;
  }

  require(n, what = 'data') {
    if (this.pos + n > this.buf.length) {
      throw new Error(`unexpected end of file reading ${what} at ${this.pos} (need ${n}, have ${this.remaining})`);
    }
  }

  u8() {
    this.require(1);
    return this.buf[this.pos++];
  }

  i8() {
    const v = this.u8();
    return v > 127 ? v - 256 : v;
  }

  bool() {
    return this.u8() !== 0;
  }

  u16() {
    this.require(2);
    const v = this.be ? this.buf.readUInt16BE(this.pos) : this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  i16() {
    this.require(2);
    const v = this.be ? this.buf.readInt16BE(this.pos) : this.buf.readInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  u32() {
    this.require(4);
    const v = this.be ? this.buf.readUInt32BE(this.pos) : this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  i32() {
    this.require(4);
    const v = this.be ? this.buf.readInt32BE(this.pos) : this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  i64() {
    this.require(8);
    const v = this.be ? this.buf.readBigInt64BE(this.pos) : this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v;
  }

  u64() {
    this.require(8);
    const v = this.be ? this.buf.readBigUInt64BE(this.pos) : this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v;
  }

  f32() {
    this.require(4);
    const v = this.be ? this.buf.readFloatBE(this.pos) : this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }

  f64() {
    this.require(8);
    const v = this.be ? this.buf.readDoubleBE(this.pos) : this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  bytes(n) {
    this.require(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  /** null-terminated UTF-8 string */
  cstr() {
    let end = this.pos;
    while (end < this.buf.length && this.buf[end] !== 0) end++;
    const s = this.buf.toString('utf8', this.pos, end);
    this.pos = end + 1;
    return s;
  }

  /** length-prefixed string (u32 length + bytes), Unity's "string" */
  str() {
    const len = this.u32();
    return this.bytes(len).toString('utf8');
  }

  /** Unity aligns strings to 4 bytes in serialized files */
  alignedStr() {
    const s = this.str();
    this.align(4);
    return s;
  }
}

module.exports = { Reader };
