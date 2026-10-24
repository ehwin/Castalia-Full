// 清理历史跨库外键残留：facts.source_memory_id 指向不存在的记忆 → 置 NULL（事实本身保留）
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/AI/castalia/memory-banks';
const apply = process.argv.includes('--apply');
let total = 0;
for (const bank of fs.readdirSync(ROOT)) {
  const bankDir = path.join(ROOT, bank);
  if (!fs.statSync(bankDir).isDirectory()) continue;
  for (const proj of fs.readdirSync(bankDir)) {
    const projDir = path.join(bankDir, proj);
    if (!fs.statSync(projDir).isDirectory()) continue;
    const file = path.join(projDir, 'general', 'memory.sqlite');
    if (!fs.existsSync(file)) continue;
    const db = new Database(file);
    try {
      db.pragma('busy_timeout = 5000');
      const n = db.prepare(`SELECT COUNT(*) c FROM facts f
        WHERE f.source_memory_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM memory m WHERE m.id = f.source_memory_id)`).get().c;
      if (n > 0) {
        if (apply) db.prepare(`UPDATE facts SET source_memory_id = NULL
          WHERE source_memory_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM memory m WHERE m.id = facts.source_memory_id)`).run();
        console.log(`${bank}/${proj}: ${n} orphan fact source(s)${apply ? ' → NULL' : ''}`);
        total += n;
      }
    } finally { db.close(); }
  }
}
console.log(JSON.stringify({ apply, orphans: total }));
