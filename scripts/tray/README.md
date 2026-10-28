# 托盘运行时（源）

这里是 Castalia **托盘 / 守护 / 外壳 / 会话钩子**的唯一源码。运行时读取的副本在
`run/Castalia/scripts`（主目录），各实例镜像在 `run/LobeHub/scripts`、`D:/system/AIRI/scripts`。

```
Castalia-Full/scripts/tray/          ← 版本控制里的唯一源（改这里）
   │  deploy_tray.py                 源 → 主目录（备份 + py_compile + 复核哈希）
   ▼
run/Castalia/scripts/                ← 主目录：托盘进程、计划任务（Castalia Guard / Hermes Hook）读这里
   │  sync_to_instances.py           主目录 → 各实例镜像（原有机制，实例清单只此一份）
   ▼
run/LobeHub/scripts/  +  D:/system/AIRI/scripts/
```

```bash
py Castalia-Full/scripts/deploy_tray.py            # 只检查漂移（源→主目录 + 镜像，有漂移退出 1）
py Castalia-Full/scripts/deploy_tray.py --apply    # 备份 → 覆盖 → py_compile → 分发到镜像 → 复核
py Castalia-Full/scripts/deploy_tray.py --no-fanout --check   # 只看源→主目录
```

## 在源里的文件

| 文件 | 作用 |
|---|---|
| `castalia_tray.py` | 托盘主进程（pystray 图标、控制端口 3398、服务编排） |
| `castalia_config.py` | 配置解析：bridges / viz / instances / paths → 服务进程对象与环境 |
| `castalia_guard.py` | 短命守护（计划任务每 2 分钟一轮，跑完即退） |
| `castalia_settings.py` | 设置窗口 |
| `castalia_shell.py` | 原生外壳窗口（pywebview，控制端口 3397） |
| `service_runtime.py` | 期望状态文件 + 文件锁（托盘与守护共用） |
| `hermes_memory_hook.py` | Hermes 会话转录 → 记忆桥投喂 + 工具事件抽取 |
| `sync_to_instances.py` | 主目录 → 实例镜像的同步器（**实例清单唯一出处**） |
| `build_tray.cmd` / `run_guard.cmd` | 品牌 exe 构建、守护启动 |

## 有意不在源里的

| 东西 | 为什么 |
|---|---|
| `castalia.config.json` | 本机路径/端口/实例编排，属部署现场数据；仓库里只放 `castalia.config.example.json` 参考 |
| `service-state.json` / `guard-state.json` / `hermes_hook_state.json` | 运行状态（谁要跑、游标到哪） |
| `*.log` / `*.lock` / `*.bak-*` / `__pycache__` | 运行产物 |
| `tray-icons/`（88 文件 ≈ 5MB）、`shell/`（外壳 HTML） | 二进制资产，留在主目录；`deploy_tray.py --check` 会在缺失时提示 |

## 改完要重启才生效

Python 进程启动时就把代码读进内存：

```bash
curl -X POST http://127.0.0.1:3398/quit          # 优雅退出（会一并停掉桥与星图）
pythonw run/Castalia/scripts/castalia_tray.py    # 重新拉起
```

例外：`castalia_guard.py` 由计划任务每次新起进程执行，**改完下一轮（≤2 分钟）自动生效**；
`hermes_memory_hook.py` 同理（`run_hermes_hook.vbs` 每 2 分钟一次）。

## 状态语义（按需服务）

`service_wanted()` 里，标了 `onDemand` 的服务（AIRI 代理 5050 / 本地嵌入 11436 / Lemonade 分拣 13305）
在没人显式声明意图前**不算“要跑”**，状态三态：`按需（未启动）` / `已停用` / `运行中`。
只有托盘菜单和 `castalia_tray.ensure_on_demand()` 会拉起按需服务；`castalia_guard.py` 只观察不启动。
