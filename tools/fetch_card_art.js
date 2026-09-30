#!/usr/bin/env node
'use strict';
/**
 * 补齐卡面美术：把 master 里的卡（index.json）对应的卡面解出来，落到
 *   data/on/art/thumb/<id>.jpg   （384x512，列表/网格用）
 *   data/on/art/full/<id>.jpg    （1440x1920 → 缩到 900x1200，详情图用）
 *
 *   node tools/fetch_card_art.js                 # 补齐所有缺图的卡
 *   node tools/fetch_card_art.js --ids 61,62,63  # 只补这几张
 *   node tools/fetch_card_art.js --force         # 已存在的也重做
 *   node tools/fetch_card_art.js --dry           # 只报告缺哪几张
 *
 * 资源包名规律：membercard_assets_membercard_<卡id>_member_<thumbnail|full>_<hash>.bundle
 * 优先用本地 data/on/dl/ 里已下好的包，没有再走 CDN（带 Basic 凭据）。
 * 一个包里会有好几个 Sprite（face_center / detail_pivot / member_full / formation…），
 * 全图那张的名字正好是 member_full / member_thumbnail，所以按名字挑，不能瞎取第一个。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ON = process.env.ON_DIR || '/home/admin/bot/data/on';
const ROOT = path.resolve(__dirname, '..');
const DL = path.join(ON, 'dl');
const ART = path.join(ON, 'art');
const TMP = path.join('/tmp', 'on_cardart');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const exists = (p) => { try { return fs.existsSync(p) && fs.statSync(p).size > 1024; } catch (e) { return false; } };

function findArt(kind, id) {
  for (const ext of ['.jpg', '.png', '.jpeg']) {
    const p = path.join(ART, kind, id + ext);
    if (exists(p)) return p;
  }
  return null;
}

/** 卡面资源包名（本地 dl/ 优先，否则从 CDN 下） */
function bundleFor(id, kind) {
  const names = readJson(path.join(ON, 'bundle_inventory.json'), {}).names || [];
  const word = (kind === 'thumb') ? 'thumbnail' : kind;   // 包名里是 member_thumbnail，不是 member_thumb
  const pre = `membercard_assets_membercard_${id}_member_${word}_`;
  const name = names.find((n) => n.startsWith(pre) && /^[0-9a-f]{32}\.bundle$/.test(n.slice(pre.length)));
  if (!name) return null;
  const local = path.join(DL, name);
  if (exists(local)) return local;
  const songs = readJson(path.join(ON, 'songs.json'), {});
  const tmp = path.join(TMP, name);
  fs.mkdirSync(TMP, { recursive: true });
  if (!exists(tmp)) {
    const out = execFileSync('curl', ['-s', '-m', '300', '-o', tmp, '-w', '%{http_code}',
      '-u', songs.auth, songs.cdn + '/' + name], { encoding: 'utf8' }).trim();
    if (out !== '200') throw new Error('下载失败 HTTP ' + out);
  }
  return tmp;
}

async function exportNamed(bundlePath, wantName, outPng) {
  const { Bundle } = require(path.join(ON, 'unitysrc', 'bundle.js'));
  const { exportObject } = require(path.join(ON, 'unitysrc', 'exporter.js'));
  const b = Bundle.load(bundlePath);
  // ⚠️ listObjects() 里的 e.name 是空的（名字在导出结果里），所以要逐个导出再看名字。
  // 一个 member_full 包里有 face_center / detail_pivot / member_full / formation 好几张，
  // 按名字（或 3:4 比例）挑，别瞎取第一个 —— 编队图 formation 是 1052x1900，方图 square 是 384x384。
  const got = [];
  for (const e of b.listObjects()) {
    if (e.className !== 'Sprite' && e.className !== 'Texture2D') continue;
    let r = null;
    try { r = await exportObject(b, e); } catch (err) { continue; }
    if (r && r.ext === '.png' && r.data) got.push({ cls: e.className, name: String(r.name || ''), meta: r.meta || {}, data: r.data });
  }
  if (!got.length) throw new Error('包里没有可导出的图片对象');
  const exact = got.find((g) => g.name === wantName);
  const partial = got.find((g) => g.name.indexOf(wantName) >= 0);
  const ratio34 = got.find((g) => g.meta.width && Math.abs(g.meta.width / g.meta.height - 0.75) < 0.02);
  const best = exact || partial || ratio34 || got.sort((a, c) => (c.meta.width || 0) * (c.meta.height || 0) - (a.meta.width || 0) * (a.meta.height || 0))[0];
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  fs.writeFileSync(outPng, best.data);
  return { name: best.name, meta: best.meta, alternatives: got.map((g) => `${g.name}:${g.meta.width}x${g.meta.height}`) };
}

function toJpg(png, jpg, width) {
  fs.mkdirSync(path.dirname(jpg), { recursive: true });     // ffmpeg 不会自己建目录
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', png];
  if (width) args.push('-vf', `scale=${width}:-2`);
  args.push('-q:v', '2', jpg);
  execFileSync('ffmpeg', args);
  return jpg;
}

async function one(id, force) {
  const out = {};
  for (const [kind, want, width] of [['thumb', 'member_thumbnail', 0], ['full', 'member_full', 900]]) {
    const dest = path.join(ART, kind, id + '.jpg');
    if (!force && findArt(kind, id)) { out[kind] = 'skip'; continue; }
    const b = bundleFor(id, kind);
    if (!b) { out[kind] = 'no-bundle'; continue; }
    const png = path.join(TMP, `${id}_${kind}.png`);
    const info = await exportNamed(b, want, png);
    toJpg(png, dest, width);
    try { fs.unlinkSync(png); } catch (e) {}
    out[kind] = `${(fs.statSync(dest).size / 1024).toFixed(0)}KB${info.meta ? ' ' + info.meta.width + 'x' + info.meta.height : ''}`;
  }
  return out;
}

const readSongs = () => (readJson(path.join(ON, 'songs.json'), {}).songs || []);

/** 曲绘：Image/Jacket/<jacket> → art/jacket/<jacket>.jpg（512x512） */
async function jacketOne(jacket, force) {
  const dest = path.join(ART, 'jacket', jacket + '.jpg');
  if (!force && (exists(dest) || exists(path.join(ART, 'jacket', jacket + '.png')))) return 'skip';
  const names = readJson(path.join(ON, 'bundle_inventory.json'), {}).names || [];
  const pre = 'image_assets_image_jacket_' + jacket.toLowerCase() + '_';
  const name = names.find((n) => n.startsWith(pre) && /^[0-9a-f]{32}\.bundle$/.test(n.slice(pre.length)));
  if (!name) return 'no-bundle';
  const local = path.join(DL, name);
  let src = local;
  if (!exists(src)) {
    const songs = readJson(path.join(ON, 'songs.json'), {});
    src = path.join(TMP, name);
    fs.mkdirSync(TMP, { recursive: true });
    execFileSync('curl', ['-s', '-m', '300', '-o', src, '-w', '%{http_code}', '-u', songs.auth, songs.cdn + '/' + name], { encoding: 'utf8' });
  }
  const png = path.join(TMP, jacket + '.png');
  const info = await exportNamed(src, jacket, png);
  toJpg(png, dest, 512);
  try { fs.unlinkSync(png); } catch (e) {}
  return `${(fs.statSync(dest).size / 1024).toFixed(0)}KB${info.meta ? ' ' + info.meta.width + 'x' + info.meta.height : ''}`;
}

/** 留影卡缩略图：SupportCard/<id>/snap_thumbnail → art/support/<id>.jpg */
async function supportOne(id, force) {
  const dest = path.join(ART, 'support', id + '.jpg');
  if (!force && exists(dest)) return 'skip';
  const names = readJson(path.join(ON, 'bundle_inventory.json'), {}).names || [];
  const pre = `supportcard_assets_supportcard_${id}_snap_thumbnail_`;
  const name = names.find((n) => n.startsWith(pre) && /^[0-9a-f]{32}\.bundle$/.test(n.slice(pre.length)));
  if (!name) return 'no-bundle';
  const local = path.join(DL, name);
  let src = local;
  if (!exists(src)) {
    const songs = readJson(path.join(ON, 'songs.json'), {});
    src = path.join(TMP, name);
    fs.mkdirSync(TMP, { recursive: true });
    execFileSync('curl', ['-s', '-m', '300', '-o', src, '-w', '%{http_code}', '-u', songs.auth, songs.cdn + '/' + name], { encoding: 'utf8' });
  }
  const png = path.join(TMP, 'sc' + id + '.png');
  const info = await exportNamed(src, 'snap_thumbnail', png);
  toJpg(png, dest, 512);
  try { fs.unlinkSync(png); } catch (e) {}
  return `${(fs.statSync(dest).size / 1024).toFixed(0)}KB${info.meta ? ' ' + info.meta.width + 'x' + info.meta.height : ''}`;
}

(async () => {
  const idsArg = arg('ids', null);
  let ids;
  if (idsArg && idsArg !== true) ids = String(idsArg).split(/[,\s]+/).map(Number).filter(Boolean);
  else {
    const ix = readJson(path.join(ON, 'index.json'), null);
    if (!ix) { console.error('读不到 index.json'); process.exit(2); }
    ids = ix.cards.map((c) => c.id).sort((a, b) => a - b);
  }
  const force = !!arg('force', false);
  const dry = !!arg('dry', false);
  let fixed = 0, missing = 0;
  for (const id of ids) {
    const lack = ['thumb', 'full'].filter((k) => !findArt(k, id));
    if (!lack.length && !force) continue;
    if (dry) { console.log(`缺 ${id}: ${lack.join('+') || '(要重做)'}`); missing++; continue; }
    try {
      const r = await one(id, force);
      console.log(`✓ ${id} thumb=${r.thumb} full=${r.full}`);
      fixed++;
    } catch (e) {
      console.log(`✗ ${id} ${e.message.slice(0, 120)}`);
      missing++;
    }
  }
  // 顺带：曲绘（新曲进来时 art/jacket 里会缺）+ 留影卡缩略图
  let jack = 0, jackMiss = 0, sup = 0;
  if (!dry) {
    for (const sg of readSongs()) {
      if (!sg.jacket) continue;
      try {
        const r = await jacketOne(sg.jacket, force);
        if (r === 'skip') continue;
        if (r === 'no-bundle') { jackMiss++; console.log(`✗ 曲绘 ${sg.jacket}（inventory 里没有包）`); }
        else { jack++; console.log(`✓ 曲绘 ${sg.jacket} ${r}`); }
      } catch (e) { jackMiss++; console.log(`✗ 曲绘 ${sg.jacket} ${e.message.slice(0, 100)}`); }
    }
    const supIds = (readJson(path.join(ON, 'master', 'MasterSupportCard.json'), {})._allData || []).map((x) => x._id);
    for (const id of supIds) {
      try { if (await supportOne(id, force) !== 'skip') sup++; } catch (e) { /* 缺包就跳过 */ }
    }
  }
  console.log(`\n卡面补齐完成：卡 ${fixed} 张（失败 ${missing}），曲绘 ${jack} 张（缺 ${jackMiss}），留影卡缩略图 ${sup} 张`);
  console.log(`art 目录：thumb ${fs.readdirSync(path.join(ART, 'thumb')).length} / full ${fs.readdirSync(path.join(ART, 'full')).length} / jacket ${fs.readdirSync(path.join(ART, 'jacket')).length} / support ${fs.existsSync(path.join(ART, 'support')) ? fs.readdirSync(path.join(ART, 'support')).length : 0}`);
  if (missing && !dry) process.exitCode = 1;
})();
