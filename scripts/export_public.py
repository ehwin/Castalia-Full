"""把 Castalia-Full 的**核心引擎**导出成公开仓 Castalia（Lite 版）。

公开仓不再手工维护引擎代码：它是 Full 的生成产物 —— 同一版本、同一套核心行为，
只去掉联邦/跨库反思两个 Full 专属模块（Lite 的版本边界），并用 `index.lite.ts` 作为入口。
README / CHANGELOG / LICENSE / web / scripts 等发布内容仍归公开仓自己维护。

用法：
    py Castalia-Full/scripts/export_public.py            # 只比对（有漂移返回 1）
    py Castalia-Full/scripts/export_public.py --apply    # 执行导出
"""
import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FULL = ROOT / "Castalia-Full"
PUBLIC = ROOT / "Castalia"

# Full 专属：不进 Lite
EXCLUDE = {
    "src/index.ts",
    "src/index.lite.ts",
    "src/fedServer.ts",
    "src/reflectAll.ts",
}
EXCLUDE_DIRS = {"src/federation"}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def version() -> str:
    return (FULL / "VERSION").read_text(encoding="utf-8").strip()


def plan():
    """返回 [(source, dest)]，以及 Lite 的 index 映射。"""
    pairs = []
    for src in sorted((FULL / "src").rglob("*.ts")):
        rel = src.relative_to(FULL).as_posix()
        if rel in EXCLUDE or any(rel.startswith(d + "/") for d in EXCLUDE_DIRS):
            continue
        pairs.append((src, PUBLIC / rel))
    # lite 入口：index.lite.ts → public/src/index.ts
    pairs.append((FULL / "src" / "index.lite.ts", PUBLIC / "src" / "index.ts"))
    for name in ("VERSION", "scripts/gen_version.mjs"):
        pairs.append((FULL / name, PUBLIC / name))
    return pairs


def diffs(pairs):
    return [(s, d) for s, d in pairs if not d.exists() or sha(s) != sha(d)]


def apply(pairs):
    for src, dst in pairs:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    # 清掉导出后不该存在的旧 .ts（保持 Lite 源码 = 清单）
    keep = {d.resolve() for _, d in pairs}
    for p in (PUBLIC / "src").rglob("*.ts"):
        if p.resolve() not in keep and p.is_file():
            p.unlink()
    pkg_path = PUBLIC / "package.json"
    pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
    pkg["version"] = version()
    pkg.setdefault("scripts", {})["build"] = "node scripts/gen_version.mjs && tsc -p tsconfig.build.json"
    pkg_path.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest = {
        "source": "Castalia-Full",
        "edition": "lite",
        "version": version(),
        "excluded": sorted(EXCLUDE | {d + "/**" for d in EXCLUDE_DIRS}),
        "files": {str(s.relative_to(FULL)): sha(s) for s, _ in pairs},
    }
    (PUBLIC / ".export-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    pairs = plan()
    changed = diffs(pairs)
    print(json.dumps({"public": str(PUBLIC), "version": version(), "edition": "lite",
                      "files": len(pairs), "changed": len(changed)}, ensure_ascii=False))
    for s, d in changed[:20]:
        print(f"  DIFF {s.relative_to(FULL)} -> {d.relative_to(ROOT)}")
    if args.apply:
        apply(pairs)
        print(f"exported {len(pairs)} files; version {version()}")
        return 0
    return 1 if changed else 0


if __name__ == "__main__":
    sys.exit(main())
