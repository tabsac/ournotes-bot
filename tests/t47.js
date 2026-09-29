// 已有进行中的一局时，再发猜X 只是提示「正在进行游戏」，不打断本局（本局仍能答对）
const fs = require('fs');
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const GID = 999999999;
const LOG = '/tmp/bot.log';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
function lastAnswer() {
  const lines = fs.readFileSync(LOG, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /\[on\] (猜卡|猜曲|猜语音)开局 key=g:999999999 答案=(.+)$/.exec(lines[i]);
    if (m) return m[2].trim();
  }
  return null;
}
function send(text) {
  console.log('\n>>> ' + text);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: GID,
    user_id: 44009995, self_id: 10000, raw_message: text,
    message: [{ type: 'text', data: { text } }], font: 0,
    sender: { user_id: 44009995, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 672600 + (n++) }));
}
ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf(String(GID)) < 0) return;
  let out = s;
  try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('   <<< ' + out.slice(0, 400));
});
(async () => {
  await sleep(800);
  send('/on猜卡 大');
  await sleep(4500);
  const a1 = lastAnswer();
  send('/on猜曲');           // 应被拒
  await sleep(2500);
  send('/on猜语音');         // 也应被拒
  await sleep(2500);
  send('/回答 ' + a1);       // 本局照常能答对
  await sleep(4000);
  console.log('\n（本局答案：' + a1 + '）');
  process.exit(0);
})();
