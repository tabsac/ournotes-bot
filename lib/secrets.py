# -*- coding: utf-8 -*-
"""密钥读取：环境变量 → 仓库根目录 secrets.json（不入库）→ 报错。

这些是逆向出来的游戏解密密钥，请不要提交进仓库。
"""
import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_FILE = {}
try:
    with open(os.path.join(_HERE, '..', 'secrets.json'), encoding='utf-8') as f:
        _FILE = json.load(f)
except Exception:
    pass


def env_name_of(key):
    """bundleKey -> ON_BUNDLE_KEY"""
    out = []
    for i, ch in enumerate(str(key)):
        if ch.isupper() and i and (str(key)[i - 1].islower() or str(key)[i - 1].isdigit()):
            out.append('_')
        out.append(ch if ch.isalnum() else '_')
    return 'ON_' + ''.join(out).upper()


def get(key, env=None):
    for n in (env, env_name_of(key), key):
        if not n:
            continue
        v = os.environ.get(n)
        if v:
            return v
    v = _FILE.get(key)
    return None if v is None else str(v)


def need(key, env=None, hint=''):
    v = get(key, env)
    if not v:
        raise SystemExit('缺少 %s：请设置环境变量 %s 或写入 secrets.json%s'
                         % (key, env or key, ('（%s）' % hint) if hint else ''))
    return v
