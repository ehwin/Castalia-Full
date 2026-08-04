#!/usr/bin/env node
/**
 * AI Memory MCP Server — standalone memory framework for agent harnesses
 *
 * 全部功能通过标准 MCP 协议暴露。
 * 工具分两类：搜索/存储类工具（LLM 可见），
 * 对话自动化/反思类工具（由 harness 或代理内部调用）。
 */
// ⚠️ 必须第一个 import:加载 config.json 覆盖环境变量(嵌入/反思配置)
import './configLoader.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchMemory, searchFacts, getRecentMemories } from './search.js';
import { saveMemory, forgetMemory, updateMemory, saveConversationTurn, cleanupExpiredMemories, batchEmbedPending } from './store.js';
import { consolidate } from './consolidate.js';
import { DatabaseManager } from './db.js';
import { getCategoryTree } from './category.js';
import { runDigest, getRecentConversations, maybeDigest } from './digest.js';
import { reflect, getAllMemories, getMemoryGraph, REFLECT_SYSTEM_PROMPT, getUnanalyzedConversations, applyReflectResult } from './reflect.js';
import { autoProcess } from './autoProcessor.js';
import { runAutoReflect, runDeepReflect } from './reflectDriver.js';
import { CHAR_ID, SERVER_NAME, SERVER_VERSION } from './env.js';

console.log = console.error;

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

function ok(data: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...data }, null, 2) }] };
}
function err(msg: string, code = 'ERROR') {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code, message: msg } }, null, 2) }], isError: true as const };
}

// ═══════════════════════════════════════════════════════════════════
// 搜索类工具（LLM 可见）
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'memory_search',
  'Search past memories using tag-first then vector KNN fallback. Use when recalling past events, facts, or user preferences.',
  {
    query: z.string().describe('What to search for'),
    topK: z.number().optional().describe('Max results (default 5)'),
    category: z.string().optional().describe('Filter by category'),
  },
  async (args) => {
    try {
      const r = await searchMemory({ query: args.query, topK: args.topK ?? 5, profile: 'balanced', category: args.category, characterId: CHAR_ID });
      return ok({
        op: 'search',
        query: args.query,
        count: r.length,
        results: r.map(m => ({
          id: m.id,
          text: m.text.length > 200 ? m.text.substring(0, 200) + '…' : m.text,
          truncated: m.text.length > 200,
          kind: m.type === 'episodic' ? 'episode' : m.type === 'semantic' ? 'reflection' : m.type,
          category: m.category,
          importance: m.importance,
          score: m.score,
          createdAt: m.createdAt,
        })),
        hint: '用 memory_get(id) 取完整内容',
      });
    } catch (e: any) { return err(e.message, 'SEARCH_FAILED'); }
  }
);

server.tool(
  'fact_search',
  'Search structured facts (subject-predicate-object triples) about the user.',
  {
    query: z.string().describe('Query text'),
    subject: z.enum(['user', 'agent', 'environment']).optional(),
    topK: z.number().optional().describe('Max results (default 5)'),
  },
  async (args) => {
    try {
      const r = await searchFacts(args.query, { subject: args.subject, topK: args.topK ?? 5, minConfidence: 0.3 });
      return ok({
        op: 'fact_search',
        query: args.query,
        count: r.length,
        results: r.map(f => ({
          id: f.id,
          subject: f.subject,
          predicate: f.predicate,
          object: f.object,
          confidence: f.confidence,
          similarity: f.similarity,
        })),
      });
    } catch (e: any) { return err(e.message, 'FACT_SEARCH_FAILED'); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 存储类工具
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'memory_save',
  'Store a new memory or update existing one by exact text match.',
  {
    text: z.string().describe('Memory content'),
    type: z.enum(['episodic', 'semantic', 'entity', 'preference']).optional().default('episodic'),
    category: z.string().optional().default('general'),
    tags: z.array(z.string()).optional().default([]),
    emotionalImpact: z.number().optional().default(0),
    importance: z.number().optional().default(0.5),
    tier: z.enum(['temporary', 'standard', 'critical']).optional().default('standard'),
    source: z.string().optional(),
    subject: z.enum(['user', 'self', 'environment']).optional().default('user'),
    skipEmbed: z.boolean().optional().default(false),
  },
  async (args) => {
    try {
      const r = await saveMemory({ text: args.text, type: args.type, category: args.category, tags: args.tags, emotionalImpact: args.emotionalImpact, importance: args.importance, tier: args.tier, source: args.source, subject: args.subject, characterId: CHAR_ID, skipEmbed: args.skipEmbed });
      return ok({ id: r.id, text: r.text.substring(0, 100), type: r.type, category: r.category });
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'memory_delete',
  'Soft-delete a memory by ID.',
  { id: z.string().describe('Memory ID to delete') },
  async (args) => {
    const ok_ = forgetMemory(args.id);
    return ok({ deleted: ok_ });
  }
);

server.tool(
  'memory_update',
  'Update memory fields (text, category, tags, importance, etc.).',
  {
    id: z.string().describe('Memory ID'),
    text: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.number().optional(),
    tier: z.string().optional(),
  },
  async (args) => {
    try {
      const r = await updateMemory(args.id, args as any);
      return ok(r ? { updated: true, id: r.id } : { updated: false, error: 'not found' });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 认知记录工具 — agent 显式沉淀(决策/模式/错误)
// 结构化认知:agent 边干活边"教"记忆体,跨会话复用
// 检索:memory_search(category=decision|pattern|mistake)
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'memory_log_decision',
  'Log an agent decision with rationale ("why I chose X"). Category=decision, searchable via memory_search(category=decision).',
  {
    text: z.string().describe('The decision and its rationale'),
    tags: z.array(z.string()).optional().describe('Optional tags'),
  },
  async (args) => {
    try {
      const r = await saveMemory({
        text: args.text, type: 'episodic', category: 'decision',
        tags: args.tags ?? [], importance: 0.6, tier: 'standard',
        source: 'agent_log', characterId: CHAR_ID,
      });
      return ok({ id: r.id, category: 'decision' });
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'memory_log_pattern',
  'Log a pattern or insight discovered ("I found that X leads to Y"). Category=knowledge+pattern tag, searchable via memory_search.',
  {
    text: z.string().describe('The pattern/insight'),
    tags: z.array(z.string()).optional().describe('Optional tags'),
  },
  async (args) => {
    try {
      const r = await saveMemory({
        text: args.text, type: 'semantic', category: 'knowledge',
        tags: ['pattern', ...(args.tags ?? [])], importance: 0.6, tier: 'standard',
        source: 'agent_log', characterId: CHAR_ID,
      });
      return ok({ id: r.id, category: 'knowledge' });
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'memory_log_mistake',
  'Log a mistake/lesson learned ("this trap cost me time, avoid it"). Category=mistake, tier=critical (protected from cleanup).',
  {
    text: z.string().describe('The mistake and the lesson'),
    tags: z.array(z.string()).optional().describe('Optional tags'),
  },
  async (args) => {
    try {
      const r = await saveMemory({
        text: args.text, type: 'episodic', category: 'mistake',
        tags: args.tags ?? [], importance: 0.7, tier: 'critical',
        source: 'agent_log', characterId: CHAR_ID,
      });
      return ok({ id: r.id, category: 'mistake', tier: 'critical' });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 对话自动化工具（proxy.py 内部调用）
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'auto_process',
  '[Internal] Process a conversation turn: save to log, update agent mood, observe user, queue VAD analysis. Called automatically after each LLM response.',
  {
    userMessage: z.string(),
    assistantMessage: z.string(),
    moodValue: z.number().optional(),
    moodReason: z.string().optional(),
  },
  async (args) => {
    try {
      const r = await autoProcess({ userMessage: args.userMessage, assistantMessage: args.assistantMessage, characterId: CHAR_ID, moodValue: args.moodValue, moodReason: args.moodReason });
      // Trigger event-driven digest
      maybeDigest(CHAR_ID)?.catch(() => {});
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'digest_run',
  '[Internal] Run the digest cycle: flush VAD queue, cleanup expired memories, restore lost critical memories.',
  {},
  async () => {
    try {
      const r = await runDigest(CHAR_ID);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'conversation_save',
  '[Internal] Save a raw conversation turn to the log (no analysis, no embedding).',
  {
    userMessage: z.string(),
    assistantMessage: z.string(),
    moodValue: z.number().optional(),
    moodReason: z.string().optional(),
  },
  async (args) => {
    try {
      const r = await saveConversationTurn(args.userMessage, args.assistantMessage, CHAR_ID, args.moodValue, args.moodReason);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 上下文/状态工具
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'context_get',
  'Get memory context summary: recent memories + stats, for prompt injection.',
  {},
  async () => {
    try {
      const db = DatabaseManager.getInstance();
      const recent = getRecentMemories(CHAR_ID, 5, 24);
      const stats = db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active=1').get() as any;
      return ok({
        recentMemories: recent.map(m => ({ text: m.text, category: m.category, importance: m.importance, createdAt: m.createdAt })),
        stats: { total: stats.c },
      });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 上下文包工具 — 借鉴 engram mem_context / memory-os fabric_brief
// 一次调用拿到组装好的注入上下文:近期 + 相关 + 认知记录 + 事实
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'memory_context',
  'Assemble an injection-ready context bundle: recent important memories + memories related to the current task (optional query) + cognitive logs (decisions/mistakes/patterns) + key facts. Call at session start or when you need memory context.',
  {
    query: z.string().optional().describe('Current task/topic to find related memories (optional)'),
    hoursBack: z.number().optional().describe('Window for recent memories (default 48h)'),
    recentLimit: z.number().optional().describe('Max recent memories (default 5)'),
    relatedLimit: z.number().optional().describe('Max related memories (default 5)'),
    asText: z.boolean().optional().describe('Return ready-to-inject prompt text (default true)'),
  },
  async (args) => {
    try {
      const db = DatabaseManager.getInstance();
      const hoursBack = args.hoursBack ?? 48;
      const recentLimit = args.recentLimit ?? 5;
      const relatedLimit = args.relatedLimit ?? 5;

      // 1. 近期重要记忆
      const recent = getRecentMemories(CHAR_ID, recentLimit, hoursBack);

      // 2. 与当前任务相关的记忆(向量搜索)
      let related: any[] = [];
      if (args.query) {
        const r = await searchMemory({ query: args.query, topK: relatedLimit, profile: 'balanced', characterId: CHAR_ID });
        related = r.map(m => ({ text: m.text, category: m.category, importance: m.importance, score: m.score, createdAt: m.createdAt }));
      }

      // 3. 认知记录(决策/错误/模式)
      const cognitiveCats = ['decision', 'mistake'];
      const cognitives = db.prepare(`
        SELECT text, category, importance, created_at FROM memory
        WHERE is_active = 1 AND character_id = ?
          AND (category IN ('decision','mistake') OR tags LIKE '%pattern%')
        ORDER BY created_at DESC LIMIT 9
      `).all(CHAR_ID) as any[];

      // 4. 关键事实(高置信度)
      const facts = db.prepare(`
        SELECT subject, predicate, object, confidence FROM facts
        WHERE is_active = 1 AND confidence >= 0.7
        ORDER BY confidence DESC, created_at DESC LIMIT 5
      `).all() as any[];

      const stats = db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active=1').get() as any;

      // 5. Ground Truth 提示词组装
      const sections: string[] = [];
      sections.push(`【当前记忆上下文】总记忆 ${stats.c} 条。请优先参考以下记忆,它们是之前会话沉淀的事实与经验:`);

      if (recent.length > 0) {
        sections.push(`\n■ 近期重要记忆(近 ${hoursBack} 小时):`);
        recent.forEach((m: any, i: number) => {
          sections.push(`${i + 1}. [${m.category}] ${m.text}${m.importance >= 0.8 ? ' (重要)' : ''}`);
        });
      }

      if (related.length > 0) {
        sections.push(`\n■ 与当前任务相关:「${args.query}」`);
        related.forEach((m: any, i: number) => {
          sections.push(`${i + 1}. [${m.category}] ${m.text}`);
        });
      }

      if (cognitives.length > 0) {
        sections.push(`\n■ 经验沉淀(决策/错误/模式):`);
        cognitives.forEach((m: any, i: number) => {
          const tag = m.category === 'mistake' ? '⚠️教训' : m.category === 'decision' ? '🎯决策' : '📐模式';
          sections.push(`${i + 1}. ${tag} ${m.text}`);
        });
      }

      if (facts.length > 0) {
        sections.push(`\n■ 已知事实:`);
        facts.forEach((f: any, i: number) => {
          sections.push(`${i + 1}. ${f.subject} — ${f.predicate}: ${f.object}`);
        });
      }

      sections.push(`\n【要求】以上记忆来自用户的真实历史,与当前任务相关时请直接使用,不要重新询问用户已知信息。`);

      const bundle = {
        prompt: sections.join('\n'),
        recent: recent.map(m => ({ text: m.text, category: m.category, importance: m.importance, createdAt: m.createdAt })),
        related,
        cognitives: cognitives.map(m => ({ text: m.text, category: m.category })),
        facts,
        stats: { total: stats.c },
        injectedAt: new Date().toISOString(),
      };

      return ok(args.asText === false ? bundle : { prompt: bundle.prompt });
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'stats_get',
  'Get memory system statistics: total count, by category, by source.',
  {},
  async () => {
    try {
      const db = DatabaseManager.getInstance();
      const total = db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active=1').get() as any;
      return ok({
        total: total.c,
        byCategory: db.prepare('SELECT category,COUNT(*) as c FROM memory WHERE is_active=1 GROUP BY category').all(),
        bySource: db.prepare('SELECT source,COUNT(*) as c FROM memory WHERE is_active=1 GROUP BY source').all(),
      });
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'mood_journal',
  'Get mood history for the past N days.',
  { days: z.number().optional().default(7) },
  async (args) => {
    try {
      const db = DatabaseManager.getInstance();
      const since = new Date(Date.now() - (args.days || 7) * 86400000).toISOString();
      return ok({
        days: args.days,
        moods: db.prepare("SELECT emotional_impact as value, created_at, text, category FROM memory WHERE is_active=1 AND (category='emotional' OR category='mood_snapshot' OR tier='temporary') AND created_at>? ORDER BY created_at DESC LIMIT 30").all(since),
      });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 记忆列表/图谱工具
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'memory_list',
  'List all active memories, optionally filtered.',
  {
    limit: z.number().optional().default(200),
    category: z.string().optional(),
    source: z.string().optional(),
  },
  async (args) => {
    try {
      const memories = getAllMemories(CHAR_ID, args.limit);
      let filtered = memories;
      if (args.category) filtered = filtered.filter((m: any) => m.category === args.category);
      if (args.source) filtered = filtered.filter((m: any) => m.source === args.source);
      const sliced = filtered.slice(0, args.limit);
      return ok({
        op: 'list',
        count: sliced.length,
        results: sliced.map(m => ({
          id: m.id,
          text: m.text.length > 200 ? m.text.substring(0, 200) + '…' : m.text,
          truncated: m.text.length > 200,
          category: m.category,
          importance: m.importance,
          createdAt: m.createdAt,
        })),
        hint: '用 memory_get(id) 取完整内容',
      });
    } catch (e: any) { return err(e.message, 'LIST_FAILED'); }
  }
);

server.tool(
  'memory_get',
  'Get one memory by ID with full text. Use to expand a search/recent/list result.',
  { id: z.string().describe('Memory ID') },
  async (args) => {
    try {
      const db = DatabaseManager.getInstance();
      const row = db.prepare('SELECT * FROM memory WHERE id = ? AND is_active = 1').get(args.id) as any;
      if (!row) return err('memory not found: ' + args.id, 'NOT_FOUND');
      return ok({
        op: 'get',
        result: {
          id: row.id,
          text: row.text,
          truncated: false,
          type: row.type,
          category: row.category,
          tags: JSON.parse(row.tags || '[]'),
          importance: row.importance,
          tier: row.tier,
          source: row.source,
          subject: row.subject,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          metadata: {
            emotionalImpact: row.emotional_impact,
            accessedCount: row.accessed_count,
            referenceCount: row.reference_count,
            locked: row.locked === 1,
          },
        },
      });
    } catch (e: any) { return err(e.message, 'GET_FAILED'); }
  }
);

server.tool(
  'memory_graph',
  'Get the memory relationship graph.',
  {},
  async () => {
    try {
      return ok(getMemoryGraph(CHAR_ID));
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'memory_recent',
  'Get recent important memories (no vector search, just time+importance).',
  {
    limit: z.number().optional().default(5),
    hoursBack: z.number().optional().default(24),
  },
  async (args) => {
    try {
      const r = getRecentMemories(CHAR_ID, args.limit, args.hoursBack);
      return ok({
        op: 'recent',
        count: r.length,
        results: r.map(m => ({
          id: m.id,
          text: m.text.length > 200 ? m.text.substring(0, 200) + '…' : m.text,
          truncated: m.text.length > 200,
          category: m.category,
          importance: m.importance,
          createdAt: m.createdAt,
        })),
        hint: '用 memory_get(id) 取完整内容',
      });
    } catch (e: any) { return err(e.message, 'RECENT_FAILED'); }
  }
);

server.tool(
  'recent_conversations',
  'Get recent conversation log entries.',
  {
    hoursBack: z.number().optional().default(24),
    limit: z.number().optional().default(50),
  },
  async (args) => {
    try {
      const r = getRecentConversations(CHAR_ID, args.hoursBack, args.limit);
      return ok({ count: r.length, results: r });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 反思工具
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'reflect_analyze',
  'Get unanalyzed conversations bundled with system prompt for a big LLM to perform reflection.',
  { limit: z.number().optional().default(30) },
  async (args) => {
    try {
      const conversations = getUnanalyzedConversations(CHAR_ID, undefined, args.limit ?? 30);
      const prompt = conversations.map((c: any) => c.text).join('\n---\n');
      return ok({
        conversationCount: conversations.length,
        systemPrompt: REFLECT_SYSTEM_PROMPT,
        userPrompt: `请分析以下对话，输出反思JSON：\n\n${prompt.substring(0, 30000)}`,
        conversationIds: conversations.map((c: any) => c.id),
      });
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'reflect_apply',
  'Apply reflection results (merge, extract, reclassify, delete actions).',
  {
    action: z.enum(['apply', 'preview']).optional().default('apply'),
    actions: z.string().describe('JSON array of reflection actions'),
  },
  async (args) => {
    try {
      let parsed: any;
      try {
        parsed = JSON.parse(args.actions);
      } catch {
        const m = args.actions.match(/```(?:json)?\s*([\s\S]*?)```/);
        parsed = m ? JSON.parse(m[1]) : JSON.parse(args.actions);
      }
      const r = await reflect(args.action, { actions: parsed });
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'reflect_auto',
  'Run automatic reflection: feed unanalyzed conversations to the configured LLM, apply extracted memories/digest. Requires REFLECT_LLM_API_KEY.',
  { limit: z.number().optional().default(30) },
  async (args) => {
    try {
      const r = await runAutoReflect(CHAR_ID, args.limit ?? 30);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'reflect_deep',
  'Run deep calibration: feed ALL memories to the configured LLM for dedup/profile/graph actions. Requires REFLECT_LLM_API_KEY.',
  { limit: z.number().optional().default(500) },
  async (args) => {
    try {
      const r = await runDeepReflect(CHAR_ID, args.limit ?? 500);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

server.tool(
  'reflect_batch_embed',
  '[Internal] Batch embed all pending (un-embedded) memories. Called after reflect.',
  {},
  async () => {
    try {
      const r = await batchEmbedPending(CHAR_ID);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 每日摘要工具
// ═══════════════════════════════════════════════════════════════════

server.tool(
  'daily_summary_data',
  'Get conversation and auto-process data for the past N hours.',
  { hoursBack: z.number().optional().default(24) },
  async (args) => {
    try {
      const db = DatabaseManager.getInstance();
      const since = new Date(Date.now() - (args.hoursBack || 24) * 3600000).toISOString();
      const convs = db.prepare("SELECT text FROM memory WHERE is_active=1 AND source='conversation_log' AND created_at>? ORDER BY created_at ASC LIMIT 100").all(since).map((r: any) => r.text);
      const aps = db.prepare("SELECT text FROM memory WHERE is_active=1 AND source='auto_process' AND created_at>? ORDER BY created_at ASC LIMIT 50").all(since).map((r: any) => r.text);
      return ok({ conversations: [...convs, ...aps] });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════

async function main() {
  // Agent state: nothing to flush (in-memory only)

  // Consolidate every 24 hours
  setInterval(() => { consolidate().catch(() => {}); }, 24 * 60 * 60 * 1000);

  // Event-driven digest check every 1 minute
  setInterval(() => {
    maybeDigest(CHAR_ID)?.catch((e: any) => console.error('digest error:', e));
  }, 60 * 1000);

  // WAL checkpoint every 30 minutes
  setInterval(() => {
    try {
      const r = DatabaseManager.checkpoint();
      if (r.pages > 0) console.error('[db] WAL checkpoint:', r.pages, 'pages');
    } catch {}
  }, 30 * 60 * 1000);

  // Cleanup expired every 30 minutes
  setInterval(() => {
    const cleaned = cleanupExpiredMemories();
    if (cleaned > 0) console.error(`[ai-memory] cleaned ${cleaned} expired temporary memories`);
  }, 30 * 60 * 1000);

  // Auto-reflect every N hours (REFLECT_INTERVAL_HOURS > 0 enables)
  const reflectIntervalHours = parseFloat(process.env.REFLECT_INTERVAL_HOURS || '0');
  if (reflectIntervalHours > 0) {
    const runOnce = () => {
      runAutoReflect(CHAR_ID).then(r => {
        if (r.skipped) return;
        console.error(`[reflect-auto] applied ${r.applied}/${r.actions} actions, errors: ${r.errors.length}`);
      }).catch((e: any) => console.error('[reflect-auto] error:', e.message));
    };
    setInterval(runOnce, reflectIntervalHours * 3600 * 1000);
    console.error(`[ai-memory] auto-reflect every ${reflectIntervalHours}h`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[airi-memory] v5.0.0 started — unified MCP server (proxy + LLM tools)');

  process.on('SIGINT', () => { DatabaseManager.close(); process.exit(0); });
  process.on('SIGTERM', () => { DatabaseManager.close(); process.exit(0); });
}

main();
