const WebSocket = require('ws');
const ADMIN = YOUR_ADMIN_QQ;                    // 管理员，才能用 /on更新
const ws = new WebSocket('ws://127.0.0.1:6700');
const send = (text, id) => ws.send(JSON.stringify({
  post_type: 'message', message_type: 'group', group_id: 999999999,
  user_id: ADMIN, self_id: 10000, raw_message: text,
  message: [{ type: 'text', data: { text } }], font: 0,
  sender: { user_id: ADMIN, nickname: 'admin', card: '', role: 'admin' },
  time: Math.floor(Date.now() / 1000), message_id: id,
}));
ws.on('open', () => {
  setTimeout(() => { console.log('>>> /on更新'); send('/on更新', 668001); }, 300);
  setTimeout(() => { console.log('>>> /on更新 状态'); send('/on更新 状态', 668002); }, 9000);
});
ws.on('message', d => console.log('<<< ' + d.toString().slice(0, 700)));
setTimeout(() => process.exit(0), 30000);
