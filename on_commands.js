'use strict';
/**
 * Our Notes（com.bilibili.sirius.official）指令模块
 *
 *  卡片
 *    /on查卡 <角色|团体|颜色> [星级]  卡片网格图（/oncard 同义）
 *    /on查卡 <数字ID>                单卡详情图
 *    /on留影 [角色|数字ID]           留影卡一览 / 单张详情图
 *  曲目
 *    /on查曲 <曲名|别名>        曲目卡（封面/作曲作词编曲/MV/BPM/时长/四难度/别名）
 *    /on听曲 <曲名|别名>        歌曲语音（有完整版发完整版，否则发试听片段）
 *    /on听 [角色]               角色语音：随机一条 + 中文文本（双引号）
 *    /on谱面预览 <曲名> [难度]   谱面长图（/on查谱面 是同一条；难度 ex/hd/nor/ez，默认 ex）
 *  图鉴
 *    /on小漫画 [角色]           随机一张加载漫画
 *    /on卡池                    当期招募一览图（封面 + 期间 + 概率 + Pick Up）
 *    /on活动                    当期活动一览图（主视觉 + 活动曲 + Pick Up + 加成 + 点数奖励）
 *    /on表情 [角色|ID]          表情图鉴 / 原图
 *    /on贴纸 [角色|ID]          贴纸收藏 / 原图
 *    /on难度排行 [难度] [整数]   难度排行图
 *    /on效益排行 [难度] [整数]   效益排行（单局理论最高分）
 *    /on效率排行 [难度] [整数]   效率排行（效益 ÷ 时长）
 *  别名
 *    /on添加别名 <原名> <别名>   曲子别名（谁都能加，进待审核队列）
 *    /on角色别名 <角色> <别名>   角色别名（同上；查卡/听/小漫画/猜卡/猜语音都认）
 *  小游戏
 *    /on猜卡 [大|中|小]          卡面剪一小块，猜角色（R 卡不参与）
 *    /on猜曲 /on猜语音           听 3 秒，猜曲名 / 猜角色
 *    /回答 <答案>（/答、/猜）      答题；/结束 放弃（模糊匹配 + 别名都算对）
 *  管理（不进 help）
 *    /待审核                    列出待审核队列（曲子别名 + 角色别名）
 *    /通过 <标号…|全部>          通过
 *    /阻止 <标号…>              阻止：撤销该别名，并按「类型+对象+别名」拉黑
 *    /on更新 [资源|主数据] [应用|状态]  资源/主数据增量更新
 *  其它
 *    /onhelp [指令]             帮助（文本见 HELP_MAIN / HELP_DETAIL）
 *
 * 搜索：原名（中简/中繁/日/英/读音）+ 别名 + 模糊匹配（归一化后包含 / 字符重合度）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ON_DIR = process.env.ON_DIR || '/home/admin/bot/data/on';
const PY = process.env.ON_PY || 'python3';
const CACHE_DIR = path.join(ON_DIR, 'cache');
const CHART_DIR = path.join(ON_DIR, 'chart');
const AUDIO_DIR = path.join(ON_DIR, 'audio');
const ALIAS_FILE = path.join(ON_DIR, 'aliases.json');
const CHAR_ALIAS_FILE = path.join(ON_DIR, 'char_aliases.json');   // 角色别名（/on角色别名）
const SCORE_FILE = path.join(ON_DIR, 'game_score.json');          // 小游戏战绩：QQ → 答对次数
const ADMIN = String(process.env.ON_ADMIN || '3936267550');
const RENDER_TIMEOUT_MS = 90 * 1000;
const withBundle = (n) => (String(n || '').endsWith('.bundle') ? String(n) : String(n || '') + '.bundle');

// ---- CDN 包解密：UnityFS 明文直接用；否则按 unity-node 的方案解密
//   key=7372a4ee777db361ad896c99e408a182 seed=ee24a70238e2a0e5
//   nonce = SHA256(seed || utf8(bundleName))[0:8]
//   计数块 = nonce(8) || BE64(blockIndex)，AES-128-ECB 生成 keystream
//   只异或前 min(size,16384) 字节，尾部原样保留
const crypto = require('crypto');
const BUNDLE_KEY = Buffer.from('7372a4ee777db361ad896c99e408a182', 'hex');
const BUNDLE_SEED = Buffer.from('ee24a70238e2a0e5', 'hex');
const INNER_MAGIC = 'UnityFS\0';

function maybeDecrypt(buf, name) {
  if (buf.length >= 8 && buf.subarray(0, 8).toString('binary') === INNER_MAGIC) return buf;
  const nonce = crypto.createHash('sha256')
    .update(Buffer.concat([BUNDLE_SEED, Buffer.from(name, 'utf8')]))
    .digest().subarray(0, 8);
  const boundary = Math.min(buf.length, 16384);
  const out = Buffer.from(buf);
  let ctr = 0n;
  for (let off = 0; off < boundary; off += 16) {
    const cb = Buffer.alloc(16);
    nonce.copy(cb, 0);
    cb.writeBigUInt64BE(ctr, 8);
    const c = crypto.createCipheriv('aes-128-ecb', BUNDLE_KEY, null);
    c.setAutoPadding(false);
    const ks = Buffer.concat([c.update(cb), c.final()]);
    const n = Math.min(16, boundary - off);
    for (let i = 0; i < n; i++) out[off + i] ^= ks[i];
    ctr += 1n;
  }
  return out;
}
const RARITY_WORDS = { SSR: 'SSR', SR: 'SR', R: 'R', BD: 'BD', EX: 'EX' };
// 属性颜色简称：红 / 蓝 / 绿 / 黄 / 紫（依次对应属性 1..5，
// 即 MasterText 里的 CardType_Red / Blue / Green / Yellow / Purple_Name）
const COLOR_WORDS = { 1: ['红', '红色'], 2: ['蓝', '蓝色'], 3: ['绿', '绿色'],
  4: ['黄', '黄色'], 5: ['紫', '紫色'] };
const DIFFS = ['EASY', 'NORMAL', 'HARD', 'EXPERT'];

let INDEX = null, SONGS = null, ALIASES = {};
let CHAR_ALIASES = {};                     // 角色 id → [别名]
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
INDEX = readJson(path.join(ON_DIR, 'index.json'), null);
SONGS = readJson(path.join(ON_DIR, 'songs.json'), null);
ALIASES = readJson(ALIAS_FILE, {});
CHAR_ALIASES = readJson(CHAR_ALIAS_FILE, {}) || {};
let SCORE = readJson(SCORE_FILE, {}) || {};   // 小游戏战绩：按 QQ 记答对次数
// 别名审核队列：加别名立即可用并进 pending；被 /on阻止 的进 blocked
// （黑名单按 类型 + 曲目 + 别名 记，别的曲子还能用同一个别名）
const REVIEW_FILE = path.join(ON_DIR, 'alias_review.json');
const REVIEW_TYPE = 'on别名';            // 曲子别名
const REVIEW_TYPE_CHAR = 'on角色别名';   // 角色别名
const REVIEW_TYPE_LABEL = '别名(on)';    // 队列里显示的样子
const typeLabel = (t) => (t === REVIEW_TYPE_CHAR ? '别名(角色)' : REVIEW_TYPE_LABEL);
const REVIEW = readJson(REVIEW_FILE, null) || {};
REVIEW.pending = Array.isArray(REVIEW.pending) ? REVIEW.pending : [];
REVIEW.blocked = Array.isArray(REVIEW.blocked) ? REVIEW.blocked : [];
function saveReview() {
  try { fs.writeFileSync(REVIEW_FILE, JSON.stringify(REVIEW, null, 1)); return true; }
  catch (e) { console.error('[on] 审核队列写入失败:', e.message); return false; }
}

function saveAliases() {
  try { fs.writeFileSync(ALIAS_FILE, JSON.stringify(ALIASES, null, 1)); return true; }
  catch (e) { console.error('[on] 别名写入失败:', e.message); return false; }
}

function saveScore() {
  try { fs.writeFileSync(SCORE_FILE, JSON.stringify(SCORE, null, 1)); return true; }
  catch (e) { console.error('[on] 战绩写入失败:', e.message); return false; }
}

function saveCharAliases() {
  try { fs.writeFileSync(CHAR_ALIAS_FILE, JSON.stringify(CHAR_ALIASES, null, 1)); return true; }
  catch (e) { console.error('[on] 角色别名写入失败:', e.message); return false; }
}

/** 角色的所有可认名字：index.json 里的 aliases + /on角色别名 登记的。
 *  纯数字的别名（index 里有 "1" 这种）不参与，免得猜卡直接打「1」就中。 */
function charNames(ch) {
  const out = [];
  const push = (a) => {
    const s = String(a == null ? '' : a).trim();
    if (s && !/^\d+$/.test(s) && out.indexOf(s) < 0) out.push(s);
  };
  if (ch) {
    for (const a of ch.aliases || []) push(a);
    push(ch.name);
    for (const a of CHAR_ALIASES[String(ch.id)] || []) push(a);
  }
  return out;
}

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/[\s　・·、,，.。!！?？~～\-—_'"“”‘’()（）\[\]【】:：;；/\\|+*&#@$%^]/g, '');

// ---------------------------------------------------------------- 角色
/** 把「团体 / 颜色」这类筛选词翻译成谓词；不是筛选就返回 null（交给角色/其它分支）。
 *  支持一个或两个词，例：MyGO!!!!! ／ 绯红 ／ MyGO 绯红。
 *  颜色用 index.json 的 typeName（绯红属性…），并额外接受去掉「属性」的简称。 */
function matchFilters(q) {
  if (!INDEX) return null;
  const bands = [...new Set(INDEX.characters.map((c) => c.band).filter(Boolean))];
  const typeOf = new Map();
  for (const [id, name] of Object.entries(INDEX.typeName || {})) {
    typeOf.set(norm(name), Number(id));
    typeOf.set(norm(String(name).replace('属性', '')), Number(id));
  }
  for (const [id, words] of Object.entries(COLOR_WORDS)) {
    for (const w of words) typeOf.set(norm(w), Number(id));
  }
  const byBand = (band) => (c) => {
    const ch = INDEX.characters.find((x) => x.id === c.char);
    return !!ch && ch.band === band;
  };
  const byType = (ty) => (c) => c.type === ty;
  const typeName = (ty) => INDEX.typeName[String(ty)] || String(ty);

  // 整串先试一次，避免 "Ave Mujica" 被拆成两个词重复匹配同一个团体
  const whole = norm(q);
  if (whole) {
    const b = bands.find((x) => norm(x) === whole);
    if (b) return { test: byBand(b), label: b };
    if (typeOf.has(whole)) {
      const ty = typeOf.get(whole);
      return { test: byType(ty), label: typeName(ty) };
    }
  }

  const tokens = String(q || '').split(/[\s　]+/).filter(Boolean);
  const tests = [];
  const labels = [];
  const seen = new Set();
  for (const t of tokens) {
    const n = norm(t);
    if (!n) return null;
    const band = bands.find((b) => {
      const bn = norm(b);
      return bn === n || (n.length >= 2 && bn.includes(n));
    });
    if (band) {
      if (seen.has('b:' + band)) continue;
      seen.add('b:' + band);
      tests.push(byBand(band));
      labels.push(band);
      continue;
    }
    if (typeOf.has(n)) {
      const ty = typeOf.get(n);
      if (seen.has('t:' + ty)) continue;
      seen.add('t:' + ty);
      tests.push(byType(ty));
      labels.push(typeName(ty));
      continue;
    }
    return null;                        // 有词不认识 → 不是筛选
  }
  if (!tests.length) return null;
  return { test: (c) => tests.every((f) => f(c)), label: labels.join(' ・ ') };
}

function resolveCharacter(q) {
  if (!INDEX) return null;
  const s = norm(q);
  if (!s) return null;
  let best = null;
  for (const ch of INDEX.characters) {
    for (const a of charNames(ch)) {
      const an = norm(a);
      if (an === s) return ch;
      if (an.includes(s) || s.includes(an)) {
        if (!best || an.length < best.len) best = { ch, len: an.length };
      }
    }
  }
  return best ? best.ch : null;
}

function parseCardQuery(arg) {
  const raw = (arg || '').trim();
  if (!raw) return { kind: 'help' };
  if (/^\d+$/.test(raw.replace(/\s+/g, ''))) return { kind: 'detail', id: Number(raw.replace(/\s+/g, '')) };
  const tokens = raw.split(/[\s　]+/).filter(Boolean);
  let rarity = null;
  const rest = [];
  for (const t of tokens) {
    const up = t.toUpperCase();
    if (!rarity && RARITY_WORDS[up]) rarity = up;
    else rest.push(t);
  }
  if (!rarity && rest.length) {
    const m = /^(.*?)(SSR|SR|R|BD|EX)$/i.exec(rest[rest.length - 1]);
    if (m && m[1]) { rest[rest.length - 1] = m[1]; rarity = m[2].toUpperCase(); }
  }
  const char = rest.join(' ').trim();
  return char ? { kind: 'grid', char, rarity } : { kind: 'help' };
}

// ---------------------------------------------------------------- 曲目搜索
function songNames(s) {
  const set = new Set();
  [s.title, s.title_tw, s.title_jp, s.title_en, s.phonetic].forEach((v) => { if (v) set.add(v); });
  (ALIASES[String(s.id)] || []).forEach((v) => set.add(v));
  return [...set];
}

function lcsRatio(a, b) {
  // 粗略的字符重合度（用于模糊匹配）
  if (!a || !b) return 0;
  const A = new Set(a.split('')), B = new Set(b.split(''));
  let inter = 0;
  A.forEach((c) => { if (B.has(c)) inter++; });
  const dice = (2 * inter) / (A.size + B.size);
  if (a.includes(b) || b.includes(a)) return Math.max(dice, 0.85) + Math.min(a.length, b.length) / 1000;
  return dice;
}

function resolveSong(q) {
  if (!SONGS) return null;
  const raw = String(q || '').trim();
  if (!raw) return null;
  if (/^\d{4,}$/.test(raw)) {
    const byId = SONGS.songs.find((s) => s.id === Number(raw));
    if (byId) return byId;
  }
  const s = norm(raw);
  let exact = null, sub = null, fuzzy = null;
  for (const song of SONGS.songs) {
    for (const name of songNames(song)) {
      const n = norm(name);
      if (!n) continue;
      if (n === s) { exact = exact || song; break; }
      if (n.includes(s) || s.includes(n)) {
        // 更长的匹配（更具体）优先
        if (!sub || n.length > sub.len) sub = { song, len: n.length };
      }
      const r = lcsRatio(n, s);
      if (r >= 0.72 && (!fuzzy || r > fuzzy.r)) fuzzy = { song, r };
    }
    if (exact) break;
  }
  return exact || (sub && sub.song) || (fuzzy && fuzzy.song) || null;
}

// 难度写法：ex / hd / nor / ez（也认全名），默认 EXPERT
const DIFF_WORDS = { easy: 'EASY', ez: 'EASY', normal: 'NORMAL', nor: 'NORMAL', nm: 'NORMAL',
  hard: 'HARD', hd: 'HARD', expert: 'EXPERT', ex: 'EXPERT' };

/** 把「曲名 [难度]」拆开；没写难度就用默认（EXPERT） */
function splitDiff(raw, def) {
  const s = String(raw || '').trim();
  const m = /^(.*?)[\s　]+([A-Za-z]+)$/.exec(s);
  if (m && m[1].trim() && DIFF_WORDS[m[2].toLowerCase()]) {
    return { q: m[1].trim(), diff: DIFF_WORDS[m[2].toLowerCase()] };
  }
  return { q: s, diff: def || 'EXPERT' };
}

function songLabel(s) {
  const jp = s.title_jp || s.title || '';
  const zh = s.title && s.title !== jp ? '（' + s.title + '）' : '';
  return jp + zh;
}

/** 「没找到」时的回复：优先列出最相近的前 5 首（比干列前 12 首有用得多） */
const songHelp = (q) => {
  const tips = q ? similarSongs(q, 5) : [];
  const head = q ? `没找到「${String(q).trim()}」。` : '没找到这首曲子。';
  if (!tips.length) {
    const list = (SONGS ? SONGS.songs : []).slice(0, 12).map((s) => songLabel(s)).join('、');
    return `${head}部分曲目：${list || '（曲目表缺失）'}\n可用 /on查曲 <曲名> 查询，或 /on添加别名 <原名> <别名> 登记别名。`;
  }
  return [head + '是不是想找这几首：']
    .concat(tips.map((t, i) => `${i + 1}. ${songLabel(t.song)}　#${t.song.id}`))
    .concat(['也可以直接发曲目 ID，或用 /on添加别名 <原名> <别名> 登记别名。'])
    .join('\n');
};

/** 最长公共子串长度（部分匹配比「字面重合度」更说明问题） */
function lcSubstr(a, b) {
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  let prev = new Array(lb + 1).fill(0), best = 0;
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1).fill(0);
    for (let j = 1; j <= lb; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/** 按相似度列候选曲目：精确 > 子串 > 0.5×字符重合度 + 0.5×最长公共子串占比
 *  （只靠字面重合度的话，短查询容易被"碰巧共享几个字"的标题压过去） */
function similarSongs(q, n, floor) {
  if (!SONGS) return [];
  const s = norm(q);
  if (!s) return [];
  n = n || 5;
  floor = floor == null ? 0.32 : floor;
  const out = [];
  for (const song of SONGS.songs) {
    let best = 0;
    for (const name of songNames(song)) {
      const nn = norm(name);
      if (!nn) continue;
      let sc;
      if (nn === s) sc = 1;
      else if (nn.includes(s) || s.includes(nn)) {
        sc = 0.9 + 0.09 * Math.min(nn.length, s.length) / Math.max(nn.length, s.length);
      } else {
        sc = 0.6 * lcsRatio(nn, s) +
             0.4 * lcSubstr(nn, s) / Math.max(nn.length, s.length);
        // 开头两个字对得上（如「天球…」vs「天球のうた」）比"碰巧共享两个字"可信得多
        if (nn.slice(0, 2) === s.slice(0, 2)) sc += 0.12;
      }
      if (sc > best) best = sc;
    }
    if (best >= floor) out.push({ song, score: best });
  }
  out.sort((a, b) => b.score - a.score || a.song.id - b.song.id);
  return out.slice(0, n);
}

// ---------------------------------------------------------------- 渲染/下载
function runPy(args, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, args, { cwd: ON_DIR });
    let log = '', done = false;
    const timer = setTimeout(() => {
      if (!done) { try { child.kill('SIGKILL'); } catch (e) {} reject(new Error('渲染超时')); }
    }, RENDER_TIMEOUT_MS);
    child.stdout.on('data', (d) => { log += d.toString(); });
    child.stderr.on('data', (d) => { log += d.toString(); });
    child.on('error', (e) => { done = true; clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      done = true; clearTimeout(timer);
      if (code === 0 && fs.existsSync(outPath)) resolve(outPath);
      else reject(new Error((log || '').trim().split('\n').slice(-2).join(' ') || ('退出码 ' + code)));
    });
  });
}

/** 跑一个 Python 脚本并把 stdout 收回来（runPy 要求有输出文件，这个不需要） */
function runPyOut(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, args, { cwd: ON_DIR });
    let log = '', done = false;
    const timer = setTimeout(() => {
      if (!done) { try { child.kill('SIGKILL'); } catch (e) {} reject(new Error('查询超时')); }
    }, RENDER_TIMEOUT_MS);
    child.stdout.on('data', (d) => { log += d.toString(); });
    child.stderr.on('data', (d) => { log += d.toString(); });
    child.on('error', (e) => { done = true; clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      done = true; clearTimeout(timer);
      if (code === 0) resolve(log.trim());
      else reject(new Error(log.trim().split('\n').slice(-2).join(' ') || ('退出码 ' + code)));
    });
  });
}

function curl(url, dest, auth) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '-m', '120', '-o', dest];
    if (auth) args.push('-u', auth);
    args.push(url);
    const child = spawn('curl', args);
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 512) resolve(dest);
      else reject(new Error('下载失败: ' + (err || code)));
    });
  });
}

/** 取谱面 JSON（缓存到 data/on/chart/<id>_<DIFF>.json）
 *  下载真实包名的 bundle（Bundle.load 解密要用真实包名做 nonce）
 *  → 解析 TextAsset（m_Name 后 4 字节小端长度 + script）→ 其中含 gzip 段 → 解压成 JSON */
async function ensureChart(song, diff) {
  try { fs.mkdirSync(CHART_DIR, { recursive: true }); } catch (e) {}
  const out = path.join(CHART_DIR, `${song.id}_${diff}.json`);
  if (fs.existsSync(out) && fs.statSync(out).size > 200) return out;
  const chart = (song.charts || []).find((c) => c.name === diff);
  if (!chart || !chart.bundle) throw new Error(`没有 ${diff} 谱面`);
  const bname = withBundle(chart.bundle);
  const tmp = path.join('/tmp', bname);           // 必须用真实包名
  await curl(`${SONGS.cdn}/${bname}`, tmp, SONGS.auth);
  const json = extractChartJson(tmp);
  fs.writeFileSync(out, json);
  try { fs.unlinkSync(tmp); } catch (e) {}
  return out;
}

/** 从谱面包里取出解压后的 JSON 文本 */
function extractChartJson(bundlePath) {
  let Bundle;
  try {
    Bundle = require(path.join(ON_DIR, 'unitysrc', 'bundle.js')).Bundle;
  } catch (e) {
    throw new Error('缺少 unitysrc（解析包体用）: ' + e.message);
  }
  const zlib = require('zlib');
  const b = Bundle.load(bundlePath);
  for (const e of b.listObjects()) {
    if (e.className !== 'TextAsset') continue;
    let raw;
    try { raw = b.rawObject(e); } catch (err) { continue; }
    const nameLen = raw.readUInt32LE(0);
    let off = (4 + nameLen + 3) & ~3;
    const scriptLen = raw.readUInt32LE(off);
    if (scriptLen <= 0 || off + 4 + scriptLen > raw.length) continue;
    const script = raw.subarray(off + 4, off + 4 + scriptLen);
    const gz = script.indexOf(Buffer.from([0x1f, 0x8b, 0x08]));
    if (gz < 0) continue;
    try {
      const text = zlib.gunzipSync(script.subarray(gz)).toString('utf8');
      JSON.parse(text);
      return text;
    } catch (err) { /* 换下一个对象 */ }
  }
  throw new Error('这个包里没有可解析的谱面数据');
}

// bundle → ACB（试听包的明文 MonoBehaviour、完整版包的分片+异或）见 tools/acb.js，
// 抽出去是为了让批处理测试和 bot 走同一份代码，不会再出现两边逻辑走偏。
const { acbFromBundle, fullBundleFor } = require(path.join(__dirname, 'tools', 'acb.js'));

/** 语音：缓存 mp3；没有就下载 bundle → 真 UnityFS 解包 → ACB → tools/hca_decode.py → ffmpeg。
 *  **优先用完整版**（1~5 分钟），目录里没有才退回试听包（~28 秒，缓存名加 .short）。
 *
 *  三个坑（都会让解码「看起来跑通、其实全是噪声」）：
 *   1. bundle 是 lz4hc 压缩的 UnityFS。直接在原始字节里 indexOf('@UTF') 拿到的是压缩残片
 *      ——表头看着像模像样，里面 HCA 的 rate/blocks 字段却是乱的。必须用 unitysrc 真正解包。
 *   2. 完整版包里的 ACB 是分片 + 单字节异或的，见 acbFromBundle()。
 *   3. HCA 载荷用「基础密钥 × AFS2 subkey」推出的表替换，块尾 CRC16 覆盖的是密文。
 *      细节与实测见 tools/hca_dec.c。 */
  /** 音频能用吗：ffprobe 看时长，太短/打不开就当半截文件删掉重做。
   *  （踩过：转码被中断留下 256KB 的半截 mp3，缓存只看 size>4096 就认了，
   *   结果 /on听曲 发出去的语音播不出来，用户看到的就是「获取不到」） */
function audioOk(file, minSec) {
  return new Promise((resolve) => {
    if (!file || !fs.existsSync(file)) return resolve(false);
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) { return resolve(false); }
    if (size < 8192) return resolve(false);
    const c = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    let out = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.on('error', () => resolve(true));            // 没有 ffprobe 就别卡住，放行
    c.on('close', () => {
      const dur = Number(String(out).trim()) || 0;
      // mp3 头里写着完整时长，光看 duration 抓不到「播到一半就断」的文件
      // （实测：截断到 256KB 的 106 秒曲子，ffprobe 仍报 106.67s）。
      // 我们统一用 libmp3lame 128k 转码，所以按 16KB/秒 估应有大小，明显偏小就是半截。
      const expect = dur * 16000;
      const short_ = dur < (minSec || 5);
      const truncated = expect > 20000 && size < expect * 0.5;
      if (!short_ && !truncated) return resolve(true);
      console.log(`[on] 缓存音频不完整（${path.basename(file)} ${(size / 1024).toFixed(0)}KB `
        + `${dur.toFixed(1)}s${truncated ? `，应有约 ${(expect / 1024).toFixed(0)}KB` : ''}）→ 删掉重做`);
      try { fs.unlinkSync(file); } catch (e) {}
      resolve(false);
    });
  });
}

async function ensureAudio(song, opts) {
  try { fs.mkdirSync(AUDIO_DIR, { recursive: true }); } catch (e) {}
  if (!song.acbBundle) throw new Error('这首曲子没有对应的音频包');

  // opts.short：只要试听包（~28 秒，包小、下得快），猜曲这类只用 3 秒的场合用
  const full = (opts && opts.short) ? null : fullBundleFor(song.acbBundle);
  const want = full || song.acbBundle;
  const mp3 = path.join(AUDIO_DIR, `${song.id}${full ? '' : '.short'}.mp3`);
  if (fs.existsSync(mp3) && await audioOk(mp3, full ? 20 : 5)) return mp3;

  const bundle = path.join('/tmp', `onacb_${song.id}.bundle`);
  await curl(`${SONGS.cdn}/${withBundle(want)}`, bundle, SONGS.auth);

  let Bundle;
  try {
    Bundle = require(path.join(ON_DIR, 'unitysrc', 'bundle.js')).Bundle;
  } catch (e) {
    throw new Error('缺少 unitysrc（解析包体用）: ' + e.message);
  }
  const acbBuf = acbFromBundle(Bundle.load(bundle));
  if (!acbBuf) throw new Error('包里没找到 ACB(@UTF)');
  const acb = path.join('/tmp', `onacb_${song.id}.acb`);
  fs.writeFileSync(acb, acbBuf);

  const wav = path.join('/tmp', `onacb_${song.id}.wav`);
  await new Promise((res, rej) => {
    const c = spawn('python3', [path.join(__dirname, 'tools', 'hca_decode.py'), acb, wav]);
    let log = '';
    c.stdout.on('data', (d) => { log += d.toString(); });
    c.stderr.on('data', (d) => { log += d.toString(); });
    c.on('close', (code) => (code === 0 && fs.existsSync(wav)
      ? res() : rej(new Error('解码失败: ' + log.slice(-160)))));
  });
  await new Promise((res, rej) => {
    const c = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav,
      '-codec:a', 'libmp3lame', '-b:a', '128k', mp3]);
    let log = '';
    c.stderr.on('data', (d) => { log += d.toString(); });
    c.on('close', (code) => {
      if (code === 0 && fs.existsSync(mp3)) return res();
      try { fs.unlinkSync(mp3); } catch (e) {}          // 半截文件绝不留在缓存里
      rej(new Error('转码失败: ' + log.slice(-120)));
    });
  });
  [bundle, acb, wav].forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });
  return mp3;
}

// ---------------------------------------------------------------- 注册
function register({ commands, sendReply, imageCqFromPath, CONFIG }) {
  // ---------------- 帮助
  const HELP_MAIN = [
    'Our Notes 指令一览（中英文名都认，全部以 /on 开头）',
    '',
    '【卡片】',
    '/on查卡 <角色> [星级]         该角色的卡片列表图',
    '/on查卡 <团体|颜色> [星级]    按团体 / 颜色筛卡',
    '/on查卡 <数字ID>              单卡详情图',
    '/on留影 [角色]                留影卡缩略图一览（不给角色就发全部）',
    '/on留影 <数字ID>              单张留影详情图（完整图 + 角色/属性/技能/日记）',
    '　星级 SSR / SR / R / BD / EX',
    '　团体 MyGO!!!!! / Ave Mujica / millsage / 一家Dumb Rock! / 梦限大MewType',
    '　颜色 红 / 蓝 / 绿 / 黄 / 紫',
    '　例 /on查卡 灯　/on查卡 MyGO 蓝 SSR　/on查卡 12',
    '',
    '【曲目】',
    '/on查曲 <曲名|别名>           曲目卡：封面・作曲作词・BPM・时长・四难度定数',
    '/on听曲 <曲名|别名>           歌曲语音（有完整版就发完整版）',
    '/on听 [角色]                  角色语音：随机一条 + 中文文本',
    '/on谱面预览 <曲名|别名> [难度]  谱面图（查谱面 = 同一条指令）',
    '　难度 ex / hd / nor / ez（默认 ex），也认全名',
    '　例 /on查曲 迷星叫　/on听曲 天球のうた　/on谱面预览 迷星叫 HARD',
    '',
    '【图鉴・排行】',
    '/on小漫画 [角色]              随机一张加载漫画（不给角色就随机）',
    '/on卡池                       当期招募一览图（封面・概率・Pick Up）',
    '/on歌榜组卡 [skip]            为所有活动歌曲分别推荐队伍',
    '/on活动组卡 [skip]            推荐刷 CP、PT、徽章的歌曲和队伍（同图）',
    '/on激奏组卡 [平均|歌曲] [skip] 激奏跨曲参考或指定歌曲',
    '/on自由组卡 [平均|歌曲] [skip] 自由模式跨曲平均或指定歌曲',
    '/on日常组卡 [skip]            日常收益最强的选歌和队伍（清火组卡同义）',
    '　指定歌曲：服务器计算并发图；其他组卡：返回网页勾选计算。',
    '　例 /on自由组卡 春日影　/on激奏组卡 春日影 skip',
    '　云端保存并复用，计算完成后自动发图：https://on.tabsac.com/#plan',
    '/on活动                       当期活动一览图（活动曲・加成・点数奖励）',
    '/on表情 [角色|ID|页2]        表情图鉴 / 原图',
    '/on贴纸 [角色|ID|页2]        贴纸收藏 / 原图',
    '/on难度排行 [难度] [整数]      难度排行图',
    '　例 /on难度排行 25（EXPERT 25.0~25.9）　/on难度排行 ex 25　/on难度排行 hd',
    '/on效益排行 [难度] [整数]      效益排行（单局理论最高分，针对查曲）',
    '/on效率排行 [难度] [整数]      效率排行（效益 ÷ 时长）',
    '',
    '【小游戏】',
    '/on猜卡 [大|中|小]            只看卡面的一小块，猜是哪个角色（R 卡不参与）',
    '/on猜曲                       听 3 秒音频，猜是哪首歌',
    '/on猜语音                     听 3 秒语音，猜是哪个角色',
    '/回答 <答案>                  回答当前这一局（/答、/猜 同义）',
    '/结束                         放弃这一局并公布答案',
    '　猜答案不用一字不差，写别名或很接近的写法都算对。',
    '　一局 1 分钟（谜面发完开始计时，到点自动公布答案）；一个会话同时只能开一局。',
    '　答错时显示提示；名称相近时会列出候选答案。',
    '',
    '【成绩与账号】',
    '/onb25                        查看已保存的 B25 成绩图片',
    '/on绑定网页 <6 位码>          绑定网页账号与当前 QQ',
    '网页版：https://on.tabsac.com/',
    '',
    '【其它】',
    '/on添加别名 <原名> <别名>      给曲子登记别名',
    '/on角色别名 <角色> <别名>      给角色登记别名',
    '/onhelp [指令]                这条帮助；带上指令名看单条用法',
    '',
    '曲名记不全也没关系，会按相似度列出最接近的几首。',
  ].join('\n');

  // 单条指令的详细用法（/onhelp <指令>）
  const HELP_DETAIL = {
    '活动组卡': ['用法：/on活动组卡 [skip]', '分别推荐刷 CP、活动 PT、徽章的歌曲和队伍，合为一张图。默认非 Skip（AP参考），可加 skip。', '优先返回云端已保存的对应组卡图片；没有匹配结果时返回网页链接，勾选活动收益及 Skip / 非 Skip 后计算并同步云端。https://on.tabsac.com/#plan'],
    '歌榜组卡': ['用法：/on歌榜组卡 [skip]', '对当前活动的所有歌曲分别推荐最高分队伍。默认非 Skip；加 skip 比较跳过分。优先返回云端已保存的对应歌榜图片；没有匹配结果时提示在网页计算并同步。'],
    '激奏组卡': ['用法：/on激奏组卡 [平均|曲名] [skip]', '不填歌曲或填平均：优先返回云端已保存的平均组卡图片，没有匹配结果才返回网页链接；指定歌曲：服务器计算并发送该曲队伍。', '例：/on激奏组卡 春日影　/on激奏组卡 平均', '当前采用单人任务模型与区间首位假设，仅为激奏参考，不能预测多人连胜。Skip只比较跳过分，不触发激奏任务。'],
    '自由组卡': ['用法：/on自由组卡 [平均|曲名] [skip]', '不填歌曲或填平均：优先返回云端已保存的自由组卡图片，没有匹配结果才提示网页计算并同步；指定歌曲：服务器计算并发送该曲队伍。', '例：/on自由组卡 春日影　/on自由组卡 平均 skip'],
    '日常组卡': ['用法：/on日常组卡 [skip]，或 /on清火组卡 [skip]', '两条指令同义，优先返回云端已保存的对应图片，没有匹配结果才提示在网页勾选日常 / 清火组卡计算每 Boost 收益更高的歌曲及队伍，同时列出 CP、PT、徽章目标。默认非 Skip，可添加 skip。'],
    '组卡': ['网页：https://on.tabsac.com/#plan', '指令：/on歌榜组卡、/on活动组卡、/on激奏组卡、/on自由组卡、/on日常组卡（或/on清火组卡）。', '均可添加 skip，只有激奏与自由支持歌曲名称或平均。默认非 Skip、最高可用难度、4 Boost。', '网页导入并同步卡库：https://on.tabsac.com/#account；绑定 QQ：https://on.tabsac.com/#cloud', '指定歌曲由机器人提交服务器计算并发图；其他指令先返回云端已保存的对应结果图片，没有匹配结果才返回网页链接，勾选后计算并同步。更多目标会变慢。激奏目前为单人任务模型参考，尚不代表多人连胜。'],
    'B25': ['用法：/onb25', '查看保存在云端的 B25 成绩图片。', '导入账号包：https://on.tabsac.com/#account', '保存成绩：https://on.tabsac.com/#b25', '绑定 QQ：https://on.tabsac.com/#cloud'],
    '查卡': ['/on查卡（/oncard）',
      '用法 /on查卡 <角色> [星级]　/on查卡 <团体|颜色> [星级]　/on查卡 <数字ID>',
      '按角色或按团体 / 颜色发卡片列表图；给数字 ID 就发单卡详情图。',
      '星级 SSR / SR / R / BD / EX',
      '团体 MyGO!!!!! / Ave Mujica / millsage / 一家Dumb Rock! / 梦限大MewType',
      '颜色 红 / 蓝 / 绿 / 黄 / 紫',
      '例 /on查卡 灯　/on查卡 MyGO 蓝 SSR　/on查卡 12'],
    '留影': ['/on留影（/onsupport、/on留影卡）',
      '用法 /on留影 [角色]　/on留影 <数字ID>',
      '留影卡（support card）：发缩略图一览；写角色名就只看该角色的；写数字 ID 就发单张详情图（完整图 + 角色 / 属性 / 三维上限 / 技能 / 日记）。',
      '例 /on留影　/on留影 峰月律　/on留影 64'],
    '查曲': ['/on查曲（/onsong、/on曲）',
      '用法 /on查曲 <曲名|别名>',
      '发一张曲目卡：封面、作曲 / 作词 / 编曲、MV、发布时间、BPM、时长、主唱，以及四个难度的定数与物量。',
      '例 /on查曲 迷星叫　/on查曲 mayoiuta'],
    '听曲': ['/on听曲（/onlisten、/on听歌）',
      '用法 /on听曲 <曲名|别名>',
      '发这首歌的语音：有完整版就发完整版，没有则发游戏内试听片段，随后补一张曲目卡。',
      '例 /on听曲 迷星叫　/on听曲 天球のうた'],
    '角色语音': ['/on听（/onvoice、/on语音）',
      '用法 /on听 [角色]',
      '随机发一条该角色的语音，并把这条语音的中文文本用双引号一起发出；不给角色就随机一个角色。',
      '例 /on听 灯　/on听 祥子　/on听'],
    '谱面预览': ['/on谱面预览（/onchart、/on查谱面、/on谱面）',
      '用法 /on谱面预览 <曲名|别名> [难度]',
      '把整首谱面画成一张长图；难度 ex / hd / nor / ez（默认 ex），写全名也行。',
      '例 /on谱面预览 迷星叫　/on谱面预览 迷星叫 hd'],
    '小漫画': ['/on小漫画（/oncomic）',
      '用法 /on小漫画 [角色]',
      '随机发一张游戏的加载小漫画；写角色名就只看该角色的那几张（每个角色各有一张）。',
      '例 /on小漫画　/on小漫画 灯'],
    '活动': ['/on活动（/onevent）',
      '用法 /on活动',
      '当前进行中的活动，画成一张图：活动主视觉、活动曲（含四难度等级）、Pick Up 卡、加成（成员卡 / 留影卡，界限突破 0→4 的百分比）、点数奖励档位。'],
    '卡池': ['/on卡池（/ongacha、/on招募）',
      '用法 /on卡池',
      '当前正在开的招募，画成一张图：卡池封面、活动期间、各星级概率、Pick Up 卡片。'],
    '表情': ['用法：/on表情 [角色|ID|页2]（/onstamp、/onemote）', '查看表情图鉴；ID 查看游戏透明原图。', '例：/on表情 灯　/on表情 1　/on表情 页2', '当前素材没有独立文字层，暂不支持替换周围文字。'],
    '贴纸': ['用法：/on贴纸 [角色|ID|页2]（/onsticker）', '一张图展示全部贴纸；预览放大裁切，ID 查看完整原图。传包后按已有 / 未拥有展示，有公开资料时显示玩家信息。', '例：/on贴纸　/on贴纸 1　/on贴纸 页2', '传包：https://on.tabsac.com/#account　绑定 QQ：https://on.tabsac.com/#cloud'],
    '难度排行': ['/on难度排行（/onrank、/on排行）',
      '用法 /on难度排行 [难度] [整数]',
      '难度 ex / hd / nor / ez（默认 ex）；写了整数就只列这一段，如 25 → 25.0~25.9。',
      '例 /on难度排行 25　/on难度排行 ex 25　/on难度排行 hd'],
    '效益排行': ['/on效益排行（/onbenefit）',
      '用法 /on效益排行 [难度] [整数难度]',
      '按「单局理论最高分」排序：基础分 × Σ(1+连击加成) × (1+技能加成)，连击数与加成都取自游戏主数据。',
      '例 /on效益排行　/on效益排行 hd 17'],
    '效率排行': ['/on效率排行（/oneff）',
      '用法 /on效率排行 [难度] [整数难度]',
      '与效益排行同一套分数，再除以歌曲时长（分/秒），适合找「短而高分」的曲子。',
      '例 /on效率排行　/on效率排行 ez'],
    '添加别名': ['/on添加别名（/onalias、/on别名）',
      '用法 /on添加别名 <原名> <别名>',
      '登记之后 /on查曲、/on听曲、/on谱面预览 都能用这个别名，同时进入待审核队列。',
      '例 /on添加别名 迷星叫 mayoiuta'],
    '角色别名': ['/on角色别名（/oncharalias）',
      '用法 /on角色别名 <角色> <别名>',
      '给角色登记别名：之后 /on查卡、/on听、/on小漫画、/on猜卡、/on猜语音 都能用这个名字，同时进入待审核队列。',
      '例 /on角色别名 高松灯 tomorin　/on角色别名 丰川祥子 祥子'],
    '猜卡': ['/on猜卡（/onguesscard）',
      '用法 /on猜卡 [大|中|小]',
      '随机抽一张非 R 卡，只发卡面里极小的一块（默认 160px，约卡面的十分之一），猜这是哪个角色。',
      '　大 = 240px 好认一点　中 = 160px（默认）　小 = 100px 更难',
      '答：/回答 <角色名>（/答、/猜 同义；别名、日文名、写得很接近都算对）；放弃就 /结束。',
      '时限 1 分钟（谜面发完开始计时），一个会话同时只能有一局。'],
    '猜曲': ['/on猜曲（/onguesssong）',
      '用法 /on猜曲',
      '随机抽一首曲子，发其中 3 秒音频，猜曲名。',
      '只发 3 秒音频、不带文字；答：/回答 <曲名>（别名与相近写法都算对）；放弃就 /结束。',
      '时限 1 分钟（谜面发完开始计时），一个会话同时只能有一局。'],
    '猜语音': ['/on猜语音（/onguessvoice）',
      '用法 /on猜语音',
      '随机抽一条角色语音，发其中 3 秒，猜是哪个角色。',
      '答：/回答 <角色名>；放弃就 /结束。',
      '时限 1 分钟（谜面发完开始计时），一个会话同时只能有一局。'],
    '回答': ['/回答（/答、/猜 同义）',
      '用法 /回答 <答案>',
      '回答 /on猜卡、/on猜曲、/on猜语音 开的那一局，答错可以继续答（最多 6 次，之后自动公布答案）。',
      '答对会记一次战绩（按 QQ），并回一句「你答对过 N 次」。'],
    '结束': ['/结束（/放弃 同义）',
      '用法 /结束',
      '结束当前这一局并公布答案（猜卡会连完整卡面一起发出来）。'],
  };

  // /onhelp 的参数 → 上面的键（中英文名与常用简称都认）
  const HELP_ALIAS = {
    '歌榜组卡': '歌榜组卡', '激奏组卡': '激奏组卡', '自由组卡': '自由组卡', '日常组卡': '日常组卡', '清火组卡': '日常组卡',
    '组卡': '组卡', '配队': '组卡', '多目标组卡': '组卡',
    '活动组卡': '活动组卡',
    'b25': 'B25', 'b25成绩': 'B25', '成绩卡': 'B25',
    'card': '查卡', '查卡': '查卡', '卡片': '查卡',
    'support': '留影', '留影': '留影', '留影卡': '留影',
    'song': '查曲', '曲': '查曲', '查曲': '查曲', '曲目': '查曲',
    'listen': '听曲', '听曲': '听曲', '听歌': '听曲',
    'voice': '角色语音', '语音': '角色语音', '听': '角色语音',
    'chart': '谱面预览', '谱面预览': '谱面预览', '谱面': '谱面预览',
    'chartinfo': '谱面预览', '查谱面': '谱面预览', '谱面数据': '谱面预览',
    'comic': '小漫画', '小漫画': '小漫画', '漫画': '小漫画',
    'gacha': '卡池', '卡池': '卡池', '招募': '卡池',
    'event': '活动', '活动': '活动', '活动一览': '活动',
    'stamp': '表情', 'emote': '表情', '表情': '表情', 'sticker': '贴纸', '贴纸': '贴纸',
    'rank': '难度排行', '难度排行': '难度排行', '排行': '难度排行',
    'benefit': '效益排行', '效益排行': '效益排行', '效益': '效益排行',
    'eff': '效率排行', 'efficiency': '效率排行', '效率排行': '效率排行', '效率': '效率排行',
    'alias': '添加别名', '别名': '添加别名', '添加别名': '添加别名',
    'charalias': '角色别名', '角色别名': '角色别名', '别名角色': '角色别名',
    'guesscard': '猜卡', '猜卡': '猜卡', 'gcard': '猜卡',
    'guesssong': '猜曲', '猜曲': '猜曲', 'gsong': '猜曲',
    'guessvoice': '猜语音', '猜语音': '猜语音', 'gvoice': '猜语音',
    'answer': '回答', '回答': '回答', '答': '回答', '猜': '回答',
    'end': '结束', '结束': '结束', '放弃': '结束',
    'help': '帮助', '帮助': '帮助', '说明': '帮助',
  };

  /** /onhelp [指令]：不给参数发总览，给了就看单条用法 */
  function helpFor(arg) {
    const q = String(arg || '').trim();
    if (!q) return HELP_MAIN;
    const key = HELP_ALIAS[norm(q)] || HELP_ALIAS[q.toLowerCase()];
    if (key === '帮助') return HELP_MAIN;
    if (key && HELP_DETAIL[key]) return HELP_DETAIL[key].join('\n');
    return `没有「${q}」这条指令。可以查：${Object.keys(HELP_DETAIL).join('、')}\n直接发 /onhelp 看全部指令。`;
  }

  const target = (msg) => (msg.message_type === 'private'
    ? { action: 'send_private_msg', base: { user_id: msg.sender.user_id } }
    : { action: 'send_group_msg', base: { group_id: msg.group_id } });
  const replyText = (ws, msg, text) => {
    const t = target(msg);
    sendReply(ws, t.action, Object.assign({}, t.base, { message: text }));
  };
  const replyImage = (ws, msg, file) => {
    const t = target(msg);
    sendReply(ws, t.action, Object.assign({}, t.base, { message: imageCqFromPath(file) }));
  };
  const replyMixed = (ws, msg, segs) => {
    const t = target(msg);
    sendReply(ws, t.action, Object.assign({}, t.base, { message: segs }));
  };
  const errText = (e) => String((e && e.message) || e).slice(0, 140);

  /** 卡面目录最后变动时间：新卡面/新缩略图写进来时目录 mtime 会变。
   *  卡片图是按 id 缓存的，缓存比卡面旧就说明「这张是缺图时画的」，必须重画
   *  （踩过：新卡上线后 /on查卡 一直发旧图，因为 detail_61.png / grid_15.png 是缺图时生成的）。 */
  function artStamp() {
    let t = 0;
    for (const d of ['thumb', 'full', 'support', 'support_full', 'jacket', 'event']) {
      try { t = Math.max(t, fs.statSync(path.join(ON_DIR, 'art', d)).mtimeMs); } catch (e) {}
    }
    return t;
  }

  /** 缓存文件是否还新（比卡面目录新才算新） */
  function cacheFresh(file) {
    try {
      if (!fs.existsSync(file) || fs.statSync(file).size < 1024) return false;
      return fs.statSync(file).mtimeMs >= artStamp();
    } catch (e) { return false; }
  }

  // ---------------- 卡片
  async function handleCard(ws, msg, arg) {
    const q = parseCardQuery(arg);
    if (q.kind === 'help') return replyText(ws, msg, helpFor('查卡'));
    if (q.kind === 'detail') {
      try {
        const out = path.join(CACHE_DIR, `detail_${q.id}.png`);
        const f = cacheFresh(out) ? out : await runPy(['cardimg.py', 'detail', '--id', String(q.id), '--out', out], out);
        return replyImage(ws, msg, f);
      } catch (e) {
        if (/没有 ID=/.test(errText(e))) {
          const n = INDEX && INDEX.cards.length ? INDEX.cards.length : 0;
          return replyText(ws, msg, `没有 ID=${q.id} 的卡片（本版本共 ${n} 张：1–${n}）。`);
        }
        console.error('[on] 详情失败:', errText(e));
        return replyText(ws, msg, '图片生成失败：' + errText(e));
      }
    }
    // 团体 / 颜色 筛选：/on查卡 MyGO!!!!! ／ /on查卡 绯红 ／ /on查卡 MyGO 绯红 SSR
    const sel = matchFilters(q.char);
    if (sel) {
      let picked = INDEX.cards.filter(sel.test);
      const rar = q.rarity ? { SSR: 4, SR: 3, R: 2, BD: 10, EX: 20 }[q.rarity] : null;
      if (rar) picked = picked.filter((c) => c.rarity === rar);
      if (!picked.length) {
        return replyText(ws, msg, `没有符合条件的卡片（${sel.label}${q.rarity ? ' ' + q.rarity : ''}）。`);
      }
      picked.sort((a, b) => a.char - b.char || a.rarity - b.rarity);
      const key = ('sel_' + norm(sel.label) + (q.rarity ? '_' + q.rarity : '')).replace(/[^\w\u4e00-\u9fa5]+/g, '_');
      const out = path.join(CACHE_DIR, key + '.png');
      try {
        const f = cacheFresh(out) ? out
          : await runPy(['cardimg.py', 'grid', '--ids', picked.map((c) => c.id).join(','),
            '--title', sel.label,
            '--sub', (q.rarity ? q.rarity + ' ・ ' : '') + picked.length + ' 张',
            '--out', out], out);
        return replyImage(ws, msg, f);
      } catch (e) {
        console.error('[on] 筛选网格失败:', errText(e));
        return replyText(ws, msg, '图片生成失败：' + errText(e));
      }
    }
    const ch = resolveCharacter(q.char);
    if (!ch) {
      const names = INDEX ? INDEX.characters.map((c) => c.name).join('、') : '';
      return replyText(ws, msg, `没有找到角色「${q.char}」。可用角色：${names}`);
    }
    let cards = ch.cards;
    if (q.rarity) {
      const want = { SSR: 4, SR: 3, R: 2, BD: 10, EX: 20 }[q.rarity];
      cards = cards.filter((c) => c.rarity === want);
      if (!cards.length) {
        const have = [...new Set(ch.cards.map((c) => (INDEX.rarityLabel || {})[c.rarity] || c.rarity))].join('/');
        return replyText(ws, msg, `${ch.name} 没有 ${q.rarity} 卡（现有：${have}）`);
      }
    }
    const key = `grid_${ch.id}${q.rarity ? '_' + q.rarity : ''}`;
    const out = path.join(CACHE_DIR, key + '.png');
    try {
      const f = cacheFresh(out) ? out
        : await runPy(['cardimg.py', 'grid', '--char', ch.name].concat(q.rarity ? ['--rarity', q.rarity] : []).concat(['--out', out]), out);
      return replyImage(ws, msg, f);
    } catch (e) {
      console.error('[on] 网格失败:', errText(e));
      return replyText(ws, msg, '图片生成失败：' + errText(e));
    }
  }

  // ---------------- 留影卡（/on留影）
  const SUP_DIR = path.join(ON_DIR, 'art', 'support');
  let SUPPORTS = null;
  function supports() {
    if (SUPPORTS) return SUPPORTS;
    SUPPORTS = [];
    try {
      const chars = new Map(((readJson(path.join(ON_DIR, 'master', 'MasterCharacter.json'), {}) || {})._allData || []).map((c) => [c._id, c]));
      const txt = new Map(((readJson(path.join(ON_DIR, 'master', 'MasterText.json'), {}) || {})._allData || []).map((r) => [String(r._id), r]));
      const zh = (id) => { const r = txt.get(String(id)) || {}; return (r._simplifiedChinese || r._japanese || '').trim(); };
      SUPPORTS = ((readJson(path.join(ON_DIR, 'master', 'MasterSupportCard.json'), {}) || {})._allData || []).map((c) => ({
        id: c._id, title: zh(c._descriptionTextID), rarity: c._rarity, type: c._cardType,
        chars: (c._characterIDs || []).map((i) => (chars.get(i) ? zh(chars.get(i)._nameTextID) : '')).filter(Boolean),
      }));
    } catch (e) { console.error('[on] 留影表读取失败:', errText(e)); }
    return SUPPORTS;
  }

  async function handleSupport(ws, msg, arg) {
    const raw = String(arg || '').trim();
    if (!raw) {
      // 不给条件就发全量一览（4 列，免得图太长）
      const out = path.join(CACHE_DIR, 'supportgrid_all.png');
      try {
        const f = cacheFresh(out) ? out
          : await runPy(['supportimg.py', 'grid', '--cols', '4', '--out', out], out);
        return replyImage(ws, msg, f);
      } catch (e) {
        console.error('[on] 留影一览失败:', errText(e));
        return replyText(ws, msg, '留影图生成失败：' + errText(e));
      }
    }
    if (/^\d+$/.test(raw.replace(/\s+/g, ''))) {
      const id = Number(raw.replace(/\s+/g, ''));
      const out = path.join(CACHE_DIR, `support_${id}.png`);
      try {
        const f = cacheFresh(out) ? out : await runPy(['supportimg.py', 'detail', '--id', String(id), '--out', out], out);
        return replyImage(ws, msg, f);
      } catch (e) {
        if (/没有 ID=/.test(errText(e))) {
          const n = supports().length;
          return replyText(ws, msg, `没有 ID=${id} 的留影卡（本版本共 ${n} 张：1–${n}）。`);
        }
        console.error('[on] 留影详情失败:', errText(e));
        return replyText(ws, msg, '留影图生成失败：' + errText(e));
      }
    }
    const ch = resolveCharacter(raw);
    if (!ch) {
      const names = INDEX ? INDEX.characters.map((c) => c.name).join('、') : '';
      return replyText(ws, msg, `没有找到角色「${raw}」。可用角色：${names}`);
    }
    const key = `supportgrid_${ch.id}`;
    const out = path.join(CACHE_DIR, key + '.png');
    try {
      const f = cacheFresh(out) ? out
        : await runPy(['supportimg.py', 'grid', '--char', ch.name, '--out', out], out);
      return replyImage(ws, msg, f);
    } catch (e) {
      if (/没有符合条件/.test(errText(e))) return replyText(ws, msg, `「${ch.name}」还没有留影卡。`);
      console.error('[on] 留影网格失败:', errText(e));
      return replyText(ws, msg, '留影图生成失败：' + errText(e));
    }
  }

  // ---------------- 曲目卡
  async function handleSong(ws, msg, q) {
    const song = resolveSong(q);
    if (!song) return replyText(ws, msg, songHelp(q));
    try {
      let chartPath = null;
      for (const d of ['EXPERT', 'HARD', 'NORMAL', 'EASY']) {
        if ((song.charts || []).some((c) => c.name === d)) {
          try { chartPath = await ensureChart(song, d); break; } catch (e) { /* 换下一个难度 */ }
        }
      }
      const out = path.join(CACHE_DIR, `song_${song.id}.png`);
      const args = ['songimg.py', 'song', '--id', String(song.id), '--aliases', ALIAS_FILE, '--out', out];
      if (chartPath) args.push('--chart', chartPath);
      // 曲目卡随别名变化，命中缓存但别名有更新时重画
      const st = fs.existsSync(out) ? fs.statSync(out) : null;
      const aSt = fs.existsSync(ALIAS_FILE) ? fs.statSync(ALIAS_FILE) : null;
      const fresh = st && (!aSt || st.mtimeMs > aSt.mtimeMs);
      const f = fresh ? out : await runPy(args, out);
      return replyImage(ws, msg, f);
    } catch (e) {
      console.error('[on] 曲目卡失败:', errText(e));
      return replyText(ws, msg, '曲目卡生成失败：' + errText(e));
    }
  }

  // ---------------- 听曲
  async function handleListen(ws, msg, q) {
    const song = resolveSong(q);
    if (!song) return replyText(ws, msg, songHelp(q));
    let mp3 = null;
    try {
      mp3 = await ensureAudio(song);
    } catch (e) {
      console.log('[on] 语音不可用:', errText(e));
    }
    if (!mp3) {
      replyText(ws, msg, `「${songLabel(song)}」的语音暂时拿不到（音频包解码失败），先发曲目卡：`);
      return handleSong(ws, msg, String(song.id));
    }
    replyMixed(ws, msg, [{ type: 'record', data: { file: 'file://' + mp3 } }]);
    const segs = [{ type: 'text', data: { text: '播放 ' + songLabel(song) } }];
    const jk = path.join(ON_DIR, 'art', 'jacket', (song.jacket || '') + '.jpg');
    if (song.jacket && fs.existsSync(jk)) segs.push({ type: 'image', data: { file: 'file://' + jk } });
    replyMixed(ws, msg, segs);
  }

  // ---------------- 角色语音（/on听 <角色>） ----------------
  const CRI_URL = readJson(path.join(ON_DIR, 'cri_url.json'), {}) || {};   // tools/cri_url.py 生成
  const VOICE_DIR = path.join(ON_DIR, 'audio', 'voice');
  const CRI_DIR = path.join('/tmp', 'on_cri');
  let SOUND_MAP = null;      // soundId -> {cue, sheet, textId}
  let VOICES = null;         // [{char, soundId, textId, from}]
  let BUNDLE_NAMES = null;   // bundle_inventory.json 里的包名清单

  function bundleNames() {
    if (BUNDLE_NAMES) return BUNDLE_NAMES;
    BUNDLE_NAMES = [];
    try {
      const inv = readJson(path.join(ON_DIR, 'bundle_inventory.json'), {});
      BUNDLE_NAMES = (Array.isArray(inv) ? inv : (inv.names || inv.bundles || [])) || [];
    } catch (e) { console.error('[on] 资源包清单读取失败:', errText(e)); }
    return BUNDLE_NAMES;
  }

  /** 一个 cue sheet 的音频包位置。两套打包方式：
   *  ① 独立 raw ACB —— catalog 里有 location，cri_url.json 给出公开 URL（不带 .bundle 后缀，无需凭据）
   *  ② 内嵌在 bundle 里 —— catalog 里没有 location，ACB 作为 MonoBehaviour 装在
   *     cri_assets_cri_sound_<sheet>_<hash>.bundle 中（下载要走 CDN 凭据）
   *  返回 { url } / { bundle }，都没有就是 null。 */
  function voicePack(sheetName) {
    const key = String(sheetName || '').toLowerCase();
    if (!key) return null;
    const hit = (CRI_URL[sheetName] || CRI_URL[key] || [])[0];
    if (hit && hit.url) return { url: hit.url };
    const pre = 'cri_assets_cri_sound_' + key + '_';
    for (const n of bundleNames()) {
      if (n.startsWith(pre) && /^[0-9a-f]{32}\.bundle$/.test(n.slice(pre.length))) return { bundle: n };
    }
    return null;
  }

  /** soundId → cue 名 + cueSheet（MasterSound / MasterSoundCueSheet），顺带带出文本 id */
  function soundMap() {
    if (SOUND_MAP) return SOUND_MAP;
    SOUND_MAP = new Map();
    try {
      const sheet = new Map();
      for (const r of (readJson(path.join(ON_DIR, 'master', 'MasterSoundCueSheet.json'), {}) || {})._allData || []) {
        if (r._cueSheetName) sheet.set(r._id, r._cueSheetName);
      }
      for (const r of (readJson(path.join(ON_DIR, 'master', 'MasterSound.json'), {}) || {})._allData || []) {
        if (r._id != null && r._cueName) SOUND_MAP.set(r._id, { cue: r._cueName, sheet: sheet.get(r._soundCueSheetID) || null });
      }
    } catch (e) { console.error('[on] 语音表读取失败:', errText(e)); }
    return SOUND_MAP;
  }

  /** 每个角色的语音清单：角色成长语音 + 演出开始语音 + 首页对话（三张表合并） */
  function voices() {
    if (VOICES) return VOICES;
    VOICES = [];
    const sm = soundMap();
    const push = (rows, idKey, textKey, from) => {
      for (const r of rows) {
        const sid = r[idKey];
        const info = sm.get(sid);
        if (!r._characterId || !info || !info.cue || !info.sheet) continue;
        VOICES.push({ char: r._characterId, soundId: sid, textId: r[textKey], from: from });
      }
    };
    const load = (n) => (readJson(path.join(ON_DIR, 'master', 'Master' + n + '.json'), {}) || {})._allData || [];
    push(load('CharacterVoice'), '_soundId', '_textId', '成长语音');
    push(load('LiveStartCharacterVoice'), '_voiceSoundId', '_voiceTextId', '演出开始');
    push(load('Talk'), '_voiceSoundId', '_textId', '首页对话');
    // 卡池语音：MasterMemberCard._gachaVoiceSoundId（抽到该卡时的那句话）
    // 这批音频是 bundle 内嵌路线（catalog 里没有 cri/sound/voicegacha_* location），
    // voicePack() 会自动回退到 cri_assets_cri_sound_<sheet>_<hash>.bundle
    for (const r of load('MemberCard')) {
      const sid = r._gachaVoiceSoundId;
      if (!sid || !r._characterID) continue;
      const info = sm.get(sid);
      if (!info || !info.cue || !info.sheet) continue;
      VOICES.push({ char: r._characterID, soundId: sid, textId: r._gachaVoiceTextId, from: '抽卡语音' });
    }
    console.log('[on] 角色语音清单 ' + VOICES.length + ' 条，覆盖角色 ' + new Set(VOICES.map((v) => v.char)).size + ' 个');
    return VOICES;
  }

  /** 中文文本：MasterText 的 _simplifiedChinese */
  function voiceText(textId) {
    try {
      if (!voiceText.TXT) {
        voiceText.TXT = new Map();
        for (const r of (readJson(path.join(ON_DIR, 'master', 'MasterText.json'), {}) || {})._allData || []) {
          if (r && r._id) voiceText.TXT.set(String(r._id), r._simplifiedChinese || r._traditionalChinese || '');
        }
      }
      return String(voiceText.TXT.get(String(textId)) || '').trim();
    } catch (e) { return ''; }
  }

  /** 取一条语音的 mp3（缓存 data/on/audio/voice/<soundId>.mp3） */
  async function ensureVoice(v, pack) {
    fs.mkdirSync(VOICE_DIR, { recursive: true });
    const mp3 = path.join(VOICE_DIR, v.soundId + '.mp3');
    if (fs.existsSync(mp3) && await audioOk(mp3, 0.4)) return mp3;
    fs.mkdirSync(CRI_DIR, { recursive: true });
    const acb = path.join(CRI_DIR, v.sheetName + '.acb');
    if (!fs.existsSync(acb) || fs.statSync(acb).size < 10240) {
      if (pack.bundle) {
        const bfile = path.join(CRI_DIR, pack.bundle);
        if (!fs.existsSync(bfile) || fs.statSync(bfile).size < 102400) {
          await curl(`${SONGS.cdn}/${pack.bundle}`, bfile, SONGS.auth);
        }
        const { Bundle } = require(path.join(ON_DIR, 'unitysrc', 'bundle.js'));
        const { acbFromBundle } = require(path.join(__dirname, 'tools', 'acb.js'));
        const bytes = acbFromBundle(Bundle.load(bfile));
        if (!bytes || bytes.length < 10240) throw new Error(`${v.sheetName} 的包里没有 ACB`);
        fs.writeFileSync(acb, bytes);
        try { fs.unlinkSync(bfile); } catch (e) {}          // 4 MB 的包留着没用，ACB 已经拿到
      } else {
        await curl(pack.url, acb, null);                    // 独立 CRI 音频包是公开的，不带 CDN 凭据
      }
    }
    const wav = path.join(CRI_DIR, v.soundId + '.wav');
    await new Promise((res, rej) => {
      const c = spawn('python3', [path.join(__dirname, 'tools', 'acb_cues.py'), '--acb', acb,
        '--select', v.cueName, '--wav', wav], { cwd: path.join(__dirname, 'tools') });
      let log = '';
      c.stdout.on('data', (d) => { log += d.toString(); });
      c.stderr.on('data', (d) => { log += d.toString(); });
      c.on('close', (code) => (code === 0 && fs.existsSync(wav)
        ? res() : rej(new Error('取音频失败: ' + log.trim().split('\n').slice(-1)[0].slice(0, 120)))));
    });
    await new Promise((res, rej) => {
      const c = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav,
        '-codec:a', 'libmp3lame', '-b:a', '128k', mp3]);
      let log = '';
      c.stderr.on('data', (d) => { log += d.toString(); });
      c.on('close', (code) => {
        if (code === 0 && fs.existsSync(mp3)) return res();
        try { fs.unlinkSync(mp3); } catch (e) {}
        rej(new Error('转码失败: ' + log.slice(-120)));
      });
    });
    try { fs.unlinkSync(wav); } catch (e) {}
    return mp3;
  }

  async function handleVoice(ws, msg, arg) {
    const q = String(arg || '').trim();
    const all = voices();
    if (!all.length) return replyText(ws, msg, '语音数据缺失（先让管理员跑 /on更新 主数据）');
    let pool = all;
    let who = '';
    if (q) {
      const ch = resolveCharacter(q) || (INDEX && INDEX.characters.find((c) => String(c.id) === q));
      if (!ch) {
        const names = INDEX ? INDEX.characters.map((c) => c.name).join('、') : '';
        return replyText(ws, msg, `没有找到角色「${q}」。可用角色：${names}`);
      }
      pool = all.filter((v) => v.char === ch.id);
      who = ch.name;
      if (!pool.length) return replyText(ws, msg, `「${ch.name}」还没有语音`);
    }
    if (!Object.keys(CRI_URL).length && !bundleNames().length) {
      return replyText(ws, msg, '音频包映射表缺失（先跑 tools/cri_url.py 生成 cri_url.json）');
    }
    // 只有音频包拿得到的语音才能播放，先筛掉其余条目再随机
    const usable = [];
    for (const v of pool) {
      const info = soundMap().get(v.soundId) || {};
      const pack = voicePack(info.sheet);
      if (pack) usable.push({ v: v, cue: info.cue, sheet: info.sheet, pack: pack });
    }
    if (!usable.length) {
      return replyText(ws, msg, q ? `「${who}」的语音包还没收录（跑 tools/cri_url.py 更新 cri_url.json）`
        : '没有可播放的语音（跑 tools/cri_url.py 更新 cri_url.json）');
    }
    for (let i = usable.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const sw = usable[i]; usable[i] = usable[j]; usable[j] = sw;
    }
    let lastErr = null;
    for (const item of usable.slice(0, 4)) {
      const pick = item.v;
      try {
        const mp3 = await ensureVoice({ soundId: pick.soundId, cueName: item.cue, sheetName: item.sheet }, item.pack);
        replyMixed(ws, msg, [{ type: 'record', data: { file: 'file://' + mp3 } }]);
        const txt = voiceText(pick.textId);
        const label = who || (INDEX ? ((INDEX.characters.find((c) => c.id === pick.char) || {}).name || '') : '');
        if (txt) return replyText(ws, msg, `${label}："${txt}"`);
        return replyText(ws, msg, `${label}：（这条语音没有文本）`);
      } catch (e) {
        lastErr = e;
        console.error('[on] 语音失败:', pick.soundId, errText(e));
      }
    }
    return replyText(ws, msg, '语音取不到：' + errText(lastErr || new Error('未知错误')));
  }

  // ---------------- 小漫画（加载漫画） ----------------
  const COMIC_DIR = path.join(ON_DIR, 'art', 'comic');
  let COMIC_BUNDLES = null;
  let COMICS = null;

  /** 包名清单：comic_001_1 → image_assets_image_comic_comic_001_1_<hash>.bundle */
  function comicBundleName(asset) {
    if (!COMIC_BUNDLES) {
      COMIC_BUNDLES = {};
      try {
        const inv = JSON.parse(fs.readFileSync(path.join(ON_DIR, 'bundle_inventory.json'), 'utf8'));
        const list = Array.isArray(inv) ? inv : (inv.names || inv.bundles || []);
        for (const n of list) {
          const m = /^image_assets_image_comic_(.+)_[0-9a-f]{32}\.bundle$/.exec(String(n));
          if (m) COMIC_BUNDLES[m[1]] = String(n);
        }
      } catch (e) { console.error('[on] 漫画包清单读取失败:', errText(e)); }
    }
    return COMIC_BUNDLES[asset] || null;
  }

  function comics() {
    if (COMICS) return COMICS;
    COMICS = [];
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ON_DIR, 'master', 'MasterLoadingComics.json'), 'utf8'));
      COMICS = (j._allData || []).map((r) => ({
        id: r._id, asset: r._imageAsset, chars: r._characterIds || [], order: r._order,
      })).filter((c) => c.asset);
    } catch (e) { console.error('[on] 漫画表读取失败:', errText(e)); }
    return COMICS;
  }

  /** 取漫画 PNG（缓存到 data/on/art/comic/<asset>.png；没有就下载包并解出图片） */
  async function ensureComic(asset) {
    const out = path.join(COMIC_DIR, asset + '.png');
    if (fs.existsSync(out) && fs.statSync(out).size > 1024) return out;
    const bname = comicBundleName(asset);
    if (!bname) throw new Error(`没有 ${asset} 的漫画包`);
    fs.mkdirSync(COMIC_DIR, { recursive: true });
    const tmp = path.join('/tmp', bname);
    await curl(`${SONGS.cdn}/${bname}`, tmp, SONGS.auth);
    try {
      const { Bundle } = require(path.join(ON_DIR, 'unitysrc', 'bundle.js'));
      const { exportObject } = require(path.join(ON_DIR, 'unitysrc', 'exporter.js'));
      const b = Bundle.load(tmp);
      const objs = b.listObjects();
      // 必须先试 Sprite：Texture2D 是整张图集（含留白、方向也不对）
      const cand = objs.filter((e) => e.className === 'Sprite')
        .concat(objs.filter((e) => e.className === 'Texture2D'));
      for (const e of cand) {
        const r = await exportObject(b, e);
        if (r && r.ext === '.png' && r.data) {
          fs.writeFileSync(out, r.data);
          console.log(`[on] 漫画解出 ${asset} <- ${e.className} ${r.name}`
            + (r.meta ? ` ${r.meta.width}x${r.meta.height}（图集 ${r.meta.sourceSize} rot=${r.meta.packingRotation}）` : ''));
          return out;
        }
      }
      throw new Error('漫画包里没有图片对象');
    } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
  }

  async function handleComic(ws, msg, arg) {
    const q = String(arg || '').trim();
    const list = comics();
    if (!list.length) return replyText(ws, msg, '漫画数据缺失（先让管理员跑 /on更新 主数据）');
    let pool = list;
    let who = '';
    if (q) {
      const ch = resolveCharacter(q);
      if (!ch) {
        const names = INDEX ? INDEX.characters.map((c) => c.name).join('、') : '';
        return replyText(ws, msg, `没有找到角色「${q}」。可用角色：${names}`);
      }
      pool = list.filter((c) => c.chars.indexOf(ch.id) >= 0);
      who = ch.name;
      if (!pool.length) return replyText(ws, msg, `「${ch.name}」还没有加载漫画`);
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    try {
      const png = await ensureComic(pick.asset);
      return replyImage(ws, msg, png);
    } catch (e) {
      console.error('[on] 漫画失败:', errText(e));
      return replyText(ws, msg, '漫画取不到：' + errText(e));
    }
  }

  // ---------------- 难度排行
  async function handleRank(ws, msg, arg) {
    const raw = String(arg || '').trim();
    const D = { ex: 'EXPERT', expert: 'EXPERT', hd: 'HARD', hard: 'HARD',
      nor: 'NORMAL', nm: 'NORMAL', normal: 'NORMAL', ez: 'EASY', easy: 'EASY' };
    let diff = 'EXPERT', level = null;
    for (const tok of raw.split(/[\s　]+/).filter(Boolean)) {
      const t = tok.toLowerCase();
      if (D[t]) { diff = D[t]; continue; }
      if (/^\d+(\.\d+)?$/.test(t)) { level = Math.floor(Number(t)); continue; }
      return replyText(ws, msg, helpFor('难度排行'));
    }
    const out = path.join(CACHE_DIR, `rank_${diff}${level == null ? '_all' : '_' + level}.png`);
    try {
      const f = fs.existsSync(out) ? out
        : await runPy(['rankimg.py', '--diff', diff]
          .concat(level == null ? [] : ['--level', String(level)])
          .concat(['--out', out]), out);
      return replyImage(ws, msg, f);
    } catch (e) {
      const m = errText(e);
      if (/没有 Lv\.|难度只能是/.test(m)) return replyText(ws, msg, m);
      console.error('[on] 难度排行失败:', m);
      return replyText(ws, msg, '排行图生成失败：' + m);
    }
  }

  // ---------------- 效益 / 效率排行（针对查曲）
  const EFF_HELP = ['用法：/on效益排行 [ex|hd|nor|ez] [整数难度]',
    '　例 /on效益排行　/on效益排行 hd 17　/on效率排行 ez',
    '效益 = 单局理论最高分（按游戏主数据表推算）；效率 = 效益 ÷ 时长'].join('\n');

  async function handleEff(ws, msg, arg, by) {
    const raw = String(arg || '').trim();
    let diff = 'EXPERT';
    let level = null;
    for (const tok of raw.split(/[\s\u3000]+/).filter(Boolean)) {
      const t = tok.toLowerCase();
      if (DIFF_WORDS[t]) { diff = DIFF_WORDS[t]; continue; }
      if (/^\d+(\.\d+)?$/.test(t)) { level = Math.floor(Number(t)); continue; }
      return replyText(ws, msg, EFF_HELP);
    }
    const out = path.join(CACHE_DIR, `${by}_${diff}${level == null ? '' : '_' + level}.png`);
    try {
      const f = await runPy(['effimg.py', '--by', by, '--diff', diff]
        .concat(level == null ? [] : ['--level', String(level)])
        .concat(['--out', out]), out);
      return replyImage(ws, msg, f);
    } catch (e) {
      const m = errText(e);
      if (/没有 Lv\.|缺少 score\.json|没有 .* 的数据/.test(m)) return replyText(ws, msg, m);
      console.error('[on] 效益排行失败:', m);
      return replyText(ws, msg, '排行图生成失败：' + m);
    }
  }

  // ---------------- 表情与收藏贴纸
  let collectibleQueue = Promise.resolve(), collectiblePending = 0;
  function renderCollectible(args, out) {
    if (collectiblePending >= 3) return Promise.reject(new Error('图鉴请求较多，请稍后重试。'));
    collectiblePending += 1;
    const job = collectibleQueue.then(() => runPy(args, out));
    collectibleQueue = job.catch(() => {});
    return job.finally(() => { collectiblePending -= 1; });
  }
  async function handleCollectible(ws, msg, arg, kind) {
    const label = kind === 'emote' ? '表情' : '贴纸';
    let q = String(arg || '').trim();
    const single = q.match(/^(\d+)(?:\s+([\s\S]+))?$/);
    if (single && single[2]) return replyText(ws, msg, kind === 'emote'
      ? '当前表情的角色和文字已合成在同一张图片里，暂不能直接替换周围文字。发送 /on表情 ' + single[1] + ' 可查看原图。'
      : '查看贴纸原图请使用 /on贴纸 ID，例如 /on贴纸 ' + single[1]);
    let page = 1;
    const pageMatch = q.match(/(?:^|\s)(?:页|第)(\d+)(?:页)?$/);
    if (pageMatch) {page = Number(pageMatch[1]); q = q.slice(0, pageMatch.index).trim();}
    const dir = path.join(ON_DIR, 'tmp'); fs.mkdirSync(dir, {recursive:true});
    const stamp = 'collectible-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex');
    const out = path.join(dir, stamp + (kind === 'degree' && !single ? '.jpg' : '.png')), input = path.join(dir, stamp + '.json');
    try {
      const args = ['collectibleimg.py', '--kind', kind, '--page', String(page), '--out', out];
      if (kind === 'degree' && !pageMatch) args.push('--all');
      if (single) args.push('--id', single[1]);
      else if (q) args.push('--char', q);
      if (kind === 'degree' && !single) {
        const qq = String(msg.sender && msg.sender.user_id || '');
        let data;
        try { data = await onApiUserData(qq, true); }
        catch { data = null; }
        const profiles = ((data && data.results) || []).filter(r => r.kind === 'profile' && r.payload && r.payload.document && r.payload.document.account_import);
        profiles.sort((a,b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
        const document = profiles[0] && profiles[0].payload.document;
        const importedId = document && document.account_import && document.account_import.account_id;
        const player = await onPublicPlayer(qq, data, importedId);
        fs.writeFileSync(input, JSON.stringify({uploaded:!!document, player, collection:document && document.profile && document.profile.inventory && document.profile.inventory.stickers || {known:false,counts:[]}}), {mode:0o600});
        args.push('--ownership', input);
      }
      await renderCollectible(args, out);
      // Embed bytes before cleanup: OneBot reads file:// paths asynchronously.
      const image = fs.readFileSync(out).toString('base64');
      const t = target(msg);
      sendReply(ws, t.action, Object.assign({}, t.base, {
        message: [{type: 'image', data: {file: 'base64://' + image}}],
      }));
    } catch(e) { return replyText(ws,msg,label + '：' + errText(e)); }
    finally { for (const file of [out,input]) {try {fs.unlinkSync(file);} catch {}} }
  }

  // ---------------- 卡池
  async function handleGacha(ws, msg) {
    // 卡池预览 = 构造图片（封面横幅 + 期间 + 概率 + Pick Up 卡缩略图）；没有在开的卡池时退回文本
    const out = path.join(CACHE_DIR, 'gacha.png');
    try {
      try { fs.unlinkSync(out); } catch (e) {}     // 免得脚本没出图时用到上一次的旧图
      await runPy(['gachaimg.py', '--out', out], out);
      return replyImage(ws, msg, out);
    } catch (e) {
      console.log('[on] 卡池改为文本输出:', errText(e));
      try {
        return replyText(ws, msg, await runPyOut(['gachainfo.py']));
      } catch (e2) {
        console.error('[on] 卡池失败:', errText(e2));
        return replyText(ws, msg, '卡池读取失败：' + errText(e2));
      }
    }
  }

  // ---------------- 当期活动
  async function handleEvent(ws, msg) {
    // 和卡池一样：构造一张图（活动 Top 图 + 活动曲 + Pick Up + 加成 + 点数奖励）
    const out = path.join(CACHE_DIR, 'event.png');
    try {
      try { fs.unlinkSync(out); } catch (e) {}      // 免得没出图时用了上一张旧的
      await runPy(['eventimg.py', '--out', out], out);
      return replyImage(ws, msg, out);
    } catch (e) {
      console.log('[on] 活动改为文本输出:', errText(e));
      try {
        return replyText(ws, msg, await runPyOut(['eventimg.py', '--text']));
      } catch (e2) {
        console.error('[on] 活动失败:', errText(e2));
        return replyText(ws, msg, '活动读取失败：' + errText(e2));
      }
    }
  }

  // ---------------- 谱面预览
  async function handleChart(ws, msg, arg) {
    const { q, diff } = splitDiff(arg);
    const song = resolveSong(q);
    if (!song) return replyText(ws, msg, songHelp(q));
    const has = (song.charts || []).some((c) => c.name === diff);
    if (!has) {
      const list = (song.charts || []).map((c) => c.name).join('/');
      return replyText(ws, msg, `「${songLabel(song)}」没有 ${diff} 谱面（现有：${list}）`);
    }
    try {
      const chartPath = await ensureChart(song, diff);
      const out = path.join(CACHE_DIR, `chart_${song.id}_${diff}.png`);
      const f = await runPy(['songimg.py', 'chart', '--id', String(song.id), '--diff', diff,
        '--chart', chartPath, '--aliases', ALIAS_FILE, '--out', out], out);
      return replyImage(ws, msg, f);
    } catch (e) {
      console.error('[on] 谱面失败:', errText(e));
      return replyText(ws, msg, '谱面生成失败：' + errText(e));
    }
  }

  // ---------------- 别名（谁都能加：加完立即生效，同时进待审核队列）
  const isAdmin = (msg) => String((msg.sender && msg.sender.user_id) || '') === ADMIN;

  /** 队列文本：标号就是位置，删掉前面的条目后后面自动前移 */
  function pendingText() {
    const rows = REVIEW.pending.map((p, i) => `${i + 1}. ${itemName(p)}${typeLabel(p.type)}：${p.alias}`);
    if (!rows.length) return '待审核：没有待审核的条目。';
    return [`待审核（${rows.length} 条）`].concat(rows)
      .concat(['/on通过 <标号…>　/on阻止 <标号…>　/on通过 全部']).join('\n');
  }

  /** 队列条目的对象名（曲子 / 角色） */
  function itemName(it) {
    if ((it.type || REVIEW_TYPE) === REVIEW_TYPE_CHAR) {
      const ch = INDEX && INDEX.characters.find((c) => c.id === it.char);
      return (ch && ch.name) || it.name || String(it.char);
    }
    const song = SONGS && SONGS.songs.find((s) => s.id === it.song);
    return (song && (song.title || song.title_jp)) || it.name || String(it.song);
  }

  const fmtItem = (it) => `${itemName(it)}${typeLabel(it.type)}：${it.alias}`;

  /** 黑名单只在「同一类型 + 同一个对象 + 同一个别名」时生效 */
  const isBlocked = (type, id, alias) => REVIEW.blocked.some((b) => (b.type || REVIEW_TYPE) === type
    && String((b.type || REVIEW_TYPE) === REVIEW_TYPE_CHAR ? b.char : b.song) === String(id)
    && norm(b.alias) === norm(alias));

  function handleAlias(ws, msg, arg) {
    const raw = String(arg || '').trim();
    const parts = raw.split(/[\s　]+/).filter(Boolean);
    if (parts.length < 2) {
      return replyText(ws, msg, '用法：/on添加别名 <原名> <别名>　例：/on添加别名 迷星叫 mayoiuta');
    }
    const alias = parts.pop();
    const name = parts.join(' ');
    const song = resolveSong(name);
    if (!song) return replyText(ws, msg, `没找到原曲「${name}」。${songHelp()}`);
    const key = String(song.id);
    const list = ALIASES[key] || (ALIASES[key] = []);
    if (list.some((x) => norm(x) === norm(alias))) {
      return replyText(ws, msg, `「${alias}」已经是 ${songLabel(song)} 的别名了。`);
    }
    if (isBlocked(REVIEW_TYPE, song.id, alias)) {
      return replyText(ws, msg, `「${alias}」被管理员阻止过，不能再给「${songLabel(song)}」当别名。`);
    }
    list.push(alias);
    if (!saveAliases()) return replyText(ws, msg, '别名写入失败，请稍后重试。');
    REVIEW.pending.push({
      type: REVIEW_TYPE, song: song.id, name: song.title || song.title_jp || '',
      alias, by: (msg.sender && msg.sender.user_id) || '', at: new Date().toISOString(),
    });
    saveReview();
    replyText(ws, msg, `已为「${songLabel(song)}」添加别名：${alias}\n现有别名：${list.join('、')}`);
  }

  /** /on角色别名 <角色> <别名>：和曲子别名一样，登记后立刻能用，同时进审核队列 */
  function handleCharAlias(ws, msg, arg) {
    const raw = String(arg || '').trim();
    const parts = raw.split(/[\s　]+/).filter(Boolean);
    if (parts.length < 2) {
      return replyText(ws, msg, '用法：/on角色别名 <角色> <别名>　例：/on角色别名 高松灯 tomorin');
    }
    const alias = parts.pop();
    const name = parts.join(' ');
    const ch = resolveCharacter(name);
    if (!ch) {
      const names = INDEX ? INDEX.characters.map((c) => c.name).join('、') : '';
      return replyText(ws, msg, `没找到角色「${name}」。可用角色：${names}`);
    }
    const key = String(ch.id);
    const list = CHAR_ALIASES[key] || (CHAR_ALIASES[key] = []);
    if (charNames(ch).some((x) => norm(x) === norm(alias))) {
      return replyText(ws, msg, `「${alias}」已经是 ${ch.name} 的名字了。`);
    }
    if (isBlocked(REVIEW_TYPE_CHAR, ch.id, alias)) {
      return replyText(ws, msg, `「${alias}」被管理员阻止过，不能再给「${ch.name}」当别名。`);
    }
    list.push(alias);
    if (!saveCharAliases()) return replyText(ws, msg, '角色别名写入失败，请稍后重试。');
    REVIEW.pending.push({
      type: REVIEW_TYPE_CHAR, char: ch.id, name: ch.name,
      alias, by: (msg.sender && msg.sender.user_id) || '', at: new Date().toISOString(),
    });
    saveReview();
    replyText(ws, msg, `已为「${ch.name}」添加别名：${alias}\n现有别名：${[...new Set(charNames(ch))].join('、')}`);
  }

  /** 管理员：/on待审核 */
  function handlePending(ws, msg) {
    if (!isAdmin(msg)) return replyText(ws, msg, '这个指令只有管理员能用哦。');
    replyText(ws, msg, pendingText());
  }

  /** 「1 2 3」/「1,2,3」→ 0 基下标；有问题返回 { err } */
  function parseIndexes(arg, len) {
    const toks = String(arg || '').split(/[\s　,，、]+/).filter(Boolean);
    if (!toks.length) return { err: '没给标号。' };
    const idx = [];
    for (const t of toks) {
      if (!/^\d+$/.test(t)) return { err: `「${t}」不是标号。` };
      const n = Number(t);
      if (n < 1 || n > len) return { err: `标号 ${n} 超出范围（现在只有 1~${len}）。` };
      if (!idx.includes(n - 1)) idx.push(n - 1);
    }
    return { idx };
  }

  /** 管理员：/on阻止 <标号…> —— 撤销这些别名，并拉黑 */
  function handleBlock(ws, msg, arg) {
    if (!isAdmin(msg)) return replyText(ws, msg, '这个指令只有管理员能用哦。');
    const len = REVIEW.pending.length;
    if (!len) return replyText(ws, msg, pendingText());
    const p = parseIndexes(arg, len);
    if (p.err) return replyText(ws, msg, `${p.err}\n${pendingText()}`);
    const picked = p.idx.map((i) => REVIEW.pending[i]);
    for (const it of picked) {
      const type = it.type || REVIEW_TYPE;
      if (type === REVIEW_TYPE_CHAR) {
        const key = String(it.char);
        const left = (CHAR_ALIASES[key] || []).filter((x) => norm(x) !== norm(it.alias));
        if (left.length) CHAR_ALIASES[key] = left; else delete CHAR_ALIASES[key];
      } else {
        const key = String(it.song);
        const left = (ALIASES[key] || []).filter((x) => norm(x) !== norm(it.alias));
        if (left.length) ALIASES[key] = left; else delete ALIASES[key];
      }
      const id = type === REVIEW_TYPE_CHAR ? it.char : it.song;
      if (!isBlocked(type, id, it.alias)) {
        REVIEW.blocked.push({ type, song: type === REVIEW_TYPE ? it.song : undefined,
          char: type === REVIEW_TYPE_CHAR ? it.char : undefined,
          name: it.name || '', alias: it.alias,
          by: (msg.sender && msg.sender.user_id) || '', at: new Date().toISOString() });
      }
    }
    REVIEW.pending = REVIEW.pending.filter((x) => !picked.includes(x));
    saveAliases(); saveCharAliases(); saveReview();
    replyText(ws, msg, `已阻止 ${picked.length} 条：${picked.map(fmtItem).join('、')}\n\n${pendingText()}`);
  }

  /** 管理员：/on通过 <标号…|全部> —— 通过（别名继续保持可用） */
  function handleApprove(ws, msg, arg) {
    if (!isAdmin(msg)) return replyText(ws, msg, '这个指令只有管理员能用哦。');
    const len = REVIEW.pending.length;
    if (!len) return replyText(ws, msg, pendingText());
    const a = String(arg || '').trim();
    let picked;
    if (/^(全部|all)$/i.test(a)) picked = REVIEW.pending.slice();
    else {
      const p = parseIndexes(a, len);
      if (p.err) return replyText(ws, msg, `${p.err}（也可以用 /on通过 全部）\n${pendingText()}`);
      picked = p.idx.map((i) => REVIEW.pending[i]);
    }
    REVIEW.pending = REVIEW.pending.filter((x) => !picked.includes(x));
    saveReview();
    replyText(ws, msg, `已通过 ${picked.length} 条：${picked.map(fmtItem).join('、')}\n\n${pendingText()}`);
  }

  // ---------------- 资源更新（管理员一键）
  const UPDATE_JS = require('path').join(__dirname, 'tools', 'on_update.js');
  const MASTER_JS = require('path').join(__dirname, 'tools', 'on_master.js');

  function handleUpdate(ws, msg, arg) {
    if (String(msg.sender.user_id) !== ADMIN) {
      return replyText(ws, msg, '这个指令只有管理员能用哦。');
    }
    const a = (arg || '').trim();
    const { execFile } = require('child_process');
    const isMaster = /主数据|master/i.test(a);
    const argv = [isMaster ? MASTER_JS : UPDATE_JS];
    const isStatus = /状态|status/i.test(a);
    if (isStatus && !isMaster) argv.push('--status');
    else if (/应用|下载|apply/i.test(a)) argv.push('--apply');
    argv.push('--json');
    replyText(ws, msg, isMaster ? (/(应用|下载)/.test(a) ? '正在更新主数据表…' : '正在检查主数据…') : isStatus ? '读取更新状态…'
      : (/应用|下载|apply/i.test(a) ? '正在检查并下载新资源，可能要一会儿…' : '正在检查资源更新…'));
    execFile('node', argv, { timeout: 300000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      let d = null;
      const raw = String(stdout || '').trim();
      try { d = JSON.parse(raw); } catch (e) {
        const i = raw.indexOf('{');                       // --json 是多行美化输出，整体解析
        if (i >= 0) { try { d = JSON.parse(raw.slice(i)); } catch (e2) {} }
      }
      if (!d) {
        return replyText(ws, msg, '资源更新脚本执行异常：' + String((err && err.message) || '输出无法解析').slice(0, 200));
      }
      if (isMaster) {                                                  // 主数据
        if (d.errors && d.errors.length) {
          return replyText(ws, msg, '主数据检查失败：' + d.errors.join('；').slice(0, 300));
        }
        const lines = [`主数据（resourceVersion ${d.resourceVersion || '-'}）`,
          `表数 ${d.total || '-'}，本次变更 ${(d.changedTables || []).length} 张`];
        if (d.applied) {
          lines.push(`已下载并解密：${d.applied.ok}/${d.applied.tried}，失败 ${(d.applied.failed || []).length}`);
          if (d.applied.ok) {
            const g = d.regenerated || {};
            const good = (g.ok || []).join(' / ');
            const bad = (g.failed || []).map((f) => f.label).join(' / ');
            lines.push(good ? `已自动重建派生索引：${good}` : '派生索引未重建，请看 /tmp/on_update.log');
            if (bad) lines.push(`重建失败：${bad}`);
          }
        } else if (!(d.changedTables || []).length) {
          lines.push('已是最新，无需下载。');
        } else {
          lines.push('发「/on更新 主数据 应用」即可下载并解密变更表。');
        }
        return replyText(ws, msg, lines.join('\n'));
      }
      if (isStatus && d.inventory !== undefined) {                      // --status
        return replyText(ws, msg, [
          '资源更新状态',
          `catalog hash：${d.catalogHash || '-'}`,
          `已知资源包：${d.inventory} 个`,
          `上次新增：${d.lastNew} 个${d.lastNewAt ? '（' + d.lastNewAt.replace('T', ' ').slice(0, 19) + '）' : ''}`,
          `密钥状态：${d.keySuspect ? '可疑，需人工提供新 APK' : '正常'}`,
        ].join('\n'));
      }
      if (d.errors && d.errors.length) {
        return replyText(ws, msg, '检查失败：' + d.errors.join('；').slice(0, 300));
      }
      const cats = Object.entries(d.categories || {}).map(([k, v]) => `${k} ${v}`).join('、');
      const lines = [];
      if (d.firstRun) lines.push(`已建立基线：记录 ${d.inventoryCount} 个资源包`);
      else if (!d.new || !d.new.length) lines.push(`无更新（已知 ${d.inventoryCount} 个资源包）`);
      else {
        lines.push(`发现 ${d.new.length} 个新增资源包：${cats}`);
        if (d.removedCount) lines.push(`（另有 ${d.removedCount} 个已下架）`);
        if (d.applied) {
          lines.push(`下载并解密：${d.applied.ok}/${d.applied.tried} 成功，${(d.applied.bytes / 1048576).toFixed(2)}MB`);
          if (d.applied.failed && d.applied.failed.length) lines.push('失败：' + d.applied.failed.slice(0, 3).map((f) => f.name.slice(0, 40)).join('、'));
        } else {
          lines.push('发「/on更新 应用」即可自动下载并解密这些资源。');
        }
      }
      if (d.keySuspect) lines.push('解密校验失败：密钥可能已更换，需要人工提供新 APK。');
      replyText(ws, msg, lines.join('\n'));
    });
  }

  // ---------------- 小游戏：/on猜卡 /on猜曲 /on猜语音 + /回答（/答、/猜）/结束
  // 一局一题，按会话（群 / 私聊）存；答对或 /结束 收局。答案用「模糊匹配 + 别名」判定。
  // 图片与文字同一条发出；**语音和文字分两条**（同一条时 QQ 只显示语音气泡）。
  // 收局给完整语音 / 原文 / 曲绘 / 完整卡面。
  const GAMES = new Map();                     // 'g:<群号>' / 'p:<QQ>' -> 当前这一局
  const GAME_TTL_MS = 30 * 60 * 1000;          // 兜底：半小时没动静就作废（正常有一分钟时限）
  const GAME_MS = 60 * 1000;                   // 一局时限：谜面（全部素材）发完开始计时 1 分钟
  const GAME_KIND = { card: '猜卡', song: '猜曲', voice: '猜语音' };
  // 正在准备谜面的会话（猜曲要下完整版，可能十几秒）：这段时间里不许再开新的一局，
  // 否则两次请求会各自准备、后一局把前一局顶掉（短间隔连点就会看到两条谜面）
  const GAME_PREPARING = new Map();            // key -> { type, at }
  const PREPARE_TTL_MS = 3 * 60 * 1000;        // 兜底：卡死的准备状态三分钟后自动失效
  const GAME_GIVEUP_AT = 6;                    // 答错几次自动公布答案（中途不再提示）
  const CARD_CROP = { 大: 240, 中: 160, 小: 100, 简单: 240, 普通: 160, 困难: 100, 难: 100, 易: 240 };
  const CLIP_SECONDS = 3;

  const gameKey = (msg) => (msg.message_type === 'private' ? 'p:' + msg.sender.user_id : 'g:' + msg.group_id);

  /** 编辑距离（答案都不长，够用） */
  function editDistance(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = [];
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  /** 猜答案判定：完全一致优先 → 互为子串 → 编辑距离在容差内；命中返回 {how} */
  function guessHit(text, accept) {
    const s = norm(text);
    if (!s) return null;
    const names = (accept || []).map((raw) => ({ raw: raw, n: norm(raw) })).filter((x) => x.n);
    for (const x of names) if (x.n === s) return { how: '' };
    for (const x of names) {
      if (s.length >= 2 && (x.n.includes(s) || s.includes(x.n))) return { how: `算作「${x.raw}」` };
      const d = editDistance(s, x.n);
      const tol = x.n.length <= 3 ? 0 : (x.n.length <= 6 ? 1 : 2);
      if (d > 0 && d <= tol) return { how: `算作「${x.raw}」` };
    }
    return null;
  }

  /** 相似度 0~1（子串 / 编辑距离 / 字符重合度 + 最长公共子串，取几种里最大的） */
  function simScore(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    let sc = 0;
    if (a.includes(b) || b.includes(a)) {
      sc = 0.9 + 0.09 * Math.min(a.length, b.length) / Math.max(a.length, b.length);
    } else {
      sc = 0.6 * lcsRatio(a, b) + 0.4 * lcSubstr(a, b) / Math.max(a.length, b.length);
      if (a.slice(0, 2) === b.slice(0, 2)) sc += 0.12;
    }
    const d = editDistance(a, b);
    sc = Math.max(sc, 1 - d / Math.max(a.length, b.length));
    return Math.min(0.99, sc);
  }

  /** 这一局「算数的答案」全集：猜卡/猜语音 = 角色，猜曲 = 曲子（用于猜错时的提示） */
  const ENTITY_CACHE = {};
  function entityList(type) {
    if (ENTITY_CACHE[type]) return ENTITY_CACHE[type];
    let list = [];
    try {
      if (type === 'song') {
        list = ((SONGS && SONGS.songs) || []).map((sg) => ({ id: sg.id,
          name: sg.title || sg.title_jp || String(sg.id), names: songNames(sg) }));
      } else if (INDEX) {
        list = INDEX.characters.map((ch) => ({ id: ch.id, name: ch.name, names: charNames(ch) }));
      }
    } catch (e) { console.error('[on] 猜题全集构建失败:', errText(e)); }
    ENTITY_CACHE[type] = list;
    return list;
  }

  /** 用户答的到底是哪个角色 / 哪首曲子（先精确，再模糊）；都不是返回 null */
  function findEntity(guess, list) {
    const s = norm(guess);
    if (!s) return null;
    for (const e of list) {
      for (const n of e.names) if (norm(n) === s) return e;
    }
    for (const e of list) if (guessHit(guess, e.names)) return e;
    return null;
  }

  /** 猜错的三种回复：① 是别的角色/曲子 → 「猜错了，不是X」
   *  ② 不认得、但有相近的 → 「你要猜的是不是：A(80%)，B(70%)，C(60%)」
   *  ③ 完全找不到 → 「没有找到你回答的人物/歌曲：X」 */
  function wrongReply(r, guess) {
    const list = entityList(r.type);
    const hit = findEntity(guess, list);
    if (hit) return `猜错了，不是${hit.name}`;
    const s = norm(guess);
    const scored = [];
    for (const e of list) {
      let best = 0;
      for (const n of e.names) {
        const v = simScore(s, norm(n));
        if (v > best) best = v;
      }
      if (best >= 0.3) scored.push({ e, score: best });
    }
    scored.sort((a, b) => b.score - a.score || String(a.e.id).localeCompare(String(b.e.id)));
    if (scored.length) {
      return '你要猜的是不是：' + scored.slice(0, 3)
        .map((x) => `${x.e.name}(${Math.round(x.score * 100)}%)`).join('，');
    }
    return (r.type === 'song' ? '没有找到你回答的歌曲：' : '没有找到你回答的人物：') + guess;
  }

  function roundOf(msg) {
    const k = gameKey(msg);
    const r = GAMES.get(k);
    if (!r) return null;
    if (Date.now() - r.at > GAME_TTL_MS) { dropRound(k); return null; }
    return r;
  }

  function dropRound(key) {
    const r = GAMES.get(key);
    GAMES.delete(key);
    if (!r) return;
    if (r.timer) { try { clearTimeout(r.timer); } catch (e) {} }
    if (r.file) { try { fs.unlinkSync(r.file); } catch (e) {} }
  }

  /** 谜面文件都在 /tmp/guess_*：开局时顺手清掉 6 小时前的（收局会删，没答的靠这个兜底） */
  function sweepGuessTmp() {
    try {
      const now = Date.now();
      for (const f of fs.readdirSync('/tmp')) {
        if (f.indexOf('guess_') !== 0) continue;
        const p = path.join('/tmp', f);
        try { if (now - fs.statSync(p).mtimeMs > 6 * 3600 * 1000) fs.unlinkSync(p); } catch (e) {}
      }
    } catch (e) {}
  }

  /** ffprobe 时长（秒）；拿不到就返回 0 */
  function audioSeconds(file) {
    return new Promise((resolve) => {
      const c = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
      let out = '';
      c.stdout.on('data', (d) => { out += d.toString(); });
      c.on('error', () => resolve(0));
      c.on('close', () => resolve(Number(String(out).trim()) || 0));
    });
  }

  /** 从 mp3 里剪一段（默认 3 秒）做谜面；开头 3 秒通常是前奏，尽量避开 */
  async function clipAudio(src, out, seconds) {
    const secs = seconds || CLIP_SECONDS;
    const dur = await audioSeconds(src);
    let start = 0;
    if (dur > secs + 6) start = 3 + Math.random() * (dur - secs - 6);
    else if (dur > secs + 1) start = Math.random() * (dur - secs - 0.5);
    await new Promise((res, rej) => {
      const c = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-ss', start.toFixed(2), '-t', String(secs), '-i', src,
        '-codec:a', 'libmp3lame', '-b:a', '128k', out]);
      let log = '';
      c.stderr.on('data', (d) => { log += d.toString(); });
      c.on('close', (code) => (code === 0 && fs.existsSync(out)
        ? res() : rej(new Error('剪音频失败: ' + log.slice(-120)))));
    });
    return { start, dur, secs };
  }

  /** 谜面下面的提示文字（猜曲不带文字，只发音频） */
  const guessPrompt = (r) => {
    const head = r.type === 'song' ? '听 3 秒，这是哪首歌？'
      : r.type === 'voice' ? '听 3 秒，这是哪个角色？'
        : '这是哪张卡的角色？';
    return `${GAME_KIND[r.type]}：${head}\n发 /回答 <答案>（/答、/猜 同义），放弃发 /结束`;
  };

  /** 这个会话已经有进行中的一局？有就提示并返回它（三个猜不能同时进行） */
  /** 开局统一入口：已有进行中的一局 / 正在准备 → 提示并返回；否则占住坑再准备 */
  async function withPrepare(ws, msg, type, fn) {
    const key = gameKey(msg);
    if (busyRound(ws, msg)) return null;
    const p = GAME_PREPARING.get(key);
    if (p && Date.now() - p.at < PREPARE_TTL_MS) {
      const extra = p.type === 'song' ? '（猜曲要下完整版，可能要十几秒）' : '';
      replyText(ws, msg, `「${GAME_KIND[p.type]}」的谜面还在准备中${extra}，出来会直接发出来，稍等一下。`);
      return null;
    }
    GAME_PREPARING.set(key, { type: type, at: Date.now() });
    try {
      return await fn();
    } finally {
      GAME_PREPARING.delete(key);
    }
  }

  function busyRound(ws, msg) {
    const r = roundOf(msg);
    if (!r) return null;
    const left = Math.max(1, Math.round(((r.deadline || (r.at + GAME_MS)) - Date.now()) / 1000));
    replyText(ws, msg, `正在进行游戏：这一局是「${GAME_KIND[r.type]}」，还剩约 ${left} 秒。`
      + '这一局不受影响，答对或发 /结束 之后再开新的一局。');
    return r;
  }

  const mediaSeg = (type, f) => ({ type: type, data: { file: 'file://' + f } });

  /** 发一段消息（若干段） */
  function sendSegs(ws, msg, segs) {
    if (!segs || !segs.length) return;
    const t = target(msg);
    sendReply(ws, t.action, Object.assign({}, t.base, { message: segs }));
  }

  /** 谜面的发法：图片可以和文字同一条；**语音必须和文字分两条**
   *  （QQ 里「语音 + 文字」放进同一条消息时，只会显示语音气泡，文字看不到 —— 踩过）
   *  返回发出去的最后一段，调用方据此开始计时。 */
  function sendPuzzle(ws, msg, r, seg) {
    const textSeg = { type: 'text', data: { text: guessPrompt(r) } };
    if (seg && seg.type === 'record') {
      sendSegs(ws, msg, [seg]);
      sendSegs(ws, msg, [textSeg]);
    } else if (seg) {
      sendSegs(ws, msg, [seg, textSeg]);
    } else {
      sendSegs(ws, msg, [textSeg]);
    }
  }

  /** 开一局：记状态 → 发谜面 → 素材发完才开始算 1 分钟 */
  function openRound(ws, msg, r, file, seg) {
    dropRound(gameKey(msg));
    sweepGuessTmp();
    r.at = Date.now();
    r.tries = 0;
    r.file = file || null;
    GAMES.set(gameKey(msg), r);
    console.log(`[on] ${GAME_KIND[r.type]}开局 key=${gameKey(msg)} 答案=${r.answer.label}`);
    sendPuzzle(ws, msg, r, seg);
    // 全部资源发出去之后开始计时
    r.deadline = Date.now() + GAME_MS;
    r.timer = setTimeout(() => {
      if (GAMES.get(gameKey(msg)) !== r) return;
      dropRound(gameKey(msg));
      revealRound(ws, msg, r, '时间到（1 分钟），');
    }, GAME_MS);
  }

  /** 猜卡：随机一张非 R 卡，剪卡面极小一块当谜面 */
  async function handleGuessCard(ws, msg, arg) {
    if (!INDEX) return replyText(ws, msg, '卡片数据缺失（先让管理员跑 /on更新 主数据）');
    return withPrepare(ws, msg, 'card', async () => {
    const key = String(arg || '').trim();
    let size = CARD_CROP['中'];
    if (key) {
      const s = CARD_CROP[key] || (/^\d{2,4}$/.test(key) ? Number(key) : null);
      if (!s) return replyText(ws, msg, helpFor('猜卡'));
      size = s;
    }
    const pool = INDEX.cards.filter((c) => c.rarity !== 2);        // 除 R 级
    for (let i = 0; i < 12; i++) {
      const c = pool[Math.floor(Math.random() * pool.length)];
      const ch = INDEX.characters.find((x) => x.id === c.char);
      if (!ch) continue;
      const out = path.join('/tmp', `guess_card_${c.id}_${Math.random().toString(36).slice(2, 8)}.png`);
      try {
        await runPy(['guessimg.py', '--id', String(c.id), '--size', String(size), '--out', out], out);
        const r = { type: 'card', answer: { label: ch.name, accept: charNames(ch), char: ch.id, card: c.id },
          };
        return openRound(ws, msg, r, out, mediaSeg('image', out));
      } catch (e) { /* 这张没有完整卡面，换一张 */ }
    }
    return replyText(ws, msg, '拿不到可用的卡面，稍后再试。');
    });
  }

  /** 猜曲：纯随机抽一首（不看有没有缓存），**直接用完整版**剪 3 秒
   *  （完整版只当剪片段的素材，收局不发它） */
  async function handleGuessSong(ws, msg) {
    if (!SONGS || !SONGS.songs.length) return replyText(ws, msg, '曲目数据缺失（先让管理员跑 /on更新 主数据）');
    return withPrepare(ws, msg, 'song', async () => {
    const all = SONGS.songs.filter((s) => s.acbBundle);
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      const song = all[Math.floor(Math.random() * all.length)];
      const out = path.join('/tmp', `guess_song_${song.id}_${Math.random().toString(36).slice(2, 8)}.mp3`);
      try {
        const mp3 = await ensureAudio(song);          // 直接抓完整版
        await clipAudio(mp3, out);
        const r = { type: 'song', answer: { label: songLabel(song), accept: songNames(song), song: song.id },
          };
        return openRound(ws, msg, r, out, mediaSeg('record', out));
      } catch (e) {
        lastErr = e;
        console.error('[on] 猜曲准备失败:', errText(e));
      }
    }
    return replyText(ws, msg, '音频拿不到，稍后再试。' + (lastErr ? '（' + errText(lastErr) + '）' : ''));
    });
  }

  /** 猜语音：随机一条角色语音，剪 3 秒 */
  async function handleGuessVoice(ws, msg) {
    const all = voices();
    if (!all.length) return replyText(ws, msg, '语音数据缺失（先让管理员跑 /on更新 主数据）');
    return withPrepare(ws, msg, 'voice', async () => {
    const usable = [];
    for (const v of all) {
      const info = soundMap().get(v.soundId) || {};
      const pack = voicePack(info.sheet);
      if (pack) usable.push({ v, info, pack });
    }
    if (!usable.length) return replyText(ws, msg, '没有可播放的语音（跑 tools/cri_url.py 更新 cri_url.json）');
    let lastErr = null;
    for (let i = 0; i < 4; i++) {
      const pick = usable[Math.floor(Math.random() * usable.length)];
      const ch = INDEX && INDEX.characters.find((c) => c.id === pick.v.char);
      if (!ch) continue;
      const out = path.join('/tmp', `guess_voice_${pick.v.soundId}_${Math.random().toString(36).slice(2, 8)}.mp3`);
      try {
        const mp3 = await ensureVoice({ soundId: pick.v.soundId, cueName: pick.info.cue, sheetName: pick.info.sheet }, pick.pack);
        await clipAudio(mp3, out);
        const r = { type: 'voice', answer: { label: ch.name, accept: charNames(ch), char: ch.id },
          voice: { soundId: pick.v.soundId, textId: pick.v.textId },
          };
        return openRound(ws, msg, r, out, mediaSeg('record', out));
      } catch (e) {
        lastErr = e;
        console.error('[on] 猜语音准备失败:', errText(e));
      }
    }
    return replyText(ws, msg, '语音拿不到，稍后再试。' + (lastErr ? '（' + errText(lastErr) + '）' : ''));
    });
  }

  /** 卡面整图（公布答案时一起发） */
  function fullArtOf(cardId) {
    for (const ext of ['.png', '.jpg', '.jpeg']) {
      const p = path.join(ON_DIR, 'art', 'full', cardId + ext);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /** 曲绘（jacket） */
  function jacketOf(songId) {
    const song = SONGS && SONGS.songs.find((s) => String(s.id) === String(songId));
    const name = song && song.jacket;
    if (!name) return null;
    for (const ext of ['.jpg', '.png', '.jpeg']) {
      const p = path.join(ON_DIR, 'art', 'jacket', name + ext);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  const songOf = (id) => (SONGS && SONGS.songs.find((s) => String(s.id) === String(id))) || null;

  /** 收局：文字 + 完整语音 / 原文 / 曲绘 / 完整卡面，能一条发就一条发。
   *  猜曲只发曲绘，**不发完整版歌曲**（完整版只当剪 3 秒的素材）。 */
  async function revealRound(ws, msg, r, why, note) {
    const segs = [];
    let text = `${why}答案是「${r.answer.label}」。`;
    let art = null;
    let audio = null;
    if (r.type === 'voice' && r.voice) {
      const t = voiceText(r.voice.textId);
      if (t) text += `\n原文："${t}"`;
      const p = path.join(VOICE_DIR, r.voice.soundId + '.mp3');     // 完整语音（谜面就是从它剪的）
      if (fs.existsSync(p)) audio = p;
    } else if (r.type === 'song' && r.answer.song) {
      art = jacketOf(r.answer.song);                                // 只给曲绘
    } else if (r.type === 'card' && r.answer.card) {
      art = fullArtOf(r.answer.card);
    }
    if (note) text += `\n${note}`;
    segs.push({ type: 'text', data: { text: text } });
    if (art) segs.push(mediaSeg('image', art));
    sendSegs(ws, msg, segs);                     // 文字（+ 图）一条
    if (audio) sendSegs(ws, msg, [mediaSeg('record', audio)]);   // 语音单独一条，免得文字被吃掉
  }

  async function handleAnswer(ws, msg, arg) {
    const guess = String(arg || '').trim();
    const r = roundOf(msg);
    if (!r) {
      const prep = GAME_PREPARING.get(gameKey(msg));
      if (prep) {
        const extra = prep.type === 'song' ? '（猜曲要下完整版，可能要十几秒）' : '';
        return replyText(ws, msg, `「${GAME_KIND[prep.type]}」的谜面还在准备中${extra}，等它发出来再答。`);
      }
      return replyText(ws, msg, '现在没有进行中的游戏。发 /on猜卡、/on猜曲、/on猜语音 开一局。');
    }
    if (!guess) return replyText(ws, msg, '用法：/回答 <你猜的名字>（/答、/猜 同义）');
    const hit = guessHit(guess, r.answer.accept);
    if (hit) {
      dropRound(gameKey(msg));
      const uid = String((msg.sender && msg.sender.user_id) || '');
      let note = '';
      if (uid) {
        const rec = SCORE[uid] || (SCORE[uid] = { win: 0 });
        rec.win = Number(rec.win || 0) + 1;
        rec[r.type] = Number(rec[r.type] || 0) + 1;
        rec.name = (msg.sender && (msg.sender.card || msg.sender.nickname)) || rec.name || '';
        rec.at = new Date().toISOString();
        saveScore();
        note = `你答对过 ${rec.win} 次`;
      }
      return revealRound(ws, msg, r, `答对了！${hit.how ? hit.how + '，' : ''}` +
        (r.tries ? `（第 ${r.tries + 1} 次猜中）` : ''), note);
    }
    r.tries++;
    if (r.tries >= GAME_GIVEUP_AT) {
      dropRound(gameKey(msg));
      return revealRound(ws, msg, r, `猜了 ${r.tries} 次都没对，`);
    }
    return replyText(ws, msg, wrongReply(r, guess));
  }

  async function handleEnd(ws, msg) {
    const r = roundOf(msg);
    if (!r) {
      const prep = GAME_PREPARING.get(gameKey(msg));
      if (prep) return replyText(ws, msg, `「${GAME_KIND[prep.type]}」的谜面还在准备中，等它出来再结束吧。`);
      return replyText(ws, msg, '现在没有进行中的游戏。');
    }
    dropRound(gameKey(msg));
    return revealRound(ws, msg, r, '这局结束了，');
  }

  // ================= Our Notes 玩家名片（好友接口公开资料）=================
  //  数据来自 /app.friend.FriendService/FindByProfileID（按「资料ID」查任何人）
  //  只读：我们自己不发任何写操作；绑定只是把「QQ → 资料ID」记下来
  const ON_PLAYER_BRIDGE = path.join(__dirname, 'tools', 'on_player.js');
  const ON_BINDS_FILE = path.join(ON_DIR, 'player_binds.json');
  const ON_PLAYER_CACHE = path.join(ON_DIR, 'cache', 'player');
  const ON_RANK_TABLE = (function () {
    try {
      const rows = (readJson(path.join(ON_DIR, 'master', 'MasterPlayerRank.json'), {}) || {})._allData || [];
      return rows.slice().sort(function (a, b) { return (a._rank || 0) - (b._rank || 0); });
    } catch (e) { return []; }
  })();

  function onBridge(args, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const child = spawn('node', [ON_PLAYER_BRIDGE].concat(args), { cwd: __dirname });
      let out = '', err = '', done = false;
      const timer = setTimeout(function () {
        if (!done) { try { child.kill('SIGKILL'); } catch (e) {} reject(new Error('查询超时')); }
      }, timeoutMs || 45000);
      child.stdout.on('data', function (d) { out += d.toString(); });
      child.stderr.on('data', function (d) { err += d.toString(); });
      child.on('error', function (e) { done = true; clearTimeout(timer); reject(e); });
      child.on('close', function () {
        done = true; clearTimeout(timer);
        const text = out.trim();
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error((err || out || '没有输出').trim().slice(0, 200))); }
      });
    });
  }

  function onBindsRead() {
    const raw = readJson(ON_BINDS_FILE, {}) || {};
    const out = {};
    Object.keys(raw).forEach(function (k) {
      const v = raw[k];
      if (v && Array.isArray(v.list)) out[k] = { list: v.list.filter(function (x) { return x && x.id; }) };
    });
    return out;
  }
  function onBindsWrite(o) {
    try { fs.mkdirSync(path.dirname(ON_BINDS_FILE), { recursive: true }); } catch (e) {}
    fs.writeFileSync(ON_BINDS_FILE, JSON.stringify(o, null, 1));
  }
  function onMyList(qq) { const b = onBindsRead(); return (b[qq] && b[qq].list) || []; }
  function onSaveList(qq, list) {
    const b = onBindsRead();
    if (list && list.length) b[qq] = { list: list }; else delete b[qq];
    onBindsWrite(b);
  }
  function onSlot(arg, len) {
    const m = /^[uU]?(\d{1,2})$/.exec(String(arg || '').trim());
    if (!m) return null;
    const n = Number(m[1]);
    if (!n || n > len) return null;
    return n - 1;
  }
  function onRankOf(exp) {
    if (!ON_RANK_TABLE.length) return { rank: 0 };
    let cur = ON_RANK_TABLE[0], next = null;
    for (let i = 0; i < ON_RANK_TABLE.length; i++) {
      if ((ON_RANK_TABLE[i]._exp || 0) <= exp) { cur = ON_RANK_TABLE[i]; next = ON_RANK_TABLE[i + 1] || null; }
      else break;
    }
    return { rank: cur._rank, friendMax: cur._friendMax, nextExp: next ? next._exp : null };
  }
  function onFmtTime(ts) {
    const n = Number(ts || 0);
    if (!n) return '';
    const d = new Date(n * 1000);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
      + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  /** 把 protocol 返回的 profile 变成渲染载荷 + 要下载的图片 URL */
  function onProfilePayload(p) {
    const exp = Number(p.rank_exp || 0);
    const rk = onRankOf(exp);
    const fm = p.favorite_member_card || {};
    const cardId = Number(fm.card_id || p.favorite_member_card_master_id || 0);
    let cardName = '', charName = '', rarity = 0;
    try {
      const mc = ((readJson(path.join(ON_DIR, 'master', 'MasterMemberCard.json'), {}) || {})._allData || [])
        .find(function (x) { return x._id === cardId; });
      const text = (readJson(path.join(ON_DIR, 'master', 'MasterText.json'), {}) || {})._allData || [];
      const t = function (id) { const r = text.find(function (x) { return String(x._id) === String(id); }); return r ? (r._simplifiedChinese || r._japanese || '') : ''; };
      if (mc) {
        cardName = t(mc._nameTextID) || ('卡 ' + cardId);
        const ch = ((readJson(path.join(ON_DIR, 'master', 'MasterCharacter.json'), {}) || {})._allData || [])
          .find(function (x) { return x._id === mc._characterID; });
        charName = ch ? t(ch._nameTextID) : '';
        rarity = mc._rarity || 0;
      }
    } catch (e) {}
    const pc = p.profile_card || {};
    const zip = function (urls, i) {
      const u = (urls || [])[i];
      return u ? path.join(ON_PLAYER_CACHE, 'pc_' + p.profile_id + '_' + (pc.slot || 0) + '_' + i + '_' + hashCode(u) + path.extname(new URL(u).pathname || '.png')) : null;
    };
    const urls = pc.thumbnail_url || [];
    return {
      payload: {
        name: p.name || '', profileId: p.profile_id || p.id || '',
        rank: rk.rank, rankExp: exp, rankNextExp: rk.nextExp, friendMax: rk.friendMax,
        lastUpdatedAt: onFmtTime(p.last_updated_at),
        avatarCardId: cardId,
        avatar: cardId ? path.join('/www/wwwroot/ournotes-web', 'avatar-images', 'avatar-' + cardId + '.webp') : null,
        card: { name: cardName, charName: charName, rarity: rarity, cardRank: fm.card_rank || 0, awake: fm.awake_count || 0,
                liveSkill: fm.live_skill_level || 0, perfSkill: fm.performance_skill_level || 0,
                art: cardId ? path.join(ON_DIR, 'art', 'full', cardId + '.jpg') : null },
        profileCard: { slot: pc.slot || 0, name: pc.name || '', images: urls.map(function (u, i) { return zip(urls, i); }).filter(Boolean) },
        note: '数据来自游戏内「好友 → ID搜索」能看到的那份公开资料（只读）。',
      },
      urls: urls.slice(0, 4).map(function (u, i) { return { url: u, file: zip(urls, i) }; }),
    };
  }
  function hashCode(s) {
    let h = 0;
    for (let i = 0; i < String(s).length; i++) { h = (h * 31 + String(s).charCodeAt(i)) | 0; }
    return Math.abs(h).toString(16).slice(0, 8);
  }
  /** 资料指纹变了就把这个号的资料卡缓存图片删掉（URL 没变但内容变了的情况） */
  function onPruneProfileImages(profileId, sig) {
    const metaFile = path.join(ON_PLAYER_CACHE, 'meta_' + profileId + '.json');
    const prev = readJson(metaFile, null);
    if (prev && prev.sig === sig) return false;
    try {
      fs.mkdirSync(ON_PLAYER_CACHE, { recursive: true });
      for (const f of fs.readdirSync(ON_PLAYER_CACHE)) {
        if (f.indexOf('pc_' + profileId + '_') === 0) { try { fs.unlinkSync(path.join(ON_PLAYER_CACHE, f)); } catch (e) {} }
      }
    } catch (e) {}
    try { fs.writeFileSync(metaFile, JSON.stringify({ sig: sig, at: Date.now() })); } catch (e) {}
    return true;
  }

  async function onDownload(url, file) {
    if (!url || !file) return null;
    if (fs.existsSync(file) && fs.statSync(file).size > 1024) return file;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) {}
    try {
      await curl(url, file);                   // on_commands 里已有的下载器（curl，跟随跳转）
      return (fs.existsSync(file) && fs.statSync(file).size > 1024) ? file : null;
    } catch (e) { return null; }
  }

  /** /on绑定 <资料ID> */
  async function handleOnBind(ws, msg, arg) {
    const qq = String((msg.sender && msg.sender.user_id) || '');
    const id = String(arg || '').trim();
    if (!/^\d+$/.test(id)) {
      return replyText(ws, msg, '用法：/on绑定 <游戏资料ID>\n资料ID 在游戏内「菜单 → 个人资料」里查看。\n如果要绑定网页账号，请发送 /on绑定网页 <6 位码>，网页：https://on.tabsac.com/#cloud');
    }
    try {
      const r = await onBridge(['friend', id]);
      const p = r && r.player_profile;
      if (!p) return replyText(ws, msg, '没有查到资料ID ' + id + '（号码写错、或该玩家不存在）。');
      const list = onMyList(qq);
      const i = list.findIndex(function (x) { return String(x.id) === String(p.profile_id || id); });
      const item = { id: String(p.profile_id || id), name: p.name || '', at: Date.now() };
      let slot;
      if (i >= 0) { list[i] = item; slot = i + 1; } else { list.push(item); slot = list.length; }
      onSaveList(qq, list);
      return replyText(ws, msg, '绑定成功：' + (p.name || '(无名)') + ' → u' + slot + '（资料ID ' + item.id + '）。\n'
        + '共绑定 ' + list.length + ' 个：/on绑定列表 看全部，/on个人信息 [uN] 看名片（默认 u1），/on解绑 uN 解绑。');
    } catch (e) {
      return replyText(ws, msg, '绑定失败：' + String(e.message || e).slice(0, 160));
    }
  }

  /** /on绑定列表 */
  async function handleOnBindList(ws, msg) {
    const qq = String((msg.sender && msg.sender.user_id) || '');
    const list = onMyList(qq);
    if (!list.length) return replyText(ws, msg, '还没有绑定任何资料ID。用法：/on绑定 <资料ID>（游戏内「菜单 → 个人资料」里那串数字）。');
    const lines = list.map(function (x, i) { return 'u' + (i + 1) + '　' + (x.name || '(无名)') + '　资料ID ' + x.id; });
    lines.push('');
    lines.push('u1 是默认号：/on个人信息 就是看它；看别的号发 /on个人信息 u2。');
    lines.push('调顺序 /on交换绑定 u1 u2，删掉一个 /on解绑 u2。');
    return replyText(ws, msg, '已绑定 ' + list.length + ' 个：\n' + lines.join('\n'));
  }

  /** /on解绑 uN */
  async function handleOnUnbind(ws, msg, arg) {
    const qq = String((msg.sender && msg.sender.user_id) || '');
    const list = onMyList(qq);
    if (!list.length) return replyText(ws, msg, '你还没有绑定任何资料ID，先发 /on绑定 <资料ID>。');
    const i = onSlot(arg, list.length);
    if (i == null) return replyText(ws, msg, '要解绑哪个？发 /on解绑 u1 ～ u' + list.length + '（编号看 /on绑定列表）。');
    const gone = list.splice(i, 1)[0];
    onSaveList(qq, list);
    return replyText(ws, msg, '已解绑 u' + (i + 1) + '：' + (gone.name || gone.id) + '。'
      + (list.length ? '\n现在还剩 ' + list.length + ' 个，默认号 u1 是 ' + (list[0].name || list[0].id) + '。' : '\n现在没有绑定任何资料ID了。'));
  }

  /** /on交换绑定 u1 u2 */
  async function handleOnSwapBind(ws, msg, arg) {
    const qq = String((msg.sender && msg.sender.user_id) || '');
    const list = onMyList(qq);
    if (list.length < 2) return replyText(ws, msg, '至少绑两个才能换顺序（现在 ' + list.length + ' 个）。');
    const parts = String(arg || '').trim().split(/[\s　,，]+/).filter(Boolean);
    if (parts.length !== 2) return replyText(ws, msg, '用法：/on交换绑定 u1 u2（编号看 /on绑定列表）。');
    const a = onSlot(parts[0], list.length), b = onSlot(parts[1], list.length);
    if (a == null || b == null || a === b) return replyText(ws, msg, '编号要写 u1 ～ u' + list.length + '，且两个不同。');
    const t = list[a]; list[a] = list[b]; list[b] = t;
    onSaveList(qq, list);
    return replyText(ws, msg, '已交换 u' + (a + 1) + ' ↔ u' + (b + 1) + '。\n现在默认号（u1）是 ' + (list[0].name || list[0].id) + '。');
  }

  /** /on个人信息 [uN] */
  async function handleOnPlayer(ws, msg, arg) {
    const qq = String((msg.sender && msg.sender.user_id) || '');
    const list = onMyList(qq);
    const raw = String(arg || '').trim();

    // 指定了 uN：行为完全不变（必须来自 /on绑定 列表）
    if (raw) {
      if (!list.length) {
        return replyText(ws, msg, '还没有绑定资料ID，所以看不到名片。\n'
          + '用法：/on绑定 <资料ID> —— 资料ID 在游戏内「菜单 → 个人资料」里（一串数字）。\n'
          + '绑定后 /on个人信息 看默认号（u1），/on个人信息 u2 看第二个。');
      }
      const k = onSlot(raw, list.length);
      if (k == null) return replyText(ws, msg, '编号只到 u' + list.length + '。发 /on个人信息 看默认号，或 /on个人信息 u2 指定。');
      return onPlayerShot(ws, msg, list[k], k, list, qq);
    }

    // 没指定 uN：优先用「网页端上传的 uid」（登录过的玩家），没有才用 /on绑定 的第一条
    let webUid = null;
    try {
      webUid = onWebUid(await onApiUserData(qq));
    } catch (e) {
      console.log('[on] 取网页 uid 失败（继续用本地绑定）:', String(e.message || e));
    }
    if (webUid) {
      const dup = list.findIndex((x) => String(x.id) === webUid);
      // 已在绑定列表里 → 用那条（保留自定义名字与编号语义）
      if (dup >= 0) return onPlayerShot(ws, msg, list[dup], dup, list, qq);
      return onPlayerShot(ws, msg, { id: webUid, name: null, fromWeb: true }, -1, list, qq);
    }
    if (!list.length) {
      return replyText(ws, msg, '还没有绑定资料ID，所以看不到名片。\n'
        + '两种方式任选：\n'
        + '· /on绑定 <资料ID> —— 资料ID 在游戏内「菜单 → 个人资料」里（一串数字）\n'
        + '· /on绑定网页 <6 位码> —— 把 QQ 绑到网页版账号；在网页版导入过账号包后，\n'
        + '  导入账号包后，/on个人信息 会使用其中的资料ID\n'
        + '网页版：https://on.tabsac.com/#account');
    }
    return onPlayerShot(ws, msg, list[0], 0, list, qq);
  }

  // The same public friend-profile endpoint and card mapping used by /on个人信息.
  async function onPublicPlayer(qq, data, preferredId) {
    const id = preferredId || onWebUid(data) || ((onMyList(qq)[0] || {}).id);
    if (!id) return null;
    try {
      const r = await onBridge(['friend', String(id)], 15000);
      return r && r.player_profile ? onProfilePayload(r.player_profile).payload : null;
    } catch (e) {
      console.log('[on] Public player profile unavailable; render without avatar/header');
      return null;
    }
  }

  /** 真正去查并渲染名片（原 handleOnPlayer 的主体，抽出来供两条路径复用）
   *  slot < 0 表示目标来自网页上传、不在绑定列表里（不写回列表） */
  async function onPlayerShot(ws, msg, target, i, list, qq) {
    const out = path.join(ON_DIR, 'cache', 'playershot_' + target.id + '.png');
    try {
      const r = await onBridge(['friend', String(target.id)]);
      const p = r && r.player_profile;
      if (!p) {
        return replyText(ws, msg, (i >= 0 ? 'u' + (i + 1) : '网页上传的 #' + target.id)
          + ' 的资料暂时查不到（接口没返回这个资料ID）。');
      }
      const built = onProfilePayload(p);
      // 指纹：等级经验 / 更新时间 / 资料卡槽位与名字 / 缩略图 URL 列表，任一变了就重下图片
      const sig = [p.rank_exp || 0, p.last_updated_at || 0, built.payload.profileCard.slot,
        built.payload.profileCard.name, (built.payload.profileCard.images || []).length,
        (p.profile_card && (p.profile_card.thumbnail_url || [])).join(',')].join('|');
      const changed = onPruneProfileImages(target.id, sig);
      if (changed) console.log('[on] 资料有变化，重新拉取资料卡图片：' + target.id);
      for (const it of built.urls) { try { await onDownload(it.url, it.file); } catch (e) {} }
      const inJson = path.join(ON_DIR, 'cache', 'player_' + target.id + '.json');
      try { fs.mkdirSync(path.dirname(inJson), { recursive: true }); } catch (e) {}
      fs.writeFileSync(inJson, JSON.stringify(built.payload));
      const file = await runPy(['player.py', '--in', inJson, '--out', out], out);
      // 名字变了顺手刷新列表（资料会变，绑定只记 ID）
      if (i >= 0 && p.name && p.name !== target.name) {
        list[i] = Object.assign({}, target, { name: p.name, at: Date.now() });
        onSaveList(qq, list);
      } else if (i < 0 && p.name) {
        console.log('[on] 名片用的资料ID来自网页上传：' + target.id + '（' + p.name + '）');
      }
      return replyImage(ws, msg, file);
    } catch (e) {
      return replyText(ws, msg, '查询失败：' + String(e.message || e).slice(0, 160));
    }
  }

  // ---------------- 网页版登录码（机器人领码 → 用户在网页上换 token）----------------
  //  后端：tools/planner_api.py（127.0.0.1:8080），内部接口只认本机 + X-Bot-Secret
  const ON_API_ENV_FILE = path.join(ON_DIR, '..', 'api', 'api.env');

  function onApiEnv() {
    const out = {};
    try {
      for (const line of fs.readFileSync(ON_API_ENV_FILE, 'utf8').split('\n')) {
        const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
        if (m) out[m[1]] = m[2].trim();
      }
    } catch (e) {}
    return out;
  }

  /**
   * 拉该 QQ 在网页端保存的数据（B25 / 卡库），走本机 8080 转发 → 东京内部接口。
   * 内部接口要 X-Bot-Secret；404 表示这个 QQ 没绑网页账号（不是错误）。
   * 结果缓存 5 分钟，避免每条命令都打后端。
   */
  const onWebCache = new Map();          // qq -> { at, data }

  function onApiUserData(qq, force, kind = '') {
    const key = String(qq) + (kind ? ':' + kind : '');
    const hit = onWebCache.get(key);
    if (!force && hit && Date.now() - hit.at < 5 * 60 * 1000) return Promise.resolve(hit.data);
    const env = onApiEnv();
    const port = env.ON_API_PORT || '8080';
    const secret = env.ON_BOT_SECRET || '';
    if (!secret) return Promise.reject(new Error('后端没配 ON_BOT_SECRET（data/api/api.env）'));
    const p = '/api/internal/user-data?qq=' + encodeURIComponent(String(qq)) + '&full=1' + (kind === 'activity' ? '&kind=activity&latest=1' : '');
    return new Promise((resolve, reject) => {
      const req = require('http').request({
        host: '127.0.0.1', port: Number(port), path: p, method: 'GET',
        headers: { 'X-Bot-Secret': secret }, timeout: 12000,
      }, (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(Buffer.concat(c).toString('utf8')); } catch (e) {}
          if (res.statusCode === 200 && j) {
            onWebCache.set(key, { at: Date.now(), data: j });
            resolve(j);
          } else if (res.statusCode === 404) {
            const empty = { account: null, results: [] };   // 这个 QQ 没绑网页账号
            onWebCache.set(key, { at: Date.now(), data: empty });
            resolve(empty);
          } else {
            reject(new Error('后端返回 ' + res.statusCode + (j && j.message ? '：' + j.message : '')));
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('后端超时')));
      req.on('error', reject);
      req.end();
    });
  }

  function onWebB25(data) {
    return ((data && data.results) || []).find((x) => x.kind === 'b25') || null;
  }

  function onWebProfile(data) {
    return ((data && data.results) || []).find((x) => x.kind === 'profile') || null;
  }

  /** 网页端上传的「玩家资料ID」：优先卡库的 account_import.account_id，其次 B25 的 accountId */
  function onWebUid(data) {
    const prof = onWebProfile(data);
    const ai = prof && prof.payload && prof.payload.document && prof.payload.document.account_import;
    if (ai && ai.account_id) return String(ai.account_id);
    const b = onWebB25(data);
    const pid = b && b.payload && (b.payload.accountId || (b.payload.player || {}).account_id);
    return pid ? String(pid) : null;
  }

  /** 向后端要一个一次性登录码；返回 { code, expiresIn } */
  function onApiLoginCode(qq) {
    const env = onApiEnv();
    const port = env.ON_API_PORT || '8080';
    const secret = env.ON_BOT_SECRET || '';
    if (!secret) return Promise.reject(new Error('后端没配 ON_BOT_SECRET（data/api/api.env）'));
    const body = Buffer.from(JSON.stringify({ qq: String(qq) }), 'utf8');
    return new Promise((resolve, reject) => {
      const req = require('http').request({
        host: '127.0.0.1', port: Number(port), path: '/api/internal/login-code', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'X-Bot-Secret': secret },
        timeout: 8000,
      }, (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(Buffer.concat(c).toString('utf8')); } catch (e) {}
          if (res.statusCode === 200 && j && j.code) resolve(j);
          else reject(new Error('后端返回 ' + res.statusCode + (j && j.message ? '：' + j.message : '')));
        });
      });
      req.on('timeout', () => req.destroy(new Error('后端超时')));
      req.on('error', reject);
      req.end(body);
    });
  }

  let b25Queue = Promise.resolve(), b25Pending = 0;
  function runB25(src, out, renderer = 'b25-render.cjs') {
    if (b25Pending >= 3) return Promise.reject(new Error('B25 render queue full'));
    b25Pending += 1;
    const job = b25Queue.then(() => new Promise((resolve, reject) => {
      const runtime = path.join(ON_DIR, 'b25-runtime');
      const child = spawn(process.execPath, ['--max-old-space-size=128', path.join(runtime, 'tools', renderer), '--in', src, '--out', out],
        {cwd: ON_DIR, env: Object.assign({}, process.env, {SKIA_THREADS: '1'})});
      let log = '', done = false;
      const timer = setTimeout(() => { if (!done) child.kill('SIGKILL'); }, 30000);
      child.stderr.on('data', d => { log = (log + d.toString()).slice(-2000); });
      child.on('error', e => { done = true; clearTimeout(timer); reject(e); });
      child.on('close', code => { done = true; clearTimeout(timer);
        if (code === 0 && fs.existsSync(out)) resolve(out);
        else reject(new Error(log.trim() || 'B25 render failed'));
      });
    }));
    b25Queue = job.catch(() => {});
    return job.finally(() => { b25Pending -= 1; });
  }

  const deckPending=new Map();
  function onApiDeck(body){const env=onApiEnv(),secret=env.ON_BOT_SECRET||'';if(!secret)return Promise.reject(Error('组卡账号服务暂不可用。'));const bytes=Buffer.from(JSON.stringify(body));return new Promise((resolve,reject)=>{const req=require('http').request({host:'127.0.0.1',port:Number(env.ON_API_PORT||8080),path:'/api/internal/deck-jobs',method:'POST',headers:{'Content-Type':'application/json','Content-Length':bytes.length,'X-Bot-Secret':secret},timeout:15000},res=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks));if(res.statusCode===200&&value.job)resolve(value);else reject(Error(value.message||'组卡接口暂不可用。'));}catch(e){reject(e);}});});req.on('timeout',()=>req.destroy(Error('组卡接口超时，请稍后重试。')));req.on('error',reject);req.end(bytes);});}
  async function handleSavedCloudDeck(ws,msg,qq,command,goal,skip){
    const titles={leaderboard:'活动歌榜',activity:'活动收益（CP、PT、徽章）',gekiso:'激奏组卡',daily:'自由组卡',fire:'日常 / 清火组卡'};
    const method=skip?'skip':'ap',key=qq+':saved:'+goal+':'+method;
    if(deckPending.has(key))return replyText(ws,msg,'正在读取并生成这项云端组卡图片，请稍候。');
    const web=command+'尚无匹配的云端结果。请在网页勾选「'+titles[goal]+'」，选择'+(skip?'Skip':'非 Skip')+'后计算并同步云端。\nhttps://on.tabsac.com/#plan';
    if(deckPending.size>=8)return replyText(ws,msg,'当前组卡请求较多，请稍后再试。');
    deckPending.set(key,true);
    let input,output,outputs=[];
    const dir=path.join(ON_DIR,'tmp'),stamp='saved-deck-'+Date.now()+'-'+crypto.randomBytes(6).toString('hex');
    try{
      const data=await onApiUserData(qq,true);
      if(!data.account)return replyText(ws,msg,'请先在网页绑定当前 QQ，再读取已上传的组卡结果。\nhttps://on.tabsac.com/#cloud');
      const preferred=onWebUid(data)||String((onMyList(qq)[0]||{}).id||'');
      const selected=require('./lib/cloud_deck_results.cjs').selectCloudDeck(data,{goal,method,profileId:preferred});
      if(!selected)return replyText(ws,msg,web);
      const batch=structuredClone(selected.batch);batch.player=await onPublicPlayer(qq,data,selected.profileId);
      fs.mkdirSync(dir,{recursive:true});input=path.join(dir,stamp+'.json');output=path.join(dir,stamp+'.png');
      fs.writeFileSync(input,JSON.stringify(batch),{mode:0o600});await runB25(input,output,'deck-render.cjs');
      outputs=JSON.parse(fs.readFileSync(output+'.pages.json','utf8'));
      for(const file of outputs){if(path.dirname(file)!==dir||!path.basename(file).startsWith(stamp))throw Error('图片路径无效。');}
      for(const file of outputs)replyImage(ws,msg,file);
      return replyText(ws,msg,'已读取云端保存的'+command+'结果（'+(skip?'Skip':'非 Skip')+'）。\nhttps://on.tabsac.com/#plan');
    }catch(e){console.error('[on] saved deck render failed:',e.message);return replyText(ws,msg,'云端组卡结果读取或图片生成失败，请稍后重试。\nhttps://on.tabsac.com/#plan');}
    finally{
      for(const file of [input,output&&output+'.pages.json'])if(file)try{fs.unlinkSync(file);}catch{}
      setTimeout(()=>{for(const file of outputs)if(path.dirname(file)===dir&&path.basename(file).startsWith(stamp))try{fs.unlinkSync(file);}catch{}},300000).unref();
      deckPending.delete(key);
    }
  }

  async function handleCloudDeck(ws,msg,command,arg){
    const qq=String(msg.sender?.user_id||msg.user_id||'');let raw=String(arg||'').trim();const skip=/(?:^|\s)skip(?:\s|$)/i.test(raw);raw=raw.replace(/(?:^|\s)skip(?=\s|$)/ig,' ').trim();
    const goal=command==='歌榜组卡'?'leaderboard':command==='活动组卡'?'activity':command==='激奏组卡'?'gekiso':command==='自由组卡'?'daily':'fire';
    if(raw==='平均')raw='';if(raw&& !['daily','gekiso'].includes(goal))return replyText(ws,msg,'只有 /on激奏组卡 和 /on自由组卡 支持指定歌曲；其他指令可添加 skip。');
    let song='';if(raw){const matched=resolveSong(raw);if(!matched)return replyText(ws,msg,'未找到歌曲：'+raw+'。可先使用 /on查曲 查询名称。');song=String(matched.id);}
    if(!song)return handleSavedCloudDeck(ws,msg,qq,command,goal,skip);
    const options={goals:[goal],methods:[skip?'skip':'ap'],song,maxLevel:99,boost:4,searchSeconds:3};const key=qq+JSON.stringify(options);
    if(deckPending.has(key))return replyText(ws,msg,'这项组卡正在计算，完成后会自动发送图片。可在网页查看进度：https://on.tabsac.com/#plan');
    if(deckPending.size>=8)return replyText(ws,msg,'当前组卡请求较多，请稍后再试。');
    deckPending.set(key,true);
    try{
      let response=await onApiDeck({qq,options}),job=response.job;const profileId=response.profileId;
      if(['queued','running'].includes(job.status))replyText(ws,msg,command+'已提交，'+(job.status==='queued'?'正在排队':'正在计算')+'，完成后自动发送。云端会保存结果。\nhttps://on.tabsac.com/#plan');
      const start=Date.now();let longNotice=false;while(['queued','running'].includes(job.status)){if(!longNotice&&Date.now()-start>30*60*1000){longNotice=true;replyText(ws,msg,'本批仍在计算，完成后会继续自动发图。可到网页查看进度或取消：https://on.tabsac.com/#plan');}await new Promise(r=>setTimeout(r,Date.now()-start>60000?15000:3000));job=(await onApiDeck({qq,id:job.id})).job;}
      if(job.status!=='complete')return replyText(ws,msg,'本批'+(job.status==='cancelled'?'已取消':'尚未完成')+'：'+(job.error||'请查看云端记录')+'\nhttps://on.tabsac.com/#plan');
      const batch=structuredClone(job.result);let data;try{data=await onApiUserData(qq,true);}catch{}batch.player=await onPublicPlayer(qq,data,profileId);
      const dir=path.join(ON_DIR,'tmp');fs.mkdirSync(dir,{recursive:true});const stamp='deck-'+Date.now()+'-'+crypto.randomBytes(6).toString('hex'),input=path.join(dir,stamp+'.json'),output=path.join(dir,stamp+'.png');let outputs=[];
      try{fs.writeFileSync(input,JSON.stringify(batch),{mode:0o600});await runB25(input,output,'deck-render.cjs');outputs=JSON.parse(fs.readFileSync(output+'.pages.json','utf8'));for(const file of outputs){if(path.dirname(file)!==dir||!path.basename(file).startsWith(stamp))throw Error('图片路径无效。');replyImage(ws,msg,file);}replyText(ws,msg,(job.reused?'已复用云端结果。':'计算完成，结果已保存到云端。')+'\n'+(goal==='gekiso'?'激奏为单人任务模型参考，尚不能预测多人连胜。\n':'')+'https://on.tabsac.com/#plan');}
      finally{for(const file of [input,output+'.pages.json'])try{fs.unlinkSync(file);}catch{}setTimeout(()=>{for(const file of outputs)if(path.dirname(file)===dir&&path.basename(file).startsWith(stamp))try{fs.unlinkSync(file);}catch{}},300000).unref();}
    }catch(e){replyText(ws,msg,e.message+'\n网页：https://on.tabsac.com/#plan\n绑定 QQ：https://on.tabsac.com/#cloud');}
    finally{deckPending.delete(key);}
  }

  async function handleActivityDeck(ws, msg) {
    const qq = String((msg.sender && msg.sender.user_id) || '');
    let data;
    try {data = await onApiUserData(qq, true, 'activity');} catch {return replyText(ws,msg,'暂时无法读取组卡方案，请稍后重试。网页：https://on.tabsac.com/');}
    const rows = ((data && data.results) || []).filter(r=>r.kind==='activity' && r.payload && r.payload.result && r.payload.schema_version===1);
    rows.sort((a,b)=>String(b.payload.savedAt||'').localeCompare(String(a.payload.savedAt||'')));
    if (!rows.length) return replyText(ws,msg,'还没有已保存的活动组卡方案。\n打开 https://on.tabsac.com/，登录账号并完成收益计算，结果会自动保存。\n在 https://on.tabsac.com/#cloud 绑定 QQ 后，再发送 /on活动组卡。');
    const p=rows[0].payload;
    let model;
    try {model=JSON.parse(fs.readFileSync('/www/wwwroot/ournotes-web/build-info.json','utf8')).activity_model;} catch {return replyText(ws,msg,'组卡图片暂时不可用，请稍后重试。网页：https://on.tabsac.com/');}
    if(p.model!==model) return replyText(ws,msg,'活动数据或计算模型已更新，请打开 https://on.tabsac.com/ 重新计算，完成后会自动保存新方案。');
    const dir=path.join(ON_DIR,'tmp');fs.mkdirSync(dir,{recursive:true});
    const stamp='activity-'+Date.now()+'-'+crypto.randomBytes(6).toString('hex');
    const input=path.join(dir,stamp+'.json'),out=path.join(dir,stamp+'.png');
    try {
      fs.writeFileSync(input,JSON.stringify(p),{mode:0o600});
      await runB25(input,out,'activity-render.cjs');replyImage(ws,msg,out);
      return replyText(ws,msg,'活动组卡方案\n计算日期：'+String(p.computedAt||p.savedAt||'').slice(0,10)+'\n网页：https://on.tabsac.com/');
    } catch(e) {console.error('[on] activity render failed:',e.message);return replyText(ws,msg,'组卡图片生成失败，请在 https://on.tabsac.com/ 下载图片，或重新计算后再试。');}
    finally {try{fs.unlinkSync(input);}catch{}setTimeout(()=>{try{fs.unlinkSync(out);}catch{}},300000).unref();}
  }

  /** /onb25 —— 看自己在网页版保存的 B25 成绩卡（渲染成一张图） */
  async function handleOnB25(ws, msg) {
    const qq = String((msg.sender && msg.sender.user_id) || '');
    let data;
    try {
      data = await onApiUserData(qq, true);            // 命令是显式查询，绕过缓存
    } catch (e) {
      return replyText(ws, msg, '暂时无法读取成绩，请稍后重试。网页：https://on.tabsac.com/#b25');
    }
    const b = onWebB25(data);
    if (!b) {
      return replyText(ws, msg, '还没有可显示的 B25 成绩卡。\n'
        + '1. 打开 https://on.tabsac.com/#account，导入游戏账号包。\n'
        + '2. 登录网页账号，在「B25 成绩」页点击「把这张卡存到云端」。\n'
        + '3. 在 https://on.tabsac.com/#cloud 点击「绑定 QQ」，然后在这里发送 /on绑定网页 <6 位码>。\n'
        + '完成后发送 /onb25 查看成绩图片。');
    }
    const p = Object.assign({}, b.payload || {});
    p.player = Object.assign({}, p.player || {});
    const livePlayer = await onPublicPlayer(qq, data, p.accountId || p.player.account_id);
    // Never keep a stale imported favourite card when the public lookup fails.
    delete p.player.favorite_card_id;
    p.player.avatar_card_id = livePlayer ? livePlayer.avatarCardId : null;
    const st = p.stats || {};
    const cacheDir = path.join(ON_DIR, 'cache');
    const stamp = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const out = path.join(cacheDir, 'b25_' + qq + '_' + stamp + '.png');
    const jsonPath = path.join(cacheDir, 'b25_' + qq + '_' + stamp + '.json');
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(jsonPath, JSON.stringify(p));
      const upd = String(p.savedAt || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
      const site = 'https://on.tabsac.com/';
      const file = await runB25(jsonPath, out);
      console.log('[on] /onb25 ' + qq + ' -> ' + (p.playerName || '') + ' Rating ' + (st.rating_avg != null ? st.rating_avg : '-')
        + ' 计入 ' + (st.count != null ? st.count : '-') + ' FC ' + (st.fc_count != null ? st.fc_count : '-')
        + '/' + (st.ap_count != null ? st.ap_count : '-') + ' v' + (b.version != null ? b.version : '?'));
      // 先发图（网页端那张导出图的版式），再补一行「已显示 / 更新日期 / 网站」
      replyImage(ws, msg, file);
      return replyText(ws, msg, 'B25 成绩卡\n更新日期：' + upd + '\n网页：' + site + '#b25');
    } catch (e) {
      console.error('[on] B25 render failed:', e.message || e);
      return replyText(ws, msg, '成绩图片生成失败，请稍后重试，或到网页下载：https://on.tabsac.com/#b25');
    } finally {
      try { fs.unlinkSync(jsonPath); } catch (_) {}
      const cleanup = setTimeout(() => { try { fs.unlinkSync(out); } catch (_) {} }, 5 * 60 * 1000);
      cleanup.unref();
    }
  }

  /** 兑换网页端生成的 QQ 绑定码：/on绑定网页 <6 位码> */
  async function handleWebBindQQ(ws, msg, arg) {
    const qq = String((msg.sender && msg.sender.user_id) || '');
    const code = String(arg || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return replyText(ws, msg, '用法：/on绑定网页 <6 位码>\n'
        + '· 打开 https://on.tabsac.com/#cloud 并登录网页账号\n'
        + '· 网页里点「绑定 QQ」，它会给你一串 6 位码\n'
        + '· 再回到这里发：/on绑定网页 <那串码>');
    }
    const env = onApiEnv();
    const secret = env.ON_BOT_SECRET || '';
    if (!secret) return replyText(ws, msg, '账号服务暂不可用，请联系管理员。');
    const body = Buffer.from(JSON.stringify({ code: code, qq: qq }), 'utf8');
    try {
      const r = await new Promise((resolve, reject) => {
        const req = require('http').request({
          host: '127.0.0.1', port: Number(env.ON_API_PORT || '8080'), path: '/api/internal/bind-qq', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'X-Bot-Secret': secret },
          timeout: 8000,
        }, (res) => {
          const c = [];
          res.on('data', (d) => c.push(d));
          res.on('end', () => {
            let j = null;
            try { j = JSON.parse(Buffer.concat(c).toString('utf8')); } catch (e) {}
            resolve({ status: res.statusCode, body: j || {} });
          });
        });
        req.on('timeout', () => req.destroy(new Error('后端超时')));
        req.on('error', reject);
        req.end(body);
      });
      if (r.status === 200 && r.body.ok) {
        return replyText(ws, msg, '绑定成功：这个 QQ（' + qq + '）已绑到网页账号「' + (r.body.username || '') + '」。\n'
          + '以后在网页上用账号密码登录就行，忘密码时也能靠这个 QQ 找回（找管理员）。');
      }
      return replyText(ws, msg, '绑定失败：' + (r.body.message || ('后端返回 ' + r.status))
        + '\n（码 10 分钟内有效、且只能用一次；也可能是这个 QQ 已经绑过别的账号了）');
    } catch (e) {
      return replyText(ws, msg, '绑定失败：' + String((e && e.message) || e).slice(0, 140)
        + '\n请稍后重试，或联系管理员。网页：https://on.tabsac.com/#cloud');
    }
  }

  // ---------------- 匹配注册
  const defs = [
    { re: /^\s*\/on(?:guesscard|猜卡|gcard)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleGuessCard(ws, msg, m[1] || ''), shortOnly: true },
    { re: /^\s*\/on(?:guesssong|猜曲|gsong)\s*([\s\S]*)$/i, run: (ws, msg) => handleGuessSong(ws, msg), shortOnly: true },
    { re: /^\s*\/on(?:guessvoice|猜语音|gvoice)\s*([\s\S]*)$/i, run: (ws, msg) => handleGuessVoice(ws, msg), shortOnly: true },
    { re: /^\s*\/(?:回答|答|猜)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleAnswer(ws, msg, m[1] || ''), shortOnly: true },
    { re: /^\s*\/(?:结束|放弃)\s*([\s\S]*)$/i, run: (ws, msg) => handleEnd(ws, msg), shortOnly: true },
    { re: /^\s*\/on(?:charalias|角色别名)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleCharAlias(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:card|查卡)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleCard(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:support|留影|留影卡)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleSupport(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:comic|小漫画|漫画)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleComic(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:rank|难度排行|排行)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleRank(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:benefit|效益排行|效益)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleEff(ws, msg, m[1] || '', 'benefit') },
    { re: /^\s*\/on(?:efficiency|eff|效率排行|效率)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleEff(ws, msg, m[1] || '', 'eff') },
    { re: /^\s*\/on(?:stamp|emote|表情)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleCollectible(ws, msg, m[1] || '', 'emote') },
    { re: /^\s*\/on(?:sticker|贴纸)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleCollectible(ws, msg, m[1] || '', 'degree') },
    // 玩家名片：绑定列表 / 解绑 / 交换绑定 / 绑定网页 都要排在「绑定」前面，
    // 否则参数会被 /on绑定 先吃掉（踩过：/on绑定网页 123456 被当成资料ID 123456 去查 gRPC）
    { re: /^\s*\/on(歌榜组卡|活动组卡|激奏组卡|自由组卡|日常组卡|清火组卡)\s*([\s\S]*)$/i, run: (ws,msg,m) => handleCloudDeck(ws,msg,m[1],m[2]||'') },
    { re: /^\s*\/on(?:b25|B25|b25成绩|成绩卡)\s*([\s\S]*)$/i, run: (ws, msg) => handleOnB25(ws, msg) },
    { re: /^\s*\/on个人信息\s*([\s\S]*)$/i, run: (ws, msg, m) => handleOnPlayer(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:绑定网页|网页绑定|绑定页面|页面绑定|webbind)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleWebBindQQ(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:绑定列表|bindlist|账号列表)\s*([\s\S]*)$/i, run: (ws, msg) => handleOnBindList(ws, msg) },
    { re: /^\s*\/on(?:解绑|unbind)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleOnUnbind(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:交换绑定|swapbind)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleOnSwapBind(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:绑定|bind)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleOnBind(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:个人信息|我的信息|名片|me|profile)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleOnPlayer(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:gacha|卡池|招募)\s*([\s\S]*)$/i, run: (ws, msg) => handleGacha(ws, msg) },
    { re: /^\s*\/on(?:event|活动|活动一览)\s*([\s\S]*)$/i, run: (ws, msg) => handleEvent(ws, msg) },
    { re: /^\s*\/on(?:song|曲|查曲)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleSong(ws, msg, m[1] || '') },
    // 「听曲 / 听歌」必须排在「听」前面：/on听 的正则原先把 /on听歌 的「歌」当成参数吞掉（踩过）
    { re: /^\s*\/on(?:listen|听曲|听歌)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleListen(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:voice|语音|听(?!曲|歌))\s*([\s\S]*)$/i, run: (ws, msg, m) => handleVoice(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:chart|chartinfo|谱面预览|谱面数据|谱面|查谱面)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleChart(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:alias|别名|添加别名)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleAlias(ws, msg, m[1] || '') },
    { re: /^\s*\/(?:review|待审核)\s*([\s\S]*)$/i, run: (ws, msg) => handlePending(ws, msg) },
    { re: /^\s*\/(?:block|阻止)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleBlock(ws, msg, m[1] || '') },
    { re: /^\s*\/(?:approve|通过)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleApprove(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:update|更新)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleUpdate(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:help|帮助|说明|\?)\s*([\s\S]*)$/i, run: (ws, msg, m) => replyText(ws, msg, helpFor(m[1] || '')) },
  ];
  for (const d of defs) {
    commands.push({
      ignoreAt: true,
      shortOnly: !!d.shortOnly,
      match(plainText) {
        const m = d.re.exec(plainText || '');
        return m ? { m } : false;
      },
      execute(ws, msg, params) {
        d.run(ws, msg, params.m);
      },
    });
  }

  console.log('Our Notes 指令已注册: /on查卡 /oncard /on留影 /on查曲 /on听曲 /on听 /on谱面预览 /on查谱面 /on小漫画 /on卡池 /on活动 /on贴纸 /on难度排行 /on效益排行 /on效率排行 /on猜卡 /on猜曲 /on猜语音 /回答 /结束 /on添加别名 /on角色别名 /on待审核 /on通过 /on阻止 /on更新 /onhelp'
    + `（角色 ${INDEX ? INDEX.characters.length : 0} / 卡片 ${INDEX ? INDEX.cards.length : 0} / 曲目 ${SONGS ? SONGS.songs.length : 0}`
    + `，别名 ${Object.keys(ALIASES).length} 条，CRI密钥 ${process.env.ON_CRI_KEY ? '已配置' : '未配置'}）`);
}

module.exports = register;
