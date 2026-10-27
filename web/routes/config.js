/* routes/config.js — /api/config GET/POST */
import { Router } from 'express';
import {
  loadConfig, saveConfig, CONFIG_PATH,
  rawConfig, rawConfigInDir, effectiveVecDim, effectiveVecDimInDir, withoutImplicitDim,
  loadAllInstanceConfigs, saveConfigToDir, mergePreserveKeys,
} from './lib.js';

const router = Router();

function maskKeys(cfg) {
  const safe = JSON.parse(JSON.stringify(cfg));
  if (safe.embedding?.api_key) safe.embedding.api_key = '****';
  if (safe.reflect?.api_key) safe.reflect.api_key = '****';
  if (safe.triage?.api_key) safe.triage.api_key = '****';
  return safe;
}

function fingerprint(cfg) {
  const e = cfg.embedding || {}, r = cfg.reflect || {}, t = cfg.triage || {}, c = cfg.consolidate || {};
  return JSON.stringify({
    emb: [e.mode, e.ollama_url, e.model, e.api_url, e.api_model, e.dim],
    ref: [r.mode, r.llm_url, r.model, r.factExtraction, r.maxFacts, r.minGapHours, r.minUnanalyzed, r.intervalHours],
    tri: [t.mode, t.llm_url, t.model, t.bufferSize, t.bufferTokens, t.sessionTtlDays],
    cons: [c.minMemories, c.similarity, c.autoOnStart],
  });
}

router.get('/config', (req, res) => {
  const scope = String(req.query.scope || 'local').toLowerCase();
  if (scope === 'all' || scope === 'federation' || scope === 'fed') {
    const instances = loadAllInstanceConfigs().map((it) => ({
      name: it.name,
      dir: it.dir,
      path: it.path,
      exists: it.exists,
      config: maskKeys(it.config),
    }));
    const fps = instances.map((it) => fingerprint(it.config));
    const inSync = fps.length <= 1 || fps.every((f) => f === fps[0]);
    res.json({
      instances,
      inSync,
      config: instances[0] ? instances[0].config : maskKeys(loadConfig()),
    });
    return;
  }
  res.json(maskKeys(loadConfig()));
});

router.post('/config', (req, res) => {
  try {
    // 2026-10-27 修复(P2-1,复核提出):维度要在服务端校验。负数/超大/非数字会被
    // 引擎当成"显式维度"(vecDimIsExplicit 只看 env 是否非空)再静默降到 1024 并清缓存。
    const dimIn = req.body?.embedding?.dim;
    if (dimIn != null && dimIn !== '') {
      const n = Number(dimIn);
      if (!Number.isInteger(n) || n < 1 || n > 65536) {
        res.status(400).json({ error: `embedding.dim 必须是 1..65536 的整数(收到 ${JSON.stringify(dimIn)})` });
        return;
      }
    }
    const applyTo = String(req.body.applyTo || 'local').toLowerCase();
    const incoming = { ...req.body };
    delete incoming.applyTo;
    if (applyTo === 'all' || applyTo === 'federation' || applyTo === 'fed') {
      const saved = [];
      // 2026-10-27 修复(P1-1,复核提出):判"用户是否真改了维度"要用**表单可能展示过的
      // 生效维度集合**(本地 + 所有同级实例),不能只看各实例自己的维度。否则 A=4096、
      // B 文件里没有 dim 时,从 A 回显来的 4096 会被误判成用户改动并写进 B,
      // B 下次开库就 DROP vec 表 + 清空 embedding_cache。
      const instances = loadAllInstanceConfigs();
      const formDims = new Set([effectiveVecDim(), ...instances.map((it) => effectiveVecDimInDir(it.dir))]);
      for (const it of instances) {
        const instRaw = rawConfigInDir(it.dir);
        const instDim = effectiveVecDimInDir(it.dir);
        const next = mergePreserveKeys(
          withoutImplicitDim(it.config, instRaw, false, instDim),
          withoutImplicitDim(incoming, instRaw, true, instDim, formDims),
        );
        saveConfigToDir(it.dir, next);
        saved.push({ name: it.name, path: it.path });
      }
      res.json({ ok: true, saved, note: '已写入全部 MCP 记忆体。重启各端 MCP 后生效' });
      return;
    }
    const cur = loadConfig();
    const raw = rawConfig();
    // 2026-10-27 修复(E2):同上 —— 归一化会把默认/环境派生的 dim 物化进 cur 与 payload,
    // 照单落盘会让引擎在下次启动时 DROP vec 表 + 清空 embedding_cache(4096 维库被静默降维)。
    const next = mergePreserveKeys(
      withoutImplicitDim(cur, raw, false),
      withoutImplicitDim(incoming, raw, true),
    );
    saveConfig(next);
    res.json({ ok: true, path: CONFIG_PATH, note: '已保存当前实例。重启 MCP 后生效' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
