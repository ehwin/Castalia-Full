// 点映射审计：重复库 / 重复点（直接读 memory-banks，不依赖 /api/graph 的截断字段）。
// dry audit only. 输出 JSON 摘要 + 最多 10 组样例。
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/AI/castalia/memory-banks';
const MT = ['general', 'user', 'feedback', 'project', 'reference'];
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const libs = new Map();          // libKey -> Map(normText -> [rows])
const idMap = new Map();         // rawId -> rows
let rowsTotal = 0;

for (const bank of fs.readdirSync(ROOT)) {
  const bankDir = path.join(ROOT, bank);
  if (!fs.statSync(bankDir).isDirectory() || bank.startsWith('_backup')) continue;
  for (const proj of fs.readdirSync(bankDir)) {
    const projDir = path.join(bankDir, proj);
    if (!fs.statSync(projDir).isDirectory()) continue;
    for (const mt of MT) {
      const f = path.join(projDir, mt, 'memory.sqlite');
      if (!fs.existsSync(f)) continue;
      const db = new Database(f, { readonly: true });
      try {
        for (const r of db.prepare('SELECT id, text, source, created_at FROM memory WHERE is_active=1').all()) {
          rowsTotal++;
          if (!idMap.has(r.id)) idMap.set(r.id, []);
          idMap.get(r.id).push({ bank, proj, mt, ...r });
          const k = bank + '/' + proj;
          if (!libs.has(k)) libs.set(k, new Map());
          const m = libs.get(k);
          const t = norm(r.text);
          if (!t) continue;
          if (!m.has(t)) m.set(t, []);
          m.get(t).push({ id: r.id, mt, source: r.source, created_at: r.created_at });
        }
      } finally { db.close(); }
    }
  }
}

const sameId = [...idMap.values()].filter(v => v.length > 1);
let sameMtGroups = 0, sameMtNodes = 0, crossMtGroups = 0, crossMtNodes = 0;
const samples = [];
for (const [lib, m] of libs) {
  for (const [t, v] of m) {
    if (v.length < 2) continue;
    const mts = new Set(v.map(x => x.mt));
    if (mts.size > 1) { crossMtGroups++; crossMtNodes += v.length; }
    else { sameMtGroups++; sameMtNodes += v.length; }
    if (samples.length < 10) samples.push({ lib, n: v.length, memTypes: [...mts], ids: v.map(x => x.id.slice(0, 8)) });
  }
}
// 重复库：不同库之间归一化文本重合率 > 30% 才报
const libKeys = [...libs.keys()];
const dupLibs = [];
for (let i = 0; i < libKeys.length; i++) {
  for (let j = i + 1; j < libKeys.length; j++) {
    const a = libs.get(libKeys[i]), b = libs.get(libKeys[j]);
    let inter = 0;
    for (const t of a.keys()) if (b.has(t)) inter++;
    const ratio = inter / Math.max(1, Math.min(a.size, b.size));
    if (ratio > 0.3) dupLibs.push({ a: libKeys[i], b: libKeys[j], overlap: inter, ratio: Number(ratio.toFixed(3)) });
  }
}
console.log(JSON.stringify({
  rows: rowsTotal,
  libraries: libKeys.length,
  duplicateIds: sameId.length,
  sameMemTypeDupGroups: sameMtGroups,
  sameMemTypeDupNodes: sameMtNodes,
  crossMemTypeDupGroups: crossMtGroups,
  crossMemTypeDupNodes: crossMtNodes,
  duplicateLibraries: dupLibs,
  samples,
}, null, 1));
