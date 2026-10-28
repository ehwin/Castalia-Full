# -*- coding: utf-8 -*-
"""Castalia 记忆服务守护(2026-09-15)

由 Windows 计划任务调用:**跑完即退,零常驻**。取代托盘里那个 8 秒定时器兼职看护。

职责
  1. 桥(3310/3312)端到端探活:端口在听 **且** 引擎子进程存在;
     空壳/掉线 → 清场重建 → 复验就绪(最多 25s,失败重试)。
  2. 星图(3344/3345/3346)端口探活,掉线则拉起。
  3. **LobeHub 消费的那座桥**重建过 → 重启 LobeHub 容器,清掉它缓存的失效 MCP 会话
     (只有 lobehub-bridge/3310 与它有关;别的桥重建不再连坐,2026-10-28 修)
     (否则界面一直报 memory_save failed / Session not found)。

为什么要独立出来(2026-09-14/15 事故)
  托盘是"无控制台的 GUI 进程兼职服务守护":批量启动时引擎握手慢于 mcp-proxy 的
  connectionTimeout → 桥变空壳(端口在听、引擎已死、tools/call 全 -32603),
  而旧代码"拉完不看结果" → 静默坏一整天。看护逻辑搬到短命脚本 + 系统调度器后,
  "进程活着但状态错"这类问题由每次运行重新判定,天然免疫。

用法
  python castalia_guard.py          # 巡检一次,有问题则修复(计划任务用这个)
  python castalia_guard.py --check  # 只报告不修复,退出码 0=健康 1=有问题
"""
import os
import sys
import time
import argparse

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS)

# LobeHub 只消费这一座桥(docker-compose 只放行 127.0.0.1:3310 的 SSRF 白名单),
# 所以"清 LobeHub 失效 MCP 会话"只对它的重建有意义。别的桥重建跟 LobeHub 无关。
LOBEHUB_BRIDGE_ID = "lobehub-bridge"


def lobehub_affected(rebuilt):
    """重建的桥里,有没有 LobeHub 真正消费的那座。(2026-10-28) """
    return LOBEHUB_BRIDGE_ID in (rebuilt or [])

try:
    import castalia_tray as tray
except Exception as e:
    print("castalia_guard: unable to load tray runtime: %s" % (e,), file=sys.stderr)
    raise SystemExit(2)

LOCK_FILE = os.path.join(SCRIPTS, "guard.lock")


def cleanup_orphan_engines(check_only=False):
    """清理父进程已消失的引擎进程(桥重启后 residue)。

    背景:引擎是 detached 进程,重建桥时只杀监听端口的 mcp-proxy,引擎不会被连带
    杀死 → 每次重建都会积下 ~130MB 的孤儿。星图进程同样"父死"但仍在正常服务,
    所以必须按命令行区分:只清 `dist/index.js` 的引擎,绝不动 `server.mjs` 星图。
    """
    try:
        import psutil
    except ImportError:
        return []
    node_name = os.path.basename(tray.NODE)
    victims = []
    for p in psutil.process_iter(["pid", "ppid", "name", "cmdline"]):
        try:
            if (p.info.get("name") or "").lower() != node_name.lower():
                continue
            args = " ".join(p.info.get("cmdline") or [])
            if "mcp-proxy" in args or "server.mjs" in args:
                continue                      # 桥代理 / 星图:不归这里管
            engine_paths = {os.path.normcase(os.path.abspath(os.path.join(b['cwd'], a))) for b in tray.BRIDGES
                            for a in b['cmd'] if a.endswith(('index.js', 'fedServer.js'))}
            proc_paths = {os.path.normcase(os.path.abspath(a)) for a in (p.info.get('cmdline') or [])
                          if a.endswith(('index.js', 'fedServer.js'))}
            if not engine_paths.intersection(proc_paths):
                continue
            try:
                psutil.Process(p.info["ppid"])   # 父还在 → 正常引擎
                continue
            except Exception:
                victims.append(p.info["pid"])
        except Exception:
            continue
    if not check_only:
        for pid in victims:
            try:
                psutil.Process(pid).kill()
            except Exception:
                pass
    return victims


def _acquire_single_instance():
    """文件锁:防两次运行重叠(重建最长可能 100s,而计划任务每 2 分钟一次)。"""
    try:
        import msvcrt
    except ImportError:
        return None
    fh = open(LOCK_FILE, "w")
    try:
        msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        return fh
    except OSError:
        fh.close()
        return False        # 已有实例在跑


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只检查不修复")
    ap.add_argument("--force", action="store_true",
                    help="忽略期望状态(托盘已停止服务时也强制修复)")
    args = ap.parse_args()
    log = tray.logger

    lock = _acquire_single_instance()
    if lock is False:
        log.info("guard: 已有实例在跑,跳过本轮")
        return 0
    if args.force and not args.check:
        tray.write_state('running', 'guard-force')
        for svc in tray.BRIDGES + tray.VIZ:
            tray.set_service_desired(svc, True)

    # ── 尊重"期望状态"(2026-10-02)──
    # 托盘"退出并停止记忆服务"后写 service-state.json desired=stopped;若不管它,
    # 看护会把桥/星图又拉起来(实测:退出进行到一半就被重建),两边互相打架。
    # 手动修复走 --force(刻意停下时也允许救活)。
    if not args.force:
        try:
            st = tray.read_state()
            if (st or {}).get("desired") == "stopped":
                log.info("guard: 期望状态=stopped(%s @ %s),跳过本轮;--force 可强制修复",
                         st.get("by", "?"), st.get("at", "?"))
                return 0
        except Exception as e:
            log.warning("guard: 读期望状态失败 %r(按 running 处理)", e)

    problems = []
    rebuilt = []
    warming = []                     # 刚被我们拉起、还在热身的组件(宽限期内不判不健康)
    GRACE = float(os.environ.get("GUARD_GRACE_SEC", "180"))

    # ── 0. 孤儿引擎清理(桥重建的 residue:不清理会一直涨内存)──
    try:
        orphans = cleanup_orphan_engines(check_only=args.check)
        if orphans:
            if args.check:
                problems.append(f"孤儿引擎 {len(orphans)} 个: {orphans}")
            else:
                log.warning("guard: 清理孤儿引擎 %s", orphans)
    except Exception as e:
        log.error("guard: 孤儿清理异常 %r", e)

    # ── 1. 桥:端口 + 引擎子进程双判定 ──
    for b in tray.BRIDGES:
        try:
            if not args.force and not tray.service_wanted(b):
                log.info("guard: 桥 %s 已按用户设置停用", b["id"])
                continue
            why = []
            if tray.bridge_healthy(b["port"], force=True, why=why):
                continue
            # 启动宽限期:刚被我们自己拉起过的组件(开机/重建后引擎握手期)不判不健康、不重建,
            # 避免"开机一次性拉起 → 立刻又被判坏 → 再重建"的来回抖动(2026-09-22 用户报"启动反复闪烁")。
            if tray.started_recently(f"bridge:{b['id']}", GRACE):
                warming.append(f"桥 {b['id']}")
                log.info("guard: 桥 %s 刚拉起(<%ds),热身中,本轮跳过", b["id"], int(GRACE))
                continue
            reason = "; ".join(why) or "原因未记录"
            problems.append(f"桥 {b['id']} 不健康({reason})")
            if args.check:
                continue
            log.warning("guard: 桥 %s 不健康(%s),开始重建", b["id"], reason)
            if tray._rebuild_bridge(b):
                rebuilt.append(b["id"])
            else:
                log.error("guard: 桥 %s 重建失败", b["id"])
        except Exception as e:
            log.error("guard: 桥 %s 巡检异常 %r", b["id"], e)

    # ── 2. 星图:端口探活(同样区分"刚拉起热身"与"真掉线") ──
    down = []
    for v in tray.VIZ:
        if not (args.force or tray.service_wanted(v)):
            continue
        why = []
        if tray.viz_status(v, why=why):
            continue
        log.warning("guard: 星图 :%s 判定掉线(%s)", v["port"], "; ".join(why) or "原因未记录")
        down.append(v)
    if down:
        warm = [v for v in down if tray.started_recently(f"viz:{v['port']}", GRACE)]
        real = [v for v in down if v not in warm]
        if warm:
            warming.append("星图 " + ", ".join(f":{v['port']}" for v in warm))
            log.info("guard: 星图 %s 刚拉起(<%ds),热身中,本轮跳过", [v["port"] for v in warm], int(GRACE))
        if real:
            problems.append("星图掉线: " + ", ".join(f":{v['port']}" for v in real))
            if not args.check:
                log.warning("guard: 星图掉线 %s,重新拉起", [v["port"] for v in real])
                try:
                    tray.start_viz(manual=False, services=real)
                except Exception as e:
                    log.error("guard: 星图拉起异常 %r", e)

    # ── 2.5 辅助服务：只看状态，绝不自动拉起 ──
    # 按需服务(AIRI 代理 / 本地嵌入 / Lemonade 分拣)常驻只会白烧内存与显存。
    # 这里只记日志,不启动 —— 启动入口只有托盘菜单与 castalia_tray.ensure_on_demand。
    for svc in [s for s in ([tray.AIRI_PROXY, tray.EMBED] + list(tray.C.EXTRAS)) if s]:
        try:
            # 常态(按需、没启动)不写日志 —— guard 每 2 分钟一轮,写下去就是刷屏。
            # 只有"用户明确启用却没跑起来"才算异常，提示一次让他去托盘点启动。
            if tray.service_wanted(svc) and not tray.service_up(svc):
                log.info("guard: 辅助服务 %s 已启用但未运行；按需服务不自动拉起，请在托盘里点启动", svc["id"])
        except Exception as e:
            log.error("guard: 辅助服务 %s 巡检异常 %r", svc.get("id"), e)

    # ── 3. 重建了 LobeHub 消费的那座桥 → 清它的失效 MCP 会话 ──
    # 只有 lobehub-bridge(3310) 是 LobeHub 连的桥(docker-compose 只放行 127.0.0.1:3310)。
    # 2026-10-28 之前这里不看是**哪座**桥重建,任何一座重建都重启整个 LobeHub 应用 ——
    # 实测 16:58 重建 hermes-bridge 也把 Container lobehub 重启了一遍,一次无关抖动
    # 变成用户可见的中断。
    if rebuilt and not args.check and not lobehub_affected(rebuilt):
        log.info("guard: 重建的是 %s,与 LobeHub 无关,跳过 lobe 重启", ", ".join(rebuilt))
        tray._notify("Castalia", "记忆桥异常已自愈: " + ", ".join(rebuilt))
    elif rebuilt and not args.check:
        try:
            if tray.lobehub_up():
                out = tray._wsl(
                    "cd %s && docker compose restart lobe 2>&1" % tray._lh_dir_wsl(), timeout=240)
                log.info("guard: restart lobe -> %s", out[-200:].replace("\n", " "))
                tray._lh_cache["t"] = 0
                tray._notify("Castalia", "记忆桥异常已自愈: " + ", ".join(rebuilt))
            else:
                log.info("guard: LobeHub 未运行,跳过会话清理")
                tray._notify("Castalia", "记忆桥异常已自愈: " + ", ".join(rebuilt))
        except Exception as e:
            log.error("guard: restart lobe 异常 %r", e)

    if warming:
        log.info("guard: 热身中(宽限 %ds,不判定不重建): %s", int(GRACE), "; ".join(warming))
    if problems:
        log.warning("guard: 本轮发现 %s", "; ".join(problems))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
