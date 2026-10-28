"""把 Lite（Castalia）的核心引擎源码同步到 Castalia-Full。

架构约定（v1.25 起）
-------------------
  Castalia（Lite）  = 引擎核心源；普通记忆桥跑它
  Castalia-Full     = **总线接口层**：总线（fedServer: memory_search_all /
                      federation_members）+ 总反思（reflectAll: reflect_all）+ 聚合星图
  Castalia-Anima    = 情感变体（AIRI），自己维护一条引擎线

Full 不再拥有独立的引擎分支：核心文件一律以 Lite 为准，Full 只额外维护
  - src/index.ts        （总线入口：Lite 中间件 + reflect_all / memory_search_all）
  - src/fedServer.ts / src/reflectAll.ts / src/federation/（总线模块，独立进程）
  - src/version.ts      （由各自 VERSION 生成）

所以这个脚本是「Full 还算不算总线接口」的**守门人**：核心漂移 = 总线背后跑的是
另一个引擎；总线工具消失 = 只剩空壳。两者都非零退出。

用法：
    py Castalia-Full/scripts/sync_core.py            # 只检查（核心一致性 + 总线自检）
    py Castalia-Full/scripts/sync_core.py --apply    # 从 Lite 同步核心到 Full
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


# 总线接口的最小证据：这些工具不在，Full 就退化成"又一份引擎副本"
# 分两处注册：引擎入口 index.ts 挂 reflect_all / memory_search_all，
# 独立进程 fedServer.ts 挂 memory_search_all / federation_members。
BUS_TOOLS = {
    "src/index.ts": ("memory_search_all", "reflect_all"),
    "src/fedServer.ts": ("memory_search_all", "federation_members"),
}
BUS_FILES = ("src/fedServer.ts", "src/reflectAll.ts")


def bus_probe():
    """静态自检：总线模块在、总线工具在对应入口里注册着。返回缺失清单。"""
    missing = []
    for rel in BUS_FILES:
        p = FULL / rel
        if not p.is_file():
            missing.append(f"{rel}:<missing file>")
        elif p.stat().st_size < 500:
            missing.append(f"{rel}:<空壳 {p.stat().st_size}B>")
    for rel, tools in BUS_TOOLS.items():
        try:
            text = (FULL / rel).read_text(encoding="utf-8")
        except OSError:
            missing.append(f"{rel}:<missing file>")
            continue
        for tool in tools:
            # 注册点形如 server.tool(\n  'memory_search_all' / register('memory_search_all'
            if f"'{tool}'" not in text:
                missing.append(f"{rel}:{tool}")
    return missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    pairs = core_files()
    changed = diffs(pairs)
    bus_missing = bus_probe()
    print(json.dumps({"from": "Castalia", "to": "Castalia-Full", "role": "bus-interface",
                      "version": (LITE / "VERSION").read_text(encoding="utf-8").strip(),
                      "coreFiles": len(pairs), "changed": len(changed),
                      "busOwned": len(FULL_OWNED) + len(FULL_OWNED_DIRS),
                      "busMissing": bus_missing},
                     ensure_ascii=False))
    for s, d in changed[:20]:
        print(f"  DIFF {s.relative_to(LITE)} -> {d.relative_to(ROOT)}")
    for m in bus_missing:
        print(f"  BUS  - {m}")
    if args.apply:
        for src, dst in pairs:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        print(f"synced {len(pairs)} core files")
        return 0
    return 1 if (changed or bus_missing) else 0


if __name__ == "__main__":
    sys.exit(main())
