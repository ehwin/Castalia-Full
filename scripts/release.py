"""统一发布门：版本一致性 → 构建（Lite 核心 / Full 总线 / Anima）→ 跑回归+对账 → 部署 → 校验漂移。

一条命令覆盖原来"手工 build / 手工 deploy / 手工对账"的全过程；任何一步失败即中止。

架构（v1.25 起）：**Lite（Castalia）= 引擎核心源；Full = 总线接口（总线 + 总反思 +
聚合星图），核心由 sync_core 同步；Anima = 情感变体，自己一条引擎线。**
所以版本锚是 **Lite**，Full 必须与它同版；Anima 只校验自身一致（它有自己的版本号）。

用法（任意目录）：
    py Castalia-Full/scripts/release.py            # 全流程
    py Castalia-Full/scripts/release.py --check    # 只做版本检查、构建与回归，不部署
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LITE = ROOT / "Castalia"
FULL = ROOT / "Castalia-Full"
ANIMA = ROOT / "Castalia-Anima"
RUN = ROOT / "run"
NODE = "node"
PY = sys.executable


def fail(msg):
    print(f"[release] FAIL: {msg}")
    raise SystemExit(1)


def run(cmd, cwd, capture=True):
    print(f"[release] $ {' '.join(str(c) for c in cmd)}  (cwd={cwd})")
    proc = subprocess.run(cmd, cwd=str(cwd), capture_output=capture, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        print(proc.stdout or "")
        print(proc.stderr or "")
        fail(f"command exited {proc.returncode}")
    return proc.stdout or ""


def last_json(text):
    for line in reversed((text or "").splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                return json.loads(line)
            except Exception:
                continue
    return None


def check_versions():
    version = (LITE / "VERSION").read_text(encoding="utf-8").strip()
    if not version:
        fail("Castalia/VERSION 为空")
    # Full = 总线接口，核心与 Lite 同源 → 必须同版
    if (FULL / "VERSION").read_text(encoding="utf-8").strip() != version:
        fail(f"Castalia-Full/VERSION={(FULL / 'VERSION').read_text(encoding='utf-8').strip()} != Lite {version}"
             "（Full 是总线接口，核心跟 Lite 同步）")
    # Anima 有自己的引擎线，只要求自身 VERSION ↔ version.ts 一致
    anima_version = (ANIMA / "VERSION").read_text(encoding="utf-8").strip()
    if not anima_version:
        fail("Castalia-Anima/VERSION 为空")

    for repo, want in ((FULL, version), (ANIMA, anima_version)):
        vt = (repo / "src" / "version.ts").read_text(encoding="utf-8")
        if f"'{want}'" not in vt:
            fail(f"{repo.name}/src/version.ts 未同步（先跑 scripts/gen_version.mjs）")
        pkg_path = repo / "package.json"
        pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
        if pkg.get("version") != want:
            # package.json 历史上一直没跟着 VERSION 走（gen_version 只写 version.ts），
            # 当门禁硬失败会把发布卡死在无关字段上，这里只提示。
            print(f"[release] WARN {repo.name}/package.json version={pkg.get('version')} != {want}")

    lite_pkg = json.loads((LITE / "package.json").read_text(encoding="utf-8"))
    if lite_pkg.get("version") != version:
        print(f"[release] WARN Castalia/package.json version={lite_pkg.get('version')} != {version}")

    for cfg_path in (RUN / "Castalia" / "scripts" / "castalia.config.json",
                     RUN / "LobeHub" / "scripts" / "castalia.config.json"):
        if not cfg_path.exists():
            fail(f"缺少 {cfg_path}")
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        variants = {i.get("variant") for i in cfg.get("instances") or []}
        if not variants <= {"full", "anima"}:
            fail(f"{cfg_path} 仍有非统一变体: {sorted(variants)}")
    print(f"[release] version OK: Lite {version} / Anima {anima_version}")
    return version


def check_core():
    """Lite 是引擎核心源；Full（总线接口）的核心必须与之一致，且总线工具必须在。"""
    proc = subprocess.run([PY, "Castalia-Full/scripts/sync_core.py"], cwd=str(ROOT),
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        print(proc.stdout or "")
        fail("Full 核心与 Lite 漂移，或总线工具缺失（跑 sync_core.py --apply 后再看 busMissing）")
    pkg = json.loads((LITE / "package.json").read_text(encoding="utf-8"))
    if pkg.get("version") not in (None, (LITE / "VERSION").read_text(encoding="utf-8").strip()):
        print("[release] WARN Lite package.json 与 VERSION 不一致（不影响发布）")
    print("[release] core sync OK (Lite -> Full bus)")


def build():
    """Lite 核心 / Full 总线（含 fedServer 独立进程）/ Anima 三条产物都要能构建。"""
    for repo in (LITE, FULL, ANIMA):
        if not (repo / "src").is_dir():
            fail(f"{repo} 缺少 src")
        run([NODE, "scripts/gen_version.mjs"], repo)
        run([NODE, "node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], repo)
    for entry in ("index.js", "fedServer.js"):
        if not (FULL / "dist" / entry).is_file():
            fail(f"Full 构建缺少总线产物 dist/{entry}")


def tests():
    results = {}
    # Full 侧：总反思（reflect_all 的落点）+ 总线面聚合（memory_context/index/context_get 跨库）
    for script in ("regression_reflection.mjs", "regression_context.mjs", "regression_engine.mjs"):
        r = last_json(run([NODE, f"scripts/{script}", "."], FULL))
        if not r or not r.get("ok"):
            fail(f"Full {script} 失败: {r}")
        results[script] = r
    for script in ("regression_facts.mjs", "regression_v123_anima.mjs", "regression_anima_audit.mjs"):
        r = last_json(run([NODE, f"scripts/{script}", "."], ANIMA))
        if not r or not r.get("ok"):
            fail(f"Anima {script} 失败: {r}")
        results[script] = r
    parity = last_json(run([NODE, "scripts/check_parity.mjs", "--strict"], FULL))
    if not parity or not parity.get("ok"):
        fail(f"引擎对账失败: {parity}")
    results["parity"] = parity
    return results


def deploy():
    before = last_json(run([PY, "Castalia-Full/scripts/deploy_runtime.py", "--apply"], ROOT))
    after = last_json(run([PY, "Castalia-Full/scripts/deploy_runtime.py"], ROOT))
    if not before or not after:
        fail("部署输出无法解析")
    if after.get("changedModules") != 0 or after.get("staleModules", 0) != 0:
        fail(f"部署后仍有漂移/残留: {after}")
    return before, after


def check_tray():
    """托盘运行时源（Castalia-Full/scripts/tray）→ run/Castalia/scripts 不能漂移。

    实例镜像（LobeHub / AIRI）由 sync_to_instances.py 分发，可能滞后（比如对方机器没部署），
    所以发布门槛只卡"源→主目录"这一段；镜像漂移数只报出来给人看。
    """
    proc = subprocess.run([PY, "Castalia-Full/scripts/deploy_tray.py", "--no-fanout", "--json"],
                          cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace")
    summary = last_json(proc.stdout or "")
    if proc.returncode != 0 or not summary or not summary.get("ok"):
        fail(f"托盘源与主目录漂移（跑 deploy_tray.py --apply）: {summary or proc.stdout or proc.stderr}")
    fan = last_json(run([PY, "Castalia-Full/scripts/deploy_tray.py", "--json"], ROOT))
    return {"files": summary.get("files"), "drift": len(summary.get("primaryDrifted") or []),
            "fanoutPending": (fan or {}).get("fanoutExit")}


def main():
    check_only = "--check" in sys.argv
    version = check_versions()
    check_core()
    build()
    results = tests()
    tray = check_tray()
    summary = {"version": version, "checks": {k: (v or {}).get("checks") for k, v in results.items()},
               "parity": (results["parity"] or {}).get("features"), "tray": tray, "deployed": None}
    if not check_only:
        before, _ = deploy()
        summary["deployed"] = before.get("changedModules")
    print(json.dumps({"ok": True, **summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
