// /on卡池：现在出的是构造图（无卡池时退回文本）
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
setTimeout(() => {
  console.log('>>> /on卡池');
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 999999999,
    user_id: 44009931, self_id: 10000, raw_message: '/on卡池',
    message: [{ type: 'text', data: { text: '/on卡池' } }], font: 0,
    sender: { user_id: 44009931, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 671500 }));
}, 500);
ws.on('message', (d) => { const s = d.toString(); if (s.indexOf('999999999') < 0) return;
  console.log('<<< ' + s.slice(0, 400)); });
setTimeout(() => process.exit(0), 20000);
