const WebSocket = require('ws');
// /onhelp 系列验证：总览、中文名、带参数、英文别名 /on?、无参数 /on查卡、未知指令
const ws = new WebSocket('ws://127.0.0.1:6700');
// QQ 号来源：secrets.json（仓库副本）→ 环境变量 ON_SELF_ID / ON_ADMIN → 占位值。不写真实号码。
let sec = null;
try { sec = require('../lib/secrets.js'); } catch (e) { /* 线上部署没有 lib/，走环境变量 */ }
const SELF = Number((sec && sec.get('selfId', 'ON_SELF_ID')) || process.env.ON_SELF_ID || 10000);
const ADMIN = Number((sec && sec.get('admin', 'ON_ADMIN')) || process.env.ON_ADMIN || 0);
const sends = ['/onhelp', '/on帮助', '/onhelp 查卡', '/on? 听曲', '/on查卡', '/onhelp 不存在的指令'];
ws.on('open', () => {
  sends.forEach((t, i) => setTimeout(() => {
    console.log('\n>>> ' + t);
    ws.send(JSON.stringify({
      post_type: 'message', message_type: 'group', group_id: 999999999,
      user_id: 44000030 + i, self_id: SELF, raw_message: t,
      message: [{ type: 'text', data: { text: t } }], font: 0,
      sender: { user_id: 44000030 + i, nickname: 't', card: '', role: 'member' },
      time: Math.floor(Date.now() / 1000), message_id: 669300 + i,
    }));
  }, 400 + i * 1600));
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
  } catch (e) { /* 原样打印 */ }
  console.log('<<< ' + out + '\n');
});
setTimeout(() => process.exit(0), 17000);
