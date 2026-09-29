const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
ws.on('open', () => setTimeout(() => {
  const t = '/on听曲 迷星叫';
  console.log('>>> ' + t);
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', group_id: 999999999,
    user_id: 44000021, self_id: 10000, raw_message: t,
    message: [{ type: 'text', data: { text: t } }], font: 0,
    sender: { user_id: 44000021, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 669130,
  }));
}, 300));
ws.on('message', (d) => console.log('<<< ' + d.toString().slice(0, 400)));
setTimeout(() => process.exit(0), 30000);
