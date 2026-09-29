// 小游戏：猜卡 / 猜曲 / 猜语音 + 回答 + 结束（答案从 bot 日志里取，用 CONFIG 里的测试会话）
const fs = require('fs');
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const LOG = '/tmp/bot.log';
const GID = 999999999;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastAnswer() {
  const lines = fs.readFileSync(LOG, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /\[on\] (猜卡|猜曲|猜语音)开局 key=g:999999999 答案=(.+)$/.exec(lines[i]);
    if (m) return { kind: m[1], answer: m[2].trim() };
  }
  return null;
}

let replied = [];
ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf(String(GID)) < 0) return;
  let out = s;
  try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  replied.push(out);
  console.log('   <<< ' + out.slice(0, 160));
});

function send(text) {
  console.log('\n>>> ' + text);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: GID,
    user_id: 44009941, self_id: 10000, raw_message: text,
    message: [{ type: 'text', data: { text } }], font: 0,
    sender: { user_id: 44009941, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 671600 + Math.floor(Math.random() * 1000) }));
}

(async () => {
  await sleep(800);
  // 1) 猜卡：先乱答一次（看错误回复），再按日志里的答案答对
  send('/on猜卡 中');
  await sleep(4000);
  send('/on回答 完全不对的名字');
  await sleep(2000);
  let r = lastAnswer();
  console.log('   （日志答案：' + JSON.stringify(r) + '）');
  send('/on回答 ' + (r ? r.answer : '灯'));
  await sleep(3000);
  // 2) 猜曲：只发 3 秒音频；用「少一个字」的模糊写法回答
  send('/on猜曲');
  await sleep(12000);
  r = lastAnswer();
  console.log('   （日志答案：' + JSON.stringify(r) + '）');
  if (r) send('/on回答 ' + r.answer.slice(0, Math.max(2, r.answer.length - 2)));
  await sleep(4000);
  // 3) 猜语音：模糊写法只留第一个字 + 一个字（编一个近似）
  send('/on猜语音');
  await sleep(9000);
  r = lastAnswer();
  console.log('   （日志答案：' + JSON.stringify(r) + '）');
  if (r) send('/on回答 ' + r.answer.slice(0, 2));
  await sleep(4000);
  // 4) 结束：开一局再放弃
  send('/on猜卡 小');
  await sleep(4000);
  send('/on结束');
  await sleep(3000);
  console.log('\n=== 收到的回复条数：' + replied.length + ' ===');
  process.exit(0);
})();
