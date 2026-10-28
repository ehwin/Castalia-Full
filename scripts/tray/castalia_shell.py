# -*- coding: utf-8 -*-
"""Castalia 桌面外壳 · 原型(2026-09-16)

把星图这些网页"收进一个原生窗口",而不是一直挂在浏览器里。

窗口策略(与 Electron 的 titleBarStyle:'hidden' 同款):
  · **视觉自绘**:整条标题栏是网页画的(HTML/CSS),想放什么放什么。
  · **命中测试留给系统**:去掉 WS_CAPTION、**保留 WS_THICKFRAME** →
    拖动、双击最大化、边缘改大小、Win+方向键分屏、贴边吸附、多屏 DPI 全由 Windows 处理,
    我们一行都不用重写,手感 100% 原生。
  · **拖动由网页上报**:WebView2 的子窗口铺满客户区,父窗口的 WM_NCHITTEST 收不到
    鼠标消息(实测:hittest=True 但拖不动)。所以标题栏的 mousedown 由网页调
    start_drag() → Python 回 ReleaseCapture + WM_NCLBUTTONDOWN(HTCAPTION),
    让系统进入原生拖动循环(贴边吸附/分屏照旧)。边缘缩放靠保留的 WS_THICKFRAME。

用法
  python castalia_shell.py                 # 打开外壳(默认内嵌 LobeHub 星图 :3346)
  python castalia_shell.py --url http://127.0.0.1:3345/
  python castalia_shell.py --no-mica       # 关闭 Mica 尝试(纯深色)

单实例 + 控制端口(2026-09-18)
  托盘点「打开…」时优先把页面送进来(见 castalia_tray.py 的 open_in_shell):
    已在跑 → HTTP 打这个外壳的本地控制端口,窗口内导航 + 置前;
    没在跑 → 用 --url 拉起一个新窗口。
  端口取 castalia.config.json 的 shell.port(默认 3397,只监听 127.0.0.1)。
  第二次启动会因单实例锁直接退出 —— 避免"点几次开几个窗口"。
"""
import argparse
import ctypes
import datetime
import glob
import http.server
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
SHELL_HTML = os.path.join(HERE, "shell", "shell.html")
TITLE = "Castalia 记忆体"
LOG = os.path.join(HERE, "shell.log")
CONFIG_PATH = os.path.join(HERE, "castalia.config.json")
TRAY_SCRIPT = os.path.join(HERE, "castalia_tray.py")
PYWISH = os.path.join(os.path.dirname(HERE), "Castalia", "Castalia.exe")   # 品牌宿主


def _load_config():
    # v1.23.2-fix: 允许 BOM（记事本/PowerShell 5 保存的 JSON 常带 BOM）
    with open(CONFIG_PATH, encoding="utf-8-sig") as f:
        return json.load(f)


def _port_open(port, timeout=0.7):
    import socket as _s
    sk = _s.socket()
    sk.settimeout(timeout)
    try:
        sk.connect(("127.0.0.1", int(port)))
        return True
    except Exception:
        return False
    finally:
        sk.close()


def log(msg):
    """写日志文件:外壳是 windowed 进程,print 看不到"""
    import time as _t
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{_t.strftime('%H:%M:%S')} {msg}\n")
    except Exception:
        pass

# ── Win32 常量 ──
GWL_STYLE = -16
GWLP_WNDPROC = -4
WS_OVERLAPPEDWINDOW = 0x00CF0000
WS_CAPTION = 0x00C00000
SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_FRAMECHANGED = 0x0002, 0x0001, 0x0004, 0x0020
WM_APP_DRAG = 0x8001          # WM_APP + 1:网页请求开始拖动
WM_APP_FOCUS = 0x8002         # WM_APP + 2:控制端口请求把窗口置前(必须回 UI 线程做)
WM_NCLBUTTONDOWN = 0x00A1
HTCLIENT, HTCAPTION = 1, 2
DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWA_SYSTEMBACKDROP_TYPE = 38
DWMWCP_ROUND = 2
DWMSBT_MAINWINDOW = 2          # Mica
TITLEBAR_H_DIP = 40            # 与 CSS 的 --tbar-h 保持一致

MUTEX_NAME = "Local\\CastaliaShellSingleInstance"
CONTROL_PORT_DEFAULT = 3397
# 外壳里可切换的视图(与 shell.html 的 .ri[data-v] / #v-* 一一对应)
VIEWS = ("viz", "agg", "mng", "alert", "set", "svc", "acc", "about")

user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi
try:
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))   # PER_MONITOR_AWARE_V2
except Exception:
    pass

_wndproc_ref = None            # 保住回调引用,别被 GC 掉
_state = {"hwnd": None, "orig_proc": None, "scale": 1.0, "win": None, "url": ""}


def _get_scale(hwnd):
    """当前窗口所在显示器的缩放比例(96dpi = 1.0)"""
    try:
        v = ctypes.c_int(user32.GetDpiForWindow(hwnd))
        return v.value / 96.0 if v.value else 1.0
    except Exception:
        return 1.0


def _apply_window_style(hwnd):
    """去掉标题栏,保留边框 → 视觉无边框,手感原生"""
    style = user32.GetWindowLongPtrW(hwnd, GWL_STYLE)
    new_style = (style | WS_OVERLAPPEDWINDOW) & ~WS_CAPTION
    user32.SetWindowLongPtrW(hwnd, GWL_STYLE, new_style)
    user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED)


def _apply_dwm(hwnd, mica=True):
    """深色 + 圆角 (+ 尝试 Mica)"""
    def set_attr(attr, val):
        try:
            v = ctypes.c_int(val)
            return dwmapi.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(v), ctypes.sizeof(v)) == 0
        except Exception:
            return False

    dark = set_attr(DWMWA_USE_IMMERSIVE_DARK_MODE, 1)
    round_ok = set_attr(DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND)
    mica_ok = set_attr(DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_MAINWINDOW) if mica else False
    return dark, round_ok, mica_ok


def _set_app_id(app_id="Castalia.Memory.Console"):
    """设置任务栏身份(AppUserModelID)。
    不设的话 Windows 会把窗口归到宿主进程(python.exe / Castalia.exe)名下,
    任务栏图标和分组都跟着宿主走 —— 这就是图标改了却不生效的原因。"""
    try:
        return ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(app_id) == 0
    except Exception:
        return False


def _set_window_icon(hwnd, ico_path):
    """任务栏 / Alt+Tab / 标题栏图标 —— 与托盘、exe 用同一套品牌图标"""
    IMAGE_ICON, LR_LOADFROMFILE = 1, 0x10
    WM_SETICON, ICON_SMALL, ICON_BIG = 0x0080, 0, 1
    user32.LoadImageW.restype = ctypes.c_void_p
    user32.LoadImageW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint,
                                  ctypes.c_int, ctypes.c_int, ctypes.c_uint]
    ok = False
    for size, which in ((16, ICON_SMALL), (32, ICON_BIG)):
        h = user32.LoadImageW(None, ico_path, IMAGE_ICON, size, size, LR_LOADFROMFILE)
        if h:
            user32.SendMessageW(hwnd, WM_SETICON, which, h)
            ok = True
    if ok:
        # 强制重画窗口框架,任务栏按钮才会重新取图标(否则一直显示旧图标)
        SWP_NOSIZE, SWP_NOMOVE, SWP_NOZORDER, SWP_FRAMECHANGED = 0x1, 0x2, 0x4, 0x20
        user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                            SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED)
        # 再走一次隐藏/显示,让任务栏按钮重建
        user32.ShowWindow(hwnd, 0)          # SW_HIDE
        user32.ShowWindow(hwnd, 5)          # SW_SHOW
    return ok


def _install_hook(hwnd):
    """钩窗口过程:把"开始拖动"这件事挪到 **UI 线程**执行。

    为什么必须这样:ReleaseCapture() 作用于调用它的那个线程的鼠标捕获,而 pywebview
    的 js_api 回调跑在别的线程 —— 在那里 ReleaseCapture 是白放(实测:日志有记录但窗口不动)。
    所以 JS 侧只 PostMessage(自定义消息)到 UI 线程,由这里的窗口过程真正执行拖动。
    """
    WNDPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wintypes.HWND, ctypes.c_uint,
                                 wintypes.WPARAM, wintypes.LPARAM)

    user32.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_void_p]
    user32.SetWindowLongPtrW.restype = ctypes.c_void_p
    user32.CallWindowProcW.argtypes = [ctypes.c_void_p, wintypes.HWND, ctypes.c_uint,
                                       wintypes.WPARAM, wintypes.LPARAM]
    user32.CallWindowProcW.restype = ctypes.c_ssize_t
    user32.PostMessageW.argtypes = [wintypes.HWND, ctypes.c_uint, wintypes.WPARAM, wintypes.LPARAM]
    user32.SendMessageW.argtypes = [wintypes.HWND, ctypes.c_uint, wintypes.WPARAM, wintypes.LPARAM]
    user32.GetForegroundWindow.restype = wintypes.HWND     # 别被默认 c_int 截断(要和 hwnd 比)

    def proc(h, msg, wparam, lparam):
        if msg == WM_APP_DRAG:
            # 现在在 UI 线程上了:释放捕获(鼠标此刻被 WebView2 抓着),再请系统进入拖动循环
            user32.ReleaseCapture()
            user32.SendMessageW(h, WM_NCLBUTTONDOWN, HTCAPTION, 0)
            log("WM_APP_DRAG 已在 UI 线程执行")
            return 0
        if msg == WM_APP_FOCUS:
            # 控制端口(托盘点「打开…」)过来:恢复 + 置前。SetForegroundWindow 有个前提 ——
            # 得由"当前前台进程"或本窗口所属线程调用,所以统一回 UI 线程做。
            try:
                if user32.IsIconic(h):
                    user32.ShowWindow(h, 9)          # SW_RESTORE
                user32.ShowWindow(h, 5)              # SW_SHOW
                user32.SetForegroundWindow(h)
                if user32.GetForegroundWindow() != h:
                    # 前台锁:用户此刻正在别的窗口操作时,SetForegroundWindow 会被 Windows 拒掉 ——
                    # 用"最小化 + 还原"这对组合把窗口拽到前台(老牌兜底做法,窗口内容不丢)。
                    user32.ShowWindow(h, 6)          # SW_MINIMIZE
                    user32.ShowWindow(h, 9)          # SW_RESTORE
                log("WM_APP_FOCUS 已在 UI 线程执行")
            except Exception as e:
                log(f"focus 失败: {e!r}")
            return 0
        return user32.CallWindowProcW(_state["orig_proc"], h, msg, wparam, lparam)

    global _wndproc_ref
    _wndproc_ref = WNDPROC(proc)
    _state["orig_proc"] = user32.SetWindowLongPtrW(hwnd, GWLP_WNDPROC,
                                                   ctypes.cast(_wndproc_ref, ctypes.c_void_p))
    return bool(_state["orig_proc"])


# ══════════════ 提醒中心数据(反思失败/退避、整合异常、桥日志错误)══════════════
# 页面「提醒」与 rail 红点都读这里；只读状态文件与日志尾部，不改任何数据。
ALERT_LOG_BAD = re.compile(
    r"(NOT NULL|FOREIGN KEY|content_filter|finish=length|退避|反思失败|整合失败|"
    r"Error:|TypeError|unknown consolidation action)", re.I)
ALERT_LOG_SKIP = re.compile(r"(errors=0|错误\s*0|no errors)", re.I)


def _read_json_file(path):
    try:
        # utf-8-sig：兼容被 PowerShell 等工具写入的带 BOM 状态文件
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:
        return None


def _iso_to_ts(value):
    try:
        return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def _rel_hours(ts, now):
    return None if ts is None else round((now - ts) / 3600.0, 1)


def _collect_alerts():
    """汇总各库的反思/整合状态 + 桥日志里的异常行。"""
    cfg = {}
    try:
        cfg = _load_config()
    except Exception:
        pass
    banks_root = (cfg.get("paths") or {}).get("banks") or ""
    try:
        backoff_h = float(os.environ.get("REFLECT_FAIL_BACKOFF_HOURS", "1"))
    except Exception:
        backoff_h = 1.0
    now = time.time()
    items = []

    def add(level, kind, bank, title, detail, ts, project=None):
        items.append({
            "level": level, "kind": kind, "bank": bank, "project": project or bank, "title": title,
            "detail": detail or "", "at": (datetime.datetime.fromtimestamp(ts).isoformat()
                                           if ts else ""),
            "ageHours": _rel_hours(ts, now),
        })

    # ── 反思状态：失败/退避 ──
    for path in glob.glob(os.path.join(banks_root, "*", "reflect-state-*.json")) if banks_root else []:
        bank = os.path.basename(os.path.dirname(path))
        proj = os.path.basename(path)[len("reflect-state-"):-len(".json")]
        st = _read_json_file(path) or {}
        ts = _iso_to_ts(st.get("at"))
        if st.get("ok") is not False:
            continue
        err = (st.get("errors") or ["未知错误"])[0]
        age = _rel_hours(ts, now)
        in_backoff = age is not None and age < backoff_h
        detail = str(err)
        if in_backoff:
            detail += "；退避中，约 %.1fh 后才会自动重试" % max(0.0, backoff_h - age)
        add("alert" if in_backoff else "warn", "reflect", bank, "反思失败", detail, ts, proj)

    # ── 整合状态：失败/有合并 ──
    for path in glob.glob(os.path.join(banks_root, "*", "consolidate-state-*.json")) if banks_root else []:
        bank = os.path.basename(os.path.dirname(path))
        proj = os.path.basename(path)[len("consolidate-state-"):-len(".json")]
        st = _read_json_file(path) or {}
        ts = _iso_to_ts(st.get("at"))
        if st.get("ok") is False:
            add("warn", "consolidate", bank, "整合失败",
                "扫描 %s 条 / 候选 %s 对" % (st.get("scanned", "?"), st.get("candidates", "?")), ts, proj)
        elif (st.get("merged") or 0) > 0:
            add("info", "consolidate", bank, "整合完成：合并 %s 条" % st.get("merged"),
                "扫描 %s 条 / 候选 %s 对" % (st.get("scanned", "?"), st.get("candidates", "?")), ts, proj)

    # ── 桥日志：**只扫当前进程启动之后**的异常行（历史错误不该反复提醒）──
    seen = set()
    START_RE = re.compile(r"(\[castalia\] v[\d.]+ started|federation\] ready|starting server on port)")
    log_paths = glob.glob(os.path.join(HERE, "bridge-*-bridge.log"))
    # AIRI 的引擎日志在 airiBase/unified-proxy 下（24h 内更新过才看，避免翻旧账）
    airi_base = (cfg.get("paths") or {}).get("airiBase") or ""
    if airi_base:
        log_paths += glob.glob(os.path.join(airi_base, "unified-proxy", "*.log"))
    for path in log_paths:
        try:
            if now - os.path.getmtime(path) > 86400:
                continue
        except Exception:
            continue
        stem = os.path.basename(path)[:-4] if path.endswith(".log") else os.path.basename(path)
        label = stem[len("bridge-"):-len("-bridge")] if stem.startswith("bridge-") and stem.endswith("-bridge") else stem
        try:
            size = os.path.getsize(path)
            with open(path, "rb") as f:
                f.seek(max(0, size - 120000))
                text = f.read().decode("utf-8", "replace")
        except Exception:
            continue
        lines = text.splitlines()
        start_idx = 0
        for i, ln in enumerate(lines):
            if START_RE.search(ln):
                start_idx = i
        recent = lines[start_idx:]
        hits = []
        for line in recent:
            s = line.strip()
            if not s or "closing session" in s:
                continue
            if ALERT_LOG_SKIP.search(s) or not ALERT_LOG_BAD.search(s):
                continue
            if s in seen:
                continue
            seen.add(s)
            hits.append(s)
        for s in hits[-3:]:
            # 日志行没有时间戳：标记为"本次启动后"，排序时放在同级别最后
            add("warn", "log", "", label, s[:300], None, label)

    rank = {"alert": 0, "warn": 1, "info": 2}
    items.sort(key=lambda x: (rank.get(x["level"], 9), -( _iso_to_ts(x["at"]) or 0)))
    counts = {lvl: sum(1 for i in items if i["level"] == lvl) for lvl in ("alert", "warn", "info")}
    return {"ok": True, "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
            "items": items[:60], "counts": counts, "total": len(items)}


class Api:
    """暴露给网页的窗口控制(拖动/双击最大化不走这里,交给系统)"""
    def minimize(self):
        if _state["hwnd"]:
            user32.ShowWindow(_state["hwnd"], 6)      # SW_MINIMIZE

    def toggle_max(self):
        h = _state["hwnd"]
        if not h:
            return
        if user32.IsZoomed(h):
            user32.ShowWindow(h, 9)                   # SW_RESTORE
        else:
            user32.ShowWindow(h, 3)                   # SW_MAXIMIZE

    def close(self):
        if _state["hwnd"]:
            user32.PostMessageW(_state["hwnd"], 0x0010, 0, 0)   # WM_CLOSE

    def start_drag(self):
        """网页上按下标题栏 → 这里让系统接管拖动。

        ReleaseCapture + WM_NCLBUTTONDOWN(HTCAPTION) 是 Windows 无边框窗口拖动的标准做法:
        系统会进入自己的拖动循环,于是贴边吸附、Win+方向键分屏都还在。
        必须另起线程:SendMessage 会阻塞到用户松开鼠标为止。
        """
        h = _state["hwnd"]
        if not h:
            return
        user32.PostMessageW.argtypes = [wintypes.HWND, ctypes.c_uint, wintypes.WPARAM, wintypes.LPARAM]
        user32.PostMessageW(h, WM_APP_DRAG, 0, 0)      # 异步投给 UI 线程,由钩子执行

    # ══════════════ 设置页数据接口(与托盘共用 castalia.config.json)══════════════
    def get_bootstrap(self):
        """一次拿全:配置 + 状态 + 接入信息(页面初始化用,省得来回三次)"""
        # v1.23.2-fix: 配置带 BOM/半截/不可读时不要让整个控制台初始化失败；
        # 返回 ok:false + 明确错误，前端可提示修复而不是白屏。
        try:
            cfg = _load_config()
        except Exception as e:
            return {"ok": False, "config": {}, "path": CONFIG_PATH,
                    "error": f"配置读取失败: {e}. 请检查 {CONFIG_PATH}（必须是 UTF-8 JSON）",
                    "status": self.get_status(), "access": self.get_access()}
        return {"ok": True, "config": cfg, "path": CONFIG_PATH,
                "status": self.get_status(), "access": self.get_access()}

    def get_status(self):
        """各接入口/服务是否在跑(实时)"""
        try:
            import castalia_config as cc
            C = cc.load()
        except Exception as e:
            return {"ok": False, "error": f"配置加载失败: {e}"}
        try:
            import urllib.request
            port = (C.TRAY or {}).get('port') or 3398
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/status', timeout=4) as response:
                status = json.load(response)
            if status.get('ok') and isinstance(status.get('groups'), list):
                groups = status['groups']
                flat = [item for group in groups for item in group['items']]
                return {"ok": True, "groups": groups, "up": sum(bool(i['up']) for i in flat),
                        "total": len(flat), "source": "tray"}
        except Exception:
            pass
        groups = []

        def ok_items(items):
            out = []
            for it in items:
                if not it:
                    continue
                p = it.get("port")
                up = _port_open(p) if p else False
                # A listening bridge may have lost its engine; use the same health rules as the tray.
                try:
                    import castalia_tray as tray
                    up = tray.service_up(it)
                except Exception:
                    pass
                out.append({"id": it.get("id"), "name": it.get("name"),
                            "port": p, "up": up})
            return out

        groups.append({"kind": "桥", "items": ok_items(C.BRIDGES)})
        groups.append({"kind": "星图", "items": ok_items(C.VIZ)})
        groups.append({"kind": "其它", "items": ok_items([C.AIRI_PROXY, C.EMBED] + (C.EXTRAS or []))})
        flat = [i for g in groups for i in g["items"]]
        return {"ok": True, "groups": groups,
                "up": sum(1 for i in flat if i["up"]), "total": len(flat)}

    def get_alerts(self):
        """提醒中心：反思失败/退避、整合异常、桥日志错误（页面每 30s 拉一次）"""
        try:
            return _collect_alerts()
        except Exception as e:
            return {"ok": False, "error": str(e), "items": [], "counts": {"alert": 0, "warn": 0, "info": 0}}

    def get_access(self):
        """生成"怎么接入"的现成片段(任何支持 MCP 的客户端都能用)"""
        try:
            import castalia_config as cc
            C = cc.load()
        except Exception as e:
            return {"ok": False, "error": str(e)}

        options = []
        for bridge in C.BRIDGES:
            if bridge.get("federation"):
                continue
            engine = bridge["cmd"][bridge["cmd"].index("--") + 1:]
            args = [os.path.join(bridge["cwd"], arg) if arg.endswith(".js") and not os.path.isabs(arg) else arg
                    for arg in engine[1:]]
            config = {"command": engine[0], "args": args, "env": dict(bridge["env"])}
            options.append({"id": bridge["id"], "name": bridge["name"], "stdio": config,
                            "stdioJson": json.dumps({"mcpServers": {bridge["id"]: config}}, ensure_ascii=False, indent=2)})
        selected = next((o for o in options if o["id"] == "hermes-bridge"), options[0] if options else None)
        stdio = selected["stdio"] if selected else None
        http = []
        for b in C.BRIDGES:
            http.append({"id": b["id"], "name": b.get("name"),
                         "url": f"http://127.0.0.1:{b['port']}/mcp", "up": _port_open(b["port"])})
        return {
            "ok": True,
            "stdio": stdio,
            "stdioJson": selected["stdioJson"] if selected else "{}",
            "stdioOptions": options,
            "selectedBridge": selected["id"] if selected else None,
            "http": http,
            "httpJson": json.dumps({"mcpServers": {h["id"]: {"url": h["url"]} for h in http}},
                                   ensure_ascii=False, indent=2),
            "tools": {
                "记忆": ["memory_search", "memory_save", "memory_get", "memory_list",
                         "memory_recent", "memory_index", "memory_graph", "fact_search"],
                "联邦": ["memory_search_all", "federation_members"],
                "对话/反思": ["auto_process", "conversation_save", "digest_run", "reflect_auto"],
            },
            "notes": [
                "stdio:适合本地 harness 直接拉进程(最省事,无需额外端口)。",
                "http:适合容器/跨进程/另一台机器;端点由记忆桥提供,对端零改动。",
                "联邦接口(带 federation 的那个端点)可跨所有成员检索,包括远端 MCP 端点。",
                "选择对应 harness 的接入配置；记忆读写使用所选实例的独立库。",
            ],
        }

    def save_config(self, cfg):
        """写回 castalia.config.json(先校验,原子替换)"""
        import tempfile
        try:
            from castalia_settings import validate
        except Exception:
            validate = None
        if validate:
            probs = validate(cfg)
            if probs:
                return {"ok": False, "errors": probs}
        try:
            fd, tmp = tempfile.mkstemp(dir=HERE, suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
                f.write("\n")
            os.replace(tmp, CONFIG_PATH)
            return {"ok": True, "path": CONFIG_PATH}
        except Exception as e:
            return {"ok": False, "errors": [repr(e)]}

    def restart_tray(self):
        """重启托盘让配置生效"""
        try:
            import psutil
            for pr in psutil.process_iter(["pid", "cmdline"]):
                try:
                    if "castalia_tray.py" in " ".join(pr.info.get("cmdline") or []):
                        pr.kill()
                except Exception:
                    pass
            import time as _t
            _t.sleep(2)
            host = PYWISH if os.path.exists(PYWISH) else sys.executable
            subprocess.Popen([host, TRAY_SCRIPT], cwd=HERE,
                             creationflags=0x00000008 | 0x08000000,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "errors": [repr(e)]}

    def test_member(self, member):
        """单个成员连通性:local-dir 看目录,mcp-http 试连接"""
        try:
            tgt = str((member or {}).get("target") or "")
            if (member or {}).get("transport") == "mcp-http":
                from urllib.parse import urlparse
                u = urlparse(tgt)
                ok = _port_open(u.port or (443 if u.scheme == "https" else 80), 1.5)
                return {"ok": ok, "detail": f"{u.hostname}:{u.port} {'可连接' if ok else '连接失败'}"}
            ok = os.path.isdir(tgt)
            return {"ok": ok, "detail": f"目录{'存在' if ok else '不存在'}: {tgt}"}
        except Exception as e:
            return {"ok": False, "detail": repr(e)}


# ══════════════ 单实例 + 本地控制端口(托盘点「打开…」时走这里)══════════════
_mutex_handle = None


def single_instance():
    """拿到单实例锁 → True;已经有外壳在跑 → False(调用方转发请求后自己退出)。"""
    global _mutex_handle
    try:
        k = ctypes.windll.kernel32
        _mutex_handle = k.CreateMutexW(None, False, MUTEX_NAME)
        return k.GetLastError() != 183            # 183 = ERROR_ALREADY_EXISTS
    except Exception as e:
        log(f"mutex 失败(仍单开一个): {e!r}")
        return True


def control_port(explicit=None):
    """控制端口:命令行 > 配置 shell.port > 默认 3397。"""
    if explicit:
        return int(explicit)
    try:
        return int((_load_config().get("shell") or {}).get("port") or CONTROL_PORT_DEFAULT)
    except Exception:
        return CONTROL_PORT_DEFAULT


def _local_page(url):
    """只放行本机页面 —— 免得这个本地端口被别的进程当成"任意网站的浏览器"用。"""
    try:
        u = urllib.parse.urlparse(url)
    except Exception:
        return False
    return u.scheme in ("http", "https") and (u.hostname or "") in ("127.0.0.1", "localhost", "::1")


def forward(port, url, view="", tries=14, delay=0.3):
    """把"换个页面"发给已在跑的外壳;成功返回 True。

    刚拉起的那个外壳要几百毫秒才把控制端口听上 → 带重试。
    """
    import urllib.request
    q = urllib.parse.urlencode({k: v for k, v in (("url", url), ("view", view)) if v})
    target = f"http://127.0.0.1:{int(port)}/open" + (f"?{q}" if q else "")
    for i in range(max(1, tries)):
        try:
            with urllib.request.urlopen(target, timeout=2.5) as r:
                return bool(json.loads(r.read().decode("utf-8")).get("ok"))
        except Exception:
            if i == max(1, tries) - 1:
                return False
            time.sleep(delay)
    return False


def _js(win, expr, default=""):
    """读网页里的一个值(evaluate_js 走 webview.Invoke,可在控制线程调用)。失败给 default。"""
    try:
        v = win.evaluate_js(expr)
        return v if isinstance(v, str) else default
    except Exception:
        return default


class _ControlHandler(http.server.BaseHTTPRequestHandler):
    """外壳的本地控制面:健康检查 / 读当前页 / 导航 + 置前。"""

    server_version = "CastaliaShellControl"

    def log_message(self, fmt, *args):
        log("control: " + (fmt % args))          # windowed 进程没有 stderr 可看

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        url = (q.get("url") or [""])[0]
        view = (q.get("view") or [""])[0]
        win = _state.get("win")

        if u.path == "/health":
            return self._json({"ok": True, "pid": os.getpid(), "hwnd": _state["hwnd"],
                               "url": _state["url"], "view": _state.get("view", "")})

        if u.path == "/state":
            if win is None:
                return self._json({"ok": False, "error": "窗口未就绪"}, 503)
            return self._json({
                "ok": True, "pid": os.getpid(), "hwnd": _state["hwnd"],
                "iframe": _js(win, "document.getElementById('viz').src"),
                "view": _js(win, "(document.querySelector('.view.on')||{}).id || ''"),
            })

        if u.path == "/open":
            if win is None:
                return self._json({"ok": False, "error": "窗口未就绪"}, 503)
            if url and not _local_page(url):
                return self._json({"ok": False, "error": "只接受本机页面(http://127.0.0.1/…)"}, 400)
            if view not in VIEWS:
                view = ""
            if not url and not view:
                return self._json({"ok": False, "error": "url 与 view 至少要有一个"}, 400)
            if url:
                _state["url"] = url
            _state["view"] = view or _state.get("view", "")
            script = ("window.__nav && window.__nav(%s, %s);"
                      % (json.dumps(url), json.dumps(view)))
            landed = ""
            frame_id = {'agg': 'fr-agg', 'mng': 'fr-mng'}.get(view, 'viz')
            for attempt in range(3):
                try:
                    # evaluate_js 内部是 webview.Invoke(...) → 非 UI 线程调用安全(实测 6.2.1)
                    win.evaluate_js(script)
                except Exception as e:
                    log(f"control /open 第 {attempt + 1} 次失败: {e!r}")
                    time.sleep(0.4)
                    continue
                if url:
                    landed = _js(win, "document.getElementById('%s').src" % frame_id)
                else:
                    landed = _js(win, "(document.querySelector('.view.on')||{}).id || ''")
                if url:
                    if landed and landed.split("?")[0] == url.split("?")[0]:
                        break
                elif landed and landed.endswith("v-" + view):
                    break
                time.sleep(0.4)
            if _state["hwnd"]:
                user32.PostMessageW(_state["hwnd"], WM_APP_FOCUS, 0, 0)   # 置前交给 UI 线程
            if url:
                ok = bool(landed) and landed.split("?")[0] == url.split("?")[0]
            else:
                ok = bool(landed) and landed.endswith("v-" + view)
            return self._json({"ok": ok, "url": url, "view": view, "landed": landed,
                               "hwnd": _state["hwnd"]}, 200 if ok else 500)

        return self._json({"ok": False, "error": "not found"}, 404)


def start_control(port):
    """起控制端口(仅 127.0.0.1)。必须在窗口 shown 之后调 —— 处理器要 evaluate_js。"""
    try:
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", int(port)), _ControlHandler)
    except OSError as e:
        log(f"控制端口 {port} 起不来(外壳仍可用,只是托盘无法把页面送进来): {e!r}")
        return None
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, name="shell-control", daemon=True).start()
    log(f"control 已监听 127.0.0.1:{port}")
    return srv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:3346/", help="初始加载哪个页面")
    ap.add_argument("--view", default="", help="初始视图:" + "/".join(VIEWS))
    ap.add_argument("--control-port", type=int, default=0, help="本地控制端口(默认取配置 shell.port)")
    ap.add_argument("--no-mica", action="store_true")
    ap.add_argument("--allow-multi", action="store_true", help="忽略单实例锁(调试用)")
    args = ap.parse_args()
    view = args.view if args.view in VIEWS else ""

    # --url 指向"记忆总成 / 库管理"时不要塞进星图 iframe ——
    # 否则星图标签里显示的会是总成页面(实测踩过)。改成切到对应视图,但**保留目标 origin**:
    # 以前把 url 清空后,fr-agg/fr-mng 会回落到硬编码的 3346(LobeHub),
    # 用户点的是 3348(Full)却看到/改到 LobeHub 的库(2026-10-17 实测)。
    if args.url and ("aggregate.html" in args.url or "manage.html" in args.url):
        view = view or ("agg" if "aggregate.html" in args.url else "mng")
        u = urllib.parse.urlsplit(args.url)
        args.url = "%s://%s/?scope=federation&embed=1" % (u.scheme, u.netloc)

    port = control_port(args.control_port or None)

    if not args.allow_multi and not single_instance():
        # 已经有外壳在跑:把"打开哪个页面"转过去,自己退出 —— 点几次都只留一个窗口
        ok = forward(port, args.url, view, tries=1, delay=0) or forward(port, args.url, view)
        log(f"已有外壳在跑 → 转发 url={args.url} view={view} ok={ok}")
        return 0 if ok else 1

    _set_app_id()          # 必须在创建窗口前:决定任务栏身份与图标归属

    import webview

    if not os.path.exists(SHELL_HTML):
        log("找不到 shell.html: " + SHELL_HTML)
        return 1

    # 注入初始 URL(让外壳可以指向任意星图实例):改的是 #viz 的 data-src —— shell.html
    # 的懒加载就是按 data-src 载入的(src 初始是 about:blank)。
    html = open(SHELL_HTML, encoding="utf-8").read()
    if args.url:
        html = html.replace('data-src="http://127.0.0.1:3346/?embed=1"', f'data-src="{args.url}"')
    if view:
        # 初始视图:等页面把 pywebview/api 挂上再切(__nav 见 shell.html)
        html = html.replace("</body>",
                            '<script>setTimeout(function () { window.__nav && window.__nav("", %s); }, 900);</script>\n</body>'
                            % json.dumps(view))

    win = webview.create_window(
        TITLE, html=html,
        width=1180, height=760, min_size=(720, 480),
        background_color="#141619",
        js_api=Api(),
    )

    def on_shown(*_a):
        time.sleep(0.4)                      # 等窗口真正成型
        user32.FindWindowW.restype = wintypes.HWND          # 默认 c_int 会截断句柄
        user32.FindWindowW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]
        user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        hwnd = user32.FindWindowW(None, TITLE)
        if not hwnd:
            log("拿不到窗口句柄,跳过原生定制")
            return
        _state["hwnd"] = hwnd
        _state["win"] = win                  # 控制端口要靠它 evaluate_js
        _state["url"] = args.url
        _state["view"] = view
        _state["scale"] = _get_scale(hwnd)
        _apply_window_style(hwnd)
        dark, rnd, mica = _apply_dwm(hwnd, mica=not args.no_mica)
        ico = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "tray-icons", "brand", "max.ico")
        icon_ok = _set_window_icon(hwnd, ico) if os.path.exists(ico) else False
        ok = _install_hook(hwnd)
        log(f"aumid={_set_app_id()} hwnd={hwnd} scale={_state['scale']:.2f} dark={dark} round={rnd} mica={mica} hook={ok} icon={icon_ok}")
        start_control(port)

    win.events.shown += on_shown
    webview.start()
    return 0


if __name__ == "__main__":
    sys.exit(main())
