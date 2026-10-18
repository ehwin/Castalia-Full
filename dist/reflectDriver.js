/**
 * Reflect Driver — LLM reflection driver (bundled into the MCP server)
 *
 * Ported from the original reflect design: fetch memories → call LLM → parse actions → apply
 * - reflect_auto: unanalyzed conversations → daily digest / memory extraction
 * - reflect_deep: all memories → dedup / profile / graph
 *
 * Env config:
 *   REFLECT_LLM_URL       default https://api.deepseek.com/v1 (OpenAI-compatible)
 *   REFLECT_LLM_API_KEY   required; skipped when unset
 *   REFLECT_LLM_MODEL     default deepseek-chat
 *   REFLECT_FACT_EXTRACTION auto | off  (default auto) — off 时 prompt 不要求 facts,也不落 facts
 *   REFLECT_MAX_FACTS     每轮最多提取 facts 条数 (default 15)
 *   REFLECT_INTERVAL_HOURS auto-reflect interval (hours), 0 = off, default 0
 */
import { getUnanalyzedConversations, listAllMemories, applyReflectResult, applyReflectActions, markConversationsReflected, deepReflectionCursor } from './reflect.js';
import { DatabaseManager, listMemTypeDirs } from './db.js';
import { normalizeProject, isEmbedEnabled } from './env.js';
import { isMemType } from './memType.js';
import { findSimilarCandidates, CONSOLIDATE_SIMILARITY, CONSOLIDATE_MAX_PAIRS } from './consolidate.js';
import { getRecentConversations } from './digest.js';
import { loadPromptOverride } from './promptFile.js';
import { makeLlmChannel, callLlm, parseJsonRobust, REFLECT_DEEP_MAX_TOKENS } from './reflectionLlm.js';
export { makeLlmChannel, callLlm, parseJsonRobust, REFLECT_DEEP_MAX_TOKENS } from './reflectionLlm.js';
import { fidelitySystemPrompt, reflectionPolicy, reflectionFidelityPrompt, wholeRecordBatches } from './reflectionFidelity.js';
const FACT_EXTRACTION = (process.env.REFLECT_FACT_EXTRACTION || 'auto').trim().toLowerCase();
const MAX_FACTS = parseInt(process.env.REFLECT_MAX_FACTS || '15', 10) || 15;
// 启动自动反思触发阈值(条件达成后,下次启动 server 时自动执行一次)
const MIN_GAP_HOURS = (() => { const v = parseFloat(process.env.REFLECT_MIN_GAP_HOURS || '24'); return Number.isFinite(v) && v > 0 ? v : 24; })();
const MIN_UNANALYZED = (() => { const v = parseInt(process.env.REFLECT_MIN_UNANALYZED || '5', 10); return Number.isFinite(v) && v >= 0 ? v : 5; })();
// v1.10: 启动自动整合触发阈值(active 记忆条数 > 该值 → 下次启动自动整合一次)
const CONSOLIDATE_MIN_MEMORIES = (() => { const v = parseInt(process.env.CONSOLIDATE_MIN_MEMORIES || '15', 10); return Number.isFinite(v) && v >= 0 ? v : 15; })();
/**
 * 进度游标契约:所有反思提示词(内置 / 自定义 / 证据 / 逐字)都必须要求模型返回
 * processedSourceIds。缺了它,驱动无法区分“整批处理完”和“只处理了一部分”,
 * 旧逻辑会整批标记 → 未处理内容被永久跳过(2026-10-17 修)。
 */
const SOURCE_CURSOR_SPEC = `

【进度游标(必须)】输出 JSON 必须包含 "processedSourceIds": ["本轮已完整审阅且其有价值信息均已提取的来源 ID"]。
- 只列真正处理完的来源;没处理完/没来得及看的来源不要列,留待下一轮。
- 不能只写 summary 就确认来源;没有长效信息的来源,完整读过后也可以列入。`;
/**
 * v1.11: LLM 通道 — 三通道架构(LLM1 triage / 向量模型 / LLM2 reflect)。
 * 构造 `${PREFIX}_LLM_URL / ${PREFIX}_LLM_API_KEY / ${PREFIX}_LLM_MODEL` 配置:
 *   优先取前缀通道自身值;缺省回退 REFLECT_*(旧单通道);再回退内置默认。
 *   供 triage(LLM1) 与 reflect(LLM2) 复用。
 */
export function isReflectConfigured() {
    return !!makeLlmChannel('reflect').apiKey;
}
export function isFactExtractionEnabled() {
    return FACT_EXTRACTION !== 'off';
}
/**
 * 启动自动反思条件检查(两个同时满足才反思):
 *   a. REFLECT_LLM_API_KEY 已配置
 *   b. 距上次反思 ≥ REFLECT_MIN_GAP_HOURS(默认 24h;从未反思 → 视为超时,满足)
 *   c. 未分析对话数 > REFLECT_MIN_UNANALYZED(默认 5)
 * 按 project 维度查询(默认项目用 charId + normalizeProject)。
 */
export function shouldAutoReflect(charId = 'airi', project) {
    if (!isReflectConfigured()) {
        return { should: false, reason: 'REFLECT_LLM_API_KEY 未配置' };
    }
    const proj = normalizeProject(project);
    const dbs = listMemTypeDirs(proj).map(mt => DatabaseManager.getInstance(proj, mt));
    // 最近一次反思时间：跨所有 memType 取最新摘要
    const lastTimes = dbs.flatMap(db => {
        try {
            return db.prepare(`
        SELECT created_at FROM memory
        WHERE source = 'reflect_summary' AND project = ?
        ORDER BY created_at DESC LIMIT 1
      `).all(proj).map(r => r.created_at);
        }
        catch {
            return [];
        }
    });
    const lastTime = lastTimes.length ? Math.max(...lastTimes.map(t => new Date(t).getTime()).filter(Number.isFinite)) : NaN;
    const hoursSince = Number.isFinite(lastTime)
        ? (Date.now() - lastTime) / 3600000
        : Number.POSITIVE_INFINITY;
    const timeOk = hoursSince >= MIN_GAP_HOURS;
    const gapLabel = Number.isFinite(lastTime) ? `${Math.floor(hoursSince * 10) / 10}` : '∞';
    if (!timeOk) {
        return { should: false, reason: `距上次反思 ${gapLabel} 小时,未到 ${MIN_GAP_HOURS}h` };
    }
    const count = getUnanalyzedConversations(charId, undefined, MIN_UNANALYZED + 1, proj).length;
    if (count <= MIN_UNANALYZED) {
        return { should: false, reason: `未分析对话 ${count} 条,未超 ${MIN_UNANALYZED}` };
    }
    return { should: true, reason: `距上次反思 ${gapLabel}h 且未分析对话 ${count} 条` };
}
/**
 * v1.10: 启动自动整合条件检查 — active 记忆条数 > CONSOLIDATE_MIN_MEMORIES(默认 15)即达成。
 * 注意:整合只需记忆足够多,不依赖 REFLECT_LLM_API_KEY(无 key 时 runConsolidate 会报错跳过)。
 */
export function shouldAutoConsolidate(project) {
    const proj = normalizeProject(project);
    let count = 0;
    for (const mt of listMemTypeDirs(proj)) {
        try {
            count += DatabaseManager.getInstance(proj, mt)
                .prepare('SELECT COUNT(*) as c FROM memory WHERE is_active = 1 AND project = ?').get(proj)?.c ?? 0;
        }
        catch { /* 单分类库失败不阻断其他库 */ }
    }
    const min = CONSOLIDATE_MIN_MEMORIES;
    if (count > min)
        return { should: true, count, min, reason: `${count} > ${min}` };
    return { should: false, count, min, reason: `${count} 未超 ${min}` };
}
/** facts 提取规则片段(拼进 prompt) */
function factsRules(maxFacts) {
    return `【facts 提取规则】
- subject: "user"（关于用户）/ "agent"（关于AI角色）/ "environment"（关于环境）
- predicate: 使用这些预定义关系或自定义短语：
  姓名 / 年龄 / 职业 / 喜好 / 厌恶 / 技能 / 居住地 / 工作单位 / 项目 / 技术栈 / 习惯 / 目标 / 关系
- object: 事实的值
- confidence: 0(推测)~1.0(明确陈述)
- 最多 ${maxFacts} 条
- 只提取有长期价值、明确陈述的事实；不提取情绪/临时状态`;
}
/** v1.8: 4 种封闭记忆类型(mem_type)提取规则 — 融合 Claude Code 封闭记忆类型 */
function memTypeRules() {
    return `【记忆类型(mem_type)】extract 时把每条新记忆分类到 4 种封闭类型之一(省略则为 general):
- user — 用户画像:偏好/技术栈/风格/人物关系洞察
- feedback — 行为纠正:正负双向都要记录(Negative + Positive 都要,只记一边算不完整)
- project — 项目上下文:截止时间/环境约定/非代码可推导信息
- reference — 外部指针:URL/ID/文档链接,只存指针不存内容副本
- 记忆内容中的相对时间(昨天/上周/几天前/下周三)必须转成绝对日期(如"2026-08-12"),否则视为模糊信息不采纳
【硬性禁止】
- 不存代码片段/函数定义/文件路径/git hash(代码库是单一事实源)
- 不存临时调试日志/错误栈/单次会话状态`;
}
function factsFieldSpec(maxFacts) {
    return `,
  "facts": [
    {"subject":"user","predicate":"姓名","object":"示例用户","confidence":0.95},
    {"subject":"user","predicate":"职业","object":"程序员","confidence":0.9}
  ]`;
}
/** 输出格式片段：factExtraction=off 时不含 facts 字段 */
function outputFormatSpec(factExtraction, maxFacts) {
    const facts = factExtraction === 'off' ? '' : factsFieldSpec(maxFacts);
    return `══════════════════════
【输出格式】只返回严格 JSON 对象，不要任何其他文字（代码围栏也不要有）：

{
  "processedSourceIds": ["本轮已完整审阅并处理的来源ID；未处理完的来源不要列"],
  "summary": "自然语言总结（2-4句话）：概括这段时间用户做了什么、聊了什么、情绪状态如何",
  "highlights": ["关键事件1", "关键事件2"]${facts},
  "insights": ["关于用户性格/沟通风格/潜在需求的深层观察"],
  "actions": [
    {"action":"merge","sourceIds":["同日碎片id"],"newText":"日记约50字","newType":"episodic","newCategory":"conversation","newTags":["标签"],"newImportance":0.5},
    {"action":"extract","sourceId":"源id","newText":"提取的记忆","newType":"episodic","newCategory":"emotional","newTags":["标签"],"newImportance":0.6,"tier":"standard","newMemType":"user"}
  ]
}

【actions 规则】
- 仅当确实需要整理已有记忆时才产生 actions；不需要操作时 actions 为空数组 []
- 字段必须严格按下面 8 种写(字段名写错会被直接拒收)：
  merge      {"action":"merge","sourceIds":["id1","id2"],"newText":"合并后的文本","newType":"episodic","newCategory":"conversation","newTags":["标签"],"newImportance":0.5}
  extract    {"action":"extract","sourceId":"id","newText":"提取的文本","newType":"semantic","newCategory":"identity","newTags":["标签"],"newImportance":0.9,"tier":"critical","newMemType":"user"}
  split      {"action":"split","targetId":"id","fragments":[{"text":"片段1"},{"text":"片段2"}]}
  relate     {"action":"relate","sourceId":"id","targetIdRelate":"id2","relationType":"sequence"}
  reclassify {"action":"reclassify","targetId":"id","newText":"改写后的文本","newCategory":"milestone"}
  delete     {"action":"delete","targetId":"id"}
  boost      {"action":"boost","targetId":"id","delta":0.2}
  decay      {"action":"decay","targetId":"id","delta":-0.2}
- 禁止省略 targetId / sourceId；禁止自造字段名(如 id / ids / target / targetIdRelate 写成 target)
【长度纪律】一次最多输出 12 条 action(按重要性排序,宁少勿滥)；
JSON 必须完整闭合——内容多时先减少 action 条数、facts 条数，绝不允许写到一半断掉。
${memTypeRules()}
${factExtraction === 'off'
        ? '【facts】本轮不提取 facts。'
        : factsRules(maxFacts)}`;
}
/** Daily-reflection prompt builder (digest + extraction, model-neutral) */
export function buildReflectSystemPrompt(factExtraction = FACT_EXTRACTION, maxFacts = MAX_FACTS) {
    return loadPromptOverride('REFLECT_PROMPT_FILE', builtinReflectSystemPrompt(factExtraction, maxFacts)) + SOURCE_CURSOR_SPEC;
}
function builtinReflectSystemPrompt(factExtraction, maxFacts) {
    return `You are a memory organization engine. Each entry has a "date" field (YYYY-MM-DD).

══════════════════════
【按日期处理】
1. 先找出所有不同的 date 值
2. 对每个日期单独处理：该日所有记忆 → 浓缩为 1-3 条日记
3. merge 的 sourceIds 必须全部来自同一日期，严禁跨日期合并
4. 同一天内的对话碎片才能融合

══════════════════════
【任务1：日记浓缩】按日期将同日碎片浓缩为日记
- 每条日记约 50 字，口语化自然
- 区分"用户"和"agent"
- 每天最多 3 条日记
- 只处理 source 为 conversation_log / daily_digest / auto_process 的对话类记忆
- identity / milestone / relationship 等已有结构化记忆 → 保留原样，不合并
- locked = 1 的记忆是**永久锁定**的，绝对不要修改、合并、删除、reclassify 它们

【任务1.5：纠正错标记忆】
检查 category='emotional' 的记忆：
- 如果是角色背景故事/经历/回忆 → 用 reclassify 改为 identity
- 如果是里程碑事件 → 改为 milestone
- 只有真正的深层情感洞察（用户性格、情绪模式）→ 保留为 emotional

【任务2：记忆提取】从对话中筛出有长期价值的信息

2a. 身份与设定（identity）→ newType=semantic newCategory=identity tier=critical
  用户/角色的核心信息：我是XX师、生日是X月X日、毕业于XX、我的名字是、我住在
  别名/代号绑定：用户在游戏/故事中叫XX、笔名是XX、外号是XX

2b. 偏好（preference）→ newType=preference newCategory=preference
  用户明确表达的好恶：喜欢/讨厌/习惯/不习惯XX

2c. 里程碑（milestone）→ newType=episodic newCategory=milestone tier=critical
  重要节点：第一次、终于、入职、拿到offer、生日确认、重要决定

2d. 关系与约定（relationship）→ newType=entity newCategory=relationship tier=critical
  约定、承诺、说好了、不许忘、纪念日

2e. 情感积淀（emotional）→ newType=episodic newCategory=emotional tier=standard
  从对话中提炼用户的深层情感模式、性格洞察、长期情绪倾向
  示例："用户面对技术难题时反而兴奋，有挑战型人格"
  这不是临时情绪（mood_snapshot），而是有长期参考价值的情感画像

2f. 知识点（knowledge）→ newType=semantic newCategory=knowledge
  用户学到的、讨论到的有价值知识

【任务3：标签】每条结果 1-3 个中文标签

分类对照：identity=语义身份, preference=偏好, milestone=里程碑, relationship=关系, emotional=情感积淀, knowledge=知识

${outputFormatSpec(factExtraction, maxFacts)}

不确定不操作。`;
}
/** Deep-calibration prompt builder (full-memory analysis) */
export function buildDeepReflectPrompt(factExtraction = FACT_EXTRACTION, maxFacts = MAX_FACTS) {
    return loadPromptOverride('REFLECT_DEEP_PROMPT_FILE', builtinDeepReflectPrompt(factExtraction, maxFacts));
}
function builtinDeepReflectPrompt(factExtraction, maxFacts) {
    return `你是记忆深度校准引擎。对全部记忆执行长时分析。

══════════════════════
【目标】从所有记忆中提炼长期模式，清理冗余，生成用户画像

【任务1：去重合并】
- 找出语义重复的记忆（同一件事被记录了多次）→ merge
- 找出过时的信息（已被新信息覆盖）→ delete 或 decay
- locked=1 的记忆仅供上下文参考，绝不修改

【任务2：用户画像】
从所有非 locked 记忆中提取用户的长期特征：
- 性格特质：用户是什么样的人（从对话模式、情绪倾向推断）
- 核心偏好：反复出现的喜好/厌恶
- 关键关系：用户与 agent 的关系动态
- 成长轨迹：用户技能、知识、心态的变化

每个画像以 extract 形式输出：
{"action":"extract","sourceId":"代表性记忆id","newText":"用户画像描述","newType":"semantic","newCategory":"preference","newTags":["用户画像","性格"],"newImportance":0.9,"tier":"critical"}

【任务3：知识图谱】
- 找出可以建立关联的记忆 → relate
- 相关事件组成序列 → relate (relationType: "sequence" 或 "follows")

【任务4：降噪】
- importance < 0.3 且无 tags 的陈旧记忆 → delete
- 已被覆盖的临时信息 → decay

【任务:时间规范化检查】
- 扫描存量记忆文本:含相对时间(昨天/上周/几天前/下周三/上个月/去年等)的记忆 → 用 reclassify 更新文本(newText 用绝对日期替换,如 2026-08-12)
- 推断依据:该记忆的 date(created_at)字段;推断不出(如"很久以前")标"约 <年份>"或保持原文
- 只改含相对时间的记忆;已用绝对日期的跳过;拿不准的不动;locked=1 的跳过

══════════════════════
锁规则：locked=1 的记忆仅供理解上下文，绝对不修改/删除/合并
${outputFormatSpec(factExtraction, maxFacts)}
不确定不操作。`;
}
/** 向后兼容：默认配置下的 prompt（外部可能仍引用这两个常量） */
export const REFLECT_SYSTEM_PROMPT = buildReflectSystemPrompt();
export const DEEP_REFLECT_PROMPT = buildDeepReflectPrompt();
/** 把 parseJsonRobust 结果规范化为 applyReflectResult 期望的 ReflectResult */
function normalizeReflectResult(parsed) {
    const out = { ...parsed };
    out.actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    if (FACT_EXTRACTION === 'off') {
        out.facts = [];
    }
    else if (Array.isArray(parsed.facts)) {
        out.facts = parsed.facts.slice(0, MAX_FACTS);
    }
    else {
        out.facts = [];
    }
    return out;
}
/** 日常反思:未分析对话 → 日记浓缩/提取 */
export async function runAutoReflect(charId, limit = 30, project) {
    const base = { ok: false, mode: 'auto', actions: 0, applied: 0, errors: [] };
    if (!isReflectConfigured()) {
        return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过反思'] };
    }
    try {
        const conversations = getUnanalyzedConversations(charId, undefined, limit, project);
        if (conversations.length === 0) {
            return { ...base, ok: true, conversationCount: 0, skipped: true, errors: ['无未分析对话'] };
        }
        const records = conversations.map(c => ({ id: c.id, createdAt: c.createdAt, date: c.createdAt?.slice(0, 10), text: c.text }));
        const batches = wholeRecordBatches(records);
        const out = { ...base, conversationCount: records.length, processedCount: 0, deferredCount: records.length, receipts: [] };
        const policy = reflectionPolicy(project);
        const fidelity = fidelitySystemPrompt(project);
        const customPrompt = loadPromptOverride('REFLECT_PROMPT_FILE', '');
        const systemPrompt = policy === 'standard'
            ? buildReflectSystemPrompt() + '\n' + reflectionFidelityPrompt(project)
            : ((customPrompt ? customPrompt + '\n' : '') + fidelity) + SOURCE_CURSOR_SPEC;
        for (const batch of batches) {
            const llm = await callLlm(systemPrompt, `请逐条分析以下完整记录，输出反思JSON：\n${JSON.stringify(batch)}`, undefined, REFLECT_DEEP_MAX_TOKENS);
            if (!llm || llm.finishReason === 'length') {
                out.errors.push(!llm ? 'LLM 调用失败；本批保留待重试' : 'LLM 输出被截断；本批未应用，保留待重试');
                break;
            }
            const parsed = parseJsonRobust(llm.content, false);
            if (!parsed || !Array.isArray(parsed.actions)) {
                out.errors.push('未返回完整反思 JSON 和 actions；本批保留待重试');
                break;
            }
            const result = normalizeReflectResult(parsed);
            const allowed = new Set(batch.map(x => x.id));
            // 模型没给游标时,只认 actions 实际引用过的来源;绝不再整批标记(旧逻辑会丢内容)。
            const fromActions = (Array.isArray(result.actions) ? result.actions : [])
                .flatMap((a) => [a.sourceId, a.targetId])
                .filter((id) => typeof id === 'string' && allowed.has(id));
            const processedIds = Array.isArray(result.processedSourceIds) && result.processedSourceIds.length
                ? result.processedSourceIds
                : [...new Set(fromActions)];
            if (!processedIds.length || new Set(processedIds).size !== processedIds.length || processedIds.some(id => typeof id !== 'string' || !allowed.has(id))) {
                out.errors.push('未明确确认已完整处理的来源 ID；本批未应用，保留待重试');
                break;
            }
            const r = await applyReflectResult(result, charId, project, { allowedSourceIds: new Set(batch.map(x => x.id)), automatic: true });
            out.actions += (result.actions || []).length;
            out.applied += r.actionsApplied;
            out.receipts.push(...r.receipts);
            out.factsInserted = (out.factsInserted || 0) + r.factsInserted;
            out.factsUpdated = (out.factsUpdated || 0) + r.factsUpdated;
            out.errors.push(...r.errors);
            if (r.errors.length)
                break;
            markConversationsReflected(processedIds, project);
            out.processedCount += processedIds.length;
            out.deferredCount -= processedIds.length;
            if (processedIds.length < batch.length) {
                out.errors.push('本批仅部分来源完成；未完成来源保留待重试');
                break;
            }
        }
        out.ok = out.errors.length === 0;
        return out;
    }
    catch (e) {
        return { ...base, errors: [e.message] };
    }
}
/**
 * 深度校准:全量记忆 → 去重/画像/图谱
 * v1.20: 分批送模型(默认每批 12 条,单次最多 4 批)。一次性塞 30+ 条会让模型输出超过
 * max_tokens 被截断,JSON 解析失败反而整轮丢弃;分批后每批输出小、必闭合,代价是多次调用。
 * 可用 REFLECT_DEEP_CHUNK / REFLECT_DEEP_MAXCALLS 调参。
 */
export async function runDeepReflect(charId, limit = 500, project) {
    const base = { ok: false, mode: 'deep', actions: 0, applied: 0, errors: [] };
    if (!isReflectConfigured()) {
        return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过反思'] };
    }
    try {
        const memories = listAllMemories(charId, limit, project);
        memories.sort((a, b) => a.id.localeCompare(b.id));
        const cursor = deepReflectionCursor(project);
        const nextIndex = memories.findIndex(m => m.id > cursor);
        if (nextIndex > 0)
            memories.push(...memories.splice(0, nextIndex));
        if (memories.length === 0) {
            return { ...base, ok: true, memoryCount: 0, skipped: true, errors: ['库为空'] };
        }
        const slim = memories.map(m => ({
            id: m.id,
            text: m.text || '',
            type: m.type, memType: m.memType || 'general', category: m.category,
            tags: m.tags || [], importance: m.importance ?? 0.5,
            emotionalImpact: m.emotionalImpact ?? 0, tier: m.tier || 'standard',
            locked: m.locked || 0, source: m.source || '',
            date: (m.createdAt || '').slice(0, 10),
        }));
        const chunk = Math.max(4, Number(process.env.REFLECT_DEEP_CHUNK || 12));
        const maxCalls = Math.max(1, Number(process.env.REFLECT_DEEP_MAXCALLS || 4));
        const batches = wholeRecordBatches(slim, 30000, chunk);
        const out = {
            ok: true, mode: 'deep', memoryCount: memories.length,
            actions: 0, applied: 0, factsInserted: 0, factsUpdated: 0, errors: [], receipts: [],
        };
        let okBatches = 0;
        for (const batch of batches.slice(0, maxCalls)) {
            const userPrompt = `记忆列表(${batch.length} 条)：\n\n${JSON.stringify(batch, null, 1)}\n\n请深度分析本批记忆，返回 JSON 操作对象。`;
            const systemPrompt = reflectionPolicy(project) === 'standard' ? buildDeepReflectPrompt() + '\n' + reflectionFidelityPrompt(project) : fidelitySystemPrompt(project);
            const llm = await callLlm(systemPrompt, userPrompt, undefined, REFLECT_DEEP_MAX_TOKENS);
            if (!llm) {
                out.errors.push('LLM 调用失败');
                break;
            }
            if (llm.finishReason === 'length') {
                out.errors.push('本批输出被截断，已保留未处理；下次重试');
                break;
            }
            const parsed = parseJsonRobust(llm.content, false);
            if (!parsed || !Array.isArray(parsed.actions)) {
                out.errors.push('未找到有效 JSON actions 结果');
                break;
            }
            const result = normalizeReflectResult(parsed);
            const r = await applyReflectResult(result, charId, project, { allowedSourceIds: new Set(batch.map(x => x.id)), automatic: true });
            if (r.errors.length === 0) {
                okBatches++;
                deepReflectionCursor(project, batch[batch.length - 1].id);
                out.processedCount = (out.processedCount || 0) + batch.length;
            }
            out.actions += (result.actions || []).length;
            out.applied += r.actionsApplied;
            out.factsInserted = (out.factsInserted || 0) + (r.factsInserted || 0);
            out.factsUpdated = (out.factsUpdated || 0) + (r.factsUpdated || 0);
            out.receipts = [...(out.receipts || []), ...(r.receipts || [])];
            out.errors.push(...(r.errors || []));
            if (r.errors.length)
                break;
        }
        if (okBatches === 0 || out.errors.length)
            out.ok = false;
        if (batches.length > maxCalls) {
            out.errors.push(`本轮只处理 ${maxCalls}/${batches.length} 批(其余留待下轮)`);
        }
        out.deferredCount = memories.length - (out.processedCount || 0);
        return out;
    }
    catch (e) {
        return { ...base, errors: [e.message] };
    }
}
// ═══════════════════════════════════════════════════════════════════
// v1.10: 记忆整合子进程(Memory Consolidator)
// 忠实还原 Claude Code MEMORY_CONSOLIDATION_PROMPT 精神(用户确认,不自定义改动):
//   - CONFLICT RESOLUTION:矛盾时 ALWAYS 偏最新用户决定;被撤销/取代的规则 REMOVE
//   - DEDUPLICATION & MERGING:同主题碎片归并,输出严格保持 4 种封闭类型之一
//   - PRUNING & COMPRESSION:删临时调试/错误日志/误存代码;相对日期转绝对日期
//   - NEVER invent new facts(铁律):保持用户偏好原样
// 执行:先读后写,原子完成。
// ═══════════════════════════════════════════════════════════════════
export function buildConsolidationPrompt() {
    return loadPromptOverride('CONSOLIDATE_PROMPT_FILE', builtinConsolidationPrompt());
}
function builtinConsolidationPrompt() {
    return `你是记忆整合引擎(Memory Consolidator)。输入:
1. 候选记忆(带 id/memType/text/createdAt)
2. 候选相似对(向量预筛结果,可能为空)
3. 近期对话转录(捕捉最新用户决定)

任务是全量"去重 + 矛盾消解 + 主题归并"。先读后写,原子完成。

══════════════════════
【CONFLICT RESOLUTION(矛盾消解)】
- 记忆互相矛盾时,ALWAYS prefer the most recent user decision(以最近一次用户决定为准)。
- 规则被撤销/取代 → REMOVE 过时记忆(用 delete)。
- 用户偏好保持原样,不擅自改写。

【DEDUPLICATION & MERGING(去重归并)】
- 同主题碎片合并为一条整合后的 Markdown 文本(用 merge)。
- merge 输出的 newMemType 必须严格是 4 种封闭类型之一:user / feedback / project / reference。
- 不相关的主题不要合并。

【PRUNING & COMPRESSION(剪枝压缩)】
- 删除临时调试步骤/错误日志/误存的代码片段。
- 相对日期转成绝对日期(如 "yesterday" → 今天日期,见输入顶部)。
- 唯一无重复的记忆 → keep 保留。

【NEVER invent new facts(铁律)】
- 绝不虚构输入中不存在的事实;用户偏好原文保留,不添加不存在的细节。

══════════════════════
【输出】只返回严格 JSON 数组,不要代码围栏,不要任何其他文字:
[
  {"action":"merge","sourceIds":["a","b"],"newText":"整合后的 Markdown 文本","newMemType":"feedback"},
  {"action":"delete","id":"c","reason":"被最新用户决定取代"},
  {"action":"keep","id":"d","reason":"唯一无重复"}
]
- merge 的 newMemType 必须属于 4 种封闭类型;不需要操作时返回 []`;
}
export const MEMORY_CONSOLIDATION_PROMPT = buildConsolidationPrompt();
/** 把整合 LLM 输出的动作规范化为 applyReflectActions 认识的 ReflectAction(keep 不落地,只计数) */
function normalizeConsolidationActions(raw) {
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.actions) ? raw.actions : []);
    const actions = [];
    let kept = 0;
    const errors = [];
    for (const a of list) {
        const action = a?.action;
        if (action === 'merge') {
            const ids = Array.isArray(a.sourceIds) ? a.sourceIds.filter((x) => typeof x === 'string' && x.length > 0) : [];
            if (ids.length >= 2 && typeof a.newText === 'string' && a.newText.trim().length > 0) {
                actions.push({ action: 'merge', sourceIds: ids, newText: a.newText, newMemType: isMemType(a.newMemType) ? a.newMemType : undefined });
            }
            else {
                errors.push('merge: need sourceIds(≥2) and newText, skipped');
            }
        }
        else if (action === 'delete') {
            if (typeof a.id === 'string' && a.id.length > 0)
                actions.push({ action: 'delete', targetId: a.id });
            else
                errors.push('delete: need id, skipped');
        }
        else if (action === 'keep') {
            if (typeof a.id === 'string' && a.id.length > 0)
                kept++;
            else
                errors.push('keep: need id, skipped');
        }
        else if (action === 'extract' && typeof a.sourceId === 'string' && typeof a.newText === 'string' && a.newText.trim()) {
            actions.push({ ...a });
        }
        else {
            errors.push(`unknown consolidation action: ${action || '(missing)'}, skipped`);
        }
    }
    return { actions, kept, errors };
}
/**
 * v1.10: 记忆整合主流程 — 向量预筛 → LLM 整合 → applyReflectActions 原子执行。
 * - EMBED_MODE=none:预筛返回空 → LLM 全量扫兜底
 * - 有向量但无相似候选 → 直接返回空结果,不再调 LLM(省 token)
 */
export async function runConsolidate(charId = 'default', project, threshold, limit) {
    const base = { ok: false, scanned: 0, candidates: 0, merged: 0, deleted: 0, kept: 0, actions: 0, applied: 0, errors: [] };
    if (!isReflectConfigured()) {
        return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过整合'] };
    }
    const proj = normalizeProject(project);
    // v1.11.2 memdir:逐 memType 库扫描并合并 —— 旧版只读 general:候选即便从别库产生,也会在下面
    // 的 `mems.filter(...)`(按候选 id 过滤)里被丢掉,等于白算。这里把各库并起来再按重要度截断。
    const mems = [];
    for (const mt of listMemTypeDirs(proj)) {
        try {
            mems.push(...DatabaseManager.getInstance(project, mt).prepare(`
        SELECT id, mem_type, text, created_at, importance FROM memory
        WHERE is_active = 1 AND project = ? AND (locked IS NULL OR locked = 0)
        ORDER BY importance DESC, created_at DESC
        LIMIT 500
      `).all(proj));
        }
        catch { /* 单个库读不到不影响其它库 */ }
    }
    mems.sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0));
    if (mems.length > 500)
        mems.length = 500;
    const scanned = mems.length;
    if (scanned < 2) {
        return { ...base, ok: true, scanned, skipped: true, errors: ['active 记忆不足 2 条,无需整合'] };
    }
    // 1. 向量预筛(EMBED_MODE=none 返回空 → 全量扫兜底)
    let candidates = [];
    if (isEmbedEnabled()) {
        candidates = await findSimilarCandidates(proj, threshold ?? CONSOLIDATE_SIMILARITY, limit ?? CONSOLIDATE_MAX_PAIRS);
        if (candidates.length === 0) {
            // 有向量但确实无相似对 → 不再调 LLM,省 token
            return { ...base, ok: true, scanned, skipped: true, errors: ['无相似候选,无需整合'] };
        }
    }
    // 2. 组装 LLM 输入:向量模式 → 候选涉及的记忆;全量模式 → 全部记忆
    const candidateIds = new Set();
    for (const p of candidates) {
        candidateIds.add(p.idA);
        candidateIds.add(p.idB);
    }
    const inputMems = candidates.length > 0 ? mems.filter(m => candidateIds.has(m.id)) : mems;
    const today = new Date().toISOString().slice(0, 10);
    const itemsJson = JSON.stringify(inputMems.map(m => ({
        id: m.id,
        memType: m.mem_type || 'general',
        text: m.text || '',
        createdAt: (m.created_at || '').slice(0, 10),
    })), null, 1);
    const pairsJson = JSON.stringify(candidates, null, 1);
    // 3. 最近对话转录(conversation_log,捕捉最新用户修正)
    let transcript = '';
    try {
        const convs = getRecentConversations(charId, 24 * 7, 20, proj);
        transcript = JSON.stringify(convs.map(c => ({ id: c.id, text: c.text, createdAt: c.created_at })), null, 2);
    }
    catch {
        transcript = '';
    }
    const userPrompt = `今天是 ${today}(相对日期转绝对日期时以此为准)。
请整合以下候选记忆,输出整合 JSON 数组。

【候选记忆】
${itemsJson}

【候选相似对】
${pairsJson}

【近期对话转录】
${transcript || '无近期对话转录'}`;
    const systemPrompt = reflectionPolicy(proj) === 'standard' ? buildConsolidationPrompt() + '\n' + reflectionFidelityPrompt(proj) : fidelitySystemPrompt(proj, true);
    const llm = await callLlm(systemPrompt, userPrompt, undefined, REFLECT_DEEP_MAX_TOKENS);
    if (!llm)
        return { ...base, scanned, candidates: candidates.length, errors: ['LLM 调用失败'] };
    if (llm.finishReason === 'length')
        return { ...base, scanned, candidates: candidates.length, errors: ['LLM 输出被截断，未应用整合'] };
    const parsed = parseJsonRobust(llm.content, false);
    if (!parsed)
        return { ...base, scanned, candidates: candidates.length, errors: ['未找到有效 JSON 结果'] };
    // 4. 规范化 + 原子执行(keep 不落地;merge/delete 复用 applyReflectActions)
    const norm = normalizeConsolidationActions(parsed);
    let r = { applied: 0, errors: [], receipts: [] };
    if (norm.actions.length > 0) {
        try {
            const inputIds = new Set(inputMems.map(m => m.id));
            r = await applyReflectActions(norm.actions, charId, proj, { allowedSourceIds: inputIds, automatic: true });
        }
        catch (e) {
            norm.errors.push(e.message);
        }
    }
    const merged = r.receipts.filter(x => x.action === 'merge' && x.status === 'applied').length;
    const deleted = r.receipts.filter(x => x.action === 'delete' && x.status === 'applied').length;
    return {
        ok: norm.errors.length === 0 && r.errors.length === 0,
        scanned,
        candidates: candidates.length,
        merged,
        deleted,
        kept: norm.kept,
        actions: norm.actions.length,
        applied: r.applied,
        errors: [...norm.errors, ...r.errors],
        receipts: r.receipts,
    };
}
