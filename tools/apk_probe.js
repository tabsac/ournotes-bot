#!/usr/bin/env node
/**
 * 官网 APK 地址探测器
 *   官网首页(5KB) -> 静态 JS(带内容 hash) -> 正则取出官方 APK 直链
 * 用法: node apk_probe.js [--json]   退出码 0=与记录一致, 1=有变化(或首次)
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const SITE = 'https://bdon.biligames.com/';
const SWITCH = 'https://le1-activity.biligames.com/x/api/sirius/download/switch';
const REC = '/home/admin/bot/data/on/apk.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0 Safari/537.36';

const getOnce = (url) => new Promise((res, rej) => {
  https.get(url, { headers: { 'User-Agent': UA }, timeout: 20000, family: 4 }, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      return get(new URL(r.headers.location, url).href).then(res, rej);
    }
    const c = []; r.on('data', d => c.push(d)); r.on('end', () => res({ code: r.statusCode, body: Buffer.concat(c).toString('utf8') }));
  }).on('error', rej);
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const get = async (url, tries = 3) => {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await getOnce(url); }
    catch (e) { last = e; if (i < tries - 1) await sleep(1200 * (i + 1)); }
  }
  throw last;
};

(async () => {
  const html = (await get(SITE)).body;
  console.error('  [info] 首页 ' + html.length + 'B, js 引用 ' + [...new Set([...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map(m => m[1]))].length + ' 个');
  const local = {}; try { Object.assign(local, JSON.parse(fs.readFileSync(REC, 'utf8'))); } catch (e) {}
  const jsPaths0 = [...new Set([...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map(m => m[1]))];
  const stamp = jsPaths0.map(x => x.split('/').pop()).sort().join(',');
  if (!process.argv.includes('--full') && local.jsStamp === stamp && local.apk) {
    console.error('  [info] JS 文件名未变 (' + stamp + ')，跳过重新拉取');
    console.log('官网 JS 数: ' + jsPaths0.length + ' | 来源: ' + local.apkSource);
    console.log('官方 APK : ' + local.apk);
    console.log('版本/时间: ' + local.version + ' ' + local.buildTime);
    console.log('与记录对比: 一致（本次未重新解析）');
    process.exit(0);
  }
  const jsPaths = [...new Set([...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map(m => m[1]))]
    .map(p => p.startsWith('//') ? 'https:' + p : (p.startsWith('http') ? p : new URL(p, SITE).href));
  let apk = null, ver = null, ts = null, src = null;
  for (const u of jsPaths) {
    let js = '';
    try { js = (await get(u)).body; } catch (e) { console.error('  [warn] 拉取失败 ' + u + ' : ' + e.message); continue; }
    const m = js.match(/https:\/\/[a-z0-9.\-]*biligames\.com\/[^"'\s]*BanGDreamOurNotes_[^"'\s]*\.apk/);
    console.error('  [info] ' + u.split('/').pop() + ' ' + js.length + 'B ' + (m ? '命中 APK 直链' : '无 APK 直链'));
    if (m) { apk = m[0]; src = u; break; }
  }
  let sw = null;
  try { sw = JSON.parse((await get(SWITCH)).body); } catch (e) { sw = { error: String(e.message) }; }
  if (apk) {
    const mm = apk.match(/BanGDreamOurNotes_([^_]+)_(\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2})\.apk/);
    if (mm) { ver = mm[1]; ts = mm[2]; }
  }
  const out = { jsStamp: stamp, checkedAt: new Date().toISOString(), site: SITE, jsCount: jsPaths.length, apkSource: src, apk, version: ver, buildTime: ts, switch: sw };
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(REC, 'utf8')); } catch (e) {}
  const changed = !prev || prev.apk !== apk;
  out.changed = changed;
  fs.mkdirSync(path.dirname(REC), { recursive: true });
  fs.writeFileSync(REC, JSON.stringify(out, null, 2));
  if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    console.log('官网 JS 数:', jsPaths.length, '| 命中来源:', src);
    console.log('官方 APK :', apk);
    console.log('版本/时间:', ver, ts);
    console.log('下载开关 :', JSON.stringify(sw));
    console.log('与记录对比:', changed ? '有变化（首次或有新版）' : '一致');
  }
  process.exit(changed ? 1 : 0);
})();
