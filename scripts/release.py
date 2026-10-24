"""统一发布门：版本一致性 → 构建两套引擎 → 跑全部回归+对账 → 部署 → 校验漂移。

一条命令覆盖原来"手工 build / 手工 deploy / 手工对账"的全过程；任何一步失败即中止。
用法（任意目录）：
    py Castalia-Full/scripts/release.py            # 全流程
    py Castalia-Full/scripts/release.py --check    # 只做版本检查与构建，不部署
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
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
    version = (FULL / "VERSION").read_text(encoding="utf-8").strip()
    if not version:
        fail("Castalia-Full/VERSION 为空")
    if (ANIMA / "VERSION").read_text(encoding="utf-8").strip() != version:
        fail("两套引擎的 VERSION 不一致")

    for repo in (FULL, ANIMA):
        pkg = json.loads((repo / "package.json").read_text(encoding="utf-8"))
        if pkg.get("version") != version:
            fail(f"{repo.name}/package.json version={pkg.get('version')} != {version}")
        vt = (repo / "src" / "version.ts").read_text(encoding="utf-8")
        if f"'{version}'" not in vt:
            fail(f"{repo.name}/src/version.ts 未同步（先跑 scripts/gen_version.mjs）")

    for cfg_path in (RUN / "Castalia" / "scripts" / "castalia.config.json",
                     RUN / "LobeHub" / "scripts" / "castalia.config.json"):
        if not cfg_path.exists():
            fail(f"缺少 {cfg_path}")
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        if (cfg.get("app") or {}).get("version") != version:
            fail(f"{cfg_path} app.version={(cfg.get('app') or {}).get('version')} != {version}")
        variants = {i.get("variant") for i in cfg.get("instances") or []}
        if not variants <= {"full", "anima"}:
            fail(f"{cfg_path} 仍有非统一变体: {sorted(variants)}")
    print(f"[release] version OK: {version}")
    return version


def check_core():
    """Lite 是引擎核心源；Full 的核心必须与之一致（Full 只多 bus 模块）。"""
    proc = subprocess.run([PY, "Castalia-Full/scripts/sync_core.py"], cwd=str(ROOT),
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        print(proc.stdout or "")
        fail("Full 核心与 Lite 漂移（跑 sync_core.py --apply）")
    pkg = json.loads((ROOT / "Castalia" / "package.json").read_text(encoding="utf-8"))
    if pkg.get("version") != (FULL / "VERSION").read_text(encoding="utf-8").strip():
        fail("Lite package.json 版本不一致")
    print("[release] core sync OK (Lite -> Full)")


def build():
    for repo in (FULL, ANIMA, ROOT / "Castalia"):
        if not (repo / "src").is_dir():
            fail(f"{repo} 缺少 src")
        run([NODE, "scripts/gen_version.mjs"], repo)
        run([NODE, "node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], repo)


def tests():
    results = {}
    full = last_json(run([NODE, "scripts/regression_reflection.mjs"], FULL))
    if not full or not full.get("ok"):
        fail(f"Full 回归失败: {full}")
    results["full"] = full
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


def main():
    check_only = "--check" in sys.argv
    version = check_versions()
    check_core()
    build()
    results = tests()
    summary = {"version": version, "checks": {k: v.get("checks") for k, v in results.items()},
               "parity": results["parity"].get("features"), "deployed": None}
    if not check_only:
        before, _ = deploy()
        summary["deployed"] = before.get("changedModules")
    print(json.dumps({"ok": True, **summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
