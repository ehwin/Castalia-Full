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
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'fs';

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

// 反思历史记录文件(每行一条 JSON,追加写;防误提交可回看)
const REFLECT_HISTORY_PATH = join(DB_DIR, 'reflect_history.jsonl');
const REFLECT_HISTORY_MAX = 200;

/** 追加一条反思历史(写入失败不阻塞主流程;超过上限裁剪保留最新) */
function appendReflectHistory(entry) {
  try {
    appendFileSync(REFLECT_HISTORY_PATH, JSON.stringify(entry) + '\n', 'utf-8');
    const lines = readFileSync(REFLECT_HISTORY_PATH, 'utf-8').split('\n').filter(l => l.trim());
    if (lines.length > REFLECT_HISTORY_MAX) {
      writeFileSync(REFLECT_HISTORY_PATH, lines.slice(lines.length - REFLECT_HISTORY_MAX).join('\n') + '\n', 'utf-8');
    }
  } catch (e) {
    console.error('[reflect-history] write failed:', e.message);
  }
}

/** 读取反思历史(倒序,最新在前) */
function readReflectHistory(limit = 20) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  try {
    if (!existsSync(REFLECT_HISTORY_PATH)) return [];
    const lines = readFileSync(REFLECT_HISTORY_PATH, 'utf-8').split('\n').filter(l => l.trim());
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
      try { out.push(JSON.parse(lines[i])); } catch { /* 跳过损坏行 */ }
    }
    return out;
  } catch (e) {
    console.error('[reflect-history] read failed:', e.message);
    return [];
  }
}

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
function mcpCall(toolName, args = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [MCP_SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        MEMORY_DB_DIR: DB_DIR,
        ...(LEGACY_DB_PATH ? { MEMORY_DB_PATH: LEGACY_DB_PATH } : {}),
        MEMORY_CONFIG: CONFIG_PATH,
        MCP_TOOLS: process.env.MCP_TOOLS || 'all',
        // 密钥文件:子进程 configLoader 靠它解密 keys.enc 注入 LLM/嵌入 key(否则反思/嵌入无 key)
        CASTALIA_KEYS_FILE: join(DB_DIR, 'keys.enc'),
        CASTALIA_KEY_FILE: join(DB_DIR, 'keys.key'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // 子进程 stderr 落盘(排障):<DB_DIR>/mcp_call_stderr.log
    try {
      const fsmod = require('node:fs');
      const logPath = join(DB_DIR, 'mcp_call_stderr.log');
      child.stderr.on('data', (d) => { try { fsmod.appendFileSync(logPath, `[${toolName}] ${d.toString()}`); } catch {} });
    } catch {}
    let buf = '';
    let id = 0;
    const pending = {};
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP 调用超时(' + Math.round(timeoutMs / 1000) + 's)')); }, timeoutMs);

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
  if (!db) return res.json({ nodes: [], links: [], stats: { totalNodes: 0, totalLinks: 0, byType: {}, byCategory: {}, byTier: {}, byMemType: {} } });
  try {
    const memories = db.prepare(`
      SELECT id, text, project, type, mem_type, category, subcategory, tags,
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
        project: m.project || 'default',
        type: m.type, memType: m.mem_type || 'general', category: m.category, subcategory: m.subcategory,
        tags, importance: m.importance,
        source: m.source, subject: m.subject, tier: m.tier || 'standard',
        expiresAt: m.expires_at, createdAt: m.created_at, accessedCount: m.accessed_count,
        starred: (m.importance || 0.5) >= 0.9,
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

    const stats = { totalNodes: nodes.length, totalLinks: links.length, byType: {}, byCategory: {}, byTier: {}, byMemType: {} };
    for (const n of nodes) {
      stats.byType[n.type] = (stats.byType[n.type] || 0) + 1;
      stats.byCategory[n.category] = (stats.byCategory[n.category] || 0) + 1;
      stats.byTier[n.tier] = (stats.byTier[n.tier] || 0) + 1;
      stats.byMemType[n.memType] = (stats.byMemType[n.memType] || 0) + 1;
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

app.post('/api/memory/toggle_important', (req, res) => {
  try {
    const id = req.body && req.body.id;
    if (!id) return res.json({ ok: false, error: 'id 必填' });
    const db = openDb();
    if (!db) return res.json({ ok: false, error: 'db not found' });
    const row = db.prepare('SELECT importance FROM memory WHERE id = ?').get(id);
    if (!row) { db.close(); return res.json({ ok: false, error: 'memory not found' }); }
    const starred = (row.importance || 0) < 0.9;
    const nextImportance = starred ? 1.0 : 0.5;
    db.prepare('UPDATE memory SET importance = ?, updated_at = ? WHERE id = ?').run(nextImportance, new Date().toISOString(), id);
    db.close();
    res.json({ ok: true, id, importance: nextImportance, starred });
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
// mode: 'auto' | 'deep'(旧,单库日常/深度反思) — 通过 MCP client 调 dist/index.js
// mode: 'all' | 'project'(新,跨库总反思 reflect_all → reflect 总库) — 见 handleReflectAll
app.post('/api/reflect/run', async (req, res) => {
  const mode = req.body.mode;
  if (mode === 'all' || mode === 'project') {
    return handleReflectAll(req, res);
  }
  // 旧模式 auto/deep(向后兼容 index.html 的反思按钮)
  const toolName = mode === 'deep' ? 'reflect_deep' : 'reflect_auto';
  const limit = parseInt(req.body.limit || (toolName === 'reflect_deep' ? '500' : '30'), 10);
  try {
    const result = await mcpCall(toolName, { limit });
    const text = result?.content?.[0]?.text || '{}';
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    res.json(parsed);
  } catch (e) {
    res.status(502).json({ error: '反思调用失败: ' + e.message });
  }
});

/** 跨库总反思:mode='all'(全机所有库) / mode='project'(指定库) → reflect_all → 追加历史 */
async function handleReflectAll(req, res) {
  const body = req.body || {};
  const mode = body.mode === 'project' ? 'project' : 'all';
  const dryRun = body.dryRun === true;
  const projects = Array.isArray(body.projects)
    ? body.projects.map(x => String(x)).filter(Boolean)
    : (body.projects ? [String(body.projects)] : []);
  if (mode === 'project' && projects.length === 0) {
    return res.status(400).json({ ok: false, mode, dryRun, error: 'mode=project 时必须提供 projects 库名(如 ["hermes"])' });
  }

  const args = { dryRun };
  if (mode === 'project') args.projects = projects;
  if (Number.isFinite(Number(body.maxTotal)) && Number(body.maxTotal) > 0) args.maxTotal = Number(body.maxTotal);
  if (Number.isFinite(Number(body.maxPerLib)) && Number(body.maxPerLib) > 0) args.maxPerLib = Number(body.maxPerLib);

  const base = {
    ok: false, mode, dryRun,
    scanned: { libraries: 0, memories: 0 },
    llm: { insights: 0, skipped: 0, saved: 0 },
    errors: [], insightList: [],
  };

  try {
    // reflect_all 会调 LLM,可能 1-3 分钟;超时给足 300s
    const result = await mcpCall('reflect_all', args, 300000);
    const text = (result?.content || []).map(c => c.text || '').join('');
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object') {
      base.errors = ['reflect_all 返回无法解析的结果: ' + text.slice(0, 300)];
      appendReflectHistory(historyEntry(base, projects));
      return res.status(502).json(base);
    }

    const out = {
      ok: parsed.ok === true,
      mode, dryRun,
      scanned: parsed.scanned || { libraries: 0, memories: 0 },
      llm: parsed.llm || { insights: 0, skipped: 0, saved: 0 },
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      insightList: Array.isArray(parsed.insightList) ? parsed.insightList : [],
    };
    // reflect_all 工具级异常(index.ts catch → err():{error:{code,message}})
    if (!out.ok && parsed.error?.message) out.errors = [parsed.error.message, ...out.errors];
    // LLM 未配置等错误在 errors 里;若完全空但 ok=false,给个兜底
    if (!out.ok && out.errors.length === 0) out.errors = ['reflect_all 执行失败(无详细错误)'];

    appendReflectHistory(historyEntry(out, projects));
    res.json(out);
  } catch (e) {
    base.errors = ['反思调用失败: ' + e.message];
    appendReflectHistory(historyEntry(base, projects));
    res.status(502).json(base);
  }
}

/** 把 reflect 结果规整为历史记录条目(insightTexts/sources 按顺序对应) */
function historyEntry(out, projects) {
  const list = out.insightList || [];
  return {
    ts: new Date().toISOString(),
    mode: out.mode,
    projects: out.mode === 'project' ? projects : null,
    dryRun: out.dryRun,
    ok: out.ok === true,
    scanned: out.scanned || { libraries: 0, memories: 0 },
    llm: out.llm || { insights: 0, skipped: 0, saved: 0 },
    errors: out.errors || [],
    insightTexts: list.map(i => (typeof i.text === 'string' ? i.text : '')),
    sources: list.map(i => (Array.isArray(i.sources) ? i.sources : [])),
  };
}

// ═══ API: GET /api/reflect/history ═══
// 倒序返回反思历史(最新在前),limit 默认 20 最大 100
app.get('/api/reflect/history', (req, res) => {
  const limit = parseInt(req.query.limit || '20', 10);
  res.json({ ok: true, history: readReflectHistory(limit) });
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

// ═══ 库管理(手动调整记忆归属)═══
function safeFilePart(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';
}

function libFilePath(project) {
  return join(DB_DIR, `project-${safeFilePart(project)}.sqlite`);
}

/** 按 instance+project 定位库;只按 project 也能兜底匹配(同名跨实例时以 instance 优先) */
function findLib(instance, project) {
  const libs = libFiles();
  if (instance && project) {
    const exact = libs.find(l => l.instance === instance && l.project === project);
    if (exact) return exact;
  }
  if (project) return libs.find(l => l.project === project) || null;
  return null;
}

/** 定位记忆所在源库文件:优先 fromInstance/fromProject,miss 时全库扫描(只读)。
 *  不排除目标库 —— 源库==目标库的「同库移动」由调用方判 skip。 */
function resolveSourceFile(id, fromInstance, fromProject) {
  if (fromInstance || fromProject) {
    const lib = findLib(fromInstance, fromProject);
    if (lib) {
      let db = null;
      try {
        db = openLibDb(lib.file, true);
        if (db && db.prepare('SELECT 1 FROM memory WHERE id = ?').get(id)) return lib.file;
      } catch {} finally { if (db) { try { db.close(); } catch {} } }
    }
  }
  for (const l of libFiles()) {
    let db = null;
    try {
      db = openLibDb(l.file, true);
      if (db && db.prepare('SELECT 1 FROM memory WHERE id = ?').get(id)) return l.file;
    } catch {} finally { if (db) { try { db.close(); } catch {} } }
  }
  return null;
}

/** 建目标库 schema(与 dist/db.ts initProjectSchema 对齐;调用前须已 sqliteVec.load) */
function ensureLibSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      project TEXT DEFAULT 'default',
      session_id TEXT,
      type TEXT DEFAULT 'episodic',
      mem_type TEXT DEFAULT 'general',
      category TEXT DEFAULT 'general',
      subcategory TEXT,
      tags TEXT DEFAULT '[]',
      importance REAL DEFAULT 0.5,
      character_id TEXT,
      source TEXT,
      subject TEXT DEFAULT 'user',
      tier TEXT DEFAULT 'standard',
      expires_at DATETIME,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      accessed_count INTEGER DEFAULT 0,
      reference_count INTEGER DEFAULT 0,
      locked INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      project TEXT DEFAULT 'default',
      confidence REAL DEFAULT 0.5,
      source_memory_id TEXT,
      character_id TEXT,
      is_active INTEGER DEFAULT 1,
      accessed_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS categories (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      parent TEXT,
      color TEXT,
      is_parent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS embedding_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text_hash TEXT UNIQUE NOT NULL,
      embedding BLOB NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS instructions (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      project TEXT,
      content TEXT NOT NULL,
      paths TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  try { db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[1024])'); } catch (e) { console.error('vec_memory create failed:', e.message); }
  try { db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(embedding float[1024])'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project, is_active)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_memory_mem_type ON memory(mem_type, is_active)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_memory_tier ON memory(tier, is_active)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project, is_active)'); } catch {}
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_spo ON facts(subject, predicate, object, project)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject, is_active)'); } catch {}
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

// ═══ 库管理 API:库列表 / 库内列表 / 移动 / 改类 / 软删 ═══

// 所有库及记忆数(active=is_active=1 数,total=全量数)
app.get('/api/manage/libraries', (req, res) => {
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

// 单库记忆列表(活跃),可按 q 过滤文本/类型/分类
app.get('/api/manage/memories', (req, res) => {
  const instance = String(req.query.instance || '');
  const project = String(req.query.project || '');
  const q = String(req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 2000);
  const lib = findLib(instance, project);
  if (!lib) return res.json({ ok: false, error: '库不存在(instance/project 未匹配)', memories: [] });
  let db = null;
  try {
    db = openLibDb(lib.file);
    if (!db) return res.json({ ok: false, error: 'open_failed', memories: [] });
    const base = `SELECT id, substr(text,1,600) AS text, length(text) AS textLen, type, mem_type, category, tier, importance, source, created_at, updated_at FROM memory`;
    let rows;
    if (q) {
      const like = `%${q}%`;
      rows = db.prepare(`${base} WHERE is_active=1 AND (text LIKE ? OR mem_type LIKE ? OR category LIKE ? OR type LIKE ?) ORDER BY created_at DESC LIMIT ?`)
        .all(like, like, like, like, limit);
    } else {
      rows = db.prepare(`${base} WHERE is_active=1 ORDER BY created_at DESC LIMIT ?`).all(limit);
    }
    db.close();
    res.json({
      ok: true, count: rows.length,
      memories: rows.map(r => ({
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
      })),
    });
  } catch (e) {
    if (db) { try { db.close(); } catch {} }
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

// 跨库移动记忆:源库可在任意实例,目标恒为当前实例 <DB_DIR>/project-<toProject>.sqlite
app.post('/api/memory/move', (req, res) => {
  try {
    const body = req.body || {};
    const ids = Array.isArray(body.ids) ? body.ids.map(x => String(x)) : null;
    const toProject = String(body.toProject || '').trim();
    if (!ids || ids.length === 0) return res.json({ ok: false, error: 'ids 必填(非空数组)', moved: 0, failed: [] });
    if (!toProject) return res.json({ ok: false, error: 'toProject 必填', moved: 0, failed: [] });
    const fromProject = body.fromProject ? String(body.fromProject).trim() : '';
    const fromInstance = body.fromInstance ? String(body.fromInstance).trim() : '';
    const targetFile = libFilePath(toProject);

    const moved = [];
    const failed = [];
    const skipped = [];

    for (const id of ids) {
      if (!id) { failed.push({ id, error: 'empty id' }); continue; }
      let srcDb = null, dstDb = null;
      try {
        const srcFile = resolveSourceFile(id, fromInstance, fromProject);
        if (!srcFile) { failed.push({ id, error: 'not found in any library' }); continue; }
        if (srcFile === targetFile) { skipped.push({ id, error: 'same library (toProject == fromProject)' }); continue; }

        srcDb = openLibDb(srcFile, false);
        if (!srcDb) { failed.push({ id, error: 'open source failed' }); continue; }

        const srcMem = srcDb.prepare('SELECT rowid, * FROM memory WHERE id = ?').get(id);
        if (!srcMem) { failed.push({ id, error: 'source row missing' }); continue; }

        if (!existsSync(targetFile)) {
          mkdirSync(dirname(targetFile), { recursive: true });
          dstDb = new Database(targetFile);
          try { sqliteVec.load(dstDb); } catch {}
          ensureLibSchema(dstDb);
        } else {
          dstDb = openLibDb(targetFile, false);
          if (!dstDb) dstDb = new Database(targetFile);
        }

        // 幂等:目标已存在同 id → 跳过
        if (dstDb.prepare('SELECT 1 FROM memory WHERE id = ?').get(id)) { skipped.push({ id, error: 'already exists in target' }); continue; }

        // 源向量(可能无,如 conversation_log / 未嵌入);文本不变 → 向量不变,原样复制不重新嵌入
        let vecBuf = null;
        try {
          const vr = srcDb.prepare('SELECT embedding FROM vec_memory WHERE rowid = ?').get(BigInt(srcMem.rowid));
          if (vr && vr.embedding) vecBuf = vr.embedding;
        } catch {}

        // 目标插入:固定标准字段(丢弃源库非标准扩展列),project 覆盖为目标库名,created_at 保留历史
        const COLS = ['id','text','project','session_id','type','mem_type','category','subcategory','tags','importance','character_id','source','subject','tier','expires_at','is_active','created_at','updated_at','last_accessed_at','accessed_count','reference_count','locked'];
        const vals = COLS.map(c => c === 'project' ? toProject : (srcMem[c] === undefined ? null : srcMem[c]));
        const insertTx = dstDb.transaction(() => {
          const info = dstDb.prepare(`INSERT INTO memory (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`).run(...vals);
          if (vecBuf) dstDb.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(BigInt(info.lastInsertRowid), vecBuf);
        });
        insertTx();

        // 源库删除:vec 行 → edges 行 → memory 行(事务;关系边跨库无效直接删)
        const delTx = srcDb.transaction(() => {
          try { srcDb.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(BigInt(srcMem.rowid)); } catch {}
          try { srcDb.prepare('DELETE FROM edges WHERE source_id = ? OR target_id = ?').run(id, id); } catch {}
          srcDb.prepare('DELETE FROM memory WHERE id = ?').run(id);
        });
        delTx();

        moved.push({ id, fromProject: srcMem.project ?? null, toProject });
      } catch (e) {
        failed.push({ id, error: String(e.message).slice(0, 200) });
      } finally {
        if (srcDb) { try { srcDb.close(); } catch {} }
        if (dstDb) { try { dstDb.close(); } catch {} }
      }
    }

    res.json({ ok: true, moved: moved.length, skipped: skipped.length, movedIds: moved, failed, skipped });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message), moved: 0, failed: [] });
  }
});

// 单条记忆改类(优先 memType;也可 category/tier/importance)——按 instance+project 定位库
app.post('/api/manage/memory/update', (req, res) => {
  try {
    const { instance, project, id, memType, category, tier, importance } = req.body || {};
    if (!id) return res.json({ ok: false, error: 'id 必填' });
    const lib = findLib(String(instance || ''), String(project || ''));
    if (!lib) return res.json({ ok: false, error: '库不存在' });
    const db = openLibDb(lib.file, false);
    if (!db) return res.json({ ok: false, error: 'open_failed' });
    const sets = [], vals = [];
    if (memType !== undefined && memType !== null) { sets.push('mem_type = ?'); vals.push(String(memType)); }
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

// 单条记忆软删(is_active=0 + 清向量)
app.post('/api/manage/memory/delete', (req, res) => {
  try {
    const { instance, project, id } = req.body || {};
    if (!id) return res.json({ ok: false, error: 'id 必填' });
    const lib = findLib(String(instance || ''), String(project || ''));
    if (!lib) return res.json({ ok: false, error: '库不存在' });
    const db = openLibDb(lib.file, false);
    if (!db) return res.json({ ok: false, error: 'open_failed' });
    const r = db.prepare('UPDATE memory SET is_active = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    try { db.prepare('DELETE FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').run(id); } catch {}
    db.close();
    res.json({ ok: true, deleted: r.changes > 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
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

// 库管理设置页
app.get('/manage.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(readFileSync(join(__dirname, 'public', 'manage.html'), 'utf-8'));
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
