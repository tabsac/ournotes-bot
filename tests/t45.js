// 猜曲直接用完整版剪片段、收局不发完整版；答对按 QQ 记战绩并回「你答对过 N 次」
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
function send(text, uid) {
  console.log('\n>>> [' + (uid || 44009981) + '] ' + text);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: GID,
    user_id: uid || 44009981, self_id: 10000, raw_message: text,
    message: [{ type: 'text', data: { text } }], font: 0,
    sender: { user_id: uid || 44009981, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 672400 + (n++) }));
}
ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf(String(GID)) < 0) return;
  let out = s;
  try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('   <<< ' + out.slice(0, 600));
});
(async () => {
  await sleep(800);
  console.log('--- 猜曲：应只用完整版剪片段、收局只给曲绘 ---');
  send('/on猜曲');
  await sleep(20000);
  let a = lastAnswer();
  console.log('   （答案：' + a + '）');
  send('/回答 ' + (a || '').replace(/\n.*$/, ''));
  await sleep(6000);
  console.log('\n--- 同一 QQ 再对一题（战绩应变 2 次）---');
  send('/on猜卡 大');
  await sleep(4500);
  a = lastAnswer();
  send('/回答 ' + a);
  await sleep(5000);
  console.log('\n--- 换个 QQ 答对（应显示 1 次）---');
  send('/on猜语音');
  await sleep(9000);
  a = lastAnswer();
  send('/回答 ' + String(a).split(' / ')[0], 44009982);
  await sleep(6000);
  process.exit(0);
})();
