#!/usr/bin/env python
"""Hermes 会话记忆投喂 hook —— 把 Hermes(本机 harness)的会话转录**增量**投给记忆引擎。

为什么需要:记忆只在他端被自动投喂(LobeHub 有 lobehub_memory_hook / AIRI 有 unified-proxy),
Hermes 侧没有任何写入方 → memory-banks/hermes 长期停在 09-13(实测 conversation_log 最新 09-12、
无 session_memory),条数远低于另两端。

设计(照 lobehub_memory_hook.py 的成熟模式):
  · 游标 = `messages.id`(整数单调,比时间戳稳);状态存 hermes_hook_state.json
  · 只投"配对完整"的轮次:一条 user 消息 + 同会话紧随其后**真正的助手答复**
    (assistant 且 tool_calls 为空 —— 中间的工具调用轮不算答复)
  · 助手答复还没出现(当前轮还在跑)→ 停在该条,下轮再来(不推进游标)
  · 桥异常 → 不推进游标,直接返回(桥恢复后自动补录;这正是 LobeHub 那边踩过的坑)
  · 每次跑顺带 reflect_batch_embed 兜底,保证新记忆可被向量检索
  · 由 Windows 计划任务每 2 分钟跑一次 `--once`(短命进程,不留常驻)

源:`~/AppData/Local/hermes/state.db`(只读打开,不干扰 Hermes)
目标:castalia.config.json 里 id=hermes-bridge 的桥(默认 3316),调 auto_process
"""
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request

# 用户正文可能整段粘贴 API Key;落日志前必须脱敏(2026-10-17 在 hermes-hook.log 中实测发现)。
_SECRET_RE = re.compile(r"(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})", re.I)


def redact(text):
    def _mask(m):
        return "sk-***REDACTED***" if m.group(0).lower().startswith("sk-") else "Bearer ***REDACTED***"
    return _SECRET_RE.sub(_mask, str(text))

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(SCRIPT_DIR, "castalia.config.json")
STATE_FILE = os.path.join(SCRIPT_DIR, "hermes_hook_state.json")
LOG_FILE = os.path.join(SCRIPT_DIR, "hermes-hook.log")

DEFAULTS = {
    "bridgeId": "hermes-bridge",
    "db": os.path.join(os.environ.get("LOCALAPPDATA", ""), "hermes", "state.db"),
    "project": "hermes",
    "batch": 30,            # 每轮最多投喂多少轮对话(剩下的下一轮继续)
    "lookbackHours": 6,     # 首次安装时的回溯窗口,避免把整段历史一次性灌给 LLM
        "minChars": 2,          # 过滤空/占位消息
}


def log(msg):
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    try:
        # 品牌宿主是 PyInstaller 的 windowed exe(--noconsole):sys.stdout 为 None,print 会抛
        print(line)
    except Exception:
        pass


def load_config():
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}
    hk = dict(DEFAULTS)
    hk.update(data.get("hermesHook") or {})
    port = hk.get("port")
    for b in (data.get("bridges") or []):
        if b.get("id") == hk.get("bridgeId"):
            port = b.get("port") or port
    hk["port"] = int(port or 3316)
    hk["url"] = "http://127.0.0.1:%d/mcp" % hk["port"]
    hk["db"] = os.path.expandvars(os.path.expanduser(str(hk["db"])))
    return hk


def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            st = json.load(f)
        if isinstance(st.get("last_id"), int):
            return st
    except Exception:
        pass
    return {"last_id": None}


def save_state(st):
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(st, f, ensure_ascii=False)
    except Exception as e:
        log("save_state 失败: %r" % (e,))


def src_conn(hk):
    """只读打开 Hermes 的会话库(不写、不加锁影响 Hermes)"""
    return sqlite3.connect("file:%s?mode=ro" % hk["db"].replace("\\", "/"), uri=True, timeout=10)


def init_cursor(conn, hk):
    """首次运行:从 lookbackHours 之前开始,避免历史全量倾泻。

    游标语义是"只处理 id > last_id" → 取**窗口之前最后一条**的 id,窗口内的才会被投喂。
    (取窗口内最早那条会把整段窗口一起跳过 —— 首版就踩了这个。)
    """
    cutoff = time.time() - max(1, int(hk["lookbackHours"])) * 3600
    row = conn.execute("SELECT MAX(id) FROM messages WHERE timestamp < ?", (cutoff,)).fetchone()
    last = (row[0] if row and row[0] is not None else 0)
    st = {"last_id": int(last or 0), "initialized": time.strftime("%Y-%m-%dT%H:%M:%S")}
    save_state(st)
    log("首次初始化游标 last_id=%s(回溯 %sh,窗口内的轮次会接着投喂)" % (st["last_id"], hk["lookbackHours"]))
    return st


def fetch_batch(conn, last_id, hk):
    """取 last_id 之后、且已有"真答复"的轮次:(uid, session_id, user, answer_id, answer)"""
    sql = """
      SELECT u.id, u.session_id, u.content, a.id AS aid, a.content AS answer
      FROM messages u
      JOIN messages a ON a.id = (
        SELECT a1.id FROM messages a1
        WHERE a1.session_id = u.session_id AND a1.id > u.id AND a1.role = 'assistant'
          AND a1.tool_calls IS NULL AND length(COALESCE(a1.content, '')) > 0
        ORDER BY a1.id LIMIT 1)
      WHERE u.role = 'user' AND u.id > ? AND length(COALESCE(u.content, '')) >= ?
      ORDER BY u.id
      LIMIT ?
    """
    return conn.execute(sql, (int(last_id), int(hk["minChars"]), int(hk["batch"]))).fetchall()


def _rpc(url, payload, sid=""):
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if sid:
        headers["Mcp-Session-Id"] = sid
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        # 注意:响应头 key 是小写 mcp-session-id(大写会取到空 → 后续调用全 400)
        return (r.headers.get("Mcp-Session-Id") or r.headers.get("mcp-session-id") or ""), r.read().decode("utf-8", "replace")


def _parse(text):
    if "data:" in text:
        text = [l[5:] for l in text.splitlines() if l.startswith("data:")][0]
    return json.loads(text)


def call_tool(url, name, args):
    """调一次 MCP 工具;返回 (ok, 摘要)。桥返回 error 时 ok=False(上游据此不推进游标)"""
    try:
        sid, _ = _rpc(url, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                                       "clientInfo": {"name": "hermes-hook", "version": "1"}}})
        if not sid:
            return False, "initialize 未取到 session id"
        _rpc(url, {"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
        _, body = _rpc(url, {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                             "params": {"name": name, "arguments": args}}, sid)
        d = _parse(body)
        if "error" in d:
            return False, "MCP error %s" % json.dumps(d["error"], ensure_ascii=False)[:160]
        res = d.get("result") or {}
        if res.get("isError"):
            return False, "tool error %s" % str(res.get("content"))[:160]
        txt = ""
        try:
            txt = str((res.get("content") or [{}])[0].get("text", ""))[:120]
        except Exception:
            pass
        return True, txt
    except Exception as e:
        return False, "%s: %s" % (type(e).__name__, str(e)[:140])


def process_once(conn, hk, st):
    rows = fetch_batch(conn, st["last_id"], hk)
    if not rows:
        return 0
    done = 0
    for uid, session_id, user_text, aid, answer in rows:
        ok, info = call_tool(hk["url"], "auto_process", {
            "userMessage": user_text or "",
            "assistantMessage": answer or "",
            "sessionId": session_id,          # 会话缓冲键(渐进式临时反思靠它)
            "project": hk["project"],
        })
        if not ok:
            log("FAIL [%s] uid=%s %s" % (session_id[-6:], uid, info))
            return done                        # 桥异常 → 游标不推进,下轮重试
        done += 1
        log("OK [%s] uid=%s-%s '%s' → %s" % (session_id[-6:], uid, aid, redact(str(user_text))[:24].replace("\n", " "), info))
        st["last_id"] = int(aid)
        save_state(st)
    return done


def embed_pending(hk):
    ok, info = call_tool(hk["url"], "reflect_batch_embed", {})
    log(("嵌入 OK %s" % info) if ok else ("嵌入 FAIL %s" % info))


# ═══════════════════════════════════════════════════════════════════
# A-1 工具事件：把"跑了什么命令、结果如何"抽成可检索事件
#   旧 hook 只投喂 user + 最终答复(tool_calls IS NULL)，命令/报错/改动全丢。
#   这里从同一个 state.db 按 id 窗口抽工具调用，结果按 tool_call_id 关联。
#   只抽摘要(命令/退出码/错误首行/长度)，不抽完整输出 —— 全文留在 state.db。
# ═══════════════════════════════════════════════════════════════════

_ARGS_PATH_KEYS = ("file_path", "path", "filepath", "target", "directory", "cwd")


def _summarize_args(name, raw_args):
    """把工具参数压成一行人能读、检索能命中的摘要。"""
    s = raw_args if isinstance(raw_args, str) else json.dumps(raw_args, ensure_ascii=False)
    try:
        d = json.loads(s) if isinstance(s, str) else (s or {})
    except Exception:
        d = None
    if isinstance(d, dict):
        if isinstance(d.get("command"), str):
            return d["command"][:600]
        for k in _ARGS_PATH_KEYS:
            if isinstance(d.get(k), str):
                extra = ""
                if isinstance(d.get("old_string"), str):
                    extra = " | old: " + d["old_string"][:80].replace("\n", " ")
                return ("%s %s%s" % (name, d[k], extra))[:600]
        if isinstance(d.get("query"), str):
            return ("%s query=%s" % (name, d["query"]))[:600]
        if isinstance(d.get("code"), str):
            first = d["code"].strip().split("\n")[0]
            return ("%s %s" % (name, first))[:600]
        if isinstance(d.get("text"), str):
            return ("%s %s" % (name, d["text"][:200].replace("\n", " ")))[:600]
    return ("%s %s" % (name, s))[:600]


def _summarize_result(content):
    """从 tool 结果里抽 (exit_code, status, error_head, result_chars)。"""
    txt = content or ""
    n = len(txt)
    exit_code, status, err = None, "unknown", None
    try:
        d = json.loads(txt)
        if isinstance(d, dict):
            ec = d.get("exit_code", d.get("exitCode"))
            if isinstance(ec, int):
                exit_code = ec
            out = d.get("output") or d.get("stdout") or d.get("content") or ""
            e = d.get("error") or d.get("stderr") or ""
            bad = bool(d.get("success") is False or d.get("status") in ("error", "failed") or e
                       or (isinstance(ec, int) and ec != 0))
            status = "error" if bad else "ok"
            src = (e if isinstance(e, str) and e else (out if bad and isinstance(out, str) else ""))
            if not isinstance(src, str):
                src = json.dumps(src, ensure_ascii=False)
            if bad and src:
                err = src.strip().split("\n")[0][:200]
            if not bad and isinstance(out, str):
                pass
            return exit_code, status, err, n
    except Exception:
        pass
    low = txt[:400].lower()
    if low.startswith("error") or "traceback" in low or '"error"' in low:
        status = "error"
        err = txt.strip().split("\n")[0][:200]
    elif txt.strip():
        status = "ok"
    return exit_code, status, err, n


def _iso(ts):
    """state.db 的 timestamp 可能是 float(epoch) 或字符串，统一成 ISO。"""
    try:
        if isinstance(ts, (int, float)):
            sec = float(ts)
            if sec > 1e11:      # 毫秒
                sec /= 1000.0
            return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(sec)) + "Z"
        s = str(ts or "").strip()
        if not s:
            return ""
        if s.endswith("Z") or "T" in s:
            return s
        return s.replace(" ", "T") + "Z"
    except Exception:
        return ""


def fetch_tool_events(conn, from_id, to_id, limit_calls=400):
    """(from_id, to_id] 窗口里的工具调用 → 事件列表。"""
    calls = conn.execute("""
      SELECT id, session_id, tool_calls, timestamp FROM messages
      WHERE id > ? AND id <= ? AND tool_calls IS NOT NULL AND tool_calls <> ''
      ORDER BY id LIMIT ?
    """, (int(from_id), int(to_id), int(limit_calls))).fetchall()
    if not calls:
        return []
    wanted = {}
    for mid, sid, raw, ts in calls:
        try:
            arr = json.loads(raw)
        except Exception:
            continue
        for c in (arr or []):
            if not isinstance(c, dict):
                continue
            fn = c.get("function") or {}
            cid = c.get("call_id") or c.get("id")
            if not cid:
                continue
            wanted[cid] = {
                "turnId": str(mid), "sessionId": sid, "at": ts,
                "toolName": str(fn.get("name") or ""),
                "argsDigest": _summarize_args(str(fn.get("name") or ""), fn.get("arguments") or ""),
            }
    if not wanted:
        return []
    res = {}
    keys = list(wanted.keys())
    for i in range(0, len(keys), 200):
        chunk = keys[i:i + 200]
        q = "SELECT tool_call_id, content FROM messages WHERE role='tool' AND tool_call_id IN (%s)" % ",".join("?" * len(chunk))
        for tcid, content in conn.execute(q, chunk):
            res[tcid] = content or ""
    events = []
    for cid, meta in wanted.items():
        exit_code, status, err, rchars = _summarize_result(res.get(cid, ""))
        events.append({
            "toolName": meta["toolName"], "callId": cid, "argsDigest": meta["argsDigest"],
            "exitCode": exit_code, "status": status, "errorHead": err,
            "resultChars": rchars, "sessionId": meta["sessionId"], "turnId": meta["turnId"],
            "at": _iso(meta["at"]),
        })
    return events


def ingest_events(conn, hk, st):
    """把事件窗口推到桥。游标只在成功后推进(与对话投喂同一纪律)。"""
    final_id = st.get("last_id")
    if not isinstance(final_id, int):
        return 0
    cur = st.get("last_event_id")
    if not isinstance(cur, int):
        # 首次：只回填最近 N 条消息里的工具调用，不试图把整部历史灌进去
        back = int(hk.get("eventsBackfillMessages") or 5000)
        cur = max(0, final_id - back)
        st["last_event_id"] = cur
    if final_id <= cur:
        return 0
    events = fetch_tool_events(conn, cur, final_id)
    if not events:
        st["last_event_id"] = final_id
        save_state(st)
        return 0
    sent = 0
    for i in range(0, len(events), 100):
        chunk = events[i:i + 100]
        ok, info = call_tool(hk["url"], "events_ingest",
                             {"events": chunk, "project": hk["project"]})
        if not ok:
            log("events FAIL [%s-%s] %s" % (cur, final_id, info))
            save_state(st)          # 已发送部分不重复(按 callId 去重)，游标停在这里下轮重试
            return sent
        sent += len(chunk)
    st["last_event_id"] = final_id
    save_state(st)
    log("events OK 投喂 %d 条工具事件 (id %s→%s)" % (sent, cur, final_id))
    return sent



def main():
    # 2026-10-02:托盘"退出并停止记忆服务"后,桥是刻意停的 —— 别每 2 分钟刷一次失败日志。
    try:
        import json as _json
        with open(os.path.join(SCRIPT_DIR, "service-state.json"), encoding="utf-8") as _f:
            if (_json.load(_f) or {}).get("desired") == "stopped":
                log("跳过: 记忆服务已被刻意停止(service-state.json desired=stopped)")
                return 0
    except Exception:
        pass
    once = "--once" in sys.argv
    hk = load_config()
    log("开始%s: db=%s url=%s project=%s" % ("(--once)" if once else "", hk["db"], hk["url"], hk["project"]))
    if not os.path.exists(hk["db"]):
        log("源库不存在: %s(跳过)" % hk["db"])
        return 0
    if once:
        st = load_state()
        conn = src_conn(hk)
        try:
            if st.get("last_id") is None:
                st = init_cursor(conn, hk)
            total = 0
            for _ in range(200):                 # --once 也循环排空,直到没有新消息
                n = process_once(conn, hk, st)
                total += n
                if n == 0:
                    break
            embed_pending(hk)
            try:
                ingest_events(conn, hk, st)
            except Exception as e:
                log("events 异常: %r" % (e,))
            log("本轮结束: 投喂 %d 轮,游标 last_id=%s,event_id=%s" % (total, st.get("last_id"), st.get("last_event_id")))
            return 0
        finally:
            conn.close()
    # 常驻模式(轮询);计划任务用 --once,这里只为手工调试
    log("Hermes 记忆 hook 启动(轮询 20s)")
    while True:
        try:
            st = load_state()
            conn = src_conn(hk)
            try:
                if st.get("last_id") is None:
                    st = init_cursor(conn, hk)
                process_once(conn, hk, st)
                ingest_events(conn, hk, st)
            finally:
                conn.close()
            embed_pending(hk)
        except Exception as e:
            log("异常: %r (重试中)" % (e,))
        time.sleep(20)


if __name__ == "__main__":
    # 计划任务下是 pythonw(无控制台) → 任何未捕获异常都会静默变成退出码 1,必须落日志
    try:
        sys.exit(main() or 0)
    except Exception:
        import traceback
        log("致命异常:\n" + traceback.format_exc())
        sys.exit(1)
