/* routes/lib.js — 共享常量/路径/DB 访问/MCP client/反思历史(供各 route 模块使用) */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, isAbsolute } from 'path';
import { readRegistry, scanMember } from './memberRegistry.js';
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, lstatSync, realpathSync, renameSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');   // routes/ 位于 <root>/viz/routes/,ROOT = <root>(castalia-run 等实例根)
const LEGACY_DB_PATH = process.env.MEMORY_DB_PATH || '';
const CONFIG_PATH = process.env.MEMORY_CONFIG || (process.env.MEMORY_DB_DIR ? join(process.env.MEMORY_DB_DIR, 'config.json') : join(ROOT, 'memory', 'config.json'));
const NODE_BIN = process.env.NODE_BIN || 'node';
function resolveMcpServer() {
  if (process.env.CASTALIA_MCP && existsSync(process.env.CASTALIA_MCP)) return process.env.CASTALIA_MCP;
  if (process.env.ANIMA_DIR) {
    const p = join(process.env.ANIMA_DIR, 'dist', 'index.js');
    if (existsSync(p)) return p;
  }
  return join(ROOT, 'dist', 'index.js');
}
const MCP_SERVER = resolveMcpServer();
const PORT = parseInt(process.env.WEB_PORT || '3345', 10);

// 读 config 前确保 memory/ 目录存在(首次启动自动创建)
mkdirSync(dirname(CONFIG_PATH), { recursive: true });

// 记忆目录:env MEMORY_DB_DIR > config.json db_dir > <项目根>/memory/
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
const DB_PATH = LEGACY_DB_PATH || join(DB_DIR, 'project-default.sqlite');

// 反思历史记录文件
const REFLECT_HISTORY_PATH = join(DB_DIR, 'reflect_history.jsonl');
const REFLECT_HISTORY_MAX = 200;

/** 追加一条反思历史 */
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

/** 读取反思历史(倒序) */
function readReflectHistory(limit = 20) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  try {
    if (!existsSync(REFLECT_HISTORY_PATH)) return [];
    const lines = readFileSync(REFLECT_HISTORY_PATH, 'utf-8').split('\n').filter(l => l.trim());
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
      try { out.push(JSON.parse(lines[i])); } catch {}
    }
    return out;
  } catch (e) {
    console.error('[reflect-history] read failed:', e.message);
    return [];
  }
}

/** 把 reflect 结果规整为历史记录条目 */
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
    /* 增量批次:本轮有多少是新增、多少被账本跳过、附了多少上下文;以及真实用量与成本 */
    coverage: out.coverage,
    usage: out.usage,
    skipReason: out.skipReason,
    warnings: out.warnings,
    errors: out.errors || [],
    insightTexts: list.map(i => (typeof i.text === 'string' ? i.text : '')),
    sources: list.map(i => (Array.isArray(i.sources) ? i.sources : [])),
  };
}

function openDb(readonly = false) {
  if (!existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, readonly ? { readonly: true } : {});
  try { db.pragma('busy_timeout = 5000'); } catch {}
  try { sqliteVec.load(db); } catch (e) { console.error('sqlite-vec load failed:', e.message); }
  return db;
}

// ═══ 嵌入配置 ═══
/**
 * 只读原始 config.json(不注入任何默认值)。
 *
 * 2026-10-27 修复(E2):必须区分"文件里真的写了什么"与"生效值(含默认值/环境变量)"。
 * 旧实现只有后者,GET 把默认 dim=1024 物化进返回体,UI 原样回传后就被 POST 写成
 * 显式配置,进而让引擎把 4096 维库静默降维清库。
 */
function rawConfig() {
  return rawConfigInDir(dirname(CONFIG_PATH));
}

function rawConfigInDir(dir) {
  const p = join(dir, 'config.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf-8').replace(/^\uFEFF+/, '')); } catch { return {}; }
}

/** 实际生效的向量维度:显式 env 优先 → 该目录 config.json 的 embedding.dim → 内置默认 1024(与引擎 db.ts 口径一致) */
function effectiveVecDimInDir(dir) {
  const envRaw = (process.env.EMBEDDING_DIM || process.env.VEC_DIM || '').trim();
  const fileRaw = rawConfigInDir(dir)?.embedding?.dim;
  for (const raw of [envRaw, fileRaw]) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0 && n <= 65536) return n;
  }
  return 1024;
}

/** 当前实例(CONFIG_PATH 所在目录)的生效维度 */
function effectiveVecDim() {
  return effectiveVecDimInDir(dirname(CONFIG_PATH));
}

/**
 * 从"归一化后的配置"里删掉 `embedding.dim`(2026-10-27 修复 E2)。
 *
 * 归一化会注入生效维度(env 优先),UI 原样回传;若照单全收就会把默认值/环境派生值
 * 写成显式配置,随后引擎据此 DROP vec 表并清空 embedding_cache。
 * `onlyIfEffective=true` 用于"用户提交的 payload":只有取值恰好等于当前生效值
 * (说明用户没改过这个输入框)才删;用户真改了维度时保留。
 */
function withoutImplicitDim(cfg, rawCfg, onlyIfEffective, effDim = effectiveVecDim(), formDims = null) {
  const e = cfg?.embedding;
  if (!e || e.dim == null) return cfg;
  const explicit = !!(rawCfg?.embedding && Object.prototype.hasOwnProperty.call(rawCfg.embedding, 'dim'));
  if (explicit) return cfg;
  if (onlyIfEffective) {
    // 2026-10-27 修复(P1-1,复核提出):联邦 applyTo=all 时,payload 里的 dim 可能来自
    // **任意一个**同级实例的 GET 回显。若只跟"该实例自己的维度"比,A=4096、B 无 dim 的
    // 组合会把 4096 判成"用户改过"并写进 B,导致 B 下次开库 DROP + 清缓存。
    // 所以凡属于"当前生效维度集合"的值都视为回显,只有集合外的值才算用户真的改了。
    const n = Number(e.dim);
    const fromForm = formDims ? formDims.has(n) : n === effDim;
    if (!fromForm) return cfg;
  }
  const copy = { ...cfg, embedding: { ...e } };
  delete copy.embedding.dim;
  return copy;
}

function normalizeConfig(cfg = {}, dim = effectiveVecDim()) {
  return {
    ...cfg,
    embedding: {
      mode: 'ollama',
      ollama_url: 'http://127.0.0.1:11436',
      model: 'yuan-embedding-2.0-zh',
      api_url: '', api_key: '', api_model: '',
      ...(cfg.embedding || {}),
      // 生效维度(env 优先):不要把默认值当成"已配置值"暴露出去
      dim,
    },
    reflect: {
      llm_url: 'https://api.deepseek.com/v1', api_key: '', model: 'deepseek-chat',
      factExtraction: 'auto', maxFacts: 15,
      minGapHours: 24, minUnanalyzed: 5, intervalHours: 0,
      ...(cfg.reflect || {}),
    },
    triage: {
      llm_url: 'https://api.deepseek.com/v1', api_key: '', model: 'deepseek-chat',
      bufferSize: 5, bufferTokens: 4000, sessionTtlDays: 7,
      ...(cfg.triage || {}),
    },
    consolidate: {
      minMemories: 15, similarity: 0.88, autoOnStart: true,
      ...(cfg.consolidate || {}),
    },
  };
}

function loadConfig() {
  let cfg = {};
  if (existsSync(CONFIG_PATH)) {
    try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
  }
  return normalizeConfig(cfg);
}

function saveConfig(cfg) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

/**
 * v1.25: 建 vec0 表用的维度 —— 取自 bank config.json 的 embedding.dim(env EMBEDDING_DIM 可覆盖),
 * 非法/未配置回退 1024。与引擎侧 db.ts 的 vecDim() 取值口径一致,避免 web 建库把维度写死。
 */
function configuredVecDim() {
  return effectiveVecDim();
}

function loadConfigFromDir(dir) {
  const p = join(dir, 'config.json');
  let cfg = {};
  let exists = false;
  if (existsSync(p)) {
    exists = true;
    try { cfg = JSON.parse(readFileSync(p, 'utf-8')); } catch {}
  }
  // 每个实例按自己的 config.json 解析生效维度,不要串用本地实例的
  return { path: p, exists, config: normalizeConfig(cfg, effectiveVecDimInDir(dir)) };
}

function saveConfigToDir(dir, cfg) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf-8');
}

function loadAllInstanceConfigs() {
  libFiles();
  return AGGREGATE_DIRS.map((c) => ({
    name: c.name,
    dir: c.dir,
    ...loadConfigFromDir(c.dir),
  }));
}

function mergePreserveKeys(cur, incoming) {
  const next = {
    ...cur,
    embedding: { ...(cur.embedding || {}), ...(incoming.embedding || {}) },
    reflect: { ...(cur.reflect || {}), ...(incoming.reflect || {}) },
    triage: { ...(cur.triage || {}), ...(incoming.triage || {}) },
    consolidate: { ...(cur.consolidate || {}), ...(incoming.consolidate || {}) },
  };
  const keep = (obj, old, field) => {
    if (!obj) return;
    if (obj[field] === '****' || obj[field] === '' || obj[field] == null) obj[field] = old?.[field] || '';
  };
  keep(next.embedding, cur.embedding, 'api_key');
  keep(next.reflect, cur.reflect, 'api_key');
  keep(next.triage, cur.triage, 'api_key');
  return next;
}

// ═══ MCP client:调用 dist/index.js 的反思工具 ═══
function mcpCall(toolName, args = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [MCP_SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        CASTALIA_BACKGROUND_TASKS: '0',
        MEMORY_DB_DIR: DB_DIR,
        ...(LEGACY_DB_PATH ? { MEMORY_DB_PATH: LEGACY_DB_PATH } : {}),
        MEMORY_CONFIG: CONFIG_PATH,
        MCP_TOOLS: process.env.MCP_TOOLS || 'all',
        CASTALIA_KEYS_FILE: join(DB_DIR, 'keys.enc'),
        CASTALIA_KEY_FILE: join(DB_DIR, 'keys.key'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const logPath = join(DB_DIR, 'mcp_call_stderr.log');
    child.stderr.on('data', (d) => { try { appendFileSync(logPath, `[${toolName}] ${d.toString()}`); } catch {} });
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

// ═══ 记忆总成(聚合本机多实例库) ═══
function sameDbDir(a, b) {
  return resolve(String(a)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === resolve(String(b)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
function getAggregateDirs() {
  const parse = (raw) => {
    if (!raw) return null;
    try {
      const d = JSON.parse(raw);
      if (Array.isArray(d) && d.length) {
        return d.filter(x => x && typeof x === 'object').filter(x => (x.transport || (/^https?:\/\//i.test(x.target || x.url || '') ? 'mcp-http' : 'local-dir')) === 'local-dir').map(x => ({ name: String(x.label || x.name || x.id || 'member'), dir: String(x.target || x.dir || '') })).filter(x => x.dir);
      }
    } catch {}
    return null;
  };
  const cands = parse(process.env.FEDERATION_MEMBERS) || parse(process.env.FEDERATION_DIRS) || parse(process.env.AGGREGATE_DIRS) || [
    /* 公开仓不带本机路径:默认只挂本实例自己的库;多成员联邦请用 FEDERATION_DIRS 环境变量配置 */
    { name: 'local', dir: DB_DIR },
  ];
  const norm = (d) => String(d || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  if (DB_DIR && !cands.some(c => norm(c.dir) === norm(DB_DIR))) cands.push({ name: '当前实例', dir: DB_DIR });
  try { for (const m of readRegistry(DB_DIR)) if (m && m.enabled !== false && m.dir) cands.push({ name: String(m.name || m.id || 'member'), dir: String(m.dir) }); } catch { /* 坏注册文件不影响既有环境成员 */ }
  const seen = new Set();
  return cands.filter(c => {
    if (!c.dir || !existsSync(c.dir)) return false;
    const k = norm(c.dir);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
let AGGREGATE_DIRS = getAggregateDirs();

function openLibDb(file, readonly = true) {
  if (!existsSync(file)) return null;
  const db = new Database(file, readonly ? { readonly: true } : {});
  try { db.pragma('busy_timeout = 5000'); } catch {}
  try { sqliteVec.load(db); } catch (e) { console.error('sqlite-vec load failed:', e.message); }
  return db;
}

function libFiles() {
  AGGREGATE_DIRS = getAggregateDirs();
  const out = [];
  let registered = [];
  try { registered = readRegistry(DB_DIR).filter(m => m.enabled !== false); } catch { /* 注册错误由 members API 报告 */ }
  for (const c of AGGREGATE_DIRS) {
    if (registered.some(m => m.name === c.name && sameDbDir(m.dir, c.dir))) {
      try { for (const item of scanMember(c.dir).files) out.push({ ...item, instance: c.name }); } catch {}
      continue;
    }
    try {
      for (const f of readdirSync(c.dir)) {
        if (f.startsWith('project-') && f.endsWith('.sqlite')) {
          out.push({ instance: c.name, project: f.slice('project-'.length, -'.sqlite'.length), file: join(c.dir, f) });
          continue;
        }
        const p = join(c.dir, f);
        try {
          if (statSync(p).isDirectory()) {
            for (const sub of readdirSync(p)) {
              const sp = join(p, sub);
              try {
                if (statSync(sp).isDirectory()) {
                  const mp = join(sp, 'memory.sqlite');
                  if (existsSync(mp)) out.push({ instance: c.name, project: f, memType: sub, file: mp });
                } else if (sub.endsWith('.sqlite')) {
                  out.push({ instance: c.name, project: f, file: sp });
                }
              } catch {}
            }
          }
        } catch {}
      }
    } catch {}
  }
  return out;
}

function libFileByProject(project, memType) {
  const lib = libFiles().find(l => l.project === project && (!memType || l.memType === memType));
  return lib || null;
}

function openDbByProject(project, readonly = false, id = null, instance = null, memType = null) {
  if (!project) return openDb(readonly);
  const candidates = libFiles().filter(l => l.project === project && (!instance || l.instance === instance) && (!memType || (l.memType || 'general') === memType));
  if (!candidates.length) return null;
  let lib = null;
  if (id) {
    const hits = [];
    for (const cand of candidates) {
      let probe = null;
      try {
        probe = openLibDb(cand.file, true);
        if (probe && probe.prepare('SELECT id FROM memory WHERE id = ?').get(id)) hits.push(cand);
      } finally { if (probe) probe.close(); }
    }
    if (hits.length !== 1) return null; // 不存在或身份歧义时拒绝写入，不能回退到任意库。
    lib = hits[0];
  }
  lib = lib || candidates.find(l => l.memType === 'general') || candidates[0];
  if (!lib || !existsSync(lib.file)) return null;
  const db = new Database(lib.file, readonly ? { readonly: true } : {});
  try { sqliteVec.load(db); } catch (e) { console.error('sqlite-vec load failed:', e.message); }
  return db;
}

function currentInstanceLibs() {
  const libs = libFiles();
  const self = AGGREGATE_DIRS.find(c => sameDbDir(c.dir, DB_DIR));
  return self ? libs.filter(l => l.instance === self.name) : [];
}

function dbDirHasData(dir) {
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (!statSync(p).isDirectory()) {
        if (f === 'global.sqlite' || (f.startsWith('project-') && f.endsWith('.sqlite'))) return true;
        continue;
      }
      for (const sub of readdirSync(p)) {
        const sp = join(p, sub);
        try {
          if (statSync(sp).isDirectory() && existsSync(join(sp, 'memory.sqlite'))) return true;
        } catch {}
      }
    }
  } catch {}
  return false;
}

function safeFilePart(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';
}

function libFilePath(project, memType) {
  return join(DB_DIR, safeFilePart(project), safeFilePart(memType || 'general'), 'memory.sqlite');
}

function findLib(instance, project) {
  const libs = libFiles();
  if (instance && project) {
    const exact = libs.find(l => l.instance === instance && l.project === project);
    if (exact) return exact;
  }
  if (project) return libs.find(l => l.project === project) || null;
  return null;
}

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
  try { db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[' + configuredVecDim() + '])'); } catch (e) { console.error('vec_memory create failed:', e.message); }
  try { db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(embedding float[' + configuredVecDim() + '])'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project, is_active)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_memory_mem_type ON memory(mem_type, is_active)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_memory_tier ON memory(tier, is_active)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project, is_active)'); } catch {}
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_spo ON facts(subject, predicate, object, project)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject, is_active)'); } catch {}
}

export {
  ROOT, DB_DIR, DB_PATH, CONFIG_PATH, NODE_BIN, MCP_SERVER, LEGACY_DB_PATH, PORT,
  loadConfig, saveConfig, rawConfig, rawConfigInDir, effectiveVecDim, effectiveVecDimInDir, withoutImplicitDim,
  loadAllInstanceConfigs, saveConfigToDir, mergePreserveKeys,
  openDb, openLibDb, openDbByProject,
  AGGREGATE_DIRS, getAggregateDirs, sameDbDir, libFiles, libFileByProject, currentInstanceLibs, findLib,
  resolveSourceFile, ensureLibSchema, safeFilePart, libFilePath, dbDirHasData,
  mcpCall, appendReflectHistory, readReflectHistory, historyEntry,
};
