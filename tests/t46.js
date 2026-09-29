// 猜曲只发音频；同会话不能同时两局；1 分钟到点自动公布
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
    user_id: 44009991, self_id: 10000, raw_message: text,
    message: [{ type: 'text', data: { text } }], font: 0,
    sender: { user_id: 44009991, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 672500 + (n++) }));
}
ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf(String(GID)) < 0) return;
  let out = s;
  try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('   <<< ' + out.slice(0, 500));
});
(async () => {
  await sleep(800);
  console.log('--- 猜曲：只发音频，不带文字 ---');
  send('/on猜曲');
  await sleep(20000);
  console.log('--- 已有进行中的一局再开猜卡（应被拒）---');
  send('/on猜卡');
  await sleep(4000);
  console.log('--- 等它自己到点（1 分钟，从音频发出后算）---');
  await sleep(45000);
  console.log('--- 到点后应该已经公布；这时再开一局应成功 ---');
  const before = lastAnswer();
  send('/on猜卡 大');
  await sleep(5000);
  send('/结束');
  await sleep(4000);
  console.log('\n（上一局答案：' + before + '）');
  process.exit(0);
})();
