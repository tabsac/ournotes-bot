#!/usr/bin/env node
/**
 * Our Notes 资源自动更新（阶段一：探测 + 增量下载 + 解密校验）
 *
 *   node on_update.js            探测；有变化则输出摘要（退出码 1 表示有更新）
 *   node on_update.js --apply    探测 + 下载新增资源包并解密校验
 *   node on_update.js --status   只打印当前状态
 *   node on_update.js --json     结果以 JSON 输出
 *
 * 原理：Addressables 远端的 bundle 名自带内容 hash 后缀
 *   live_assets_live_musicscore_0001_0001_03_be02901aec561cfa69f6a0d700190757.bundle
 * 内容一变名字就变 => 「catalog 名字集合 diff」就是最可靠的更新探测。
 * 探测点：catalog_<ver>_<locale>.hash（32 字节），变了才下 8.6MB 的 catalog。
 *
 * 只有下载回来的包解密头不是 UnityFS 时，才判定「密钥可能已更换」-> 需要人工提供新 APK。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('/home/admin/bot/data/on/unitysrc/crypto.js');
const { execFileSync } = require('child_process');

const ON = '/home/admin/bot/data/on';
const BASE = 'https://l14-prod-hk-patch-sirius.gamerfusiontech.com/prod/hk_27f3c91e8b62d6056c7a19f2e83b6d10/asset/Android';
const AUTH = 'sirius:pXrQcRvnwkux6hp89OpgFHytDjm2DTM';
const API_HOST = 'https://l14-prod-hk-all-gs-sirius.gamerfusiontech.com';
const VERSION_RPC = API_HOST + '/app.masterdata.MasterdataService/Version';
const CATALOG_LOCALE = 'zh-Hans';
const CATALOG_FALLBACK = 'catalog_1.0.0.104_zh-Hans.bin';
const CATALOG_HASH = (n) => n.replace(/\.bin$/, '.hash');
const STATE = path.join(ON, 'update_state.json');
// 下下来的 catalog 要落盘：build_songs2.py / cri_url.py 都是读这个文件推包名/音频 URL 的，
// 只写 inventory 不写 catalog 的话，新曲的谱面包名会算不出来（踩过：100109 谱面全 None）
const CATALOG_FILE = path.join(ON, 'catalog.bin');
const INVENTORY = path.join(ON, 'bundle_inventory.json');
const DLDIR = path.join(ON, 'dl');
const UA = 'UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)';

const CATS = [
  ['谱面', /live_assets_live_musicscore/i],
  ['卡面', /membercard_assets_membercard/i],
  ['封面', /image_assets_image_jacket/i],
  ['音频', /^cri_assets_cri_sound/i],
  ['谱面UI', /live_assets_live_(lane|note|judge|effect)/i],
  ['支援卡', /supportcard_assets_supportcard/i],
  ['剧情', /story_assets_story/i],
  ['其它', /.*/],
];
const catOf = (n) => (CATS.find(([, re]) => re.test(n)) || [, '其它'])[0];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getOnce = (url, { auth = true, binary = true } = {}) => new Promise((res, rej) => {
  const u = new URL(url);
  const headers = { 'User-Agent': UA, Accept: '*/*' };
  if (auth) headers.Authorization = 'Basic ' + Buffer.from(AUTH).toString('base64');
  const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 120000, family: 4 }, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      r.resume();
      return getOnce(new URL(r.headers.location, url).href, { auth, binary }).then(res, rej);
    }
    const chunks = [];
    r.on('data', c => chunks.push(c));
    r.on('end', () => {
      const buf = Buffer.concat(chunks);
      res({ code: r.statusCode, size: buf.length, buf, text: binary ? null : buf.toString('utf8') });
    });
  });
  req.on('error', rej);
  req.on('timeout', () => req.destroy(new Error('timeout ' + url)));
});
// curl 兜底：这台机器上 curl 到该 CDN 比 node 稳（实测 node 会偶发 DNS/连接失败）
const curlGet = (url, { auth = true } = {}) => {
  const tmp = '/tmp/_up_' + process.pid + '_' + Math.random().toString(36).slice(2);
  const args = ['-sS', '--max-time', '180', '--retry', '2', '-o', tmp, '-w', '%{http_code}', '-A', UA];
  if (auth) args.push('-u', AUTH);
  args.push(url);
  const code = parseInt(execFileSync('curl', args, { encoding: 'utf8' }).trim(), 10);
  const buf = fs.existsSync(tmp) ? fs.readFileSync(tmp) : Buffer.alloc(0);
  try { fs.unlinkSync(tmp); } catch (e) {}
  return { code, size: buf.length, buf, text: null };
};
const get = async (url, opt, tries = 2) => {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await getOnce(url, opt); }
    catch (e) { last = e; if (i < tries - 1) await sleep(1500 * (i + 1)); }
  }
  try { return curlGet(url, opt || {}); }          // node 失败 -> curl 兜底
  catch (e) { throw new Error((last && last.message) + ' | curl: ' + e.message); }
};

// 公共的版本接口（无需登录）：gRPC 空帧 -> protobuf{ field1: resourceVersion, field2: contentVersion }
function masterVersion() {
  const tmp = '/tmp/_ver_' + process.pid;
  try {
    fs.writeFileSync(tmp, Buffer.from([0, 0, 0, 0, 0]));
    const out = execFileSync('curl', ['-sS', '--max-time', '20', '-X', 'POST',
      '-H', 'Content-Type: application/grpc+proto', '-H', 'TE: trailers',
      '--data-binary', '@' + tmp, VERSION_RPC], { maxBuffer: 1 << 20 });
    const b = Buffer.from(out, 'binary');
    const fields = {};
    let i = 5;                                    // 跳过 5 字节 gRPC 帧头
    while (i < b.length) {
      const tag = b[i++];
      if ((tag & 7) !== 2) { i++; continue; }
      let len = b[i++]; if (len > 127) { len = ((len & 0x7f) << 7) | b[i++]; }
      fields[tag >> 3] = b.slice(i, i + len).toString('utf8');
      i += len;
    }
    return { resourceVersion: fields[1] || null, contentVersion: fields[2] || null };
  } catch (e) { return { error: e.message }; }
  finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}

const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2)); };

function parseCatalog(buf) {
  const s = buf.toString('latin1');
  const set = new Set();
  for (const m of s.matchAll(/[A-Za-z0-9_\-\.\(\)]{6,140}\.bundle/g)) set.add(m[0]);
  return [...set].sort();
}

(async () => {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const apply = args.includes('--apply');
  const statusOnly = args.includes('--status');
  const state = readJson(STATE, {}) || {};
  const inv = readJson(INVENTORY, null);

  if (statusOnly) {
    const r = {
      catalogHash: state.catalogHash || null, lastCheck: state.lastCheck || null,
      inventory: inv ? (inv.names || []).length : 0,
      lastNew: (state.lastNew || []).length, lastNewAt: state.lastNewAt || null,
      keySuspect: !!state.keySuspect,
    };
    console.log(jsonOut ? JSON.stringify(r, null, 2)
      : `catalog hash : ${r.catalogHash}\n上次检查     : ${r.lastCheck}\n已知 bundle  : ${r.inventory}\n上次新增     : ${r.lastNew} 个（${r.lastNewAt || '-'}）\n密钥可疑     : ${r.keySuspect ? '是（需人工提供新 APK）' : '否'}`);
    process.exit(0);
  }

  const log = (...a) => { if (!jsonOut) console.error(...a); };
  const result = { checkedAt: new Date().toISOString(), changed: false, new: [], categories: {}, applied: null, errors: [], keySuspect: false };

  // 0) 公共版本接口（无需登录，约 50 字节）
  const ver = masterVersion();
  result.contentVersion = ver.contentVersion || null;
  result.resourceVersion = ver.resourceVersion || null;
  if (ver.error) result.errors.push('版本接口失败: ' + ver.error);
  log(`[0/4] 版本接口: content=${result.contentVersion} resource=${result.resourceVersion}`);

  // 1) 探测 catalog hash（catalog 名 = catalog_<contentVersion>_<locale>.bin）
  const CATALOG = ver.contentVersion ? `catalog_${ver.contentVersion}_${CATALOG_LOCALE}.bin` : CATALOG_FALLBACK;
  result.catalog = CATALOG;
  let hashRes;
  try { hashRes = await get(`${BASE}/${CATALOG_HASH(CATALOG)}`); }
  catch (e) { result.errors.push('catalog.hash 获取失败: ' + e.message); }
  if (hashRes && hashRes.code !== 200) result.errors.push('catalog.hash HTTP ' + hashRes.code);
  const catalogHash = hashRes && hashRes.code === 200 ? hashRes.buf.toString('utf8').trim() : null;
  result.catalogHash = catalogHash;
  log(`[1/4] catalog hash = ${catalogHash || '(获取失败)'}`);

  if (!catalogHash) {
    writeJson(STATE, { ...state, lastCheck: result.checkedAt, errors: result.errors });
    console.log(jsonOut ? JSON.stringify(result, null, 2) : '探测失败：' + result.errors.join('; '));
    process.exit(2);
  }

  // 2) hash 未变 -> 直接报「无更新」（除非本地 catalog.bin 缺失/太小，或被要求强制刷新）
  const localCatalogSize = fs.existsSync(CATALOG_FILE) ? fs.statSync(CATALOG_FILE).size : 0;
  const forceCatalog = process.argv.includes('--refresh-catalog');
  if (state.catalogHash === catalogHash && inv && localCatalogSize > 1000 && !forceCatalog) {
    result.inventoryCount = (inv.names || []).length;
    log('[2/4] hash 未变，无需下载 catalog');
    writeJson(STATE, { ...state, lastCheck: result.checkedAt, errors: [] });
    console.log(jsonOut ? JSON.stringify(result, null, 2) : `无更新（已知 ${result.inventoryCount} 个资源包，catalog hash ${catalogHash}）`);
    process.exit(0);
  }

  // 3) 拉 catalog 并 diff
  let cat;
  try { cat = await get(`${BASE}/${CATALOG}`); }
  catch (e) { result.errors.push('catalog 下载失败: ' + e.message); }
  if (!cat || cat.code !== 200 || cat.size < 1000) {
    result.errors.push(`catalog 异常: HTTP ${cat && cat.code} ${cat && cat.size}B`);
    writeJson(STATE, { ...state, lastCheck: result.checkedAt, errors: result.errors });
    console.log(jsonOut ? JSON.stringify(result, null, 2) : '探测失败：' + result.errors.join('; '));
    process.exit(2);
  }
  const names = parseCatalog(cat.buf);
  try {
    fs.writeFileSync(CATALOG_FILE + '.tmp', cat.buf);
    fs.renameSync(CATALOG_FILE + '.tmp', CATALOG_FILE);
    log(`[3/4] catalog 已落盘 ${CATALOG_FILE}（${(cat.size / 1048576).toFixed(1)}MB, ${CATALOG}）`);
  } catch (e) {
    result.errors.push('catalog 落盘失败: ' + e.message);
    log('      catalog 落盘失败: ' + e.message);
  }
  const old = new Set((inv && inv.names) || []);
  const isFirst = !inv;
  const added = isFirst ? [] : names.filter(n => !old.has(n));
  const removed = isFirst ? [] : (inv.names || []).filter(n => !names.includes(n));
  const byCat = {};
  for (const n of added) byCat[catOf(n)] = (byCat[catOf(n)] || 0) + 1;
  result.inventoryCount = names.length;
  result.changed = !isFirst && added.length > 0;
  result.firstRun = isFirst;
  result.new = added;
  result.categories = byCat;
  result.removedCount = removed.length;
  log(`[2/4] catalog ${(cat.size / 1048576).toFixed(1)}MB, bundle 名 ${names.length} 个${isFirst ? '（首次建立基线）' : ''}`);
  if (!isFirst) log(`[3/4] 新增 ${added.length} 个, 消失 ${removed.length} 个` + (added.length ? ' -> ' + JSON.stringify(byCat) : ''));

  writeJson(INVENTORY, { catalogHash, updatedAt: result.checkedAt, count: names.length, names });
  writeJson(STATE, {
    ...state, catalogHash, lastCheck: result.checkedAt, inventoryCount: names.length,
    lastNew: added.slice(0, 200), lastNewAt: added.length ? result.checkedAt : (state.lastNewAt || null),
    lastRemoved: removed.slice(0, 50), errors: [],
  });

  // 4) --apply：下载新增包并解密校验（默认只取游戏内容相关的前几类）
  if (apply && added.length) {
    const want = new Set(['谱面', '卡面', '封面', '音频', '支援卡', '谱面UI']);
    const list = added.filter(n => want.has(catOf(n)));
    fs.mkdirSync(DLDIR, { recursive: true });
    const applied = { tried: list.length, ok: 0, failed: [], bytes: 0, skipped: added.length - list.length };
    log(`[4/4] 下载 ${list.length} 个新增包（跳过其它类 ${applied.skipped} 个）...`);
    for (const n of list) {
      const dest = path.join(DLDIR, n);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { applied.ok++; continue; }
      try {
        const r = await get(`${BASE}/${encodeURIComponent(n)}`);
        if (r.code !== 200 || r.size < 100) throw new Error('HTTP ' + r.code + ' ' + r.size + 'B');
        const { data } = crypto.decryptBundle(r.buf, n);
        const head = data.slice(0, 8).toString('latin1');
        if (head !== 'UnityFS\0') throw new Error('解密头异常: ' + JSON.stringify(head));
        fs.writeFileSync(dest, r.buf);
        applied.ok++; applied.bytes += r.size;
        log(`     ok ${n.slice(0, 70)} (${(r.size / 1024).toFixed(0)}KB)`);
      } catch (e) {
        applied.failed.push({ name: n, error: e.message });
        if (/解密头异常/.test(e.message)) result.keySuspect = true;
      }
    }
    result.applied = applied;
    result.keySuspect = result.keySuspect || (applied.tried > 0 && applied.ok === 0);
    writeJson(STATE, { ...readJson(STATE, {}), keySuspect: result.keySuspect, lastApply: result.checkedAt, applied });
    log(`[4/4] 成功 ${applied.ok}/${applied.tried}，共 ${(applied.bytes / 1048576).toFixed(1)}MB，失败 ${applied.failed.length}`);
    if (result.keySuspect) log('!! 解密全部/部分失败 —— 密钥可能已更换，需要人工提供新 APK');
  }

  if (jsonOut) console.log(JSON.stringify(result, null, 2));
  else if (result.firstRun) console.log(`首次建立基线：记录 ${names.length} 个资源包`);
  else if (!added.length) console.log('无新增资源');
  else console.log(`发现 ${added.length} 个新增资源包：` + Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join('、'));

  process.exit(result.changed ? 1 : 0);
})().catch(e => { console.error('未捕获错误: ' + e.stack); process.exit(3); });
