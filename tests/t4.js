const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const ADMIN = YOUR_ADMIN_QQ;
const GID = 999999999;
const cases = [
  { raw: '/on添加别名 迷星叫 まよいうた', uid: ADMIN, delay: 300 },
  { raw: '/on查曲 まよいうた', uid: 41000001, delay: 3500 },
  { raw: '/on谱面预览 まよいうた EXPERT', uid: 41000002, delay: 7000 },
  { raw: '/on查曲 春日影', uid: 41000003, delay: 13000 },
  { raw: '/onhelp', uid: 41000004, delay: 17000 },
];
function send(raw, uid) {
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: GID,
    user_id: uid, self_id: 10000, raw_message: raw,
    message: [{ type: 'text', data: { text: raw } }], font: 0,
    sender: { user_id: uid, nickname: 'tester', card: '', role: uid === ADMIN ? 'owner' : 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 700000 + Math.floor(Math.random() * 1000),
  }));
  console.log(`>>> ${raw}`);
}
ws.on('open', () => { for (const c of cases) setTimeout(() => send(c.raw, c.uid), c.delay); });
let n = 0;
ws.on('message', (d) => {
  n++;
  const s = d.toString();
  console.log(`<<< #${n}: ${s.length > 320 ? s.slice(0, 320) + '…' : s}`);
});
setTimeout(() => { console.log(`\n共 ${n} 条，结束`); process.exit(0); }, 25000);
