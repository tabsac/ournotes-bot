// 模拟 NapCat 连接，向 bot 发指令，观察 bot 回传的动作 JSON（不产生真实群消息）
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const uid = 20000000 + Math.floor(Math.random() * 1000000);
const GID = 999999999;

const cases = [
  { raw: '/on查卡 灯', delay: 300 },
  { raw: '/on查卡 灯 SSR', delay: 2600 },
  { raw: '/oncard 51', delay: 5000 },
  { raw: '/on查卡 Tomori', delay: 7500 },
  { raw: '/onhelp', delay: 10000 },
];

function send(raw) {
  const ev = {
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    group_id: GID, user_id: uid, self_id: 10000,
    raw_message: raw, message: [{ type: 'text', data: { text: raw } }], font: 0,
    sender: { user_id: uid, nickname: 'tester', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 900000 + Math.floor(Math.random() * 1000),
  };
  ws.send(JSON.stringify(ev));
  console.log(`>>> SENT: ${raw}`);
}

ws.on('open', () => {
  console.log('已作为“假 NapCat”连上 127.0.0.1:6700, uid=' + uid);
  for (const c of cases) setTimeout(() => send(c.raw), c.delay);
});

let n = 0;
ws.on('message', (d) => {
  n++;
  const s = d.toString();
  console.log(`<<< RECV#${n} (${s.length}B): ${s.slice(0, 700)}`);
});

setTimeout(() => { console.log(`\n共收到 ${n} 条回传，测试结束`); process.exit(0); }, 15000);
