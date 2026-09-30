// /on留影：不给条件=全部缩略图、给角色=该角色的缩略图、给数字=单张详情（完整图+角色/属性/技能/日记）
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const GID = 999999999;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
function send(t) { console.log('\n>>> ' + t);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: GID,
    user_id: 44008950, self_id: 10000, raw_message: t,
    message: [{ type: 'text', data: { text: t } }], font: 0,
    sender: { user_id: 44008950, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 675000 + (n++) })); }
ws.on('message', (d) => { const s = d.toString(); if (s.indexOf(String(GID)) < 0) return;
  let out = s; try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('   <<< ' + String(out).slice(0, 200)); });
(async () => {
  await sleep(800);
  send('/on留影 峰月律');
  await sleep(10000);
  send('/on留影 64');
  await sleep(10000);
  send('/on留影');
  await sleep(14000);
  send('/on活动');
  await sleep(14000);
  process.exit(0);
})();
