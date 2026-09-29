'use strict';
// UnityFS bundle -> ACB, for both bundle layouts the game uses.
//
//   · 试听包（*_short*）：ACB 是明文，藏在 MonoBehaviour 里，@UTF 直接可见。
//   · 完整版包：ACB 被切成 N 个 TextAsset（M_<曲名>-001..NNN），每片整体与单字节异或。
//
// 分片结构（逐个 TextAsset 的 rawObject）：
//   [u32 名字长度][名字][补齐到 4][u32 数据长度][数据][可能的尾部填充]
//   ↑ off 处那个 u32 **必须**用来截断数据：不同曲子的尾部填充长度不一样
//     （mayoiuta 恰好为 0，所以早期只按长度拼接"能跑"，别的曲子就会多出十几字节、
//      拼出来的 ACB 比 @UTF 自称的长度长，解码大面积失败）。
//   异或密钥取 blob[0] ^ 0x40（明文以 '@' 开头；明文里大量 0x00 填充，
//   所以密文被密钥字节主导，也可以先用众数猜）。
const fs = require('fs');
const path = require('path');

const ON_DIR = process.env.ON_DIR || '/home/admin/bot/data/on';
let INV_NAMES = null;

/** 从 UnityFS bundle 里取出 ACB（两种布局都吃）。取不到返回 null。 */
function acbFromBundle(b) {
  // 1) 明文 ACB（试听包）
  for (const e of b.listObjects()) {
    let raw;
    try { raw = b.rawObject(e); } catch (err) { continue; }
    const at = raw.indexOf('@UTF');
    if (at >= 0) return raw.subarray(at);
  }

  // 2) 分片 + 单字节异或（完整版包）
  const chunks = [];
  for (const e of b.listObjects()) {
    if (e.className !== 'TextAsset') continue;
    let raw;
    try { raw = b.rawObject(e); } catch (err) { continue; }
    if (raw.length < 24) continue;
    const nl = raw.readUInt32LE(0);
    if (nl <= 0 || 4 + nl > raw.length) continue;
    const name = raw.subarray(4, 4 + nl).toString('utf8');
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(name)) continue;   // M_Tanebi-001 / A_Fatal-001
    const off = (4 + nl + 3) & ~3;
    if (off + 8 > raw.length) continue;
    const decl = raw.readUInt32LE(off);
    if (decl <= 0 || off + 4 + decl > raw.length) continue;
    chunks.push({ name, data: raw.subarray(off + 4, off + 4 + decl) });
  }
  if (!chunks.length) return null;
  chunks.sort((a, c) => a.name.localeCompare(c.name));

  const blob = Buffer.concat(chunks.map((c) => c.data));
  const key = blob[0] ^ 0x40;
  const plain = Buffer.allocUnsafe(blob.length);
  for (let i = 0; i < blob.length; i++) plain[i] = blob[i] ^ key;
  const at = plain.indexOf('@UTF');
  if (at < 0) return null;
  plain.meta = { chunks: chunks.length, key, first: chunks[0].name };
  return plain.subarray(at);
}

/** 试听包名 → 完整版包名。`..._<stem>_short_<hash>.bundle` → `..._<stem>_<hash>.bundle`
 *  （hash 是内容哈希，两边不同，只能按 stem 匹配）。84/85 首有完整版。 */
function fullBundleFor(name) {
  const m = /^(.*)_short_([0-9a-f]{32})\.bundle$/.exec(String(name || ''));
  if (!m) return null;
  const stem = m[1];
  if (!INV_NAMES) {
    try {
      INV_NAMES = JSON.parse(fs.readFileSync(path.join(ON_DIR, 'bundle_inventory.json'), 'utf8')).names || [];
    } catch (e) { INV_NAMES = []; }
  }
  for (const n of INV_NAMES) {
    if (n.length === stem.length + 1 + 32 + 7 && n.startsWith(stem + '_') &&
        /^[0-9a-f]{32}\.bundle$/.test(n.slice(stem.length + 1))) return n;
  }
  return null;
}

module.exports = { acbFromBundle, fullBundleFor };
