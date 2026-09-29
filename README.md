# Our Notes 指令模块（BanG Dream! Our Notes）

`on_commands.js`：手游 **BanG Dream! Our Notes** 的 QQ 机器人指令模块（OneBot v11）——
查卡、查曲、听曲（含完整版）、角色语音、谱面预览与难度排行、卡池、贴纸、小漫画、效益 / 效率排行……

> 非官方粉丝项目。游戏素材与数据版权归 **Bushiroad / Craft Egg / Ishimori** 所有。
> 本仓库只包含**指令模块与配套工具**，不含任何游戏素材、主数据或解密密钥。

## 怎么接进机器人

模块自己**不连 QQ**，由宿主 OneBot v11 应用（NapCat 等）调用注册：

```js
const register = require('./on_commands.js');

register({
  commands,            // 数组；每条 { ignoreAt, match(plainText, msg), execute(ws, msg, params) }
                       // 宿主逐条试 match，命中就 execute —— 匹配不过就返回 false
  sendReply,           // (ws, action, params) => void，把 action 发给 QQ
  imageCqFromPath,     // (file) => '[CQ:image,file=…]'
  CONFIG,              // 宿主配置对象（本模块只用其中少量字段）
});
```

模块约定：`ignoreAt: true` 的指令不需要 @ 机器人也能触发；其余按宿主的 @ 规则走。

## 仓库内容

```
on_commands.js          /on* 指令实现（查卡 / 查曲 / 听曲 / 角色语音 / 谱面 / 排行 / 卡池 / 贴纸 / 小漫画 …）
lib/secrets.js|.py      密钥读取（环境变量 → secrets.json）
tools/
  on_update.js          资源包增量更新（catalog hash → bundle diff → 下载解密）
  on_master.js          主数据增量更新（gRPC 版本 → manifest → 解密），完成后自动重建索引
  master_decrypt.py     主数据表解密（Rijndael-256-CBC）
  rijndael.py           Rijndael 实现
  build_songs2.py       songs.json 生成器
  build_index.py        index.json（角色 / 卡牌索引）生成器
  fetch_charts.js       把全部谱面抓到本地缓存
  build_score.py        按主数据表推算「单局理论分（效益）」与「效率」
  acb.js                UnityFS bundle → ACB（试听包 / 完整版分片两种布局）
  hca_dec.c             CRI HCA 解码器（直接驱动 clHCA，含 per-file 密钥推导）
  hca_decode.py         定位 HCA/AWB/ACB 并调 hca_dec
  clhca.c/.h/_data.h    vgmstream 的 clHCA（上游实现，见下）
  cri_url.py            catalog → CRI 音频包 URL 映射（角色语音用）
  acb_cues.py           ACB → 按 cue 名取出音轨并解码（角色语音用）
  verify_voicepacks.js  角色语音音频包全量校验（两条打包路线各取一次）
  export_asset.js       按资源名从 bundle 里导出图片（卡池封面等）
  audio_selftest.js     全曲音频自检（走与指令相同的代码路径）
  grpc_probe.js         gRPC 免登录方法面探测
data/on/
  cardimg.py            卡牌网格 / 单卡详情图
  songimg.py            曲目卡
  chart3.py             谱面预览（数据 / 绘制 / 统计）
  stampimg.py           贴纸图鉴
  rankimg.py            难度排行图
  effimg.py             效益 / 效率排行图
  gachainfo.py          当期卡池数据与文本一览
  gachaimg.py           当期卡池一览图（封面 + 期间 + 概率 + Pick Up）
  unitysrc/             UnityFS / 序列化文件 / 贴图解析（含 lz4hc、ASTC 解码）
tests/                  假 NapCat 客户端，用来触发指令（需要有一个跑起来的宿主）
```

## 快速开始

```bash
# 1) 依赖
npm install                       # ws
npm i texture2ddecoder-wasm       # unitysrc 的 ASTC / 贴图解码
pip3 install pillow               # 图片渲染
apt install ffmpeg curl python3   # 音频转码 / 下载

# 2) 密钥（不入库）
cp secrets.example.json secrets.json   # 按上表填入真值；也可改用同名的 ON_* 环境变量

# 3) 数据（本仓库不含数据，需自行从游戏 CDN 拉取）
node tools/on_update.js --apply   # 资源包 → data/on/art/…、音频
node tools/on_master.js --apply   # 主数据 → data/on/master/*.json（并重建 songs.json / index.json）
node tools/fetch_charts.js        # 谱面缓存 → data/on/chart/*.json
python3 tools/build_score.py      # 效益 / 效率排行数据 → data/on/score.json
python3 tools/cri_url.py          # CRI 音频包映射 → data/on/cri_url.json（角色语音用）

# 4) 接进宿主后即可使用（tests/ 里的脚本连的是宿主的 OneBot 端口）
```

## 密钥说明（重要）

这些值来自对游戏客户端的逆向：客户端自己下载、自己解密自己的资源，密钥固化在客户端内部，
逆向读出的结果所有人相同，与部署者无关；它们不是账号、密码或注册凭据。

配置有两个来源，读取顺序为**环境变量 → 仓库根目录的 `secrets.json`**（实现见 `lib/secrets.js`）。
仓库里保留的 `secrets.example.json` 只是字段清单（里面写的是说明文字），真值文件
`secrets.json` 已列入 `.gitignore`。

| 字段 | 环境变量 | 是什么 | 从哪来 | 缺失后果 |
|---|---|---|---|---|
| `bundleKey` | `ON_BUNDLE_KEY` | UnityFS 资源包的 AES-128 密钥（32 位 hex） | 客户端解密逻辑里的常量 | `.bundle` 解不开，图片 / 谱面 / 音频都取不出来 |
| `bundleSeed` | `ON_BUNDLE_SEED` | 同一套 AES-CTR 的 nonce 种子（16 位 hex）：每个包的 nonce = `SHA256(seed ‖ 包文件名)[0:8]`，且只加密每个包的前 16 KB | 同上 | 同 `bundleKey`（两者成对使用） |
| `masterKey` | `ON_MASTER_KEY` | 主数据表密钥（64 位 hex）；算法是 Rijndael-256-CBC（Nb=8），不是 AES | 客户端解密逻辑里的常量 | `data/on/master/*.json` 解不开，查卡 / 查曲 / 卡池 / 贴纸 / 查谱面没有数据 |
| `masterIv` | `ON_MASTER_IV` | 主数据表 CBC 的初始向量（64 位 hex）；每个 `.bin` 的前 64 字节是明文头（32 字节固定前缀 + IV），密文从第 64 字节起 | 同上 | 同 `masterKey` |
| `hcaBaseKey` | `ON_HCA_BASE_KEY` | HCA 音频的基础密钥（hex）；单个文件的实际密钥 = 基础密钥 × 该文件自己的 subkey，而 subkey 存在音频文件头里（AFS2 `+0x0E`） | 客户端解密逻辑里的常量 | 「听曲」「角色语音」与 `tools/hca_dec` 无法解码 |
| `cdnAuth` | `ON_CDN_AUTH` | 访问官方 CDN 的 HTTP Basic 凭据（`user:pass`）；六项里唯一属于服务凭据、而非客户端内置常量的一项 | 客户端请求 CDN 时携带的 `Authorization: Basic …` 头 | `tools/on_update.js`、`tools/on_master.js` 无法下载资源 |
| `admin` | `ON_ADMIN` | 本模块的管理员 QQ（别名登记、资源更新等指令用） | 部署方填写 | 管理类指令不可用 |

以上各项在用到对应功能时才会报错，错误信息给出缺失的字段名与应设置的环境变量名（`lib/secrets.js`）。
宿主应用可能还使用其它字段（例如机器人自身的 QQ、屏蔽名单），那些与指令模块无关。

## 第三方代码

* `tools/clhca.c` / `clhca.h` / `clhca_data.h` —— 取自 [vgmstream](https://github.com/vgmstream/vgmstream)
  的 `src/coding/libs/`（CRI HCA 解码库）。版权与许可归其作者（kode54 / nyaga）。
* `data/on/unitysrc/` 里的 ASTC / 贴图解码依赖 `texture2ddecoder-wasm`。

## 许可

代码以 MIT 发布；**游戏素材、主数据、解密密钥不在许可范围内**，也不随本仓库分发。
