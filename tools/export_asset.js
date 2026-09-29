'use strict';
// 资源名 → PNG：走 bundle_inventory.json 找到所属包，下载（带 CDN 凭据）、解密、导出图片。
// 包名规律：<首段小写>_assets_<资源全路径小写，'/' → '_'>_<32位hash>.bundle
//   例 Gacha/Banner/gacha_banner_00001
//      → gacha_assets_gacha_banner_gacha_banner_00001_<hash>.bundle
//
//   node tools/export_asset.js --asset Gacha/Banner/gacha_banner_00001 --out /tmp/b.png
//   node tools/export_asset.js --asset ... --list        只打印解析到的包名，不下载
//
// 导出优先取 Sprite（Texture2D 常是整张图集，含留白、方向也不对）。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ON_DIR = process.env.ON_DIR || '/home/admin/bot/data/on';
const DL_DIR = process.env.ON_ASSET_DL || '/tmp/on_asset';

function readJson(p, d) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; }
}

/** 资源名 → 包名（找不到返回 null；路径不匹配时退化成按末段模糊匹配） */
function bundleForAsset(asset, inv) {
  const parts = String(asset || '').split('/').filter(Boolean);
  if (parts.length >= 2) {
    const pre = parts[0].toLowerCase() + '_assets_' + parts.join('_').toLowerCase() + '_';
    const hit = inv.find((n) => n.startsWith(pre) && /^[0-9a-f]{32}\.bundle$/.test(n.slice(pre.length)));
    if (hit) return hit;
  }
  const tail = '_' + parts[parts.length - 1].toLowerCase() + '_';
  return inv.find((n) => n.indexOf(tail) >= 0 && /^[0-9a-f]{32}\.bundle$/.test(n.slice(-39))) || null;
}

function download(url, dest, auth) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const args = ['-s', '-m', '300', '-o', dest, '-w', '%{http_code}'];
  if (auth) args.push('-u', auth);
  args.push(url);
  const code = execFileSync('curl', args, { encoding: 'utf8' }).trim();
  if (code !== '200') throw new Error('下载失败 HTTP ' + code + ' ' + url);
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (k, d) => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const asset = get('--asset');
  if (!asset) throw new Error('要 --asset <资源名>，例 Gacha/Banner/gacha_banner_00001');
  const songs = readJson(path.join(ON_DIR, 'songs.json'), null);
  const inv = (readJson(path.join(ON_DIR, 'bundle_inventory.json'), {}) || {}).names || [];
  const bundle = bundleForAsset(asset, inv);
  if (!bundle) throw new Error('bundle_inventory 里没有 ' + asset + ' 的包');
  if (argv.includes('--list')) { console.log(bundle); return; }

  const out = get('--out');
  if (!out) throw new Error('要 --out <png 路径>');
  const bfile = path.join(DL_DIR, bundle);
  if (!fs.existsSync(bfile) || fs.statSync(bfile).size < 10240) {
    download(songs.cdn + '/' + bundle, bfile, songs.auth);
  }
  const { Bundle } = require(path.join(ON_DIR, 'unitysrc', 'bundle.js'));
  const { exportObject } = require(path.join(ON_DIR, 'unitysrc', 'exporter.js'));
  const b = Bundle.load(bfile);
  const objs = b.listObjects();
  const cand = objs.filter((e) => e.className === 'Sprite')
    .concat(objs.filter((e) => e.className === 'Texture2D'));
  for (const e of cand) {
    const r = await exportObject(b, e);
    if (r && r.ext === '.png' && r.data) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, r.data);
      const meta = r.meta ? r.meta.width + 'x' + r.meta.height : '';
      console.log(JSON.stringify({ asset: asset, bundle: bundle, out: out, from: e.className, name: r.name, size: meta }));
      try { fs.unlinkSync(bfile); } catch (e2) {}
      return;
    }
  }
  throw new Error(asset + ' 的包里没有图片对象');
}

main().catch((e) => { console.error('export_asset: ' + (e && e.message ? e.message : e)); process.exit(1); });
