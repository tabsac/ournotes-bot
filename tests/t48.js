// 语音谜面：语音一条 + 文字一条（不再合并）；图片谜面仍是同一条；收局语音也单独一条
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
    user_id: 44009996, self_id: 10000, raw_message: text,
    message: [{ type: 'text', data: { text } }], font: 0,
    sender: { user_id: 44009996, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 672700 + (n++) }));
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
  console.log('--- 猜曲谜面：应是 语音一条 + 文字一条 ---');
  send('/on猜曲');
  await sleep(20000);
  const a1 = lastAnswer();
  send('/回答 ' + String(a1).replace(/\n.*$/, ''));
  await sleep(6000);
  console.log('\n--- 猜卡谜面：应仍是 图片+文字 同一条 ---');
  send('/on猜卡 大');
  await sleep(4500);
  send('/结束');
  await sleep(4000);
  console.log('\n--- 猜语音谜面 + 收局 ---');
  send('/on猜语音');
  await sleep(9000);
  const a3 = lastAnswer();
  send('/回答 ' + String(a3).split(' / ')[0]);
  await sleep(6000);
  process.exit(0);
})();
