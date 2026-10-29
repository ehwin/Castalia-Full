"""
Castalia 托盘 — 各端独立记忆 + 一份联邦总图

普通端、Anima 和 Full 各用独立库。Full 只读汇总成员；
AIRI 接入层分别读取 Anima 与 Full，Anima 引擎不依赖 Full。

左键打开联邦总图。不要再单独起 airi_tray。
用法: pythonw castalia_tray.py
"""
import os
import sys
import time
import json
import socket
import ctypes
import logging
import threading
import subprocess
import webbrowser
import http.server
import service_runtime

if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

os.environ["PYTHONPATH"] = ""
sys.path = [p for p in sys.path if "hermes-agent" not in p.lower()]

# ── 配置(2026-09-15 通用化)──
# 路径/端口/实例全部来自 scripts/castalia.config.json;配置缺失时回退内置默认。
# 支持多实例:托盘/守护可用 `--instance <id>` 或环境变量 CASTALIA_INSTANCE 只加载某一端。
def _cli_instance():
    a = sys.argv[1:]
    for i, v in enumerate(a):
        if v == "--instance" and i + 1 < len(a):
            return a[i + 1]
        if v.startswith("--instance="):
            return v.split("=", 1)[1]
    return os.environ.get("CASTALIA_INSTANCE") or None


_CLI_INSTANCE = _cli_instance()

import castalia_config                      # noqa: E402
C = castalia_config.load(instance=_CLI_INSTANCE)

APP_NAME = C.APP.get("name", "Castalia 记忆体")
APP_VERSION = C.APP.get("version", "0.0.0")
APP_PUBLISHER = C.APP.get("publisher", "")
APP_DESC = C.APP.get("desc", "")
BASE = C.BASE
BANKS = C.BANKS
SCRIPTS = os.path.join(BASE, "scripts")
PYW = C.PYW            # 品牌宿主(PyInstaller onedir 薄壳):托盘/嵌入/自启入口
NODE = C.NODE          # 品牌 node 运行时副本(任务管理器里显示 CastaliaNode.exe)
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
# 2026-09-13: 从无控制台的父进程(pythonw / Hermes 孵化)spawn 时,
# 只给 CREATE_NO_WINDOW 仍会给子进程挂 conhost 窗口 → 必须叠加 DETACHED_PROCESS + stdin=DEVNULL
DETACHED = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)

WSL_DIST_HINT = "Ubuntu-24.04"
LOBEHUB_DIR = C.LOBEHUB_DIR
LOBEHUB_RUN = C.LOBEHUB_RUN
AIRI_BASE = C.AIRI_BASE
AIRI_ANIMA = C.AIRI_ANIMA
AIRI_EXE = os.path.join(AIRI_BASE, "airi.exe")
# 第三方附带服务(如 AIRI 分拣 Lemonade):同样从配置读,配置里删掉即不在菜单出现。
# 占位值(port=0/cmd=[])保证配置缺项时托盘不崩、菜单显示为关闭。
AIRI_LEMONADE = C.extra("lemonade") or {"id": "lemonade", "name": "AIRI 分拣",
                                        "port": 0, "cmd": [], "cwd": ""}
MCP_PROXY = os.path.join(LOBEHUB_RUN, "node_modules", "mcp-proxy", "dist", "bin", "mcp-proxy.mjs")

# ── 服务定义(2026-09-15 全部来自配置)──
# 想改端口/库目录/增删实例 → 编辑 scripts/castalia.config.json,不用改代码。
FEDERATION = C.FEDERATION
EMBED = C.EMBED
VIZ = C.VIZ
AIRI_PROXY = C.AIRI_PROXY
BRIDGES = C.BRIDGES
# 桌面外壳(原生窗口 GUI,castalia_shell.py)。配置里删掉 shell 段 → None → 「打开…」回浏览器。
SHELL = C.SHELL
SHELL_SCRIPT = (SHELL or {}).get("script") or os.path.join(SCRIPTS, "castalia_shell.py")
# 网页壳偏好(castalia.config.json 的 webApp 段):mode=edge → 该入口直接开 Edge 应用窗口
# (--app,无地址栏、独立任务栏图标),不收进原生外壳。留空/删段 = 旧行为。
WEBAPP = C.WEBAPP or {}

logger = logging.getLogger("castalia_tray")
logging.basicConfig(
    filename=os.path.join(SCRIPTS, "castalia-tray.log"),
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    encoding="utf-8",
)

_procs = {}
_lock = threading.Lock()
_icon = None
_stop = threading.Event()

# ══ 托盘身份 + 控制端口(2026-10-02 重构)══════════════════════════════════════
# 与外壳(castalia_shell.py, 3397)同一套做法:**端口即身份**。
#   · 启动时 bind 127.0.0.1:TRAY_PORT —— bind 是原子的:抢到就是"我是唯一的托盘",
#     抢不到 = 已有托盘在跑,本进程退化为**客户端**,把 --status/--quit/--activate
#     转发给首实例后安静退出(Chrome / VS Code / Slack 的第二实例激活逻辑)。
#   · 为什么不用命名互斥量:它只能回答"有没有人",既没法把请求送过去,也没有状态可查。
#     旧实现用 ctypes.windll.kernel32.GetLastError() 判断,而默认 windll 每次调用后会
#     **恢复** last-error → 永远读不到 183 → 判断恒为"没人" → 一天起出十几个托盘、
#     通知区留下幽灵图标,用户点"退出"点的是死实例的图标(点击根本没进活着的进程)。
#   · 顺带解决"点了没关":任何外部进程都能 `Castalia.exe castalia_tray.py --quit` 关掉托盘。
TRAY = C.TRAY or {"id": "tray", "name": "托盘", "port": 3398}
TRAY_PORT = int(TRAY.get("port") or 3398)
# ⚠️ 命名不要叫 STATE_FILE —— 本文件后面(守卫热身记录那段)已经用了 STATE_FILE=guard-state.json,
# 同名会被后定义覆盖(2026-10-02 实际踩过:期望状态被写进 guard-state.json,冲掉了守卫的热身记录)。
SERVICE_STATE_FILE = os.path.join(SCRIPTS, "service-state.json")
STATUS_FILE = os.path.join(SCRIPTS, "tray-status.json")
_control_srv = None


def write_state(desired, by=""):
    return service_runtime.update(SERVICE_STATE_FILE, desired=desired, by=by)


def read_state():
    return service_runtime.read(SERVICE_STATE_FILE)

def service_wanted(svc):
    if _stop.is_set(): return False
    # 按需服务(onDemand)：没人显式要过就不算"要跑"。
    # 旧语义是"没写 stopped 就算 wanted"，于是 AIRI 代理/本地嵌入/分拣这类辅助服务
    # 天然常驻（2026-10-28 用户要求：辅助服务按需拉起，不要随时随地都跑）。
    if svc.get('onDemand') and not service_runtime.declared(SERVICE_STATE_FILE, svc['id']):
        return False
    return service_runtime.wanted(SERVICE_STATE_FILE, svc['id'])

def set_service_desired(svc, running):
    return service_runtime.update(SERVICE_STATE_FILE, services={svc['id']: 'running' if running else 'stopped'}, by='tray-service')

def _service_lock(svc):
    return service_runtime.file_lock(os.path.join(SCRIPTS, 'service-' + svc['id'] + '.lock'), timeout=90)


def _write_status(obj):
    """命令行查询的结果落文件 —— 品牌宿主是 windowed 进程,没有控制台可以 print。"""
    try:
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    try:
        print(json.dumps(obj, ensure_ascii=False))
    except Exception:
        pass


def control_alive(port=None, timeout=0.7):
    """控制端口有人应答 = 已有托盘(与 castalia_shell._port_open 同款)。"""
    sk = socket.socket()
    sk.settimeout(timeout)
    try:
        sk.connect(("127.0.0.1", int(port or TRAY_PORT)))
        return True
    except Exception:
        return False
    finally:
        sk.close()


def control_request(method, path, port=None, timeout=8):
    """给正在跑的托盘发一条控制请求 → (status, body)。"""
    import urllib.request
    url = f"http://127.0.0.1:{int(port or TRAY_PORT)}{path}"
    try:
        req = urllib.request.Request(url, method=method.upper())
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, repr(e)


class _ControlHandler(http.server.BaseHTTPRequestHandler):
    """托盘本地控制口(仅 127.0.0.1):GET /health /status;POST /quit /activate。"""

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _local_only(self):
        """控制口只服务本机页面:挡 DNS rebinding + 跨站 CSRF(浏览器可无读权限地 POST /quit)。

        外壳控制口(castalia_shell.py)一直有同类校验,托盘这边以前漏了 —— 2026-10-17 补齐。
        CLI(--status/--quit)不带 Origin,Host 是 127.0.0.1,照常放行。
        """
        host = (self.headers.get("Host") or "").strip().lower()
        if host.startswith("["):            # [::1]:3398
            hostname = host.split("]", 1)[0] + "]"
        else:
            hostname = host.rsplit(":", 1)[0] if ":" in host else host
        if hostname not in ("127.0.0.1", "localhost", "[::1]", "::1"):
            self._json({"ok": False, "error": "仅允许本机访问"}, 403)
            return False
        origin = self.headers.get("Origin")
        if origin:
            try:
                from urllib.parse import urlsplit
                if (urlsplit(origin).hostname or "").lower() not in ("127.0.0.1", "localhost", "::1"):
                    self._json({"ok": False, "error": "拒绝跨站请求"}, 403)
                    return False
            except Exception:
                self._json({"ok": False, "error": "拒绝跨站请求"}, 403)
                return False
        if (self.headers.get("Sec-Fetch-Site") or "").lower() == "cross-site":
            self._json({"ok": False, "error": "拒绝跨站请求"}, 403)
            return False
        return True

    def do_GET(self):
        if not self._local_only():
            return
        p = self.path.split("?")[0]
        if p == "/health":
            return self._json({"ok": True, "app": APP_NAME, "version": APP_VERSION, "pid": os.getpid()})
        if p == "/status":
            try:
                title = getattr(_icon, "title", "") or ""
            except Exception:
                title = ""
            return self._json({"ok": True, "running": True, "app": APP_NAME, "version": APP_VERSION,
                               "pid": os.getpid(), "controlPort": TRAY_PORT, "title": title,
                               "icon": bool(_ICON_ALIVE),
                               "bridges": bridges_up(), "viz": viz_up(),
                               "children": {k: getattr(v, "pid", None) for k, v in _procs.items()},
                               "state": read_state(), "groups": service_groups()})
        return self._json({"ok": False, "error": f"未知路径 {p}"}, 404)

    def do_POST(self):
        if not self._local_only():
            return
        p = self.path.split("?")[0]
        # 2026-10-28: 记下**是谁**发的控制命令。17:47:22 有人优雅地 /quit 掉了托盘,
        # 25 秒后又被重新拉起,但日志只写"收到 /quit",没有任何线索能查出发起方
        # (两个 scripts 目录里没有任何脚本发它) → 这条诊断缺口先补上。
        # 只记本机回环地址 + User-Agent,不含任何请求体。
        _who = "%s ua=%s" % (self.client_address[0] if self.client_address else "?",
                             (self.headers.get("User-Agent") or "-")[:40])
        if p == "/quit":
            self._json({"ok": True, "action": "quit"})
            logger.info("control: 收到 /quit (来自 %s)", _who)
            threading.Thread(target=lambda: exit_all(_icon), daemon=True).start()
            return
        if p == "/activate":
            self._json({"ok": True, "action": "activate"})
            logger.info("control: 收到 /activate (来自 %s)", _who)
            # v1.23.2-fix: “点快捷方式”应当真的打开控制台，而不是只弹一句“托盘已在运行”。
            # 与托盘双击/默认菜单项同一路径（start_shell 内部已有单实例与宿主探测）。
            try:
                threading.Thread(target=lambda: _run_action(start_shell)(), daemon=True).start()
            except Exception:
                pass
            return
        return self._json({"ok": False, "error": f"未知路径 {p}"}, 404)


def start_control():
    """起控制端口(仅 127.0.0.1)。抢不到 = 已有托盘,调用方退化为客户端。"""
    global _control_srv
    _control_srv = http.server.ThreadingHTTPServer(("127.0.0.1", TRAY_PORT), _ControlHandler)
    threading.Thread(target=_control_srv.serve_forever, daemon=True).start()
    logger.info("control 已监听 127.0.0.1:%s", TRAY_PORT)
    return _control_srv


def _cli_verb():
    for v in sys.argv[1:]:
        if v in ("--status", "--quit", "--activate", "--stop-services"):
            return v
    return None


def _client(verb):
    """第二实例(或命令行调用):把动词转发给首实例再退出,绝不自己再起一套服务。"""
    verb = verb or "--activate"
    if verb == "--stop-services":
        verb = "--quit"
    method, path = {"--status": ("GET", "/status"), "--quit": ("POST", "/quit"),
                    "--activate": ("POST", "/activate")}[verb]
    code, body = control_request(method, path)
    logger.info("client %s -> %s %s", verb, code, body[:200].replace("\n", " "))
    if verb == "--status":
        try:
            _write_status(json.loads(body))
        except Exception:
            _write_status({"ok": False, "httpStatus": code, "raw": body})
    return 0 if code else 1


def _env_base(extra=None):
    env = dict(os.environ)
    env["PYTHONPATH"] = ""
    if extra:
        env.update(extra)
    return env


# ══ 端口/进程探测:全部进程内完成(psutil) ══════════════════════════════════
# 2026-09-13 重构:原先 tooltip 每 8 秒刷新一次、一次刷 5~6 个端口,每个端口各 spawn
# 一次 netstat.exe / tasklist.exe。本机 netstat.exe 在 pythonw 孵化时启动失败
# (0xc0000142 应用程序无法正常启动) → 错误框 + 控制台窗口无休止弹出。
# 现在统一走 psutil(Python310 已装 7.2.2)进程内调用,零子进程;仅 psutil 缺失时兜底。
try:
    import psutil as _psutil
except Exception:      # pragma: no cover - 兜底路径
    _psutil = None

_LISTEN_CACHE = {}     # port -> (bool, ts)  socket 探测结果,1 秒时效


def listening(port):
    """True if a process is LISTENING on this exact TCP port.

    8 秒定时器高频调用 → 走 socket 直连(不 spawn 子进程;也不用 psutil.net_connections,
    后者在有几百个连接时能卡十几秒)。结果缓存 1 秒,一次刷新多个端口不重复探测。
    """
    p = int(port)
    now = time.time()
    hit = _LISTEN_CACHE.get(p)
    if hit is not None and now - hit[1] < 1.0:
        return hit[0]
    ok = False
    for host in ("127.0.0.1", "::1"):
        try:
            with socket.create_connection((host, p), timeout=0.15):
                ok = True
                break
        except Exception:
            continue
    _LISTEN_CACHE[p] = (ok, now)
    return ok


def listening_pids(port):
    """该端口 LISTEN 的 pid 集合 —— 只在杀端口时用(罕见路径),这里才动 psutil 全表。"""
    if _psutil is None:
        return set()
    try:
        return {c.pid for c in _psutil.net_connections(kind="tcp")
                if c.status == _psutil.CONN_LISTEN and c.laddr
                and int(c.laddr.port) == int(port) and c.pid}
    except Exception:
        return set()


def _rotate_log(path, max_bytes=2_000_000):
    """桥日志超过 2MB 时轮转一份 .1(保留上一次崩溃现场)。"""
    try:
        if os.path.exists(path) and os.path.getsize(path) > max_bytes:
            os.replace(path, path + ".1")
    except Exception:
        pass


_open_logs = []          # 保持文件句柄引用,防 GC 关掉子进程的 stdout


def _spawn(key, cmd, cwd, extra_env=None, log_path=None):
    if _stop.is_set() or not service_runtime.wanted(SERVICE_STATE_FILE, key):
        raise RuntimeError('服务已停用，取消启动')
    stdout = stderr = subprocess.DEVNULL
    if log_path:
        # 2026-09-15: 桥的 mcp-proxy/引擎输出此前全丢 DEVNULL → 空壳桥无任何线索。
        _rotate_log(log_path)
        fh = open(log_path, "a", encoding="utf-8", errors="replace")
        _open_logs.append(fh)
        stdout, stderr = fh, subprocess.STDOUT
    p = subprocess.Popen(
        cmd, cwd=cwd, env=_env_base(extra_env),
        # 2026-09-13: 只写 CREATE_NO_WINDOW 不够 —— 从无控制台的父进程(pythonw/Hermes 孵化)
        # spawn 时 Windows 仍会给每个子进程挂一个 conhost 窗口(表现为"一直在弹窗")。
        # 三件套: CREATE_NO_WINDOW | DETACHED_PROCESS + stdin/stdout/stderr 全 DEVNULL。
        stdin=subprocess.DEVNULL,
        stdout=stdout, stderr=stderr,
        creationflags=NOWIN | DETACHED,
        close_fds=True,
    )
    _procs[key] = p
    if _stop.is_set() or not service_runtime.wanted(SERVICE_STATE_FILE, key):
        _kill_pid(p.pid)
        _procs.pop(key, None)
        raise RuntimeError('服务已停用，取消启动')
    logger.info("start %s pid=%s", key, p.pid)
    return p


def _kill_port(port):
    for pid in listening_pids(port):
        _kill_pid(pid)


def _kill_ports(ports):
    """一次枚举 TCP 表,杀掉这些端口的 LISTEN 者 —— 退出路径专用。

    2026-10-04:`_kill_port` 每个端口各调一次 psutil.net_connections(kind="tcp"),
    而那是全表枚举;7 个端口 ≈ 7 秒,导致"点退出后 6~7 秒才停完服务"。这里只扫一次。
    """
    if _psutil is None:
        for p in ports:
            _kill_port(p)
        return
    try:
        want = {int(p) for p in ports}
        victims = {c.pid for c in _psutil.net_connections(kind="tcp")
                   if c.status == _psutil.CONN_LISTEN and c.laddr and int(c.laddr.port) in want and c.pid}
    except Exception:
        return
    for pid in victims:
        _kill_pid(pid)


def _kill_pid(pid):
    if _psutil is not None:
        try:
            parent = _psutil.Process(pid)
            for child in reversed(parent.children(recursive=True)):
                try: child.kill()
                except Exception: pass
            parent.kill()
            return True
        except Exception: pass
    try:
        result = subprocess.run(['taskkill', '/f', '/t', '/pid', str(pid)],
            stdin=subprocess.DEVNULL, capture_output=True, timeout=5, creationflags=NOWIN | DETACHED)
        return result.returncode == 0
    except Exception: return False


def _kill_airi():
    """按镜像名杀 airi.exe(psutil 进程内,零子进程)。"""
    if _psutil is None:
        return
    for pid, name in _proc_names():
        if name != "airi.exe":
            continue
        try:
            _psutil.Process(pid).kill()
        except Exception:
            pass


def _notify(title, body):
    icon = _icon
    if icon is None:
        return
    try:
        icon.notify(body, title)
    except Exception as e:
        logger.error("notify failed: %s", e)


def _clipboard(text):
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $input"],
            input=text.encode("utf-8"),
            timeout=8, creationflags=NOWIN,
        )
        return True
    except Exception as e:
        logger.error("clipboard failed: %s", e)
        return False


def _bg(fn):
    threading.Thread(target=fn, daemon=True).start()


# ══ 桌面外壳(原生窗口 GUI)═════════════════════════════════════════════════
# 托盘「打开…」不再直接甩浏览器:先把页面送进外壳窗口(castalia_shell.py,pywebview/WebView2)。
# 外壳有本地控制端口 + 单实例锁 → 已在跑就导航过去(同一窗口内部切页),没跑就 --url 拉起一个。
# 回落到浏览器的两种情况:① 配置里没有 shell 段 ② 本机找不到装了 pywebview 的宿主。
_SHELL_HOST = {"host": None, "checked": False}
# v1.23.2-fix: 图标事件循环是否还活着。控制端口在、图标没了（pystray 创建窗口失败）
# 会让新实例误判“托盘已在运行”，于是用户点快捷方式永远没反应。
_ICON_ALIVE = False


def _exe_bundles_webview(exe):
    """文件系统判断 exe 里是否打包了 pywebview(品牌宿主目前只打了 tkinter → 跑不了外壳)。"""
    base = os.path.dirname(exe)
    return any(os.path.isdir(os.path.join(base, sub, "webview"))
               for sub in ("_internal", "_internal\\_internal", ""))


def _python_has_webview(exe_path):
    """文件系统判断解释器有没有装 pywebview(不跑子进程探针:windowed exe 异常会弹系统框)。"""
    root = os.path.dirname(exe_path)
    parent = os.path.dirname(root)
    cands = [os.path.join(root, "Lib", "site-packages", "webview", "__init__.py"),
             os.path.join(parent, "Lib", "site-packages", "webview", "__init__.py")]
    for ver in ("311", "310", "312", "39"):
        cands.append(os.path.join(root, "lib", f"python{ver}", "site-packages", "webview", "__init__.py"))
    return any(os.path.isfile(c) for c in cands)


def _shell_host():
    """挑一个能跑外壳的宿主:品牌 exe(打包了 pywebview)→ 系统 pythonw → 当前解释器。"""
    if _SHELL_HOST["checked"]:
        return _SHELL_HOST["host"]
    _SHELL_HOST["checked"] = True
    import glob as _glob

    cands = [PYW] if os.path.exists(PYW) else []
    for base in (os.environ.get("LOCALAPPDATA") or "", "C:\\"):
        cands += sorted(_glob.glob(os.path.join(base, "Programs", "Python", "Python3*", "pythonw.exe")),
                        reverse=True)          # 高版本优先
        cands += sorted(_glob.glob(os.path.join(base, "Python3*", "pythonw.exe")), reverse=True)
    if not getattr(sys, "frozen", False):
        cands.append(sys.executable)

    for c in cands:
        if not c or not os.path.exists(c):
            continue
        if c == PYW:
            if _exe_bundles_webview(c):
                _SHELL_HOST["host"] = c
                break
        elif _python_has_webview(c):
            _SHELL_HOST["host"] = c
            break
    logger.info("shell host = %s", _SHELL_HOST["host"])
    return _SHELL_HOST["host"]


def shell_up():
    return bool(SHELL) and listening(SHELL["port"])


def _embed(url):
    """星图页面追加 embed=1:外壳里隐藏星图自带的 rail(导航归外壳管,免得双侧栏)。"""
    if "embed=" in url:
        return url
    for v in VIZ:
        if f":{v['port']}/" in url:
            return url + ("&" if "?" in url else "?") + "embed=1"
    return url


def _viz_port():
    full = next((v for v in VIZ if v.get('instance') == 'full'), None)
    if full:
        return full['port']
    for v in VIZ:
        if listening(v["port"]):
            return v["port"]
    return VIZ[0]["port"] if VIZ else 3345


def _focus_window(hwnd):
    """把外壳窗口拉到前台并激活。

    为什么要由托盘来喊这一声:Windows 的**前台锁**(foreground lock)只允许"刚收到用户输入"的
    进程抢前台 —— 托盘点「打开…」时它正是那个进程;外壳自己喊则经常被拒(只剩任务栏闪)。
    """
    if not hwnd:
        return False
    try:
        u = ctypes.windll.user32
        # 参数按 HWND(指针宽)声明 —— ctypes 默认按 c_int 传,窗口句柄大了会被截断
        u.GetForegroundWindow.restype = ctypes.c_void_p
        u.IsIconic.argtypes = [ctypes.c_void_p]
        u.IsIconic.restype = ctypes.c_bool
        u.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
        u.BringWindowToTop.argtypes = [ctypes.c_void_p]
        u.SetForegroundWindow.argtypes = [ctypes.c_void_p]
        h = int(hwnd)
        if u.IsIconic(h):
            u.ShowWindow(h, 9)               # SW_RESTORE
        u.ShowWindow(h, 5)                   # SW_SHOW
        u.BringWindowToTop(h)
        u.SetForegroundWindow(h)
        return u.GetForegroundWindow() == h
    except Exception as e:
        logger.error("focus window: %s", e)
        return False


def _shell_send(url="", view="", port=None, tries=1, delay=0.3):
    """把导航请求发给已在跑的外壳(HTTP,127.0.0.1);成功 True,并顺手把窗口置前。"""
    port = port or (SHELL or {}).get("port")
    if not port:
        return False
    import urllib.request
    import urllib.parse
    q = urllib.parse.urlencode({k: v for k, v in (("url", url), ("view", view)) if v})
    target = f"http://127.0.0.1:{int(port)}/open" + (f"?{q}" if q else "")
    for i in range(max(1, tries)):
        try:
            with urllib.request.urlopen(target, timeout=3) as r:
                data = json.loads(r.read().decode("utf-8"))
            if data.get("ok"):
                _focus_window(data.get("hwnd"))
            return bool(data.get("ok"))
        except Exception:
            if i == max(1, tries) - 1:
                return False
            time.sleep(delay)
    return False


def open_in_shell(url="", view=""):
    """把页面送进外壳:已在跑 → 导航过去;没跑 → 拉起一个新窗口。

    False = 本机没有能跑外壳的宿主(调用方回落到浏览器)。
    """
    if not SHELL or not os.path.exists(SHELL_SCRIPT):
        return False
    port = SHELL["port"]
    if _shell_send(url, view, port, tries=1, delay=0):      # 外壳已在跑
        return True
    host = _shell_host()
    if not host:
        return False
    cmd = [host, SHELL_SCRIPT]
    if url:
        cmd += ["--url", url]
    if view:
        cmd += ["--view", view]
    try:
        subprocess.Popen(cmd, cwd=SCRIPTS, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=NOWIN | DETACHED, close_fds=True)
    except Exception as e:
        logger.error("shell start: %s", e)
        return False
    logger.info("start shell pid=? url=%s view=%s", url, view)
    # 冷启动竞态:新外壳要几百毫秒才把控制端口听上 → 重试下发一次(拿不到也无妨,它已按 --url 打开)
    if url or view:
        _shell_send(url, view, port, tries=14, delay=0.4)
    return True


def start_shell(url=None, view=""):
    if not SHELL:
        return "配置里没有外壳(shell 段)"
    if shell_up():
        # 已在跑：把窗口置前（否则从快捷方式再点一次毫无反应）
        try:
            _shell_send("", "", SHELL["port"], tries=2, delay=0.2)
        except Exception:
            pass
        return "控制台已在运行"
    if not url:
        port = _viz_port()
        v = next((x for x in VIZ if x["port"] == port), None)
        # 汇总星图(Full)的本库是空的 —— 它的数据只在 federation 视图里;
        # 默认打开 local 会得到一张 0 节点的空星图(2026-10-17 实测 3348 local = 0)。
        # 2026-10-28 修复:原来只看 v["env"]["FEDERATION_DIRS"],而它是 castalia_config 在
        # 生成进程环境时注入的、配置里根本没有这个键 → fed 恒为 False → 外壳打开的是空星图。
        # 真正的开关是 viz 条目的 "federation": true(见 castalia_config._viz)。
        _venv = v.get("env") or {}
        fed = bool(v and (v.get("federation") or str(_venv.get("FEDERATION_DIRS") or "[]") not in ("[]", "")
                          or str(_venv.get("FEDERATION_MEMBERS") or "[]") not in ("[]", "")))
        url = f"http://127.0.0.1:{port}/?scope={'federation' if fed else 'local'}&embed=1"
    # 2026-10-29:进控制台第一眼要「记忆体」(记忆总成),不是星图。
    # 星图没被删,仍在 v-viz 页签上,点一下即回;这里只改打开的落点。
    if not view:
        view = "agg"
    if open_in_shell(url, view):
        return "正在打开控制台"
    return "没有能跑外壳的宿主(缺 pywebview)"


def stop_shell():
    """关掉外壳窗口(按命令行找进程;外壳不占服务端口,所以不能按端口杀)。"""
    if _psutil is not None:
        # 2026-10-04:原来对**全表**进程取 cmdline —— 退出路径上要 5~7 秒。
        # 先按进程名筛(只可能是 python*/Castalia*),再取命令行,毫秒级。
        for pr in _psutil.process_iter(["pid", "name"]):
            try:
                nm = str(pr.info.get("name") or "").lower()
                if "python" not in nm and "castalia" not in nm:
                    continue
                if any("castalia_shell.py" in str(a) for a in (pr.cmdline() or [])):
                    pr.kill()
            except Exception:
                pass
    return "控制台已关闭"


def toggle_shell(icon=None, item=None):
    msg = stop_shell() if shell_up() else start_shell()
    _notify(APP_NAME, msg)
    _refresh_title()


# ══ 网页壳:Edge 应用窗口(--app)═══════════════════════════════════════════
# webApp.mode = edge 的入口(当前:LobeHub)不走原生外壳,直接开 Edge 的 --app 窗口 ——
# 观感是独立应用(无地址栏/标签栏、独立任务栏图标),本质仍是网页,登录态沿用默认 Edge
# 配置(所以不要另开 --user-data-dir)。同标题窗口已在跑就直接置前,不重复开。
def _edge_exe():
    if WEBAPP.get("browser") and os.path.isfile(WEBAPP["browser"]):
        return WEBAPP["browser"]
    for p in (os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
              os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
              os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe")):
        if p and os.path.isfile(p):
            return p
    return None


def _windows_titled(needle):
    """按标题找可见顶层窗口(应用窗口的标题就是页面标题)。

    排除标题里带 "Microsoft Edge" 的窗口 —— 那是普通浏览器窗口,免得把标签页当成应用窗口。
    """
    u = ctypes.windll.user32
    u.IsWindowVisible.argtypes = [ctypes.c_void_p]
    u.IsWindowVisible.restype = ctypes.c_bool
    u.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
    u.GetWindowTextLengthW.restype = ctypes.c_int
    u.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
    u.EnumWindows.argtypes = [ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p),
                              ctypes.c_void_p]
    u.EnumWindows.restype = ctypes.c_bool
    hits = []
    low = (needle or "").lower()

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def _cb(hwnd, _lparam):
        try:
            if not u.IsWindowVisible(hwnd):
                return True
            n = u.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(hwnd, buf, n + 1)
            t = (buf.value or "").lower()
            if low and low in t and "microsoft edge" not in t:
                hits.append(hwnd)
        except Exception:
            pass
        return True

    try:
        u.EnumWindows(_cb, 0)
    except Exception as e:
        logger.error("enum windows: %s", e)
    return hits


def open_web(url, needle="", only_if="edge"):
    """用网页壳打开页面。True = 已处理(开窗/置前);False = 调用方回落外壳/浏览器。"""
    if (WEBAPP.get("mode") or "").lower() != only_if:
        return False
    exe = _edge_exe()
    if not exe:
        logger.info("webapp: 找不到浏览器 exe,回落")
        return False
    if needle:
        hits = _windows_titled(needle)
        if hits:
            _focus_window(hits[0])
            logger.info("webapp: 复用已开窗口 hwnd=%s url=%s", hits[0], url)
            return True
    try:
        subprocess.Popen([exe, f"--app={url}"], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=NOWIN | DETACHED, close_fds=True)
        logger.info("webapp: 打开 %s", url)
        return True
    except Exception as e:
        logger.error("webapp: %s", e)
        return False


# ── embed ──

def embed_is_api():
    try:
        sys.path.insert(0, SCRIPTS)
        from keys_util import load_keys_enc
        secrets = load_keys_enc(
            os.path.join(BANKS, "hermes", "keys.enc"),
            os.path.join(BANKS, "hermes", "keys.key"),
        )
        return bool(secrets.get("embedding", {}).get("api_key"))
    except Exception as e:
        logger.error("embed_mode: %s", e)
        return False


def start_embed(manual=True):
    if not EMBED: return '未配置本地嵌入服务'
    if manual: set_service_desired(EMBED, True)
    with _service_lock(EMBED):
        if not service_wanted(EMBED): return '本地嵌入已停用'
        if listening(EMBED['port']): return '本地嵌入已在运行'
        _spawn(EMBED['id'], EMBED['cmd'], EMBED['cwd'])
    return '正在启动本地嵌入'


def stop_embed():
    return stop_service(EMBED) if EMBED else '未配置本地嵌入服务'


def toggle_embed(icon=None, item=None):
    _service_callback(EMBED, 'stop' if EMBED and listening(EMBED['port']) else 'start')(icon, item)


# ── viz ──

def embed_status():
    if embed_is_api(): return True, '云端 API 已配置（未验证）'
    return bool(EMBED and listening(EMBED['port'])), f"本地 :{EMBED['port']}" if EMBED else '未配置'


def embed_mark():
    return '云端已配置（未验证）' if embed_is_api() else _mark(bool(EMBED and listening(EMBED['port'])))


def group_up(items):
    # 桥必须通过引擎健康探针；星图必须通过 HTTP API；其余简单端口服务仍看监听。
    if items and items is BRIDGES:
        return sum(1 for v in items if bridge_healthy(v["port"]))
    if items and items is VIZ:
        return sum(1 for v in items if viz_status(v, timeout=1.5))
    return sum(1 for v in items if listening(v["port"]))


def _mark_n(up, total):
    """分组状态:全开=开 / 全关=关 / 部分=半 n/total(旧实现全开才显示"开",挂一个就变"关")。"""
    if total and up == total:
        return "开"
    if up == 0:
        return "关"
    return f"半 {up}/{total}"


_HTTP_CACHE = {}


def _http_probe(port, path='/api/status', timeout=0.35):
    cache_key = (int(port), path)
    now = time.monotonic()
    cached = _HTTP_CACHE.get(cache_key)
    if cached and now - cached[1] < 5:
        return cached[0]
    import urllib.request
    try:
        req = urllib.request.Request(f'http://127.0.0.1:{int(port)}{path}', method='GET')
        with urllib.request.urlopen(req, timeout=timeout) as r:
            ok = 200 <= int(r.status) < 400
    except Exception:
        ok = False
    _HTTP_CACHE[cache_key] = (ok, now)
    return ok
VIZ_PROBE_TIMEOUT = float(os.environ.get("VIZ_PROBE_TIMEOUT", "6"))


def viz_status(v, why=None, timeout=None):
    """星图活着 = 端口在听 且 /api/status 应答。

    timeout: 探测预算。判定用的调用(看护、viz_up、start_viz)走 VIZ_PROBE_TIMEOUT,
    **不要**用旧的 0.35s —— 星图冷启动要加载整库,实测 LobeHub 星图 3.3s 才应答,
    0.35s 会把"活着但慢"判成掉线,看护据此把 5 个星图全量重启(2026-10-28 实测)。
    界面/定时器这类高频且只看一眼的调用传小值(如 1.5),靠 5s 缓存摊掉开销。
    """
    port = int(v["port"])
    if not listening(port):
        if why is not None:
            why.append("端口未监听")
        return False
    budget = VIZ_PROBE_TIMEOUT if timeout is None else float(timeout)
    ok = _http_probe(port, "/api/status", timeout=budget)
    if not ok and why is not None:
        why.append(f"/api/status 在 {budget}s 内未应答")
    return ok


def viz_up():
    return all(viz_status(v) for v in VIZ)


def start_viz(manual=True, services=None):
    targets = VIZ if services is None else services
    errors = []
    if manual:
        for v in targets: set_service_desired(v, True)
    for v in targets:
        if not service_wanted(v): continue
        with _service_lock(v):
            if not service_wanted(v): continue
            if viz_status(v): continue
            _kill_port(v['port'])
            _wait_port_clear(v['port'])
            mark_started(f"viz:{v['port']}")
            try: _spawn(v['id'], v['cmd'], v['cwd'], v['env'])
            except Exception as e: errors.append(f"{v['name']}: {e}")
    if errors: raise RuntimeError('星图启动失败: ' + '; '.join(errors))
    return '星图启动请求已完成'


def stop_viz():
    for v in VIZ: set_service_desired(v, False)
    for v in VIZ: stop_service(v)
    return '星图已停用'


def toggle_viz(icon=None, item=None):
    _run_action(stop_viz if viz_up() else start_viz)


def open_page(port, path="/", view=""):
    """打开一个页面 —— 优先送进原生外壳(GUI),只有没有外壳时才回落到浏览器。"""
    def work():
        target = next((v for v in VIZ if v['port'] == port), None)
        start_viz(services=[target] if target else [])
        for _ in range(24):
            if listening(port):
                url = f"http://127.0.0.1:{port}{path}"
                if open_in_shell(_embed(url), view):
                    return
                if SHELL:
                    _notify(APP_NAME, "没有能跑外壳的宿主(缺 pywebview),已在浏览器打开")
                webbrowser.open(url)
                return
            time.sleep(0.25)
        _notify(APP_NAME, "星图未就绪，请再点一次")
    _bg(work)


def open_star(icon=None, item=None):
    open_page(_viz_port(), '/?scope=federation')


def open_fed_graph(icon=None, item=None):
    open_page(_viz_port(), '/?scope=federation')


def open_aggregate(icon=None, item=None):
    open_page(_viz_port(), '/aggregate.html', view='agg')


def open_hermes(icon=None, item=None):
    v = next((v for v in VIZ if v.get('instance') == 'hermes' or v['id'] == 'hermes'), None)
    if v: open_page(v['port'], '/?scope=local')


def open_lobehub_viz(icon=None, item=None):
    v = next((v for v in VIZ if v.get('instance') == 'lobehub' or v['id'] == 'lobehub'), None)
    if v: open_page(v['port'], '/?scope=local')


def open_airi_viz(icon=None, item=None):
    v = next((v for v in VIZ if v.get('instance') == 'airi' or v['id'] == 'airi'), None)
    if v: open_page(v['port'], '/?scope=local')


def _toggle_svc(svc):
    def callback(icon=None, item=None):
        _service_callback(svc, 'stop' if service_up(svc) else 'start')(icon, item)
    return callback

_busy_services = set()
_errors = {}
_actions_lock = threading.Lock()

def service_up(svc):
    if not svc: return False
    if svc in BRIDGES: return bridge_healthy(svc['port'])
    if svc in VIZ: return viz_status(svc)
    return listening(svc['port'])

def service_label(svc):
    if svc['id'] in _busy_services: state = '启动中'
    elif not service_wanted(svc):
        # 三态：没人表达过意图=按需（可被 ensure_on_demand/菜单拉起）；
        # 用户显式关掉=已停用（触发器也不该再由自动路径碰它）。
        declared = service_runtime.declared(SERVICE_STATE_FILE, svc['id'])
        state = '已停用' if declared else ('按需（未启动）' if svc.get('onDemand') else '已停用')
    elif service_up(svc): state = '运行中'
    elif svc['id'] in _errors or listening(svc['port']): state = '失败'
    else: state = '未运行'
    return f"{svc['name']}  {state}  :{svc['port']}"

def service_groups():
    def desired_of(svc):
        if service_wanted(svc): return 'running'
        if not service_runtime.declared(SERVICE_STATE_FILE, svc['id']) and svc.get('onDemand'):
            return 'on-demand'
        return 'stopped'
    return [{'kind': name, 'items': [{'id': svc['id'], 'name': svc['name'], 'port': svc['port'],
        'up': service_up(svc), 'desired': desired_of(svc), 'onDemand': bool(svc.get('onDemand')),
        'status': service_label(svc)} for svc in group if svc]}
        for name, group in [('桥', BRIDGES), ('星图', VIZ), ('其它', [AIRI_PROXY, EMBED] + C.EXTRAS)]]

def ensure_on_demand(svc, reason=''):
    """按需拉起：只有"用到它"时才起，并把意图写进 state（否则重启/guard 会漏）。

    与 start_service 的区别：会先显式声明 desired=running（因为 onDemand 服务
    在没人声明前不算 wanted），失败只记日志不抛 —— 触发点是打开页面这类前台动作，
    辅助服务起不来不该挡住主流程。
    """
    if not svc: return '未配置'
    if service_up(svc): return '已在运行'
    try:
        set_service_desired(svc, True)
        out = start_service(svc, manual=False)
        logger.info('按需拉起 %s（原因：%s）→ %s', svc['id'], reason or '未记录', out)
        return out
    except Exception as e:
        logger.warning('按需拉起 %s 失败（原因：%s）：%r', svc['id'], reason or '未记录', e)
        return f'拉起失败: {e}'

def stop_service(svc, manual=True):
    if manual: set_service_desired(svc, False)
    with _service_lock(svc):
        _kill_port(svc['port'])
        proc = _procs.pop(svc['id'], None)
        if proc and proc.poll() is None: _kill_pid(proc.pid)
        _HEALTH_CACHE.pop(int(svc['port']), None)
        _HTTP_CACHE.clear()
    return f"{svc['name']}已停用"

def start_service(svc, manual=True):
    if manual: set_service_desired(svc, True)
    if svc in BRIDGES:
        if not _rebuild_bridge(svc): raise RuntimeError(f"{svc['name']}启动失败或已取消")
    elif svc in VIZ: return start_viz(manual=False, services=[svc])
    elif svc is EMBED: return start_embed(manual=False)
    else:
        with _service_lock(svc):
            if not service_wanted(svc): return '启动已取消'
            if not service_up(svc): _spawn(svc['id'], svc['cmd'], svc['cwd'], svc.get('env'))
    return f"{svc['name']}启动请求已完成"

def _run_action(fn):
    def work():
        try: msg = fn()
        except Exception as e:
            msg = f'操作失败: {e}'
            logger.exception('service action')
        if msg: _notify(APP_NAME, msg)
        _refresh_title()
    _bg(work)

def _service_callback(svc, action):
    def callback(icon=None, item=None):
        if not svc: return
        if action == 'stop':
            set_service_desired(svc, False)
            _run_action(lambda: stop_service(svc))
            return
        with _actions_lock:
            if svc['id'] in _busy_services: return
            _busy_services.add(svc['id'])
            set_service_desired(svc, True)
        def work():
            try:
                if action == 'restart': stop_service(svc, manual=False)
                if not service_wanted(svc): return '启动已取消'
                _errors.pop(svc['id'], None)
                return start_service(svc, manual=False)
            except Exception as e:
                _errors[svc['id']] = str(e)
                raise
            finally:
                with _actions_lock: _busy_services.discard(svc['id'])
        _run_action(work)
    return callback


_PROC_CACHE = {"t": 0.0, "list": []}


def _proc_names(ttl=2.0):
    """[(pid, 小写镜像名)] —— 单次快照 + 2 秒缓存。

    注意:不要逐个 psutil.Process(pid).name() —— Windows 上碰上受保护进程会卡住,
    8 秒定时器会被拖死。process_iter 一次快照 + ad_value=None 吞掉 AccessDenied。
    """
    now = time.time()
    if _PROC_CACHE["list"] and now - _PROC_CACHE["t"] < ttl:
        return _PROC_CACHE["list"]
    out = []
    if _psutil is not None:
        try:
            for p in _psutil.process_iter(["pid", "name"], ad_value=None):
                nm = p.info.get("name")
                if nm:
                    out.append((p.info["pid"], nm.lower()))
        except Exception:
            out = _PROC_CACHE["list"]
    _PROC_CACHE.update(t=now, list=out)
    return out


def airi_running():
    """airi.exe 是否在跑 —— psutil 进程内查询,不再 spawn tasklist。"""
    if _psutil is not None:
        return any(name == "airi.exe" for _, name in _proc_names())
    return False


def start_airi_app():
    if not AIRI_PROXY: return '未配置 AIRI'
    set_service_desired(AIRI_PROXY, True)
    if AIRI_LEMONADE['cmd']: set_service_desired(AIRI_LEMONADE, True)
    if not listening(AIRI_PROXY["port"]):
        try:
            _spawn(AIRI_PROXY["id"], AIRI_PROXY["cmd"], AIRI_PROXY["cwd"], AIRI_PROXY.get("env"))
        except Exception as e:
            logger.error("airi proxy: %s", e)
    if AIRI_LEMONADE["cmd"] and not listening(AIRI_LEMONADE["port"]):
        try:
            _spawn(AIRI_LEMONADE["id"], AIRI_LEMONADE["cmd"], AIRI_LEMONADE["cwd"])
        except Exception as e:
            logger.error("lemonade: %s", e)
    if airi_running():
        return "AIRI 已在运行"
    try:
        env = _env_base(AIRI_PROXY.get("env"))
        subprocess.Popen(
            [AIRI_EXE], cwd=AIRI_BASE, env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=NOWIN | DETACHED,
        )
        logger.info("start airi.exe")
        return "正在启动 AIRI"
    except Exception as e:
        logger.error("airi.exe: %s", e)
        return f"AIRI 启动失败: {e}"


def stop_airi_app():
    if not AIRI_PROXY: return '未配置 AIRI'
    set_service_desired(AIRI_PROXY, False)
    if AIRI_LEMONADE['cmd']: set_service_desired(AIRI_LEMONADE, False)
    _kill_airi()
    _kill_port(AIRI_PROXY["port"])
    if AIRI_LEMONADE["port"]:
        _kill_port(AIRI_LEMONADE["port"])
    _procs.pop(AIRI_PROXY["id"], None)
    _procs.pop(AIRI_LEMONADE["id"], None)
    return "AIRI 已停止"


def open_airi(icon=None, item=None):
    def work():
        msg = start_airi_app()
        _notify(APP_NAME, msg)
        _refresh_title()
    _bg(work)


def toggle_airi(icon=None, item=None):
    def work():
        msg = stop_airi_app() if airi_running() else start_airi_app()
        _notify(APP_NAME, msg)
        _refresh_title()
    _bg(work)


def open_admin(icon=None, item=None):
    if not AIRI_PROXY: return
    set_service_desired(AIRI_PROXY, True)
    def work():
        if not listening(AIRI_PROXY["port"]):
            # 只起代理(admin 页由代理提供) —— 旧实现调 start_airi_app() 会把 airi.exe 也拉起来
            try:
                _spawn(AIRI_PROXY["id"], AIRI_PROXY["cmd"], AIRI_PROXY["cwd"], AIRI_PROXY.get("env"))
            except Exception as e:
                logger.error("airi proxy: %s", e)
        for _ in range(24):
            if listening(AIRI_PROXY["port"]):
                url = f"http://127.0.0.1:{AIRI_PROXY['port']}/admin"
                if not open_in_shell(url):
                    webbrowser.open(url)
                return
            time.sleep(0.25)
        _notify(APP_NAME, "AIRI 代理未就绪")
    _bg(work)


# ── bridges ──

def bridges_up():
    return all(bridge_healthy(b["port"]) for b in BRIDGES)


_HEALTH_CACHE = {}       # port -> (healthy, ts)
_HEALTH_TTL = 5.0


def _bridge_probe(port, why=None):
    """实探一次:端口在听 且 桥进程下游存在 node 引擎子进程。

    why: 可选的 list,判定不健康时写入原因(2026-10-28 加)。
    以前看护只记"不健康",不记判据 —— 2026-10-28 一天里 hermes-bridge 被判不健康
    22 次、按日志反查不出原因,只能靠事后翻桥日志猜。原因要当场落下来。
    """
    def _say(msg):
        if why is not None:
            why.append(msg)
    if not listening(port):
        _say("端口未监听")
        return False
    if _psutil is None:
        # 无 psutil 兜底:只能信端口(保持原行为)
        return True
    try:
        pids = listening_pids(port)
        if not pids:
            _say("端口在听但取不到监听 pid")
            return False
        seen = []
        for pid in pids:
            proc = _psutil.Process(pid)
            for child in proc.children(recursive=True):
                # 2026-09-15: 运行时已品牌化为 CastaliaNode.exe —— 改为"名字含 node",
                # 否则改名后判定恒为不健康 → guard 会反复误重建桥。
                cn = (child.name() or "").lower()
                if cn.endswith(".exe") and "node" in cn:
                    return True
                seen.append(f"{child.pid}:{child.name()}")
        _say(f"端口在听(pid={sorted(pids)}) 但下游无 node 引擎子进程,子进程=[{','.join(seen) or '无'}]")
        return False
    except Exception as e:
        # 探测异常不误杀,当健康处理
        _say(f"探测异常按健康处理: {e!r}")
        return True


STATE_FILE = os.path.join(SCRIPTS, "guard-state.json")


def mark_started(key):
    """记录"某组件刚被我们拉起"的时间戳(供守护的启动宽限期)。

    守护是短命进程(计划任务每 2 分钟一次),内存不跨轮 → 必须落文件。
    只记"我们自己拉起的",用来区分"刚拉起还在热身"与"真掉线"。
    """
    try:
        st = {}
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                st = json.load(f) or {}
        st.setdefault("started", {})[key] = time.time()
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(st, f, ensure_ascii=False)
    except Exception:
        pass


def started_recently(key, grace):
    """该组件是否在 grace 秒内被我们拉起过(启动宽限期判定)"""
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            st = json.load(f) or {}
        ts = (st.get("started") or {}).get(key)
        return bool(ts) and (time.time() - float(ts)) < float(grace)
    except Exception:
        return False


def bridge_healthy(port, force=False, why=None):
    """桥健康 = 端口在听 且 引擎子进程存在。

    2026-09-14 空壳桥事故: mcp-proxy 的引擎子进程退出后不会自动重启,
    端口仍在听 → 只看端口就会跳过 → 工具调用全部 -32603 Not connected。
    2026-09-15: 结果加 60s 缓存 —— psutil 全表扫描不能进 8 秒刷新定时器。
    """
    p = int(port)
    now = time.time()
    if not listening(p):
        if why is not None:
            why.append("端口未监听")
        _HEALTH_CACHE[p] = (False, now)
        return False
    if not force:
        hit = _HEALTH_CACHE.get(p)
        if hit is not None and now - hit[1] < _HEALTH_TTL:
            if why is not None and not hit[0]:
                why.append("命中 60s 健康缓存")
            return hit[0]
    ok = _bridge_probe(p, why)
    _HEALTH_CACHE[p] = (ok, now)
    return ok


def _bridge_log_path(b):
    return os.path.join(SCRIPTS, f"bridge-{b['id']}.log")


def _wait_port_clear(port, timeout=3.0):
    """等待旧监听者真正释放端口，避免 kill 后立即 spawn 的 EADDRINUSE 竞态。"""
    deadline = time.time() + max(0.0, float(timeout))
    while time.time() < deadline:
        if not listening(port):
            return True
        time.sleep(0.1)
    return not listening(port)


def _rebuild_bridge(b, attempts=3, wait_s=25):
    with _service_lock(b):
        if not service_wanted(b): return False
        if bridge_healthy(b['port'], force=True): return True
        return _rebuild_bridge_locked(b, attempts, wait_s)

def _rebuild_bridge_locked(b, attempts=3, wait_s=25):
    """清场 → spawn → **复验引擎就绪**;不就绪则重试。

    2026-09-15 根因: 旧 start_bridge 拉完就走、从不看结果,开机自启时系统 IO
    峰值下引擎握手慢于 mcp-proxy 的 connectionTimeout → Not connected 且不重试,
    空壳桥静默存在数小时。现在拉完必须复验,失败重试。
    """
    p = int(b["port"])
    mark_started(f"bridge:{b['id']}")
    for i in range(1, attempts + 1):
        if not service_wanted(b): return False
        _kill_port(p)
        if not _wait_port_clear(p, timeout=3.0):
            logger.warning("bridge %s port %s still busy after cleanup; skip spawn attempt %s", b["id"], p, i)
            continue
        try:
            with _lock:
                _spawn(b["id"], b["cmd"], b["cwd"], b["env"], log_path=_bridge_log_path(b))
        except Exception as e:
            logger.error("bridge %s spawn: %s", b["id"], e)
            return False
        deadline = time.time() + wait_s
        while time.time() < deadline:
            if not service_wanted(b):
                _kill_port(p)
                return False
            _stop.wait(0.5)
            if _bridge_probe(p):
                logger.info("bridge %s ready (attempt %s)", b["id"], i)
                _HEALTH_CACHE[p] = (True, time.time())
                return True
        logger.warning("bridge %s 引擎未就绪,重试 %s/%s", b["id"], i, attempts)
    _HEALTH_CACHE[p] = (False, time.time())
    logger.error("bridge %s 重建失败(已试 %s 次)", b["id"], attempts)
    return False


def start_bridge(manual=True):
    failures = []
    if manual:
        for b in BRIDGES: set_service_desired(b, True)
    for b in BRIDGES:
        if not service_wanted(b): continue
        if not _rebuild_bridge(b): failures.append(b['name'])
    return '记忆桥启动失败或已取消: ' + ', '.join(failures) if failures else '记忆桥已就绪'


def stop_bridge():
    for b in BRIDGES: set_service_desired(b, False)
    for b in BRIDGES: stop_service(b)
    return '记忆桥已停用'


def toggle_bridge(icon=None, item=None):
    _run_action(stop_bridge if bridges_up() else start_bridge)


# ── LobeHub docker ──

def _dec_bytes(b):
    """解码子进程输出:wsl.exe 有时吐 UTF-16LE,用 UTF-8 解码会炸 UnicodeDecodeError
    (2026-09-19 实测:托盘菜单「启动 LobeHub」因此一直崩,表现为点了没反应)。"""
    b = b or b""
    if b[:2] in (b"\xff\xfe", b"\xfe\xff") or b.count(b"\x00") > max(1, len(b) // 4):
        try:
            return b.decode("utf-16-le", errors="replace").replace("\x00", "")
        except Exception:
            pass
    return b.decode("utf-8", errors="replace")


def _wsl(cmd, timeout=180):
    try:
        r = subprocess.run(
            ["wsl", "-u", "root", "-e", "bash", "-c", cmd],
            capture_output=True, timeout=timeout,
            creationflags=NOWIN,
        )
        return _dec_bytes(r.stdout) + _dec_bytes(r.stderr)
    except Exception as e:
        return f"wsl error: {e}"


_lh_cache = {"t": 0.0, "up": False}


def _lh_dir_wsl():
    """compose 目录在 WSL 内的路径 —— 由配置 paths.lobehubDir 推导(默认 D:/AI/lobehub)。

    2026-10-01:原来三处硬编码 /mnt/d/AI/lobehub,换机换盘就会失效。
    """
    d = (getattr(C, "LOBEHUB_DIR", "") or "D:/AI/lobehub").replace("\\", "/")
    if len(d) > 2 and d[1] == ":":
        return "/mnt/%s%s" % (d[0].lower(), d[2:])
    return d


def autostart_lobehub():
    """托盘启动时按配置把 LobeHub 栈拉起(2026-10-01 接上托盘)。

    延迟 delaySeconds 秒(默认 45,避开开机 IO 峰值),已在线则跳过。
    配置:castalia.config.json 的 lobehub.autoStart。
    """
    def work():
        boot = getattr(C, "LOBEHUB_BOOT", {}) or {}
        delay = float(boot.get("delaySeconds", 45))
        if not boot.get("autoStart"):
            logger.info("lobehub autostart: 配置关闭,跳过")
            return
        time.sleep(max(0.0, delay))
        if lobehub_up():
            logger.info("lobehub autostart: 已在线,跳过(等待 %.0fs 后复查)", delay)
            return
        logger.info("lobehub autostart: 未在线,开始拉起(延迟 %.0fs)", delay)
        start_lobehub()
    _bg(work)


def lobehub_up():
    """LobeHub 可用状态：容器可能运行但 Windows 端口不可达，不能显示为开。"""
    now = time.time()
    if now - _lh_cache["t"] < 5:
        return _lh_cache["up"]
    up = listening(3210) and _http_probe(3210, '/', timeout=0.5)
    _lh_cache["t"] = now
    _lh_cache["up"] = up
    return up


def _docker_ready():
    """docker 守护是否活着 —— 守护没起时 compose 会直接失败,必须先判。"""
    out = _wsl("docker info --format '{{.ServerVersion}}' 2>&1", timeout=30)
    return ("Cannot connect" not in out) and ("error" not in out.lower())


def _first_err(out):
    for l in out.split("\n"):
        ll = l.lower()
        if ("error" in ll) or ("denied" in ll) or ("failed" in ll) or ("already in use" in ll):
            return l.strip()[:140]
    return ""


def start_lobehub(icon=None, item=None):
    def work():
        _notify(APP_NAME, "正在启动 LobeHub…")
        _wsl("service docker start 2>/dev/null; true", timeout=180)
        if not _docker_ready():
            logger.error("lobehub: docker daemon 未就绪")
            _notify(APP_NAME, "LobeHub 启动失败: docker 守护未就绪(service docker start 失败)")
            _refresh_title()
            return
        out = _wsl("cd %s && docker compose up -d 2>&1" % _lh_dir_wsl(), timeout=420)
        logger.info("lobehub up: %s", out[-400:])
        _lh_cache["t"] = 0
        # 2026-09-14 修:旧实现无论成败都弹"已启动" → 用户感觉"选项无效"。现在**复验**后再报。
        if not lobehub_up():
            _notify(APP_NAME, "LobeHub 启动失败: " + (_first_err(out) or "容器未就绪,见日志"))
            _refresh_title()
            return
        # 2026-09-26 加:容器起来 ≠ Windows 打得开。WSL 镜像网络挂掉时(端口范围被改宽的已知
        # 坑:WSL 报 CreateInstance/CreateVm/ConfigureNetworking/0x8007054f → 回退 networkingMode
        # None → 没网卡没路由),容器内部 3210 正常但 Windows 连不上,表现为"启动失败"。
        # 这里分两段判定,别再把网络问题报成启动失败。
        for _ in range(60):
            if listening(3210):
                _notify(APP_NAME, "LobeHub 已启动  http://localhost:3210")
                _refresh_title()
                return
            time.sleep(0.5)
        logger.error("lobehub: 容器在跑但 Windows 连不上 :3210(WSL 网络未就绪)")
        _notify(APP_NAME, "LobeHub 容器已起,但 Windows 连不上 :3210 — WSL 网络未就绪(日志见 castalia-tray.log)")
        _refresh_title()
    _bg(work)


def stop_lobehub(icon=None, item=None):
    def work():
        _notify(APP_NAME, "正在停止 LobeHub…")
        out = _wsl("cd %s && docker compose down 2>&1" % _lh_dir_wsl(), timeout=300)
        logger.info("lobehub down: %s", out[-300:])
        _lh_cache["t"] = 0
        if lobehub_up():
            _notify(APP_NAME, "LobeHub 停止失败: " + (_first_err(out) or "容器仍在运行"))
        else:
            _notify(APP_NAME, "LobeHub 已停止")
        _refresh_title()
    _bg(work)


def open_lobehub(icon=None, item=None):
    def work():
        if not lobehub_up():
            start_lobehub()
            for _ in range(40):
                if lobehub_up():
                    break
                time.sleep(0.5)
        url = "http://localhost:3210"
        # 2026-09-26:走网页壳(webApp.mode=edge → Edge 应用窗口),不再丢进原生外壳 GUI。
        if WEBAPP.get('mode') == 'browser':
            webbrowser.open(url)
            return
        if not open_web(url, "LobeHub") and not open_in_shell(url):
            webbrowser.open(url)
    _bg(work)


# ── status ──

def _mark(ok):
    return "开" if ok else "关"


def status_text():
    e_ok, e_where = embed_status()
    lines = [
        f"嵌入     {('配置' if embed_is_api() else _mark(e_ok))}   {e_where}"
        + ("   (API 模式;本地 11436 为降级备用,不跑也正常)" if embed_is_api() else ""),
        f"星图     {_mark_n(group_up(VIZ), len(VIZ))}   " + "  ".join(f"{v['name'].replace(' 星图', '')} :{v['port']} {_mark(viz_status(v, timeout=1.5))}" for v in VIZ),
        f"控制台   {_mark(shell_up())}   "
        + (f":{SHELL['port']}   原生窗口 GUI(「打开…」的落地窗口)" if SHELL else "未启用(配置里没有 shell 段 → 走浏览器)"),
        f"记忆桥   {_mark_n(group_up(BRIDGES), len(BRIDGES))}   "
        + " / ".join(
            f"{b.get('name') or b['id']} :{b['port']}" + ("" if bridge_healthy(b["port"]) else "(关/不健康)")
            for b in BRIDGES),
        (f"AIRI 代理 {_mark(listening(AIRI_PROXY['port']))}   :{AIRI_PROXY['port']}   admin → http://127.0.0.1:{AIRI_PROXY['port']}/admin" if AIRI_PROXY else 'AIRI 代理 未配置'),
        f"分拣     {_mark(listening(AIRI_LEMONADE['port']))}   :{AIRI_LEMONADE['port']}",
        f"AIRI     {_mark(airi_running())}   airi.exe",
        f"LobeHub  {_mark(lobehub_up())}   :3210 (docker" + ("" if _docker_ready() else "; 守护未起!")
        + ("" if (not lobehub_up() or listening(3210)) else "; 容器在跑但 Windows 连不上 → WSL 网络问题")
        + ")",
    ]
    return "\n".join(lines)


def copy_status(icon=None, item=None):
    text = status_text()
    if _clipboard(text):
        _notify(APP_NAME, "状态已复制")
    else:
        _notify(APP_NAME, text)


def endpoint_menu_items(services):
    import pystray
    def make(svc):
        return pystray.MenuItem(lambda item: service_label(svc), pystray.Menu(
            pystray.MenuItem('启动', _service_callback(svc, 'start'), enabled=lambda item: svc['id'] not in _busy_services),
            pystray.MenuItem('停止并停用守护', _service_callback(svc, 'stop')),
            pystray.MenuItem('重启', _service_callback(svc, 'restart'), enabled=lambda item: svc['id'] not in _busy_services)))
    return [make(svc) for svc in services if svc and svc.get('cmd')]


_SETTINGS_HOST = {"host": None}


def _exe_bundles_tkinter(exe):
    """纯文件系统判断 exe 里有没有打包 tkinter(PyInstaller onedir 放在 _internal/ 下)。

    为什么不跑探针:PyInstaller 的 windowed exe 遇到未捕获异常会弹**系统错误对话框**,
    调用方捕获 stdout 也拦不住 —— 探测本身成了噪音来源。文件检查零副作用。
    """
    base = os.path.dirname(exe)
    return any(os.path.isdir(os.path.join(base, sub, "tkinter"))
               for sub in ("_internal", "_internal\\_internal", ""))


def _python_has_tkinter(exe_path):
    """纯文件系统判断某解释器是否带 tkinter(标准库目录里有没有 tkinter 包)。"""
    root = os.path.dirname(exe_path)          # ...\Python310
    parent = os.path.dirname(root)            # ...\Programs\Python
    cands = [os.path.join(root, "Lib", "tkinter", "__init__.py"),
             os.path.join(parent, "Lib", "tkinter", "__init__.py")]
    for ver in ("311", "310", "312", "39"):
        cands.append(os.path.join(root, "lib", f"python{ver}", "tkinter", "__init__.py"))
    return any(os.path.isfile(c) for c in cands)


def _tk_host():
    """挑一个**带 tkinter** 的宿主来跑设置窗口(只做文件检查,不跑子进程)。

    顺序:品牌 exe(打包含 tkinter 时最佳)→ 系统 pythonw(常见安装位置)→ 当前解释器。
    全程不读子进程输出 → 不会再有任何弹框噪音。
    """
    if _SETTINGS_HOST["host"]:
        return _SETTINGS_HOST["host"]
    import glob as _glob

    cands = [PYW] if os.path.exists(PYW) else []
    for base in (os.environ.get("LOCALAPPDATA") or "", "C:\\"):
        cands += sorted(_glob.glob(os.path.join(base, "Programs", "Python", "Python3*", "pythonw.exe")),
                        reverse=True)          # 高版本优先
        cands += sorted(_glob.glob(os.path.join(base, "Python3*", "pythonw.exe")), reverse=True)
    cands.append(sys.executable)

    for c in cands:
        if not c or not os.path.exists(c):
            continue
        if c == PYW:
            if _exe_bundles_tkinter(c):
                _SETTINGS_HOST["host"] = c
                logger.info("settings: host = %s (bundled tkinter)", c)
                return c
        elif c == sys.executable or _python_has_tkinter(c):
            _SETTINGS_HOST["host"] = c
            logger.info("settings: host = %s", c)
            return c

    _SETTINGS_HOST["host"] = sys.executable
    logger.warning("settings: 未找到带 tkinter 的宿主,回退当前解释器")
    return sys.executable


def open_settings(icon=None, item=None):
    """打开设置窗口(2026-09-16)。

    以**独立进程**启动 tkinter 窗口:tkinter 有自己的主线程,不和托盘的 pystray
    事件循环抢线程;窗口崩溃也拖不垮托盘。宿主用 _tk_host() 挑(谁有 tkinter 用谁)。
    """
    script = os.path.join(SCRIPTS, "castalia_settings.py")
    if not os.path.exists(script):
        _notify(APP_NAME, "找不到设置脚本 castalia_settings.py")
        return
    host = _tk_host()
    try:
        subprocess.Popen([host, script], cwd=SCRIPTS,
                         creationflags=NOWIN | DETACHED,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        logger.info("settings: opened via %s", host)
    except Exception as e:
        logger.error("settings: %r", e)
        _notify(APP_NAME, f"设置窗口启动失败: {e}")


def open_logs(icon=None, item=None):
    subprocess.Popen(["explorer", SCRIPTS], creationflags=NOWIN)


# ── 记忆维护(2026-10-28)─────────────────────────────────────────────────
# 这一轮给记忆栈加了「句级片段索引 / 注入评测 / 坏向量修复 / 嵌入自检」,原先只能手敲
# CastaliaNode.exe 才用得上。统一收进 Castalia-Anima/scripts/memory_maintenance.mjs 一个入口,
# 托盘只负责在后台跑它:最后一行 RESULT 弹窗+通知,完整输出进 castalia-tray.log。
MAINT_SCRIPT = os.path.join(AIRI_ANIMA, "scripts", "memory_maintenance.mjs")
MAINT_BANK = "airi"


def run_maintenance(cmd, label, confirm=None):
    """后台跑记忆维护命令 —— 不阻塞托盘事件循环;危险动作先弹确认框。"""
    def _job():
        try:
            import ctypes
            if confirm and ctypes.windll.user32.MessageBoxW(0, confirm, f"{APP_NAME} · {label}", 0x44) != 6:
                logger.info("维护 %s: 用户取消", cmd)
                return
            if not os.path.exists(MAINT_SCRIPT):
                _notify(APP_NAME, f"缺少维护脚本: {MAINT_SCRIPT}")
                return
            t0 = time.time()
            proc = subprocess.run([NODE, MAINT_SCRIPT, cmd, MAINT_BANK, MAINT_BANK],
                                  capture_output=True, text=True, timeout=1800,
                                  creationflags=NOWIN, stdin=subprocess.DEVNULL)
            out = (proc.stdout or "") + (proc.stderr or "")
            lines = [l.rstrip() for l in out.splitlines() if l.strip() and not l.startswith("[config]")]
            result = next((l[len("RESULT:"):].strip() for l in reversed(lines) if l.startswith("RESULT:")), None)
            if result is None:
                result = lines[-1] if lines else f"无输出 (exit={proc.returncode})"
            logger.info("维护 %s → %s（%.1fs）", cmd, result, time.time() - t0)
            for l in lines[-14:]:
                logger.info("  %s", l)
            _notify(label, result)
            ctypes.windll.user32.MessageBoxW(0, (result + "\n\n" + "\n".join(lines[-10:]))[:1800],
                                             f"{APP_NAME} · {label}", 0x40)
        except subprocess.TimeoutExpired:
            logger.error("维护 %s 超时", cmd)
            _notify(label, "超时（30 分钟）")
        except Exception as e:
            logger.error("维护 %s 失败: %r", cmd, e)
            _notify(label, f"失败: {e}")
    _bg(_job)


def open_ledger(icon=None, item=None):
    for p in (os.path.join(BASE, "..", "FUSION-老部署-20261028.md"), "D:/AI/castalia/FUSION-老部署-20261028.md"):
        if os.path.exists(p):
            try:
                os.startfile(p)
                return
            except Exception as e:
                logger.error("ledger open failed: %r", e)
    _notify(APP_NAME, "找不到维护台账 FUSION-老部署-20261028.md")


def _about_text():
    """关于对话框正文 —— 版本 + 实时组件状态 + 路径(大厂式信息面)。"""
    def st(fn):
        try:
            return fn()
        except Exception:
            return False
    return (
        f"{APP_NAME}  {APP_VERSION}\n"
        f"{APP_DESC}\n\n"
        f"记忆桥   {_mark_n(group_up(BRIDGES), len(BRIDGES))}        星图   {_mark_n(group_up(VIZ), len(VIZ))}\n"
        f"嵌入     {_mark(st(lambda: embed_status()[0]))}         AIRI   {_mark(st(airi_running))}"
        f"         LobeHub   {_mark(st(lobehub_up))}\n\n"
        f"活库目录   {BANKS}\n"
        f"实例目录   {BASE}\n"
        f"日志文件   {os.path.join(SCRIPTS, 'castalia-tray.log')}\n\n"
        f"看护方式   Windows 计划任务「Castalia 记忆守护」每 2 分钟巡检自愈\n\n"
        f"© 2026 {APP_PUBLISHER}"
    )


def show_about(icon=None, item=None):
    """关于对话框 —— 原生 Windows 弹窗(放后台线程,不阻塞托盘菜单)。"""
    def _box():
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, _about_text(), f"关于 {APP_NAME}", 0x40)
        except Exception as e:
            logger.error("about failed: %r", e)
    _bg(_box)


# ── 开机启动(2026-09-15)──
# 用 HKCU\...\Run 键 —— 开源托盘程序的主流做法(PowerTray / server-start / Trayffeine
# 都这么做):注册表是唯一事实源、无需管理员、任务管理器的"启动"页可见、取消勾选即干净删除。
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_VALUE = "Castalia 记忆体"


def _autostart_cmd():
    """开机启动执行的命令行:品牌宿主 + 托盘脚本。"""
    exe = sys.executable if getattr(sys, "frozen", False) else PYW
    return f'"{exe}" "{os.path.join(SCRIPTS, "castalia_tray.py")}"'


def autostart_on():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            winreg.QueryValueEx(k, RUN_VALUE)
            return True
    except FileNotFoundError:
        return False
    except Exception:
        return False


def toggle_autostart(icon=None, item=None):
    """开机启动开关(写/删 HKCU Run 键)。

    注:核心服务(记忆桥)由计划任务「Castalia 记忆守护」保证自启,与本开关无关
    —— 本开关只决定这个**托盘界面**是否随登录出现。被外部(任务管理器/regedit)
    改动时,菜单勾选状态会跟随注册表实际值。
    """
    try:
        import winreg
        if autostart_on():
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
                winreg.DeleteValue(k, RUN_VALUE)
            _notify(APP_NAME, "已关闭开机启动(记忆服务仍由计划任务守护)")
        else:
            cmd = _autostart_cmd()
            with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
                winreg.SetValueEx(k, RUN_VALUE, 0, winreg.REG_SZ, cmd)
            logger.info("autostart on: %s", cmd)
            _notify(APP_NAME, "已开启开机启动" if autostart_on() else "开启失败,见日志")
    except Exception as e:
        logger.error("autostart toggle: %r", e)
        _notify(APP_NAME, f"操作失败: {e}")
    _refresh_title()


def tooltip():
    """托盘悬停提示 —— 品牌行 + 关键状态(2026-09-15 品牌化)。

    Windows 通知区的 tooltip 对多行支持不稳,故保持单行但结构清晰。
    """
    return (
        f"{APP_NAME} {APP_VERSION} — "
        f"记忆桥 {_mark_n(group_up(BRIDGES), len(BRIDGES))} · "
        f"星图 {_mark_n(group_up(VIZ), len(VIZ))} · "
        f"嵌入 {embed_mark()} · "
        f"AIRI {_mark(airi_running())}"
    )


def _refresh_title():
    if _icon is not None:
        try:
            _icon.title = tooltip()
            _icon.update_menu()
        except Exception:
            pass


_GUARD_TS = [0.0]
GUARD_INTERVAL = 60


def _heal_bridges(bad):
    """重建不健康的桥。桥一重建,LobeHub 缓存的 MCP 会话即失效(-32001),
    所以顺手重启 lobe 容器让它重新握手(2026-09-15)。"""
    for b in bad:
        logger.warning("guard: 重建桥 %s", b["id"])
        _rebuild_bridge(b)
    if lobehub_up():
        out = _wsl("cd %s && docker compose restart lobe 2>&1" % _lh_dir_wsl(), timeout=240)
        logger.info("guard: restart lobe -> %s", out[-200:].replace("\n", " "))
        _lh_cache["t"] = 0
        _notify(APP_NAME, "记忆桥异常:已自动重建,并重启了 LobeHub")
    else:
        _notify(APP_NAME, "记忆桥异常:已自动重建")
    _refresh_title()


def bridge_guard():
    """每 60s 巡检桥;发现空壳桥(端口在听但引擎已死)立即自愈。"""
    now = time.time()
    if now - _GUARD_TS[0] < GUARD_INTERVAL:
        return
    _GUARD_TS[0] = now
    bad = [b for b in BRIDGES if not bridge_healthy(b["port"], force=True)]
    if bad:
        logger.warning("guard: 桥不健康 %s", [b["id"] for b in bad])
        _bg(lambda: _heal_bridges(bad))


def _title_loop():
    while not _stop.wait(8):
        _refresh_title()
        # 2026-09-15: 桥巡检已交给 Windows 计划任务(scripts/castalia_guard.py,跑完即退),
        # 避免"GUI 进程 + 守护脚本"两头同时重建抢端口。
        # 下面这行是原托盘内置巡检,留作手动/紧急使用,平时不启用:
        # bridge_guard()


def _stop_services_fast():
    targets = BRIDGES + VIZ + [EMBED]
    for key in [svc['id'] for svc in targets if svc]:
        proc = _procs.pop(key, None)
        if proc and proc.poll() is None: _kill_pid(proc.pid)
    _kill_ports([svc['port'] for svc in targets if svc])
    if SHELL: stop_shell()


def exit_all(icon=None, item=None):
    """退出并停止记忆服务 —— 唯一提交点(commit point)。

    行业规范:Electron `before-quit`→`tray.destroy()`;Qt `aboutToQuit`→`hide()`;
    Tauri 托盘 Exit→`app.exit(0)`;codex-desktop#939 的结论 —— "提交点之前任何一步
    都可恢复,提交点之后收尾必须不可逆,并带**不可取消**的超时兜底,最后一步是强退"。
    按此:
      1) 进门第一件事就挂上**不可取消**的强退兜底(之后任何一步卡住都还能退出去);
      2) 先显式摘图标(Windows 需 NIM_DELETE;否则进程死了图标留成幽灵,鼠标划过才消失);
      3) 停服务走无锁路径(不抢 _lock,不被后台 WSL 调用拖住);
      4) 最后才 icon.stop()。

    2026-10-04 实证:菜单点退出时 1~3 都做了,但 icon.stop() 没能结束 pystray 的 run 循环,
    进程带着图标继续活着(CPU 还在涨、菜单还能点)= 用户说的"退不出去"。所以第 1 条是关键。
    """
    logger.info("tray exit requested")
    force = threading.Timer(10.0, lambda: os._exit(0))   # 不可取消 —— 故意不 cancel
    force.daemon = True
    force.start()
    _stop.set()
    write_state("stopped", "tray-exit")
    try:
        _stop_services_fast()
    except Exception as e:
        logger.error("exit stop: %s", e)
    _stop.set()
    if icon:
        try:
            icon.visible = False                 # 显式摘图标(死之前做)
        except Exception as e:
            logger.error("exit icon.visible: %s", e)
        try:
            icon.stop()
        except Exception as e:
            logger.error("exit icon.stop: %s", e)
    logger.info("tray exit")


def make_icon():
    from PIL import Image, ImageDraw
    # 2026-09-15 多实例品牌:指定实例时用它的变体图标(lite / anima / max),
    # 图标路径来自 scripts/castalia.config.json 的 instances[].icon
    if _CLI_INSTANCE:
        try:
            p = C.icon_for(_CLI_INSTANCE)
            if p and os.path.exists(p):
                return Image.open(p).convert("RGBA")
        except Exception as e:
            logger.warning("icon_for(%s) 失败: %r", _CLI_INSTANCE, e)
    # 默认:预生成的"裁到盘边"图标(scripts/tray-icons/active-64.png)
    # —— 盘中图案 + 设计描边,盘外无黑(旧版是整张方图切圆角,盘外还留一圈黑)
    ready = os.path.join(BASE, "scripts", "tray-icons", "active-64.png")
    if os.path.exists(ready):
        try:
            return Image.open(ready).convert("RGBA")
        except Exception:
            pass
    mark = os.path.join(BASE, "viz", "public", "castalia-mark.png")
    if os.path.exists(mark):
        return _round_corners(Image.open(mark).convert("RGBA")).resize((64, 64), Image.Resampling.LANCZOS)
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((2, 2, 62, 62), radius=16, fill=(62, 232, 200, 255))
    star = [
        (32, 12), (36, 27), (52, 32), (36, 37),
        (32, 52), (28, 37), (12, 32), (28, 27),
    ]
    d.polygon(star, fill=(6, 35, 30, 255))
    return img


def build_menu():
    import pystray
    def group_action(services, running):
        def callback(icon, item):
            for svc in services: set_service_desired(svc, running)
            if running:
                _run_action(lambda: start_bridge(manual=False) if services is BRIDGES else start_viz(manual=False))
            else:
                def stop_group():
                    for svc in services: stop_service(svc, manual=False)
                    return '服务已停止并停用守护'
                _run_action(stop_group)
        return callback
    def group(name, services):
        return pystray.MenuItem(name, pystray.Menu(
            pystray.MenuItem('全部启动', group_action(services, True)),
            pystray.MenuItem('全部停止并停用守护', group_action(services, False)),
            pystray.Menu.SEPARATOR, *endpoint_menu_items(services)), visible=bool(services))
    def open_viz(v):
        return lambda icon, item: open_page(v['port'], '/?scope=local')
    opening = [pystray.MenuItem('联邦总图', open_fed_graph), pystray.MenuItem('记忆总成', open_aggregate)] if VIZ else []
    opening += [pystray.MenuItem(v['name'], open_viz(v)) for v in VIZ]
    if AIRI_PROXY:
        opening += [pystray.MenuItem('AIRI', open_airi), pystray.MenuItem('AIRI Admin', open_admin)]
    opening.append(pystray.MenuItem('LobeHub', open_lobehub))
    services = [group('记忆桥', BRIDGES), group('星图', VIZ)]
    if SHELL:
        services.append(pystray.MenuItem(lambda item: '控制台  ' + ('运行中' if shell_up() else '未运行'),
            pystray.Menu(pystray.MenuItem('打开', lambda icon, item: _run_action(start_shell)),
                         pystray.MenuItem('关闭窗口', lambda icon, item: _run_action(stop_shell)))))
    # 云端嵌入:升级成可点的子菜单 —— 光写"已配置(未验证)"没有下一步,这里给出验证动作
    services.append(pystray.MenuItem(
        lambda item: '云端嵌入：已配置（未验证）' if embed_is_api() else '云端嵌入：未配置',
        pystray.Menu(
            pystray.MenuItem('验证连接（一次真实调用）', lambda icon, item: run_maintenance('probe-embed', '嵌入自检')),
            pystray.MenuItem('打开记忆库配置目录', lambda icon, item: subprocess.Popen(['explorer', BANKS], creationflags=NOWIN)))))
    services += endpoint_menu_items([EMBED, AIRI_PROXY] + C.EXTRAS)
    if AIRI_PROXY:
        services.append(pystray.MenuItem(lambda item: 'AIRI  ' + ('运行中' if airi_running() else '未运行'),
            pystray.Menu(pystray.MenuItem('启动', lambda icon, item: _run_action(start_airi_app)),
                         pystray.MenuItem('停止 AIRI 及代理', lambda icon, item: _run_action(stop_airi_app)))))
    services.append(pystray.MenuItem(lambda item: 'LobeHub  ' + ('运行中' if lobehub_up() else '未运行'),
        pystray.Menu(pystray.MenuItem('启动', lambda icon, item: start_lobehub()),
                     pystray.MenuItem('停止', lambda icon, item: stop_lobehub()))))
    return pystray.Menu(
        pystray.MenuItem(f'{APP_NAME}  {APP_VERSION}', None, enabled=False),
        pystray.MenuItem('打开控制台', lambda icon, item: _run_action(start_shell), default=True, visible=bool(SHELL)),
        pystray.MenuItem('打开', pystray.Menu(*opening)),
        pystray.MenuItem('服务', pystray.Menu(*services)), pystray.Menu.SEPARATOR,
        pystray.MenuItem('记忆维护', pystray.Menu(
            pystray.MenuItem('体检（索引 / 坏向量 / 片段）', lambda icon, item: run_maintenance('health', '记忆体检')),
            pystray.MenuItem('评测（注入质量 14 问 + 8 噪音）', lambda icon, item: run_maintenance('eval', '注入评测')),
            pystray.MenuItem('自检（云端嵌入连通性）', lambda icon, item: run_maintenance('probe-embed', '嵌入自检')),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('重建片段索引（幂等）', lambda icon, item: run_maintenance('rebuild-chunks', '重建片段索引')),
            pystray.MenuItem('修复向量索引（清空重建）', lambda icon, item: run_maintenance(
                'repair', '修复向量索引',
                confirm='将清空并重建派生索引（整行向量 + 句级片段 + 嵌入缓存）。\n记忆正文与关系不受影响，可随时重建。继续？')),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('打开维护台账', open_ledger),
            pystray.MenuItem('打开记忆库目录', lambda icon, item: subprocess.Popen(['explorer', BANKS], creationflags=NOWIN)))),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('设置…', open_settings), pystray.MenuItem('复制状态', copy_status),
        pystray.MenuItem('打开日志', open_logs),
        pystray.MenuItem('托盘开机启动', toggle_autostart, checked=lambda item: autostart_on()),
        pystray.MenuItem(f'关于 {APP_NAME}', show_about), pystray.Menu.SEPARATOR,
        pystray.MenuItem('退出并停止记忆桥、星图和本地嵌入', exit_all))


# v1.23.2-fix: pystray 自带的 pywin32 NOTIFYICONDATAW 在本机（Python 3.13 + 新 pywin32）
# 会静默 NIM_ADD 失败：窗口在、GetRect 却 E_FAIL；同一 hwnd 用 ctypes 结构注册就正常。
# 这里把 pystray 的 _message 换成 ctypes 实现，图标才能真正进通知区。
_NOTIFY_UID = 1


def _patch_pystray_message():
    try:
        import ctypes
        from ctypes import wintypes as wt
        import pystray._win32 as pw

        class NID(ctypes.Structure):
            _fields_ = [
                ("cbSize", wt.DWORD), ("hWnd", wt.HWND), ("uID", wt.UINT),
                ("uFlags", wt.UINT), ("uCallbackMessage", wt.UINT), ("hIcon", wt.HICON),
                ("szTip", wt.WCHAR * 128), ("dwState", wt.DWORD), ("dwStateMask", wt.DWORD),
                ("szInfo", wt.WCHAR * 256), ("uVersion", wt.UINT),
                ("szInfoTitle", wt.WCHAR * 64), ("dwInfoFlags", wt.DWORD),
                ("guidItem", ctypes.c_byte * 16), ("hBalloonIcon", wt.HICON),
            ]

        def _message(self, code, flags, **kwargs):
            nid = NID()
            nid.cbSize = ctypes.sizeof(NID)
            nid.hWnd = self._hwnd
            nid.uID = _NOTIFY_UID
            nid.uFlags = flags
            for k, v in kwargs.items():
                if hasattr(nid, k):
                    setattr(nid, k, v)
            return ctypes.windll.shell32.Shell_NotifyIconW(code, ctypes.byref(nid))

        pw.Icon._message = _message
    except Exception as e:
        logger.error("patch pystray message failed: %r", e)


def _log_icon_rect(icon):
    """诊断：Shell_NotifyIconGetRect 返回 0 才说明图标真的进了通知区（否则只是 visible 标志）。"""
    try:
        import ctypes
        from ctypes import wintypes

        class NID(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.DWORD), ("hWnd", wintypes.HWND),
                        ("uID", wintypes.UINT), ("uFlags", wintypes.UINT),
                        ("guid", ctypes.c_byte * 16)]

        class RECT(ctypes.Structure):
            _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                        ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

        hwnd = getattr(icon, "_hwnd", 0)
        nid = NID(ctypes.sizeof(NID), hwnd, _NOTIFY_UID, 0, (ctypes.c_byte * 16)())
        rect = RECT()
        hr = ctypes.windll.shell32.Shell_NotifyIconGetRect(ctypes.byref(nid), ctypes.byref(rect))
        logger.info("tray icon rect: hr=0x%08x hwnd=%s rect=(%s,%s,%s,%s)",
                    hr & 0xFFFFFFFF, hwnd, rect.left, rect.top, rect.right, rect.bottom)
        return hr
    except Exception as e:
        logger.error("tray icon rect check failed: %r", e)
        return None


def _on_ready(icon):
    """pystray 官方契约:`run(setup=…)` 的 setup 在图标就绪后**于单独线程**执行,run() 不等它
    (文档原文:"you may put any code that would follow the call to run() in it")。

    2026-10-02 之前这些初始化写在 run() **之前** —— 桥/星图起来要十几秒,那段时间图标
    还没显示/点不动。现在图标秒出,服务在后台线程里起。
    """
    global _ICON_ALIVE
    try:
        _ICON_ALIVE = False
        icon.visible = True
        hr = _log_icon_rect(icon)
        if hr not in (0, None):
            # 高完整性进程无法把图标挂到普通权限的 explorer 通知区（实测 E_FAIL）。
            # 非提权进程即便 GetRect 查不到（hID 口径差异）也不能自杀，否则会把正常的托盘杀掉。
            elevated = False
            try:
                elevated = bool(ctypes.windll.shell32.IsUserAnAdmin())
            except Exception:
                pass
            if elevated:
                _ICON_ALIVE = False
                logger.error("托盘图标未进入通知区（hr=0x%08x，提权进程），退出以便用普通权限重启", hr & 0xFFFFFFFF)
                try:
                    icon.visible = False
                    icon.stop()
                except Exception:
                    pass
                return
            logger.warning("托盘图标 GetRect 查询失败（hr=0x%08x），非提权进程，继续运行", hr & 0xFFFFFFFF)
        # 到这里图标才算真的可见
        _ICON_ALIVE = True
        threading.Thread(target=_title_loop, daemon=True).start()
        write_state("running", "tray-start")
        start_bridge(manual=False)
        start_viz(manual=False)
        autostart_lobehub()          # 2026-10-01:托盘启动顺带把 LobeHub 拉起(lobehub.autoStart 可关)
        if embed_is_api():
            logger.info("embed = API, skip local yuan")
        else:
            start_embed(manual=False)
    except Exception as e:
        import traceback
        logger.error("setup: %r\n%s", e, traceback.format_exc())


def main():
    import pystray
    _patch_pystray_message()

    # v1.23.2-fix: pystray 生成托盘图标时要 tempfile.mkstemp；从某些宿主（Explorer/计划任务）
    # 启动时进程的 TEMP 可能指向不可用目录，导致 setup 直接失败、图标不出现。
    # 这里先锁定一个确定可写、已存在的临时目录，再让 pystray 工作。
    try:
        import tempfile
        tmp = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "Temp")
        os.makedirs(tmp, exist_ok=True)
        os.environ["TEMP"] = tmp
        os.environ["TMP"] = tmp
        tempfile.tempdir = tmp
        fd, probe = tempfile.mkstemp(prefix="castalia-tray-", dir=tmp)
        os.close(fd)
        os.unlink(probe)
        logger.info("temp dir = %s", tmp)
    except Exception as e:
        logger.error("temp dir unusable: %r", e)

    # v1.23.2-fix: 品牌宿主（PyInstaller windowed）里 pystray._win32._create_window 的
    # ChangeWindowMessageFilterEx 会抛 PermissionError(13, 拒绝访问)，导致图标循环直接结束、
    # 只剩控制端口（用户看到“托盘起不来”）。这一步只影响“资源管理器重启后能否收到
    # WM_TASKBARCREATED”，失败不该让整个托盘不可用 → 降级为 no-op。
    try:
        import pystray._win32 as _pw
        _orig_cwmf = _pw.win32.ChangeWindowMessageFilterEx
        def _cwmf_safe(*a, **k):
            try:
                return _orig_cwmf(*a, **k)
            except Exception:
                return True
        _pw.win32.ChangeWindowMessageFilterEx = _cwmf_safe
    except Exception:
        pass

    global _icon, _ICON_ALIVE
    verb = _cli_verb()
    already = control_alive()

    # 已有托盘(端口即身份)→ 本进程当客户端:转发动词/激活首实例后退出。
    # v1.23.2-fix: 但“端口在”不等于“图标在”。pystray 创建窗口失败时控制线程仍会
    # 非 daemon 存活，形成没有图标的僵尸实例 —— 这时新实例必须接管，否则用户点
    # 快捷方式永远只是把 activate 发给一个看不见的托盘。
    if already:
        icon_alive = None
        try:
            code, body = control_request("GET", "/status")
            if code:
                icon_alive = json.loads(body).get("icon")
        except Exception:
            icon_alive = None
        if icon_alive is False:
            logger.info("检测到无图标的托盘实例(僵尸)，请求退出并接管")
            try:
                control_request("POST", "/quit")
            except Exception:
                pass
            for _ in range(40):
                if not control_alive():
                    break
                time.sleep(0.25)
            if control_alive():
                logger.error("旧实例未退出，仍按客户端转发")
                return _client(verb)
        else:
            return _client(verb)

    # 没有托盘在跑,而调用方只是想查状态/关托盘 → 直接答复
    if verb in ("--status", "--quit", "--stop-services"):
        logger.info("client %s: 当前没有托盘在运行", verb)
        _write_status({"ok": True, "running": False, "verb": verb})
        return 0

    # 我是唯一的托盘:先把控制端口抢下来(抢不到说明有竞态 → 退化为客户端)
    try:
        start_control()
    except OSError as e:
        logger.error("control bind 失败(端口 %s 被占?): %r — 退化为客户端", TRAY_PORT, e)
        return _client(verb)

    logger.info("tray start pid=%s (%s %s) ctl=127.0.0.1:%s", os.getpid(), APP_NAME, APP_VERSION, TRAY_PORT)

    last_error = None
    try:
        # v1.23.2-fix: 图标循环失败重试 2 次（窗口类/桌面偶发冲突）；仍失败就退出，
        # 让出 3398。否则控制端口活着、图标没了，快捷方式会被僵尸吃掉。
        for attempt in range(1, 4):
            _icon = pystray.Icon(APP_NAME, make_icon(), tooltip(), build_menu())
            try:
                _icon.run(setup=_on_ready)      # 阻塞在图标事件循环
                last_error = None
                break
            except Exception as e:
                last_error = e
                _ICON_ALIVE = False
                logger.error("run attempt %s/3: %r", attempt, e)
                time.sleep(1.0 * attempt)
        if last_error is not None:
            import traceback
            logger.error("托盘图标启动失败（3 次），释放控制端口后退出: %s", traceback.format_exc())
            try:
                _write_status({"ok": False, "running": False, "error": str(last_error)})
            except Exception:
                pass
            os._exit(1)
    finally:
        _ICON_ALIVE = False
        _stop.set()
        logger.info("tray loop ended")

if __name__ == "__main__":
    main()
