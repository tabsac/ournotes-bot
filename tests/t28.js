const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const texts = ['/on效益排行 hd 17', '/on效率排行', '/on谱面预览 迷星叫 hd'];
ws.on('open', () => texts.forEach((t, i) => setTimeout(() => {
  console.log('\n>>> ' + t);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 999999999,
    user_id: 44000140 + i, self_id: 10000, raw_message: t,
    message: [{ type: 'text', data: { text: t } }], font: 0,
    sender: { user_id: 44000140 + i, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 669980 + i }));
}, 400 + i * 12000)));
ws.on('message', (d) => { const s = d.toString(); if (s.indexOf('999999999') >= 0) console.log('<<< ' + s.slice(0, 260)); });
setTimeout(() => process.exit(0), 40000);
