#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 Lite 的 index.ts（已含 v1.24 全部改动）升级成 Full 的总线入口。

Full = 总线接口：Lite 入口 + 两个总线工具（reflect_all / memory_search_all）。
此前 index.ts 是 FULL_OWNED（不参与 sync_core），而生成它的 export_public.py 已经不在了，
于是 Lite 侧 v1.24 的入口改动（装箱/事件/血缘/索引摘要/启动补向量）一直没进 Full。

本脚本做四件事，然后断言幂等：
  1). 头注释改成总线入口
  2). 补 federation / reflectAll 的 import
  3). admin 组补 memory_search_all / reflect_all
  4). 把两个总线工具注册块原样搬进来（位置与旧 Full 一致：project_create 之后）

用法: python Castalia-Full/scripts/port_bus_entry.py [--check]
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LITE = ROOT / "Castalia" / "src" / "index.ts"
FULL = ROOT / "Castalia-Full" / "src" / "index.ts"

HEADER_OLD = "// Lite 版入口（由 export_public.py 从 index.ts 生成，去掉联邦 / 跨库反思两个 Full 专属工具）。"
HEADER_NEW = ("// 总线接口入口（Castalia-Full）：Lite 引擎入口 + 两个总线工具\n"
              "//   reflect_all        跨库总反思（写进 project=reflect）\n"
              "//   memory_search_all  联邦检索（成员来自 FEDERATION_MEMBERS，只读）\n"
              "// 除这两块以外，本文件应与 Castalia/src/index.ts 保持同源（sync_core.py 只同步核心模块，\n"
              "// 入口文件不参与同步，改 Lite 入口后请重跑 scripts/port_bus_entry.py）。")

IMPORT_ANCHOR = "import { packContext, deriveCaps, type PackSection } from './contextPack.js';"
IMPORT_NEW = (IMPORT_ANCHOR + "\n"
              "import { fedSearchAll, resolveFedLibraries } from './federation/index.js';\n"
              "import { runReflectAll } from './reflectAll.js';")

ADMIN_OLD = ("admin: ['memory_list', 'stats_get', 'recent_conversations', 'daily_summary_data', "
             "'reflect_analyze', 'reflect_apply', 'memory_context', 'context_get', 'project_list', "
             "'project_create', 'instruction_list', 'instruction_delete', 'consolidate_deep'],")
ADMIN_NEW = ("admin: ['memory_list', 'stats_get', 'recent_conversations', 'daily_summary_data', "
             "'reflect_analyze', 'reflect_apply', 'memory_context', 'context_get', 'project_list', "
             "'project_create', 'memory_search_all', 'instruction_list', 'instruction_delete', "
             "'consolidate_deep', 'reflect_all'],")

BUS_ANCHOR = """      });
    } catch (e: any) { return err(e.message, 'PROJECT_CREATE_FAILED'); }
  }
);
"""

BUS_BLOCK = """      });
    } catch (e: any) { return err(e.message, 'PROJECT_CREATE_FAILED'); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 总线接口（Full 专属）：总反思 + 联邦检索
//   · 两个工具都是"接口"，引擎不会自动合并任何库；跨库语义由调用方决定
//   · 源库只读打开，绝不写回；输出只落 project=reflect
// ═══════════════════════════════════════════════════════════════════

register(
  'reflect_all', 'admin',
  'Cross-library reflection & consolidation (non-destructive): scan active memories from every memory library (this instance + FEDERATION_DIRS external instances), let the LLM merge duplicates and distill high-value insights across libraries, then write the result into the dedicated project=reflect library (skipping already-existing texts). dryRun=true only analyzes without writing. Source libraries are opened read-only and never modified. Requires REFLECT LLM channel (config.json reflect section).',
  {
    maxTotal: z.number().optional().describe('Optional total sampling limit; omitted = all active memories. coverage reports deferred records.'),
    maxPerLib: z.number().optional().describe('Optional per-library sampling limit; omitted = all active memories'),
    dryRun: z.boolean().optional().describe('true = analyze only, do not write into reflect library (default false)'),
    projects: z.array(z.string()).optional().describe('Only reflect the specified project libraries (e.g. ["hermes"]); default = all libraries'),
  },
  async (args) => {
    try {
      const r = await runReflectAll({
        maxTotal: args.maxTotal,
        maxPerLib: args.maxPerLib,
        dryRun: args.dryRun,
        projects: args.projects,
      });
      return ok(r);
    } catch (e: any) { return err(e.message, 'REFLECT_ALL_FAILED'); }
  }
);

register(
  'memory_search_all', 'admin',
  'Federation search interface (read-only): searches this instance plus every member configured via FEDERATION_MEMBERS (or legacy FEDERATION_DIRS). Members may be local library dirs (transport=local-dir) or remote MCP endpoints (transport=mcp-http) — a member needs no code changes to be collected. Explicit semantics: the engine does NOT merge libraries automatically; the caller decides interop policy. Results carry \\"instance\\", \\"member\\", \\"project\\".',
  {
    query: z.string().describe('Query text'),
    topK: z.number().optional().describe('Max results per library (default 5)'),
    mode: z.enum(['text', 'vector']).optional().describe('text = LIKE substring search (default); vector = reserved for sqlite-vec KNN (falls back to text in this build)'),
  },
  async (args) => {
    try {
      const topK = Math.min(50, Math.max(1, Math.floor(Number(args.topK ?? 5)) || 5));
      // 接口化(v1.14):并发检索所有成员(本实例 + 配置的成员),
      // 成员可以是同机目录(local-dir)或 MCP 端点(mcp-http),单成员失败不影响整体。
      const { hits, members, errors } = await fedSearchAll(currentMemDir(), args.query, topK);
      return ok({
        op: 'memory_search_all',
        query: args.query,
        members,
        libraries: resolveFedLibraries(currentMemDir()).length,
        mode: args.mode === 'vector' ? 'text_fallback' : 'text',
        count: hits.length,
        results: hits.map(r => ({
          instance: r.instance,
          member: r.member,
          project: r.project,
          memType: r.memType,
          id: r.id,
          text: r.text,
          score: r.score,
          createdAt: r.createdAt,
        })),
        errors: errors.length ? errors : undefined,
        hint: '接口先行:互通语义未定,引擎不自动合并库。成员来自 FEDERATION_MEMBERS(推荐)或 FEDERATION_DIRS(兼容);transport 支持 local-dir 与 mcp-http。',
      });
    } catch (e: any) { return err(e.message, 'FEDERATION_FAILED'); }
  }
);
"""

# 总线入口的最小证据：这些标记缺一不可
MARKERS = ("packContext", "event_search", "events_ingest", "includeInactive", "PROMPT_BUDGET",
           "summarizeForIndex(row.summary, 150)", "eventStats", "memory_search_all", "reflect_all",
           "busTicks" if False else "fedSearchAll", "runReflectAll")


def _read(p: Path):
    """读文件并记录原始换行风格（仓库里 index.ts 是 CRLF，Lite 与 Full 必须一致，
    否则 git 会把整份文件记成改写）。"""
    raw = p.read_text(encoding="utf-8", newline="")
    crlf = "\r\n" in raw
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    return text, crlf


def build_text() -> str:
    text, crlf = _read(LITE)
    if HEADER_OLD not in text:
        raise SystemExit(f"Lite 入口缺少预期头注释，拒绝改写：{HEADER_OLD!r}")
    text = text.replace(HEADER_OLD, HEADER_NEW, 1)
    if IMPORT_ANCHOR not in text:
        raise SystemExit("找不到 contextPack 的 import 锚点，Lite 入口结构变了")
    text = text.replace(IMPORT_ANCHOR, IMPORT_NEW, 1)
    if ADMIN_OLD not in text:
        raise SystemExit("找不到 TOOL_GROUPS.admin 锚点，Lite 入口结构变了")
    text = text.replace(ADMIN_OLD, ADMIN_NEW, 1)
    if BUS_ANCHOR not in text:
        raise SystemExit("找不到 project_create 注册块的结尾锚点")
    text = text.replace(BUS_ANCHOR, BUS_BLOCK, 1)
    return text.replace("\n", "\r\n") if crlf else text


def main():
    new = build_text()
    missing = [m for m in MARKERS if m not in new]
    check_only = "--check" in sys.argv
    if missing:
        print(f"[port_bus_entry] 改写结果缺标记: {missing}")
        return 1
    if check_only:
        cur = FULL.read_text(encoding="utf-8", newline="") if FULL.is_file() else ""
        same = cur == new
        print(f"[port_bus_entry] check: {'已同步' if same else '与 Lite 漂移（需重跑）'}"
              f"  lines={new.count(chr(10))+1} markers={len(MARKERS)}")
        return 0 if same else 1
    FULL.write_text(new, encoding="utf-8", newline="")
    print(f"[port_bus_entry] 写入 {FULL.relative_to(ROOT)}  lines={new.count(chr(10))+1} markers={len(MARKERS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
