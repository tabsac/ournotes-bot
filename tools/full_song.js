'use strict';
// Given a song's short preview bundle, find the full-length bundle in the catalog.
// cri_assets_cri_sound_<x>_<stem>_short_<hash>.bundle  ->  ..._<stem>_<hash>.bundle
// (the hash differs, so match on the stem.)
const fs = require('fs');

const INV = '/home/admin/bot/data/on/bundle_inventory.json';
let NAMES = null;

function bundleNames() {
  if (!NAMES) NAMES = JSON.parse(fs.readFileSync(INV, 'utf8')).names || [];
  return NAMES;
}

function fullBundleFor(shortName) {
  const m = /^(.*)_short_([0-9a-f]{32})\.bundle$/.exec(String(shortName || ''));
  if (!m) return null;
  const stem = m[1];
  const suffix = /^[0-9a-f]{32}\.bundle$/;
  for (const n of bundleNames()) {
    if (n.length !== stem.length + 1 + 32 + 7) continue;
    if (!n.startsWith(stem + '_')) continue;
    if (!suffix.test(n.slice(stem.length + 1))) continue;
    return n;
  }
  return null;
}

module.exports = { fullBundleFor, bundleNames };

if (require.main === module) {
  const J = JSON.parse(fs.readFileSync('/home/admin/bot/data/on/songs.json', 'utf8'));
  const ids = process.argv.slice(2).map(Number);
  const list = ids.length ? J.songs.filter((s) => ids.includes(s.id)) : J.songs;
  let hit = 0;
  const miss = [];
  for (const s of list) {
    const f = fullBundleFor(s.acbBundle);
    if (f) hit++;
    else miss.push(s.id + ' ' + s.title + ' :: ' + s.acbBundle);
    if (ids.length) console.log(String(s.id).padEnd(7), (s.title || '').padEnd(12), '->', f || '(无完整版)');
  }
  console.log('\n%d / %d 有完整版' % (hit, list.length));
  miss.slice(0, 8).forEach((m) => console.log('  MISS ' + m));
}
