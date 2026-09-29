// 11–20 号角色的语音只走 bundle 内嵌路线（catalog 里没有独立 CRI 包），这里专门压这条路线
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const steps = ['阿拉蕾', '野乃花', '律', '都子', '由乃', '萤', '枣', '凪', '茉幌', '朋花'];
let t = 500;
ws.on('open', () => steps.forEach((name, i) => {
  setTimeout(() => {
    console.log('\n>>> [11+' + i + '] /on听 ' + name);
    const text = '/on听 ' + name;
    ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 999999999,
      user_id: 44001000 + i, self_id: 10000, raw_message: text,
      message: [{ type: 'text', data: { text } }], font: 0,
      sender: { user_id: 44001000 + i, nickname: 't', card: '', role: 'member' },
      time: Math.floor(Date.now() / 1000), message_id: 671000 + i }));
  }, (t += 22000));
}));
ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf('999999999') < 0) return;
  let out = s;
  try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('<<< ' + out.slice(0, 240));
});
setTimeout(() => process.exit(0), 260000);
