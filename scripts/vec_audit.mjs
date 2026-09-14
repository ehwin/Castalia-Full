#!/usr/bin/env node
/** _vec_audit.mjs — 独立复验:各库各表的 (活跃记忆 vs 向量) / (活跃事实 vs 事实向量) */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire('/path/to/castalia/run/Castalia/package.json');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const BANKS = '/path/to/castalia/memory-banks';
function dbs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !['node_modules', 'receipts'].includes(e.name)) dbs(p, acc);
    else if (e.isFile() && e.name.endsWith('.sqlite')) acc.push(p);
  }
  return acc;
}
let bad = 0;
console.log('库/文件'.padEnd(46) + '活跃记忆  向量   活跃事实  事实向量');
for (const bank of ['hermes', 'lobehub', 'airi']) {
  const root = path.join(BANKS, bank);
  for (const f of dbs(root)) {
    const rel = path.join(bank, path.relative(root, f));
    let db;
    try { db = new Database(f); try { sqliteVec.load(db); } catch {} } catch { continue; }
    const g = (sql, d = 0) => { try { return db.prepare(sql).get().c; } catch { return d; } };
    const am = g('SELECT COUNT(*) c FROM memory WHERE is_active=1');
    const vm = g('SELECT COUNT(*) c FROM vec_memory');
    const af = g('SELECT COUNT(*) c FROM facts WHERE is_active=1');
    const vf = g('SELECT COUNT(*) c FROM vec_facts');
    db.close();
    if (!am && !vm && !af && !vf) continue;
    const okM = am === vm, okF = af === vf;
    if (!okM) bad += Math.abs(am - vm);
    console.log(rel.padEnd(46) + String(am).padStart(6) + String(vm).padStart(7) + String(af).padStart(9) + String(vf).padStart(9) + (okM && okF ? '  ✓' : '  ✗'));
  }
}
console.log(bad ? `\n⚠ 记忆向量缺口 ${bad} 条` : '\n✓ 记忆与向量全库对齐');
process.exit(0);
