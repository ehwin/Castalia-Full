/**
 * 引擎基线对齐检查：防止 Castalia-Full 与 Castalia-Anima 再次"分版本"。
 *
 * 背景：2026-10-23/24 的 v1.23 底层优化（Parent-Child 回捞、facts 时间有效性、
 * 冷存分层、整合轮转/输入指纹、invalidate 裁决）先落在 Full，Anima 只跟了一半，
 * 于是同一份"记忆引擎"在 AIRI 与其它实例上行为不同。
 *
 * 用法（在 Castalia-Full 目录下）：
 *   node scripts/check_parity.mjs            # 检查默认两棵树
 *   node scripts/check_parity.mjs --strict   # 缺失即非零退出
 *
 * 只看源码标记，不读数据库、不改任何文件。新增跨引擎能力时，把标记加进 PROBES。
 */
import fs from 'node:fs';
import path from 'node:path';

const strict = process.argv.includes('--strict');
const root = path.resolve(import.meta.dirname, '..', '..');

const ENGINES = {
  full: path.join(root, 'Castalia-Full', 'src'),
  anima: path.join(root, 'Castalia-Anima', 'src'),
};

// 每项：feature → [{ file, needles[] }]，needles 全部出现才算具备
const PROBES = {
  'parent-child 回捞': [
    { file: 'db.ts', needles: ['parent_id', 'idx_memory_parent'] },
    { file: 'search.ts', needles: ['parentId', 'parent_id'] },
    { file: 'index.ts', needles: ['hydrated', 'parentId'] },
  ],
  'facts 时间有效性': [
    { file: 'db.ts', needles: ['valid_from', 'valid_to', 'evidence'] },
    { file: 'store.ts', needles: ['valid_from', 'valid_to', "FUNCTIONAL_PREDICATES"] },
    { file: 'index.ts', needles: ["valid_to IS NULL"] },
    { file: 'search.ts', needles: ["valid_to IS NULL"] },
  ],
  '冷存分层': [
    { file: 'store.ts', needles: ['markColdMemories', 'COLD_AFTER_DAYS'] },
    { file: 'reflectDriver.ts', needles: ["status, '') <> 'cold'"] },
  ],
  '整合闸门与轮转': [
    { file: 'reflectDriver.ts', needles: ['CONSOLIDATE_MIN_INTERVAL_HOURS', 'fingerprint', 'windowWhere', 'oldestSlice|tailRows'] },
  ],
  'invalidate 裁决': [
    { file: 'reflectDriver.ts', needles: ['invalidate', "valid_to"] },
  ],
  '整合任务提示词': [
    // v1.23-fix：整合必须是"整合任务 + 保真约束"，不能再用保真提取提示词整体替换
    { file: 'reflectDriver.ts', needles: ['consolidation: true'], absent: ['fidelitySystemPrompt(proj, true)'] },
  ],
  'critical 保护': [
    { file: 'reflect.ts', needles: ["<> 'critical'", 'identity_locked'] },
    { file: 'reflectDriver.ts', needles: ["<> 'critical'"] },
  ],
  'superseded 全路径过滤': [
    { file: 'search.ts', needles: ["<> 'superseded'"] },
  ],
  '冷存回温': [
    { file: 'search.ts', needles: ['cold'] },
  ],
  'hardFacts / 证据附录': [
    { file: 'reflect.ts', needles: ['hardFacts', 'linkedMemoryIds'] },
  ],
};

const rows = [];
let missing = 0;
for (const [feature, specs] of Object.entries(PROBES)) {
  const per = {};
  for (const [engine, dir] of Object.entries(ENGINES)) {
    const missingHere = [];
    for (const spec of specs) {
      const file = path.join(dir, spec.file);
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { missingHere.push(`${spec.file}:<missing file>`); continue; }
      for (const needle of spec.needles) {
        // "a|b" = 任一命中即可（不同引擎的等价实现可能用不同变量名）
        const variants = needle.split('|');
        if (!variants.some(v => text.includes(v))) missingHere.push(`${spec.file}:${variants[0]}`);
      }
      for (const banned of spec.absent || []) {
        if (text.includes(banned)) missingHere.push(`${spec.file}:不应出现 ${banned}`);
      }
    }
    per[engine] = missingHere;
    if (missingHere.length) missing++;
  }
  rows.push({ feature, full: per.full, anima: per.anima });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('feature', 22) + pad('full', 10) + 'anima');
for (const r of rows) {
  console.log(pad(r.feature, 22) + pad(r.full.length ? 'MISSING' : 'ok', 10) + (r.anima.length ? 'MISSING' : 'ok'));
  for (const m of r.full) console.log(`  full  - ${m}`);
  for (const m of r.anima) console.log(`  anima - ${m}`);
}
const summary = { features: rows.length, missingEngineFeatures: missing, ok: missing === 0 };
console.log(JSON.stringify(summary));
if (strict && missing > 0) process.exit(1);
