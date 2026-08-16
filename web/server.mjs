/**
 * Castalia Web Console — 3D 可视化主界面 + 管理副界面
 *
 * 独立 Express 服务器:
 *   - /api/graph      : 读取记忆库,输出 { nodes, links } 供 3d-force-graph 渲染
 *   - /api/stats      : 统计
 *   - /api/memory     : 记忆列表/删除/更新(直接 SQLite 读写)
 *   - /api/config     : 读写 config.json(嵌入模型 + 反思 LLM 配置)
 *   - /api/reflect/run: 通过 MCP client 调用 dist/index.js 的 reflect_auto / reflect_deep
 *   - /api/status     : 状态检测
 *
 * 环境变量:
 *   WEB_PORT         默认 3345(避开 AIRI viz 的 3344)
 *   MEMORY_DB_DIR    默认 <项目根>/memory/(按项目分库:global.sqlite + project-<name>.sqlite)
 *   MEMORY_DB_PATH   旧单库路径(兼容模式:显式设置时仍指向单库)
 *   NODE_BIN         默认 node(PATH)
 */
import express from 'express';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const LEGACY_DB_PATH = process.env.MEMORY_DB_PATH || '';
const CONFIG_PATH = process.env.MEMORY_CONFIG || join(ROOT, 'memory', 'config.json');
const NODE_BIN = process.env.NODE_BIN || (existsSync('D:\\system\\New Folder\\node.exe') ? 'D:\\system\\New Folder\\node.exe' : 'node');
const MCP_SERVER = join(ROOT, 'dist', 'index.js');
const PORT = parseInt(process.env.WEB_PORT || '3345', 10);

// 读 config 前确保 memory/ 目录存在(首次启动自动创建)
mkdirSync(dirname(CONFIG_PATH), { recursive: true });

// 记忆目录:env MEMORY_DB_DIR > config.json db_dir > <项目根>/memory/(兼容旧 MEMORY_DB_PATH 单库)
function resolveDbDir() {
  if (process.env.MEMORY_DB_DIR) return process.env.MEMORY_DB_DIR;
  try {
    if (existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      if (cfg.db_dir && typeof cfg.db_dir === 'string' && cfg.db_dir.trim()) return cfg.db_dir.trim();
    }
  } catch {}
  return join(ROOT, 'memory');
}
const DB_DIR = resolveDbDir();
// Web 控制台直接读库:兼容模式指向单库,新目录结构指向默认项目库(project-default.sqlite)
const DB_PATH = LEGACY_DB_PATH || join(DB_DIR, 'project-default.sqlite');

const app = express();
app.use(express.json({ limit: '2mb' }));

function openDb(readonly = false) {
  if (!existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, readonly ? { readonly: true } : {});
  try { sqliteVec.load(db); } catch (e) { console.error('sqlite-vec load failed:', e.message); }
  return db;
}

// ═══ 嵌入配置默认值(Ollama 本地) ═══
function loadConfig() {
  let cfg = {};
  if (existsSync(CONFIG_PATH)) {
    try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
  }
  // 默认值 + 已有配置合并:老配置缺新字段时仍返回默认,保证前端表单有值
  return {
    embedding: {
      mode: 'ollama',
      ollama_url: 'http://127.0.0.1:11436',
      model: 'yuan-embedding-2.0-zh',
      api_url: '', api_key: '', api_model: '',
      ...(cfg.embedding || {}),
    },
    reflect: {
      llm_url: 'https://api.deepseek.com/v1', api_key: '', model: 'deepseek-chat',
      factExtraction: 'auto', maxFacts: 15,
      ...(cfg.reflect || {}),
    },
    triage: {
      llm_url: 'https://api.deepseek.com/v1', api_key: '', model: 'deepseek-chat',
      ...(cfg.triage || {}),
    },
  };
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

// ═══ MCP client:调用 dist/index.js 的反思工具 ═══
function mcpCall(toolName, args = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [MCP_SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        MEMORY_DB_DIR: DB_DIR,
        ...(LEGACY_DB_PATH ? { MEMORY_DB_PATH: LEGACY_DB_PATH } : {}),
        MEMORY_CONFIG: CONFIG_PATH,
        MCP_TOOLS: process.env.MCP_TOOLS || 'all',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let id = 0;
    const pending = {};
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP 调用超时(120s)')); }, 120000);

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && pending[msg.id]) { pending[msg.id](msg); delete pending[msg.id]; }
        } catch {}
      }
    });
    child.stderr.on('data', () => {});  // 日志忽略
    child.on('exit', () => { clearTimeout(timer); });

    const initId = ++id;
    pending[initId] = () => {
      const callId = ++id;
      pending[callId] = (msg) => {
        clearTimeout(timer);
        child.kill();
        if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
        else resolve(msg.result);
      };
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name: toolName, arguments: args } }) + '\n');
    };
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: initId, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'castalia-web', version: '1.0' } },
    }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  });
}

// ═══ API: GET /api/graph ═══
app.get('/api/graph', (req, res) => {
  const db = openDb(true);
  if (!db) return res.json({ nodes: [], links: [], stats: { totalNodes: 0, totalLinks: 0, byType: {}, byCategory: {}, byTier: {} } });
  try {
    const memories = db.prepare(`
      SELECT id, text, type, category, subcategory, tags,
             importance, character_id, source,
             subject, tier, expires_at, created_at, accessed_count
      FROM memory WHERE is_active = 1 ORDER BY created_at ASC
    `).all();

    let edges = [];
    try { edges = db.prepare('SELECT source_id, target_id, relation_type FROM edges').all(); } catch {}

    const categoryColors = {
      emotional: '#FF6B6B', milestone: '#FFA726', identity: '#66BB6A',
      relationship: '#42A5F5', mood_snapshot: '#FFD54F', conversation: '#AB47BC',
      knowledge: '#26A69A', preference: '#EC407A', decision: '#FFA726',
      mistake: '#EF5350', general: '#78909C',
    };

    const nodes = memories.map(m => {
      let tags = [];
      try { tags = JSON.parse(m.tags || '[]'); } catch {}
      const isTemporary = m.tier === 'temporary';
      const isCritical = m.tier === 'critical';
      return {
        id: m.id,
        label: m.text.length > 60 ? m.text.slice(0, 60) + '...' : m.text,
        fullText: m.text,
        type: m.type, category: m.category, subcategory: m.subcategory,
        tags, importance: m.importance,
        source: m.source, subject: m.subject, tier: m.tier || 'standard',
        expiresAt: m.expires_at, createdAt: m.created_at, accessedCount: m.accessed_count,
        valence: isCritical ? (m.importance * 12 + 5) : isTemporary ? (m.importance * 5 + 2) : (m.importance * 8 + 3),
        color: categoryColors[m.category] || '#90A4AE',
        isTemporary, isCritical,
      };
    });

    const nodeIds = new Set(nodes.map(n => n.id));
    const links = edges
      .filter(e => nodeIds.has(e.source_id) && nodeIds.has(e.target_id))
      .map(e => ({ source: e.source_id, target: e.target_id, type: e.relation_type }));

    // 相似度链接(<=100 节点时)
    if (memories.length <= 100) {
      try {
        const vecRows = db.prepare(`
          SELECT m.id, v.embedding FROM memory m
          JOIN vec_memory v ON m.rowid = v.rowid WHERE m.is_active = 1
        `).all();
        const embeddings = vecRows.map(r => ({
          id: r.id,
          vec: Array.from(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)),
        }));
        const cosSim = (a, b) => {
          let dot = 0, ma = 0, mb = 0;
          for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
          return dot / (Math.sqrt(ma) * Math.sqrt(mb));
        };
        const SIM_THRESHOLD = 0.65;
        const existing = new Set(links.map(l => `${l.source}|${l.target}`));
        for (let i = 0; i < embeddings.length; i++) {
          const sims = [];
          for (let j = 0; j < embeddings.length; j++) {
            if (i === j) continue;
            sims.push({ id: embeddings[j].id, sim: cosSim(embeddings[i].vec, embeddings[j].vec) });
          }
          sims.sort((a, b) => b.sim - a.sim);
          for (const s of sims.slice(0, 2)) {
            if (s.sim < SIM_THRESHOLD) break;
            const k1 = `${embeddings[i].id}|${s.id}`, k2 = `${s.id}|${embeddings[i].id}`;
            if (!existing.has(k1) && !existing.has(k2)) {
              links.push({ source: embeddings[i].id, target: s.id, type: 'similarity', similarity: Math.round(s.sim * 100) / 100 });
              existing.add(k1);
            }
          }
        }
      } catch (e) { console.error('Similarity links failed:', e.message); }
    }

    const stats = { totalNodes: nodes.length, totalLinks: links.length, byType: {}, byCategory: {}, byTier: {} };
    for (const n of nodes) {
      stats.byType[n.type] = (stats.byType[n.type] || 0) + 1;
      stats.byCategory[n.category] = (stats.byCategory[n.category] || 0) + 1;
      stats.byTier[n.tier] = (stats.byTier[n.tier] || 0) + 1;
    }
    db.close();
    res.json({ nodes, links, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ API: GET /api/stats ═══
app.get('/api/stats', (req, res) => {
  const db = openDb(true);
  if (!db) return res.json({ total: 0, edges: 0 });
  try {
    const total = db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active=1').get();
    let edgesC = 0;
    try { edgesC = db.prepare('SELECT COUNT(*) as c FROM edges').get().c; } catch { /* edges 表可能未创建 */ }
    db.close();
    res.json({ total: total.c, edges: edgesC });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ API: GET /api/status ═══
app.get('/api/status', (req, res) => {
  const cfg = loadConfig();
  const dbPath = DB_PATH;
  res.json({
    db: LEGACY_DB_PATH ? DB_PATH : DB_DIR,
    dbPath,
    config: CONFIG_PATH,
    dbExists: existsSync(dbPath),
    embedMode: cfg.embedding?.mode || 'ollama',
    reflectConfigured: !!(cfg.reflect?.api_key),
  });
});

// ═══ API: GET/POST /api/config ═══
app.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  // 隐藏 api_key 明文(仅返回是否已配置)
  const safe = JSON.parse(JSON.stringify(cfg));
  if (safe.embedding?.api_key) safe.embedding.api_key = safe.embedding.api_key ? '****' : '';
  if (safe.reflect?.api_key) safe.reflect.api_key = safe.reflect.api_key ? '****' : '';
  if (safe.triage?.api_key) safe.triage.api_key = safe.triage.api_key ? '****' : '';
  res.json(safe);
});

app.post('/api/config', (req, res) => {
  try {
    const cur = loadConfig();
    const next = { ...cur, ...req.body };
    // 保留旧 key:前端传 '****' 表示未修改
    if (next.embedding?.api_key === '****') next.embedding.api_key = cur.embedding?.api_key || '';
    if (next.reflect?.api_key === '****') next.reflect.api_key = cur.reflect?.api_key || '';
    if (next.triage?.api_key === '****') next.triage.api_key = cur.triage?.api_key || '';
    saveConfig(next);
    res.json({ ok: true, path: CONFIG_PATH, note: '已保存。若 MCP server 正在运行,重启后配置生效' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ API: 记忆管理(直接 SQLite 读写) ═══
app.get('/api/memory', (req, res) => {
  const db = openDb(true);
  if (!db) return res.json([]);
  try {
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
    let rows;
    if (req.query.q) {
      const q = `%${req.query.q}%`;
      rows = db.prepare(`SELECT * FROM memory WHERE is_active=1 AND text LIKE ? ORDER BY created_at DESC LIMIT ?`).all(q, limit);
    } else {
      rows = db.prepare('SELECT * FROM memory WHERE is_active=1 ORDER BY created_at DESC LIMIT ?').all(limit);
    }
    db.close();
    res.json(rows.map(r => ({ ...r, tags: safeTags(r.tags) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function safeTags(raw) {
  try { const p = JSON.parse(raw || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
}

app.post('/api/memory/delete', (req, res) => {
  const db = openDb();
  if (!db) return res.json({ deleted: false });
  try {
    const r = db.prepare('UPDATE memory SET is_active = 0 WHERE id = ?').run(req.body.id);
    try { db.prepare('DELETE FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').run(req.body.id); } catch {}
    db.close();
    res.json({ deleted: r.changes > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/memory/update', (req, res) => {
  try {
    const { id, fields } = req.body;
    const allowed = ['text', 'category', 'tags', 'importance', 'tier'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        sets.push(`${k === 'tags' ? 'tags' : k} = ?`);
        vals.push(k === 'tags' ? JSON.stringify(fields[k]) : fields[k]);
      }
    }
    if (sets.length === 0) return res.json({ updated: false });
    sets.push('updated_at = ?');
    vals.push(new Date().toISOString());
    vals.push(id);
    const db = openDb();
    if (!db) return res.json({ updated: false });
    const r = db.prepare(`UPDATE memory SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    db.close();
    res.json({ updated: r.changes > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ API: POST /api/reflect/run ═══
// mode: 'auto' | 'deep' — 通过 MCP client 调 dist/index.js
app.post('/api/reflect/run', async (req, res) => {
  const mode = req.body.mode === 'deep' ? 'reflect_deep' : 'reflect_auto';
  const limit = parseInt(req.body.limit || (mode === 'reflect_deep' ? '500' : '30'), 10);
  try {
    const result = await mcpCall(mode, { limit });
    const text = result?.content?.[0]?.text || '{}';
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    res.json(parsed);
  } catch (e) {
    res.status(502).json({ error: '反思调用失败: ' + e.message });
  }
});

// ═══ 记忆总成(聚合本机多实例库:只读总览/搜索/动态 + 建库)═══
// 2026-08-16:库管理 + 跨库互通接口(显式语义,引擎不自动合并库)
const AGGREGATE_DIRS = (() => {
  const raw = process.env.AGGREGATE_DIRS;
  if (raw) { try { const d = JSON.parse(raw); if (Array.isArray(d) && d.length) return d; } catch {} }
  const cands = [
    { name: 'Hermes', dir: 'D:\\AI\\castalia-run\\memory' },
    { name: 'LobeHub', dir: 'D:\\AI\\lobehub-run\\memory' },
    { name: 'AIRI', dir: 'D:\\AI\\anima-run\\memory' },
    { name: '当前实例', dir: DB_DIR },
  ];
  const seen = new Set();
  return cands.filter(c => c.dir && existsSync(c.dir) && !seen.has(c.dir) && seen.add(c.dir));
})();

function openLibDb(file, readonly = true) {
  if (!existsSync(file)) return null;
  const db = new Database(file, readonly ? { readonly: true } : {});
  try { sqliteVec.load(db); } catch (e) { console.error('sqlite-vec load failed:', e.message); }
  return db;
}

function libFiles() {
  const out = [];
  for (const c of AGGREGATE_DIRS) {
    try {
      for (const f of readdirSync(c.dir)) {
        if (f.startsWith('project-') && f.endsWith('.sqlite')) {
          out.push({ instance: c.name, project: f.slice('project-'.length, -'.sqlite'.length), file: join(c.dir, f) });
        }
      }
    } catch {}
  }
  return out;
}

// 总览:每个库的条数/最近更新
app.get('/api/aggregate/overview', (req, res) => {
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

// 总成视图:二分图(software 实例 ↔ library 库),只读
app.get('/api/aggregate/graph', (req, res) => {
  const instTotal = {};  // instance -> 记忆总数
  const projTotal = {};  // project  -> 记忆总数(跨实例同名库合并)
  const links = [];
  for (const l of libFiles()) {
    let db = null;
    let count = 0;
    try {
      db = openLibDb(l.file);
      if (db) count = db.prepare('SELECT COUNT(*) c FROM memory WHERE is_active=1').get().c;
    } catch { count = 0; }
    finally { if (db) db.close(); }
    instTotal[l.instance] = (instTotal[l.instance] || 0) + count;
    projTotal[l.project] = (projTotal[l.project] || 0) + count;
    links.push({ source: `software:${l.instance}`, target: `library:${l.project}`, value: count });
  }
  const nodes = [
    ...AGGREGATE_DIRS.map(c => ({ id: `software:${c.name}`, group: 'software', label: c.name, value: instTotal[c.name] || 0 })),
    ...Object.keys(projTotal).sort().map(p => ({ id: `library:${p}`, group: 'library', label: p, value: projTotal[p] })),
  ];
  res.json({ ok: true, nodes, links });
});

// 聚合搜索(文本模式,只读,按库分组)
app.get('/api/aggregate/search', (req, res) => {
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

// 最近动态:所有库最新记忆
app.get('/api/aggregate/recent', (req, res) => {
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

// 建库(经 MCP 调本实例 dist 的 project_create,保证 schema 正确)
app.post('/api/aggregate/projects', async (req, res) => {
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

// ═══ 静态服务 ═══
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(readFileSync(join(__dirname, 'public', 'index.html'), 'utf-8'));
});

// 记忆总成页
app.get('/aggregate.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(readFileSync(join(__dirname, 'public', 'aggregate.html'), 'utf-8'));
});

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   Castalia Web Console                  ║
  ║   http://127.0.0.1:${PORT}                  ║
  ║   DB_DIR: ${DB_DIR}  ║
  ╚══════════════════════════════════════════╝
  `);
});
