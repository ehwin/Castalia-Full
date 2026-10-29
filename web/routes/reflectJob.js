/* routes/reflectJob.js — 反思任务的执行体 + 后台任务表
 *
 * 为什么需要这一层:
 * reflect_all 是「逐库全量扫描 → 每 12 条一批 → 每批一次 LLM 调用」(reflectAll.ts:294)。
 * 2026-10-29 实测:85 个库 / 2395 条活跃记忆 ≈ 200 批,单批 13~45s(中位 ~25s),
 * 全量一轮 1~1.5 小时。把这样的工作挂在一个 HTTP 请求上,任何固定超时都会在
 * **正常工作**时报「反思失败」——旧实现是 300s(web/routes/reflect.js),
 * 于是 2026-10-29 12:51 / 12:58 两次全量反思都以
 * `反思调用失败: MCP 调用超时(300s)` 记录失败(reflect_history.jsonl)。
 *
 * 所以接口改成:立刻返回 jobId,任务在后台跑,页面轮询 /api/reflect/job/:id。
 * 超时只作为兜底(默认 3 小时,REFLECT_JOB_TIMEOUT_MS 可覆盖),不再等于「失败」判据。
 */
import { mcpCall, appendReflectHistory, historyEntry } from './lib.js';

const jobs = new Map();
const MAX_JOBS = 20;
const MAX_BYTES_PER_BATCH_NOTE = 0; // 预留:进度上报接口(引擎当前不回传进度)

export const JOB_TIMEOUT_MS = (() => {
  const n = Number(process.env.REFLECT_JOB_TIMEOUT_MS);
  return Number.isFinite(n) && n > 60000 ? n : 3 * 3600 * 1000;
})();

function trimJobs() {
  while (jobs.size > MAX_JOBS) {
    const idle = [...jobs.values()].find(j => j.status !== 'running');
    if (!idle) break;
    jobs.delete(idle.id);
  }
}

/** 对外可见的任务视图(不回显 body) */
function view(job) {
  return {
    id: job.id, mode: job.mode, dryRun: job.dryRun,
    status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt,
    elapsedMs: job.elapsedMs, ok: job.ok, error: job.error,
    result: job.result,
  };
}

function elapsedSec(job) {
  return Math.round(((job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.startedAt)) / 1000);
}

/** mode='all'|'project' 的总反思(逻辑与旧 handleReflectAll 一致,行为不变,只是不再绑 HTTP 超时) */
async function runReflectAll(body) {
  const mode = body.mode === 'project' ? 'project' : 'all';
  const dryRun = body.dryRun === true;
  const projects = Array.isArray(body.projects)
    ? body.projects.map(x => String(x)).filter(Boolean)
    : (body.projects ? [String(body.projects)] : []);

  const args = { dryRun };
  if (mode === 'project') args.projects = projects;
  if (Number.isFinite(Number(body.maxTotal)) && Number(body.maxTotal) > 0) args.maxTotal = Number(body.maxTotal);
  if (Number.isFinite(Number(body.maxPerLib)) && Number(body.maxPerLib) > 0) args.maxPerLib = Number(body.maxPerLib);
  // 增量反思:默认只跑「没被上一轮覆盖过」的记录;all=true 是全量重扫(贵)
  if (body.all === true) args.all = true;
  if (Number.isFinite(Number(body.batchRecords)) && Number(body.batchRecords) > 0) args.batchRecords = Number(body.batchRecords);
  if (Number.isFinite(Number(body.contextPerProject)) && Number(body.contextPerProject) >= 0) args.contextPerProject = Number(body.contextPerProject);

  const base = {
    ok: false, mode, dryRun,
    scanned: { libraries: 0, memories: 0 },
    llm: { insights: 0, skipped: 0, saved: 0 },
    errors: [], insightList: [],
  };

  try {
    const result = await mcpCall('reflect_all', args, JOB_TIMEOUT_MS);
    const text = (result?.content || []).map(c => c.text || '').join('');
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object') {
      const out = { ...base, errors: ['reflect_all 返回无法解析的结果: ' + text.slice(0, 300)] };
      appendReflectHistory(historyEntry(out, projects));
      return { httpStatus: 502, payload: out };
    }
    const out = {
      ok: parsed.ok === true,
      mode, dryRun,
      scanned: parsed.scanned || { libraries: 0, memories: 0 },
      coverage: parsed.coverage,
      llm: parsed.llm || { insights: 0, skipped: 0, saved: 0 },
      usage: parsed.usage,
      skipReason: parsed.skipReason,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      insightList: Array.isArray(parsed.insightList) ? parsed.insightList : [],
    };
    if (!out.ok && parsed.error?.message) out.errors = [parsed.error.message, ...out.errors];
    if (!out.ok && out.errors.length === 0) out.errors = ['reflect_all 执行失败(无详细错误)'];
    appendReflectHistory(historyEntry(out, projects));
    return { httpStatus: 200, payload: out };
  } catch (e) {
    const out = { ...base, errors: ['反思调用失败: ' + e.message] };
    appendReflectHistory(historyEntry(out, projects));
    return { httpStatus: 502, payload: out };
  }
}

/** mode='auto'|'deep' 的单库反思(旧路由逻辑) */
async function runReflectSingle(body) {
  const mode = body.mode;
  const toolName = mode === 'deep' ? 'reflect_deep' : 'reflect_auto';
  const limit = parseInt(body.limit || (toolName === 'reflect_deep' ? '500' : '30'), 10);
  const project = typeof body.project === 'string' ? body.project.trim() : undefined;
  try {
    const result = await mcpCall(toolName, { limit, ...(project ? { project } : {}) }, JOB_TIMEOUT_MS);
    const text = result?.content?.[0]?.text || '{}';
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { httpStatus: 200, payload: parsed };
  } catch (e) {
    return { httpStatus: 502, payload: { error: '反思调用失败: ' + e.message } };
  }
}

/** 同步执行一次反思(给 `sync: true` 的脚本调用方 / 后台任务共用) */
export async function runReflect(body) {
  return body.mode === 'all' || body.mode === 'project'
    ? runReflectAll(body)
    : runReflectSingle(body);
}

/**
 * 起一个后台反思任务。已有任务在跑时抛 code='BUSY'(带 job 视图),由路由转 409。
 * 返回任务视图;结果通过 getJob(id) 轮询。
 */
export function startReflectJob(body) {
  const running = [...jobs.values()].find(j => j.status === 'running');
  if (running) {
    const err = new Error(`已有反思任务在运行(${running.mode},已 ${elapsedSec(running)}s)`);
    err.code = 'BUSY';
    err.job = view(running);
    throw err;
  }
  const id = 'rj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const job = {
    id, mode: body.mode, dryRun: body.dryRun === true,
    status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
    elapsedMs: null, ok: null, error: null, result: null,
  };
  jobs.set(id, job);
  trimJobs();

  runReflect(body)
    .then(({ httpStatus, payload }) => {
      job.httpStatus = httpStatus;
      job.result = payload;
      job.ok = payload?.ok === true;
      job.status = 'done';
    })
    .catch(e => {
      job.status = 'error';
      job.error = e.message;
      job.ok = false;
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      job.elapsedMs = Date.parse(job.finishedAt) - Date.parse(job.startedAt);
      trimJobs();
    });

  return view(job);
}

export function getJob(id) {
  const job = jobs.get(String(id || ''));
  return job ? view(job) : null;
}

export function listJobs() {
  return [...jobs.values()].map(view).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export function runningJob() {
  const job = [...jobs.values()].find(j => j.status === 'running');
  return job ? view(job) : null;
}
