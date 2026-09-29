const WebSocket = require('ws');
// 权限与 help 检查：普通用户碰管理员指令应被拒；help 里不应出现管理员指令
const ws = new WebSocket('ws://127.0.0.1:6700');
// QQ 号来源：secrets.json（仓库副本）→ 环境变量 ON_SELF_ID / ON_ADMIN → 占位值。不写真实号码。
let sec = null;
try { sec = require('../lib/secrets.js'); } catch (e) { /* 线上部署没有 lib/，走环境变量 */ }
const SELF = Number((sec && sec.get('selfId', 'ON_SELF_ID')) || process.env.ON_SELF_ID || 10000);
const ADMIN = Number((sec && sec.get('admin', 'ON_ADMIN')) || process.env.ON_ADMIN || 0);
const USER = 44000099;
const steps = [
  [USER, '/on待审核'],
  [USER, '/on通过 1'],
  [USER, '/on阻止 1'],
  [ADMIN, '/onhelp 更新'],
  [ADMIN, '/onhelp'],
];
ws.on('open', () => {
  steps.forEach(([uid, t], i) => setTimeout(() => {
    console.log(`\n>>> [${uid === ADMIN ? '管理员' : '普通用户'}] ${t}`);
    ws.send(JSON.stringify({
      post_type: 'message', message_type: 'group', group_id: 999999999,
      user_id: uid, self_id: SELF, raw_message: t,
      message: [{ type: 'text', data: { text: t } }], font: 0,
      sender: { user_id: uid, nickname: 't', card: '', role: uid === ADMIN ? 'owner' : 'member' },
      time: Math.floor(Date.now() / 1000), message_id: 669600 + i,
    }));
  }, 500 + i * 1500));
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
  console.log('<<< ' + out.slice(0, 900));
});
setTimeout(() => process.exit(0), 14000);
