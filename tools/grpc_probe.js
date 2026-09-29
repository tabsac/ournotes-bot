'use strict';
// Probe the game's gRPC gateway without logging in.
//
//   node grpc_probe.js test                 -> a few discriminating probes
//   node grpc_probe.js sweep <names.json>   -> service x method cross product
//
// Every probe is an unauthenticated POST of a 5-byte EMPTY grpc frame
// (00 00 00 00 00) with content-type application/grpc+proto -- exactly what the
// public Version call does. Nothing is written to the account.
const fs = require('fs');
const HOST = 'l14-prod-hk-all-gs-sirius.gamerfusiontech.com';
const EMPTY = Buffer.from([0, 0, 0, 0, 0]);

async function probe(path, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch('https://' + HOST + path, {
      method: 'POST',
      headers: { 'content-type': 'application/grpc+proto', 'grpc-accept-encoding': 'identity,deflate,gzip' },
      body: EMPTY,
      signal: ac.signal,
    });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, bytes: buf.length, head: buf.subarray(0, 40).toString('hex') };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message.slice(0, 80) };
  } finally {
    clearTimeout(t);
  }
}

const show = (p, r) => console.log('  %-72s %s', p, JSON.stringify(r));

(async () => {
  const mode = process.argv[2] || 'test';

  if (mode === 'test') {
    const cases = [
      '/app.masterdata.MasterdataService/Version',            // known good
      '/app.masterdata.MasterdataService/NoSuchMethod123',    // known service, bogus method
      '/app.nosuch.Service/Nope',                             // bogus service
      '/app.nosuch.NoSuchService/Version',                    // bogus service, real method
      '/app.player.PlayerService/GetPlayer',                  // guess
      '/app.player.PlayerService/Get',                        // guess
      '/app.friend.FriendService/GetFriendList',              // guess
      '/app.home.HomeService/Get',                            // guess
      '/app.profilecard.ProfileCardService/Get',              // guess
    ];
    console.log('== discriminating probes ==');
    for (const p of cases) show(p, await probe(p));
    return;
  }

  if (mode === 'sweep') {
    const names = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const services = names.services, methods = names.methods;
    const CONC = Number(process.argv[4] || 16);
    const targets = [];
    for (const s of services) for (const m of methods) targets.push('/' + s + '/' + m);
    console.log('sweep %d services x %d methods = %d probes (conc %d)', services.length, methods.length, targets.length, CONC);

    const hits = [];
    let done = 0, i = 0;
    async function worker() {
      while (i < targets.length) {
        const path = targets[i++];
        const r = await probe(path);
        done++;
        if (r.status && r.status !== 404) {
          hits.push({ path, ...r });
          console.log('HIT  ' + path + '  ' + JSON.stringify(r));
        }
        if (done % 500 === 0) console.log('  ...' + done + '/' + targets.length + '  hits=' + hits.length);
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    fs.writeFileSync('/tmp/grpc_hits.json', JSON.stringify(hits, null, 1));
    console.log('\nDONE  %d probes, %d non-404 -> /tmp/grpc_hits.json', done, hits.length);
    return;
  }

  console.error('usage: node grpc_probe.js test|sweep <names.json> [concurrency]');
  process.exitCode = 2;
})();
