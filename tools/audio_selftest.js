'use strict';
// Self-test: run every song's audio through the exact same path the bot uses
// (tools/acb.js + tools/hca_dec) and report any that fail.
//
//   node tools/audio_selftest.js            all songs
//   node tools/audio_selftest.js 100001 ..  only these ids
//
// Downloads are ~1-5 MB per song; nothing is cached.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Bundle } = require(path.join(__dirname, '..', 'data', 'on', 'unitysrc', 'bundle.js'));
const { acbFromBundle, fullBundleFor } = require('./acb.js');

const ON = '/home/admin/bot/data/on';
const SONGS = JSON.parse(fs.readFileSync(path.join(ON, 'songs.json'), 'utf8'));
const list = (() => {
  const ids = process.argv.slice(2).map(Number);
  return ids.length ? SONGS.songs.filter((s) => ids.includes(s.id)) : SONGS.songs;
})();

let ok = 0, fail = 0;
const problems = [];

for (const song of list) {
  const full = fullBundleFor(song.acbBundle);
  const want = full || song.acbBundle;
  const bundle = '/tmp/st_' + song.id + '.bundle';
  const acb = '/tmp/st_' + song.id + '.acb';
  const wav = '/tmp/st_' + song.id + '.wav';
  let line = String(song.id).padEnd(7) + (song.title || '').padEnd(14) + (full ? 'FULL ' : 'prev ');
  try {
    const dl = spawnSync('curl', ['-s', '-m', '180', '-u', SONGS.auth, '-o', bundle,
      SONGS.cdn + '/' + want], { encoding: 'utf8' });
    if (dl.status !== 0 || !fs.existsSync(bundle) || fs.statSync(bundle).size < 1024) {
      throw new Error('download failed');
    }
    const buf = acbFromBundle(Bundle.load(bundle));
    if (!buf) throw new Error('no ACB (@UTF not found)');
    fs.writeFileSync(acb, buf);
    const declared = buf.readUInt32BE(4) + 8;
    if (declared !== buf.length) throw new Error('ACB ' + buf.length + ' != declared ' + declared);
    const r = spawnSync(path.join(__dirname, 'hca_dec'), [acb, wav], { encoding: 'utf8' });
    const err = (r.stderr || '').trim().split('\n');
    const blocks = (err.find((l) => l.includes('blocks bad=')) || '').replace('hca_dec: ', '');
    if (r.status !== 0) throw new Error(blocks || ('hca_dec rc=' + r.status));
    console.log('OK   ' + line + blocks);
    ok++;
  } catch (e) {
    const msg = (e.stderr ? String(e.stderr) : e.message).trim().split('\n').slice(-1)[0].slice(0, 140);
    console.log('FAIL ' + line + msg);
    problems.push(song.id + ' ' + song.title + ' :: ' + msg);
    fail++;
  } finally {
    [bundle, acb, wav].forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } });
  }
}

console.log('\nTOTAL ' + list.length + '  ok=' + ok + '  fail=' + fail);
problems.forEach((p) => console.log('  ' + p));
process.exitCode = fail ? 1 : 0;
