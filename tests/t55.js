// /on活动：构造图片（主视觉 + 活动曲 + Pick Up + 加成 + 点数奖励）
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const GID = 999999999;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
function send(t) { console.log('\n>>> ' + t);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: GID,
    user_id: 44008900, self_id: 10000, raw_message: t,
    message: [{ type: 'text', data: { text: t } }], font: 0,
    sender: { user_id: 44008900, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 674500 + (n++) })); }
ws.on('message', (d) => { const s = d.toString(); if (s.indexOf(String(GID)) < 0) return;
  let out = s; try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('   <<< ' + String(out).slice(0, 200)); });
(async () => {
  await sleep(800);
  send('/on活动');
  await sleep(15000);
  send('/onhelp 活动');
  await sleep(4000);
  process.exit(0);
})();
