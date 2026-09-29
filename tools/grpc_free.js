'use strict';
// Fetch + decode the gRPC methods that answer WITHOUT a login.
const zlib = require('zlib');
const HOST = 'l14-prod-hk-all-gs-sirius.gamerfusiontech.com';
const EMPTY = Buffer.from([0, 0, 0, 0, 0]);

const TARGETS = [
  '/app.masterdata.MasterdataService/Version',
  '/app.feature_switch.FeatureSwitchService/Get',
  '/app.external_payments.ExternalPaymentsService/Nop',
];

function protoDump(buf, indent = '') {
  let i = 0;
  while (i < buf.length) {
    let tag = 0, shift = 0;
    while (i < buf.length) { const b = buf[i++]; tag |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; }
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 0) {
      let v = 0, s = 0;
      while (i < buf.length) { const b = buf[i++]; v |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) break; }
      console.log(indent + 'field ' + field + ' (varint) = ' + v);
    } else if (wire === 2) {
      let len = 0, s = 0;
      while (i < buf.length) { const b = buf[i++]; len |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) break; }
      const sub = buf.subarray(i, i + len); i += len;
      const asText = sub.toString('utf8');
      const printable = /^[\x20-\x7e\u00a0-\uffff]*$/.test(asText) && asText.length > 0;
      console.log(indent + 'field ' + field + ' (len ' + len + ') = ' +
        (printable ? JSON.stringify(asText) : sub.toString('hex')));
      if (!printable && len > 2 && len < 400) { try { protoDump(sub, indent + '    '); } catch (e) {} }
    } else if (wire === 5) { console.log(indent + 'field ' + field + ' (fixed32) = ' + buf.readUInt32LE(i)); i += 4; }
    else if (wire === 1) { console.log(indent + 'field ' + field + ' (fixed64)'); i += 8; }
    else { console.log(indent + 'field ' + field + ' wire ' + wire + ' (stop)'); break; }
  }
}

(async () => {
  for (const p of TARGETS) {
    const r = await fetch('https://' + HOST + p, {
      method: 'POST', headers: { 'content-type': 'application/grpc+proto' }, body: EMPTY,
    });
    const b = Buffer.from(await r.arrayBuffer());
    console.log('\n=== ' + p + '   http=' + r.status + '  ' + b.length + ' B ===');
    if (!b.length) { console.log('   (empty body)'); continue; }
    const flag = b[0], len = b.readUInt32BE(1);
    let payload = b.subarray(5, 5 + len);
    console.log('   grpc frame: compressed=' + flag + ' len=' + len);
    if (flag === 1) { payload = zlib.gunzipSync(payload); console.log('   gunzip -> ' + payload.length + ' B'); }
    console.log('   hex: ' + payload.subarray(0, 120).toString('hex'));
    protoDump(payload, '   ');
  }
})().catch((e) => { console.error('FATAL ' + e.stack); process.exitCode = 1; });
