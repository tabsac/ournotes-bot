// 测试 /on查曲 /on添加别名 /on谱面预览 /on听曲
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const ADMIN = YOUR_ADMIN_QQ;
const GID = 999999999;
const cases = [
  { raw: '/on查曲 迷星叫', uid: 31000001, delay: 300 },
  { raw: '/on添加别名 迷星叫 mayoiuta', uid: ADMIN, delay: 4000 },
  { raw: '/on查曲 mayoiuta', uid: 31000002, delay: 7000 },
  { raw: '/on谱面预览 迷星叫 HARD', uid: 31000003, delay: 11000 },
  { raw: '/on听曲 迷星叫', uid: 31000004, delay: 18000 },
  { raw: '/on查曲 まよいうた', uid: 31000005, delay: 26000 },
];
function send(raw, uid) {
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: GID,
    user_id: uid, self_id: 10000, raw_message: raw,
    message: [{ type: 'text', data: { text: raw } }], font: 0,
    sender: { user_id: uid, nickname: 'tester', card: '', role: uid === ADMIN ? 'owner' : 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 800000 + Math.floor(Math.random() * 1000),
  }));
  console.log(`>>> ${raw}`);
}
ws.on('open', () => {
  console.log('假 NapCat 已连接');
  for (const c of cases) setTimeout(() => send(c.raw, c.uid), c.delay);
});
let n = 0;
ws.on('message', (d) => {
  n++;
  const s = d.toString();
  console.log(`<<< RECV#${n}: ${s.length > 400 ? s.slice(0, 400) + '…' : s}`);
});
setTimeout(() => { console.log(`\n共 ${n} 条回传，结束`); process.exit(0); }, 40000);
