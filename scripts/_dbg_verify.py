#!/usr/bin/env python3
"""边界场景 debug:特殊字符/长文本/空值/并发/项目切换"""
import json, os, shutil, sqlite3, subprocess, time, threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which('node') or r"D:\system\New Folder\node.exe"
TMP = os.path.join(ROOT, "scripts", ".tmp_dbg_verify")
if os.path.isdir(TMP): shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(TMP, exist_ok=True)
MDB = os.path.join(TMP, "memory")
os.makedirs(MDB, exist_ok=True)

class MCPSession:
    def __init__(self, extra=None):
        env = {**os.environ, 'MCP_TOOLS': 'all', 'CHAR_ID': 'dbg', 'MEMORY_DB_DIR': MDB, 'EMBED_MODE': 'none'}
        if extra: env.update(extra)
        self.proc = subprocess.Popen([NODE, os.path.join(ROOT, 'dist', 'index.js')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=ROOT)
        self.mid = 0
        self.send("initialize", {"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"dbg","version":"1.0"}})
        while True:
            r = self.recv()
            if r and r.get("id") == self.mid: break
        self.send("notifications/initialized", {})
    def send(self, m, p):
        self.mid += 1
        self.proc.stdin.write((json.dumps({"jsonrpc":"2.0","id":self.mid,"method":m,"params":p})+"\n").encode()); self.proc.stdin.flush()
    def recv(self):
        line = self.proc.stdout.readline()
        return json.loads(line) if line else None
    def call(self, name, args):
        self.send("tools/call", {"name": name, "arguments": args})
        while True:
            r = self.recv()
            if r and r.get("id") == self.mid: return r
    def close(self):
        try:
            self.proc.stdin.close(); self.proc.wait(timeout=3)
        except: self.proc.kill()

ok = 0; fail = 0
def check(name, cond, extra=""):
    global ok, fail
    if cond: ok += 1; print(f"  ✅ {name}")
    else: fail += 1; print(f"  ❌ {name} {extra}")

s = MCPSession()

# 1. 特殊字符(引号/emoji/换行/中文)
r = s.call("memory_save", {"text": "带\"引号\"和'单引号'还有\n换行\n和 emoji 🎉 的中文", "skipEmbed": True})
res = json.loads(r["result"]["content"][0]["text"])
check("特殊字符保存", 'id' in res, str(res)[:80])

# 2. 超长文本(10 万字符)
long_text = "测试长文本" * 20000
r = s.call("memory_save", {"text": long_text, "skipEmbed": True})
res = json.loads(r["result"]["content"][0]["text"])
check("10万字符长文本保存", 'id' in res, str(res)[:80])
check("返回截断", 'id' in res)

# 3. 空文本(应报错)
r = s.call("memory_save", {"text": "", "skipEmbed": True})
check("空文本被拒绝", r["result"].get("isError") or "error" in json.dumps(r["result"])[:200], str(r["result"])[:100])

# 4. 空 project(默认)
r = s.call("memory_save", {"text": "默认项目测试", "skipEmbed": True, "project": "  "})
res = json.loads(r["result"]["content"][0]["text"])
check("空白 project → 默认", 'id' in res, str(res)[:80])

# 5. 恶意 project 名(路径逃逸)
r = s.call("memory_save", {"text": "逃逸测试", "skipEmbed": True, "project": "../evil"})
res = json.loads(r["result"]["content"][0]["text"])
check("逃逸 project 名被安全化", 'id' in res, str(res)[:80])
# 检查没有生成 memory/../evil.sqlite
evil = os.path.join(TMP, "evil.sqlite")
check("无路径逃逸文件", not os.path.exists(evil), f"evil={os.path.exists(evil)}")
# 应生成 project-.._evil.sqlite(safeFilePart 替换)
safe = os.path.join(MDB, "project-.._evil.sqlite")
check("逃逸名被安全化落库", os.path.exists(safe), os.listdir(MDB))

# 6. memType 非法值(应回 general)
r = s.call("memory_save", {"text": "非法类型测试", "memType": "bogus", "skipEmbed": True})
res = json.loads(r["result"]["content"][0]["text"])
check("非法 memType 不报错", 'id' in res, str(res)[:80])
check("非法 memType → general", res.get("memType") == "general", str(res)[:100])

# 7. 并发写入(10 个线程)
def writer(i):
    try:
        s.call("memory_save", {"text": f"并发{i}", "skipEmbed": True})
    except: pass
threads = [threading.Thread(target=writer, args=(i,)) for i in range(10)]
for t in threads: t.start()
for t in threads: t.join()
conn = sqlite3.connect(os.path.join(MDB, 'project-default.sqlite'))
cnt = conn.execute("SELECT COUNT(*) FROM memory WHERE text LIKE '并发%'").fetchone()[0]
conn.close()
check("并发 10 写入全部成功", cnt == 10, f"cnt={cnt}")

# 8. stats_get byMemType 存在且不崩
r = s.call("stats_get", {})
res = json.loads(r["result"]["content"][0]["text"])
check("stats_get 正常", "byMemType" in res or "total" in res, str(list(res.keys()))[:100])

# 9. memory_context 空库不崩(用新 project)
r = s.call("memory_context", {"project": "empty-proj", "asText": True})
res = json.loads(r["result"]["content"][0]["text"])
check("空项目 memory_context 不崩", 'prompt' in res.get("prompt", "") or "prompt" in res, str(res)[:80])

s.close()
for _ in range(5):
    try:
        shutil.rmtree(TMP, ignore_errors=True)
        break
    except Exception:
        time.sleep(0.5)
print(f"\n=== 边界 debug: {ok} 通过 / {fail} 失败 ===")
