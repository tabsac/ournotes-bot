#!/usr/bin/env node
// 统一告警出口：同一条消息**同时**走 QQ（OneBot WS）与邮件（SMTP 465）。
//
// 用法:  node /home/admin/bot/tools/on_alert.js "主题" "正文"
// 配置:  /home/admin/bot/data/alert/config.json   （0600，root）
//        {
//          "qq":   {"private": [<QQ 号>], "group": <群号>, "at": <要 @ 的 QQ>},
//          "smtp": {"host": "smtp.163.com", "port": 465, "from": "…", "authCode": "…", "to": "…"}
//        }
//
// 为什么要有这个脚本：护栏（web_release_guard.sh）以前失败时**只往 /var/log/ournotes-guard.log 写一行**，
// 没人主动看日志就等于没有告警。用户拍板要「失败发 QQ + 同时发邮件」，这里就是那唯一出口 ——
// 两个通道各自独立，一个挂了不影响另一个；**两个都失败才返回非 0**。
//
// QQ 走的是 NapCat 的 OneBot WS 服务端 ws://127.0.0.1:6098/ws（monitor.js 用的同一条路）。
// 邮件那段是零依赖的 implicit-TLS SMTP（只在 node:tls 上），与 dsh-notify-skill 的 sender.mjs 同思路。
'use strict';
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const WebSocket = require('/home/admin/bot/node_modules/ws');

const CONFIG_PATH = '/home/admin/bot/data/alert/config.json';
const QQ_WS = process.env.ON_ALERT_QQ_WS || 'ws://127.0.0.1:6098/ws';

const subject = process.argv[2] || 'Our Notes 告警';
const text = process.argv[3] || '(无正文)';

function log(line) { console.log('[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + line); }

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    log('读不到配置 ' + CONFIG_PATH + '：' + error.message);
    return null;
  }
}

// ---------------------------------------------------------------- QQ
function onebotAction(action, params, timeoutMs) {
  return new Promise((resolve) => {
    let socket;
    try { socket = new WebSocket(QQ_WS); } catch (error) { resolve({ ok: false, why: 'WS 建不起来: ' + error.message }); return; }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch (error) { /* 关不掉就算了 */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, why: '超时（' + timeoutMs + 'ms 没有回执）' }), timeoutMs);
    socket.on('open', () => {
      socket.send(JSON.stringify({ action: action, params: params, echo: 'on-alert' }));
    });
    socket.on('message', (data) => {
      let payload;
      try { payload = JSON.parse(data.toString()); } catch (error) { return; }
      if (payload.echo !== 'on-alert') return;
      const ok = payload.status === 'ok' && payload.retcode === 0;
      finish({ ok: ok, why: ok ? 'ok' : JSON.stringify(payload).slice(0, 200) });
    });
    socket.on('error', (error) => finish({ ok: false, why: 'WS 错误: ' + error.message }));
  });
}

async function sendQQ(config) {
  const qq = (config && config.qq) || {};
  const message = subject + '\n' + text;
  const tried = [];
  for (const target of (qq.private || [])) {
    const result = await onebotAction('send_private_msg', { user_id: target, message: message }, 8000);
    tried.push('私聊 ' + target + ' → ' + result.why);
    if (result.ok) return { ok: true, detail: '私聊 ' + target + ' 已发送' };
  }
  if (qq.group) {
    const mention = qq.at ? '[CQ:at,qq=' + qq.at + '] ' : '';
    const result = await onebotAction('send_group_msg', { group_id: qq.group, message: mention + message }, 8000);
    tried.push('群 ' + qq.group + ' → ' + result.why);
    if (result.ok) return { ok: true, detail: '群 ' + qq.group + ' 已发送' };
  }
  return { ok: false, detail: tried.join('；') || '没配任何 QQ 目标' };
}

// ---------------------------------------------------------------- 邮件
function smtpSend(smtp, mailSubject, body) {
  return new Promise((resolve) => {
    if (!smtp || !smtp.from || !smtp.authCode || !smtp.to) {
      resolve({ ok: false, detail: '没配 smtp（from/authCode/to）' });
      return;
    }
    const host = smtp.host || (String(smtp.from).endsWith('@qq.com') ? 'smtp.qq.com' : 'smtp.163.com');
    const port = smtp.port || 465;
    const socket = tls.connect({ host: host, port: port, servername: host });
    let buffer = '';
    let step = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch (error) { /* 已经断了 */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: 'SMTP 超时' }), 25000);

    // 把非 ASCII 主题按 RFC 2047 编码，中文才不会变乱码
    const encodedSubject = /[^\x20-\x7e]/.test(mailSubject)
      ? '=?UTF-8?B?' + Buffer.from(mailSubject, 'utf8').toString('base64') + '?='
      : mailSubject;
    const message =
      'Subject: ' + encodedSubject + '\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'Content-Transfer-Encoding: 8bit\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');

    socket.on('error', (error) => finish({ ok: false, detail: 'SMTP 错误: ' + error.message }));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const match = /^(\d{3})([ -])/.exec(line);
        if (!match || match[2] === '-') continue;   // 继续行不算完成
        const code = Number(match[1]);
        try {
          if (step === 0) {                        // 220 banner
            if (code !== 220) return finish({ ok: false, detail: 'SMTP 问候异常: ' + line });
            step = 1; socket.write('EHLO ' + host + '\r\n'); continue;
          }
          if (step === 1) {                        // 250 EHLO 回应
            if (code !== 250) return finish({ ok: false, detail: 'SMTP EHLO 异常: ' + line });
            step = 2; socket.write('AUTH LOGIN\r\n'); continue;
          }
          if (step === 2) {                        // 334 要用户名
            if (code !== 334) return finish({ ok: false, detail: 'SMTP AUTH 异常: ' + line });
            step = 3; socket.write(Buffer.from(smtp.from, 'utf8').toString('base64') + '\r\n'); continue;
          }
          if (step === 3) {                        // 334 要授权码
            if (code !== 334) return finish({ ok: false, detail: 'SMTP 用户被拒: ' + line });
            step = 4; socket.write(Buffer.from(smtp.authCode, 'utf8').toString('base64') + '\r\n'); continue;
          }
          if (step === 4) {                        // 235 认证成功
            if (code !== 235) return finish({ ok: false, detail: 'SMTP 认证失败（授权码？）: ' + line });
            step = 5; socket.write('MAIL FROM:<' + smtp.from + '>\r\n'); continue;
          }
          if (step === 5) {
            if (code !== 250) return finish({ ok: false, detail: 'MAIL FROM 被拒: ' + line });
            step = 6; socket.write('RCPT TO:<' + smtp.to + '>\r\n'); continue;
          }
          if (step === 6) {
            if (code !== 250) return finish({ ok: false, detail: 'RCPT TO 被拒: ' + line });
            step = 7; socket.write('DATA\r\n'); continue;
          }
          if (step === 7) {
            if (code !== 354) return finish({ ok: false, detail: 'DATA 被拒: ' + line });
            step = 8; socket.write(message + '\r\n.\r\n'); continue;
          }
          if (step === 8) {
            if (code !== 250) return finish({ ok: false, detail: '邮件未被接受: ' + line });
            socket.write('QUIT\r\n');
            finish({ ok: true, detail: '已投递到 ' + smtp.to });
            return;
          }
        } catch (error) {
          finish({ ok: false, detail: 'SMTP 处理异常: ' + error.message });
          return;
        }
      }
    });
  });
}

// ---------------------------------------------------------------- main
(async () => {
  const config = loadConfig() || {};
  const results = [];
  const qqResult = await sendQQ(config);
  log((qqResult.ok ? 'OK   ' : 'FAIL ') + 'QQ: ' + qqResult.detail);
  results.push(qqResult);
  const mailResult = await smtpSend(config.smtp, subject, text);
  log((mailResult.ok ? 'OK   ' : 'FAIL ') + '邮件: ' + mailResult.detail);
  results.push(mailResult);
  process.exit(results.some((item) => item.ok) ? 0 : 1);
})();
