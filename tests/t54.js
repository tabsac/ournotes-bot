// 求助类 /bang：先给 tsugu 的帮助列表，再补一句「/bang + 指令」的用法提示
//   /banghelp、/bang/help（多一个斜杠）、/bang帮助 都应触发；普通 /bang查卡 不带提示
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const GID = 999999999;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

function send(t) {
  console.log('\n>>> ' + t);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: GID,
    user_id: 44008880, self_id: 10000, raw_message: t,
    message: [{ type: 'text', data: { text: t } }], font: 0,
    sender: { user_id: 44008880, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 674300 + (n++) }));
}

ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf(String(GID)) < 0) return;
  let out = s;
  try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('   <<< ' + String(out).slice(0, 240));
});

(async () => {
  await sleep(800);
  send('/banghelp');        // tsugu 指令列表 + 提示
  await sleep(14000);
  send('/bang/help');       // 多一个斜杠也要认
  await sleep(14000);
  send('/bang帮助');        // 中文写法
  await sleep(10000);
  console.log('\n--- 普通指令：不应带提示 ---');
  send('/bang查卡 灯');
  await sleep(16000);
  process.exit(0);
})();
