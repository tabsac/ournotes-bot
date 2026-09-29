// /banghelp：tsugu 的 help 指令（Koishi 的 @koishijs/plugin-help）
//   * /banghelp        → 列出全部 tsugu 指令
//   * /banghelp 查卡    → 单条指令的用法
//   * 顺便确认：不是 tsugu 指令的 /bangxxx 仍然静默（白名单外不发）
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const GID = 999999999;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

function send(t) {
  console.log('\n>>> ' + t);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: GID,
    user_id: 44008870, self_id: 10000, raw_message: t,
    message: [{ type: 'text', data: { text: t } }], font: 0,
    sender: { user_id: 44008870, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 674200 + (n++) }));
}

ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf(String(GID)) < 0) return;
  let out = s;
  try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('   <<< ' + String(out).slice(0, 1200));
});

(async () => {
  await sleep(800);
  send('/banghelp');          // 全部指令
  await sleep(15000);
  send('/banghelp 查卡');      // 单条用法
  await sleep(12000);
  console.log('\n--- 不是指令的（应静默）---');
  send('/bang这肯定不是指令');
  await sleep(4000);
  process.exit(0);
})();
