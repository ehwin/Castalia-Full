/* routes/reflect.js — /api/reflect/run /api/reflect/job /api/reflect/history
 *
 * 长任务(总反思 reflect_all:全库扫描 + 每 12 条一批 LLM)不挂在 HTTP 请求上:
 * POST 立刻返回 jobId,前端轮询 /api/reflect/job/:id。见 routes/reflectJob.js 顶部说明。
 * 脚本调用方仍可传 `sync: true` 拿旧的同步行为(兜底超时也从 300s 提到 3h)。
 */
import { Router } from 'express';
import { readReflectHistory } from './lib.js';
import { startReflectJob, runReflect, getJob, listJobs, runningJob } from './reflectJob.js';

const router = Router();

// ═══ POST /api/reflect/run ═══
router.post('/reflect/run', async (req, res) => {
  const body = req.body || {};
  const mode = body.mode;

  // 参数校验先做:坏输入要 400,不能变成一个失败的任务
  if (mode === 'project') {
    const projects = Array.isArray(body.projects)
      ? body.projects.map(x => String(x)).filter(Boolean)
      : (body.projects ? [String(body.projects)] : []);
    if (projects.length === 0) {
      return res.status(400).json({ ok: false, mode, dryRun: body.dryRun === true, error: 'mode=project 时必须提供 projects 库名(如 ["hermes"])' });
    }
  } else if (mode === 'auto' || mode === 'deep') {
    const limit = parseInt(body.limit || (mode === 'deep' ? '500' : '30'), 10);
    if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
      return res.status(400).json({ ok: false, error: 'limit 必须为 1–1000' });
    }
    const project = typeof body.project === 'string' ? body.project.trim() : undefined;
    if (project && !/^[\p{L}\p{N}_.-]+$/u.test(project)) {
      return res.status(400).json({ ok: false, error: '项目名格式无效' });
    }
  } else if (mode !== 'all') {
    return res.status(400).json({ ok: false, error: '未知反思模式' });
  }

  // 同步逃生门:脚本/CI 要一次拿到结果
  if (body.sync === true) {
    const { httpStatus, payload } = await runReflect(body);
    return res.status(httpStatus).json(payload);
  }

  try {
    const job = startReflectJob(body);
    return res.status(202).json({
      ok: true, async: true, jobId: job.id, status: job.status,
      mode: job.mode, dryRun: job.dryRun, startedAt: job.startedAt,
      poll: `/api/reflect/job/${job.id}`,
      note: '反思已在后台运行(全量可能几十分钟);轮询 /api/reflect/job/<id> 取结果',
    });
  } catch (e) {
    if (e.code === 'BUSY') {
      return res.status(409).json({
        ok: false, error: e.message, jobId: e.job?.id, status: e.job?.status,
        poll: e.job?.id ? `/api/reflect/job/${e.job.id}` : undefined,
      });
    }
    return res.status(500).json({ ok: false, error: '启动反思任务失败: ' + e.message });
  }
});

// ═══ GET /api/reflect/job/:id ═══
router.get('/reflect/job/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: '没有这个反思任务(可能已被清理)' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, job });
});

// ═══ GET /api/reflect/jobs ═══
router.get('/reflect/jobs', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, jobs: listJobs(), running: runningJob() });
});

// ═══ GET /api/reflect/history ═══
router.get('/reflect/history', (req, res) => {
  const limit = parseInt(req.query.limit || '20', 10);
  res.json({ ok: true, history: readReflectHistory(limit) });
});

export default router;
