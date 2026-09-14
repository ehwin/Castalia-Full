#!/usr/bin/env node
/**
 * reembed_all.mjs — 全库重嵌(统一嵌入模型后重建向量空间)
 *
 * 为什么需要:向量没有模型溯源字段 —— 换嵌入模型后,旧向量与新查询不在同一空间,
 * 检索会"看着能搜、结果发飘"。所以换模型 = **清掉旧向量,用新模型全量重建**。
 *
 * 用法: <node137> reembed_all.mjs <库名> <char> [--dry-run]
 *   例:  reembed_all.mjs hermes hermes
 *        reembed_all.mjs lobehub lobehub     (库内还有 custom-project/reflect 分区,一并重嵌)
 *        reembed_all.mjs airi airi
 *
 * 步骤:①扫库下所有 sqlite,清空 vec_memory / vec_facts
 *      ②循环 batchEmbedPending(char) 直到 embedded=0(每次上限 200 条)
 *      ③复验:活跃记忆数 vs 向量数、活跃事实数 vs 事实向量数
 */
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const BANKS = '/path/to/castalia/memory-banks';
const ENGINES = { hermes: '/path/to/castalia/run/Castalia', lobehub: '/path/to/castalia/run/LobeHub', airi: '/path/to/castalia/run/Castalia-Anima' };

const bank = process.argv[2];
const char = process.argv[3];
const dryRun = process.argv.includes('--dry-run');
const engine = ENGINES[bank];
if (!bank || !char || !engine) {
  console.error('用法: reembed_all.mjs <hermes|lobehub|airi> <char> [--dry-run]');
  process.exit(2);
}
const bankDir = path.join(BANKS, bank);
process.env.MEMORY_DB_DIR = bankDir;
process.env.CHAR_ID = char;
process.env.CASTALIA_PROJECT = char;
process.env.CASTALIA_KEYS_FILE = path.join(bankDir, 'keys.enc');
process.env.CASTALIA_KEY_FILE = path.join(bankDir, 'keys.key');
process.env.MEMORY_CONFIG = path.join(bankDir, 'config.json');
process.env.MCP_TOOLS = 'all';

/* 清向量:直接用 better-sqlite3 + sqlite-vec(引擎同一套依赖),不依赖引擎内部 API */
const require = createRequire(path.join(engine, 'package.json'));
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

function dbsIn(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !['node_modules', 'receipts'].includes(e.name)) out.push(...dbsIn(p));
    else if (e.isFile() && e.name.endsWith('.sqlite')) out.push(p);
  }
  return out;
}

console.log(`库 ${bank} · char=${char} · 引擎 ${engine}\n`);
let cleared = { vec_memory: 0, vec_facts: 0 };
const files = dbsIn(bankDir);
for (const f of files) {
  let db;
  try { db = new Database(f); try { sqliteVec.load(db); } catch {} } catch { continue; }
  const got = [];
  for (const t of ['vec_memory', 'vec_facts']) {
    try {
      const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
      if (n > 0) {
        if (!dryRun) db.prepare(`DELETE FROM ${t}`).run();
        cleared[t] += n; got.push(`${t}=${n}`);
      }
    } catch { /* 该库没有此表 */ }
  }
  db.close();
  if (got.length) console.log('  清向量 ' + path.relative(bankDir, f).padEnd(58) + ' ' + got.join(' '));
}
console.log(`\n共清空: vec_memory ${cleared.vec_memory} 行 · vec_facts ${cleared.vec_facts} 行${dryRun ? ' (DRY-RUN,未真删)' : ''}\n`);
if (dryRun) process.exit(0);

/* 驱动引擎自己的补嵌任务 */
await import(pathToFileURL(path.join(engine, 'dist', 'configLoader.js')).href);
const { batchEmbedPending } = require(path.join(engine, 'dist', 'store.js'));

/* batchEmbedPending 只扫"当前项目"(env 里的 CASTALIA_PROJECT)→ 必须**逐个项目分区**各跑一轮,
 * 否则 castalia/airi 这类新分区里的记忆永远补不上向量(实测 2 条漏嵌)。 */
/* 同一银行里不同分区的 character_id 可能不同(实测:lobehub 银行里 custom-project 分区的行是 char=custom-project)
 * → 逐分区探测实际 character_id,再按它补嵌,否则整分区漏嵌(0 条)。 */
function probeChar(proj) {
  const hits = {};
  for (const mt of ['user', 'feedback', 'project', 'reference', 'general']) {
    const f = path.join(bankDir, proj, mt, 'memory.sqlite');
    if (!fs.existsSync(f)) continue;
    let db; try { db = new Database(f, { readonly: true }); } catch { continue; }
    try { for (const r of db.prepare("SELECT COALESCE(character_id,'') c, COUNT(*) n FROM memory WHERE is_active=1 GROUP BY 1").all()) hits[r.c] = (hits[r.c] || 0) + r.n; } catch {}
    db.close();
  }
  const best = Object.entries(hits).sort((a, b) => b[1] - a[1])[0];
  return (best && best[0]) || char;
}
const projects = [char, ...fs.readdirSync(bankDir, { withFileTypes: true })
  .filter(e => e.isDirectory() && !['node_modules', 'receipts'].includes(e.name))
  .map(e => e.name)].filter((v, i, a) => a.indexOf(v) === i);
let totalM = 0, totalF = 0;
for (const proj of projects) {
  let round = 0, pm = 0, pf = 0;
  for (;;) {
    round++;
    const pc = probeChar(proj);
    const r = await batchEmbedPending(pc, proj);
    const m = (r && (r.embedded ?? r.embeddedMemories)) || 0;
    const fc = (r && (r.embeddedFacts ?? r.facts)) || 0;
    pm += m; pf += fc;
    if (m || fc) console.log(`  [${proj}] 第 ${round} 轮: 记忆 +${m} 事实 +${fc}`);
    if (!m && !fc) break;
    if (round > 40) { console.log('  轮次上限,停止'); break; }
  }
  if (pm || pf || true) console.log(`  [${proj}] (char=${probeChar(proj)}) 小计: 记忆 ${pm} · 事实 ${pf}`);
  totalM += pm; totalF += pf;
}
console.log(`\n=== ${bank}: 重嵌完成 记忆 ${totalM} · 事实 ${totalF} · ${round} 轮 ===`);

/* 复验:活跃数 vs 向量数 */
const check = {};
for (const f of dbsIn(bankDir)) {
  const rel = path.relative(bankDir, f);
  try {
    const db = new Database(f);
    try { sqliteVec.load(db); } catch {}
    const am = db.prepare('SELECT COUNT(*) c FROM memory WHERE is_active=1').get().c;
    const vm = db.prepare('SELECT COUNT(*) c FROM vec_memory').get().c;
    check[rel] = { active: am, vec: vm };
    db.close();
  } catch (e) { check[rel] = { active: -1, vec: -1, err: String(e.message).slice(0, 60) }; }
}
const tk = Object.keys(check);
console.log('\n复验(活跃记忆 / 向量):');
let miss = 0;
for (const k of tk) { const v = check[k]; if (v.active || v.vec) { const ok = v.active === v.vec; if (!ok) miss += Math.abs(v.active - v.vec); console.log('  ' + k.padEnd(58) + ' ' + String(v.active).padStart(4) + ' / ' + String(v.vec).padStart(4) + ' ' + (ok ? '✓' : '✗ 差 ' + (v.active - v.vec))); } }
console.log(miss ? `\n⚠ 合计差异 ${miss} 条(无向量/嵌入失败,见上方行)` : '\n✓ 全部对齐');
process.exit(0);
