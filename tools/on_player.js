// Our Notes(邦邦新游) gRPC 网关客户端 —— 登录态 + schema 驱动编解码
//   会话与 schema 都在 data/on/ 下；纯 Node，无第三方依赖；HTTP/2 + gzip
// 用法（在 /home/admin/bot 下执行）：
//   node tools/on_player.js friend <profileId>   # Friend.FindByProfileID（别人/自己的公开资料）
//   node tools/on_player.js me                   # Player.GetPlayerData（自己的数据 + 好友列表）
//   node tools/on_player.js serverlist            # PlayerLogin.GetServerList（免登录）
//   node tools/on_player.js switches              # FeatureSwitch.Get（免登录，探活）
//   node tools/on_player.js login                # 用 data/on/sdk.json 里的 SDK 票据换游戏会话（轮换 credential）
//   node tools/on_player.js call <Svc> <Method> '<json>'   # 任意方法，body 是「字段名→值」的 JSON
//   node tools/on_player.js schema <MessageName>  # 看某个消息的字段表
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const HOST = 'l14-prod-hk-all-gs-sirius.gamerfusiontech.com';
const SDK_HOST = 'https://l11-sdk-login-intl.biligame.net';
const ON_DIR = path.join(__dirname, '..', 'data', 'on');
const SESSION_FILE = process.env.ON_SESSION || path.join(ON_DIR, 'session.json');
const SDK_FILE = path.join(ON_DIR, 'sdk.json');
const SDK_REPLAY_FILE = path.join(ON_DIR, 'sdk_replay.txt');
const SCHEMA_FILE = process.env.ON_SCHEMA || path.join(ON_DIR, 'schema.json');

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const writeJson = (f, o) => { const t = f + '.part'; fs.writeFileSync(t, JSON.stringify(o, null, 1)); fs.renameSync(t, f); };
const SCHEMA = readJson(SCHEMA_FILE, { messages: {}, services: {} });

// ---------------------------------------------------------------- protobuf 编解码（schema 驱动）
const VARINT_TYPES = ['int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'bool', 'enum'];
const FIXED64 = ['fixed64', 'sfixed64', 'double'];
const FIXED32 = ['fixed32', 'sfixed32', 'float'];
const wireOf = (t) => (VARINT_TYPES.indexOf(t) >= 0 ? 0 : (FIXED64.indexOf(t) >= 0 ? 1 : (FIXED32.indexOf(t) >= 0 ? 5 : 2)));

function varint(n) {
  let v = BigInt(n);
  if (v < 0n) v += 1n << 64n;
  const out = [];
  while (v > 127n) { out.push(Number((v & 127n) | 128n)); v >>= 7n; }
  out.push(Number(v));
  return Buffer.from(out);
}
function readVarint(b, i) {
  let v = 0n, s = 0n;
  while (i < b.length) { const c = b[i++]; v |= BigInt(c & 0x7f) << s; s += 7n; if (!(c & 0x80)) break; }
  return [v, i];
}
function fieldsOf(typeName) {
  const m = SCHEMA.messages[typeName];
  return (m && m.fields) || null;
}
function byNum(typeName) {
  const f = fieldsOf(typeName);
  if (!f) return {};
  const out = {};
  for (const x of f) out[x.num] = x;
  return out;
}

function encode(typeName, obj) {
  const spec = fieldsOf(typeName);
  if (!spec) throw new Error('schema 里没有消息 ' + typeName);
  const parts = [];
  for (const f of spec) {
    let v = obj[f.name];
    if (v === undefined || v === null) continue;
    const list = f.label === 'repeated' ? (Array.isArray(v) ? v : [v]) : [v];
    for (const one of list) {
      const key = varint((BigInt(f.num) << 3n) | BigInt(wireOf(f.type)));
      if (f.type === 'message') parts.push(key, (() => { const b = encode(f.typeName, one); return Buffer.concat([varint(b.length), b]); })());
      else if (f.type === 'string') { const b = Buffer.from(String(one), 'utf8'); parts.push(key, varint(b.length), b); }
      else if (f.type === 'bytes') { const b = Buffer.isBuffer(one) ? one : Buffer.from(String(one), 'hex'); parts.push(key, varint(b.length), b); }
      else if (FIXED64.indexOf(f.type) >= 0) { const b = Buffer.alloc(8); if (f.type === 'double') b.writeDoubleLE(Number(one)); else b.writeBigUInt64LE(BigInt(one)); parts.push(key, b); }
      else if (FIXED32.indexOf(f.type) >= 0) { const b = Buffer.alloc(4); if (f.type === 'float') b.writeFloatLE(Number(one)); else b.writeUInt32LE(Number(one)); parts.push(key, b); }
      else parts.push(key, varint(one === true ? 1 : (one === false ? 0 : one)));
    }
  }
  return Buffer.concat(parts);
}

function decode(typeName, buf) {
  const spec = byNum(typeName);
  const out = {};
  let i = 0;
  while (i < buf.length) {
    let key; [key, i] = readVarint(buf, i);
    const num = Number(key >> 3n), wire = Number(key & 7n);
    const f = spec[num];
    let val;
    if (wire === 0) { let v; [v, i] = readVarint(buf, i); val = (f && (f.type === 'bool')) ? (v !== 0n) : v.toString(); }
    else if (wire === 2) {
      let len; [len, i] = readVarint(buf, i);
      const n = Number(len), raw = buf.subarray(i, i + n); i += n;
      if (f && f.type === 'message') { try { val = decode(f.typeName, raw); } catch (e) { val = { _raw: raw.toString('hex') }; } }
      else if (f && f.type === 'bytes') val = raw.toString('hex');
      else val = raw.toString('utf8');
    } else if (wire === 5) { val = String(buf.readUInt32LE(i)); i += 4; }
    else if (wire === 1) { val = buf.readBigUInt64LE(i).toString(); i += 8; }
    else break;
    if (!f) { (out._unknown = out._unknown || []).push({ num, wire, value: val }); continue; }
    if (f.type === 'message' && (f.label === 'repeated' || out[f.name] !== undefined)) {
      if (!Array.isArray(out[f.name])) out[f.name] = out[f.name] === undefined ? [] : [out[f.name]];
      out[f.name].push(val);
    } else if (f.label === 'repeated') {
      if (!Array.isArray(out[f.name])) out[f.name] = [];
      out[f.name].push(val);
    } else out[f.name] = val;
  }
  return out;
}

// ---------------------------------------------------------------- gRPC
function headersFor(extra) {
  const s = readJson(SESSION_FILE, {});
  return Object.assign({
    'content-type': 'application/grpc+proto',
    'te': 'trailers',
    'grpc-accept-encoding': 'identity,deflate,gzip',
    'user-agent': 'grpc-dotnet/2.0.0',
    'x-player-id': s.playerId || '',
    'x-player-credential': s.credential || '',
    'x-platform': 'android',
    'x-client-version': s.clientVersion || '1.0.2',
    'x-request-id': crypto.randomUUID(),
  }, s.masterVersion ? { 'x-master-version': s.masterVersion } : {},
     s.resourceVersion ? { 'x-resource-version': s.resourceVersion } : {},
     s.playerBid ? { 'x-player-bid': s.playerBid } : {}, extra || {});
}

function rawCall(methodPath, body, extraHeaders) {
  const http2 = require('http2');
  const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
  const frame = Buffer.concat([Buffer.from([0]), head, body]);
  const headers = headersFor(extraHeaders);
  return new Promise((resolve, reject) => {
    const client = http2.connect('https://' + HOST);
    let status = 0, resHeaders = {}, trailers = {};
    const chunks = [];
    const done = (err) => {
      try { client.close(); } catch (e) {}
      if (err) return reject(err);
      let msg = null, flag = 0;
      const raw = Buffer.concat(chunks);
      if (raw.length >= 5) {
        flag = raw[0];
        const len = raw.readUInt32BE(1);
        msg = raw.subarray(5, 5 + len);
        if (flag === 1) { try { msg = zlib.gunzipSync(msg); } catch (e) { /* 保留原样 */ } }
      } else if (raw.length) msg = raw;
      resolve({ status, headers: resHeaders, trailers, msg });
    };
    client.on('error', done);
    const req = client.request(Object.assign({ ':method': 'POST', ':path': methodPath, 'content-length': frame.length }, headers));
    req.on('response', (h) => { status = h[':status'] || 0; resHeaders = h; });
    req.on('trailers', (h) => { trailers = h; });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => done());
    req.on('error', done);
    req.setTimeout(30000, () => { req.close(); done(new Error('超时')); });
    req.end(frame);
  });
}

/** 调一个 RPC：body 传 {字段名: 值}，返回解析后的对象；gRPC 非 0 状态抛错 */
async function rpc(service, method, bodyObj, extraHeaders, noRetry) {
  const svc = SCHEMA.services[service];
  if (!svc) throw new Error('schema 里没有服务 ' + service);
  const m = (svc.methods || []).find((x) => x.name === method);
  if (!m) throw new Error('服务 ' + service + ' 没有方法 ' + method);
  const body = bodyObj ? encode(m.input, bodyObj) : Buffer.alloc(0);
  // Version discovery is public and must not inherit a stale client/master header.
  if (service === 'app.masterdata.MasterdataService' && method === 'Version') {
    extraHeaders = Object.assign({}, extraHeaders, {'x-client-version': undefined, 'x-master-version': undefined, 'x-resource-version': undefined});
  }
  let res = await rawCall('/' + service + '/' + method, body, extraHeaders);
  // This read-only profile endpoint accepts an optional client version. Keep the
  // existing authenticated credential; refresh master metadata, never relogin
  // merely because an old client version header is rejected.
  if (service === 'app.friend.FriendService' && method === 'FindByProfileID' &&
      /client update required|master version mismatch/i.test(decodeURIComponent(res.trailers['grpc-message'] || ''))) {
    const version = await rpc('app.masterdata.MasterdataService', 'Version', {}, {}, true);
    const session = readJson(SESSION_FILE, {});
    writeJson(SESSION_FILE, Object.assign({}, session, {masterVersion: version.version, resourceVersion: version.resource_version}));
    res = await rawCall('/' + service + '/' + method, body, Object.assign({}, extraHeaders, {
      'x-client-version': undefined, 'x-master-version': version.version, 'x-resource-version': version.resource_version,
    }));
  }
  const st = res.trailers['grpc-status'];
  const msg = decodeURIComponent(res.trailers['grpc-message'] || '');
  if (st && st !== '0') {
    // 会话过期/被踢：自动重登一次再试（凭证每次登录都会轮换）
    if (!noRetry && (st === '16' || /credential|auth|session|login|unauthor/i.test(msg))) {
      console.log('[on] 会话失效（' + st + ' ' + msg + '），自动重登…');
      await loginWithSdk();
      return rpc(service, method, bodyObj, extraHeaders, true);
    }
    const e = new Error('gRPC ' + st + ': ' + msg);
    e.grpcStatus = Number(st);
    throw e;
  }
  if (!res.msg || !res.msg.length) return null;
  return decode(m.output, res.msg);
}

// ---------------------------------------------------------------- B站 SDK：刷新 id_token
/**
 * 用抓包那份 cache.login 请求**原样重放**换一个新的 id_token（2 小时有效）。
 * 为什么能这么干：服务端只校验 sign 与参数是否匹配，**不校验 timestamp 是否新鲜**
 * （实测：换时间戳 → code -3 认证错误；原样重放 → code 0 + 新 id_token）。
 * 参数里的 access_key 有效期 30 天，所以这套能一直用到 access_key 过期为止。
 */
async function refreshSdkToken() {
  const body = (() => { try { return fs.readFileSync(SDK_REPLAY_FILE, 'utf8').trim(); } catch (e) { return ''; } })();
  if (!body) throw new Error('缺少 ' + SDK_REPLAY_FILE + '（抓包那份 cache.login 的表单原文）');
  const https = require('https');
  const u = new URL(SDK_HOST + '/gapi/client/cache.login');
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      host: u.hostname, path: u.pathname, method: 'POST', timeout: 30000,
      headers: {
        'user-agent': 'Mozilla/5.0 BSGameSDK',
        'api-version': '1',
        'one-sdk-ver': '1.25.0',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
      },
    }, (r) => {
      const c = [];
      r.on('data', (d) => c.push(d));
      r.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('SDK 刷新超时')));
    req.on('error', reject);
    req.end(body);
  });
  let j;
  try { j = JSON.parse(res); } catch (e) { throw new Error('SDK 返回不是 JSON：' + res.slice(0, 120)); }
  if (j.code !== 0 || !j.data || !j.data.id_token) throw new Error('SDK 刷新失败 code=' + j.code + ' ' + j.message);
  const sdk = readJson(SDK_FILE, {}) || {};
  const jwt = j.data.id_token.split('.')[1];
  const pad = (4 - (jwt.length % 4)) % 4;          // 注意：JS 里 -len % 4 是负数（Python 才是正数）
  const payload = JSON.parse(Buffer.from(jwt + '='.repeat(pad), 'base64').toString('utf8'));
  const next = Object.assign({}, sdk, {
    sdkUid: String(j.data.uid || sdk.sdkUid || ''),
    mid: String(j.data.mid || sdk.mid || ''),
    sdkAccessToken: j.data.access_key || sdk.sdkAccessToken,
    idToken: j.data.id_token,
    idTokenExp: payload.exp,
    accessKeyExp: j.data.expires ? Math.floor(j.data.expires / 1000) : null,
    refreshedAt: Date.now(),
  });
  writeJson(SDK_FILE, next);
  return next;
}

/** app_ver / device 等参数：cache.login 的表单里就有，直接从原文抽，不用另配 */
function sdkFormField(name) {
  const body = (() => { try { return fs.readFileSync(SDK_REPLAY_FILE, 'utf8'); } catch (e) { return ''; } })();
  const m = new RegExp('[&?]' + name + '=([^&\\s]*)').exec(body);
  return m ? decodeURIComponent(m[1]) : '';
}

// ---------------------------------------------------------------- 便捷命令
/** 完整链：SDK 刷新 id_token → PlayerLogin → 轮换游戏会话 */
async function loginWithSdk() {
  let sdk = readJson(SDK_FILE, {}) || {};
  const now = Math.floor(Date.now() / 1000);
  // id_token 只剩不到 5 分钟就先刷一张新的
  if (!sdk.idToken || !sdk.idTokenExp || sdk.idTokenExp - now < 300) sdk = await refreshSdkToken();
  const req = {
    sdkUid: String(sdk.sdkUid),
    sdkAccessToken: sdk.sdkAccessToken,
    platform: sdk.platform === undefined ? 0 : sdk.platform,
    deviceModel: sdk.deviceModel || sdkFormField('model') || 'OPPO PCHM30',
    operatingSystem: sdk.operatingSystem || 'Android OS 11 / API-30',
    clientVersion: sdk.clientVersion || sdkFormField('app_ver') || '1.0.2',
    clientPackage: sdk.clientPackage || 'com.bilibili.sirius',
    globalChannelId: sdk.globalChannelId || 2005,
    brandId: sdk.brandId || 5,
    areaId: sdk.areaId || 6,
    idToken: sdk.idToken,
    uuid: { identifier: sdk.uuid || sdkFormField('udid') || crypto.randomBytes(16).toString('hex'), adId: '' },
    initialDataGroup: '',
  };
  const r = await rpc('app.playerlogin.PlayerLoginService', 'PlayerLogin', req,
    sdk.sdkUid ? { 'x-player-bid': String(sdk.sdkUid) } : null, true);
  if (!r || !r.credential) throw new Error('登录响应没有 credential：' + JSON.stringify(r));
  const sess = readJson(SESSION_FILE, {});
  const next = Object.assign({}, sess, {
    playerId: r.credential.id || sess.playerId,
    credential: r.credential.credential,
    profileId: r.credential.profileId ? String(r.credential.profileId) : sess.profileId,
    playerBid: String(sdk.sdkUid),
    clientVersion: req.clientVersion,
    cpServerId: r.cpServerId,
    updatedAt: Date.now(),
  });
  writeJson(SESSION_FILE, next);
  return next;
}

/** 依赖版本号：Masterdata.Version（好友那些接口会带 x-master-version / x-resource-version） */
async function refreshVersions() {
  const r = await rpc('app.masterdata.MasterdataService', 'Version', null);
  if (!r) return null;
  const sess = readJson(SESSION_FILE, {});
  const next = Object.assign({}, sess, {
    masterVersion: r.version || sess.masterVersion,
    resourceVersion: r.resourceVersion || sess.resourceVersion,
  });
  writeJson(SESSION_FILE, next);
  return next;
}

module.exports = { readJson, writeJson, rpc, encode, decode, loginWithSdk, refreshSdkToken, refreshVersions,
  SESSION_FILE, SDK_FILE, SDK_REPLAY_FILE, SCHEMA_FILE, ON_DIR };

// ---------------------------------------------------------------- CLI
if (require.main === module) {
  (async () => {
    const [cmd, a1, a2, a3] = process.argv.slice(2);
    const show = (x) => console.log(JSON.stringify(x, null, 1));
    if (cmd === 'friend') {
      const r = await rpc('app.friend.FriendService', 'FindByProfileID', { player_profile_id: a1 });
      show(r);
    } else if (cmd === 'me') {
      const r = await rpc('app.player.PlayerService', 'GetPlayerData', {});
      show(r);
    } else if (cmd === 'serverlist') {
      show(await rpc('app.playerlogin.PlayerLoginService', 'GetServerList', {}));
    } else if (cmd === 'switches') {
      show(await rpc('app.feature_switch.FeatureSwitchService', 'Get', {}));
    } else if (cmd === 'login') {
      const s = await loginWithSdk();
      console.log('游戏会话已轮换：playerId=' + String(s.playerId).slice(0, 8) + '…  credential='
        + String(s.credential).slice(0, 8) + '…');
      await refreshVersions();
      console.log('版本号已刷新');
    } else if (cmd === 'sdk') {
      const s = await refreshSdkToken();
      const left = Math.round((s.idTokenExp * 1000 - Date.now()) / 60000);
      console.log('已刷新 id_token（剩 ' + left + ' 分钟）  access_key 到期 '
        + new Date(s.accessKeyExp * 1000).toISOString().slice(0, 10));
    } else if (cmd === 'versions') {
      show(await refreshVersions());
    } else if (cmd === 'schema') {
      const m = SCHEMA.messages[a1];
      if (!m) { console.log('没有这个消息。可用示例：', Object.keys(SCHEMA.messages).slice(0, 12).join(', ')); return; }
      console.log(a1);
      for (const f of m.fields) console.log(`  #${String(f.num).padEnd(3)} ${f.label.padEnd(9)} ${f.type.padEnd(9)} ${f.name} ${f.typeName || ''}`);
    } else if (cmd === 'services') {
      for (const s of Object.keys(SCHEMA.services).sort()) {
        console.log(s);
        for (const m of SCHEMA.services[s].methods) console.log(`   ${m.name.padEnd(28)} ${m.input} -> ${m.output}`);
      }
    } else if (cmd === 'call') {
      const body = a3 ? JSON.parse(a3) : {};
      show(await rpc(a1, a2, body));
    } else {
      console.log('用法: node tools/on_player.js friend <profileId> | me | serverlist | switches | login | versions | call <Svc> <Method> \'<json>\' | schema <Msg> | services');
    }
  })().catch((e) => { console.error('失败:', e.message); process.exit(1); });
}
