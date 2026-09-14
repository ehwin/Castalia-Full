#!/usr/bin/env node
/**
 * test_finddb_active.mjs — findDbByMemoryId 活跃行优先的回归测试
 *
 * 复现场景(2026-09-13 实测真 bug):
 *   1) 一条记忆从 general 搬到 user  → 源库留 is_active=0 墓碑
 *   2) 再把它从 user 搬到 project    → 旧代码按目录顺序先命中 general 墓碑,
 *      于是"插新副本 + 软删墓碑(本来就 0)" → **真身 user 副本留在原地** = 同 id 双活跃
 * 修复后期望:第 2 步打在真活跃行上 → 全库只剩 1 个活跃副本,且落在 project。
 *
 * 用法: <node137> test_finddb_active.mjs <引擎实例目录>     # 例: /path/to/castalia/run/Castalia
 * 只在临时库上跑(MEMORY_DB_DIR=<temp>),不碰真库。
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createRequire } from 'module';

const engine = process.argv[2];
if (!engine) { console.error('用法: test_finddb_active.mjs <引擎实例目录>'); process.exit(2); }
const require = createRequire(path.join(engine, 'package.json'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-finddb-'));
process.env.MEMORY_DB_DIR = tmp;
process.env.CHAR_ID = 'tester';
process.env.CASTALIA_PROJECT = 't1';

const { saveMemory, updateMemory } = require(path.join(engine, 'dist', 'store.js'));
const { DatabaseManager } = require(path.join(engine, 'dist', 'db.js'));

const MTS = ['user', 'feedback', 'project', 'reference', 'general'];
const snapshot = () => {
  const out = {};
  for (const mt of MTS) {
    try { out[mt] = DatabaseManager.getInstance('t1', mt).prepare('SELECT id FROM memory WHERE is_active=1').all().map(r => r.id); }
    catch { out[mt] = []; }
  }
  return out;
};

const rec = await saveMemory({ text: '回归测试:搬家两次不应产生双活跃', project: 't1', memType: 'general', characterId: 'tester' });
const id = rec && (rec.id || rec);
console.log('初始落位:', JSON.stringify(snapshot()));

await updateMemory(id, { memType: 'user', project: 't1' });
console.log('第 1 次搬家(→user):', JSON.stringify(snapshot()));

await updateMemory(id, { memType: 'project', project: 't1' });
const s = snapshot();
console.log('第 2 次搬家(→project):', JSON.stringify(s));

const actives = MTS.filter(mt => (s[mt] || []).includes(id));
const pass = actives.length === 1 && actives[0] === 'project';
console.log('\n结论: id 出现在 %s ✅/❌ 期望只有 [project]' % JSON.stringify(actives));
console.log(pass ? '✓ PASS — 活跃行优先生效,不再产生双活跃' : '✗ FAIL — 仍有两个活跃副本(修复未生效)');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(pass ? 0 : 1);
