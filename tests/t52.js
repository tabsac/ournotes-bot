// /bang<指令> → 去掉 /bang 推给 tsugu（Koishi + 公共 API）
//  * /bang查卡          → 本地提示用法（不发 tsugu，避免 tsugu 回「后端服务器连接出错」）
//  * /bang查卡 灯        → tsugu 调公共 API /searchCard → 卡图
//  * 顺带检查：Koishi 日志里不应新增「Timeout with request send_group_msg」
//    （app.js 必须把 NapCat 对 tsugu 动作的 echo 回执传回去）
const fs = require('fs');
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const GID = 999999999;
const TSG_LOG = '/tmp/tsugu.log';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

function timeouts() {
  try { return (fs.readFileSync(TSG_LOG, 'utf8').match(/Timeout with request send_group_msg/g) || []).length; }
  catch (e) { return -1; }
}

function send(t) {
  console.log('\n>>> ' + t);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: GID,
    user_id: 44008860, self_id: 10000, raw_message: t,
    message: [{ type: 'text', data: { text: t } }], font: 0,
    sender: { user_id: 44008860, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 674100 + (n++) }));
}

ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf(String(GID)) < 0) return;
  let out = s;
  try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('   <<< ' + String(out).slice(0, 160));
});

(async () => {
  await sleep(800);
  const t0 = timeouts();
  console.log('（Koishi 发送超时计数：' + t0 + '）');

  send('/bang查卡');            // 缺参数 → 本地用法提示
  await sleep(4000);
  send('/bang查卡 灯');          // 正常 → 卡图
  await sleep(20000);

  const t1 = timeouts();
  console.log('\n（Koishi 发送超时计数：' + t1 + '）' + (t1 === t0 ? ' → 没有新增，echo 回执正常 ✅' : ' → 有新增，检查 app.js 的响应转发 ❌'));
  console.log('\n--- 不是 tsugu 指令的（应静默）---');
  send('/bang谱面 1');
  await sleep(4000);
  process.exit(0);
})();
