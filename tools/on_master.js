#!/usr/bin/env node
/**
 * Our Notes 主数据（Master 表）自动更新
 *
 *   路径规律（已由抓包 + 实测确认）：
 *     <BASE_ROOT>/master/<resourceVersion>/MasterManifest.json      ← 明文 JSON，无鉴权
 *     <BASE_ROOT>/master/<resourceVersion>/Master<Xxx>.bin          ← 逐表下载
 *   resourceVersion 由公开 gRPC 接口取回（5 字节空帧，无需登录）：
 *     POST https://l14-prod-hk-all-gs-sirius.gamerfusiontech.com
 *          /app.masterdata.MasterdataService/Version
 *
 *   .bin 解密：Rijndael-256-CBC(Nb=8) + PKCS#7 + gzip  → 交给 tools/master_decrypt.py
 *
 * 用法： node on_master.js [--apply] [--json]
 *   无 --apply：只报告哪些表变了（约 1 次 HTTP + 44KB）
 *   --apply  ：下载变更表 → 解密 → 覆盖 data/on/master/<Name>.json
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ON = '/home/admin/bot/data/on';
const BASE_ROOT = 'https://l14-prod-hk-patch-sirius.gamerfusiontech.com/prod/hk_27f3c91e8b62d6056c7a19f2e83b6d10';
const AUTH = 'sirius:pXrQcRvnwkux6hp89OpgFHytDjm2DTM';
const API_HOST = 'https://l14-prod-hk-all-gs-sirius.gamerfusiontech.com';
const VERSION_RPC = API_HOST + '/app.masterdata.MasterdataService/Version';
const MASTER_DIR = path.join(ON, 'master');
const INDEX = path.join(ON, 'master_index.json');
const DECRYPT_PY = '/home/admin/bot/tools/master_decrypt.py';
const TMP = '/tmp/onmaster';
const UA = 'UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)';

const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2)); };

function curlGet(url, { auth = true, out = null } = {}) {
  const tmp = out || ('/tmp/_om_' + process.pid + '_' + Math.random().toString(36).slice(2));
  const args = ['-sS', '--max-time', '120', '--retry', '2', '-o', tmp, '-w', '%{http_code}', '-A', UA];
  if (auth) args.push('-u', AUTH);
  args.push(url);
  const code = parseInt(execFileSync('curl', args, { encoding: 'utf8' }).trim(), 10);
  if (out) return { code, size: fs.existsSync(out) ? fs.statSync(out).size : 0, path: out };
  const buf = fs.existsSync(tmp) ? fs.readFileSync(tmp) : Buffer.alloc(0);
  try { fs.unlinkSync(tmp); } catch (e) {}
  return { code, size: buf.length, buf };
}

function masterVersion() {
  const tmp = '/tmp/_ver_' + process.pid;
  try {
    fs.writeFileSync(tmp, Buffer.from([0, 0, 0, 0, 0]));
    const out = execFileSync('curl', ['-sS', '--max-time', '20', '-X', 'POST',
      '-H', 'Content-Type: application/grpc+proto', '-H', 'TE: trailers',
      '--data-binary', '@' + tmp, VERSION_RPC], { maxBuffer: 1 << 20 });
    const b = Buffer.from(out, 'binary');
    const f = {};
    let i = 5;
    while (i < b.length) {
      const tag = b[i++];
      if ((tag & 7) !== 2) { i++; continue; }
      let len = b[i++]; if (len > 127) { len = ((len & 0x7f) << 7) | b[i++]; }
      f[tag >> 3] = b.slice(i, i + len).toString('utf8');
      i += len;
    }
    return { resourceVersion: f[1] || null, contentVersion: f[2] || null };
  } catch (e) { return { error: e.message }; }
  finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}

(async () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const jsonOut = args.includes('--json');
  const log = (...a) => { if (!jsonOut) console.error(...a); };
  const result = { checkedAt: new Date().toISOString(), changed: false, changedTables: [], applied: null, errors: [] };

  const ver = masterVersion();
  result.resourceVersion = ver.resourceVersion;
  result.contentVersion = ver.contentVersion;
  if (!ver.resourceVersion) {
    result.errors.push('版本接口失败: ' + (ver.error || '无 resourceVersion'));
    console.log(jsonOut ? JSON.stringify(result, null, 2) : '失败：' + result.errors.join('; '));
    process.exit(2);
  }
  log(`[1/3] resourceVersion = ${ver.resourceVersion}（内容版本 ${ver.contentVersion}）`);

  const url = `${BASE_ROOT}/master/${ver.resourceVersion}/MasterManifest.json`;
  const mf = curlGet(url);
  if (mf.code !== 200) {
    result.errors.push(`MasterManifest HTTP ${mf.code}`);
    console.log(jsonOut ? JSON.stringify(result, null, 2) : '失败：' + result.errors.join('; '));
    process.exit(2);
  }
  let man;
  try { man = JSON.parse(mf.buf.toString('utf8')); } catch (e) { result.errors.push('manifest 非 JSON'); }
  if (!man || !Array.isArray(man.files)) {
    console.log(jsonOut ? JSON.stringify(result, null, 2) : '失败：manifest 结构异常');
    process.exit(2);
  }
  log(`[2/3] manifest version=${man.version}, ${man.files.length} 张表, 合计 ${(man.files.reduce((a, f) => a + f.size, 0) / 1048576).toFixed(2)}MB`);

  const idx = readJson(INDEX, null);
  const prev = (idx && idx.files) || null;
  const changed = man.files.filter(f => !prev || prev[f.name] !== f.hash);
  const localMissing = man.files.filter(f => !fs.existsSync(path.join(MASTER_DIR, f.name.replace(/\.bin$/, '.json'))));
  result.total = man.files.length;
  result.changed = changed.length > 0;
  result.changedTables = changed.map(f => f.name);
  result.localMissing = localMissing.length;
  log(`[3/3] 变更 ${changed.length} 张${prev ? '' : '（首次，全量）'} | 本地缺 ${localMissing.length} 张`);

  if (apply && changed.length) {
    fs.mkdirSync(TMP, { recursive: true });
    const ap = { tried: changed.length, ok: 0, failed: [], bytes: 0 };
    for (const f of changed) {
      const bin = path.join(TMP, f.name);
      const out = path.join(MASTER_DIR, f.name.replace(/\.bin$/, '.json'));
      try {
        const r = curlGet(`${BASE_ROOT}/master/${ver.resourceVersion}/${f.name}`, { out: bin });
        if (r.code !== 200 || r.size !== f.size) throw new Error(`HTTP ${r.code} size ${r.size}≠${f.size}`);
        execFileSync('python3', [DECRYPT_PY, bin, out], { stdio: 'pipe' });
        JSON.parse(fs.readFileSync(out, 'utf8'));            // 校验是合法 JSON
        ap.ok++; ap.bytes += r.size;
        try { fs.unlinkSync(bin); } catch (e) {}
      } catch (e) {
        ap.failed.push({ name: f.name, error: String(e.message).slice(0, 160) });
      }
    }
    result.applied = ap;
    log(`     解密写入 ${ap.ok}/${ap.tried}，${(ap.bytes / 1048576).toFixed(2)}MB，失败 ${ap.failed.length}`);
    if (ap.failed.length) log('     失败示例: ' + JSON.stringify(ap.failed.slice(0, 3)));
    if (ap.ok > 0) {
      const files = {};
      for (const f of man.files) files[f.name] = f.hash;
      writeJson(INDEX, { resourceVersion: ver.resourceVersion, contentVersion: ver.contentVersion, updatedAt: result.checkedAt, files });

      // 主数据变了 -> 必须重建派生索引，否则新曲/新卡不会出现（以前要手工跑，容易忘）
      const gen = { ok: [], failed: [] };
      for (const [label, script] of [['songs.json', 'build_songs2.py'],
                                     ['index.json', 'build_index.py']]) {
        try {
          const out = execFileSync('python3', [path.join(__dirname, script)],
                                   { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          gen.ok.push(label);
          log(`     重建 ${label}：${String(out).trim().split('\n').slice(-1)[0].slice(0, 120)}`);
        } catch (e) {
          const msg = String(e.stderr || e.message).trim().slice(0, 200);
          gen.failed.push({ label, error: msg });
          log(`     重建 ${label} 失败：${msg}`);
        }
      }
      // 新卡还需要卡面文件（art/thumb|full/<id>.jpg）：主数据有了但图没解出来时，
      // /on查卡 会画成灰块（踩过：63 张卡里新加的 61–63 一直没图）。这里顺手补齐。
      try {
        const out = execFileSync('node', [path.join(__dirname, 'fetch_card_art.js')],
                                 { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60 * 1000 });
        const last = String(out).trim().split('\n').filter(Boolean).pop() || '';
        gen.ok.push('卡面');
        log(`     补齐卡面：${last.slice(0, 140)}`);
      } catch (e) {
        const msg = String(e.stderr || e.message).trim().slice(0, 200);
        gen.failed.push({ label: '卡面', error: msg });
        log(`     补齐卡面失败：${msg}`);
      }
      result.regenerated = gen;
    }
  } else if (!apply && prev) {
    result.note = '未下载（加 --apply 生效）';
  } else if (!apply) {
    result.note = '首次运行，加 --apply 可全量下载并解密';
  }

  if (jsonOut) console.log(JSON.stringify(result, null, 2));
  else if (!changed.length) console.log(`主数据已是最新（${man.files.length} 张表，resourceVersion ${ver.resourceVersion}）`);
  else console.log(`主数据有 ${changed.length} 张表变更` + (result.applied ? `，已写入 ${result.applied.ok} 张` : '（未下载）'));

  process.exit(result.changed ? 1 : 0);
})().catch(e => { console.error('未捕获: ' + e.stack); process.exit(3); });
