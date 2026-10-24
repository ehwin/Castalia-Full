"""把 Lite（Castalia）的核心引擎源码同步到 Castalia-Full。

架构约定：**Castalia（Lite）= 引擎核心源；Castalia-Full = 核心 + 联邦/跨库总线**。
所以核心文件以 Lite 为准，Full 只额外维护：
  - src/index.ts        （Lite 入口 + reflect_all / memory_search_all 两个 bus 工具）
  - src/fedServer.ts / src/reflectAll.ts / src/federation/（总线模块）
  - version.ts 由各自 VERSION 生成

用法：
    py Castalia-Full/scripts/sync_core.py            # 只检查
    py Castalia-Full/scripts/sync_core.py --apply    # 从 Lite 同步到 Full
"""
import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LITE = ROOT / "Castalia"
FULL = ROOT / "Castalia-Full"

# Full 自己维护的文件（不参与核心同步）
FULL_OWNED = {
    "src/index.ts",
    "src/version.ts",
    "src/fedServer.ts",
    "src/reflectAll.ts",
}
FULL_OWNED_DIRS = {"src/federation"}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def core_files():
    out = []
    for src in sorted((LITE / "src").rglob("*.ts")):
        rel = src.relative_to(LITE).as_posix()
        if rel in FULL_OWNED or any(rel.startswith(d + "/") for d in FULL_OWNED_DIRS):
            continue
        out.append((src, FULL / rel))
    return out


def diffs(pairs):
    return [(s, d) for s, d in pairs if not d.exists() or sha(s) != sha(d)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    pairs = core_files()
    changed = diffs(pairs)
    print(json.dumps({"from": "Castalia", "to": "Castalia-Full", "coreFiles": len(pairs), "changed": len(changed)},
                     ensure_ascii=False))
    for s, d in changed[:20]:
        print(f"  DIFF {s.relative_to(LITE)} -> {d.relative_to(ROOT)}")
    if args.apply:
        for src, dst in pairs:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        print(f"synced {len(pairs)} core files")
        return 0
    return 1 if changed else 0


if __name__ == "__main__":
    sys.exit(main())
