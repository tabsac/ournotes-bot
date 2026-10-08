// Canonical B25 PNG drawing shared by the browser download and QQ bot.
// Adapters provide Canvas/Image implementations and load identical public assets.
const DIFF_LABEL = {easy: "EASY", normal: "NORMAL", hard: "HARD", expert: "EXPERT"};
const int = v => Number(v || 0).toLocaleString("en-US");
const num = v => (Math.round(Number(v) * 100) / 100).toFixed(2).replace(/\.00$/, "");
const lvl = v => (v == null || v === "") ? "-" : String(Number(Number(v).toFixed(2)));
function jacketUrl(entry) { return "./jacket-images/" + (entry.jacket || "placeholder.webp"); }
function medalFor(rating, extras) {
    const tiers = extras?.total_rating_tiers;
    if (!tiers || !tiers.length) return null;
    let hit = tiers[0];
    for (const tier of tiers) {
        if (rating >= tier[0]) hit = tier;
        else break;
    }
    const grade = hit[1];
    const names = {0: "铜牌", 1: "银牌", 2: "金牌"};
    // 下一档还差多少
    const next = tiers.find(t => t[0] > rating);
    return {
        grade,
        step: hit[2],
        key: extras?.source?.medal_grades?.[grade] ?? "bronze",
        name: names[grade] ?? `等级 ${grade}`,
        threshold: hit[0],
        next: next ? next[0] : null,
        toNext: next ? next[0] - rating : 0,
    };
}

/** 玩家等级：MasterPlayerRank 的 _exp 门槛表。 */
function rankFor(exp, extras) {
    const table = extras?.player_rank;
    if (!table || !table.length) return null;
    let rank = table[0][0];
    for (const [r, need] of table) {
        if (exp >= need) rank = r;
        else break;
    }
    return rank;
}

function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let cut = text;
    while (cut.length > 1 && ctx.measureText(cut + "…").width > maxWidth) cut = cut.slice(0, -1);
    return cut + "…";
}

/** 按宽度折行（最多 maxLines 行，最后一行放不下才省略）。canvas 没有自动换行。 */
function wrapText(ctx, text, maxWidth, maxLines) {
    const chars = [...String(text)];
    const lines = [];
    let cur = "";
    for (const ch of chars) {
        const next = cur + ch;
        if (ctx.measureText(next).width <= maxWidth || !cur) {
            cur = next;
        } else {
            lines.push(cur);
            cur = ch;
            if (lines.length === maxLines) break;
        }
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    if (lines.length === maxLines) {
        const last = lines[maxLines - 1];
        const rest = chars.slice(lines.join("").length);
        if (rest.length && ctx.measureText(last).width > maxWidth - 12) {
            lines[maxLines - 1] = fitText(ctx, last, maxWidth);
        }
    }
    return lines.length ? lines : [""];
}
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/** 画牌子（canvas 版，和页面上那个 SVG 一致：圆牌 + 高音谱号 + 星星）。 */

function drawMedal(ctx, medal, x, y, starImage, gradeImages) {
    // 牌子直接用游戏原图（grade-bronze / silver / gold），不用再染色
    const brand = gradeImages && gradeImages[medal.key];
    if (brand) {
        // 牌子宽度 = 星条上「第2颗星左沿 → 第5颗星右沿」= 56px，再左移 2px 微调
        // 星条起点 x+2，间距 14：星2左沿 = x+16，星5右沿 = x+72
        ctx.drawImage(brand, x + 14, y, 56, 56);
    } else {
        ctx.fillStyle = "#c98a52";
        ctx.fillRect(x, y, 30, 30);
    }
    // 星级：6 个星位，亮起 medal.step 个（同样用游戏原图）
    for (let i = 0; i < 6; i++) {
        const sx = x + 2 + i * 14, sy = y + 60;
        if (!starImage) continue;
        if (i < medal.step) {
            ctx.drawImage(starImage, sx, sy, 14, 14);
        } else {
            ctx.save();
            ctx.globalAlpha = 0.32;
            ctx.drawImage(starImage, sx, sy, 14, 14);
            ctx.restore();
        }
    }
}
export async function renderB25(record, extras, {createCanvas, loadImage}) {
    const entries = record.entries?.slice(0, 25);
    if (!entries?.length) throw new Error("没有可导出的成绩");
    const COLUMNS = 5;                 // 5 列：25 首正好排成 5×5（一屏一张，和游戏里那张卡一样）
    const PAD = 44, GAP = 18;
    // 卡高必须容得下：徽章行(38) + 封面(184) + 曲名(30) + 数值(28) + 脚注(20) + 下边距
    const CARD_W = 268, CARD_H = 348;
    const HEAD = 144, FOOT = 96;   // 160 x 0.9（head 整体再缩 0.9）
    const rows = Math.ceil(entries.length / COLUMNS);
    const width = PAD * 2 + CARD_W * COLUMNS + GAP * (COLUMNS - 1);
    const height = HEAD + rows * CARD_H + (rows - 1) * GAP + FOOT;

    const scale = 1.5;                 // 2 倍会到 9 MB，1.5 倍够清晰又便于分享
    const canvas = createCanvas(width * scale, height * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.textBaseline = "top";

    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, "#12121a");
    bg.addColorStop(1, "#1d1b2e");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    const stats = record.stats || {};
    const info = record.player || {};
    const [starImage, ...grades] = await Promise.all([
        loadImage("./ui-images/star.webp"),
        ...["bronze", "silver", "gold"].map(k => loadImage(`./ui-images/grade-${k}.webp`)),
    ]);
    const gradeImages = Object.fromEntries(["bronze", "silver", "gold"].map((k, i) => [k, grades[i]]));

    // ---- 头部：用户信息（左，放大）+ 牌子与最高分（紧挨着）+ Rating（最右），同一行 ----
    // head 整体再缩 0.9 倍：左上角钉在 PAD 不动，右边缘靠 HRIGHT 补偿回来，
    // 这样头部内容和卡片网格左右对齐，不会在一侧留出空档。
    const HS = 0.9;
    const HT = PAD * (1 - HS);
    const HUP = 5;                       // head 整体再上移 5px
    const HRIGHT = (width - PAD - HT) / HS;
    ctx.save();
    ctx.translate(HT, HT - HUP);
    ctx.scale(HS, HS);
    const avatarSize = 104;   // 116 x 0.9
    const avatarId2 = info.avatar_card_id || info.favorite_card_id;
    const avatar = avatarId2 ? await loadImage(`./avatar-images/avatar-${avatarId2}.webp`) : null;
    if (avatar) {
        ctx.save();
        roundRect(ctx, PAD, PAD, avatarSize, avatarSize, 16);
        ctx.clip();
        // 和网页一致：整张卡**等比缩放**填进方形框（不裁切、不变形），居中显示。
        // 之前用的 cover 会裁成正方形，所以只看到脸；网页上能看到肩膀，就是整张缩进去的。
        const _sw = (avatar.naturalWidth || avatar.width), _sh = (avatar.naturalHeight || avatar.height);
        const _k = Math.min(avatarSize / _sw, avatarSize / _sh);
        const _dw = _sw * _k, _dh = _sh * _k;
        ctx.drawImage(avatar, PAD + (avatarSize - _dw) / 2, PAD + (avatarSize - _dh) / 2, _dw, _dh);
        ctx.restore();
    } else {
        ctx.fillStyle = "rgba(255,255,255,.08)";
        roundRect(ctx, PAD, PAD, avatarSize, avatarSize, 16);
        ctx.fill();
    }

    const left = PAD + avatarSize + 16;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 29px 'OurNotesB25', sans-serif";
    const maxUserWidth = HRIGHT - left - 250 - 200 - 24;
    ctx.fillText(fitText(ctx, record.playerName || info.name || "（未命名）", maxUserWidth), left, PAD + 14);

    const rank = rankFor(info.exp ?? 0, extras);
    const subY = PAD + 56;    // 62 x 0.9
    let chipX = left;
    if (rank != null) {
        const chip = `RANK ${rank}`;
        ctx.font = "bold 15px 'OurNotesB25', sans-serif";
        const cw = ctx.measureText(chip).width + 26;
        ctx.fillStyle = "rgba(118,103,222,.28)";
        roundRect(ctx, chipX, subY - 2, cw, 24, 9);
        ctx.fill();
        ctx.fillStyle = "#bdb2ff";
        ctx.fillText(chip, chipX + 10, subY + 2);
        chipX += cw + 10;
    }
    if (record.accountId) {
        ctx.fillStyle = "#a5a3bf";
        ctx.font = "15px 'OurNotesB25', sans-serif";
        ctx.fillText(fitText(ctx, `ID ${record.accountId}`, maxUserWidth - (chipX - left)), chipX, subY + 4);
    }
    ctx.fillStyle = "#a5a3bf";
    ctx.font = "14px 'OurNotesB25', sans-serif";
    ctx.fillText(fitText(ctx, `共 ${stats.total_songs ?? stats.count} 首有记录`
        + `　FC ${stats.fc_count ?? "-"} / AP ${stats.ap_count ?? "-"}`, maxUserWidth), left, subY + 32);

    // ---- 右侧：Rating 在最右，牌子+最高分紧挨它的左边（不要留空档） ----
    const ratingText = `${stats.count || entries.length} 首等级平均`;
    ctx.textAlign = "right";
    ctx.fillStyle = "#a5a3bf";
    ctx.font = "15px 'OurNotesB25', sans-serif";
    ctx.fillText("Rating", HRIGHT, PAD + 4);
    ctx.fillStyle = "#ffd66b";
    ctx.font = "bold 56px 'OurNotesB25', sans-serif";
    ctx.fillText(num(stats.rating_avg), HRIGHT, PAD + 32);
    ctx.fillStyle = "#8f8da8";
    ctx.font = "14px 'OurNotesB25', sans-serif";
    ctx.fillText(ratingText, HRIGHT, PAD + 92);
    const ratingLeft = HRIGHT - Math.max(ctx.measureText(ratingText).width, 120);
    ctx.textAlign = "left";

    const total = stats.total_rating ?? 0;
    const medal = medalFor(total, extras);
    // 牌子的位置要和网页一致：紧贴用户信息块的右侧（不是按 Rating 反推）。
    // 网页上是 flex 的 20px 间距，这里按用户文字的实际宽度量出来。
    // 框高必须包住：硬币(34) + 间距 + 星星(12)，从 hsrY+8 起算到 hsrY+68，再留 12 下边距
    const hsrW = 250, hsrH = 90;
    ctx.font = "bold 29px 'OurNotesB25', sans-serif";
    const _wName = ctx.measureText(record.playerName || info.name || "（未命名）").width;
    ctx.font = "14px 'OurNotesB25', sans-serif";   // 和实际绘制字号一致，否则量出来偏大
    const _wCounts = ctx.measureText(`共 ${stats.total_songs ?? stats.count} 首有记录`
        + `　FC ${stats.fc_count ?? "-"} / AP ${stats.ap_count ?? "-"}`).width;
    // 最宽的一行其实是「RANK 芯片 + ID」，必须一起量，否则盒子会压到 ID
    ctx.font = "bold 15px 'OurNotesB25', sans-serif";
    const _chipW = (rank != null) ? ctx.measureText(`RANK ${rank}`).width + 26 + 10 : 0;
    ctx.font = "15px 'OurNotesB25', sans-serif";
    const _idW = record.accountId ? ctx.measureText(`ID ${record.accountId}`).width : 0;
    const userW = Math.min(Math.max(_wName, _chipW + _idW, _wCounts, 130), ratingLeft - left - hsrW - 24);
    const hsrX = left + userW + 8;   // 紧贴个人信息，只留几像素
    const hsrY = PAD + 6;   // 原 PAD + 16，整体上移 10px
    ctx.fillStyle = "rgba(118,103,222,.14)";
    roundRect(ctx, hsrX, hsrY, hsrW, hsrH, 12);
    ctx.fill();
    if (medal) drawMedal(ctx, medal, hsrX + 16, hsrY + 7, starImage, gradeImages);
    ctx.fillStyle = "#c8c4e6";
    ctx.font = "11px 'OurNotesB25', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("HIGH SCORE RATING", hsrX + hsrW - 16, hsrY + 22.5);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 25px 'OurNotesB25', sans-serif";
    ctx.fillText(int(total), hsrX + hsrW - 16, hsrY + 46);
    ctx.textAlign = "left";
    ctx.restore();   // 结束 head 的 0.9 倍缩放

    // ---- 卡片 ----
    const images = await Promise.all(entries.map(e => loadImage(jacketUrl(e))));
    const DIFF_FILL = {
        expert: ["rgba(255,107,107,.20)", "#ff6b6b"],
        hard: ["rgba(255,214,107,.20)", "#ffd66b"],
        normal: ["rgba(126,224,168,.20)", "#7ee0a8"],
        easy: ["rgba(127,198,255,.20)", "#7fc6ff"],
    };

    entries.forEach((entry, index) => {
        const col = index % COLUMNS;
        const row = Math.floor(index / COLUMNS);
        const x = PAD + col * (CARD_W + GAP);
        const y = HEAD + row * (CARD_H + GAP);

        ctx.fillStyle = "rgba(255,255,255,.06)";
        roundRect(ctx, x, y, CARD_W, CARD_H, 14);
        ctx.fill();

        // 顶行：序号 + 难度徽章 + FC/AP 徽章
        ctx.fillStyle = "rgba(255,255,255,.55)";
        ctx.font = "bold 13px 'OurNotesB25', sans-serif";
        ctx.fillText(String(index + 1), x + 12, y + 13);

        /** 画一个徽章；rightAlign 时贴卡片右边。size 同时决定字号和内边距。 */
        const drawBadge = (text, fill, color, size, rightAlign) => {
            ctx.font = `bold ${size}px 'OurNotesB25', sans-serif`;
            const w = ctx.measureText(text).width + size * 1.4;
            const h = size * 1.9;
            const bx = rightAlign ? x + CARD_W - 12 - w : x + 12;
            ctx.fillStyle = fill;
            roundRect(ctx, bx, y + 10, w, h, size * 0.75);
            ctx.fill();
            ctx.fillStyle = color;
            ctx.fillText(text, bx + size * 0.7, y + 10 + size * 0.42);
        };
        // 难度徽章靠右（规格：难度靠右）
        const diff = DIFF_FILL[entry.difficulty] || ["rgba(255,255,255,.14)", "#cfcee0"];
        drawBadge(DIFF_LABEL[entry.difficulty] || entry.difficulty, diff[0], diff[1], 11, true);
        // 封面
        const art = CARD_W - 24;
        const image = images[index];
        if (image) {
            ctx.save();
            roundRect(ctx, x + 12, y + 38, art, art, 10);
            ctx.clip();
            ctx.drawImage(image, x + 12, y + 38, art, art);
            ctx.restore();
        } else {
            ctx.fillStyle = "rgba(255,255,255,.10)";
            roundRect(ctx, x + 12, y + 38, art, art, 10);
            ctx.fill();
        }

        // 曲名
        // 曲名行：曲名在左，FC/AP 徽章贴右边、放大 1.5 倍、上端与曲名齐平
        // 曲名一行（放不下就省略）；FC/AP 徽章能并排就并排，
        // 放不下先缩小，再放不下就挪到曲名下面单独一行。
        // 曲名：一行，字号从 15 自动缩到 10，尽量把全名显示出来
        // 曲名：一行，字号从 15 自动缩到 10，尽量显示全名
        const titleY = y + 38 + art + 8;
        let titleSize = 15;
        ctx.font = `bold ${titleSize}px 'OurNotesB25', sans-serif`;
        while (titleSize > 10 && ctx.measureText(String(entry.name)).width > art) {
            titleSize -= 1;
            ctx.font = `bold ${titleSize}px 'OurNotesB25', sans-serif`;
        }
        ctx.fillStyle = "#ffffff";
        ctx.fillText(fitText(ctx, String(entry.name), art), x + 12, titleY);

        // 数值行：左边「原值 -> 计入值」，右边 FC/AP 徽章（12px）
        const vy = titleY + titleSize + 14;
        ctx.font = "bold 20px 'OurNotesB25', sans-serif";
        ctx.fillStyle = entry.ap ? "#7ee0a8" : entry.fc ? "#7fc6ff" : "#e7e6f2";
        const first = lvl(entry.value);
        ctx.fillText(first, x + 12, vy);
        let vx = x + 12 + ctx.measureText(first).width + 7;
        ctx.fillStyle = "#8f8da8";
        ctx.font = "15px 'OurNotesB25', sans-serif";
        ctx.fillText("\u2192", vx, vy + 4);
        vx += ctx.measureText("\u2192").width + 7;
        ctx.fillStyle = "#cfcee0";
        ctx.font = "bold 20px 'OurNotesB25', sans-serif";
        ctx.fillText(lvl(entry.counted), vx, vy);

        const fcText = entry.ap ? "ALL PERFECT" : entry.fc ? "FULL COMBO" : "";
        if (fcText) {
            const fcSize = 12;
            ctx.font = `bold ${fcSize}px 'OurNotesB25', sans-serif`;
            const bw = ctx.measureText(fcText).width + fcSize * 1.4;
            const bx = x + CARD_W - 12 - bw;
            const by = vy + 1;
            ctx.fillStyle = entry.ap ? "rgba(255,138,190,.20)" : "rgba(127,198,255,.18)";
            roundRect(ctx, bx, by, bw, fcSize * 1.9, fcSize * 0.75);
            ctx.fill();
            ctx.fillStyle = entry.ap ? "#ff8abe" : "#7fc6ff";
            ctx.fillText(fcText, bx + fcSize * 0.7, by + fcSize * 0.42);
        }

    });

    // ---- 页脚 ----
    ctx.fillStyle = "#7c7a95";
    ctx.font = "13px 'OurNotesB25', sans-serif";
    const footY = height - FOOT + 22;
    ctx.fillText("AP 记谱面等级原值；FC 记「原值 − " + (record.fcPenalty ?? 1) + "」。"
        + "只统计 FC / AP，「完成」不计入。"
        + "Rating = 卡片这 " + entries.length + " 首计入值的平均，排名不看分数。", PAD, footY);
    ctx.fillText("选取已取得 FC / AP 的成绩中计入值最高的 25 首；"
        + "同值时原值高的在前，再同按乐曲 ID 排。", PAD, footY + 22);
    ctx.fillStyle = "#6a6880";
    ctx.fillText("评级徽章：银牌 105500 / 金牌 211000。"
        + "FC / AP 状态由导入记录识别，仅供参考。　Our Notes 配队助手",
        PAD, footY + 44);

    return canvas;
}
