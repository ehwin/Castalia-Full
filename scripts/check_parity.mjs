/**
 * 引擎基线对齐检查：确认 Full（总线接口）的核心与 Lite 同源，Anima 只作参考列。
 *
 * 背景：2026-10-23/24 的 v1.23 底层优化（Parent-Child 回捞、facts 时间有效性、
 * 冷存分层、整合轮转/输入指纹、invalidate 裁决）先落在 Full，Anima 只跟了一半，
 * 于是同一份"记忆引擎"在 AIRI 与其它实例上行为不同。
 *
 * v1.25 起架构改为：**Lite = 引擎核心源；Full = 总线接口（核心由 sync_core 从 Lite
 * 同步）；Anima = 情感变体，自己一条引擎线**。所以
 *   · lite 与 full 缺任何标记 → 失败（ok=false，--strict 时非零退出）
 *   · anima 缺失 → 只记 warning 并列在表里，不参与 ok（它有自己版本线）
 *
 * 用法（在 Castalia-Full 目录下）：
 *   node scripts/check_parity.mjs            # 检查三棵树
 *   node scripts/check_parity.mjs --strict   # lite/full 缺失即非零退出
 *
 * 只看源码标记，不读数据库、不改任何文件。新增跨引擎能力时，把标记加进 PROBES。
 */
import fs from 'node:fs';
import path from 'node:path';

const strict = process.argv.includes('--strict');
const root = path.resolve(import.meta.dirname, '..', '..');

const ENGINES = {
  lite: path.join(root, 'Castalia', 'src'),
  full: path.join(root, 'Castalia-Full', 'src'),
};
// 参考列：不参与 ok
const REFERENCE = {
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
let missing = 0;        // 只在 lite/full 上计数 → 决定 ok
let refMissing = 0;     // anima 参考列

function probe(dir, specs) {
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
  return missingHere;
}

for (const [feature, specs] of Object.entries(PROBES)) {
  const per = {};
  for (const [engine, dir] of Object.entries(ENGINES)) {
    per[engine] = probe(dir, specs);
    if (per[engine].length) missing++;
  }
  for (const [engine, dir] of Object.entries(REFERENCE)) {
    per[engine] = probe(dir, specs);
    if (per[engine].length) refMissing++;
  }
  rows.push({ feature, ...per });
}

const cols = [...Object.keys(ENGINES), ...Object.keys(REFERENCE)];
const pad = (s, w) => String(s).padEnd(w);
console.log(pad('feature', 22) + cols.map(c => pad(c, 10)).join(''));
for (const r of rows) {
  console.log(pad(r.feature, 22) + cols.map(c => pad(r[c].length ? 'MISSING' : 'ok', 10)).join(''));
  for (const c of cols) for (const m of r[c]) console.log(`  ${c} - ${m}`);
}
const summary = { features: rows.length, missingEngineFeatures: missing,
                 referenceMissing: refMissing, ok: missing === 0 };
console.log(JSON.stringify(summary));
if (strict && missing > 0) process.exit(1);
