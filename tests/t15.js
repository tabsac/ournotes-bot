const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const cmds = ['/on查谱面 焚音打 EXPERT', '/on查卡 MyGO!!!!!', '/on查卡 绯红', '/on查卡 MyGO 绯红'];
const send = (t, id) => {
  console.log('>>> ' + t);
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', group_id: 999999999,
    user_id: 44000040 + id, self_id: 10000, raw_message: t,
    message: [{ type: 'text', data: { text: t } }], font: 0,
    sender: { user_id: 44000040 + id, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 669300 + id,
  }));
};
ws.on('open', () => {
  cmds.forEach((c, i) => setTimeout(() => send(c, i), 500 + i * 9000));
});
ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf('999999999') >= 0) {
    const m = /"message":("(?:[^"\\]|\\.)*")/.exec(s);
    console.log('<<< ' + (m ? m[1].slice(0, 400) : s.slice(0, 260)));
  }
});
setTimeout(() => process.exit(0), 40000);
