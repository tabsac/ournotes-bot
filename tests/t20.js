const WebSocket = require('ws');
// 颜色简称筛选：/on查卡 红　/on查卡 MyGO 蓝 SSR　/on查卡 紫色
// QQ 号来源：secrets.json（仓库副本）→ 环境变量 ON_SELF_ID / ON_ADMIN → 占位值。不写真实号码。
let sec = null;
try { sec = require('../lib/secrets.js'); } catch (e) { /* 线上部署没有 lib/，走环境变量 */ }
const SELF = Number((sec && sec.get('selfId', 'ON_SELF_ID')) || process.env.ON_SELF_ID || 10000);
const ADMIN = Number((sec && sec.get('admin', 'ON_ADMIN')) || process.env.ON_ADMIN || 0);
const ws = new WebSocket('ws://127.0.0.1:6700');
const sends = ['/on查卡 红', '/on查卡 MyGO 蓝 SSR', '/on查卡 紫'];
ws.on('open', () => {
  sends.forEach((t, i) => setTimeout(() => {
    console.log('\n>>> ' + t);
    ws.send(JSON.stringify({
      post_type: 'message', message_type: 'group', group_id: 999999999,
      user_id: 44000060 + i, self_id: SELF, raw_message: t,
      message: [{ type: 'text', data: { text: t } }], font: 0,
      sender: { user_id: 44000060 + i, nickname: 't', card: '', role: 'member' },
      time: Math.floor(Date.now() / 1000), message_id: 669400 + i,
    }));
  }, 400 + i * 9000));
});
ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf('999999999') < 0) return;
  let out = s;
  try {
    const j = JSON.parse(s);
    const m = j.params && j.params.message;
    if (typeof m === 'string') out = m;
    else if (m) out = JSON.stringify(m);
  } catch (e) { /* 原样 */ }
  console.log('<<< ' + out.slice(0, 500));
});
setTimeout(() => process.exit(0), 30000);
