/* routes/config.js — /api/config GET/POST */
import { Router } from 'express';
import {
  loadConfig, saveConfig, CONFIG_PATH,
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
    emb: [e.mode, e.ollama_url, e.model, e.api_url, e.api_model],
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
    const applyTo = String(req.body.applyTo || 'local').toLowerCase();
    const incoming = { ...req.body };
    delete incoming.applyTo;
    if (applyTo === 'all' || applyTo === 'federation' || applyTo === 'fed') {
      const saved = [];
      for (const it of loadAllInstanceConfigs()) {
        const next = mergePreserveKeys(it.config, incoming);
        saveConfigToDir(it.dir, next);
        saved.push({ name: it.name, path: it.path });
      }
      res.json({ ok: true, saved, note: '已写入全部 MCP 记忆体。重启各端 MCP 后生效' });
      return;
    }
    const cur = loadConfig();
    const next = mergePreserveKeys(cur, incoming);
    saveConfig(next);
    res.json({ ok: true, path: CONFIG_PATH, note: '已保存当前实例。重启 MCP 后生效' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
