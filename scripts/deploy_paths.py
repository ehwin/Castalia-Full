"""部署根 / 源码根的解析(单一出处,别在每个脚本里各写一份)。

2026-10-29 起:源码仓留在 `D:\\AI\\castalia`(Castalia / Castalia-Full / Castalia-Anima),
运行时(run/ + memory-banks/)已经整体迁到 `D:\\castalia`。
所有部署脚本必须用 `deploy_root()` 找 run/,不能再用 `ROOT/'run'` ——
不然它们会安静地在废弃的仓目录下新建一套 run/,看起来"同步成功",实际没人读。

优先级:`CASTALIA_DEPLOY_ROOT` 环境变量 > 仓同级目录下若有 run/ > `D:/castalia` > 仓同级目录。
"""
import os
from pathlib import Path


def repo_root() -> Path:
    """仓库根:Castalia-Full/scripts/deploy_paths.py → 上两级。"""
    return Path(__file__).resolve().parents[2]


def deploy_root() -> Path:
    env = (os.environ.get("CASTALIA_DEPLOY_ROOT") or "").strip()
    if env:
        return Path(env)
    repo = repo_root()
    for cand in (repo.parent, Path("D:/castalia")):
        if (cand / "run").is_dir():
            return cand
    return repo.parent


def run_dir(*parts) -> Path:
    return deploy_root().joinpath("run", *parts)


def bank_root() -> Path:
    env = (os.environ.get("CASTALIA_BANK_ROOT") or "").strip()
    return Path(env) if env else deploy_root() / "memory-banks"
