/**
 * v1.23.1 全库升级：给所有记忆库（含未运行实例）补齐 v1.23 列与索引。
 *
 * 设计：直接 DDL，不依赖引擎模块（避免 MEMORY_DB_DIR 进程级绑定）；幂等；只加可空列。
 *   memory: parent_id / status / identity_locked + idx_memory_parent
 *   facts : valid_from / valid_to / evidence
 *
 * 用法（在 Castalia-Full 目录下）：
 *   node scripts/upgrade_banks.mjs            # 只报告
 *   node scripts/upgrade_banks.mjs --apply    # 执行
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = process.env.CASTALIA_BANKS || 'D:/AI/castalia/memory-banks';
const APPLY = process.argv.includes('--apply');
const MEM_TYPES = ['general', 'user', 'feedback', 'project', 'reference'];

const WANT = {
  memory: [['parent_id', 'TEXT'], ['status', 'TEXT'], ['identity_locked', 'INTEGER DEFAULT 0']],
  facts: [['valid_from', 'DATETIME'], ['valid_to', 'DATETIME'], ['evidence', 'TEXT']],
};

const report = { apply: APPLY, banks: [], changes: [], configs: [], warnings: [] };

function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
}
function columnNames(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)); } catch { return new Set(); }
}

function upgradeDb(dbPath, bank, project, memType) {
  const entry = { bank, project, memType, file: dbPath.replace(ROOT + '/', ''), added: [], skipped: [] };
  let db;
  try {
    db = new Database(dbPath, { fileMustExist: true });
  } catch (e) {
    entry.error = e.message;
    report.changes.push(entry);
    return;
  }
  try {
    db.pragma('busy_timeout = 5000');
    const tables = tableNames(db);
    for (const [table, cols] of Object.entries(WANT)) {
      if (!tables.has(table)) { entry.skipped.push(`${table}: table missing`); continue; }
      const existing = columnNames(db, table);
      for (const [col, type] of cols) {
        if (existing.has(col)) continue;
        if (APPLY) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
        entry.added.push(`${table}.${col}`);
      }
    }
    if (tables.has('memory') && columnNames(db, 'memory').has('parent_id')) {
      const hasIdx = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_memory_parent'").get();
      if (!hasIdx) {
        if (APPLY) db.exec('CREATE INDEX IF NOT EXISTS idx_memory_parent ON memory(parent_id)');
        entry.added.push('idx_memory_parent');
      }
    }
    if (!entry.added.length) entry.added = [];
  } catch (e) {
    entry.error = e.message;
  } finally {
    try { db.close(); } catch { /* */ }
  }
  report.changes.push(entry);
}

function discoverProjectDirs(bankDir) {
  const out = [];
  for (const name of fs.readdirSync(bankDir)) {
    const dir = path.join(bankDir, name);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    if (name.startsWith('.')) continue;
    const hasMem = MEM_TYPES.some(mt => fs.existsSync(path.join(dir, mt, 'memory.sqlite')));
    if (hasMem) out.push({ project: name, dir });
  }
  return out;
}

for (const bank of fs.readdirSync(ROOT)) {
  const bankDir = path.join(ROOT, bank);
  try { if (!fs.statSync(bankDir).isDirectory()) continue; } catch { continue; }
  const cfgPath = path.join(bankDir, 'config.json');
  const cfg = fs.existsSync(cfgPath) ? (() => { try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { return null; } })() : null;
  report.banks.push({ bank, hasConfig: !!cfg, hasKeys: fs.existsSync(path.join(bankDir, 'keys.enc')) });
  if (cfg) {
    const model = cfg?.reflect?.model || null;
    report.configs.push({ bank, reflectModel: model, preservation: cfg?.reflect?.preservation || null, maxTokens: cfg?.reflect?.maxTokens || null });
    if (model && !/flash/i.test(model)) report.warnings.push(`${bank}: reflect 模型不是 flash (${model})`);
    if (!cfg?.reflect?.maxTokens) report.warnings.push(`${bank}: reflect.maxTokens 未设置`);
  } else {
    report.warnings.push(`${bank}: 缺少 config.json`);
  }

  const projects = discoverProjectDirs(bankDir);
  // 兼容旧的 project-<name>.sqlite 单库结构
  for (const f of fs.readdirSync(bankDir)) {
    if (f.startsWith('project-') && f.endsWith('.sqlite')) {
      projects.push({ project: f.slice('project-'.length, -'.sqlite'.length), dir: bankDir, legacyFile: path.join(bankDir, f) });
    }
  }
  for (const p of projects) {
    if (p.legacyFile) { upgradeDb(p.legacyFile, bank, p.project, 'legacy'); continue; }
    for (const mt of MEM_TYPES) {
      const dbPath = path.join(p.dir, mt, 'memory.sqlite');
      if (fs.existsSync(dbPath)) upgradeDb(dbPath, bank, p.project, mt);
    }
  }
}

const pending = report.changes.filter(c => (c.added && c.added.length) || c.error);
report.summary = {
  banks: report.banks.length,
  projects: new Set(report.changes.map(c => `${c.bank}/${c.project}`)).size,
  dbs: report.changes.length,
  needsChange: pending.length,
  columnsToAdd: pending.reduce((n, c) => n + (c.added || []).filter(a => !a.startsWith('idx_')).length, 0),
  errors: pending.filter(c => c.error).length,
};
console.log(JSON.stringify(report, null, 1));
