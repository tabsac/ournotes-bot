# -*- coding: utf-8 -*-
"""扩展版 songs.json：加入难度/连击数/谱面包名/MV/主唱头像/读音，供 /on查曲、/on听曲、/on谱面预览 使用。"""
import json
import os
import re
import shutil

def _secret(key):
    """密钥/凭据：环境变量 → ../secrets.json（不入库）"""
    import json as _json
    env = {'cdnAuth': 'ON_CDN_AUTH', 'masterKey': 'ON_MASTER_KEY', 'masterIv': 'ON_MASTER_IV',
           'bundleKey': 'ON_BUNDLE_KEY', 'bundleSeed': 'ON_BUNDLE_SEED', 'hcaBaseKey': 'ON_HCA_BASE_KEY'}
    v = os.environ.get(env.get(key, key))
    if v:
        return v
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'secrets.json'),
                  encoding='utf-8') as fh:
            return _json.load(fh).get(key)
    except Exception:
        return None



BASE = r"C:\Users\13766\dsh-workspace"
MIRROR = r"C:\Users\13766\.dsh\remote-workspaces\39.105.184.173-root-22\dsh_server_workspace"
MD = "/home/admin/bot/data/on/master"
CATALOG = "/home/admin/bot/data/on/catalog.bin"
JKT = "/home/admin/bot/data/on/art/jacket"


def L(name):
    with open(os.path.join(MD, name + ".json"), encoding="utf-8") as f:
        return json.load(f)["_allData"]


TEXT = {str(r["_id"]): r for r in L("MasterText")}
MUSIC = L("MasterLiveMusic")
SOUND = {str(r["_id"]): r for r in L("MasterSound")}
CUE = {str(r["_id"]): r for r in L("MasterSoundCueSheet")}
CHARS = {c["_id"]: c for c in L("MasterCharacter")}
BANDS = {b["_id"]: b for b in L("MasterBand")}
SCORE = {str(r["_id"]): r for r in L("MasterLiveMusicScore")}
VIDEO = {v["_id"]: v for v in L("MasterVideo")}
CARDS = L("MasterMemberCard")
TYPE = {1: "绯红", 2: "绀碧", 3: "翡翠", 4: "琉金", 5: "紫苑"}
DIFFS = [("EASY", "_easyID"), ("NORMAL", "_normalID"), ("HARD", "_hardID"), ("EXPERT", "_expertID")]

catalog = open(CATALOG, "rb").read().decode("latin1")
bundles = set(re.findall(r"[A-Za-z0-9_/]+_[0-9a-f]{32}\.bundle", catalog))
cri, chart = {}, {}
for b in bundles:
    if b.startswith("cri_assets_cri_sound_"):
        cri.setdefault(b[len("cri_assets_cri_sound_"):].rsplit("_", 1)[0].lower(), b)
    m = re.match(r"(live_assets_live_musicscore_\d+_\d+_\d+)_[0-9a-f]{32}\.bundle$", b)
    if m:
        chart[m.group(1)] = b


def t(tid, lang="_simplifiedChinese"):
    r = TEXT.get(str(tid))
    if not r:
        return ""
    return r.get(lang) or ""


# 角色 -> 用于头像的卡（取该角色稀有度最低的卡缩略图）
avatar = {}
for c in sorted(CARDS, key=lambda x: x["_rarity"]):
    avatar.setdefault(c["_characterID"], c["_id"])

songs = []
for m in MUSIC:
    sid = m["_id"]
    jingle = str(m.get("_jingleSoundID") or "")
    cue = CUE.get(jingle, {}).get("_cueSheetName") or SOUND.get(jingle, {}).get("_cueName") or ""
    charts = []
    for label, key in DIFFS:
        cid = str(m.get(key) or "")
        row = SCORE.get(cid)
        if not row:
            continue
        txtfile = row.get("_musicScoreTextFileName") or ""
        stem = "live_assets_live_musicscore_" + txtfile.replace("/", "_")
        charts.append({
            "name": label,
            "level": row["_musicScoreLevel"],
            "display": row["_musicScoreDisplayLevel"],
            "combo": row["_fullComboCount"],
            "textFile": txtfile,
            "bundle": chart.get(stem),
        })
    vocals = []
    for cid in (m.get("_vocalCharacterIDs") or []):
        ch = CHARS.get(cid)
        if ch:
            vocals.append({"id": cid, "name": t(ch["_nameTextID"]),
                           "avatarCard": avatar.get(cid)})
    videos = [VIDEO[v] for v in (m.get("_musicVideoIDs") or []) if v in VIDEO]
    songs.append({
        "id": sid,
        "title": t(m["_titleTextID"]),
        "title_tw": t(m["_titleTextID"], "_traditionalChinese"),
        "title_jp": t(m["_titleTextID"], "_japanese"),
        "title_en": t(m["_titleTextID"], "_english"),
        "phonetic": t(m["_phoneticTextID"]) or t(m["_phoneticTextID"], "_japanese"),
        "band": [{"id": b, "name": t(BANDS[b]["_nameTextID"])} for b in (m.get("_bandIDs") or []) if b in BANDS],
        "vocals": vocals,
        "type": TYPE.get(m.get("_musicType")),
        "typeId": m.get("_musicType"),
        "jacket": m.get("_jacketAssetName") or "",
        "shortCue": cue,
        "acbBundle": cri.get(cue.lower()) if cue else None,
        "lyricist": t(m.get("_lyricistTextID")),
        "composer": t(m.get("_composerTextID")),
        "arranger": t(m.get("_arrangerTextID")),
        "releaseAt": m.get("_startAt"),
        "mv": ({"asset": videos[0]["_assetName"], "w": videos[0]["_width"], "h": videos[0]["_height"]}
               if videos else None),
        "charts": charts,
        "unlock": m.get("_defaultUnlock"),
    })

out = {
    "source": "Our Notes 主数据 MasterLiveMusic / MasterLiveMusicScore / MasterVideo / MasterText",
    "count": len(songs),
    "cdn": "https://l14-prod-hk-patch-sirius.gamerfusiontech.com/prod/hk_27f3c91e8b62d6056c7a19f2e83b6d10/asset/Android",
    "auth": os.environ.get("ON_CDN_AUTH") or _secret("cdnAuth") or "",
    "songs": sorted(songs, key=lambda s: s["id"]),
}
os.makedirs(os.path.join(MIRROR, "on"), exist_ok=True)
with open("/home/admin/bot/data/on/songs.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

no_jacket = [s["id"] for s in songs if s["jacket"] and not os.path.exists(os.path.join(JKT, s["jacket"] + ".jpg"))]
no_chart = [s["id"] for s in songs if not s["charts"] or any(c["bundle"] is None for c in s["charts"])]
print(f"songs.json: {len(songs)} 首 | 缺封面 {len(no_jacket)} | 缺谱面包 {len(no_chart)}")
print(f"示例: {songs[0]['title']} / {songs[0]['title_jp']} / 读音 {songs[0]['phonetic']} / 难度 "
      + " ".join(f"{c['name']}{c['display']:g}({c['combo']})" for c in songs[0]["charts"]))

dst = "/home/admin/bot/data/on/art/jacket"
os.makedirs(dst, exist_ok=True)
n = 0
for s in songs:
    p = os.path.join(JKT, s["jacket"] + ".jpg")
    if os.path.abspath(p) == os.path.abspath(os.path.join(dst, s["jacket"] + ".jpg")):
        continue                                   # 源与目标同目录（服务器上就是这种情况）
    if s["jacket"] and os.path.exists(p):
        shutil.copy(p, os.path.join(dst, s["jacket"] + ".jpg"))
        n += 1
print(f"封面 -> {dst}: {n} 张")
