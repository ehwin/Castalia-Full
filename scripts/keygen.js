#!/usr/bin/env node
/**
 * keygen.js — generate/update Castalia encrypted API-key store (zero dependency)
 *
 * 将三通道 API key 用 AES-256-GCM 加密写入 <cwd>/memory/keys.enc,
 * 密钥存 <cwd>/memory/keys.key(32 字节 hex)。启动时 configLoader 自动解密并注入环境变量。
 *
 * 用法:
 *   node scripts/keygen.js            交互式(env/config.json 有值则预填,空回车跳过)
 *   node scripts/keygen.js --no-input 不交互,仅取 env + memory/config.json 已有值
 *   node scripts/keygen.js --new-key  强制生成新密钥(旧 keys.enc 需重新生成)
 *
 * 取值优先级:显式环境变量 > memory/config.json > 交互输入
 *   通道      环境变量                config.json 字段
 *   reflect   REFLECT_LLM_API_KEY    reflect.api_key
 *   triage    TRIAGE_LLM_API_KEY     triage.api_key
 *   embedding EMBEDDING_API_KEY      embedding.api_key
 *
 * 路径可用环境变量覆盖:
 *   CASTALIA_KEYS_FILE / CASTALIA_KEY_FILE(与 configLoader 保持一致)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

const ROOT = process.cwd();
const keysFile = process.env.CASTALIA_KEYS_FILE || path.join(ROOT, 'memory', 'keys.enc');
const keyFile = process.env.CASTALIA_KEY_FILE || path.join(ROOT, 'memory', 'keys.key');

const forceNewKey = process.argv.includes('--new-key');
const noInput = process.argv.includes('--no-input');

const CHANNELS = [
  { name: 'reflect', env: 'REFLECT_LLM_API_KEY', cfgPath: ['reflect', 'api_key'] },
  { name: 'triage', env: 'TRIAGE_LLM_API_KEY', cfgPath: ['triage', 'api_key'] },
  { name: 'embedding', env: 'EMBEDDING_API_KEY', cfgPath: ['embedding', 'api_key'] },
];

function loadOrCreateKey() {
  if (!forceNewKey && fs.existsSync(keyFile)) {
    const buf = Buffer.from(fs.readFileSync(keyFile, 'utf-8').trim(), 'hex');
    if (buf.length === 32) {
      console.log(`[keygen] using existing key ${keyFile}`);
      return buf;
    }
    console.warn(`[keygen] ${keyFile} is not a valid 32-byte key — regenerating`);
  }
  const buf = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, buf.toString('hex') + '\n');
  try { fs.chmodSync(keyFile, 0o600); } catch { /* Windows 无 posix 权限 */ }
  console.log(`[keygen] generated new key ${keyFile}`);
  return buf;
}

function readConfigJson() {
  const p = process.env.MEMORY_CONFIG || path.join(ROOT, 'memory', 'config.json');
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.warn(`[keygen] config.json read failed: ${e.message}`);
  }
  return {};
}

function ask(rl, question, def) {
  const suffix = def ? ` (默认: ${def})` : '';
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (ans) => {
      resolve(ans.trim() || def || '');
    });
  });
}

async function collectSecrets(cfg) {
  const secrets = {};
  const rl = noInput ? null : readline.createInterface({ input: process.stdin, output: process.stdout });

  for (const ch of CHANNELS) {
    const fromEnv = (process.env[ch.env] || '').trim();
    const fromCfg = (cfg[ch.cfgPath[0]]?.[ch.cfgPath[1]] || '').trim();
    let val = fromEnv || fromCfg || '';
    if (rl) {
      const hint = `env:${fromEnv ? 'set' : 'no'} cfg:${fromCfg ? 'set' : 'no'}`;
      val = await ask(rl, `${ch.name}.api_key [${hint}]`, val);
    }
    if (val.trim()) secrets[ch.name] = { api_key: val.trim() };
  }
  if (rl) rl.close();
  return secrets;
}

async function main() {
  const key = loadOrCreateKey();
  const secrets = await collectSecrets(readConfigJson());

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(secrets), 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const payload = JSON.stringify(
    { iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') },
    null,
    2,
  );

  fs.mkdirSync(path.dirname(keysFile), { recursive: true });
  fs.writeFileSync(keysFile, payload + '\n');
  try { fs.chmodSync(keysFile, 0o600); } catch { /* Windows 无 posix 权限 */ }

  const chans = Object.keys(secrets);
  console.log(`[keygen] wrote ${keysFile} (channels: ${chans.join(', ') || 'none'})`);
  if (!chans.length) {
    console.warn('[keygen] no api keys provided — keys.enc is empty; re-run to add them');
  } else {
    console.log('[keygen] done. configLoader decrypts and injects on startup (explicit env vars still win).');
  }
}

main().catch((e) => {
  console.error('[keygen] failed:', e.message);
  process.exit(1);
});
