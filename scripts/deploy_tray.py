#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把托盘运行时**源**（Castalia-Full/scripts/tray/）部署到运行时目录。

为什么需要它
------------
托盘/守护/外壳/会话钩子这套代码此前只存在于运行时目录：run/Castalia/scripts 是"主目录"，
run/LobeHub/scripts 与 D:/system/AIRI/scripts 是镜像（由 sync_to_instances.py 同步）。
问题在于**主目录本身不在版本控制里**：一次重新部署就全丢，而且没人看得出镜像漂移了多久
（2026-10-28 实测：主目录已领先一代，两个镜像共 10 个文件待更新）。

本脚本把链条补成单向的：

    Castalia-Full/scripts/tray/   ← 版本控制里的唯一源（本脚本的输入）
        │  deploy_tray.py（本脚本：源 → 主目录）
        ▼
    run/Castalia/scripts/         ← 主目录（运行时/计划任务读取的地方）
        │  sync_to_instances.py（已有机制，本脚本直接调用，不重造）
        ▼
    run/LobeHub/scripts/  +  D:/system/AIRI/scripts/    ← 各实例镜像

分工是刻意的：**实例清单只写在 sync_to_instances.py 里**，本脚本不再维护第二份目标列表，
否则又变成"两个轮子"。本脚本只管"源 → 主目录"，剩下那段交给它。

用法
    py Castalia-Full/scripts/deploy_tray.py            # 只检查漂移（有漂移退出 1）
    py Castalia-Full/scripts/deploy_tray.py --apply    # 备份 → 覆盖 → py_compile → 分发 → 复核
"""
import argparse
import hashlib
import json
import os
import py_compile
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "Castalia-Full" / "scripts" / "tray"
PRIMARY = ROOT / "run" / "Castalia" / "scripts"
FANOUT = PRIMARY / "sync_to_instances.py"

# 与 sync_to_instances.py 的 ITEMS 取交集：只搬"代码/脚本"，本机运行时数据不搬。
FILES = [
    "castalia_tray.py",
    "castalia_config.py",
    "castalia_guard.py",
    "castalia_settings.py",
    "castalia_shell.py",
    "service_runtime.py",
    "hermes_memory_hook.py",
    "sync_to_instances.py",
    "build_tray.cmd",
    "run_guard.cmd",
]
# 只做示例/文档，不进运行时目录
DOC_ONLY = ["castalia.config.example.json", "README.md"]
# 有意不进版本控制的二进制资产（约 5MB 图标 + 外壳 HTML）：留在主目录，只提示缺失
BINARY_ASSETS = ["tray-icons", "shell"]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_copy(src: Path, dst: Path):
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".deploy-tmp")
    shutil.copy2(src, tmp)
    os.replace(tmp, dst)


def primary_plan():
    """源 → 主目录的差异；源里缺什么；主目录少哪些二进制资产。"""
    drifted, missing = [], []
    for name in FILES:
        src = SOURCE / name
        if not src.is_file():
            missing.append(name)
            continue
        dst = PRIMARY / name
        if not dst.is_file() or sha(src) != sha(dst):
            drifted.append(name)
    absent_assets = [a for a in BINARY_ASSETS if not (PRIMARY / a).exists()]
    return drifted, missing, absent_assets


def run_fanout(check: bool):
    cmd = [sys.executable, str(FANOUT)] + (["--check"] if check else [])
    r = subprocess.run(cmd, cwd=str(PRIMARY), capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--no-fanout", action="store_true", help="只同步主目录，不碰实例镜像")
    args = ap.parse_args()

    drifted, missing, absent_assets = primary_plan()
    summary = {
        "source": str(SOURCE.relative_to(ROOT)),
        "primary": str(PRIMARY.relative_to(ROOT)),
        "files": len(FILES),
        "primaryDrifted": drifted,
        "missingInSource": missing,
        "absentBinaryAssets": absent_assets,
        "compiled": 0,
        "fanoutExit": None,
        "ok": False,
    }

    if missing:
        print(f"deploy_tray: 源缺文件 {missing}", file=sys.stderr)
        print(json.dumps(summary, ensure_ascii=False))
        return 2
    if not PRIMARY.is_dir():
        print(f"deploy_tray: 主目录不存在 {PRIMARY}", file=sys.stderr)
        print(json.dumps(summary, ensure_ascii=False))
        return 2

    if not args.json:
        print(f"源: {summary['source']}（{len(FILES)} 个文件）")
        print(f"主目录: {summary['primary']}")
        print("源→主目录漂移: " + (", ".join(drifted) if drifted else "无"))
        for a in absent_assets:
            print(f"  NOTE 主目录缺二进制资产: {a}（有意不入库，需手工恢复）")

    if args.apply and drifted:
        stamp = time.strftime("tray-deploy-%Y%m%d-%H%M%S")
        backup = ROOT / "_归档" / stamp
        for name in drifted:
            dst = PRIMARY / name
            if dst.is_file():
                bdst = backup / dst.relative_to(ROOT)
                bdst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(dst, bdst)
        print(f"已备份 {len(drifted)} 个旧文件 → {backup.relative_to(ROOT)}")
        for name in drifted:
            atomic_copy(SOURCE / name, PRIMARY / name)
        print(f"已部署到主目录: {', '.join(drifted)}")

    if args.apply:
        bad = []
        for name in FILES:
            if not name.endswith(".py"):
                continue
            p = PRIMARY / name
            try:
                py_compile.compile(str(p), doraise=True, cfile=str(p) + ".pyc-check")
                summary["compiled"] += 1
            except Exception as e:
                bad.append(f"{name}: {e}")
            finally:
                pyc = Path(str(p) + ".pyc-check")
                if pyc.exists():
                    pyc.unlink()
        if bad:
            summary["compileErrors"] = bad
            print("py_compile 失败: " + "; ".join(bad), file=sys.stderr)
            print(json.dumps(summary, ensure_ascii=False))
            return 1

    if not args.no_fanout:
        rc, out = run_fanout(check=not args.apply)
        summary["fanoutExit"] = rc
        if args.json:
            summary["fanoutOutput"] = out.strip()
        else:
            print("--- sync_to_instances.py " + ("--check" if not args.apply else "（分发）"))
            print(out.rstrip())

    drift2, _, _ = primary_plan()
    summary["primaryDrifted"] = drift2
    fanout_ok = summary["fanoutExit"] in (0, None)
    if args.apply:
        fanout_ok = summary["fanoutExit"] == 0
    summary["ok"] = (not drift2) and fanout_ok and not missing

    if args.json:
        print(json.dumps(summary, ensure_ascii=False))
    else:
        print(f"复核: 源→主目录漂移 {len(drift2)}；分发退出码 {summary['fanoutExit']}；ok={summary['ok']}")
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
