const WebSocket = require('ws');
// 谱面预览走 bot 全链路：/on谱面预览 迷星叫 EXPERT（应出新图：侧条 + 拍号）
// QQ 号来源：secrets.json（仓库副本）→ 环境变量 → 占位值
let sec = null;
try { sec = require('../lib/secrets.js'); } catch (e) { /* 线上部署没有 lib/ */ }
const SELF = Number((sec && sec.get('selfId', 'ON_SELF_ID')) || process.env.ON_SELF_ID || 10000);
const USER = 44000101;
const ws = new WebSocket('ws://127.0.0.1:6700');
const texts = ['/on谱面预览 迷星叫 EXPERT', '/on查谱面 鳴らす'];
ws.on('open', () => {
  texts.forEach((t, i) => setTimeout(() => {
    console.log('\n>>> ' + t);
    ws.send(JSON.stringify({
      post_type: 'message', message_type: 'group', group_id: 999999999,
      user_id: USER + i, self_id: SELF, raw_message: t,
      message: [{ type: 'text', data: { text: t } }], font: 0,
      sender: { user_id: USER + i, nickname: 't', card: '', role: 'member' },
      time: Math.floor(Date.now() / 1000), message_id: 669900 + i,
    }));
  }, 400 + i * 30000));
});
ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf('999999999') < 0) return;
  let out = s;
  try {
    const j = JSON.parse(s);
    const m = j.params && j.params.message;
    if (typeof m === 'string') out = m;
    else if (m) out = JSON.stringify(m);
  } catch (e) { /* 原样 */ }
  console.log('<<< ' + out.slice(0, 400));
});
setTimeout(() => process.exit(0), 75000);
