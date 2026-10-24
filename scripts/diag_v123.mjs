/**
 * v1.23 数据体检（只读）：对单个记忆库检查昨天上线的几项改动在真实数据上的落地情况。
 *
 * 用法（在 Castalia-Full 目录下）：
 *   node scripts/diag_v123.mjs --bank D:/AI/castalia/memory-banks/dsh --project dsh [--json]
 *
 * 检查项：
 *   - parent_id：叶子是否真的指回原文、父是否还存在、跨库父是否可回捞
 *   - facts：SPO 是否合法（NOT NULL 事故复检）、evidence、valid_from/valid_to、跨库 FK
 *   - 冷存/接管：cold 与 superseded 的数量、是否仍会被检索命中（tag/text 路径）
 *   - 反思积压与游标
 * 只读打开数据库，不做任何写入。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const opt = (name, def = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const bankRoot = opt('bank');
const project = opt('project') || (bankRoot ? path.basename(bankRoot) : '');
const asJson = args.includes('--json');
if (!bankRoot) { console.error('need --bank'); process.exit(2); }

const MEM_TYPES = ['general', 'user', 'feedback', 'project', 'reference'];
const projectDir = fs.existsSync(path.join(bankRoot, project)) ? path.join(bankRoot, project) : bankRoot;

function tableExists(db, name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); } catch { return false; }
}
function cols(db, name) {
  try { return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name)); } catch { return new Set(); }
}
function count(db, sql, params = []) {
  try { return db.prepare(sql).get(...params)?.c ?? 0; } catch { return null; }
}

const dbs = {};
for (const mt of MEM_TYPES) {
  const p = path.join(projectDir, mt, 'memory.sqlite');
  if (!fs.existsSync(p)) continue;
  dbs[mt] = new Database(p, { readonly: true, fileMustExist: true });
}
const legacy = path.join(bankRoot, `project-${project}.sqlite`);
if (Object.keys(dbs).length === 0 && fs.existsSync(legacy)) dbs.general = new Database(legacy, { readonly: true });

const out = {
  bank: bankRoot, project, generatedAt: new Date().toISOString(),
  config: null, memtypes: {}, facts: {}, anomalies: [], notes: [],
};

// ---- config ----
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(bankRoot, 'config.json'), 'utf8'));
  out.config = {
    reflectModel: cfg?.reflect?.model ?? null,
    reflectMode: cfg?.reflect?.mode ?? null,
    preservation: cfg?.reflect?.preservation ?? null,
    maxTokens: cfg?.reflect?.maxTokens ?? null,
    factExtraction: cfg?.reflect?.factExtraction ?? null,
    embedMode: cfg?.embedding?.mode ?? null,
  };
  if (out.config.reflectModel && !/flash/.test(out.config.reflectModel)) {
    out.anomalies.push(`reflect 模型不是 flash：${out.config.reflectModel}`);
  }
} catch { out.notes.push('config.json 读取失败'); }

// ---- 每库 memory 统计 ----
const parentRefs = [];   // {mt, id, parent}
let activeMemory = 0;
for (const [mt, db] of Object.entries(dbs)) {
  const c = cols(db, 'memory');
  const has = (n) => c.has(n);
  const m = {
    memoryTotal: count(db, 'SELECT COUNT(*) c FROM memory'),
    active: count(db, 'SELECT COUNT(*) c FROM memory WHERE is_active=1'),
    cold: has('status') ? count(db, "SELECT COUNT(*) c FROM memory WHERE is_active=1 AND status='cold'") : 0,
    supersededActive: has('status') ? count(db, "SELECT COUNT(*) c FROM memory WHERE is_active=1 AND status='superseded'") : 0,
    invalidStatus: has('status') ? count(db, "SELECT COUNT(*) c FROM memory WHERE status IS NOT NULL AND status NOT IN ('cold','superseded')") : 0,
    critical: count(db, "SELECT COUNT(*) c FROM memory WHERE is_active=1 AND COALESCE(tier,'standard')='critical'"),
    extractedActive: count(db, "SELECT COUNT(*) c FROM memory WHERE is_active=1 AND source='reflect_extract'"),
    leavesWithParent: has('parent_id') ? count(db, 'SELECT COUNT(*) c FROM memory WHERE is_active=1 AND parent_id IS NOT NULL') : 0,
    parentIds: has('parent_id') ? count(db, 'SELECT COUNT(DISTINCT parent_id) c FROM memory WHERE parent_id IS NOT NULL') : 0,
  };
  activeMemory += m.active || 0;
  out.memtypes[mt] = m;
  if (has('parent_id')) {
    for (const r of db.prepare("SELECT id, parent_id FROM memory WHERE parent_id IS NOT NULL AND is_active=1").all()) {
      parentRefs.push({ mt, id: r.id, parent: r.parent_id });
    }
  }
}

// parent 是否还存在（本项目内任意分类库，含已停用）
const existsCache = new Map();
const parentExists = (pid) => {
  if (existsCache.has(pid)) return existsCache.get(pid);
  let found = dbs.general?.prepare('SELECT id, text FROM memory WHERE id=?').get(pid) || null;
  if (!found) {
    for (const [mt, db] of Object.entries(dbs)) {
      const row = db.prepare('SELECT id, text FROM memory WHERE id=?').get(pid);
      if (row) { found = { ...row, memType: mt }; break; }
    }
  }
  existsCache.set(pid, found);
  return found;
};

const parents = new Map();
for (const r of parentRefs) {
  const p = parents.get(r.parent) || { parent: r.parent, leaves: 0, memTypes: new Set(), exists: null, parentChars: 0, inDb: null };
  p.leaves++;
  p.memTypes.add(r.mt);
  const row = parentExists(r.parent);
  p.exists = !!row;
  p.parentChars = row?.text ? String(row.text).length : 0;
  p.inDb = row?.memType || (row ? 'general' : null);
  parents.set(r.parent, p);
}
out.parents = {
  parents: parents.size,
  leaves: parentRefs.length,
  missingParents: [...parents.values()].filter(p => !p.exists).length,
  crossMemType: [...parents.values()].filter(p => p.exists && p.memTypes.size && !p.memTypes.has(p.inDb)).length,
  sample: [...parents.values()].slice(0, 5).map(p => ({ parent: String(p.parent).slice(0, 8), leaves: p.leaves, exists: p.exists, parentChars: p.parentChars })),
};
if (out.parents.missingParents > 0) out.anomalies.push(`parent_id 指向的原文缺失 ${out.parents.missingParents} 条（回捞会静默跳过）`);

// ---- facts（general 库） ----
const gdb = dbs.general;
if (gdb && tableExists(gdb, 'facts')) {
  const fc = cols(gdb, 'facts');
  const f = {
    total: count(gdb, 'SELECT COUNT(*) c FROM facts'),
    active: count(gdb, 'SELECT COUNT(*) c FROM facts WHERE is_active=1'),
    nullSpo: count(gdb, "SELECT COUNT(*) c FROM facts WHERE subject IS NULL OR predicate IS NULL OR object IS NULL OR subject='' OR predicate='' OR object=''"),
    neverNullConstraint: null,
    withEvidence: fc.has('evidence') ? count(gdb, "SELECT COUNT(*) c FROM facts WHERE evidence IS NOT NULL AND evidence <> ''") : 0,
    withValidFrom: fc.has('valid_from') ? count(gdb, 'SELECT COUNT(*) c FROM facts WHERE valid_from IS NOT NULL') : 0,
    withValidTo: fc.has('valid_to') ? count(gdb, "SELECT COUNT(*) c FROM facts WHERE valid_to IS NOT NULL AND valid_to <> ''") : 0,
    conflictOpen: count(gdb, `SELECT COUNT(*) c FROM (SELECT subject, predicate FROM facts WHERE is_active=1 GROUP BY subject, predicate HAVING COUNT(DISTINCT object) > 1)`),
  };
  try {
    const bad = gdb.prepare(`SELECT COUNT(*) c FROM facts f WHERE f.source_memory_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memory m WHERE m.id=f.source_memory_id)`).get();
    f.fkOrphans = bad.c;
    if (bad.c > 0) out.anomalies.push(`facts.source_memory_id 指向不存在的记忆 ${bad.c} 条（跨库外键残留）`);
  } catch { f.fkOrphans = null; }
  out.facts = f;
  if (f.nullSpo > 0) out.anomalies.push(`facts 存在 NULL/空 SPO ${f.nullSpo} 条 —— NOT NULL 事故会复发`);
  // 功能性谓词是否真的做了失效（旧库没有 valid_to 列 → 跳过，不算异常，但要记一笔）
  const functional = ['姓名', '名字', '年龄', '职业', '居住地', '工作单位', '生日', '称呼', '昵称', 'name', 'age', 'job', 'occupation', 'residence', 'birthday'];
  if (!fc.has('valid_to')) {
    out.facts.openSameSlot = null;
    out.notes.push('facts 表缺 valid_to 列：该库未做 v1.23 迁移（版本分叉）');
  } else {
    const openSameSlot = gdb.prepare(
      `SELECT subject, predicate, COUNT(DISTINCT object) n FROM facts
       WHERE is_active=1 AND (valid_to IS NULL OR valid_to='') AND predicate IN (${functional.map(() => '?').join(',')})
       GROUP BY subject, predicate HAVING n > 1 LIMIT 10`
    ).all(...functional);
    out.facts.openSameSlot = openSameSlot;
    if (openSameSlot.length) out.notes.push(`功能性谓词仍有 ${openSameSlot.length} 组未失效（可能都属正常：新值尚未写入）`);
  }
} else {
  out.facts = { total: null };
}

// ---- superseded 是否仍可被检索（tag/text 路径未加过滤） ----
const supersededByType = [];
for (const [mt, db] of Object.entries(dbs)) {
  if (!cols(db, 'memory').has('status')) continue;
  const rows = db.prepare("SELECT id, source FROM memory WHERE is_active=1 AND status='superseded' LIMIT 200").all();
  for (const r of rows) supersededByType.push({ mt, id: r.id, source: r.source });
}
out.superseded = { total: supersededByType.length, bySource: supersededByType.reduce((a, r) => (a[r.source || '-'] = (a[r.source || '-'] || 0) + 1, a), {}) };

// ---- 精确同文重复（reflect_extract） ----
const dup = [];
for (const [mt, db] of Object.entries(dbs)) {
  try {
    const rows = db.prepare(`SELECT text, COUNT(*) n FROM memory WHERE is_active=1 AND source='reflect_extract' GROUP BY text HAVING n>1 LIMIT 20`).all();
    for (const r of rows) dup.push({ mt, n: r.n, head: String(r.text).slice(0, 40) });
  } catch { /* ignore */ }
}
out.duplicates = { groups: dup.length, sample: dup.slice(0, 5) };
if (dup.length) out.notes.push(`精确同文重复 ${dup.length} 组（可 consolidate_deep 合并）`);

// ---- 反思积压（v1.23-fix：来源是 memory 里 is_active=0 的 conversation_log，不是不存在的表） ----
const backlog = {};
for (const [mt, db] of Object.entries(dbs)) {
  try {
    const total = count(db, "SELECT COUNT(*) c FROM memory WHERE is_active=0 AND source='conversation_log' AND project=?", [project]);
    let pending = null;
    try {
      pending = count(db, `SELECT COUNT(*) c FROM memory m
        WHERE m.is_active=0 AND m.source='conversation_log' AND m.project=?
          AND NOT EXISTS (SELECT 1 FROM reflection_progress p WHERE p.project=? AND p.conversation_id=m.id)`,
        [project, project]);
    } catch {
      pending = total; // 没有 reflection_progress 表 = 全部未处理
    }
    if (pending === null) pending = total; // count() 内部吞掉 SQL 错误时按"全部未处理"报
    if (total) backlog[mt] = { total, pending };
  } catch { /* ignore */ }
}
out.backlog = backlog;

// ---- 汇总 ----
out.summary = {
  activeMemory,
  parents: out.parents.parents,
  factsActive: out.facts.active ?? null,
  cold: Object.values(out.memtypes).reduce((n, m) => n + (m.cold || 0), 0),
  superseded: out.superseded.total,
  duplicates: out.duplicates.groups,
  anomalies: out.anomalies.length,
};

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`# 体检 ${project} (${bankRoot})`);
  console.log('config:', JSON.stringify(out.config));
  console.log('summary:', JSON.stringify(out.summary));
  for (const [mt, m] of Object.entries(out.memtypes)) console.log(`  ${mt.padEnd(10)}`, JSON.stringify(m));
  console.log('parents:', JSON.stringify(out.parents));
  console.log('facts:', JSON.stringify(out.facts));
  console.log('superseded:', JSON.stringify(out.superseded));
  console.log('duplicates:', JSON.stringify(out.duplicates));
  console.log('backlog:', JSON.stringify(out.backlog));
  if (out.notes.length) console.log('notes:\n  - ' + out.notes.join('\n  - '));
  if (out.anomalies.length) console.log('ANOMALIES:\n  - ' + out.anomalies.join('\n  - '));
  else console.log('ANOMALIES: none');
}
for (const db of Object.values(dbs)) { try { db.close(); } catch { /* */ } }
