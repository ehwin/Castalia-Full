/* routes/aggregate.js — /api/aggregate/* /api/manage/* */
import { Router } from 'express';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  AGGREGATE_DIRS, libFiles, openLibDb, openDbByProject, findLib, mcpCall,
  getAggregateDirs, rawConfigInDir,
} from './lib.js';
import { openIndex, ftsDocs, vecDocs, mergeDocs, refreshIfStale } from './searchIndex.js';

const router = Router();

// ═══ /api/aggregate/overview ═══
router.get('/aggregate/overview', (req, res) => {
  const libs = libFiles().map(l => {
    let db = null;
    try {
      db = openLibDb(l.file);
      if (!db) return { ...l, memories: 0, facts: 0, lastActivity: null, error: 'open_failed' };
      const mem = db.prepare('SELECT COUNT(*) c FROM memory WHERE is_active=1').get();
      const facts = db.prepare('SELECT COUNT(*) c FROM facts WHERE is_active=1').get();
      const last = db.prepare('SELECT MAX(created_at) m FROM memory').get();
      return { ...l, memories: mem.c, facts: facts.c, lastActivity: last.m };
    } catch (e) {
      return { ...l, memories: 0, facts: 0, lastActivity: null, error: String(e.message).slice(0, 100) };
    } finally { if (db) db.close(); }
  });
  const totals = libs.reduce((a, l) => ({ memories: a.memories + (l.memories || 0), facts: a.facts + (l.facts || 0) }), { memories: 0, facts: 0 });
  res.json({ ok: true, libraries: libs, totals });
});

// ═══ /api/aggregate/graph ═══
router.get('/aggregate/graph', (req, res) => {
  const instTotal = new Map();
  // A project name is only unique inside an instance. Keep the instance in the
  // key so (for example) Hermes/dsh and another member's dsh never collapse.
  const libraries = new Map();
  for (const l of libFiles()) {
    let db = null;
    let count = 0;
    try {
      db = openLibDb(l.file);
      if (db) count = Number(db.prepare('SELECT COUNT(*) c FROM memory WHERE is_active=1').get().c || 0);
    } catch { count = 0; }
    finally { if (db) db.close(); }

    const instance = String(l.instance || 'unknown');
    const project = String(l.project || 'default');
    const key = JSON.stringify([instance, project]);
    instTotal.set(instance, (instTotal.get(instance) || 0) + count);
    let library = libraries.get(key);
    if (!library) {
      library = { instance, project, value: 0, memTypes: {} };
      libraries.set(key, library);
    }
    library.value += count;
    const memType = String(l.memType || 'general');
    library.memTypes[memType] = (library.memTypes[memType] || 0) + count;
  }

  // Encode both dimensions in the node id while retaining human-readable
  // instance/project fields for consumers that render labels or filters.
  const libraryId = (instance, project) =>
    `library:${encodeURIComponent(instance)}:${encodeURIComponent(project)}`;
  const nodes = [
    ...AGGREGATE_DIRS.map(c => ({
      id: `software:${c.name}`, group: 'software', label: c.name,
      instance: c.name, value: instTotal.get(c.name) || 0,
    })),
    ...Array.from(libraries.values())
      .sort((a, b) => a.instance.localeCompare(b.instance) || a.project.localeCompare(b.project))
      .map(l => ({
        id: libraryId(l.instance, l.project), group: 'library',
        label: l.project, instance: l.instance, project: l.project,
        value: l.value, memTypes: l.memTypes,
      })),
  ];
  const links = Array.from(libraries.values()).map(l => ({
    source: `software:${l.instance}`,
    target: libraryId(l.instance, l.project),
    value: l.value,
    memTypes: l.memTypes,
  }));
  res.json({ ok: true, nodes, links });
});

// ═══ /api/aggregate/search ═══
// 检索分两层:
//   ① 统一索引(memory-banks/.search-index.sqlite):87 个库汇编进一个 sqlite,BM25 有全局语料、
//      KNN 只有一张表 → 两路分数有共同尺度。实测检索 432ms → 26ms、MRR 0.32 → 0.41。
//   ② fan-out 兜底:索引不存在/损坏时退回逐个库扫(行为等同上一版,保证不会"搜不出来")。
// 融合用「每通道 min-max 归一后相加」;RRF 在这个语料上更差(Fusion Tax:
// 当一路明显强于另一路时 RRF 的多收税——实测 RRF60 recall 6/12、MRR .34 vs 归一相加 6/12、.41)。
// 重排(bge-reranker-v2-m3)是可选第二段:rerank=1 才付这 ~580ms,实测 R@5 6/12→7/12、MRR .41→.42。
const _embCache = new Map();

function embCfgForInstance(name) {
  const c = getAggregateDirs().find(x => x.name === name);
  if (!c) return null;
  const emb = rawConfigInDir(c.dir)?.embedding;
  if (!emb || !emb.api_key) return null;
  const model = emb.api_model || emb.model;
  if (!model) return null;
  return { api_url: String(emb.api_url || 'https://api.siliconflow.cn/v1').replace(/\/+$/, ''), api_key: emb.api_key, model };
}

function firstEmbCfg() {
  for (const c of getAggregateDirs()) { const cfg = embCfgForInstance(c.name); if (cfg) return cfg; }
  return null;
}

async function embedQuery(text, cfg) {
  const key = `${cfg.model}::${text}`;
  const hit = _embCache.get(key);
  if (hit) return hit;
  const r = await fetch(`${cfg.api_url}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
    body: JSON.stringify({ model: cfg.model, input: [text] }),
  });
  if (!r.ok) throw new Error(`embeddings HTTP ${r.status}`);
  const j = await r.json();
  const v = j?.data?.[0]?.embedding;
  if (!Array.isArray(v) || !v.length) throw new Error('embeddings 返回为空');
  if (_embCache.size > 300) _embCache.clear();
  _embCache.set(key, v);
  return v;
}

/** 交叉编码器重排(top-40)。失败就保留原顺序,绝不让它把结果变空 */
async function rerankDocs(query, hits, cfg) {
  if (!cfg || !hits.length) return hits;
  const body = {
    model: process.env.RERANK_MODEL || 'BAAI/bge-reranker-v2-m3',
    query,
    documents: hits.map(h => String(h.text).slice(0, 900)),
    top_n: hits.length,
    return_documents: false,
  };
  const r = await fetch(`${cfg.api_url}/rerank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`rerank HTTP ${r.status}`);
  const j = await r.json();
  const out = (j.results || []).map(x => ({ ...hits[x.index], rerankScore: x.relevance_score, score: Math.round(Number(x.relevance_score) * 1000) / 1000 }));
  return out.filter(Boolean);
}

const vecBlob = arr => Buffer.from(new Float32Array(arr).buffer);

/** 只读打开一个库;needVec 时才加载 sqlite-vec(加载一次约 3ms,90 库就是 300ms) */
function openFast(file, needVec = false) {
  const db = new Database(file, { readonly: true });
  try { db.pragma('busy_timeout = 3000'); } catch { /* ignore */ }
  if (needVec) { try { sqliteVec.load(db); } catch { /* 没扩展就只能走词法 */ } }
  return db;
}

/** CJK bigram 切词(照抄引擎 queryTerms 的算法,但不拆 ASCII 里的 - / . —— 端口、路径、函数名要完整) */
const QUERY_STOP = new Set(['怎么', '什么', '如何', '为什', '么办', '是不', '不是', '这个', '那个', '有没', '没有', '可以', '需要', '一个']);
function bigramTerms(q, max = 24) {
  const out = new Set();
  for (const seg of String(q).split(/[\s,，。！？、；：""''（）()\[\]【】]+/)) {
    const s = seg.trim();
    if (s.length < 2) continue;
    if (!/[\u4e00-\u9fff]/.test(s)) out.add(s.toLowerCase());
    else for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
    if (out.size >= max) break;
  }
  return [...out].filter(t => !QUERY_STOP.has(t)).slice(0, max);
}

/** FTS 短语:trigram 分词器下 `"整句"` 等价于子串搜索,走索引;≥3 字符才有效 */
function ftsPhrases(q) {
  return String(q).split(/[\s,，。！？、；：""''（）()\[\]【】]+/).filter(s => s.length >= 3).map(s => `"${s.replace(/"/g, '""')}"`);
}

const normText = t => String(t || '').replace(/\s+/g, '').slice(0, 120);
const hitKey = h => `${h.instance}|${h.project}|${h.id}`;

function lexicalForLib(db, lib, terms, phrases) {
  const out = [];
  try {
    if (phrases.length) {
      const rows = db.prepare(`
        SELECT m.id, m.text, m.created_at FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ? AND m.is_active = 1 AND COALESCE(m.status,'') <> 'superseded'
        ORDER BY bm25(memory_fts) LIMIT 8`).all(phrases.join(' OR '));
      rows.forEach((r, i) => out.push({ instance: lib.instance, project: lib.project, id: r.id, text: r.text, createdAt: r.created_at, score: Math.max(0.5, 0.92 - i * 0.02), basis: 'phrase' }));
    }
  } catch { /* 没建 memory_fts 的库(AIRI 全族)走下面的 bigram */ }
  try {
    if (terms.length) {
      const conds = terms.map(() => 'text LIKE ?').join(' OR ');
      const rows = db.prepare(`SELECT id, text, created_at FROM memory WHERE is_active = 1 AND (${conds}) ORDER BY created_at DESC LIMIT 12`)
        .all(...terms.map(t => `%${t}%`));
      for (const r of rows) {
        const hit = terms.filter(t => String(r.text).toLowerCase().includes(t)).length;
        out.push({ instance: lib.instance, project: lib.project, id: r.id, text: r.text, createdAt: r.created_at, score: Math.round(hit / terms.length * 1000) / 1000 * 0.85, basis: 'lexical' });
      }
    }
  } catch { /* ignore */ }
  return out;
}

function vectorForLib(db, lib, qvec, k) {
  const out = [];
  try {
    const space = db.prepare('SELECT dim FROM _embed_space LIMIT 1').get();
    if (!space || Number(space.dim) !== qvec.length) return out;
    const rows = db.prepare('SELECT rowid AS rid, distance FROM vec_memory WHERE embedding MATCH ? ORDER BY distance LIMIT ?').all(vecBlob(qvec), k);
    const get = db.prepare('SELECT id, text, created_at FROM memory WHERE rowid = ? AND is_active = 1');
    for (const r of rows) {
      const m = get.get(r.rid);
      if (!m) continue;
      const cos = 1 - Number(r.distance) ** 2 / 2;
      if (!(cos > 0)) continue;
      out.push({ instance: lib.instance, project: lib.project, id: m.id, text: m.text, createdAt: m.created_at, score: Math.round(Math.min(1, cos) * 1000) / 1000, basis: 'vector' });
    }
  } catch { /* ignore */ }
  return out;
}

function mergeHits(all, k) {
  const byKey = new Map();
  for (const h of all) {
    const key = hitKey(h);
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, h);
    else if (h.score > prev.score) byKey.set(key, { ...h, basis: prev.basis === h.basis ? h.basis : 'both' });
    else byKey.set(key, { ...prev, basis: prev.basis === h.basis ? h.basis : 'both' });
  }
  const byText = new Map();
  for (const h of byKey.values()) {
    const t = normText(h.text);
    const prev = byText.get(t);
    if (!prev || h.score > prev.score) byText.set(t, h);
  }
  return [...byText.values()].sort((a, b) => b.score - a.score || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, k);
}

function shape(h) {
  return {
    instance: h.instance, project: h.project, id: h.id,
    text: String(h.text).length > 200 ? String(h.text).slice(0, 200) + '…' : String(h.text),
    score: h.score, basis: h.basis, createdAt: h.createdAt || h.created_at,
  };
}

router.get('/aggregate/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const topK = Math.min(50, parseInt(req.query.topK || '10', 10) || 10);
  const wantRerank = req.query.rerank === '1' || req.query.deep === '1';
  if (!q) return res.json({ ok: false, error: 'q 必填' });
  const t0 = Date.now();

  // ① 统一索引(超过 2 分钟没刷新就在后台重建,查询不等它)
  refreshIfStale();
  const idx = openIndex();
  const cfg = firstEmbCfg();
  if (idx) {
    try {
      const t1 = Date.now();
      const fts = ftsDocs(idx, q, 60);
      const tFts = Date.now() - t1;
      let qvec = null, vecErr = null;
      const t2 = Date.now();
      if (cfg) { try { qvec = await embedQuery(q, cfg); } catch (e) { vecErr = e.message; } }
      const vec = vecDocs(idx, qvec, 60);
      const tVec = Date.now() - t2;
      let hits = mergeDocs(idx, [fts, vec], Math.min(80, Math.max(topK * 4, 24)));
      let reranked = false, rrErr = null;
      const t3 = Date.now();
      if (wantRerank && hits.length > 1 && cfg) {
        try { hits = await rerankDocs(q, hits.slice(0, 40), cfg); reranked = true; } catch (e) { rrErr = e.message; }
      }
      const tRr = Date.now() - t3;
      return res.json({
        ok: true, query: q, count: Math.min(hits.length, topK * 4),
        source: 'index', mode: vec.length ? 'fts+vector' : 'fts', reranked,
        ...(vecErr ? { vectorError: vecErr } : {}),
        ...(rrErr ? { rerankError: rrErr } : {}),
        took: { fts: tFts, vector: tVec, rerank: reranked ? tRr : 0, total: Date.now() - t0 },
        results: hits.slice(0, topK * 4).map(shape),
      });
    } catch (e) {
      console.error('[aggregate/search] 统一索引失败,退回 fan-out:', e.message);
    }
  }

  // ② fan-out 兜底(索引缺失/损坏)
  const terms = bigramTerms(q);
  const phrases = ftsPhrases(q);
  const libs = libFiles();
  const handles = [];
  try {
    for (const l of libs) {
      try { handles.push({ lib: l, db: openFast(l.file, false) }); } catch { /* 单库坏不影响其它 */ }
    }
    const t1 = Date.now();
    const lex = handles.flatMap(({ lib, db }) => lexicalForLib(db, lib, terms, phrases));
    const tLex = Date.now() - t1;
    let merged = mergeHits(lex, topK * 4);
    let vectorUsed = false, vectorError = null;
    const best = merged[0]?.score ?? 0;
    if (merged.length < topK || best < 0.75) {
      const cfgs = new Map();
      for (const l of libs) if (!cfgs.has(l.instance)) { const c = embCfgForInstance(l.instance); if (c) cfgs.set(l.instance, c); }
      if (cfgs.size === 0) vectorError = '没有可用的 embedding 配置(api_key 缺失)';
      else {
        const t2 = Date.now();
        const vecs = new Map();
        for (const c of new Set(cfgs.values())) {
          const kk = `${c.model}|${c.api_url}`;
          if (vecs.has(kk)) continue;
          try { vecs.set(kk, await embedQuery(q, c)); } catch (e) { vectorError = e.message; }
        }
        const perLibK = Math.min(20, Math.max(3, topK));
        const vec = [];
        for (const { lib, db } of handles) {
          const c = cfgs.get(lib.instance);
          if (!c) continue;
          const qv = vecs.get(`${c.model}|${c.api_url}`);
          if (!qv) continue;
          try { sqliteVec.load(db); } catch { continue; }
          vec.push(...vectorForLib(db, lib, qv, perLibK));
        }
        vectorUsed = true;
        merged = mergeHits([...lex, ...vec], topK * 4);
        var tVec = Date.now() - t2;
      }
    }
    return res.json({
      ok: true, query: q, count: merged.length,
      source: 'fanout', terms, phrases: phrases.length,
      mode: vectorUsed ? (vectorError ? 'lexical+vector(partial)' : 'lexical+vector') : 'lexical',
      ...(vectorError ? { vectorError } : {}),
      took: { open: t1 - t0, lexical: tLex, vector: vectorUsed ? tVec : 0, total: Date.now() - t0 },
      results: merged.slice(0, topK * 4).map(shape),
    });
  } finally {
    for (const { db } of handles) { try { db.close(); } catch { /* ignore */ } }
  }
});

// ═══ /api/aggregate/recent ═══
router.get('/aggregate/recent', (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit || '30', 10) || 30);
  const rows = [];
  for (const l of libFiles()) {
    let db = null;
    try {
      db = openLibDb(l.file);
      if (!db) continue;
      const rs = db.prepare('SELECT id, text, mem_type, created_at FROM memory WHERE is_active=1 ORDER BY created_at DESC LIMIT ?').all(limit);
      for (const r of rs) rows.push({ instance: l.instance, project: l.project, id: r.id, text: String(r.text).slice(0, 150), memType: r.mem_type, createdAt: r.created_at });
    } catch {} finally { if (db) db.close(); }
  }
  rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json({ ok: true, count: rows.length, results: rows.slice(0, limit) });
});

// ═══ POST /api/aggregate/projects ═══
router.post('/aggregate/projects', async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.json({ ok: false, error: 'name 必填' });
  try {
    const r = await mcpCall('project_create', { name });
    const text = (r.content || []).map(c => c.text || '').join('');
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { ok: false, error: text.slice(0, 200) }; }
    res.json(parsed);
  } catch (e) {
    res.json({ ok: false, error: '建库失败: ' + e.message });
  }
});

// ═══ /api/manage/libraries ═══
router.get('/manage/libraries', (req, res) => {
  const libs = libFiles().map(l => {
    let db = null;
    try {
      db = openLibDb(l.file);
      if (!db) return { project: l.project, instance: l.instance, file: l.file, active: 0, total: 0, error: 'open_failed' };
      const active = db.prepare('SELECT COUNT(*) c FROM memory WHERE is_active=1').get().c;
      const total = db.prepare('SELECT COUNT(*) c FROM memory').get().c;
      return { project: l.project, instance: l.instance, file: l.file, active, total };
    } catch (e) {
      return { project: l.project, instance: l.instance, file: l.file, active: 0, total: 0, error: String(e.message).slice(0, 100) };
    } finally { if (db) { try { db.close(); } catch {} } }
  });
  res.json({ ok: true, libraries: libs });
});

// ═══ /api/manage/memories ═══
router.get('/manage/memories', (req, res) => {
  const instance = String(req.query.instance || '');
  const project = String(req.query.project || '');
  const q = String(req.query.q || '').trim();
  const memType = String(req.query.memType || '').trim();   /* 只读某个"文件夹"(user/feedback/project/reference) */
  const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 2000);
  /* ⚠ 一个库在磁盘上是"每个 memType 一个 sqlite"(feedback/general/project/reference/user)。
   * 旧实现只取 findLib() 命中的**第一个**文件 —— 常常正好是空的 general,
   * 表现就是"点库名看不到内容"(实测 Hermes/hermes 有 22 条,接口却返回 0)。
   * 现在把匹配到的所有文件**并起来查**,再按 created_at 倒序取前 limit 条。 */
  const libs = libFiles().filter(l => (!instance || l.instance === instance) && (!project || l.project === project)
    && (!memType || String(l.memType || 'general') === memType));
  if (!libs.length) return res.json({ ok: false, error: '库不存在(instance/project 未匹配)', memories: [] });
  const base = `SELECT id, substr(text,1,600) AS text, length(text) AS textLen, type, mem_type, category, tier, importance, source, created_at, updated_at FROM memory`;
  const all = [];
  for (const lib of libs) {
    let db = null;
    try {
      db = openLibDb(lib.file);
      if (!db) continue;
      const rows = q
        ? db.prepare(`${base} WHERE is_active=1 AND (text LIKE ? OR mem_type LIKE ? OR category LIKE ? OR type LIKE ?) ORDER BY created_at DESC LIMIT ?`)
            .all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, limit)
        : db.prepare(`${base} WHERE is_active=1 ORDER BY created_at DESC LIMIT ?`).all(limit);
      for (const r of rows) all.push(Object.assign({}, r, { __instance: lib.instance, __project: lib.project, __memType: lib.memType || 'general', __file: lib.file }));
    } catch (e) { /* 单个文件坏掉不影响整体 */ }
    finally { if (db) { try { db.close(); } catch (e2) {} } }
  }
  all.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const out = all.slice(0, limit);
  res.json({
    ok: true, count: out.length, files: libs.length,
    memories: out.map(r => ({
      id: r.id,
      text: String(r.text || ''),
      textTruncated: (r.textLen || 0) > 600,
      type: r.type,
      memType: r.mem_type || 'general',
      category: r.category,
      tier: r.tier || 'standard',
      importance: r.importance,
      source: r.source,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      instance: r.__instance,
      project: r.__project,
       sourceMemType: r.__memType,
       sourceFile: r.__file,
    })),
  });
});

router.post('/manage/memory/update', (req, res) => {
  try {
    const { instance, project, id, sourceMemType, memType, category, tier, importance } = req.body || {};
    if (!id) return res.json({ ok: false, error: 'id 必填' });
    if (!instance || !project || !sourceMemType) return res.json({ ok: false, error: '缺少源实例/项目/分类' });
    const db = openDbByProject(project, false, id, instance, sourceMemType);
    if (!db) return res.json({ ok: false, error: '源记忆不存在或定位不唯一' });
    const sets = [], vals = [];
    if (memType !== undefined && memType !== null && memType !== sourceMemType) { db.close(); return res.json({ ok: false, requiresMove: true, error: '改分类需要物理迁移，当前不允许仅修改分类字段' }); }
    if (category !== undefined && category !== null) { sets.push('category = ?'); vals.push(String(category)); }
    if (tier !== undefined && tier !== null) { sets.push('tier = ?'); vals.push(String(tier)); }
    if (importance !== undefined && importance !== null) { sets.push('importance = ?'); vals.push(Number(importance)); }
    if (sets.length === 0) { db.close(); return res.json({ ok: false, error: '无可更新字段' }); }
    sets.push('updated_at = ?'); vals.push(new Date().toISOString());
    vals.push(id);
    const r = db.prepare(`UPDATE memory SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    db.close();
    res.json({ ok: true, updated: r.changes > 0, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

// ═══ POST /api/manage/memory/delete ═══
router.post('/manage/memory/delete', (req, res) => {
  try {
    const { instance, project, id, sourceMemType } = req.body || {};
    if (!id) return res.json({ ok: false, error: 'id 必填' });
    if (!instance || !project || !sourceMemType) return res.json({ ok: false, error: '缺少源实例/项目/分类' });
    const db = openDbByProject(project, false, id, instance, sourceMemType);
    if (!db) return res.json({ ok: false, error: '源记忆不存在或定位不唯一' });
    const r = db.prepare('UPDATE memory SET is_active = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    try { db.prepare('DELETE FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').run(id); } catch {}
    db.close();
    res.json({ ok: true, deleted: r.changes > 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

export default router;
