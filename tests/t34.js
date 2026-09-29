const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const steps = [['/on听 灯', '角色1'], ['/on听 祥子', '角色10'], ['/on听', '随机角色']];
let t = 500;
ws.on('open', () => steps.forEach(([text, what], i) => {
  setTimeout(() => {
    console.log('\n>>> [' + what + '] ' + text);
    ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 999999999,
      user_id: 44000600 + i, self_id: 10000, raw_message: text,
      message: [{ type: 'text', data: { text } }], font: 0,
      sender: { user_id: 44000600 + i, nickname: 't', card: '', role: 'member' },
      time: Math.floor(Date.now() / 1000), message_id: 670400 + i }));
  }, (t += 25000));
}));
ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf('999999999') < 0) return;
  let out = s;
  try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('<<< ' + out.slice(0, 300));
});
setTimeout(() => process.exit(0), 90000);
