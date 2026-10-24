// 清理同 memType 内"归一化文本完全相同"的重复反思记忆（仅空白/大小写差异）。
// 默认 dry-run；--apply 备份后软删旧副本，引用计数/重要性并入保留行（最新创建的那条）。
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/AI/castalia/memory-banks';
const MT = ['general', 'user', 'feedback', 'project', 'reference'];
const apply = process.argv.includes('--apply');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupRoot = path.join('D:/AI/castalia/_backups', `near-dup-${stamp}`);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
let groups = 0, removed = 0;

for (const bank of fs.readdirSync(ROOT)) {
  const bankDir = path.join(ROOT, bank);
  if (!fs.statSync(bankDir).isDirectory() || bank.startsWith('_backup')) continue;
  for (const proj of fs.readdirSync(bankDir)) {
    const projDir = path.join(bankDir, proj);
    if (!fs.statSync(projDir).isDirectory()) continue;
    for (const mt of MT) {
      const f = path.join(projDir, mt, 'memory.sqlite');
      if (!fs.existsSync(f)) continue;
      const db = new Database(f);
      try {
        const rows = db.prepare("SELECT id, text, created_at, importance, reference_count FROM memory WHERE is_active=1 AND source='reflect_extract'").all();
        const by = new Map();
        for (const r of rows) { const k = norm(r.text); if (!k) continue; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
        const dupGroups = [...by.values()].filter(v => v.length > 1);
        if (!dupGroups.length) continue;
        groups += dupGroups.length;
        if (apply) {
          const dst = path.join(backupRoot, bank, proj, mt, 'memory.sqlite');
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          const bdb = new Database(f);
          try { bdb.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`); } finally { bdb.close(); }
        }
        for (const v of dupGroups) {
          v.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
          const keep = v[0];
          const drop = v.slice(1);
          if (!apply) { console.log(bank + '/' + proj + '/' + mt, 'n=' + v.length, 'keep=' + keep.id.slice(0, 8), 'drop=' + drop.map(d => d.id.slice(0, 8)).join(',')); continue; }
          const ref = v.reduce((n, x) => n + (x.reference_count || 0), 0);
          const imp = Math.max(...v.map(x => x.importance || 0));
          db.prepare('UPDATE memory SET reference_count=?, importance=MAX(importance, ?), updated_at=? WHERE id=?')
            .run(ref, imp, new Date().toISOString(), keep.id);
          for (const d of drop) {
            const row = db.prepare('SELECT rowid FROM memory WHERE id=? AND is_active=1').get(d.id);
            if (!row) continue;
            try { db.prepare('DELETE FROM vec_memory WHERE rowid=?').run(row.rowid); } catch { /* no vec */ }
            try { db.prepare('DELETE FROM edges WHERE source_id=? OR target_id=?').run(d.id, d.id); } catch { /* no edges */ }
            db.prepare("UPDATE memory SET is_active=0, status='superseded', updated_at=? WHERE id=?").run(new Date().toISOString(), d.id);
            removed++;
          }
        }
      } finally { db.close(); }
    }
  }
}
console.log(JSON.stringify({ apply, groups, removed, backupRoot: apply ? backupRoot : null }));
