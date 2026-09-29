const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const cmds = ['/on难度排行 25', '/on难度排行 ex 25', '/on难度排行 hd 18', '/on难度排行 nor', '/on难度排行 ez', '/on难度排行 99', '/on难度排行 foo'];
const send = (t, id) => {
  console.log('>>> ' + t);
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', group_id: 999999999,
    user_id: 44000080 + id, self_id: 10000, raw_message: t,
    message: [{ type: 'text', data: { text: t } }], font: 0,
    sender: { user_id: 44000080 + id, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 669700 + id,
  }));
};
ws.on('open', () => cmds.forEach((c, i) => setTimeout(() => send(c, i), 400 + i * 5500)));
ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf('999999999') >= 0) {
    const m = /"message":("(?:[^"\\]|\\.)*")/.exec(s);
    console.log('<<< ' + (m ? m[1].slice(0, 300) : s.slice(0, 200)));
  }
});
setTimeout(() => process.exit(0), 43000);
