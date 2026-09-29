// 收局给完整语音/原文/曲绘 + 谜面文字同一条 + 裸指令 /回答 /答 /猜 /结束
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
    if (m) return { kind: m[1], answer: m[2].trim() };
  }
  return null;
}
function send(text) {
  console.log('\n>>> ' + text);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: GID,
    user_id: 44009961, self_id: 10000, raw_message: text,
    message: [{ type: 'text', data: { text } }], font: 0,
    sender: { user_id: 44009961, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 672100 + (n++) }));
}
ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf(String(GID)) < 0) return;
  let out = s;
  try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('   <<< ' + out.slice(0, 700));
});
(async () => {
  await sleep(800);
  console.log('--- 猜语音：/猜 回答（裸指令）---');
  send('/on猜语音');
  await sleep(9000);
  let a = lastAnswer();
  console.log('   （答案：' + JSON.stringify(a) + '）');
  if (a) send('/猜 ' + a.answer.split(' / ')[0]);
  await sleep(6000);
  console.log('\n--- 猜卡：/答 回答 ---');
  send('/on猜卡 大');
  await sleep(4500);
  a = lastAnswer();
  console.log('   （答案：' + JSON.stringify(a) + '）');
  if (a) send('/答 ' + a.answer);
  await sleep(5000);
  console.log('\n--- 猜曲：/回答 回答（完整版要现抓，可能慢一点）---');
  send('/on猜曲');
  await sleep(15000);
  a = lastAnswer();
  console.log('   （答案：' + JSON.stringify(a) + '）');
  if (a) send('/回答 ' + a.answer.replace(/\n.*$/, ''));
  await sleep(35000);
  console.log('\n--- 开一局再 /结束 ---');
  send('/on猜卡 中');
  await sleep(4500);
  send('/结束');
  await sleep(4000);
  process.exit(0);
})();
