/**
 * Memory Search — 中性通用检索
 *
 * 策略：
 *   1. 标签搜索(0 向量调用)→ 不够回退向量 KNN
 *   2. 评分：语义一致性为主(60%)，时间衰减(30%)，情绪标记弱化(10%)
 *
 * 权重全部可经环境变量调整，适用于通用 agent 记忆场景。
 */
import { DatabaseManager } from './db.js';
import { embed } from './ollama.js';
import { normalizeProject } from './env.js';
// 中性评分权重(可配)
const WEIGHT_CONSISTENCY = parseFloat(process.env.WEIGHT_CONSISTENCY || '0.65'); // 语义/标签匹配
const WEIGHT_TIME = parseFloat(process.env.WEIGHT_TIME || '0.35'); // 时间衰减
// 时间衰减半衰期(小时),默认 30 天
const HALF_LIFE_HOURS = parseFloat(process.env.HALF_LIFE_HOURS || (30 * 24).toString());
// minScore 阈值可配;harness 可用 SEARCH_MIN_SCORE 覆盖
const SEARCH_PROFILES = {
    quick: { topK: 3, minScore: 0.6 },
    balanced: { topK: 5, minScore: parseFloat(process.env.SEARCH_MIN_SCORE || '0.15') },
    deep: { topK: 10, minScore: 0.1 },
};
/** 指数时间衰减:30 天半衰期 */
function timeDecay(hoursSinceCreated) {
    if (hoursSinceCreated <= 0)
        return 1;
    return Math.pow(0.5, hoursSinceCreated / HALF_LIFE_HOURS);
}
/** 统一评分:一致性 + 情绪(弱) + 时间 */
function computeScore(similarity, row) {
    const consistency = Math.min(Math.max(similarity, 0), 0.85);
    const hoursSinceCreated = (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60);
    const decay = timeDecay(hoursSinceCreated);
    const tierBoost = row.tier === 'critical' ? 2.0 : (row.tier === 'temporary' ? 0.5 : 1.0);
    const importanceMult = 0.5 + (row.importance || 0.5);
    const accessBoost = 1 + Math.min(0.5, Math.log2(1 + (row.accessed_count || 0)) * 0.1);
    const rawScore = WEIGHT_CONSISTENCY * consistency
        + WEIGHT_TIME * decay;
    return Math.round(rawScore * importanceMult * tierBoost * accessBoost * 1000) / 1000;
}
/**
 * 标签优先搜索 → 不足时回退向量 KNN
 */
export async function searchMemory(options) {
    const db = DatabaseManager.getInstance();
    const profile = options.profile ? SEARCH_PROFILES[options.profile] : null;
    const topK = options.topK ?? profile?.topK ?? 10;
    const minScore = options.minScore ?? profile?.minScore ?? 0;
    // ═══ Phase 1: 标签搜索(0 次向量调用) ═══
    const tagResults = tagSearch(db, options);
    // 标签结果足够好 → 直接返回
    if (tagResults.length >= topK && tagResults[0].score >= 0.5) {
        updateAccessed(db, tagResults.slice(0, topK));
        return tagResults.slice(0, topK);
    }
    // ═══ Phase 2: 标签不够 → 向量 KNN 补充 ═══
    const existingIds = new Set(tagResults.map(r => r.id));
    let vectorResults = [];
    try {
        const queryVector = await embed(options.query);
        const floatQuery = new Float32Array(queryVector);
        vectorResults = vectorKnnSearch(db, options, floatQuery, existingIds, topK, minScore);
    }
    catch {
        // 向量搜索失败 → 文本回退
        vectorResults = textFallbackSearch(db, options, existingIds, topK, minScore);
    }
    // 合并 + 去重 + 排序
    const merged = [...tagResults, ...vectorResults];
    merged.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const unique = [];
    for (const r of merged) {
        if (!seen.has(r.id)) {
            seen.add(r.id);
            unique.push(r);
        }
        if (unique.length >= topK)
            break;
    }
    updateAccessed(db, unique.slice(0, topK));
    return unique.slice(0, topK);
}
// ═══════════════════════════════════════════════════════════════════
// 标签搜索 — 从 query 提取关键词，SQL tag LIKE 匹配
// ═══════════════════════════════════════════════════════════════════
/** 从中文/英文 query 中提取关键词 */
function extractKeywords(query) {
    const stopWords = new Set(['的', '了', '是', '我', '你', '他', '她', '吗', '呢', '吧', '啊',
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'of', 'and', 'or',
        '有', '在', '不', '要', '会', '能', '就', '都', '也', '还', '和', '与', '这', '那', '什么', '怎么']);
    const tokens = query.split(/[\s,，。！？、；：""''（）()\[\]【】\-\/\\|]+/);
    return [...new Set(tokens.filter(t => t.length >= 2 && !stopWords.has(t.toLowerCase())))];
}
/** SQL 标签搜索：匹配 memory.tags JSON 数组 */
function tagSearch(db, options) {
    const keywords = extractKeywords(options.query);
    if (keywords.length === 0)
        return [];
    const profile = options.profile ? SEARCH_PROFILES[options.profile] : null;
    const topK = options.topK ?? profile?.topK ?? 10;
    const project = normalizeProject(options.project);
    const tagCond = keywords.map(() => `m.tags LIKE ?`).join(' OR ');
    const tagParams = keywords.map(k => `%"${k}"%`);
    const looseCond = keywords.map(() => `m.tags LIKE ?`).join(' OR ');
    const looseParams = keywords.map(k => `%${k}%`);
    const conditions = ['m.is_active = 1', 'm.project = ?'];
    const params = [project];
    conditions.push(`((${tagCond}) OR (${looseCond}))`);
    params.push(...tagParams, ...looseParams);
    if (options.type) {
        conditions.push('m.type = ?');
        params.push(options.type);
    }
    if (options.category) {
        conditions.push('m.category = ?');
        params.push(options.category);
    }
    if (options.characterId) {
        conditions.push('m.character_id = ?');
        params.push(options.characterId);
    }
    if (options.subject) {
        conditions.push('m.subject = ?');
        params.push(options.subject);
    }
    const rows = db.prepare(`
    SELECT m.id, m.text, m.project, m.type, m.category, m.subcategory, m.tags,
      m.importance, m.character_id, m.source,
      m.subject, m.tier,
      m.created_at, m.last_accessed_at, m.accessed_count
    FROM memory m
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.importance DESC, m.created_at DESC
    LIMIT ?
  `).all(...params, topK * 3);
    return rows.map(row => {
        const memTags = JSON.parse(row.tags || '[]');
        const matchedTags = keywords.filter(k => memTags.some((t) => t.toLowerCase().includes(k.toLowerCase()))).length;
        const tagScore = Math.min(1.0, matchedTags / Math.max(1, keywords.length));
        return {
            id: row.id, text: row.text, project: row.project || 'default', type: row.type, category: row.category,
            subcategory: row.subcategory, tags: memTags,
            importance: row.importance,
            characterId: row.character_id, source: row.source,
            subject: row.subject || 'user', tier: row.tier || 'standard',
            score: computeScore(tagScore, row), similarity: Math.round(tagScore * 1000) / 1000,
            createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
            accessedCount: row.accessed_count,
        };
    });
}
/** 向量 KNN 搜索 */
function vectorKnnSearch(db, options, floatQuery, excludeIds, topK, minScore) {
    // v1.5: vec0 虚拟表禁止 JOIN(KNN 必须在 vec0 上 LIMIT),项目过滤放在第二段 memory 查询
    // 候选集放大(全库 KNN)保证单项目召回;隔离语义由 memory 查询的 project=? 保证
    const knnLimit = Math.min(topK * 8, 60);
    const project = normalizeProject(options.project);
    let knnRows;
    try {
        knnRows = db.prepare(`
      SELECT rowid, distance FROM vec_memory
      WHERE embedding MATCH ? ORDER BY distance LIMIT ?
    `).all(floatQuery, knnLimit);
    }
    catch {
        return [];
    }
    if (knnRows.length === 0)
        return [];
    const rowidMap = new Map();
    for (const r of knnRows)
        rowidMap.set(Number(r.rowid), r.distance);
    const rowidPlaceholders = knnRows.map(() => '?').join(',');
    const rowidParams = knnRows.map(r => Number(r.rowid));
    const conditions = [`m.rowid IN (${rowidPlaceholders})`, 'm.is_active = 1', 'm.project = ?'];
    const params = [...rowidParams, project];
    if (options.type) {
        conditions.push('m.type = ?');
        params.push(options.type);
    }
    if (options.category) {
        conditions.push('m.category = ?');
        params.push(options.category);
    }
    if (options.characterId) {
        conditions.push('m.character_id = ?');
        params.push(options.characterId);
    }
    const rows = db.prepare(`
    SELECT m.id, m.text, m.project, m.type, m.category, m.subcategory, m.tags,
      m.importance, m.character_id, m.source,
      m.subject, m.tier,
      m.created_at, m.last_accessed_at, m.accessed_count, m.rowid
    FROM memory m WHERE ${conditions.join(' AND ')}
  `).all(...params);
    const results = [];
    for (const row of rows) {
        if (excludeIds.has(row.id))
            continue;
        const dist = rowidMap.get(row.rowid) ?? 1.0;
        const similarity = Math.max(0, 1.0 - dist);
        const score = computeScore(similarity, row);
        if (score >= minScore) {
            results.push({
                id: row.id, text: row.text, project: row.project || 'default', type: row.type, category: row.category,
                subcategory: row.subcategory, tags: JSON.parse(row.tags || '[]'),
                importance: row.importance,
                characterId: row.character_id, source: row.source,
                subject: row.subject || 'user', tier: row.tier || 'standard',
                score, similarity: Math.round(similarity * 1000) / 1000,
                createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
                accessedCount: row.accessed_count,
            });
        }
    }
    return results;
}
/** 文本回退搜索(向量不可用时) */
function textFallbackSearch(db, options, excludeIds, topK, minScore) {
    const terms = options.query.split(/\s+/).filter(t => t.length > 0);
    if (terms.length === 0)
        return [];
    const project = normalizeProject(options.project);
    const likeConditions = terms.map(() => 'm.text LIKE ?').join(' OR ');
    const likeParams = terms.map(t => `%${t}%`);
    const rows = db.prepare(`
    SELECT m.id, m.text, m.project, m.type, m.category, m.subcategory, m.tags,
      m.importance, m.character_id, m.source,
      m.subject, m.tier,
      m.created_at, m.last_accessed_at, m.accessed_count
    FROM memory m
    WHERE m.is_active = 1 AND m.project = ? AND (${likeConditions})
    ORDER BY m.created_at DESC LIMIT ?
  `).all(project, ...likeParams, topK * 2);
    return rows
        .filter(row => !excludeIds.has(row.id))
        .map(row => ({
        id: row.id, text: row.text, project: row.project || 'default', type: row.type, category: row.category,
        subcategory: row.subcategory, tags: JSON.parse(row.tags || '[]'),
        importance: row.importance,
        characterId: row.character_id, source: row.source,
        subject: row.subject || 'user', tier: row.tier || 'standard',
        score: computeScore(0.3, row), similarity: 0.3,
        createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
        accessedCount: row.accessed_count,
    }));
}
/** 更新记忆访问计数 */
function updateAccessed(db, results) {
    if (results.length === 0)
        return;
    try {
        const stmt = db.prepare('UPDATE memory SET accessed_count = accessed_count + 1, last_accessed_at = ? WHERE id = ?');
        const now = new Date().toISOString();
        const tx = db.transaction((ids) => { for (const id of ids)
            stmt.run(now, id); });
        tx(results.map(r => r.id));
    }
    catch { }
}
/**
 * 快速获取近期重要记忆(用于请求前注入，<5ms)
 * 不做向量搜索，直接按时间+importance 捞
 */
export function getRecentMemories(characterId, limit = 5, hoursBack = 24, project) {
    const db = DatabaseManager.getInstance();
    const since = new Date(Date.now() - hoursBack * 3600000).toISOString();
    const proj = normalizeProject(project);
    const rows = db.prepare(`
    SELECT id, text, project, type, category, subcategory, tags,
           importance, character_id, source, subject, tier,
           created_at, last_accessed_at, accessed_count
    FROM memory
    WHERE is_active = 1 AND character_id = ? AND project = ? AND created_at > ?
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `).all(characterId, proj, since, limit);
    return rows.map(row => ({
        id: row.id, text: row.text, project: row.project || 'default', type: row.type, category: row.category,
        subcategory: row.subcategory, tags: JSON.parse(row.tags || '[]'),
        importance: row.importance,
        characterId: row.character_id, source: row.source, subject: row.subject || 'user',
        tier: row.tier || 'standard',
        score: row.importance, similarity: 0,
        createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
        accessedCount: row.accessed_count,
    }));
}
/**
 * 语义搜索事实
 * 将查询文本做 embedding，在 vec_facts 中 KNN 搜索。
 */
export async function searchFacts(query, options = {}) {
    const db = DatabaseManager.getInstance();
    const topK = options.topK ?? 10;
    const minConfidence = options.minConfidence ?? 0.3;
    const proj = normalizeProject(options.project);
    const queryVector = await embed(query);
    const floatQuery = new Float32Array(queryVector);
    const knnLimit = Math.min(topK * 8, 60);
    let knnRows;
    try {
        knnRows = db.prepare(`
      SELECT rowid, distance
      FROM vec_facts
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(floatQuery, knnLimit);
    }
    catch {
        return [];
    }
    if (knnRows.length === 0)
        return [];
    const rowidMap = new Map();
    for (const r of knnRows) {
        rowidMap.set(Number(r.rowid), r.distance);
    }
    const conditions = ['f.is_active = 1', 'f.project = ?', `f.rowid IN (${knnRows.map(() => '?').join(',')})`];
    const params = [proj, ...knnRows.map(r => Number(r.rowid))];
    if (options.subject) {
        conditions.push('f.subject = ?');
        params.push(options.subject);
    }
    const rows = db.prepare(`
    SELECT f.rowid, f.id, f.subject, f.predicate, f.object, f.confidence,
           f.source_memory_id, f.created_at, f.updated_at
    FROM facts f
    WHERE ${conditions.join(' AND ')}
    ORDER BY f.confidence DESC
  `).all(...params);
    const results = [];
    for (const row of rows) {
        const dist = rowidMap.get(row.rowid) ?? 1.0;
        const similarity = Math.max(0, 1.0 - dist);
        const confidence = row.confidence;
        if (confidence < minConfidence)
            continue;
        results.push({
            id: row.id,
            subject: row.subject,
            predicate: row.predicate,
            object: row.object,
            confidence,
            similarity: Math.round(similarity * 1000) / 1000,
            sourceMemoryId: row.source_memory_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        });
    }
    // 按 similarity × confidence 排序
    results.sort((a, b) => (b.similarity * b.confidence) - (a.similarity * a.confidence));
    // 更新 accessed_count
    if (results.length > 0) {
        try {
            const now = new Date().toISOString();
            const update = db.prepare('UPDATE facts SET accessed_count = accessed_count + 1, updated_at = ? WHERE id = ?');
            const tx = db.transaction((ids) => { for (const id of ids)
                update.run(now, id); });
            tx(results.map(r => r.id));
        }
        catch { }
    }
    return results;
}
