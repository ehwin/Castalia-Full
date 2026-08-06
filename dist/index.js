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
import { runDigest, getRecentConversations, maybeDigest } from './digest.js';
import { reflect, getAllMemories, getMemoryGraph, REFLECT_SYSTEM_PROMPT, getUnanalyzedConversations } from './reflect.js';
import { autoProcess } from './autoProcessor.js';
import { runAutoReflect, runDeepReflect } from './reflectDriver.js';
import { ensureSeedInstructions, saveInstruction, getInstruction, listInstructions, deleteInstruction } from './instructions.js';
import { CHAR_ID, PROJECT_ID, SERVER_NAME, SERVER_VERSION, normalizeProject } from './env.js';
console.log = console.error;
const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...data }, null, 2) }] };
}
function err(msg, code = 'ERROR') {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message: msg } }, null, 2) }], isError: true };
}
// ═══════════════════════════════════════════════════════════════════
// 工具分级(借鉴 engram ProfileAgent/ProfileAdmin)
// 暴露面原则:主 Agent 只读(search/get/recent/fact/graph),
// 写入与管线工具归 harness,管理工具归 admin(console)。
// 环境变量 MCP_TOOLS: 逗号分隔的 profile 或工具名;默认 'agent'(agent 友好)。
//   MCP_TOOLS=all  → 全部注册(向后兼容)
//   MCP_TOOLS=agent,admin → agent + admin 两组
// ═══════════════════════════════════════════════════════════════════
const TOOL_GROUPS = {
    agent: ['memory_search', 'memory_get', 'memory_recent', 'fact_search', 'memory_graph'],
    harness: ['auto_process', 'conversation_save', 'digest_run', 'reflect_auto', 'reflect_deep', 'reflect_batch_embed', 'memory_save', 'memory_update', 'memory_delete', 'memory_log', 'instruction_save'],
    admin: ['memory_list', 'stats_get', 'recent_conversations', 'daily_summary_data', 'reflect_analyze', 'reflect_apply', 'memory_context', 'context_get', 'project_list', 'instruction_list', 'instruction_delete'],
};
function resolveTools(input) {
    if (!input || input === 'all')
        return null; // null = 注册全部
    const result = new Set();
    for (const token of input.split(',').map(t => t.trim())) {
        if (token === 'all')
            return null;
        if (TOOL_GROUPS[token])
            TOOL_GROUPS[token].forEach(t => result.add(t));
        else
            result.add(token);
    }
    return result;
}
const TOOL_ALLOWLIST = resolveTools(process.env.MCP_TOOLS);
const TOOL_GROUP_OF = {};
for (const [g, tools] of Object.entries(TOOL_GROUPS))
    for (const t of tools)
        TOOL_GROUP_OF[t] = g;
function shouldRegister(name) {
    if (TOOL_ALLOWLIST === null)
        return true;
    if (TOOL_ALLOWLIST.has(name))
        return true;
    if (TOOL_ALLOWLIST.has('admin') || TOOL_ALLOWLIST.has('harness') || TOOL_ALLOWLIST.has('agent'))
        return false; // profile 已展开,不再匹配
    return false;
}
function register(name, group, description, schema, handler) {
    if (!shouldRegister(name)) {
        if (process.env.MCP_LOG_TOOLS === '1')
            console.error(`[tools] skipped: ${name} (group=${group})`);
        return;
    }
    server.tool(name, description, schema, handler);
}
// ═══════════════════════════════════════════════════════════════════
// 搜索类工具（LLM 可见）
// ═══════════════════════════════════════════════════════════════════
register('memory_search', 'agent', 'Search past memories using tag-first then vector KNN fallback. Use when recalling past events, facts, or user preferences.', {
    query: z.string().describe('What to search for'),
    topK: z.number().optional().describe('Max results (default 5)'),
    category: z.string().optional().describe('Filter by category'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
}, async (args) => {
    try {
        const r = await searchMemory({ query: args.query, topK: args.topK ?? 5, profile: 'balanced', category: args.category, characterId: CHAR_ID, project: args.project });
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
    }
    catch (e) {
        return err(e.message, 'SEARCH_FAILED');
    }
});
register('fact_search', 'agent', 'Search structured facts (subject-predicate-object triples) about the user.', {
    query: z.string().describe('Query text'),
    subject: z.enum(['user', 'agent', 'environment']).optional(),
    topK: z.number().optional().describe('Max results (default 5)'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
}, async (args) => {
    try {
        const r = await searchFacts(args.query, { subject: args.subject, topK: args.topK ?? 5, minConfidence: 0.3, project: args.project });
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
    }
    catch (e) {
        return err(e.message, 'FACT_SEARCH_FAILED');
    }
});
// ═══════════════════════════════════════════════════════════════════
// 存储类工具
// ═══════════════════════════════════════════════════════════════════
register('memory_save', 'harness', 'Store a new memory or update existing one by exact text match.', {
    text: z.string().describe('Memory content'),
    type: z.enum(['episodic', 'semantic', 'entity', 'preference']).optional().default('episodic'),
    category: z.string().optional().default('general'),
    tags: z.array(z.string()).optional().default([]),
    importance: z.number().optional().default(0.5),
    tier: z.enum(['temporary', 'standard', 'critical']).optional().default('standard'),
    source: z.string().optional(),
    subject: z.enum(['user', 'self', 'environment']).optional().default('user'),
    skipEmbed: z.boolean().optional().default(false),
    expiresAt: z.string().optional().describe('Custom expiration (ISO datetime) for temporary memories. Overrides the default 3-day TTL. Also honored on standard/critical tiers when explicitly set.'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
}, async (args) => {
    try {
        const r = await saveMemory({ text: args.text, project: args.project, type: args.type, category: args.category, tags: args.tags, importance: args.importance, tier: args.tier, source: args.source, subject: args.subject, characterId: CHAR_ID, skipEmbed: args.skipEmbed, expiresAt: args.expiresAt });
        return ok({ id: r.id, text: r.text.substring(0, 100), type: r.type, category: r.category });
    }
    catch (e) {
        return err(e.message);
    }
});
register('memory_delete', 'harness', 'Soft-delete a memory by ID.', { id: z.string().describe('Memory ID to delete') }, async (args) => {
    const ok_ = forgetMemory(args.id);
    return ok({ deleted: ok_ });
});
register('memory_update', 'harness', 'Update memory fields (text, category, tags, importance, etc.).', {
    id: z.string().describe('Memory ID'),
    text: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.number().optional(),
    tier: z.string().optional(),
}, async (args) => {
    try {
        const r = await updateMemory(args.id, args);
        return ok(r ? { updated: true, id: r.id } : { updated: false, error: 'not found' });
    }
    catch (e) {
        return err(e.message);
    }
});
// ═══════════════════════════════════════════════════════════════════
// 认知记录工具 — agent 显式沉淀(决策/模式/错误)
// 结构化认知:agent 边干活边"教"记忆体,跨会话复用
// 检索:memory_search(category=decision|pattern|mistake)
// ═══════════════════════════════════════════════════════════════════
register('memory_log', 'harness', 'Log a cognitive entry (decision/pattern/mistake) with kind. Internal mapping: decision→category=decision, pattern→knowledge+tag, mistake→category=mistake+tier=critical. Searchable via memory_search(category=...).', {
    kind: z.enum(['decision', 'pattern', 'mistake']).describe('Kind of cognitive entry'),
    text: z.string().max(2000).describe('The content: decision rationale / pattern insight / mistake lesson'),
    tags: z.array(z.string()).optional().describe('Optional tags'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
}, async (args) => {
    try {
        const kind = args.kind;
        const map = {
            decision: { type: 'episodic', category: 'decision', importance: 0.6, tier: 'standard', tags: args.tags ?? [] },
            pattern: { type: 'semantic', category: 'knowledge', importance: 0.6, tier: 'standard', tags: ['pattern', ...(args.tags ?? [])] },
            mistake: { type: 'episodic', category: 'mistake', importance: 0.7, tier: 'critical', tags: args.tags ?? [] },
        };
        const conf = map[kind];
        const r = await saveMemory({
            text: args.text, project: args.project, type: conf.type, category: conf.category,
            tags: conf.tags, importance: conf.importance, tier: conf.tier,
            source: 'agent_log', characterId: CHAR_ID,
        });
        return ok({ id: r.id, kind, category: conf.category, tier: conf.tier });
    }
    catch (e) {
        return err(e.message, 'LOG_FAILED');
    }
});
// ═══════════════════════════════════════════════════════════════════
// 对话自动化工具（proxy.py 内部调用）
// ═══════════════════════════════════════════════════════════════════
register('auto_process', 'harness', '[Internal] Process a conversation turn: save to log, update agent mood, observe user, queue VAD analysis. Called automatically after each LLM response.', {
    userMessage: z.string(),
    assistantMessage: z.string(),
    moodValue: z.number().optional(),
    moodReason: z.string().optional(),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
}, async (args) => {
    try {
        const r = await autoProcess({ userMessage: args.userMessage, assistantMessage: args.assistantMessage, characterId: CHAR_ID, moodValue: args.moodValue, moodReason: args.moodReason, project: args.project });
        // Trigger event-driven digest
        maybeDigest(CHAR_ID)?.catch(() => { });
        return ok(r);
    }
    catch (e) {
        return err(e.message);
    }
});
register('digest_run', 'harness', '[Internal] Run the digest cycle: flush VAD queue, cleanup expired memories, restore lost critical memories.', {}, async () => {
    try {
        const r = await runDigest(CHAR_ID);
        return ok(r);
    }
    catch (e) {
        return err(e.message);
    }
});
register('conversation_save', 'harness', '[Internal] Save a raw conversation turn to the log (no analysis, no embedding).', {
    userMessage: z.string(),
    assistantMessage: z.string(),
    moodValue: z.number().optional(),
    moodReason: z.string().optional(),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
}, async (args) => {
    try {
        const r = await saveConversationTurn(args.userMessage, args.assistantMessage, CHAR_ID, args.moodValue, args.moodReason, args.project);
        return ok(r);
    }
    catch (e) {
        return err(e.message);
    }
});
// ═══════════════════════════════════════════════════════════════════
// 上下文/状态工具
// ═══════════════════════════════════════════════════════════════════
register('context_get', 'admin', 'Get memory context summary: recent memories + stats, for prompt injection.', { project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') }, async (args) => {
    try {
        const db = DatabaseManager.getInstance();
        const recent = getRecentMemories(CHAR_ID, 5, 24, args.project);
        const stats = db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active=1 AND project=?').get(normalizeProject(args.project));
        return ok({
            recentMemories: recent.map(m => ({ text: m.text, category: m.category, importance: m.importance, createdAt: m.createdAt })),
            stats: { total: stats.c },
        });
    }
    catch (e) {
        return err(e.message);
    }
});
// ═══════════════════════════════════════════════════════════════════
// 上下文包工具 — 借鉴 engram mem_context / memory-os fabric_brief
// 一次调用拿到组装好的注入上下文:近期 + 相关 + 认知记录 + 事实
// ═══════════════════════════════════════════════════════════════════
register('memory_context', 'admin', 'Assemble an injection-ready context bundle: recent important memories + memories related to the current task (optional query) + cognitive logs (decisions/mistakes/patterns) + key facts. Call at session start or when you need memory context.', {
    query: z.string().optional().describe('Current task/topic to find related memories (optional)'),
    hoursBack: z.number().optional().describe('Window for recent memories (default 48h)'),
    recentLimit: z.number().optional().describe('Max recent memories (default 5)'),
    relatedLimit: z.number().optional().describe('Max related memories (default 5)'),
    asText: z.boolean().optional().describe('Return ready-to-inject prompt text (default true)'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    path: z.string().optional().describe('Current file path for glob-filtered instructions (e.g. src/components/Button.tsx). Instructions whose paths pattern does not match are skipped.'),
}, async (args) => {
    try {
        const db = DatabaseManager.getInstance();
        const hoursBack = args.hoursBack ?? 48;
        const recentLimit = args.recentLimit ?? 5;
        const relatedLimit = args.relatedLimit ?? 5;
        const proj = normalizeProject(args.project);
        // 1. 近期重要记忆
        const recent = getRecentMemories(CHAR_ID, recentLimit, hoursBack, proj);
        // 2. 与当前任务相关的记忆(向量搜索)
        let related = [];
        if (args.query) {
            const r = await searchMemory({ query: args.query, topK: relatedLimit, profile: 'balanced', characterId: CHAR_ID, project: proj });
            related = r.map(m => ({ text: m.text, category: m.category, importance: m.importance, score: m.score, createdAt: m.createdAt }));
        }
        // 3. 认知记录(决策/错误/模式)
        const cognitiveCats = ['decision', 'mistake'];
        const cognitives = db.prepare(`
        SELECT text, category, importance, created_at FROM memory
        WHERE is_active = 1 AND character_id = ? AND project = ?
          AND (category IN ('decision','mistake') OR tags LIKE '%pattern%')
        ORDER BY created_at DESC LIMIT 9
      `).all(CHAR_ID, proj);
        // 4. 关键事实(高置信度)
        const facts = db.prepare(`
        SELECT subject, predicate, object, confidence FROM facts
        WHERE is_active = 1 AND project = ? AND confidence >= 0.7
        ORDER BY confidence DESC, created_at DESC LIMIT 5
      `).all(proj);
        // 0. 三层指令记忆(全局→用户→项目;拼接顺序 L1→L2→L3,L3 在 Prompt 末尾约束最高)
        //    path 可选:对带 paths 的指令做 glob 过滤
        const instructions = getInstruction(proj, args.path);
        const stats = db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active=1 AND project=?').get(proj);
        // 5. Ground Truth 提示词组装(指令分节在最前面)
        const sections = [];
        if (instructions.length > 0) {
            const lines = instructions.map(i => {
                const base = i.scope === 'global' ? '[全局]' : i.scope === 'user' ? '[用户]' : '[项目]';
                const pathTag = i.paths && i.paths.length ? ` ${i.paths.join(', ')}` : '';
                return `${base}${pathTag} ${i.content}`;
            });
            sections.push(`【指令(全局→项目,项目约束最高)】\n${lines.join('\n')}`);
        }
        sections.push(`【当前记忆上下文】总记忆 ${stats.c} 条。请优先参考以下记忆,它们是之前会话沉淀的事实与经验:`);
        if (recent.length > 0) {
            sections.push(`\n■ 近期重要记忆(近 ${hoursBack} 小时):`);
            recent.forEach((m, i) => {
                sections.push(`${i + 1}. [${m.category}] ${m.text}${m.importance >= 0.8 ? ' (重要)' : ''}`);
            });
        }
        if (related.length > 0) {
            sections.push(`\n■ 与当前任务相关:「${args.query}」`);
            related.forEach((m, i) => {
                sections.push(`${i + 1}. [${m.category}] ${m.text}`);
            });
        }
        if (cognitives.length > 0) {
            sections.push(`\n■ 经验沉淀(决策/错误/模式):`);
            cognitives.forEach((m, i) => {
                const tag = m.category === 'mistake' ? '⚠️教训' : m.category === 'decision' ? '🎯决策' : '📐模式';
                sections.push(`${i + 1}. ${tag} ${m.text}`);
            });
        }
        if (facts.length > 0) {
            sections.push(`\n■ 已知事实:`);
            facts.forEach((f, i) => {
                sections.push(`${i + 1}. ${f.subject} — ${f.predicate}: ${f.object}`);
            });
        }
        sections.push(`\n【要求】以上记忆来自用户的真实历史,与当前任务相关时请直接使用,不要重新询问用户已知信息。`);
        const bundle = {
            prompt: sections.join('\n'),
            instructions,
            recent: recent.map(m => ({ text: m.text, category: m.category, importance: m.importance, createdAt: m.createdAt })),
            related,
            cognitives: cognitives.map(m => ({ text: m.text, category: m.category })),
            facts,
            stats: { total: stats.c },
            injectedAt: new Date().toISOString(),
        };
        return ok(args.asText === false ? bundle : { prompt: bundle.prompt });
    }
    catch (e) {
        return err(e.message);
    }
});
register('stats_get', 'admin', 'Get memory system statistics: total count, by category, by source.', { project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') }, async (args) => {
    try {
        const db = DatabaseManager.getInstance();
        const proj = normalizeProject(args.project);
        const total = db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active=1 AND character_id=? AND project=?').get(CHAR_ID, proj);
        return ok({
            op: 'stats',
            total: total.c,
            byCategory: db.prepare('SELECT category,COUNT(*) as c FROM memory WHERE is_active=1 AND character_id=? AND project=? GROUP BY category').all(CHAR_ID, proj),
            bySource: db.prepare('SELECT source,COUNT(*) as c FROM memory WHERE is_active=1 AND character_id=? AND project=? GROUP BY source').all(CHAR_ID, proj),
            characterId: CHAR_ID,
            project: proj,
        });
    }
    catch (e) {
        return err(e.message, 'STATS_FAILED');
    }
});
// ═══════════════════════════════════════════════════════════════════
// 记忆列表/图谱工具
// ═══════════════════════════════════════════════════════════════════
register('memory_list', 'admin', 'List active memories, optionally filtered. Admin tool: hard limit 50 to protect context.', {
    limit: z.number().max(50).optional().default(50).describe('Max results (hard cap 50)'),
    category: z.string().optional(),
    source: z.string().optional(),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
}, async (args) => {
    try {
        const memories = getAllMemories(CHAR_ID, args.limit, args.project);
        let filtered = memories;
        if (args.category)
            filtered = filtered.filter((m) => m.category === args.category);
        if (args.source)
            filtered = filtered.filter((m) => m.source === args.source);
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
    }
    catch (e) {
        return err(e.message, 'LIST_FAILED');
    }
});
register('memory_get', 'agent', 'Get one memory by ID with full text. Use to expand a search/recent/list result.', { id: z.string().describe('Memory ID') }, async (args) => {
    try {
        const db = DatabaseManager.getInstance();
        const row = db.prepare('SELECT * FROM memory WHERE id = ? AND is_active = 1').get(args.id);
        if (!row)
            return err('memory not found: ' + args.id, 'NOT_FOUND');
        // v1.3: 访问一次 → 热度 +1(配合热度升格:accessed_count ≥ 阈值自动升 tier)
        db.prepare('UPDATE memory SET accessed_count = accessed_count + 1, last_accessed_at = ? WHERE id = ?')
            .run(new Date().toISOString(), args.id);
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
                    accessedCount: row.accessed_count + 1,
                    referenceCount: row.reference_count,
                    locked: row.locked === 1,
                },
            },
        });
    }
    catch (e) {
        return err(e.message, 'GET_FAILED');
    }
});
register('memory_graph', 'agent', 'Get the memory relationship graph. Neighborhood only: nodes capped by limit (default 50), edges kept only between returned nodes.', { limit: z.number().max(200).optional().default(50).describe('Max nodes (default 50)'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') }, async (args) => {
    try {
        const g = getMemoryGraph(CHAR_ID, args.project);
        const limit = args.limit ?? 50;
        const nodes = g.nodes.slice(0, limit);
        const nodeIds = new Set(nodes.map((n) => n.id));
        const edges = g.edges.filter((e) => nodeIds.has(e.sourceId) && nodeIds.has(e.targetId));
        return ok({
            op: 'graph',
            count: nodes.length,
            nodes,
            edges,
            truncated: g.nodes.length > limit,
            hint: '图已按节点数截断,如需完整图用 Web Console',
        });
    }
    catch (e) {
        return err(e.message, 'GRAPH_FAILED');
    }
});
register('memory_recent', 'agent', 'Get recent important memories (no vector search, just time+importance).', {
    limit: z.number().optional().default(5),
    hoursBack: z.number().optional().default(24),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
}, async (args) => {
    try {
        const r = getRecentMemories(CHAR_ID, args.limit, args.hoursBack, args.project);
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
    }
    catch (e) {
        return err(e.message, 'RECENT_FAILED');
    }
});
register('recent_conversations', 'admin', 'Get recent conversation log entries.', {
    hoursBack: z.number().optional().default(24),
    limit: z.number().optional().default(50),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
}, async (args) => {
    try {
        const r = getRecentConversations(CHAR_ID, args.hoursBack, args.limit, args.project);
        return ok({ count: r.length, results: r });
    }
    catch (e) {
        return err(e.message);
    }
});
// ═══════════════════════════════════════════════════════════════════
// 反思工具
// ═══════════════════════════════════════════════════════════════════
register('reflect_analyze', 'admin', 'Get unanalyzed conversations bundled with system prompt for a big LLM to perform reflection.', { limit: z.number().optional().default(30),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') }, async (args) => {
    try {
        const conversations = getUnanalyzedConversations(CHAR_ID, undefined, args.limit ?? 30, args.project);
        const prompt = conversations.map((c) => c.text).join('\n---\n');
        return ok({
            conversationCount: conversations.length,
            systemPrompt: REFLECT_SYSTEM_PROMPT,
            userPrompt: `请分析以下对话，输出反思JSON：\n\n${prompt.substring(0, 30000)}`,
            conversationIds: conversations.map((c) => c.id),
        });
    }
    catch (e) {
        return err(e.message);
    }
});
register('reflect_apply', 'admin', 'Apply reflection results (merge, extract, reclassify, delete actions).', {
    action: z.enum(['apply', 'preview']).optional().default('apply'),
    actions: z.string().describe('JSON array of reflection actions'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
}, async (args) => {
    try {
        let parsed;
        try {
            parsed = JSON.parse(args.actions);
        }
        catch {
            const m = args.actions.match(/```(?:json)?\s*([\s\S]*?)```/);
            parsed = m ? JSON.parse(m[1]) : JSON.parse(args.actions);
        }
        const r = await reflect(args.action, { actions: parsed, project: args.project });
        return ok(r);
    }
    catch (e) {
        return err(e.message);
    }
});
register('reflect_auto', 'harness', 'Run automatic reflection: feed unanalyzed conversations (or ALL memories when mode=deep) to the configured LLM, apply extracted actions. Requires REFLECT_LLM_API_KEY.', {
    limit: z.number().optional().default(30),
    mode: z.enum(['daily', 'deep']).optional().default('daily').describe('daily=unanalyzed conversations; deep=full calibration'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
}, async (args) => {
    try {
        const r = args.mode === 'deep'
            ? await runDeepReflect(CHAR_ID, args.limit ?? 500, args.project)
            : await runAutoReflect(CHAR_ID, args.limit ?? 30, args.project);
        return ok({ op: args.mode === 'deep' ? 'reflect_deep' : 'reflect_auto', ...r });
    }
    catch (e) {
        return err(e.message, 'REFLECT_FAILED');
    }
});
register('reflect_deep', 'harness', '[Legacy] Deep calibration. Use reflect_auto(mode="deep") instead.', { limit: z.number().optional().default(500),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') }, async (args) => {
    try {
        const r = await runDeepReflect(CHAR_ID, args.limit ?? 500, args.project);
        return ok({ op: 'reflect_deep', ...r });
    }
    catch (e) {
        return err(e.message, 'REFLECT_FAILED');
    }
});
register('reflect_batch_embed', 'harness', '[Internal] Batch embed all pending (un-embedded) memories. Called after reflect.', { project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') }, async (args) => {
    try {
        const r = await batchEmbedPending(CHAR_ID, args.project);
        return ok(r);
    }
    catch (e) {
        return err(e.message);
    }
});
// ═══════════════════════════════════════════════════════════════════
// 每日摘要工具
// ═══════════════════════════════════════════════════════════════════
register('daily_summary_data', 'admin', 'Get conversation and auto-process data for the past N hours.', { hoursBack: z.number().optional().default(24),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') }, async (args) => {
    try {
        const db = DatabaseManager.getInstance();
        const since = new Date(Date.now() - (args.hoursBack || 24) * 3600000).toISOString();
        const proj = normalizeProject(args.project);
        const convs = db.prepare("SELECT text FROM memory WHERE is_active=1 AND source='conversation_log' AND project=? AND created_at>? ORDER BY created_at ASC LIMIT 100").all(proj, since).map((r) => r.text);
        const aps = db.prepare("SELECT text FROM memory WHERE is_active=1 AND source='auto_process' AND project=? AND created_at>? ORDER BY created_at ASC LIMIT 50").all(proj, since).map((r) => r.text);
        return ok({ conversations: [...convs, ...aps] });
    }
    catch (e) {
        return err(e.message);
    }
});
register('project_list', 'admin', 'List all project namespaces and their memory/fact counts. Use to discover which projects have memories (e.g. after switching working directories).', {}, async () => {
    try {
        const db = DatabaseManager.getInstance();
        const mem = db.prepare(`
        SELECT project, COUNT(*) as c FROM memory
        WHERE is_active = 1 GROUP BY project ORDER BY c DESC
      `).all();
        const facts = db.prepare(`
        SELECT project, COUNT(*) as c FROM facts
        WHERE is_active = 1 GROUP BY project ORDER BY c DESC
      `).all();
        const byId = {};
        for (const r of mem)
            byId[r.project || 'default'] = { project: r.project || 'default', memories: r.c, facts: 0 };
        for (const r of facts) {
            const key = r.project || 'default';
            if (!byId[key])
                byId[key] = { project: key, memories: 0, facts: 0 };
            byId[key].facts = r.c;
        }
        const projects = Object.values(byId).sort((a, b) => (b.memories + b.facts) - (a.memories + a.facts));
        return ok({
            op: 'project_list',
            count: projects.length,
            current: PROJECT_ID,
            projects,
            hint: '读写工具传 project 参数即切换到该项目的记忆空间;不传则用当前项目(' + PROJECT_ID + ')',
        });
    }
    catch (e) {
        return err(e.message, 'PROJECT_LIST_FAILED');
    }
});
// ═══════════════════════════════════════════════════════════════════
// 三层指令记忆工具(类比 CLAUDE.md 层级)
// L1 global:所有用户/项目通用规则(种子为全局规范)
// L2 user:当前用户所有项目共享
// L3 project:单项目专属规则,拼接在 Prompt 最末尾、约束最高,可覆盖 L1/L2 冲突
// rule:规则组(scope=rule),供 include 引用复用;指令带 paths 时可做 glob 路径过滤
// ═══════════════════════════════════════════════════════════════════
register('instruction_save', 'harness', 'Save (upsert) an instruction rule into one of four layers: global (all users/projects, seeded with global rules), user (current user, all projects), project (this project only), or rule (a reusable rule group referenced via include lines like include: "rule:typescript-core" in any instruction). Load order into prompt: global→user→project; project rules land at the very end and carry the highest constraint. Same scope+project overwrites the previous content. Optional paths accepts glob patterns (JSON array of strings, e.g. ["src/**","!src/temp/**"]) — when memory_context is called with a path, instructions whose paths do not match are skipped.', {
    scope: z.enum(['global', 'user', 'project', 'rule']).describe('Layer: global=all users/projects, user=this user shared, project=this project only, rule=reusable rule group (project = group name)'),
    project: z.string().optional().describe('Project name (REQUIRED when scope=project) or rule group name (REQUIRED when scope=rule)'),
    content: z.string().describe('Instruction rule content. May contain include lines: include: "rule:groupname" or include: ["rule:a","rule:b"]'),
    paths: z.array(z.string()).optional().describe('Glob patterns (picomatch). NULL = applies to all paths; patterns with leading ! are negations (last match wins).'),
}, async (args) => {
    try {
        const needsProject = args.scope === 'project' || args.scope === 'rule';
        if (needsProject && !(args.project ?? '').trim())
            return err(args.scope === 'rule' ? 'scope=rule 时必须传 project 参数(规则组名)' : 'scope=project 时必须传 project 参数', 'INVALID_PROJECT');
        const proj = needsProject ? normalizeProject(args.project) : null;
        const r = saveInstruction(args.scope, proj, args.content, args.paths ?? null);
        return ok({ saved: true, scope: args.scope, project: proj, paths: args.paths ?? null, created: r.created, id: r.id });
    }
    catch (e) {
        return err(e.message, 'INSTRUCTION_SAVE_FAILED');
    }
});
register('instruction_list', 'admin', 'List all instruction layers (global/user/project/rule) with scope, project, content, paths and updated_at. Rule groups are scope=rule + project=group name. Admin tool: use instruction_save to add/update, instruction_delete to remove.', {}, async () => {
    try {
        const rows = listInstructions();
        return ok({ count: rows.length, instructions: rows });
    }
    catch (e) {
        return err(e.message, 'INSTRUCTION_LIST_FAILED');
    }
});
register('instruction_delete', 'admin', 'Delete one instruction layer. scope=project requires the matching project name; scope=rule requires the rule group name. Admin tool.', {
    scope: z.enum(['global', 'user', 'project', 'rule']).describe('Layer to delete'),
    project: z.string().optional().describe('Project name (required when scope=project) or rule group name (required when scope=rule)'),
}, async (args) => {
    try {
        const needsProject = args.scope === 'project' || args.scope === 'rule';
        if (needsProject && !(args.project ?? '').trim())
            return err(args.scope === 'rule' ? 'scope=rule 时必须传 project 参数(规则组名)' : 'scope=project 时必须传 project 参数', 'INVALID_PROJECT');
        const proj = needsProject ? normalizeProject(args.project) : null;
        const r = deleteInstruction(args.scope, proj);
        return ok({ deleted: r.deleted, scope: args.scope, project: proj });
    }
    catch (e) {
        return err(e.message, 'INSTRUCTION_DELETE_FAILED');
    }
});
// ═══════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════
async function main() {
    // 三层指令记忆:首次启动写入 L1 全局种子(必须在建表之后、服务对外之前)
    DatabaseManager.getInstance();
    const seed = ensureSeedInstructions();
    console.error(`[instructions] L1 种子${seed.seeded ? '已写入(scope=global)' : `跳过(表已有 ${seed.count} 条)`}`);
    // Agent state: nothing to flush (in-memory only)
    // Consolidate every 24 hours
    setInterval(() => { consolidate().catch(() => { }); }, 24 * 60 * 60 * 1000);
    // Event-driven digest check every 1 minute
    setInterval(() => {
        maybeDigest(CHAR_ID)?.catch((e) => console.error('digest error:', e));
    }, 60 * 1000);
    // WAL checkpoint every 30 minutes
    setInterval(() => {
        try {
            const r = DatabaseManager.checkpoint();
            if (r.pages > 0)
                console.error('[db] WAL checkpoint:', r.pages, 'pages');
        }
        catch { }
    }, 30 * 60 * 1000);
    // Cleanup expired every 30 minutes
    setInterval(() => {
        const cleaned = cleanupExpiredMemories();
        if (cleaned > 0)
            console.error(`[castalia] cleaned ${cleaned} expired temporary memories`);
    }, 30 * 60 * 1000);
    // Auto-reflect every N hours (REFLECT_INTERVAL_HOURS > 0 enables)
    const reflectIntervalHours = parseFloat(process.env.REFLECT_INTERVAL_HOURS || '0');
    if (reflectIntervalHours > 0) {
        const runOnce = () => {
            runAutoReflect(CHAR_ID).then(r => {
                if (r.skipped)
                    return;
                console.error(`[reflect-auto] applied ${r.applied}/${r.actions} actions, errors: ${r.errors.length}`);
            }).catch((e) => console.error('[reflect-auto] error:', e.message));
        };
        setInterval(runOnce, reflectIntervalHours * 3600 * 1000);
        console.error(`[castalia] auto-reflect every ${reflectIntervalHours}h`);
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[airi-memory] v5.0.0 started — unified MCP server (proxy + LLM tools)');
    process.on('SIGINT', () => { DatabaseManager.close(); process.exit(0); });
    process.on('SIGTERM', () => { DatabaseManager.close(); process.exit(0); });
}
main();
