// 调试：解密 CDN 包 → 校验 UnityFS → 找真正的 gzip 段
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const KEY = Buffer.from(require('../lib/secrets.js').need('bundleKey', 'ON_BUNDLE_KEY'), 'hex');
const SEED = Buffer.from(require('../lib/secrets.js').need('bundleSeed', 'ON_BUNDLE_SEED'), 'hex');

function decrypt(buf, name) {
  if (buf.length >= 8 && buf.subarray(0, 8).toString('binary') === 'UnityFS\0') {
    console.log('  (明文包，无需解密)');
    return buf;
  }
  const nonce = crypto.createHash('sha256')
    .update(Buffer.concat([SEED, Buffer.from(name, 'utf8')])).digest().subarray(0, 8);
  const boundary = Math.min(buf.length, 16384);
  const out = Buffer.from(buf);
  let ctr = 0n;
  for (let off = 0; off < boundary; off += 16) {
    const cb = Buffer.alloc(16);
    nonce.copy(cb, 0);
    cb.writeBigUInt64BE(ctr, 8);
    const c = crypto.createCipheriv('aes-128-ecb', KEY, null);
    c.setAutoPadding(false);
    const ks = Buffer.concat([c.update(cb), c.final()]);
    const n = Math.min(16, boundary - off);
    for (let i = 0; i < n; i++) out[off + i] ^= ks[i];
    ctr += 1n;
  }
  return out;
}

const file = process.argv[2];
const name = process.argv[3];
const raw = fs.readFileSync(file);
console.log(`原始 ${raw.length}B head=${raw.subarray(0, 12).toString('hex')}`);
const dec = decrypt(raw, name);
console.log(`解密后 head=${dec.subarray(0, 32).toString('hex')}`);
console.log(`解密后前 16 字节文本: ${JSON.stringify(dec.subarray(0, 16).toString('latin1'))}`);

const offsets = [];
let i = dec.indexOf(Buffer.from([0x1f, 0x8b, 0x08]));
while (i >= 0 && offsets.length < 12) {
  offsets.push(i);
  i = dec.indexOf(Buffer.from([0x1f, 0x8b, 0x08]), i + 1);
}
console.log(`找到 ${offsets.length} 个 1f8b08 候选: ${offsets.join(', ')}`);
for (const off of offsets) {
  try {
    const out = zlib.gunzipSync(dec.subarray(off));
    const txt = out.toString('utf8');
    console.log(`  ★ 偏移 ${off} gunzip 成功 -> ${out.length}B: ${txt.slice(0, 80)}`);
  } catch (e) {
    console.log(`  偏移 ${off} 失败: ${e.message.slice(0, 60)}  FLG=0x${dec[off + 3].toString(16)}`);
  }
}
