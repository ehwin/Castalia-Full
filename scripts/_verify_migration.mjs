// v1.23.2 部署后数据验证：迁移列/触发器/索引/活跃数/衰减基线
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/AI/castalia/memory-banks';
const MEM_TYPES = ['general', 'user', 'feedback', 'project', 'reference'];
const report = [];

for (const bank of fs.readdirSync(ROOT)) {
  const bankDir = path.join(ROOT, bank);
  if (!fs.statSync(bankDir).isDirectory()) continue;
  for (const proj of fs.readdirSync(bankDir)) {
    const projDir = path.join(bankDir, proj);
    if (!fs.statSync(projDir).isDirectory()) continue;
    for (const mt of MEM_TYPES) {
      const file = path.join(projDir, mt, 'memory.sqlite');
      if (!fs.existsSync(file)) continue;
      const db = new Database(file, { readonly: true });
      try {
        const cols = new Set(db.prepare('PRAGMA table_info(memory)').all().map(c => c.name));
        const trg = db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_memory_base_importance'").get();
        const active = db.prepare('SELECT COUNT(*) c FROM memory WHERE is_active=1').get().c;
        const baseNull = cols.has('base_importance')
          ? db.prepare('SELECT COUNT(*) c FROM memory WHERE base_importance IS NULL').get().c : -1;
        const failed = cols.has('embed_fail_count')
          ? db.prepare('SELECT COUNT(*) c FROM memory WHERE COALESCE(embed_fail_count,0) > 0').get().c : -1;
        const factsIdx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_facts_spo'").get();
        const factDup = (() => { try { return db.prepare('SELECT COUNT(*) c FROM (SELECT subject,predicate,object,project FROM facts GROUP BY 1,2,3,4 HAVING COUNT(*)>1)').get().c; } catch { return -1; } })();
        report.push({ bank, proj, mt, active, baseNull, failed, trigger: !!trg, factsUnique: !!factsIdx, factDup });
      } finally { db.close(); }
    }
  }
}
const anomalies = report.filter(r => r.baseNull < 0 || r.baseNull > r.active || !r.trigger);
console.log(JSON.stringify({ dbs: report.length, anomalies, totalActive: report.reduce((n, r) => n + r.active, 0), sample: report.slice(0, 3) }, null, 1));
