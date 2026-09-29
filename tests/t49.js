// 猜错的三种回复：别的角色/曲子、相近候选带百分比、完全找不到
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
    user_id: 44009998, self_id: 10000, raw_message: text,
    message: [{ type: 'text', data: { text } }], font: 0,
    sender: { user_id: 44009998, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 672900 + (n++) }));
}
ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf(String(GID)) < 0) return;
  let out = s;
  try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('   <<< ' + out.slice(0, 320));
});
(async () => {
  await sleep(800);
  send('/on猜卡 大');
  await sleep(4500);
  console.log('   （本局答案：' + lastAnswer() + '）');
  send('/回答 千早爱音');        // ① 是别的角色
  await sleep(2500);
  send('/回答 高松登');          // ② 相近候选（错别字）
  await sleep(2500);
  send('/回答 完全无关的名字');   // ③ 找不到
  await sleep(2500);
  send('/结束');
  await sleep(3500);
  console.log('\n=== 歌曲那边 ===');
  send('/on猜曲');
  await sleep(20000);
  console.log('   （本局答案：' + lastAnswer() + '）');
  send('/回答 迷星叫');          // ① 别的曲子
  await sleep(2500);
  send('/回答 迷星叫唤');        // ② 相近
  await sleep(2500);
  send('/回答 完全不存在的歌');   // ③ 找不到
  await sleep(2500);
  send('/结束');
  await sleep(4000);
  process.exit(0);
})();
