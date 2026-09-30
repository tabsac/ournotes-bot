// 音频缓存完整性：半截 mp3（转码中断留下的）必须被识别出来删掉重做，
// 否则 /on听曲 发出的语音播不出来（用户看到「获取不到」）
//   —— 跑之前先把某个已缓存的 mp3 截断（例如 head -c 262144 x.mp3 > x.mp3）再跑本测试
const fs = require('fs');
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:6700');
const GID = 999999999;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

function send(t) {
  console.log('\n>>> ' + t);
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: GID,
    user_id: 44008940, self_id: 10000, raw_message: t,
    message: [{ type: 'text', data: { text: t } }], font: 0,
    sender: { user_id: 44008940, nickname: 't', card: '', role: 'member' },
    time: Math.floor(Date.now() / 1000), message_id: 674900 + (n++) }));
}

ws.on('message', (d) => {
  const s = d.toString();
  if (s.indexOf(String(GID)) < 0) return;
  let out = s;
  try { const j = JSON.parse(s); const m = j.params && j.params.message;
    if (typeof m === 'string') out = m; else if (m) out = JSON.stringify(m); } catch (e) {}
  console.log('   <<< ' + String(out).slice(0, 200));
});

(async () => {
  await sleep(800);
  const f = '/home/admin/bot/data/on/audio/100109.mp3';
  console.log('（测试前缓存大小：' + (fs.existsSync(f) ? fs.statSync(f).size : -1) + 'B）');
  send('/on听曲 夢我夢中');
  await sleep(30000);
  console.log('（测试后缓存大小：' + (fs.existsSync(f) ? fs.statSync(f).size : -1) + 'B）');
  process.exit(0);
})();
