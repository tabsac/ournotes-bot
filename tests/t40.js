// 角色别名：登记 → 立即生效（查卡/听/猜卡答案都认）→ 进待审核队列 → 管理员阻止
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const GID = 999999999;
const ADMIN = process.env.ON_ADMIN || '3936267550';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
function send(text, uid) {
  console.log('\n>>> ' + text);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: GID,
    user_id: uid || 44009942, self_id: 10000, raw_message: text,
    message: [{ type: 'text', data: { text } }], font: 0,
    sender: { user_id: uid || 44009942, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 671700 + (n++) }));
}
ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf(String(GID)) < 0) return;
  let out = s;
  try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('   <<< ' + out.slice(0, 200));
});
(async () => {
  await sleep(800);
  send('/on角色别名 高松灯 tomorin');
  await sleep(3000);
  send('/on听 tomorin');            // 别名立刻可用于其它指令
  await sleep(6000);
  send('/on待审核', ADMIN);          // 管理员看队列（应同时有角色别名）
  await sleep(3000);
  console.log('\n=== 完 ===');
  process.exit(0);
})();
