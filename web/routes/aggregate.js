/* routes/aggregate.js — /api/aggregate/* /api/manage/* */
import { Router } from 'express';
import {
  AGGREGATE_DIRS, libFiles, openLibDb, openDbByProject, findLib, mcpCall,
} from './lib.js';

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
router.get('/aggregate/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const topK = Math.min(50, parseInt(req.query.topK || '10', 10) || 10);
  if (!q) return res.json({ ok: false, error: 'q 必填' });
  const terms = q.split(/[\s,，。！？、；：]+/).filter(t => t.length >= 2);
  const hits = [];
  for (const l of libFiles()) {
    let db = null;
    try {
      db = openLibDb(l.file);
      if (!db) continue;
      let rows;
      if (terms.length === 0) {
        rows = db.prepare('SELECT id, text, created_at FROM memory WHERE is_active=1 ORDER BY created_at DESC LIMIT ?').all(topK);
      } else {
        const conds = terms.map(() => 'text LIKE ?').join(' OR ');
        rows = db.prepare(`SELECT id, text, created_at FROM memory WHERE is_active=1 AND (${conds}) ORDER BY created_at DESC LIMIT ?`).all(...terms.map(t => `%${t}%`), topK);
      }
      for (const r of rows) {
        const hit = terms.filter(t => String(r.text).includes(t)).length;
        hits.push({
          instance: l.instance, project: l.project, id: r.id,
          text: String(r.text).length > 200 ? String(r.text).slice(0, 200) + '…' : String(r.text),
          score: terms.length ? Math.round(hit / terms.length * 1000) / 1000 : 0.1,
          createdAt: r.created_at,
        });
      }
    } catch {} finally { if (db) db.close(); }
  }
  hits.sort((a, b) => b.score - a.score || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json({ ok: true, query: q, count: hits.length, results: hits.slice(0, topK * 4) });
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
