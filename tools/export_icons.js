'use strict';
// 导出 atlas 里的 medal/badge 图标：名字要等 exportObject 解出来才知道，所以先全导再看名字
const fs = require('fs');
const path = require('path');
const ON = '/home/admin/bot/data/on';
const BUNDLE = process.argv[2] || '/tmp/item_assets_all_de742e86cdf93301fd6a66dbafe82113.bundle';
const OUT = process.argv[3] || '/tmp/medals';
const FILTER = new RegExp(process.env.ON_ICON_FILTER || 'medal|badge|star|seal', 'i');
fs.mkdirSync(OUT, { recursive: true });

const { Bundle } = require(path.join(ON, 'unitysrc', 'bundle.js'));
const { exportObject } = require(path.join(ON, 'unitysrc', 'exporter.js'));

(async () => {
  const b = Bundle.load(BUNDLE);
  const sprites = b.listObjects().filter((e) => e.className === 'Sprite');
  console.log('Sprite 共 ' + sprites.length + ' 个，开始导出…');
  const names = [];
  let saved = 0, failed = 0;
  for (const e of sprites) {
    try {
      const r = await exportObject(b, e);
      if (!r || !r.data) { failed++; continue; }
      const nm = r.name || 'unnamed';
      names.push(nm);
      if (FILTER.test(nm)) {
        const f = path.join(OUT, nm.replace(/[^\w.\-]/g, '_') + (r.ext || '.png'));
        fs.writeFileSync(f, r.data);
        saved++;
        if (saved <= 15) console.log('   ✓ ' + nm + '  ' + (r.meta ? JSON.stringify(r.meta) : '') + ' → ' + f);
      }
    } catch (err) { failed++; }
  }
  console.log('\n导出成功(medal/badge) ' + saved + ' 张，失败 ' + failed + ' 个');
  console.log('名字样例（前 30）:');
  names.slice(0, 30).forEach((n) => console.log('   ' + n));
  fs.writeFileSync('/tmp/medals_names.txt', names.join('\n'));
  console.log('\n全部名字已写到 /tmp/medals_names.txt（' + names.length + ' 行）');
})().catch((e) => { console.error('失败: ' + (e && e.message ? e.message : e)); process.exit(1); });
