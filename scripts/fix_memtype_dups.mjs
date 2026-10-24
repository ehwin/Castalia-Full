// 清理"同一 id 同时活跃在多个 memType 库"的旧副本（v1.23.2 审计发现 AIRI 16 组）。
// 默认 dry-run；--apply 真正软删重复副本（保留 memType 顺序最靠前的那份，通常是 general）。
// 变更前用 VACUUM INTO 备份每个要改的库。
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/AI/castalia/memory-banks';
const MT = ['general', 'user', 'feedback', 'project', 'reference'];
const apply = process.argv.includes('--apply');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupRoot = path.join('D:/AI/castalia/_backups', `dedupe-${stamp}`);
let groups = 0, removed = 0;

for (const bank of fs.readdirSync(ROOT)) {
  const bankDir = path.join(ROOT, bank);
  if (!fs.statSync(bankDir).isDirectory() || bank.startsWith('_backup')) continue;
  for (const proj of fs.readdirSync(bankDir)) {
    const projDir = path.join(bankDir, proj);
    if (!fs.statSync(projDir).isDirectory()) continue;
    const dbs = {};
    for (const mt of MT) {
      const f = path.join(projDir, mt, 'memory.sqlite');
      if (fs.existsSync(f)) dbs[mt] = f;
    }
    const byId = new Map();
    for (const [mt, f] of Object.entries(dbs)) {
      const db = new Database(f, { readonly: true });
      try {
        for (const r of db.prepare('SELECT id, reference_count, importance, updated_at FROM memory WHERE is_active=1').all()) {
          if (!byId.has(r.id)) byId.set(r.id, []);
          byId.get(r.id).push({ mt, ...r });
        }
      } finally { db.close(); }
    }
    for (const [id, list] of byId) {
      if (list.length < 2) continue;
      groups++;
      list.sort((a, b) => MT.indexOf(a.mt) - MT.indexOf(b.mt));
      const keep = list[0];
      const drop = list.slice(1);
      console.log(`${bank}/${proj} id=${id.slice(0, 8)} keep=${keep.mt} drop=${drop.map(d => d.mt).join(',')}`);
      if (!apply) continue;
      // 备份涉及到的库（每个库只备一次）
      for (const mt of new Set([keep.mt, ...drop.map(d => d.mt)])) {
        const src = dbs[mt];
        const dst = path.join(backupRoot, bank, proj, mt, 'memory.sqlite');
        if (fs.existsSync(dst)) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        const bdb = new Database(src);
        try { bdb.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`); } finally { bdb.close(); }
      }
      // 合并到 keeper
      const kdb = new Database(dbs[keep.mt]);
      try {
        const ref = list.reduce((n, x) => n + (x.reference_count || 0), 0);
        const imp = Math.max(...list.map(x => x.importance || 0));
        kdb.prepare('UPDATE memory SET reference_count=?, importance=MAX(importance, ?), updated_at=? WHERE id=?')
          .run(ref, imp, new Date().toISOString(), id);
      } finally { kdb.close(); }
      // 软删副本 + 清向量/边
      for (const d of drop) {
        const db = new Database(dbs[d.mt]);
        try {
          const row = db.prepare('SELECT rowid FROM memory WHERE id=? AND is_active=1').get(id);
          if (row) {
            try { db.prepare('DELETE FROM vec_memory WHERE rowid=?').run(row.rowid); } catch { /* no vec */ }
            try { db.prepare('DELETE FROM edges WHERE source_id=? OR target_id=?').run(id, id); } catch { /* no edges */ }
            db.prepare("UPDATE memory SET is_active=0, status='superseded', updated_at=? WHERE id=?").run(new Date().toISOString(), id);
            removed++;
          }
        } finally { db.close(); }
      }
    }
  }
}
console.log(JSON.stringify({ apply, groups, removed, backupRoot: apply ? backupRoot : null }));
