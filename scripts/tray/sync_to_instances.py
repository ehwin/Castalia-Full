# -*- coding: utf-8 -*-
"""把**运行时组件**从主脚本目录同步到各实例(LobeHub / AIRI)。

设计:主目录 D:/castalia/run/Castalia/scripts 是唯一"源",
      各实例目录是镜像 —— 改完主目录跑一次本脚本即可,避免多份手工维护。

用法:
    python sync_to_instances.py            # 执行同步
    python sync_to_instances.py --check    # 只比对差异,不写
"""
import argparse
import os
import shutil
import sys
import hashlib
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

# 只同步"组件",不同步日志/缓存/构建产物
ITEMS = [
    "castalia_shell.py", "shell", "castalia_tray.py", "castalia_guard.py",
    "castalia_settings.py", "castalia_config.py", "keys_util.py",
    "tray_launcher.py", "patch_mcp_proxy.py", "build_tray.cmd", "tray-icons",
    "run_guard.cmd", "README.md",
    'hermes_memory_hook.py',
    'service_runtime.py', 'sync_to_instances.py',
]

TARGETS = [
    (r"D:/castalia/run/LobeHub/scripts", "LobeHub"),
    (r"D:/system/AIRI/scripts", "AIRI"),
]


def _newer(src, dst):
    if not os.path.exists(dst): return True
    def digest(path):
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 16), b''): h.update(chunk)
        return h.digest()
    return digest(src) != digest(dst)


def sync(check=False):
    changed, total = 0, 0
    missing = [item for item in ITEMS if not os.path.exists(os.path.join(HERE, item))]
    if missing:
        print('源组件缺失，取消同步: ' + ', '.join(missing))
        return 2
    for dst_root, name in TARGETS:
        if not os.path.isdir(dst_root):
            print(f"[跳过] {name}: 目录不存在 {dst_root}")
            continue
        print(f"\n[{name}] {dst_root}")
        for item in ITEMS:
            src = os.path.join(HERE, item)
            if not os.path.exists(src):
                print(f"   ? 源缺失 {item}")
                continue
            total += 1
            dst = os.path.join(dst_root, item)
            if os.path.isdir(src):
                # 目录:逐文件比对,只覆盖较旧的
                for root, _dirs, files in os.walk(src):
                    _dirs[:] = [d for d in _dirs if d != '__pycache__']
                    for f in files:
                        if f.endswith(('.pyc', '.pyo')): continue
                        s = os.path.join(root, f)
                        rel = os.path.relpath(s, src)
                        d = os.path.join(dst, rel)
                        if _newer(s, d):
                            if not check:
                                _copy_atomic(s, d)
                            print(f"   {'~' if check else '>'} {item}/{rel}")
                            changed += 1
            else:
                if _newer(src, dst):
                    if not check:
                        _copy_atomic(src, dst)
                    print(f"   {'~' if check else '>'} {item}")
                    changed += 1
    verb = "待更新" if check else "已更新"
    print(f"\n{verb} {changed} 个文件(共检查 {total} 个组件)")
    return 1 if check and changed else 0

def _copy_atomic(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dst), prefix='.sync-')
    os.close(fd)
    try:
        shutil.copy2(src, tmp)
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只比对,不写入")
    sys.exit(sync(ap.parse_args().check))
