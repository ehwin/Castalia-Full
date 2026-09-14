#!/usr/bin/env node
/**
 * reclassify_memtype.mjs — 存量记忆 memType 批量重分类(memdir 分库版)
 *
 * 背景:memdir 布局下每个 memType 是独立 sqlite(memory/<project>/<memType>/memory.sqlite),
 * 所以"改 memType" = 跨分类搬家,不能只 UPDATE 列。这里**直接调用引擎自己的 store.updateMemory**,
 * 由它负责(复制到目标分类库 + 迁移向量 + 软删原库)——与引擎行为一致,不手搓 SQL。
 *
 * 保护:跳过 tier='critical'(手工定稿的权威条目,如自定义领域基准画像),避免被 LLM 重新打散。
 *
 * 用法(一次一个目标,env 与 configLoader 单例绑定,勿在同进程里切库):
 *   <node137> reclassify_memtype.mjs --bank=lobehub --project=custom-project [--limit=40] [--dry-run]
 *                                     [--types=user,general] [--hint="自定义领域custom类归 project/reference"]
 */
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const BANKS = '/path/to/castalia/memory-banks';
const RUN = '/path/to/castalia/run';

/** bank/project → 引擎 dist 与运行目录(构建来源:lobehub/hermes=Lite-Full,airi=Anima) */
const TARGETS = {
  'lobehub/lobehub': { engine: path.join(RUN, 'LobeHub'), char: 'lobehub' },
  'lobehub/custom-project': { engine: path.join(RUN, 'LobeHub'), char: 'custom-project' },
  'lobehub/reflect': { engine: path.join(RUN, 'LobeHub'), char: 'lobehub' },
  'hermes/hermes': { engine: path.join(RUN, 'Castalia'), char: 'hermes' },
  'airi/airi': { engine: path.join(RUN, 'Castalia-Anima'), char: 'airi' },
};

const arg = (k, d = '') => {
  const pre = k + '=';
  const hit = process.argv.find(a => a.startsWith(pre));
  if (hit) return hit.slice(pre.length);
  const i = process.argv.indexOf(k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const bank = arg('--bank'),
  proj = arg('--project');
const key = `${bank}/${proj}`;
if (!TARGETS[key]) {
  console.error(`未知目标 ${key}。可用: ${Object.keys(TARGETS).join(', ')}`);
  process.exit(2);
}
const t = TARGETS[key];
const limit = Number(arg('--limit', '0')) || 0;
const dryRun = process.argv.includes('--dry-run');
const types = arg('--types', 'user,feedback,project,reference,general').split(',').map(s => s.trim()).filter(Boolean);
const hint = arg('--hint', '');

/* Anima(情感版)的 memType 语义与通用版**不同**(v1.18 定制):project=情感分区、user=AI 对用户的画像。
 * 用通用四类去分情感库会整体错位,所以按 profile 换口径块。 */
/* 口径:与引擎的 memType.ts / 分拣提示词一致(两版定义相同)。
 * 注意:曾错误地引入过"anima=情感分区"的 profile(2026-09-14 已删) ——
 * 那是误解,导致 AIRI 库的人设/情感记忆被倒进 project(项目上下文)。
 * 需要偏向某种归类时用 --hint 传提示,不要再改口径块。 */
  const TYPE_BLOCK = `- user — 用户画像:关于用户**本人是什么样的人**(偏好/习惯/性格/技术栈/行为模式/人物关系/他的命盘八字等个人资料)
- feedback — 行为纠正:用户对 agent 行为的纠正或肯定
- project — 项目上下文:某个项目/任务的约定、截止时间、环境、领域工作内容
- reference — 外部指针:URL/ID/文档链接/古籍出处
- general — 其他(知识/事实/事件/无法归类)`;

/* —— 环境必须在 configLoader 之前注入(它负责解密 keys.enc 并写入 env) —— */
const bankDir = path.join(BANKS, bank);
process.env.MEMORY_DB_DIR = bankDir;
process.env.CHAR_ID = t.char;
process.env.CASTALIA_PROJECT = proj;
process.env.CASTALIA_KEYS_FILE = path.join(bankDir, 'keys.enc');
process.env.CASTALIA_KEY_FILE = path.join(bankDir, 'keys.key');
process.env.MEMORY_CONFIG = path.join(bankDir, 'config.json');
process.env.MCP_TOOLS = 'all';

await import(pathToFileURL(path.join(t.engine, 'dist', 'configLoader.js')).href);
const { callLlm, makeLlmChannel } = require(path.join(t.engine, 'dist', 'reflectDriver.js'));
const { DatabaseManager } = require(path.join(t.engine, 'dist', 'db.js'));
const { updateMemory } = require(path.join(t.engine, 'dist', 'store.js'));

const SYSTEM = `你是记忆分类器。把每条记忆分类到 4 种封闭类型之一(无法判断则 general):
${TYPE_BLOCK}

判断原则:
* 记忆文本可能有 "# AI 对用户的画像:" 等标题前缀 —— 按**内容**判断,描述用户行为/偏好/性格的都属于 user。
* 如果一句话的主语是"用户/他",且说的是他的特征 → user;**领域知识/案例/方法**即使与他有关,也归 project。
* 拿不准 → general,不要硬塞。
${hint ? '* 本次领域补充:' + hint + '\n' : ''}只输出 JSON 数组:[{"id":"...","memType":"..."}]`;

const VALID = ['user', 'feedback', 'project', 'reference'];

/* —— 收集各 memType 分类库的存量 ——
 * ⚠️ 引擎 `findDbByMemoryId` 不筛 is_active 且按目录顺序取第一个命中:跨库搬家会在源库留墓碑,
 * 同一 id 若在两个库都活跃,第二次搬家会命中墓碑 → 双活跃(实测 2026-09-13 出现过 3 条)。
 * 这里的防护 = 同 id 只处理一次(取第一个遇到的活跃副本),并在末尾断言无跨库双活跃。 */
const rows = [];
const seen = new Set();
let dupSkipped = 0;
const beforeTotal = {};
for (const mt of types) {
  const db = DatabaseManager.getInstance(proj, mt);
  beforeTotal[mt] = db.prepare('SELECT COUNT(*) c FROM memory WHERE is_active=1').get().c;
  const got = db
    .prepare("SELECT id, text, mem_type, tier FROM memory WHERE is_active=1 AND COALESCE(source,'')!='conversation_log' ORDER BY created_at ASC")
    .all();
  let skippedCritical = 0, skippedDup = 0;
  for (const r of got) {
    if (r.tier === 'critical') { skippedCritical++; continue; } // 权威条目保护
    if (seen.has(r.id)) { dupSkipped++; skippedDup++; console.error(`  ! 双活跃 id 已存在(跳过 ${mt} 副本): ${r.id}`); continue; }
    seen.add(r.id);
    rows.push(r);
  }
  console.log(`  ${mt}: 活跃 ${beforeTotal[mt]} 条(纳入分类 ${got.length - skippedCritical - skippedDup},critical 保护 ${skippedCritical},双活跃跳过 ${skippedDup})`);
}
console.log(`\n目标 ${key} · 待分类 ${rows.length} 条 · 批大小 20 · ${dryRun ? 'DRY-RUN' : '实跑'}\n`);

const channel = makeLlmChannel('triage');
const batchSize = 20;
let changed = 0, errors = 0, calls = 0;
const moves = {};

for (let i = 0; i < rows.length; i += batchSize) {
  const batch = rows.slice(i, i + batchSize);
  const userPrompt = `请分类以下记忆:\n${batch.map(r => `${r.id}|${r.text.slice(0, 200).replace(/\n/g, ' ')}`).join('\n')}\n\n返回 JSON 数组。`;
  const llm = await callLlm(SYSTEM, userPrompt, channel);
  calls++;
  if (!llm) { errors += batch.length; console.error(`  批次 ${i / batchSize + 1} LLM 调用失败`); continue; }
  let parsed = [];
  try {
    const m = llm.content.match(/\[[\s\S]*\]/);
    parsed = JSON.parse(m ? m[0] : '[]');
  } catch {
    errors += batch.length;
    console.error(`  批次 ${i / batchSize + 1} 解析失败: ${String(llm.content).slice(0, 100)}`);
    continue;
  }
  const byId = new Map(parsed.map(x => [String(x.id), String(x.memType || '')]));
  for (const r of batch) {
    const raw = byId.get(r.id);
    const target = VALID.includes(raw) ? raw : 'general';
    if (target === r.mem_type) continue;
    console.log(`  [${r.mem_type} → ${target}] ${r.text.slice(0, 46).replace(/\n/g, ' ')}`);
    if (!dryRun) {
      const ok = await updateMemory(r.id, { memType: target, project: proj });
      if (!ok) { errors++; console.error(`    ! 搬家失败 ${r.id}`); continue; }
    }
    moves[`${r.mem_type}→${target}`] = (moves[`${r.mem_type}→${target}`] || 0) + 1;
    changed++;
  }
  console.log(`  批次 ${i / batchSize + 1}/${Math.ceil(rows.length / batchSize)} 完成`);
  if (limit && changed >= limit) { console.log('  达到 --limit,提前结束'); break; }
}

/* —— 复验:各分类库活跃数 + 总量守恒 + 无跨库双活跃 —— */
const after = {};
const actIds = new Map();
for (const mt of types) {
  const db = DatabaseManager.getInstance(proj, mt);
  after[mt] = db.prepare('SELECT COUNT(*) c FROM memory WHERE is_active=1').get().c;
  for (const r of db.prepare('SELECT id FROM memory WHERE is_active=1').all()) actIds.set(r.id, (actIds.get(r.id) || 0) + 1);
}
const dups = [...actIds.entries()].filter(([, n]) => n > 1);
const beforeTotal2 = Object.values(beforeTotal).reduce((a, b) => a + b, 0);
const afterTotal = Object.values(after).reduce((a, b) => a + b, 0);
console.log(`\n=== ${key}: 变更 ${changed} 条 L:${calls} 错误 ${errors} ${dryRun ? '(DRY-RUN)' : ''} ===`);
console.log('  分布 前:', JSON.stringify(beforeTotal));
console.log('  分布 后:', JSON.stringify(after));
console.log('  搬家统计:', JSON.stringify(moves));
console.log(`  活跃总量 ${beforeTotal2} → ${afterTotal} ${beforeTotal2 === afterTotal ? '✓ 守恒' : '✗ 不守恒(查备份)'}`);
console.log(`  跨库双活跃: ${dups.length} ${dups.length === 0 ? '✓' : '✗ ' + JSON.stringify(dups.slice(0, 5))}`);
process.exit(0);
