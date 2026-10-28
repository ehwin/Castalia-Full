// Regression: memory_context / memory_index / context_get must aggregate all memType DBs.
// Isolated temp directory; no production reads/writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(process.argv[2] || '.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-context-'));
const env = {
  ...process.env,
  MEMORY_DB_DIR: temp,
  MEMORY_DB_PATH: '',
  EMBED_MODE: 'none',
  CASTALIA_PROJECT: 'ctxcheck',
  CHARACTER_ID: 'ctxcheck',
  CASTALIA_BACKGROUND_TASKS: '0',
  MCP_TOOLS: 'all',   // v1.23.2 起未设置时默认只暴露 agent 组，memory_context 在 admin 组
  TRIAGE_LLM_API_KEY: '',
  REFLECT_LLM_API_KEY: '',
};
delete env.MEMORY_DB_PATH;
Object.assign(process.env, { MEMORY_DB_DIR: temp, EMBED_MODE: 'none' });

const load = (name) => import(pathToFileURL(path.join(root, 'dist', name + '.js')).href);
const { saveMemory } = await load('store');
await saveMemory({ text: '回答要简洁,先给结论', project: 'ctxcheck', memType: 'user', type: 'preference', importance: 0.9, scorePriority: 0.8 });
await saveMemory({ text: '端口约定 3318,不要改', project: 'ctxcheck', memType: 'project', importance: 0.7 });
await saveMemory({ text: '普通记忆一条', project: 'ctxcheck', memType: 'general', importance: 0.3 });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist', 'index.js')],
  env,
  stderr: 'pipe',
});
const client = new Client({ name: 'context-regression', version: '1.0.0' });
const checks = [];
const check = (ok, msg) => { assert.ok(ok, msg); checks.push(msg); };
try {
  await client.connect(transport, { timeout: 20000 });
  const parse = (r) => JSON.parse(r.content[0].text);

  const ctx = parse(await client.callTool({ name: 'memory_context', arguments: { project: 'ctxcheck', asText: false } }, undefined, { timeout: 30000 }));
  check(ctx.stats.total === 3, 'context total counts all 3 memType DBs');
  check(Array.isArray(ctx.index) && ctx.index.some(x => x.memType === 'user') && ctx.index.some(x => x.memType === 'project'), 'context index layer contains user+project');
  const hasPrefSection = String(ctx.prompt).includes('用户偏好');
  check(!hasPrefSection || String(ctx.prompt).includes('回答要简洁'), 'context preference section (if present) contains the preference');

  const idx = parse(await client.callTool({ name: 'memory_index', arguments: { project: 'ctxcheck' } }, undefined, { timeout: 20000 }));
  const types = new Set(idx.results.map(r => r.memType));
  check(idx.count >= 3 && types.has('user') && types.has('project') && types.has('general'), 'memory_index spans all memType DBs');

  const cg = parse(await client.callTool({ name: 'context_get', arguments: { project: 'ctxcheck' } }, undefined, { timeout: 20000 }));
  check(cg.stats.total === 3, 'context_get total counts all 3 memType DBs');

  console.log(JSON.stringify({ ok: true, checks: checks.length, total: ctx.stats.total, index: ctx.index.length, indexTypes: [...types] }));
} finally {
  try { await client.close(); } catch {}
  // Windows: the parent process still holds sqlite WAL handles, so removal may fail; temp dir is harmless.
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
}
