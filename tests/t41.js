// 管理员审核队列（角色别名一起管）+ 小游戏连发不受长冷却限制
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const GID = 999999999;
const ADMIN = process.env.ON_ADMIN || '3936267550';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0, replies = 0;
function send(text, uid) {
  console.log('\n>>> ' + text);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: GID,
    user_id: uid || 44009943, self_id: 10000, raw_message: text,
    message: [{ type: 'text', data: { text } }], font: 0,
    sender: { user_id: uid || 44009943, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 671800 + (n++) }));
}
ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf(String(GID)) < 0) return;
  replies++;
  let out = s;
  try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('   <<< ' + out.slice(0, 260));
});
(async () => {
  await sleep(800);
  send('/待审核', ADMIN);
  await sleep(3000);
  send('/阻止 1', ADMIN);
  await sleep(3000);
  send('/待审核', ADMIN);
  await sleep(3000);
  console.log('\n--- 连发 8 次 /on回答（验证不会被 60 秒长冷却吃掉）---');
  for (let i = 0; i < 8; i++) { send('/on回答 测试' + i); await sleep(1300); }
  await sleep(2000);
  console.log('\n=== 回复条数 ' + replies + '（连发那段应至少 8 条）===');
  process.exit(0);
})();
