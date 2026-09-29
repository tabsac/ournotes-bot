const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const t = '/on查谱面 鳴らす';
ws.on('open', () => setTimeout(() => {
  console.log('>>> ' + t);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 999999999,
    user_id: 44000111, self_id: 10000, raw_message: t,
    message: [{ type: 'text', data: { text: t } }], font: 0,
    sender: { user_id: 44000111, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 669950 }));
}, 400));
ws.on('message', (d) => { const s = d.toString(); if (s.indexOf('999999999') >= 0) console.log('<<< ' + s.slice(0, 500)); });
setTimeout(() => process.exit(0), 9000);
