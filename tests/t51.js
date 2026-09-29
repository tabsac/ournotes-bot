// 短间隔连发：准备期内的第二次请求必须被挡住（不再各开一局互相抢占）
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
function send(t, gid, who) {
  console.log('\n>>> [群 ' + gid + '] ' + t);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: gid,
    user_id: who, self_id: 10000, raw_message: t,
    message: [{ type: 'text', data: { text: t } }], font: 0,
    sender: { user_id: who, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 673500 + (n++) }));
}
ws.on('message', (d) => { const s = d.toString();
  if (!/99999999[0-9]/.test(s)) return;
  let out = s; try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('   <<< ' + out.slice(0, 200)); });
(async () => {
  await sleep(800);
  for (const gid of [999999990, 999999991, 999999992]) {
    send('/on猜曲', gid, 44008820);
    await sleep(1300);                    // 短间隔：这时第一局多半还在下完整版
    send('/on猜曲', gid, 44008820);
    await sleep(2000);
    send('/回答 随便猜', gid, 44008820);   // 准备中的话应提示「等谜面发出来再答」
    await sleep(24000);
  }
  process.exit(0);
})();
