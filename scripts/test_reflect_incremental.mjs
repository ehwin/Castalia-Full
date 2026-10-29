/**
 * 增量反思(已反思账本)回归 — 不需要 LLM
 *
 * 事故背景:reflect_all 每次把整库活跃记忆重扫一遍(2,395 条 = 200 批 LLM / ¥5.06 一轮),
 * 而其中 99% 的行上一轮已经反思过、一个字没变。修法:账本 key = instance|project|id|sha1(text),
 * 只处理未覆盖的记录,并给每个库附带少量已反思的近期记录当上下文(保住新旧冲突判断)。
 *
 * 钉住的规则:
 *   R1 首轮(无账本)= 全量,变成增量后 fresh=0 → runReflectAll 直接 skipReason='no-new'(0 次 LLM)
 *   R2 已覆盖的记录被跳过;新记录照跑
 *   R3 记忆文本被 update 后哈希变化 → 自动重新进入下一轮(不会永久漏掉更新)
 *   R4 all=true 逃生门忽略账本,恢复全量
 *   R5 上下文行只附给「本库有新增」的库,并标记 context:true(不计入本轮覆盖)
 *
 * 用法:CastaliaNode.exe scripts/test_reflect_incremental.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-rcov-'));
const BANK = path.join(TMP, 'bank');
process.env.MEMORY_DB_DIR = BANK;
process.env.CASTALIA_INSTANCE_ID = 'test';
process.env.EMBED_MODE = 'none';
delete process.env.FEDERATION_DIRS;
delete process.env.FEDERATION_MEMBERS;
delete process.env.MEMORY_CONFIG;
process.env.REFLECT_LEDGER_FILE = path.join(BANK, 'reflect-ledger.sqlite');

const { collectReflectRecords, runReflectAll } = await import('../dist/reflectAll.js');
const { initProjectSchema } = await import('../dist/db.js');
const sqliteVec = await import('sqlite-vec');

const PROJECTS = ['alpha', 'beta'];
const PER_LIB = 5;
function makeBank() {
  for (const p of PROJECTS) {
    const dir = path.join(BANK, p, 'general');
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'memory.sqlite'));
    sqliteVec.load(db);
    initProjectSchema(db);
    for (let i = 1; i <= PER_LIB; i++) {
      const t = `2026-10-29 10:0${i}  ${p} 第 ${i} 条记忆:端口 33${10 + i},结论已核验`;
      db.prepare(`INSERT OR REPLACE INTO memory (id, text, project, type, mem_type, category, tags, importance, source, subject, tier, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count, metadata)
        VALUES (?, ?, ?, 'semantic', 'general', 'general', '[]', 0.6, 'test', 'user', 'standard', 1, ?, ?, ?, 0, 0, '{}')`)
        .run(`${p}-m${i}`, t, p, `2026-10-29T02:0${i}:00.000Z`, `2026-10-29T02:0${i}:00.000Z`, `2026-10-29T02:0${i}:00.000Z`);
    }
    db.close();
  }
}
makeBank();

const COLLECT = { maxTotal: Number.MAX_SAFE_INTEGER, maxPerLib: Number.MAX_SAFE_INTEGER, all: false, contextPerProject: 3 };
const key = (project, id, text) => `test|${project}|${id}|${crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)}`;
const textOf = (project, i) => `2026-10-29 10:0${i}  ${project} 第 ${i} 条记忆:端口 33${10 + i},结论已核验`;

function markCovered(entries) {
  const db = new Database(process.env.REFLECT_LEDGER_FILE);
  db.exec(`CREATE TABLE IF NOT EXISTS covered (key TEXT PRIMARY KEY, instance TEXT NOT NULL, project TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, covered_at TEXT NOT NULL)`);
  const stmt = db.prepare('INSERT OR REPLACE INTO covered (key, instance, project, id, hash, covered_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [project, id, text] of entries) {
    const k = key(project, id, text);
    stmt.run(k, 'test', project, id, k.split('|')[3], new Date().toISOString());
  }
  db.close();
}

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + String(extra).slice(0, 260) : ''}`); }
};

console.log('R1 首轮(无账本)= 全量');
{
  const c = collectReflectRecords(COLLECT);
  check('10 条全是新增', c.fresh === 10 && c.records.length === 10, `fresh=${c.fresh} records=${c.records.length}`);
  check('没有已覆盖', c.covered === 0, `covered=${c.covered}`);
  check('首轮不附上下文(没有已覆盖的行)', c.context.length === 0, `context=${c.context.length}`);
}

console.log('R2 已覆盖 6 条 → 只选中 4 条新增 + 上下文');
markCovered([
  ['alpha', 'alpha-m1', textOf('alpha', 1)], ['alpha', 'alpha-m2', textOf('alpha', 2)], ['alpha', 'alpha-m3', textOf('alpha', 3)],
  ['beta', 'beta-m1', textOf('beta', 1)], ['beta', 'beta-m2', textOf('beta', 2)], ['beta', 'beta-m3', textOf('beta', 3)],
]);
{
  const c = collectReflectRecords(COLLECT);
  check('剩余 4 条新增', c.fresh === 4 && c.records.length === 4, `fresh=${c.fresh} records=${c.records.length}`);
  check('跳过 6 条已覆盖', c.covered === 6, `covered=${c.covered}`);
  check('上下文有上限:min(24, 各库3条, ≥新增条数)', c.context.length === Math.min(6, Math.max(4, c.records.length)), `context=${c.context.length} records=${c.records.length}`);
  check('上下文行都带 context:true', c.context.every(r => r.context === true));
  check('新增行不带 context 标记', c.records.every(r => !r.context));
}

console.log('R3 记忆文本被 update → 哈希变化,重新进入下一轮');
{
  const db = new Database(path.join(BANK, 'alpha', 'general', 'memory.sqlite'));
  db.prepare('UPDATE memory SET text = ? WHERE id = ?').run('2026-10-29 11:00  alpha 第 1 条记忆已更新:端口改为 3399', 'alpha-m1');
  db.close();
  const c = collectReflectRecords(COLLECT);
  check('被更新的那条回到新增集合(fresh 4→5)', c.fresh === 5, `fresh=${c.fresh}`);
  check('新增集合里包含 alpha-m1', c.records.some(r => r.id === 'alpha-m1'));
}

console.log('R4 all=true 逃生门 = 忽略账本,全量');
{
  const c = collectReflectRecords({ ...COLLECT, all: true });
  check('10 条全量', c.fresh === 10 && c.records.length === 10, `fresh=${c.fresh} records=${c.records.length}`);
  check('全量模式不读账本(covered=0)', c.covered === 0, `covered=${c.covered}`);
  check('incremental=false', c.incremental === false);
}

console.log('R5 全部覆盖 → runReflectAll 直接跳过,不调 LLM');
{
  const all = [];
  for (const p of PROJECTS) for (let i = 1; i <= PER_LIB; i++) all.push([p, `${p}-m${i}`, textOf(p, i)]);
  all[0] = ['alpha', 'alpha-m1', '2026-10-29 11:00  alpha 第 1 条记忆已更新:端口改为 3399'];
  markCovered(all);
  const c = collectReflectRecords(COLLECT);
  check('没有新增', c.fresh === 0 && c.records.length === 0, `fresh=${c.fresh}`);
  // 这里没有配 REFLECT LLM key:能走到 skipReason 说明在调 LLM 之前就返回了
  const r = await runReflectAll({ dryRun: true });
  check('skipReason=no-new', r.skipReason === 'no-new', JSON.stringify({ skipReason: r.skipReason, errors: r.errors }));
  check('没有产生任何用量', !r.usage || r.usage.calls === 0, JSON.stringify(r.usage));
  check('coverage 报告 fresh=0/covered=10', r.coverage?.fresh === 0 && r.coverage?.covered === 10, JSON.stringify(r.coverage));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
