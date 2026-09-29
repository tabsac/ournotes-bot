'use strict';
// 逐个校验「只有 bundle 路线」的 cue sheet：下载 bundle → 取出内嵌 ACB → 解一条实际用到的 cue。
//   node tools/verify_voicepacks.js [--all]      默认只查 raw 缺失的那批
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ON_DIR = process.env.ON_DIR || '/home/admin/bot/data/on';
const ROOT = path.resolve(__dirname, '..');
const OUT = '/tmp/on_cri';
const songs = JSON.parse(fs.readFileSync(path.join(ON_DIR, 'songs.json'), 'utf8'));
const inv = JSON.parse(fs.readFileSync(path.join(ON_DIR, 'bundle_inventory.json'), 'utf8')).names;
const cri = JSON.parse(fs.readFileSync(path.join(ON_DIR, 'cri_url.json'), 'utf8'));
const rd = (n) => JSON.parse(fs.readFileSync(path.join(ON_DIR, 'master', 'Master' + n + '.json'), 'utf8'))._allData;
const sound = new Map(rd('Sound').map((r) => [r._id, r]));
const sheetName = new Map(rd('SoundCueSheet').map((r) => [r._id, r._cueSheetName]));

// sheet → 该 sheet 下实际会被 /on听 用到的 cue（按 master 顺序第一条）
const want = new Map();
for (const [table, key] of [['CharacterVoice', '_soundId'], ['LiveStartCharacterVoice', '_voiceSoundId'], ['Talk', '_voiceSoundId']]) {
  for (const r of rd(table)) {
    const s = sound.get(r[key]);
    if (!s) continue;
    const sh = sheetName.get(s._soundCueSheetID);
    if (sh && !want.has(sh)) want.set(sh, { cue: s._cueName, soundId: r[key] });
  }
}
const bundleOf = (sheet) => {
  const pre = 'cri_assets_cri_sound_' + sheet.toLowerCase() + '_';
  return inv.find((n) => n.startsWith(pre) && /^[0-9a-f]{32}\.bundle$/.test(n.slice(pre.length))) || null;
};

const argAll = process.argv.includes('--all');
const rows = [...want.entries()]
  .filter(([sh]) => argAll || !(cri[sh.toLowerCase()] || []).length)
  .sort((a, b) => a[0].localeCompare(b[0]));

const { Bundle } = require(path.join(ON_DIR, 'unitysrc', 'bundle.js'));
const { acbFromBundle } = require(path.join(ROOT, 'tools', 'acb.js'));
fs.mkdirSync(OUT, { recursive: true });

let ok = 0;
const bad = [];
for (const [sheet, info] of rows) {
  const bn = bundleOf(sheet);
  if (!bn) { bad.push([sheet, '没有 bundle']); console.log(`✗ ${sheet} 没有 bundle`); continue; }
  const bfile = path.join(OUT, bn);
  try {
    if (!fs.existsSync(bfile) || fs.statSync(bfile).size < 102400) {
      execFileSync('curl', ['-s', '-o', bfile, '-w', '%{http_code}', '-u', songs.auth, '-m', '300',
        songs.cdn + '/' + bn], { stdio: ['ignore', 'ignore', 'ignore'] });
    }
    const bytes = acbFromBundle(Bundle.load(bfile));
    if (!bytes || bytes.length < 10240) throw new Error('包里没有 ACB');
    const acb = path.join(OUT, sheet + '.acb');
    fs.writeFileSync(acb, bytes);
    const wav = path.join(OUT, info.soundId + '.wav');
    execFileSync('python3', [path.join(ROOT, 'tools', 'acb_cues.py'), '--acb', acb, '--select', info.cue, '--wav', wav],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    const chk = execFileSync('python3', [path.join(ROOT, 'tools', 'acb_cues.py'), '--acb', acb, '--select', info.cue], { encoding: 'utf8' });
    const m = /cue 数 = (\d+)/.exec(chk);
    const wavKB = Math.round(fs.statSync(wav).size / 1024);
    fs.unlinkSync(wav);
    ok++;
    console.log(`✓ ${sheet.padEnd(16)} bundle ${Math.round(fs.statSync(bfile).size / 1024)} KB → ACB ${Math.round(bytes.length / 1024)} KB, cue ${m ? m[1] : '?'} 条, 试解 ${info.cue} → ${wavKB} KB wav`);
  } catch (e) {
    bad.push([sheet, String(e.message || e).slice(0, 120)]);
    console.log(`✗ ${sheet} ${String(e.message || e).slice(0, 120)}`);
  } finally {
    try { if (fs.existsSync(bfile)) fs.unlinkSync(bfile); } catch (e) {}
  }
}
console.log(`\n合计 ${rows.length} 个 sheet：成功 ${ok}，失败 ${bad.length}`);
if (bad.length) { for (const [s, why] of bad) console.log('  失败:', s, why); process.exitCode = 1; }
