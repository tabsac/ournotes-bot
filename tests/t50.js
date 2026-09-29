// /on听歌、/on听曲 不再被 /on听 吞掉；/on听 仍可用；答错不再有中途提示
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
function send(t) {
  console.log('\n>>> ' + t);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: GID,
    user_id: 44008802, self_id: 10000, raw_message: t,
    message: [{ type: 'text', data: { text: t } }], font: 0,
    sender: { user_id: 44008802, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 673300 + (n++) }));
}
ws.on('message', (d) => { const s = d.toString(); if (s.indexOf(String(GID)) < 0) return;
  let out = s; try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('   <<< ' + out.slice(0, 200)); });
(async () => {
  await sleep(800);
  send('/on听歌 迷星叫');
  await sleep(9000);
  send('/on听曲 迷星叫');
  await sleep(9000);
  send('/on听 灯');
  await sleep(6000);
  console.log('\n--- 答错 4 次：不应再出现「提示：…」---');
  send('/on猜卡 大');
  await sleep(4500);
  for (let i = 0; i < 4; i++) { send('/回答 不对的名字' + i); await sleep(1800); }
  await sleep(2500);
  send('/结束');
  await sleep(3500);
  console.log('（本局答案：' + lastAnswer() + '）');
  process.exit(0);
})();
