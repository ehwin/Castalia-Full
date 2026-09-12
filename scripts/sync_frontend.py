#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync_frontend.py — 前端单一源同步工具
═══════════════════════════════════════════════════════════════════════════
背景:星图/管理页前端曾经有 5 份拷贝(Lite web + Full web + 三个活体 viz),
     靠手工 cp 同步,Grok/DeepSeek 两轮改动后已经漂移(lobehub-run 差一代)。
规则:从 v1.16.0 起,**Castalia-Full web/ 是前端唯一源(Single Source of Truth)**。
     改前端只改 Full/web,然后跑本脚本,把 public/ + routes/ + server.mjs
     同步到三端活体目录。md5 对齐即通过。

用法:
    python scripts/sync_frontend.py            # 同步 + 校验
    python scripts/sync_frontend.py --check    # 只校验不写(适合验收)

各端差异说明(为什么是"覆盖 + 白名单增删"而不是全删重建):
    - server.mjs 各端不同(AIRI 版有 admin 代理转发,Full 版没有)→ 不同步,各自维护
    - lib.js 含 paths 解析逻辑(读 FEDERATION_DIRS 环境变量),各端内容一致 → 同步
    - index.html/routes/*.html/js 全量同步
    - vendor/ 只做"引用完整性"校验,不搬运文件(体积大,各端自备)
"""
import hashlib
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_ROOT = os.path.normpath(os.path.join(HERE, '..', 'web'))

# 三端活体目录(viz 根)。保持与 castalia_tray.py 的 viz 定义一致。
TARGETS = {
    'run/Castalia (Hermes :3345)':    os.path.normpath(os.path.join(HERE, '..', '..', 'run', 'Castalia', 'viz')),
    'lobehub-run (LobeHub :3346)':    os.path.normpath(HERE.rsplit(os.sep, 3)[0] and os.path.join('D:', os.sep, 'AI', 'lobehub-run', 'viz')),
    'AIRI viz (:3344)':              os.path.normpath(os.path.join('D:', os.sep, 'system', 'AIRI', 'viz')),
}

# 同步范围内的相对路径。改前端新增文件时,在此登记。
SYNC_ITEMS = [
    'public/index.html',
    'public/aggregate.html',
    'public/manage.html',
    'public/castalia.png',
    'public/castalia-mark.png',
    'public/favicon.png',
    'routes/graph.js',
    'routes/lib.js',
    'routes/config.js',
    'routes/aggregate.js',
    'routes/memory.js',
    'routes/reflect.js',
]

# 这些后缀的文件出现在目标目录但不在同步清单里 → 视为滞留旧版,删除
# (注意:_ 前缀诊断文件、备份、.gitkeep 不算滞留)
STALE_SUFFIXES = ('.html', '.js')


def md5(path: str) -> str:
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


def vendor_refs_ok(public_dir: str) -> tuple[bool, set]:
    """index.html 里引用的 vendor 文件必须实际存在(G1 崩溃事故的回归检查)。"""
    idx = open(os.path.join(public_dir, 'index.html'), encoding='utf-8', errors='replace').read()
    refs = set(re.findall(r'vendor/([\w.-]+\.(?:mjs|js))', idx))
    ok = True
    for r in refs:
        if not os.path.exists(os.path.join(public_dir, 'vendor', r)):
            print(f'    ✗ vendor 引用缺失: vendor/{r} 不存在(index.html 会 404 → module 崩溃)')
            ok = False
    return ok, refs


def sync(dry: bool) -> int:
    fail = 0
    print(f'单一源: {SRC_ROOT}')
    print('-' * 70)
    for label, tgt in TARGETS.items():
        print(f'▸ {label}')
        print(f'  目标: {tgt}')
        if not os.path.isdir(tgt):
            print('    ✗ 目标目录不存在,跳过')
            fail += 1
            continue
        tgt_public = os.path.join(tgt, 'public')
        tgt_routes = os.path.join(tgt, 'routes')
        os.makedirs(tgt_public, exist_ok=True)
        os.makedirs(tgt_routes, exist_ok=True)

        # 1) 同步清单内文件
        for rel in SYNC_ITEMS:
            src = os.path.join(SRC_ROOT, rel)
            dst = os.path.join(tgt, rel)
            if not os.path.exists(src):
                print(f'    ✗ 源缺失: {rel}')
                fail += 1
                continue
            if os.path.exists(dst) and md5(dst) == md5(src):
                continue  # 已一致
            if dry:
                print(f'    (check) 不一致: {rel}')
                fail += 1
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(src, dst)
            print(f'    已同步: {rel}')

        # 2) 清滞留:目标里属于前端范围但不该在的文件
        allowed = set(SYNC_ITEMS)
        for sub in ('public', 'routes'):
            d = os.path.join(tgt, sub)
            if not os.path.isdir(d):
                continue
            for f in os.listdir(d):
                if f.startswith(('_', '.')) or f == '.gitkeep' or f == 'vendor':
                    continue
                rel = f'{sub}/{f}'
                if rel in allowed:
                    continue
                if f.endswith(STALE_SUFFIXES):
                    p = os.path.join(d, f)
                    if dry:
                        print(f'    (check) 滞留: {rel}')
                        fail += 1
                    else:
                        os.remove(p)
                        print(f'    已删除滞留: {rel}')

        # 3) md5 终验
        for rel in SYNC_ITEMS:
            src = os.path.join(SRC_ROOT, rel)
            dst = os.path.join(tgt, rel)
            if os.path.exists(src) and os.path.exists(dst) and md5(src) != md5(dst):
                print(f'    ✗ md5 不齐: {rel}')
                fail += 1

        # 4) vendor 引用完整性
        ok, _ = vendor_refs_ok(tgt_public)
        if not ok:
            fail += 1
    print('-' * 70)
    if fail:
        print(f'结果: {fail} 项失败' + ('(dry-run)' if dry else ''))
        return 1
    print('结果: 三端全部与 Full web 单一源一致 ✓')
    return 0


if __name__ == '__main__':
    sys.exit(sync(dry='--check' in sys.argv))
