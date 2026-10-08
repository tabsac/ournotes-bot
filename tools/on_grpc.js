// Our Notes(邦邦新游) gRPC 网关客户端 —— 用抓到的登录态调好友/资料接口
//   纯 Node，无第三方依赖；HTTP/2（和客户端一致，能拿到 grpc-status trailer）+ gzip 解帧
// 用法：
//   node tools/on_grpc.js ping                      # 探活（免登录方法 FeatureSwitch.Get）
//   node tools/on_grpc.js friend <profileId>        # Friend.FindByProfileID
//   node tools/on_grpc.js serverlist                # PlayerLogin.GetServerList
//   node tools/on_grpc.js me                        # Player.GetPlayerData
//   node tools/on_grpc.js raw <svc/m> <hex>         # 任意方法 + 裸 body(hex)
//   ON_HTTP1=1 环境变量可退回 HTTP/1.1（拿不到 trailer，仅排障用）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const HOST = 'l14-prod-hk-all-gs-sirius.gamerfusiontech.com';
const SESSION_FILE = process.env.ON_SESSION || path.join(__dirname, '..', 'data', 'on', 'session.json');

function loadSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch (e) { return {}; }
}

// ---------------------------------------------------------------- protobuf
function varint(n) {
  const out = [];
  let v = BigInt(n);
  while (v > 127n) { out.push(Number((v & 127n) | 128n)); v >>= 7n; }
  out.push(Number(v));
  return Buffer.from(out);
}
const tag = (field, wire) => varint((BigInt(field) << 3n) | BigInt(wire));
const pbString = (field, s) => { const b = Buffer.from(String(s), 'utf8'); return Buffer.concat([tag(field, 2), varint(b.length), b]); };

function pbDecode(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let shift = 0, key = 0n;
    while (i < buf.length) { const b = buf[i++]; key |= BigInt(b & 0x7f) << BigInt(shift); shift += 7; if (!(b & 0x80)) break; }
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (wire === 0) {
      let v = 0n, s = 0n;
      while (i < buf.length) { const b = buf[i++]; v |= BigInt(b & 0x7f) << s; s += 7n; if (!(b & 0x80)) break; }
      out.push({ field, wire, value: v.toString() });
    } else if (wire === 2) {
      let len = 0n, s = 0n;
      while (i < buf.length) { const b = buf[i++]; len |= BigInt(b & 0x7f) << s; s += 7n; if (!(b & 0x80)) break; }
      const n = Number(len);
      out.push({ field, wire, bytes: buf.subarray(i, i + n) }); i += n;
    } else if (wire === 5) { out.push({ field, wire, value: buf.readUInt32LE(i).toString() }); i += 4; }
    else if (wire === 1) { out.push({ field, wire, value: buf.readBigUInt64LE(i).toString() }); i += 8; }
    else { out.push({ field, wire, error: 'wire ' + wire }); break; }
  }
  return out;
}
function looksLikeText(b) {
  if (!b.length) return false;
  for (const c of b) if (c < 0x09 || (c > 0x0d && c < 0x20)) return false;
  return true;
}
function tryNested(data) {
  if (!data || !data.length || data.length > 8192 || looksLikeText(data)) return null;
  try { const d = pbDecode(data); return (d.length && !d.some((x) => x.error)) ? d : null; } catch (e) { return null; }
}
function dumpFields(msg, indent = '  ') {
  const out = [];
  for (const f of pbDecode(msg)) {
    if (f.wire === 2) {
      const nested = tryNested(f.bytes);
      if (nested) { out.push(`${indent}#${f.field} (msg) {`); out.push(...dumpFields(f.bytes, indent + '  ')); out.push(`${indent}}`); }
      else if (looksLikeText(f.bytes)) out.push(`${indent}#${f.field} = "${f.bytes.toString('utf8')}"`);
      else out.push(`${indent}#${f.field} = <${f.bytes.length}B> ${f.bytes.subarray(0, 40).toString('hex')}`);
    } else out.push(`${indent}#${f.field} = ${f.value}`);
  }
  return out;
}

// ---------------------------------------------------------------- 调用
function headersFor(extra) {
  const s = loadSession();
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
  },
    s.masterVersion ? { 'x-master-version': s.masterVersion } : {},
    s.resourceVersion ? { 'x-resource-version': s.resourceVersion } : {},
    s.playerBid ? { 'x-player-bid': s.playerBid } : {},
    extra || {});
}
function frameOf(body) {
  const l = Buffer.alloc(4); l.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from([0]), l, body]);
}

/** HTTP/2（默认）：能拿到 grpc-status / grpc-message trailer */
function callH2(methodPath, body) {
  const http2 = require('http2');
  const frame = frameOf(body);
  const headers = headersFor();
  return new Promise((resolve, reject) => {
    const client = http2.connect('https://' + HOST);
    let status = 0, resHeaders = {}, trail = {}, chunks = [];
    const done = (err) => { try { client.close(); } catch (e) {} err ? reject(err) : resolve({ status, headers: resHeaders, trailers: trail, body: Buffer.concat(chunks) }); };
    client.on('error', done);
    const req = client.request(Object.assign({ ':method': 'POST', ':path': methodPath, 'content-length': frame.length }, headers));
    req.on('response', (h, flags) => { status = h[':status'] || 0; resHeaders = h; if (flags & http2.constants.NGHTTP2_FLAG_END_STREAM) { /* no body */ } });
    req.on('trailers', (h) => { trail = h; });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => done());
    req.on('error', done);
    req.setTimeout(30000, () => { req.close(); done(new Error('超时')); });
    req.end(frame);
  });
}
/** HTTP/1.1 退回（拿不到 trailer） */
function callH1(methodPath, body) {
  const https = require('https');
  const frame = frameOf(body);
  return new Promise((resolve, reject) => {
    const req = https.request({ host: HOST, port: 443, path: methodPath, method: 'POST',
      headers: Object.assign({}, headersFor(), { 'content-length': frame.length }), timeout: 30000 },
      (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, trailers: {}, body: Buffer.concat(c) })); });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.end(frame);
  });
}

(async () => {
  const [cmd, a1, a2] = process.argv.slice(2);
  let method = '', body = Buffer.alloc(0);
  if (cmd === 'ping') method = '/app.feature_switch.FeatureSwitchService/Get';
  else if (cmd === 'serverlist') method = '/app.playerlogin.PlayerLoginService/GetServerList';
  else if (cmd === 'me') method = '/app.player.PlayerService/GetPlayerData';
  else if (cmd === 'friend') { method = '/app.friend.FriendService/FindByProfileID'; body = pbString(1, a1); }
  else if (cmd === 'raw') { method = '/' + String(a1 || '').replace(/^\//, ''); body = Buffer.from(String(a2 || ''), 'hex'); }
  else { console.log('用法: node tools/on_grpc.js ping|serverlist|me|friend <id>|raw <svc/m> <hex>'); process.exit(1); }

  const s = loadSession();
  console.log('session:', (s.playerId || '(无)').slice(0, 8) + '…', 'credential:', (s.credential || '(无)').slice(0, 8) + '…',
    '| 传输:', process.env.ON_HTTP1 ? 'HTTP/1.1' : 'HTTP/2');
  console.log('→', method, body.length ? 'body ' + body.toString('hex') : '(空 body)');
  const r = process.env.ON_HTTP1 ? await callH1(method, body) : await callH2(method, body);
  console.log('HTTP', r.status, '| grpc-status:', r.trailers['grpc-status'] ?? '(无 trailer)',
    r.trailers['grpc-message'] ? '| grpc-message: ' + decodeURIComponent(r.trailers['grpc-message']) : '');
  const keep = ['content-type', 'grpc-encoding', 'x-server-time', 'server', 'date', 'x-error-code', 'x-error-message'];
  console.log('头:', keep.filter((k) => r.headers[k] !== undefined).map((k) => `${k}=${r.headers[k]}`).join('  '));
  if (!r.body.length) { console.log('响应体 0 字节'); return; }
  let msg = r.body, flag = 0;
  if (r.body.length >= 5) { flag = r.body[0]; const len = r.body.readUInt32BE(1); msg = r.body.subarray(5, 5 + len); }
  console.log(`帧 flag=${flag}(1=压缩) 体 ${msg.length}B`);
  if (flag === 1) {
    try { msg = zlib.gunzipSync(msg); console.log('解压后', msg.length, 'B'); }
    catch (e) { console.log('解压失败:', e.message); return; }
  }
  console.log(dumpFields(msg).join('\n'));
})().catch((e) => { console.error('调用失败:', e.message); process.exit(1); });
