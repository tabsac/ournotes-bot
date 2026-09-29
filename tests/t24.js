const WebSocket = require('ws');
// 管理员：免长冷却、保留 1 秒短冷却；审核指令只认 /待审核 /阻止 /通过（不再认 /on 前缀）
// QQ 号来源：secrets.json（仓库副本）→ 环境变量 ON_SELF_ID / ON_ADMIN → 占位值。不写真实号码。
let sec = null;
try { sec = require('../lib/secrets.js'); } catch (e) { /* 线上部署没有 lib/，走环境变量 */ }
const SELF = Number((sec && sec.get('selfId', 'ON_SELF_ID')) || process.env.ON_SELF_ID || 10000);
const ADMIN = Number((sec && sec.get('admin', 'ON_ADMIN')) || process.env.ON_ADMIN || 0);

const ws = new WebSocket('ws://127.0.0.1:6700');
// [内容, 距上一条的毫秒数, 说明, 预期有没有回复]
const steps = [
  ['/待审核', 400, '第一条', true],
  ['/待审核', 300, '距上条 0.3 秒 → 短冷却挡掉', false],
  ['/待审核', 1200, '距上次放行 1.5 秒', true],
  ['/待审核', 1200, '允许 #3', true],
  ['/待审核', 1200, '允许 #4', true],
  ['/待审核', 1200, '允许 #5（若长冷却还在，这里之后就该静默）', true],
  ['/待审核', 1200, '允许 #6 → 证明长冷却被免', true],
  ['/待审核', 1200, '允许 #7', true],
  ['/on待审核', 1200, '带 on 前缀 → 应无匹配、无回复', false],
  ['/待审核', 1200, '再发一次 → 有回复，说明上一条的静默不是冷却造成的', true],
  ['/阻止 1', 1200, '免前缀的 /阻止', true],
];
let sent = 0, replies = 0, expect = 0;
const results = [];
ws.on('open', () => {
  let t = 0;
  steps.forEach(([text, gap, why, want], i) => {
    t += gap;
    if (want) expect++;
    setTimeout(() => {
      sent++;
      console.log(`\n>>> #${sent} ${text}   （${why}）`);
      results.push({ i, want, before: replies });
      ws.send(JSON.stringify({
        post_type: 'message', message_type: 'group', group_id: 999999999,
        user_id: ADMIN, self_id: SELF, raw_message: text,
        message: [{ type: 'text', data: { text } }], font: 0,
        sender: { user_id: ADMIN, nickname: 't', card: '', role: 'owner' },
        time: Math.floor(Date.now() / 1000), message_id: 669800 + i,
      }));
    }, t);
  });
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
  replies++;
  console.log('<<< ' + out.slice(0, 200).replace(/\n/g, ' / '));
});
setTimeout(() => {
  console.log(`\n=== 发出 ${sent} 条，收到 ${replies} 条回复（预期 ${expect} 条）===`);
  results.forEach((r) => {
    const got = replies > r.before ? '有回复' : '无回复';
    const ok = (r.want && replies > r.before) || (!r.want && replies === r.before);
    console.log(`  #${r.i + 1} 预期${r.want ? '有' : '无'}回复 → 实际${got} ${ok ? '✅' : '❌'}`);
  });
  process.exit(0);
}, 16000);
