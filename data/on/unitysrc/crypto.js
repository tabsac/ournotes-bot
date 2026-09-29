'use strict';
// Decryption for BanG Dream! Our Notes asset bundles.
//
// Scheme recovered at runtime from the app (see decrypt/SOLUTION.md):
//   key       = 见 secrets.json 的 bundleKey
//   nonceSeed = 见 secrets.json 的 bundleSeed
//   nonce     = SHA256(nonceSeed || utf8(bundleName))[0:8]
//   counter   = nonce(8) || big-endian block counter (from 0, +1 per 16 bytes)
//   plaintext = AES-128-CTR over the FIRST min(size, 16384) bytes only

const crypto = require('crypto');

const { need } = require(require('path').join(__dirname, '..', '..', '..', 'lib', 'secrets.js'));
const KEY = Buffer.from(need('bundleKey', 'ON_BUNDLE_KEY', 'UnityFS 资源包 AES-128 密钥'), 'hex');
const NONCE_SEED = Buffer.from(need('bundleSeed', 'ON_BUNDLE_SEED', 'bundle nonce seed'), 'hex');
const ENCRYPTED_HEADER_SIZE = 0x4000; // 16384
const UNITYFS_MAGIC = Buffer.from('UnityFS\0', 'binary');

function nonceFor(bundleName) {
  return crypto
    .createHash('sha256')
    .update(Buffer.concat([NONCE_SEED, Buffer.from(bundleName, 'utf8')]))
    .digest()
    .subarray(0, 8);
}

/**
 * AES-CTR keystream: counter block = nonce || big-endian 64-bit block counter.
 * Equivalently a 128-bit big-endian counter starting at nonce||0.
 */
function keystream(nonce, nbytes) {
  const out = Buffer.alloc(nbytes);
  let written = 0;
  let ctr = 0n;
  while (written < nbytes) {
    const cb = Buffer.alloc(16);
    nonce.copy(cb, 0);
    cb.writeBigUInt64BE(ctr, 8);
    const block = crypto.createCipheriv('aes-128-ecb', KEY, null);
    block.setAutoPadding(false);
    const ks = Buffer.concat([block.update(cb), block.final()]);
    const take = Math.min(16, nbytes - written);
    ks.copy(out, written, 0, take);
    written += take;
    ctr += 1n;
  }
  return out;
}

function looksPlaintext(buf) {
  return buf.length >= 8 && buf.subarray(0, 8).equals(UNITYFS_MAGIC);
}

/**
 * @param {Buffer} data raw bundle bytes
 * @param {string} bundleName file name including ".bundle"
 * @returns {{data: Buffer, encrypted: boolean}}
 */
function decryptBundle(data, bundleName) {
  if (looksPlaintext(data)) return { data, encrypted: false };
  const boundary = Math.min(data.length, ENCRYPTED_HEADER_SIZE);
  if (boundary === 0) return { data, encrypted: false };
  const ks = keystream(nonceFor(bundleName), boundary);
  const out = Buffer.from(data); // copy; tail is kept verbatim
  for (let i = 0; i < boundary; i++) out[i] ^= ks[i];
  return { data: out, encrypted: true };
}

module.exports = {
  KEY,
  NONCE_SEED,
  ENCRYPTED_HEADER_SIZE,
  nonceFor,
  keystream,
  looksPlaintext,
  decryptBundle,
};
