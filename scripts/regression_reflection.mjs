// Offline integration checks: all databases and receipts are isolated; fetch is mocked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2] || '.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-reflection-'));
const config = path.join(temp, 'config.json');
fs.writeFileSync(config, JSON.stringify({ reflect: { preservation: 'evidence' } }));
Object.assign(process.env, { MEMORY_DB_DIR: temp, MEMORY_CONFIG: config, EMBED_MODE: 'none', CASTALIA_PROJECT: 'engineering',
  REFLECT_LLM_API_KEY: 'fixture', REFLECT_LLM_URL: 'https://fixture.invalid', REFLECT_LLM_RETRIES: '1',
  TRIAGE_LLM_API_KEY: 'fixture', TRIAGE_LLM_URL: 'https://fixture.invalid', REFLECT_DEEP_CHUNK: '4', REFLECT_DEEP_MAXCALLS: '1',
  REFLECT_VERBATIM_PROJECTS: 'verbatim-demo', REFLECT_EVIDENCE_PROJECTS: 'engineering' });
delete process.env.MEMORY_DB_PATH;
delete process.env.FEDERATION_DIRS;
delete process.env.REFLECT_DIR;
const load = name => import(pathToFileURL(path.join(root, 'dist', name + '.js')).href);
const { DatabaseManager, safeFilePart } = await load('db');
const { consolidate } = await load('consolidate');
const { saveMemory, findDbByMemoryId, getSessionMemory, promoteToProject, saveFacts, markColdMemories, getFactsBySubject } = await load('store');
const { searchMemory, getRecentMemories } = await load('search');
const { applyReflectActions, applyReflectResult, getUnanalyzedConversations, markConversationsReflected } = await load('reflect');
const { runAutoReflect, runDeepReflect, runConsolidate, shouldAutoReflect, REFLECT_SYSTEM_PROMPT } = await load('reflectDriver');
const { runReflectAll } = await load('reflectAll');
const { runIncrementalReflection, isDuplicate } = await load('triage');
const { parseJsonRobust, makeLlmChannel } = await load('reflectionLlm');
const { normalizeMarkdown } = await load('memType');
const { wholeRecordBatches } = await load('reflectionFidelity');
let checks = 0, calls = [], respond;
const check = (value, message) => { assert.ok(value, message); checks++; };
const json = value => ({ content: JSON.stringify(value), finish_reason: 'stop' });
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  calls.push(body);
  const result = respond(body);
  return new Response(JSON.stringify({ choices: [{ finish_reason: result.finish_reason, message: { content: result.content } }] }), { status: 200 });
};
const db = project => DatabaseManager.getInstance(project);
const source = async (project, text, id, memType = 'general') => {
  const m = await saveMemory({ project, text, memType, source: 'conversation_log' });
  const d = findDbByMemoryId(m.id, project).db;
  d.prepare("UPDATE memory SET id=?, is_active=0, created_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(id, m.id);
  return id;
};
const sourceRow = (project, id) => findDbByMemoryId(id, project)?.db.prepare('SELECT * FROM memory WHERE id=?').get(id);
const records = body => {
  const text = body.messages[1].content;
  const start = text.indexOf('[');
  const tail = text.slice(start);
  const end = tail.lastIndexOf(']');
  return JSON.parse(tail.slice(0, end + 1));
};
const extraction = (batch, extras = {}) => ({ processedSourceIds: batch.map(r => r.id), summary: '导航', highlights: [], facts: [], insights: [],
  actions: batch.map(r => ({ action: 'extract', sourceId: r.id, newText: r.text, newCategory: 'context', newMemType: 'project' })), ...extras });
try {
  process.env.TRIAGE_LLM_MODEL = 'triage-fixture';
  check(makeLlmChannel('triage').model === 'triage-fixture', 'triage uses its own uppercase environment channel');
  const codeEvidence = '配置示例\n\n```python\nif ready:\n    start(port=3318)\n```\n\n| 参数 | 值 |\n| --- | --- |\n| 端口 | 3318 |';
  check(normalizeMarkdown(codeEvidence, 'project').endsWith(codeEvidence), 'Markdown wrapping preserves code indentation and empty lines');
  const packed = wholeRecordBatches([{ text: 'x'.repeat(35000) }, { text: 'tail' }]);
  check(packed.length === 2 && packed[0][0].text.length === 35000, 'oversize record remains intact');
  check(parseJsonRobust('{"actions":[{"action":"delete"', false) === null, 'strict parser rejects partial JSON');
  const long = '原文'.repeat(1800) + '\n关键修正：桥端口3318，DSH与Hermes独立。';
  await source('engineering', long, 'log_engineering_001');
  let r = await applyReflectActions([{ action: 'extract', sourceId: 'log_engineering_001', newText: long, newCategory: 'decision', newMemType: 'project' }], 'fixture', 'engineering');
  check(r.applied === 1, 'inactive conversation source supports extract');
  check(sourceRow('engineering', 'log_engineering_001').is_active === 0, 'source stays inactive and intact');
  const output = DatabaseManager.getInstance('engineering', 'project').prepare("SELECT * FROM memory WHERE source='reflect_extract'").get();
  check(output.text.includes('关键修正') && output.category === 'decision', 'tail and custom category survive extraction');
  check(JSON.parse(output.metadata).reflection.sourceIds.includes('log_engineering_001'), 'extraction stores provenance');
  const other = await saveMemory({ text: 'unseen target', project: 'engineering' });
  r = await applyReflectActions([{ action: 'extract', sourceId: other.id, newText: 'forged' }], 'fixture', 'engineering', { allowedSourceIds: new Set(['log_engineering_001']), automatic: true });
  check(r.applied === 0 && r.errors.length, 'real but unseen ID is rejected');
  r = await applyReflectActions([{ action: 'delete', targetId: other.id }], 'fixture', 'engineering', { automatic: true });
  check(r.applied === 0 && sourceRow('engineering', other.id).is_active === 1, 'engineering automatic delete is refused');
  r = await applyReflectResult({ summary: 'must not appear', actions: [{ action: 'extract', sourceId: 'invented', newText: 'bad' }] }, 'fixture', 'engineering', { automatic: true, allowedSourceIds: new Set(['log_engineering_001']) });
  check(!r.summaryId && r.errors.length, 'failed extract does not save misleading summary');
  const verbatim = await saveMemory({ project: 'verbatim-demo', text: '原始记录：条件 A，不可改写。', memType: 'general' });
  const verbatim2 = await saveMemory({ project: 'verbatim-demo', text: '反例：修正条件 B。' });
  for (const action of [{ action: 'delete', targetId: verbatim.id }, { action: 'merge', sourceIds: [verbatim.id, verbatim2.id], newText: '短结论' }, { action: 'split', targetId: verbatim.id, fragments: [{ text: '碎片' }] }, { action: 'reclassify', targetId: verbatim.id, newText: '改写' }]) {
    const result = await applyReflectActions([action], 'fixture', 'verbatim-demo');
    check(result.applied === 0 && sourceRow('verbatim-demo', verbatim.id).text === verbatim.text, `verbatim-demo refuses ${action.action}`);
  }
  r = await applyReflectActions([{ action: 'reclassify', targetId: verbatim.id, newCategory: 'custom', newType: 'semantic' }], 'fixture', 'verbatim-demo');
  check(r.applied === 1 && sourceRow('verbatim-demo', verbatim.id).category === 'custom', 'metadata-only verbatim classification works');
  for (let i = 0; i < 37; i++) await source('backlog', 'backlog original ' + i, 'backlog-' + String(i).padStart(3, '0'));
  await saveMemory({ project: 'backlog', source: 'reflect_summary', text: 'old summary newer than every source', memType: 'project' });
  const first = getUnanalyzedConversations('fixture', undefined, 7, 'backlog');
  check(first.length === 7 && first[0].createdAt === '2026-01-01T00:00:00.000Z', 'summary does not hide old logs; date is explicit');
  markConversationsReflected(first.map(r => r.id), 'backlog');
  check(getUnanalyzedConversations('fixture', undefined, 50, 'backlog').length === 30, 'per-ID cursor preserves limit backlog');
  check(shouldAutoReflect('fixture', 'backlog').should === false, 'time gap remains independent of queue');
  await source('auto-evidence', long, 'auto-source');
  respond = body => json(extraction(records(body)));
  r = await runAutoReflect('fixture', 30, 'auto-evidence');
  check(r.ok && r.processedCount === 1 && r.applied === 1, 'auto reflection processes full evidence: ' + JSON.stringify(r));
  check(calls.at(-1).messages[1].content.includes('关键修正') && calls.at(-1).messages[1].content.includes('auto-source'), 'model receives full text and real IDs');
  check(!calls.at(-1).messages[0].content.includes('约 50 字'), 'evidence prompt has no diary compression requirement');
  check(getUnanalyzedConversations('fixture', undefined, 30, 'auto-evidence').length === 0, 'only successful sources advance progress');
  check(/facts 字段是结构化三元组/.test(calls.at(-1).messages[0].content), 'evidence prompt states the facts field contract');
  // 2026-10-23 事故回归：提示词只给 `facts: []` 时模型会写成字符串 / {sourceId,text}，
  // saveFacts 抛 NOT NULL → 驱动在 markConversationsReflected 之前 break → 同批无限重跑。
  await source('facts-shape', 'fact evidence 3318', 'fs-a');
  calls = [];
  respond = body => json(extraction(records(body), { facts: ['2026-01-01 用户提到端口 3318', { sourceId: 'fs-a', text: '非三元组事实' }, { subject: 'user', predicate: '端口', object: '3318', confidence: 0.9 }] }));
  r = await runAutoReflect('fixture', 30, 'facts-shape');
  check(r.ok && r.processedCount === 1 && r.factsInserted === 1, 'malformed facts are dropped, valid one is stored, batch still advances: ' + JSON.stringify(r));
  check((r.warnings || []).some(w => w.includes('facts')), 'dropped facts leave an audit warning');
  check(getUnanalyzedConversations('fixture', undefined, 30, 'facts-shape').length === 0, 'facts shape never blocks the cursor');
  await source('facts-none', 'no fact evidence', 'fn-a');
  respond = body => json(extraction(records(body), { facts: ['纯字符串事实', 'another string'] }));
  r = await runAutoReflect('fixture', 30, 'facts-none');
  check(r.ok && r.processedCount === 1 && r.factsInserted === 0, 'string-only facts neither crash nor block progress: ' + JSON.stringify(r));

  // ── v1.23 保真链路：多主题拆条 / 引用校验 / hard_facts 证据 / parent_id / 证据附录 / critical 保护 ──
  await source('v2', '端口 3318，版本 1.2.3，路径 D:\\AI\\x。先做 A。再做 B。', 'v2-src');
  respond = body => json({
    processedSourceIds: ['v2-src'],
    summary: '导航',
    facts: [],
    insights: [],
    actions: [
      {
        action: 'extract', sourceId: 'v2-src', newText: '先做 A', newMemType: 'project', newCategory: 'context',
        quotes: ['先做 A。', '这句原文里根本没有'],
        hardFacts: [{ subject: 'environment', predicate: '端口', object: '3318', evidence: '端口 3318', confidence: 0.9 }],
      },
      { action: 'extract', sourceId: 'v2-src', newText: '再做 B', newMemType: 'project', newCategory: 'context' },
    ],
  });
  r = await runAutoReflect('fixture', 30, 'v2');
  check(r.ok && r.applied === 2 && r.processedCount === 1, 'multi-topic: one source produces several leaves: ' + JSON.stringify(r));
  const leaves = DatabaseManager.getInstance('v2', 'project').prepare("SELECT * FROM memory WHERE source='reflect_extract'").all();
  check(leaves.length === 2, 'two leaves stored for one source');
  check(leaves.every(l => l.parent_id === 'v2-src'), 'leaves keep parent_id (parent-child link)');
  const quoted = leaves.filter(l => String(l.text).includes('【原文引用】'));
  check(quoted.length === 1 && !String(quoted[0].text).includes('这句原文里根本没有'), 'fabricated quote dropped, real quote kept');
  const factRow = DatabaseManager.getInstance('v2').prepare("SELECT * FROM facts WHERE object='3318'").get();
  check(!!factRow && !!factRow.evidence, 'hard fact stored with evidence');
  await source('v2b', '端口 3318，版本 9.9.9，其它都正常。', 'v2b-src');
  respond = body => json({
    processedSourceIds: ['v2b-src'], summary: '导航', facts: [], insights: [],
    actions: [{ action: 'extract', sourceId: 'v2b-src', newText: '没有任何数字的记录', newMemType: 'project', newCategory: 'context' }],
  });
  r = await runAutoReflect('fixture', 30, 'v2b');
  const appendixLeaf = DatabaseManager.getInstance('v2b', 'project').prepare("SELECT * FROM memory WHERE source='reflect_extract'").get();
  check(!!appendixLeaf && String(appendixLeaf.text).includes('【证据附录·原文】') && String(appendixLeaf.text).includes('3318'), 'low hard-fact coverage appends verbatim evidence appendix');
  const crit = await saveMemory({ project: 'v2', text: '核心记忆不可动', tier: 'critical' });
  const normal = await saveMemory({ project: 'v2', text: '普通记忆可动' });
  r = await applyReflectActions([{ action: 'delete', targetId: crit.id }], 'fixture', 'v2', { automatic: true });
  check(r.applied === 0 && sourceRow('v2', crit.id).is_active === 1, 'critical memory cannot be deleted by reflection');
  r = await applyReflectActions([{ action: 'merge', sourceIds: [crit.id, normal.id], newText: '合并' }], 'fixture', 'v2', { automatic: true });
  check(r.applied === 0 && sourceRow('v2', crit.id).is_active === 1, 'critical memory cannot be merged');
  await saveMemory({ project: 'cons-window', text: 'CRITICAL-MARKER 核心记忆', tier: 'critical' });
  await saveMemory({ project: 'cons-window', text: '普通记忆 A' });
  await saveMemory({ project: 'cons-window', text: '普通记忆 B' });
  calls = [];
  respond = () => json({ actions: [] });
  await runConsolidate('fixture', 'cons-window', undefined, undefined, { force: true });
  check(calls.length === 0 || !calls[0].messages[1].content.includes('CRITICAL-MARKER'), 'critical memory is excluded from the consolidation window');

  // v1.23 冷存打标 + 事实冲突失效
  const cold = await saveMemory({ project: 'lifecycle', text: '很久以前的小事', importance: 0.3 });
  findDbByMemoryId(cold.id, 'lifecycle').db
    .prepare("UPDATE memory SET created_at='2026-01-01T00:00:00.000Z', last_accessed_at='2026-01-01T00:00:00.000Z', importance=0.3, reference_count=0 WHERE id=?")
    .run(cold.id);
  const coldMarked = markColdMemories('lifecycle');
  check(coldMarked >= 1 && String(sourceRow('lifecycle', cold.id).status) === 'cold', 'stale low-importance memory is marked cold');
  await saveFacts([{ subject: 'user', predicate: '姓名', object: '张三', confidence: 0.9 }], null, 'fixture', 'lifecycle');
  await saveFacts([{ subject: 'user', predicate: '姓名', object: '李四', confidence: 0.9 }], null, 'fixture', 'lifecycle');
  const nameFacts = DatabaseManager.getInstance('lifecycle').prepare("SELECT object, valid_to FROM facts WHERE predicate='姓名'").all();
  check(nameFacts.length >= 2 && nameFacts.some(f => f.object === '张三' && f.valid_to), 'functional fact conflict sets valid_to on the old value');

  // v1.23 冷存回温：被检索命中即回工作集
  await saveMemory({ project: 'warm', text: '冷存回温测试 3318 端口' });
  const warmDb = DatabaseManager.getInstance('warm');
  const warmId = warmDb.prepare("SELECT id FROM memory WHERE project='warm' LIMIT 1").get().id;
  warmDb.prepare("UPDATE memory SET status='cold' WHERE id=?").run(warmId);
  const warmHits = await searchMemory({ query: '冷存回温测试 3318', topK: 5, project: 'warm' });
  check(warmHits.some(h => h.id === warmId), 'cold memory is still searchable');
  check(String(warmDb.prepare('SELECT status FROM memory WHERE id=?').get(warmId).status || '') !== 'cold', 'cold memory warms up after being retrieved');

  // v1.23 非功能性冲突：整合阶段输出 invalidate → 旧事实打 valid_to
  await saveMemory({ project: 'lifecycle', text: '普通记忆，用于让整合窗口有两条以上' });
  await saveMemory({ project: 'lifecycle', text: '第二条普通记忆，凑够整合窗口' });
  const beforeFact = DatabaseManager.getInstance('lifecycle').prepare("SELECT id FROM facts WHERE predicate='姓名' AND object='李四'").get();
  calls = [];
  respond = () => json({ actions: [{ action: 'invalidate', factId: beforeFact.id, reason: '用户改名为王五' }] });
  r = await runConsolidate('fixture', 'lifecycle', undefined, undefined, { force: true });
  check(r.invalidated === 1, 'consolidation invalidates the contradicted fact: ' + JSON.stringify(r));
  const afterFact = DatabaseManager.getInstance('lifecycle').prepare('SELECT valid_to FROM facts WHERE id=?').get(beforeFact.id);
  check(!!afterFact && !!afterFact.valid_to, 'invalidated fact is kept with valid_to (not deleted)');

  // v1.23-fix：evidence 策略下整合必须能 merge（旧实现用保真提取提示词替换整合提示词 + 拒绝 merge，
  // 导致每次整合都变成"逐条重摘要"：净增记忆、merged 恒 0、token 照烧）
  await saveMemory({ project: 'lifecycle', text: '整合样本 X 版本一 3318' });
  await saveMemory({ project: 'lifecycle', text: '整合样本 X 版本二 3319' });
  const dupIds = DatabaseManager.getInstance('lifecycle').prepare("SELECT id FROM memory WHERE project='lifecycle' AND text LIKE '整合样本 X 版本%'").all().map(r => r.id);
  check(dupIds.length === 2, 'two merge sources created');
  calls = [];
  respond = () => json([{ action: 'merge', sourceIds: dupIds, newText: '整合样本 X（合并后）', newMemType: 'general' }]);
  r = await runConsolidate('fixture', 'lifecycle', undefined, undefined, { force: true });
  check(r.merged === 1, 'consolidation can merge duplicates under evidence policy: ' + JSON.stringify(r));
  check(calls.at(-1)?.messages[0].content.includes('CONFLICT RESOLUTION') && !calls.at(-1)?.messages[0].content.includes('禁止 merge'), 'consolidation keeps the consolidation task prompt under evidence policy');
  respond = () => json([{ action: 'extract', sourceId: dupIds[0], newText: '重新摘要' }]);
  r = await runConsolidate('fixture', 'lifecycle', undefined, undefined, { force: true });
  check(r.applied === 0 && r.errors.some(e => e.includes('extract')), 'extract is rejected in consolidation (no silent re-summarization)');

  // v1.23-fix：同批互斥值不得互相失效；旧值被重新断言时必须清掉 valid_to
  await saveFacts([
    { subject: 'user', predicate: '居住地', object: '北京', confidence: 0.9 },
    { subject: 'user', predicate: '居住地', object: '上海', confidence: 0.9 },
  ], null, 'fixture', 'lifecycle');
  const residence = DatabaseManager.getInstance('lifecycle').prepare("SELECT object, valid_to FROM facts WHERE predicate='居住地'").all();
  check(residence.length === 2 && residence.every(f => !f.valid_to), 'same-batch conflicting facts are not mutually invalidated');
  await saveFacts([{ subject: 'user', predicate: '昵称', object: '阿明', confidence: 0.9 }], null, 'fixture', 'lifecycle');
  await saveFacts([{ subject: 'user', predicate: '昵称', object: '小明', confidence: 0.9 }], null, 'fixture', 'lifecycle');
  const nickOld = () => DatabaseManager.getInstance('lifecycle').prepare("SELECT valid_to FROM facts WHERE predicate='昵称' AND object='阿明'").get();
  check(!!nickOld()?.valid_to, 'new functional value invalidates the previous one');
  await saveFacts([{ subject: 'user', predicate: '昵称', object: '阿明', confidence: 0.9 }], null, 'fixture', 'lifecycle');
  check(!nickOld()?.valid_to, 're-asserting an older value clears its valid_to');

  // v1.23-fix：读侧只返回当前有效事实（旧值保留在库里，但不能和当前值一起注入）
  await saveFacts([{ subject: 'user', predicate: '居住地', object: '广州', confidence: 0.9 }], null, 'fixture', 'lifecycle');
  const currentResidence = getFactsBySubject('user', undefined, 'lifecycle').filter(f => f.predicate === '居住地');
  check(currentResidence.length === 1 && currentResidence[0].object === '广州', 'fact read paths hide invalidated values: ' + JSON.stringify(currentResidence.map(f => f.object)));

  // v1.23-fix：superseded 必须在标签/文本路径也被排除（此前只有向量路径过滤）
  const sup = await saveMemory({ project: 'superseded-q', text: '检索过滤专用词 量子猫 3318', tags: ['量子猫'] });
  findDbByMemoryId(sup.id, 'superseded-q').db.prepare("UPDATE memory SET status='superseded' WHERE id=?").run(sup.id);
  const supHits = await searchMemory({ query: '量子猫', topK: 10, project: 'superseded-q' });
  check(!supHits.some(h => h.id === sup.id), 'superseded memory is excluded from every search path');

  await source('retry', 'retry original', 'retry-source');
  respond = body => ({ ...json(extraction(records(body))), finish_reason: 'length' });
  r = await runAutoReflect('fixture', 30, 'retry');
  check(!r.ok && r.applied === 0 && getUnanalyzedConversations('fixture', undefined, 30, 'retry').length === 1, 'length finish reason does not apply or advance');
  respond = () => ({ content: '{"summary":"partial","actions":[', finish_reason: 'stop' });
  r = await runAutoReflect('fixture', 30, 'retry');
  check(!r.ok && r.applied === 0, 'malformed partial response is rejected');
  respond = body => json(extraction(records(body), { actions: [{ action: 'extract', sourceId: 'wrong-id', newText: 'invalid' }] }));
  r = await runAutoReflect('fixture', 30, 'retry');
  check(!r.ok && getUnanalyzedConversations('fixture', undefined, 30, 'retry').length === 1, 'failed action keeps source pending');
  respond = body => json(extraction(records(body)));
  r = await runAutoReflect('fixture', 30, 'retry');
  check(r.ok && r.processedCount === 1, 'retry succeeds using the original source');

  // v1.23.1 失败退避：失败后 1h 内自动反思不再重试（显式工具调用仍可直接跑）
  await source('backoff', 'backoff evidence 3318', 'bk-a');
  respond = () => ({ content: '{"summary":"x","actions":[', finish_reason: 'stop' });
  r = await runAutoReflect('fixture', 30, 'backoff');
  check(!r.ok, 'failed reflection is recorded as a failure');
  let bkCond = shouldAutoReflect('fixture', 'backoff');
  check(bkCond.should === false && /退避/.test(bkCond.reason), 'auto reflection backs off after a failure: ' + JSON.stringify(bkCond));
  respond = body => json(extraction(records(body)));
  r = await runAutoReflect('fixture', 30, 'backoff');
  check(r.ok, 'an explicit retry still runs (tool call bypasses backoff)');
  bkCond = shouldAutoReflect('fixture', 'backoff');
  check(!/退避/.test(bkCond.reason), 'a successful run clears the backoff: ' + JSON.stringify(bkCond));
  await source('partial', 'first evidence', 'partial-a');
  await source('partial', 'second evidence', 'partial-b');
  respond = body => json(extraction(records(body).slice(0, 1)));
  r = await runAutoReflect('fixture', 30, 'partial');
  check(!r.ok && r.processedCount === 1 && getUnanalyzedConversations('fixture', undefined, 30, 'partial')[0].id === 'partial-b', 'partial source acknowledgement leaves tail pending');
  check(String(REFLECT_SYSTEM_PROMPT).includes('processedSourceIds'), 'reflection prompt requires processedSourceIds');
  await source('no-cursor', 'first evidence', 'nc-a');
  await source('no-cursor', 'second evidence', 'nc-b');
  respond = body => {
    const rs = records(body);
    const r = extraction(rs.slice(0, 1));
    delete r.processedSourceIds;
    return json(r);
  };
  r = await runAutoReflect('fixture', 30, 'no-cursor');
  const ncPending = getUnanalyzedConversations('fixture', undefined, 30, 'no-cursor');
  check(r.processedCount === 1 && ncPending.length === 1 && ncPending[0].id === 'nc-b', 'missing cursor advances only action-referenced sources');
  await source('no-cursor-empty', 'lonely evidence', 'nc-c');
  respond = () => json({ summary: '', actions: [], facts: [], insights: [] });
  r = await runAutoReflect('fixture', 30, 'no-cursor-empty');
  check(r.processedCount === 0 && getUnanalyzedConversations('fixture', undefined, 30, 'no-cursor-empty').length === 1, 'missing cursor with no actions does not advance');
  for (let i = 0; i < 9; i++) await saveMemory({ project: 'deep-evidence', text: long + ' deep ' + i, memType: 'feedback' });
  await source('deep-evidence', 'not consumed by deep', 'deep-log');
  respond = () => json({ summary: '', actions: [], insights: [], facts: [] });
  calls = [];
  r = await runDeepReflect('fixture', 50, 'deep-evidence');
  const deepFirst = records(calls[0]).map(r => r.id);
  check(r.processedCount === 4 && r.deferredCount === 5 && calls[0].messages[1].content.includes('关键修正'), 'deep batches preserve full evidence and report actual count');
  calls = [];
  await runDeepReflect('fixture', 50, 'deep-evidence');
  check(records(calls[0]).every(r => !deepFirst.includes(r.id)), 'next deep run rotates beyond prior batch');
  check(getUnanalyzedConversations('fixture', undefined, 50, 'deep-evidence').length === 1, 'deep scan does not consume conversation progress');
  await saveMemory({ project: 'consolidate', text: long });
  await saveMemory({ project: 'consolidate', text: 'second full evidence' });
  calls = [];
  respond = () => json({ actions: [] });
  r = await runConsolidate('fixture', 'consolidate');
  check(r.ok && calls[0].messages[1].content.includes('关键修正'), 'consolidation includes beyond 600 chars');
  // 同一输入再跑一次：不许再调 LLM（重启风暴里每次启动都重烧一遍就是 token 流失）。
  calls = [];
  respond = () => json({ actions: [] });
  r = await runConsolidate('fixture', 'consolidate');
  check(r.skipped === true && calls.length === 0, 'unchanged consolidation input makes no second LLM call: ' + JSON.stringify(r));
  // 输入变了也还有最小间隔闸门：重启风暴里每次启动都重算 = 把 token 当水放。
  await saveMemory({ project: 'consolidate', text: 'third changed evidence 3318' });
  calls = [];
  respond = () => json({ actions: [] });
  r = await runConsolidate('fixture', 'consolidate');
  check(r.skipped === true && calls.length === 0, 'changed input still respects the minimum interval: ' + JSON.stringify(r));
  calls = [];
  r = await runConsolidate('fixture', 'consolidate', undefined, undefined, { force: true });
  check(calls.length === 1, 'explicit force bypasses the interval gate');
  calls = [];
  respond = () => json({ sessionMemory: 'navigation only', promoted: [{ memType: 'project', text: long, category: 'decision' }] });
  r = await runIncrementalReflection('incremental', 'session-fixture', [{ role: 'user', content: long }], 'fixture');
  check(r.ok && r.promoted === 1 && calls[0].messages[1].content.includes('关键修正'), 'incremental receives and promotes beyond 2000 chars: ' + JSON.stringify(r));
  check(getSessionMemory('incremental', 'session-fixture') !== null, 'incremental snapshot still works');
  check(await isDuplicate('incremental', long, 'project'), 'duplicate lookup finds actual memType database');
  check(!(await isDuplicate('incremental', long.replace('3318', '3319'), 'project')), 'similar evidence with a changed port is preserved');
  check(promoteToProject('incremental', [{ memType: 'project', text: long.replace('3318', '3319') }]).length === 1, 'promotion delta gate preserves changed engineering facts');
  const caseA = await saveMemory({ project: 'incremental', memType: 'project', text: 'Path /srv/project-a; token AbC' });
  const caseB = await saveMemory({ project: 'incremental', memType: 'project', text: 'Path /srv/project-a; token abc' });
  check(caseA.id !== caseB.id, 'evidence storage preserves case-sensitive differences');
  check(!(await isDuplicate('incremental', 'Path /srv/project-a; token ABC', 'project')), 'evidence duplicate check preserves case-sensitive differences');
  respond = () => ({ ...json({ sessionMemory: 'bad replacement', promoted: [{ memType: 'project', text: 'partial' }] }), finish_reason: 'length' });
  r = await runIncrementalReflection('incremental', 'session-fixture', [{ role: 'user', content: 'truncated retry' }], 'fixture');
  check(!r.ok && getSessionMemory('incremental', 'session-fixture') === 'navigation only', 'truncated incremental output preserves snapshot');
  calls = [];
  respond = () => json({ insights: [] });
  r = await runReflectAll({ projects: ['deep-evidence'], dryRun: true });
  check(r.ok && calls.some(b => b.messages[1].content.includes('关键修正')), 'cross-library reflection includes beyond 300 chars');
  respond = () => json({ insights: [{ text: 'invented source', sources: [{ instance: 'fake', project: 'missing', id: 'no-id' }] }] });
  r = await runReflectAll({ projects: ['deep-evidence'], dryRun: true });
  check(!r.ok && r.llm.saved === 0, 'cross-library fabricated provenance is refused');
  respond = body => {
    const [record] = records(body);
    return json({ insights: [{ text: 'Full provenance record', sources: [{ instance: record.instance, project: record.project, id: record.id, memType: record.memType }] }] });
  };
  r = await runReflectAll({ projects: ['deep-evidence'], dryRun: true });
  check(r.ok && r.insightList.every(item => item.sources.every(source => source.memType && source.id)), 'cross-library structured provenance validates exact records');
  await source('collision', 'general source', 'same-id', 'general');
  await source('collision', 'project source', 'same-id', 'project');
  assert.throws(() => getUnanalyzedConversations('fixture', undefined, 30, 'collision'), /Ambiguous conversation ID/); checks++;
  const receipts = fs.readdirSync(path.join(temp, 'receipts')).map(f => JSON.parse(fs.readFileSync(path.join(temp, 'receipts', f))));
  check(receipts.every(r => r.project && r.inputIds), 'automatic receipts are bank-local and scoped');

  // v1.23.1 审查修复回归：路径穿越 / 衰减幂等 / identity_locked / facts 无唯一索引
  check(safeFilePart('..') === 'default' && safeFilePart('.') === 'default', 'dot project names cannot escape the memory directory');
  const oldTs = new Date(Date.now() - 61 * 86400000).toISOString();
  const decMem = await saveMemory({ project: 'decay-idem', text: '衰减幂等测试 3318', importance: 0.9 });
  const decDb = findDbByMemoryId(decMem.id, 'decay-idem').db;
  decDb.prepare('UPDATE memory SET last_accessed_at=?, created_at=?, base_importance=0.9, importance=0.9 WHERE id=?').run(oldTs, oldTs, decMem.id);
  await consolidate('decay-idem');
  const imp1 = decDb.prepare('SELECT importance FROM memory WHERE id=?').get(decMem.id).importance;
  await consolidate('decay-idem');
  const imp2 = decDb.prepare('SELECT importance FROM memory WHERE id=?').get(decMem.id).importance;
  check(Math.abs(imp1 - imp2) < 1e-9, `repeated consolidation does not compound decay (${imp1} vs ${imp2})`);

  const lockMem = await saveMemory({ project: 'decay-idem', text: '身份锁不参与衰减 3319', importance: 0.9 });
  findDbByMemoryId(lockMem.id, 'decay-idem').db
    .prepare('UPDATE memory SET identity_locked=1, last_accessed_at=?, created_at=?, base_importance=0.9, importance=0.9 WHERE id=?')
    .run(oldTs, oldTs, lockMem.id);
  await consolidate('decay-idem');
  const lockRow = findDbByMemoryId(lockMem.id, 'decay-idem').db.prepare('SELECT is_active, importance FROM memory WHERE id=?').get(lockMem.id);
  check(lockRow.is_active === 1 && Math.abs(lockRow.importance - 0.9) < 1e-9, 'identity-locked memories survive consolidation untouched');

  await saveFacts([{ subject: 'user', predicate: '昵称', object: '索引测试', confidence: 0.8 }], null, 'fixture', 'facts-noidx');
  DatabaseManager.getInstance('facts-noidx').exec('DROP INDEX IF EXISTS idx_facts_spo');
  await saveFacts([{ subject: 'user', predicate: '昵称', object: '索引测试', confidence: 0.95 }], null, 'fixture', 'facts-noidx');
  const noIdx = DatabaseManager.getInstance('facts-noidx').prepare("SELECT COUNT(*) n, MAX(confidence) c FROM facts WHERE predicate='昵称'").get();
  check(noIdx.n === 1 && noIdx.c === 0.95, 'saveFacts works even when the unique index is missing');

  // v1.23.2 审查修复：读路径不建库 / 联邦成员配置校验
  const ghost = 'ghost-project-' + Date.now();
  check(getRecentMemories('nobody', 5, 48, ghost).length === 0, 'recent read on unknown project returns empty');
  check((await searchMemory({ query: 'x', topK: 3, project: ghost })).length === 0, 'search on unknown project returns empty');
  check(!fs.existsSync(path.join(temp, ghost)), 'read paths do not create project directories');
  const { normalizeMember } = await load('federation/registry');
  check(normalizeMember({ id: 'web', target: 'http://127.0.0.1:3318/mcp' }).transport === 'mcp-http', 'http target infers mcp-http');
  check(normalizeMember({ id: 'typo', target: 'D:/banks/x', transport: 'nonsense' }).transport === 'local-dir', 'unknown transport falls back to target shape');

  console.log(JSON.stringify({ checks, ok: true, liveLlmCalls: 0, productionWrites: 0 }));
} finally { DatabaseManager.close(); fs.rmSync(temp, { recursive: true, force: true }); }
