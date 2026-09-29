const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const texts = ['/on谱面预览 迷星叫 hd', '/on查谱面 迷星叫 ez', '/on谱面预览 焚音打 nor'];
ws.on('open', () => texts.forEach((t, i) => setTimeout(() => {
  console.log('\n>>> ' + t);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 999999999,
    user_id: 44000120 + i, self_id: 10000, raw_message: t,
    message: [{ type: 'text', data: { text: t } }], font: 0,
    sender: { user_id: 44000120 + i, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 669960 + i }));
}, 400 + i * 22000)));
ws.on('message', (d) => { const s = d.toString(); if (s.indexOf('999999999') >= 0) console.log('<<< ' + s.slice(0, 300)); });
setTimeout(() => process.exit(0), 70000);
