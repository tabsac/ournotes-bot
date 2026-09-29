'use strict';
/**
 * Our Notes（com.bilibili.sirius.official）指令模块
 *
 *  卡片
 *    /on查卡 <角色|团体|颜色> [星级]  卡片网格图（/oncard 同义）
 *    /on查卡 <数字ID>                单卡详情图
 *  曲目
 *    /on查曲 <曲名|别名>        曲目卡（封面/作曲作词编曲/MV/BPM/时长/四难度/别名）
 *    /on听曲 <曲名|别名>        歌曲语音（有完整版发完整版，否则发试听片段）
 *    /on听 [角色]               角色语音：随机一条 + 中文文本（双引号）
 *    /on谱面预览 <曲名> [难度]   谱面长图（/on查谱面 是同一条；难度 ex/hd/nor/ez，默认 ex）
 *  图鉴
 *    /on小漫画 [角色]           随机一张加载漫画
 *    /on卡池                    当期招募一览图（封面 + 期间 + 概率 + Pick Up）
 *    /on贴纸 [角色]             贴纸图鉴
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
const ADMIN = String(process.env.ON_ADMIN || require(path.join(__dirname, 'lib', 'secrets.js')).get('admin') || '');
const RENDER_TIMEOUT_MS = 90 * 1000;
const withBundle = (n) => (String(n || '').endsWith('.bundle') ? String(n) : String(n || '') + '.bundle');

// ---- CDN 包解密：UnityFS 明文直接用；否则按 unity-node 的方案解密
//   key/seed 见 secrets.json（ON_BUNDLE_KEY / ON_BUNDLE_SEED）
//   nonce = SHA256(seed || utf8(bundleName))[0:8]
//   计数块 = nonce(8) || BE64(blockIndex)，AES-128-ECB 生成 keystream
//   只异或前 min(size,16384) 字节，尾部原样保留
const crypto = require('crypto');
const { need } = require(path.join(__dirname, 'lib', 'secrets.js'));
const BUNDLE_KEY = Buffer.from(need('bundleKey', 'ON_BUNDLE_KEY', 'UnityFS 资源包 AES-128 密钥'), 'hex');
const BUNDLE_SEED = Buffer.from(need('bundleSeed', 'ON_BUNDLE_SEED', 'bundle nonce seed'), 'hex');
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
async function ensureAudio(song, opts) {
  try { fs.mkdirSync(AUDIO_DIR, { recursive: true }); } catch (e) {}
  if (!song.acbBundle) throw new Error('这首曲子没有对应的音频包');

  // opts.short：只要试听包（~28 秒，包小、下得快），猜曲这类只用 3 秒的场合用
  const full = (opts && opts.short) ? null : fullBundleFor(song.acbBundle);
  const want = full || song.acbBundle;
  const mp3 = path.join(AUDIO_DIR, `${song.id}${full ? '' : '.short'}.mp3`);
  if (fs.existsSync(mp3) && fs.statSync(mp3).size > 4096) return mp3;

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
    c.on('close', (code) => (code === 0 && fs.existsSync(mp3) ? res() : rej(new Error('转码失败: ' + log.slice(-120)))));
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
    '/on贴纸 [角色]                贴纸图，不给角色就发全部',
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
    '查卡': ['/on查卡（/oncard）',
      '用法 /on查卡 <角色> [星级]　/on查卡 <团体|颜色> [星级]　/on查卡 <数字ID>',
      '按角色或按团体 / 颜色发卡片列表图；给数字 ID 就发单卡详情图。',
      '星级 SSR / SR / R / BD / EX',
      '团体 MyGO!!!!! / Ave Mujica / millsage / 一家Dumb Rock! / 梦限大MewType',
      '颜色 红 / 蓝 / 绿 / 黄 / 紫',
      '例 /on查卡 灯　/on查卡 MyGO 蓝 SSR　/on查卡 12'],
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
    '卡池': ['/on卡池（/ongacha、/on招募）',
      '用法 /on卡池',
      '当前正在开的招募，画成一张图：卡池封面、活动期间、各星级概率、Pick Up 卡片。'],
    '贴纸': ['/on贴纸（/onstamp）',
      '用法 /on贴纸 [角色]',
      '该角色的贴纸图鉴；不给角色就发全部角色的。',
      '例 /on贴纸 灯　/on贴纸'],
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
      '答：/回答 <角色名>（/答、/猜 同义；别名、日文名、写得很接近都算对）；放弃就 /结束。'],
    '猜曲': ['/on猜曲（/onguesssong）',
      '用法 /on猜曲',
      '随机抽一首曲子，发其中 3 秒音频，猜曲名。',
      '答：/回答 <曲名>（别名与相近写法都算对）；放弃就 /结束。'],
    '猜语音': ['/on猜语音（/onguessvoice）',
      '用法 /on猜语音',
      '随机抽一条角色语音，发其中 3 秒，猜是哪个角色。',
      '答：/回答 <角色名>；放弃就 /结束。'],
    '回答': ['/回答（/答、/猜 同义）',
      '用法 /回答 <答案>',
      '回答 /on猜卡、/on猜曲、/on猜语音 开的那一局，答错可以继续答，3 次后会提示，6 次未果自动公布答案。',
      '答对会记一次战绩（按 QQ），并回一句「你答对过 N 次」。'],
    '结束': ['/结束（/放弃 同义）',
      '用法 /结束',
      '结束当前这一局并公布答案（猜卡会连完整卡面一起发出来）。'],
  };

  // /onhelp 的参数 → 上面的键（中英文名与常用简称都认）
  const HELP_ALIAS = {
    'card': '查卡', '查卡': '查卡', '卡片': '查卡',
    'song': '查曲', '曲': '查曲', '查曲': '查曲', '曲目': '查曲',
    'listen': '听曲', '听曲': '听曲', '听歌': '听曲',
    'voice': '角色语音', '语音': '角色语音', '听': '角色语音',
    'chart': '谱面预览', '谱面预览': '谱面预览', '谱面': '谱面预览',
    'chartinfo': '谱面预览', '查谱面': '谱面预览', '谱面数据': '谱面预览',
    'comic': '小漫画', '小漫画': '小漫画', '漫画': '小漫画',
    'gacha': '卡池', '卡池': '卡池', '招募': '卡池',
    'stamp': '贴纸', '贴纸': '贴纸',
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

  // ---------------- 卡片
  async function handleCard(ws, msg, arg) {
    const q = parseCardQuery(arg);
    if (q.kind === 'help') return replyText(ws, msg, helpFor('查卡'));
    if (q.kind === 'detail') {
      try {
        const out = path.join(CACHE_DIR, `detail_${q.id}.png`);
        const f = fs.existsSync(out) ? out : await runPy(['cardimg.py', 'detail', '--id', String(q.id), '--out', out], out);
        return replyImage(ws, msg, f);
      } catch (e) {
        if (/没有 ID=/.test(errText(e))) return replyText(ws, msg, `没有 ID=${q.id} 的卡片（本版本共 60 张：1–60）。`);
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
        const f = fs.existsSync(out) ? out
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
      const f = fs.existsSync(out) ? out
        : await runPy(['cardimg.py', 'grid', '--char', ch.name].concat(q.rarity ? ['--rarity', q.rarity] : []).concat(['--out', out]), out);
      return replyImage(ws, msg, f);
    } catch (e) {
      console.error('[on] 网格失败:', errText(e));
      return replyText(ws, msg, '图片生成失败：' + errText(e));
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
    if (fs.existsSync(mp3) && fs.statSync(mp3).size > 2048) return mp3;
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
      c.on('close', (code) => (code === 0 && fs.existsSync(mp3) ? res() : rej(new Error('转码失败: ' + log.slice(-120)))));
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

  // ---------------- 贴纸
  async function handleStamp(ws, msg, arg) {
    const q = String(arg || '').trim();
    const out = path.join(CACHE_DIR, 'stamp_' + (q ? norm(q).slice(0, 24) : 'all') + '.png');
    try {
      const f = fs.existsSync(out) ? out
        : await runPy(['stampimg.py'].concat(q ? ['--char', q] : []).concat(['--out', out]), out);
      return replyImage(ws, msg, f);
    } catch (e) {
      if (/没有找到角色/.test(errText(e))) {
        const names = INDEX ? INDEX.characters.map((c) => c.name).join('、') : '';
        return replyText(ws, msg, `没有找到角色「${q}」。可用角色：${names}`);
      }
      console.error('[on] 贴纸失败:', errText(e));
      return replyText(ws, msg, '贴纸图生成失败：' + errText(e));
    }
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
  // 谜面与文字同一条发出；收局给完整语音 / 原文 / 曲绘 / 完整卡面。
  const GAMES = new Map();                     // 'g:<群号>' / 'p:<QQ>' -> 当前这一局
  const GAME_TTL_MS = 30 * 60 * 1000;          // 半小时没动静就作废
  const GAME_KIND = { card: '猜卡', song: '猜曲', voice: '猜语音' };
  const GAME_HINT_AT = 3;                      // 答错几次给提示
  const GAME_GIVEUP_AT = 6;                    // 答错几次自动公布答案
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
    if (r && r.file) { try { fs.unlinkSync(r.file); } catch (e) {} }
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

  const guessPrompt = (r) => {
    const head = r.type === 'song' ? '听 3 秒，这是哪首歌？'
      : r.type === 'voice' ? '听 3 秒，这是哪个角色？'
        : '这是哪张卡的角色？';
    return `${GAME_KIND[r.type]}：${head}\n发 /回答 <答案>（/答、/猜 同义），放弃发 /结束`;
  };

  const mediaSeg = (type, f) => ({ type: type, data: { file: 'file://' + f } });

  /** 开一局：记状态 → 谜面与文字**同一条**发出 */
  function openRound(ws, msg, r, file, seg) {
    dropRound(gameKey(msg));
    sweepGuessTmp();
    r.at = Date.now();
    r.tries = 0;
    r.file = file || null;
    GAMES.set(gameKey(msg), r);
    console.log(`[on] ${GAME_KIND[r.type]}开局 key=${gameKey(msg)} 答案=${r.answer.label}`);
    const t = target(msg);
    const segs = [];
    if (seg) segs.push(seg);
    segs.push({ type: 'text', data: { text: guessPrompt(r) } });
    sendReply(ws, t.action, Object.assign({}, t.base, { message: segs }));
  }

  /** 猜卡：随机一张非 R 卡，剪卡面极小一块当谜面 */
  async function handleGuessCard(ws, msg, arg) {
    if (!INDEX) return replyText(ws, msg, '卡片数据缺失（先让管理员跑 /on更新 主数据）');
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
          hint: `提示：这个角色属于 ${ch.band || '？'}` };
        return openRound(ws, msg, r, out, mediaSeg('image', out));
      } catch (e) { /* 这张没有完整卡面，换一张 */ }
    }
    return replyText(ws, msg, '拿不到可用的卡面，稍后再试。');
  }

  /** 猜曲：纯随机抽一首（不看有没有缓存），**直接用完整版**剪 3 秒
   *  （完整版只当剪片段的素材，收局不发它） */
  async function handleGuessSong(ws, msg) {
    if (!SONGS || !SONGS.songs.length) return replyText(ws, msg, '曲目数据缺失（先让管理员跑 /on更新 主数据）');
    const all = SONGS.songs.filter((s) => s.acbBundle);
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      const song = all[Math.floor(Math.random() * all.length)];
      const out = path.join('/tmp', `guess_song_${song.id}_${Math.random().toString(36).slice(2, 8)}.mp3`);
      try {
        const mp3 = await ensureAudio(song);          // 直接抓完整版
        await clipAudio(mp3, out);
        const r = { type: 'song', answer: { label: songLabel(song), accept: songNames(song), song: song.id },
          hint: `提示：这首歌来自 ${bandNameOf(song)}` };
        return openRound(ws, msg, r, out, mediaSeg('record', out));
      } catch (e) {
        lastErr = e;
        console.error('[on] 猜曲准备失败:', errText(e));
      }
    }
    return replyText(ws, msg, '音频拿不到，稍后再试。' + (lastErr ? '（' + errText(lastErr) + '）' : ''));
  }

  /** 猜语音：随机一条角色语音，剪 3 秒 */
  async function handleGuessVoice(ws, msg) {
    const all = voices();
    if (!all.length) return replyText(ws, msg, '语音数据缺失（先让管理员跑 /on更新 主数据）');
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
          hint: `提示：这个角色属于 ${ch.band || '？'}` };
        return openRound(ws, msg, r, out, mediaSeg('record', out));
      } catch (e) {
        lastErr = e;
        console.error('[on] 猜语音准备失败:', errText(e));
      }
    }
    return replyText(ws, msg, '语音拿不到，稍后再试。' + (lastErr ? '（' + errText(lastErr) + '）' : ''));
  }

  /** 曲子的团体名（谜面提示用） */
  function bandNameOf(song) {
    try {
      const b = song.band;
      if (Array.isArray(b) && b.length) return b.map((x) => x.name).join(' / ');
      if (typeof b === 'string' && b.trim()) {
        const m = /'name':\s*'([^']+)'/.exec(b);
        if (m) return m[1];
      }
    } catch (e) {}
    return '？';
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
    if (audio) segs.push(mediaSeg('record', audio));
    replyMixed(ws, msg, segs);
  }

  async function handleAnswer(ws, msg, arg) {
    const guess = String(arg || '').trim();
    const r = roundOf(msg);
    if (!r) return replyText(ws, msg, '现在没有进行中的游戏。发 /on猜卡、/on猜曲 或 /on猜语音 开一局。');
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
    if (r.tries === GAME_HINT_AT && r.hint) {
      return replyText(ws, msg, `还不对。${r.hint}`);
    }
    return replyText(ws, msg, '不对，再想想～' + (r.hint && r.tries > GAME_HINT_AT ? '　' + r.hint : ''));
  }

  async function handleEnd(ws, msg) {
    const r = roundOf(msg);
    if (!r) return replyText(ws, msg, '现在没有进行中的游戏。');
    dropRound(gameKey(msg));
    return revealRound(ws, msg, r, '这局结束了，');
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
    { re: /^\s*\/on(?:voice|语音|听)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleVoice(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:comic|小漫画|漫画)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleComic(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:rank|难度排行|排行)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleRank(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:benefit|效益排行|效益)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleEff(ws, msg, m[1] || '', 'benefit') },
    { re: /^\s*\/on(?:efficiency|eff|效率排行|效率)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleEff(ws, msg, m[1] || '', 'eff') },
    { re: /^\s*\/on(?:stamp|贴纸)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleStamp(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:gacha|卡池|招募)\s*([\s\S]*)$/i, run: (ws, msg) => handleGacha(ws, msg) },
    { re: /^\s*\/on(?:song|曲|查曲)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleSong(ws, msg, m[1] || '') },
    { re: /^\s*\/on(?:listen|听曲|听歌)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleListen(ws, msg, m[1] || '') },
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

  console.log('Our Notes 指令已注册: /on查卡 /oncard /on查曲 /on听曲 /on听 /on谱面预览 /on查谱面 /on小漫画 /on卡池 /on贴纸 /on难度排行 /on效益排行 /on效率排行 /on猜卡 /on猜曲 /on猜语音 /回答 /结束 /on添加别名 /on角色别名 /on待审核 /on通过 /on阻止 /on更新 /onhelp'
    + `（角色 ${INDEX ? INDEX.characters.length : 0} / 卡片 ${INDEX ? INDEX.cards.length : 0} / 曲目 ${SONGS ? SONGS.songs.length : 0}`
    + `，别名 ${Object.keys(ALIASES).length} 条，CRI密钥 ${process.env.ON_CRI_KEY ? '已配置' : '未配置'}）`);
}

module.exports = register;
