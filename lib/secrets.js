'use strict';
// 密钥/凭据读取顺序：环境变量 → 仓库根目录的 secrets.json（不入库）→ 报错。
// 这些是逆向出来的游戏解密密钥，**请不要提交进仓库**。
// 复制 secrets.example.json 为 secrets.json 并填好，或改用环境变量。
const fs = require('fs');
const path = require('path');

let FILE = {};
try {
  FILE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'secrets.json'), 'utf8'));
} catch (e) { /* 没配也能起，用到时再报错 */ }

/** bundleKey -> ON_BUNDLE_KEY（自动推导，省得每处都写环境变量名） */
function envNameOf(key) {
  return 'ON_' + String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
}

/** 取一个值：显式环境变量名 → 推导出的 ON_XXX → secrets.json；都没有返回 null */
function get(key, envName) {
  for (const n of [envName, envNameOf(key), key]) {
    if (!n) continue;
    const v = process.env[n];
    if (v != null && v !== '') return v;
  }
  const f = FILE[key];
  return f == null ? null : String(f);
}

/** 取一个值；没有就抛错（附上怎么配的提示） */
function need(key, envName, hint) {
  const v = get(key, envName);
  if (v == null || v === '') {
    throw new Error('缺少 ' + key + '：请设置环境变量 ' + (envName || key) +
      ' 或写入 secrets.json' + (hint ? '（' + hint + '）' : ''));
  }
  return v;
}

module.exports = { get, need };
