"""Shared desired state and process locks for tray and scheduled guard."""
import contextlib
import json
import os
import tempfile
import threading
import time

_local = threading.RLock()
_locks = {}

@contextlib.contextmanager
def file_lock(path, timeout=5):
    import msvcrt
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with _local:
        local_lock = _locks.setdefault(os.path.abspath(path), threading.RLock())
    with local_lock:
        with open(path, 'a+b') as handle:
            if os.path.getsize(path) == 0:
                handle.write(b'0'); handle.flush()
            deadline = time.monotonic() + timeout
            while True:
                try:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline: raise TimeoutError(path)
                    time.sleep(0.05)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)

def read(path):
    try:
        with open(path, encoding='utf-8') as handle:
            obj = json.load(handle)
        if not isinstance(obj, dict): raise ValueError('invalid desired state')
        if not isinstance(obj.get('services', {}), dict): raise ValueError('invalid services')
        if obj.get('desired', 'running') not in ('running', 'stopped'): raise ValueError('invalid desired')
        return obj
    except FileNotFoundError:
        return {}
    except (ValueError, OSError):
        # A corrupt state file must not silently revive deliberately stopped services.
        return {'desired': 'stopped', 'error': 'invalid desired state'}

def update(path, desired=None, services=None, by=''):
    with file_lock(path + '.lock'):
        state = read(path)
        if desired is not None: state['desired'] = desired
        state.setdefault('services', {}).update(services or {})
        state.update(by=by, pid=os.getpid(), at=time.strftime('%Y-%m-%dT%H:%M:%S'))
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.service-state-', suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                json.dump(state, handle, ensure_ascii=False); handle.flush(); os.fsync(handle.fileno())
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp): os.unlink(tmp)
        return state

def wanted(path, service_id):
    state = read(path)
    return state.get('desired') != 'stopped' and state.get('services', {}).get(service_id) != 'stopped'

def declared(path, service_id):
    """该服务是否被**显式**表达过意图（state 里有它的条目）。

    旧语义是"没写 stopped 就算 wanted" —— 于是每个服务默认都是"要跑"，辅助服务
    （AIRI 代理 / 本地嵌入 / Lemonade 分拣）天然变成常驻。按需服务需要区分
    "没人要过（按需，可被触发器拉起）" 与 "用户明确要跑" 两件事，所以单独暴露这个判定。
    """
    state = read(path)
    return service_id in (state.get('services') or {})
