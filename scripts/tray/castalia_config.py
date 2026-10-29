# -*- coding: utf-8 -*-
"""Castalia 记忆体 · 配置加载器(2026-09-15 通用化)

把 castalia.config.json 转成托盘/守护脚本用的常量,让路径、端口、实例全部可配置 ——
开源用户只需改 JSON,不用碰代码。

设计要点
  · 配置文件缺失 → 回退内置默认(与历史硬编码一致),保证老部署不乱。
  · 路径解析:home 可被环境变量 CASTALIA_HOME 覆盖;值形如 "airiBase/viz" 时,
    前缀若命中 paths 的键,就按 paths 解析成绝对路径;否则当字面值。
  · 环境变量值支持 "run/xxx" 这类路径引用,以及 ${KEY} 形式。
  · instance 过滤:传 instance="airi" 时只保留该实例的桥/星图/代理(多实例共用一套代码)。

用法
    import castalia_config as cfg
    C = cfg.load()                  # 全部实例
    C = cfg.load(instance="airi")   # 只 AIRI 那套
    C.BRIDGES / C.VIZ / C.EMBED / C.AIRI_PROXY / C.INSTANCES / C.APP / C.PATHS
"""
import json
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(HERE, "castalia.config.json")

# ── 内置默认(配置缺失时的回退;与历史硬编码值一致)──
FALLBACK = {
    "app": {"name": "Castalia 记忆体", "version": "1.22.0",
            "publisher": "Castalia 记忆体项目", "desc": "记忆体联邦控制台与运行时看护"},
    "paths": {
        "home": r"D:\castalia",
        "run": r"D:\castalia\run\Castalia",
        "lobehubRun": r"D:\castalia\run\LobeHub",
        "banks": r"D:\castalia\memory-banks",
        "anima": r"D:\castalia\run\Castalia-Anima",
        "full": r"D:\castalia\run\Castalia-Federation",
        "airiBase": r"D:\system\AIRI",
        "lobehubDir": r"D:\AI\lobehub",
        "node": r"D:\castalia\run\Castalia\bin\CastaliaNode.exe",
        "pythonHost": r"D:\castalia\run\Castalia\Castalia\Castalia.exe",
    },
    "instances": [
        {"id": "hermes", "label": "Hermes 记忆体", "variant": "full",
         "icon": "tray-icons/brand/lite-tray.png", "bank": "hermes", "char": "hermes", "project": "hermes"},
        {"id": "dsh", "label": "DSH 记忆体", "variant": "full",
         "icon": "tray-icons/brand/lite-tray.png", "bank": "dsh", "char": "dsh", "project": "dsh"},
        {"id": "lobehub", "label": "LobeHub 记忆体", "variant": "full",
         "icon": "tray-icons/brand/lite-tray.png", "bank": "lobehub", "char": "lobehub", "project": "lobehub"},
        {"id": "airi", "label": "AIRI（Anima）", "variant": "anima",
         "icon": "tray-icons/brand/anima-tray.png", "bank": "airi", "char": "airi", "project": "airi"},
        {"id": "full", "label": "Full 汇总", "variant": "full",
         "icon": "tray-icons/brand/max-tray.png", "bank": "full", "char": "full", "project": "full"},
    ],
    "bridges": [
        {"id": "hermes-bridge", "name": "Hermes 记忆桥", "port": 3316,
         "instance": "hermes", "char": "hermes", "project": "hermes", "bank": "hermes"},
        {"id": "dsh-bridge", "name": "DSH 记忆桥", "port": 3318,
         "instance": "dsh", "char": "dsh", "project": "dsh", "bank": "dsh"},
        {"id": "lobehub-bridge", "name": "LobeHub 记忆桥", "port": 3310,
         "instance": "lobehub", "char": "lobehub", "project": "lobehub", "bank": "lobehub"},
        {"id": "shushu-bridge", "name": "术数记忆桥", "port": 3312,
         "instance": "lobehub", "char": "shushu", "project": "shushu", "bank": "lobehub"},
    ],
    "viz": [
        {"id": "dsh", "name": "DSH 星图", "port": 3347, "instance": "dsh",
         "dir": "run/viz", "bank": "dsh",
         "env": {"CASTALIA_PROJECT": "dsh", "CHAR_ID": "dsh", "GRAPH_CATEGORY_INSTANCES": "airi"}},
        {"id": "hermes", "name": "Hermes 星图", "port": 3345, "instance": "hermes",
         "dir": "run/viz", "bank": "hermes", "env": {"GRAPH_CATEGORY_INSTANCES": "airi"}},
        {"id": "lobehub", "name": "LobeHub 星图", "port": 3346, "instance": "lobehub",
         "dir": "lobehubRun/viz", "bank": "lobehub", "env": {"GRAPH_CATEGORY_INSTANCES": "airi"}},
        {"id": "airi", "name": "AIRI 星图", "port": 3344, "instance": "airi",
         "dir": "airiBase/viz", "bank": "airi",
         "env": {"ANIMA_DIR": "anima", "CASTALIA_MCP": "anima/dist/index.js",
                 "GRAPH_CATEGORY_INSTANCES": "airi"}},
        {"id": "full", "name": "Full 汇总星图", "port": 3348, "instance": "full",
         "dir": "full/web", "bank": "full", "federation": True,
         "env": {"CASTALIA_MCP": "full/dist/index.js", "GRAPH_CATEGORY_INSTANCES": "airi"}},
    ],
    "airiProxy": {"id": "airi-proxy", "name": "AIRI 代理", "port": 5050, "instance": "airi",
                  "script": "airiBase/unified-proxy/proxy.py", "cwd": "airiBase/unified-proxy",
                  "bank": "airi", "char": "airi", "project": "airi"},
    "embed": {"id": "embed", "name": "嵌入", "port": 11436,
              "script": "run/yuan_embed_server.py", "cwd": "run"},
    "extraServices": [
        {"id": "lemonade", "name": "AIRI 分拣", "port": 13305, "instance": "airi",
         "program": r"D:\AI\Lemonade\bin\LemonadeServer.exe", "cwd": r"D:\AI\Lemonade\bin"},
    ],
    # 桌面外壳(原生窗口 GUI):存在此段 → 托盘「打开…」入口优先送进外壳窗口
    "shell": {"id": "shell", "name": "控制台", "port": 3397},
    "tray": {"id": "tray", "name": "托盘", "port": 3398},
    "federation": [
        {"name": "DSH", "dir": "D:/castalia/memory-banks/dsh"},
        {"name": "Hermes", "dir": "D:/castalia/memory-banks/hermes"},
        {"name": "LobeHub", "dir": "D:/castalia/memory-banks/lobehub"},
        {"name": "AIRI", "dir": "D:/castalia/memory-banks/airi"},
    ],
}


class Config:
    def __init__(self, data, instance=None, source="fallback"):
        self.source = source
        self.raw = data
        self.APP = dict(data.get("app") or {})
        self.PATHS = self._resolve_paths(data.get("paths") or {})
        self.INSTANCES = list(data.get("instances") or [])
        self.instance = instance

        # ── 路径别名(脚本里沿用旧名字)──
        self.BASE = self.PATHS.get("run", "")
        self.BANKS = self.PATHS.get("banks", "")
        self.NODE = self.PATHS.get("node", "")
        self.PYW = self.PATHS.get("pythonHost", "")
        self.LOBEHUB_RUN = self.PATHS.get("lobehubRun", "")
        self.AIRI_BASE = self.PATHS.get("airiBase", "")
        self.AIRI_ANIMA = self.PATHS.get("anima", "")
        self.LOBEHUB_DIR = self.PATHS.get("lobehubDir", "")
        self.MCP_PROXY = os.path.join(self.PATHS.get("proxyDeps") or self.LOBEHUB_RUN, "node_modules", "mcp-proxy",
                                      "dist", "bin", "mcp-proxy.mjs")
        self.FEDERATION = json.dumps(
            [{"name": f["name"], "dir": self._resolve(f["dir"])} for f in (data.get("federation") or [])],
            ensure_ascii=False)

        # ── 服务定义 ──
        self.PROMOTE_GATE = data.get("promoteGate") or {}
        self.BRIDGES = [self._bridge(b) for b in (data.get("bridges") or []) if self._keep(b.get("instance"))]
        self.VIZ = [self._viz(v) for v in (data.get("viz") or []) if self._keep(v.get("instance"))]
        ap = data.get("airiProxy")
        self.AIRI_PROXY = self._airi_proxy(ap) if (ap and self._keep(ap.get("instance"))) else None
        em = data.get("embed")
        self.EMBED = self._embed(em) if em else None
        # 联邦服务(v1.14):与桥同构,build 完直接并入 BRIDGES → 托盘/守护逻辑零特例
        self.FED_SERVICE = self._fed_service(data.get("federationService"))
        self.BRIDGES = [self._bridge(b) for b in (data.get("bridges") or []) if self._keep(b.get("instance"))]
        if self.FED_SERVICE:
            self.BRIDGES.append(self.FED_SERVICE)
        # 第三方附带服务(AIRI 分拣 Lemonade 之类):配置里删掉就不会出现在菜单
        self.EXTRAS = [self._extra(e) for e in (data.get("extraServices") or [])
                       if self._keep(e.get("instance"))]
        # 桌面外壳(原生窗口 GUI):配置里删掉此段 → 「打开…」一律回浏览器
        self.SHELL = self._shell(data.get("shell"))
        # 托盘自身控制端口(2026-10-02):端口即身份 + 远程控制(--status/--quit),
        # 与 SHELL 同一套做法;抢不到端口 = 已有托盘在跑。
        self.TRAY = self._tray(data.get("tray"))
        # 网页壳偏好(2026-09-26):mode=edge 的入口(如 LobeHub)直接开 Edge 应用窗口,
        # 不收进原生外壳;缺省 = shell(与其它入口一致,保持旧行为)。
        self.WEBAPP = self._webapp(data.get("webApp"))
        # LobeHub compose 栈随托盘启动(2026-10-01):把「开机即起 LobeHub」接进托盘启动流程。
        # autoStart=false 时只保留托盘菜单里的手动开关(旧行为)。
        self.LOBEHUB_BOOT = self._lobehub_boot(data.get("lobehub"))

    # ── 内部工具 ──
    def _keep(self, inst):
        return True if not self.instance else (inst in (None, self.instance))

    def _resolve(self, value):
        """解析路径引用:'airiBase/viz' → paths['airiBase'] + '/viz';支持 ${VAR} 与环境变量。"""
        if not isinstance(value, str):
            return value
        value = os.path.expandvars(value)
        if value.startswith("${") and value.endswith("}"):
            return self.PATHS.get(value[2:-1].lower(), value)
        head, _, rest = value.partition("/")
        if head in self.PATHS:
            base = self.PATHS[head]
            return os.path.join(base, *rest.split("/")) if rest else base
        return value

    def _resolve_paths(self, paths):
        out = {}
        home = os.environ.get("CASTALIA_HOME") or paths.get("home") or ""
        for k, v in paths.items():
            if k == "home":
                out[k] = home
                continue
            v = os.path.expandvars(str(v))
            if not os.path.isabs(v):
                v = os.path.join(home, v)
            out[k] = os.path.normpath(v)
        return out

    def _bank_dir(self, bank):
        return os.path.join(self.BANKS, bank) if bank else self.BANKS

    def _global_env(self):
        """部署级个性化环境(助手名/反思策略名单等)。桥/星图自己的 env 会再覆盖它。"""
        out = {}
        for k, v in (self.raw.get("env") or {}).items():
            if str(k).startswith("_"):
                continue
            out[str(k)] = self._resolve(v) if isinstance(v, str) else str(v)
        return out

    def _bridge(self, b):
        bank_dir = self._bank_dir(b.get("bank"))
        env = {
            "MEMORY_DB_DIR": bank_dir,
            "MEMORY_DB_PATH": "",
            "CHAR_ID": b.get("char", ""),
            "CASTALIA_PROJECT": b.get("project", ""),
            "CASTALIA_KEYS_FILE": os.path.join(bank_dir, "keys.enc"),
            "CASTALIA_KEY_FILE": os.path.join(bank_dir, "keys.key"),
            "MEMORY_CONFIG": os.path.join(bank_dir, "config.json"),
            "MCP_TOOLS": "all",
            "FEDERATION_DIRS": "[]",
            "FEDERATION_MEMBERS": "[]",
            "AGGREGATE_DIRS": "[]",
            "FULL_REFLECT_DIR": "",
            "REFLECT_DIR": bank_dir,
        }
        env.update(self._global_env())
        # 联邦开关(v1.14):true = 把全局 federation 列表作为联邦成员传给引擎,
        # 于是 memory_search_all / reflect_all 可以跨记忆体工作;缺省不传(只搜本实例)。
        if b.get("federation"):
            env["FEDERATION_DIRS"] = self.FEDERATION
            env["FEDERATION_MEMBERS"] = self.FEDERATION
        # 跨库污染闸门名单(引擎 store.ts 读取):公共版源码默认不拦,这里按实例还原
        gate = getattr(self, "PROMOTE_GATE", {}) or {}
        if gate.get("foreignNames"):
            env["CASTALIA_FOREIGN_NAMES"] = ",".join(gate["foreignNames"])
        if gate.get("homeNames"):
            env["CASTALIA_HOME_NAMES"] = json.dumps(gate["homeNames"], ensure_ascii=False)
        # v1.12: 该桥可用自己的 env 覆盖引擎变量(例:shushu-bridge 挂保真反思提示词,
        # 不影响 lobehub 主库);值支持 paths 键前缀与 ${VAR} 展开。
        for k, v in (b.get("env") or {}).items():
            env[str(k)] = self._resolve(v) if isinstance(v, str) else str(v)
        return {
            "id": b["id"], "name": b["name"], "port": int(b["port"]),
            "instance": b.get("instance"), "bank": b.get("bank"),
            "cmd": [self.NODE, self.MCP_PROXY, "--host", "0.0.0.0", "--port", str(int(b["port"])),
                    "--connectionTimeout", "180000",          # 开机 IO 峰值下给引擎更多握手时间
                    "--server", "stream", "--", self.NODE, "dist/index.js"],
            "cwd": self.PATHS.get("run") or self.LOBEHUB_RUN,
            "env": env,
        }

    def _viz(self, v):
        cwd = self._resolve(v.get("dir", ""))
        instance = next((i for i in self.INSTANCES if i.get("id") == v.get("instance")), {})
        bank_dir = self._bank_dir(v.get("bank"))
        env = {
            "WEB_PORT": str(int(v["port"])),
            "MEMORY_DB_DIR": self._bank_dir(v.get("bank")),
            "MEMORY_DB_PATH": "",
            "FEDERATION_DIRS": self.FEDERATION if v.get("federation") else "[]",
            "FEDERATION_MEMBERS": self.FEDERATION if v.get("federation") else "[]",
            "AGGREGATE_DIRS": self.FEDERATION if v.get("federation") else "[]",
            "GRAPH_MEMBERS_FILE": os.path.join(bank_dir, "federation-viz.json"),
            "REFLECT_DIR": bank_dir,
            "FULL_REFLECT_DIR": "",
            "MEMORY_CONFIG": os.path.join(self._bank_dir(v.get("bank")), "config.json"),
            "CASTALIA_PROJECT": v.get("project") or instance.get("project") or v.get("bank") or "default",
            "CHAR_ID": v.get("char") or instance.get("char") or v.get("bank") or "default",
        }
        env.update(self._global_env())
        for k, val in (v.get("env") or {}).items():
            env[k] = self._resolve(val)
        return {"id": v["id"], "name": v["name"], "port": int(v["port"]),
                "instance": v.get("instance"), "cwd": cwd, "env": env,
                "cmd": [self.NODE, os.path.join(cwd, "server.mjs")]}

    def _airi_proxy(self, ap):
        bank_dir = self._bank_dir(ap.get("bank"))
        cwd = self._resolve(ap.get("cwd", ""))
        return {
            "id": ap["id"], "name": ap["name"], "port": int(ap["port"]),
            "instance": ap.get("instance"),
            # 按需服务：没人显式要就不常驻（见 castalia_tray.service_wanted）
            "onDemand": bool(ap.get("onDemand")),
            "cmd": [self.PYW, self._resolve(ap.get("script", ""))],
            "cwd": cwd,
            "env": {
                "ANIMA_DIR": self.AIRI_ANIMA,
                "CASTALIA_BANK_DIR": bank_dir,
                "FULL_REFLECT_DIR": self._bank_dir(self.raw.get("fullReflectBank", "full")),
                "MEMORY_DIR": bank_dir,
                "MEMORY_DB_DIR": bank_dir,
                "MEMORY_DB_PATH": "",
                "CASTALIA_PROJECT": ap.get("project", ""),
                "CHAR_ID": ap.get("char", ""),
                "WEB_PORT": "3344",
                "NODE_BIN": self.NODE,
                "OLLAMA_URL": "https://api.siliconflow.cn/v1",
                "EMBEDDING_MODEL": "BAAI/bge-m3",
                "FEDERATION_DIRS": "[]",
                "FEDERATION_MEMBERS": "[]",
                "REALTIME_CLASSIFY": "1",
                "LLM_UPSTREAM": "https://api.deepseek.com/v1",
            },
        }

    def _embed(self, em):
        cwd = self._resolve(em.get("cwd", ""))
        return {"id": em["id"], "name": em["name"], "port": int(em["port"]), "cwd": cwd,
                # 按需：只有"本地嵌入模式 + 真的需要嵌"时才有意义；云端已配置时压根不该起
                "onDemand": bool(em.get("onDemand")),
                "cmd": [self.PYW, self._resolve(em.get("script", "")), str(int(em["port"]))]}

    def _fed_service(self, f):
        """联邦服务(v1.14):把"跨记忆体收纳"作为一个独立 MCP 端点暴露。

        结构与记忆桥同构(mcp-proxy 包住一个 stdio 引擎)→ 托盘/守护的启停与健康判定
        直接复用,无需特例。引擎是 Full 版的 dist/fedServer.js;成员配置由 members 生成
        FEDERATION_MEMBERS 传给它 —— 于是 Lite 实例也能挂这个端点用联邦记忆。
        """
        if not f or not self._keep(f.get("instance")):
            return None
        members = []
        for m in (f.get("members") or []):
            mm = dict(m)
            if mm.get("target"):
                mm["target"] = self._resolve(mm["target"])
            members.append(mm)
        cwd = self._resolve(f.get("dir", ""))
        env = {
            "FEDERATION_MEMBERS": json.dumps(members, ensure_ascii=False),
            "CASTALIA_INSTANCE_ID": f.get("id", "federation"),
            "CASTALIA_INSTANCE_LABEL": f.get("name", "联邦接口"),
        }
        if f.get("ownBank"):
            env["MEMORY_DB_DIR"] = self._bank_dir(f["ownBank"])
        return {
            "id": f["id"], "name": f["name"], "port": int(f["port"]),
            "instance": f.get("instance"),
            "federation": True,          # 标记:菜单/状态里可单独识别
            "cmd": [self.NODE, self.MCP_PROXY, "--host", "0.0.0.0", "--port", str(int(f["port"])),
                    "--connectionTimeout", "180000", "--server", "stream", "--",
                    self.NODE, os.path.join(cwd, "dist", "fedServer.js")],
            "cwd": cwd,
            "env": env,
        }

    def _shell(self, s):
        """桌面外壳(原生窗口 GUI,castalia_shell.py)。

        存在该段 → 托盘的「打开…」入口优先送进外壳窗口(已在跑就导航过去,没跑就拉起);
        删掉该段 → 一律回浏览器。port 是外壳的本地控制端口,托盘靠它把已开的窗口导到新页面。
        """
        if not s or not self._keep(s.get("instance")):
            return None
        return {"id": s.get("id", "shell"), "name": s.get("name", "控制台"),
                "port": int(s.get("port", 3397)),
                "script": os.path.join(HERE, "castalia_shell.py")}

    def _tray(self, t):
        """托盘自身的控制端口(与 _shell 同构)。缺段时给默认 3398,保证托盘身份可用。"""
        t = t or {}
        try:
            port = int(t.get("port", 3398))
        except Exception:
            port = 3398
        return {"id": t.get("id", "tray"), "name": t.get("name", "托盘"), "port": port}

    def _lobehub_boot(self, d):
        """LobeHub compose 栈的随托盘启动配置(autoStart / delaySeconds)。

        autoStart: 托盘启动后顺带把栈拉起(需要 WSL + docker);默认 false,保持旧行为。
        delaySeconds: 启动延迟,给开机 IO 峰值留余量(默认 45s)。
        """
        d = d or {}
        try:
            delay = float(d.get("delaySeconds", 45))
        except Exception:
            delay = 45.0
        return {
            "autoStart": bool(d.get("autoStart", False)),
            "delaySeconds": max(0.0, delay),
        }

    def _webapp(self, w):
        """网页壳偏好(不对应常驻服务,只决定「打开…」用哪个窗口)。

        mode: edge = Edge 应用窗口(--app,无地址栏、独立任务栏图标,沿用默认 Edge 配置的登录态);
              browser = 系统默认浏览器;shell / 缺省 / 非法值 = 与其它入口一致,收进原生外壳。
        browser: 可选,指定浏览器 exe;留空则自动找 Edge,找不到再由调用方回落。
        """
        if not w or not isinstance(w, dict):
            return {}
        mode = str(w.get("mode") or "").strip().lower()
        return {"mode": mode if mode in ("edge", "browser", "shell") else "",
                "browser": str(w.get("browser") or "").strip()}

    # ── 便利方法 ──
    def _extra(self, e):
        return {"id": e["id"], "name": e.get("name", e["id"]), "port": int(e["port"]),
                "instance": e.get("instance"),
                # 第三方分拣/推理服务一律按需：常驻只会白烧显存/内存
                "onDemand": bool(e.get("onDemand")),
                "cmd": [self._resolve(e["program"])] if e.get("program") else [],
                "cwd": self._resolve(e.get("cwd", ""))}

    def extra(self, service_id):
        for e in self.EXTRAS:
            if e["id"] == service_id:
                return e
        return None

    def icon_for(self, instance_id):
        for i in self.INSTANCES:
            if i.get("id") == instance_id:
                return os.path.join(HERE, i.get("icon", "")) if i.get("icon") else None
        return None

    def label_for(self, instance_id):
        for i in self.INSTANCES:
            if i.get("id") == instance_id:
                return i.get("label")
        return None


def load(path=None, instance=None):
    """加载配置。path 默认 scripts/castalia.config.json;缺失则回退内置默认。"""
    path = path or DEFAULT_CONFIG
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            return Config(data, instance=instance, source=path)
        except Exception as e:
            print(f"[castalia_config] 配置解析失败({path}): {e!r} — 回退内置默认", file=sys.stderr)
    return Config(FALLBACK, instance=instance, source="fallback")


# ══════════════════════════ 记忆库角色模型(库级 config.json)══════════════════════════
# 每个库有自己的 <banks>/<bank>/config.json:分拣(triage)/反思(reflect)/嵌入(embedding)
# 各角色的模型与端点。引擎启动时按 MEMORY_CONFIG 读同一份文件;托盘设置窗口的
# 「角色模型」页读写它。这里只提供路径与安全的读写原语,不动 castalia.config.json 的
# 既有语义 —— 没有这些文件时一切照旧(引擎用内置默认)。
def _default_banks_dir():
    """解析 <paths.banks>(Config.BANKS)。配置损坏时退回 FALLBACK,保证不抛异常。"""
    try:
        banks = load().BANKS
    except Exception:
        banks = ""
    if not banks:
        banks = (FALLBACK.get("paths") or {}).get("banks", "")
    return banks or ""


def bank_config_path(bank, banks_dir=None):
    """库配置路径:<banks>/<bank>/config.json。

    banks_dir 缺省取当前 castalia.config.json 的 paths.banks(即 Config.BANKS)。
    bank 为空时退回 <banks>/config.json(正常调用不会这样用,仅防御)。
    """
    base = banks_dir or _default_banks_dir()
    name = str(bank or "").strip()
    return os.path.join(base, name, "config.json") if name else os.path.join(base, "config.json")


def load_bank_config(path):
    """读库配置;**文件缺失或解析失败一律返回 {}(调用方按"引擎默认"处理)**。"""
    if not path or not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception as e:
        print(f"[castalia_config] 库配置解析失败({path}): {e!r} — 按默认处理", file=sys.stderr)
        return {}


def save_bank_config(path, data):
    """原子写库配置,覆盖前先留 <path>.bak-<YYYYmmdd-HHMMSS> 副本。

    与仓库里既有 .bak 命名一致;同秒内重复保存追加 -2/-3。返回实际写入路径。
    目录不存在会创建(新库第一次保存)。
    """
    path = os.path.abspath(path)
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    if os.path.isfile(path):
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = f"{path}.bak-{stamp}"
        n = 2
        while os.path.exists(backup):
            backup = f"{path}.bak-{stamp}-{n}"
            n += 1
        shutil.copy2(path, backup)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".bank-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)          # 原子替换:写一半断电不会毁库配置
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return path


if __name__ == "__main__":
    C = load()
    print("config:", C.source)
    print("BASE:", C.BASE)
    print("BANKS:", C.BANKS)
    print("NODE:", C.NODE)
    print("PYW:", C.PYW)
    print("实例:", [i["id"] for i in C.INSTANCES])
    for b in C.BRIDGES:
        print(f"  桥 {b['id']} :{b['port']} cwd={b['cwd']}")
    for v in C.VIZ:
        print(f"  星图 {v['id']} :{v['port']} cwd={v['cwd']}")
    print("AIRI 代理:", (C.AIRI_PROXY or {}).get("cwd"))
    print("FEDERATION:", C.FEDERATION)
