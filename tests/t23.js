const WebSocket = require('ws');
// 管理员不吃冷却 + /待审核 /通过 /阻止 不带 on 也能用
// QQ 号来源：secrets.json（仓库副本）→ 环境变量 ON_SELF_ID / ON_ADMIN → 占位值。不写真实号码。
let sec = null;
try { sec = require('../lib/secrets.js'); } catch (e) { /* 线上部署没有 lib/，走环境变量 */ }
const SELF = Number((sec && sec.get('selfId', 'ON_SELF_ID')) || process.env.ON_SELF_ID || 10000);
const ADMIN = Number((sec && sec.get('admin', 'ON_ADMIN')) || process.env.ON_ADMIN || 0);

const ws = new WebSocket('ws://127.0.0.1:6700');
// [谁, 内容, 距上一条的毫秒数]——刻意挤在 1 秒内，普通用户会被短冷却/长冷却挡掉
const steps = [
  [ADMIN, '/待审核', 400],
  [ADMIN, '/通过 1', 300],
  [ADMIN, '/阻止 1', 300],
  [ADMIN, '/on待审核', 300],
  [ADMIN, '/待审核', 300],
  [ADMIN, '/待审核', 300],
  [ADMIN, '/待审核', 300],
  [44000077, '/待审核', 600],
];
let n = 0;
ws.on('open', () => {
  let t = 0;
  steps.forEach(([uid, text, gap], i) => {
    t += gap;
    setTimeout(() => {
      n++;
      console.log(`\n>>> #${n} [${uid === ADMIN ? '管理员' : '普通用户'}] ${text}`);
      ws.send(JSON.stringify({
        post_type: 'message', message_type: 'group', group_id: 999999999,
        user_id: uid, self_id: SELF, raw_message: text,
        message: [{ type: 'text', data: { text } }], font: 0,
        sender: { user_id: uid, nickname: 't', card: '', role: uid === ADMIN ? 'owner' : 'member' },
        time: Math.floor(Date.now() / 1000), message_id: 669700 + i,
      }));
    }, t);
  });
});
let replies = 0;
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
  replies++;
  console.log('<<< ' + out.slice(0, 260).replace(/\n/g, ' / '));
});
setTimeout(() => {
  console.log(`\n=== 发了 ${n} 条，收到 ${replies} 条回复（期望 管理员 7/7 全部有回复） ===`);
  process.exit(0);
}, 6000);
