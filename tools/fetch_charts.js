#!/usr/bin/env node
/**
 * 把所有歌曲 × 四个难度的谱面 JSON 抓到本地缓存（data/on/chart/<id>_<DIFF>.json）
 * 已缓存的跳过。给 build_score.py 算「效益 / 效率」用。
 *   node tools/fetch_charts.js [--diff EXPERT] [--limit N]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ON_DIR = process.env.ON_DIR || '/home/admin/bot/data/on';
const CHART_DIR = path.join(ON_DIR, 'chart');
const SONGS = JSON.parse(fs.readFileSync(path.join(ON_DIR, 'songs.json'), 'utf8'));
const withBundle = (n) => (String(n || '').endsWith('.bundle') ? String(n) : String(n || '') + '.bundle');

function extractChartJson(bundlePath) {
  const Bundle = require(path.join(ON_DIR, 'unitysrc', 'bundle.js')).Bundle;
  const zlib = require('zlib');
  const b = Bundle.load(bundlePath);
  for (const e of b.listObjects()) {
    if (e.className !== 'TextAsset') continue;
    let raw;
    try { raw = b.rawObject(e); } catch (err) { continue; }
    const nameLen = raw.readUInt32LE(0);
    let off = (4 + nameLen + 3) & ~3;
    const scriptLen = raw.readUInt32LE(off);
    if (scriptLen <= 0 || off + 4 + scriptLen > raw.length) continue;
    const script = raw.subarray(off + 4, off + 4 + scriptLen);
    let gz = -1;
    for (let i = 0; i + 1 < script.length; i++) {
      if (script[i] === 0x1f && script[i + 1] === 0x8b) { gz = i; break; }
    }
    if (gz < 0) continue;
    try { return zlib.gunzipSync(script.subarray(gz)).toString('utf8'); } catch (err) { continue; }
  }
  throw new Error('包里没有可用的谱面 JSON');
}

const args = process.argv.slice(2);
const onlyDiff = (args.includes('--diff') ? args[args.indexOf('--diff') + 1] : '').toUpperCase();
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 0;

fs.mkdirSync(CHART_DIR, { recursive: true });
let done = 0, skip = 0, fail = 0, n = 0;
for (const song of SONGS.songs) {
  for (const c of (song.charts || [])) {
    if (onlyDiff && c.name !== onlyDiff) continue;
    if (!c.bundle) continue;
    if (limit && n >= limit) break;
    n++;
    const out = path.join(CHART_DIR, `${song.id}_${c.name}.json`);
    if (fs.existsSync(out) && fs.statSync(out).size > 200) { skip++; continue; }
    const bname = withBundle(c.bundle);
    const tmp = path.join('/tmp', bname);
    try {
      execFileSync('curl', ['-s', '-m', '120', '-o', tmp, '-u', SONGS.auth, `${SONGS.cdn}/${bname}`]);
      const json = extractChartJson(tmp);
      fs.writeFileSync(out, json);
      done++;
      console.log(`✔ ${song.id}_${c.name} (${(json.length / 1024).toFixed(0)}KB)  已抓 ${done} / 跳过 ${skip} / 失败 ${fail}`);
    } catch (e) {
      fail++;
      console.log(`✘ ${song.id}_${c.name} ${String(e.message).slice(0, 80)}`);
    }
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}
console.log(`\n完成：新抓 ${done}，跳过 ${skip}，失败 ${fail}`);
