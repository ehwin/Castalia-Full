/**
 * Config Loader — 启动时读取 config.json 覆盖环境变量
 *
 * 供 web 管理界面持久化配置:嵌入模型(Ollama/API 两种模式)+ 反思 LLM。
 * 配置文件路径:环境变量 MEMORY_CONFIG 或 ./config.json(与 web/server.mjs 共享)
 *
 * 必须在 index.ts 的 import 中放在最前面(确保在 ollama.ts/reflectDriver.ts 读取 env 之前生效)。
 */
import fs from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = process.env.MEMORY_CONFIG
  || path.join(process.cwd(), 'config.json');

try {
  if (fs.existsSync(CONFIG_PATH)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

    // 嵌入模型配置
    const emb = cfg.embedding || {};
    if (emb.mode === 'api') {
      if (emb.api_url) process.env.OLLAMA_URL = emb.api_url.replace(/\/+$/, '');
      if (emb.api_model) process.env.EMBEDDING_MODEL = emb.api_model;
      if (emb.api_key) process.env.EMBEDDING_API_KEY = emb.api_key;
    } else {
      // 默认 Ollama 模式
      if (emb.ollama_url) process.env.OLLAMA_URL = emb.ollama_url.replace(/\/+$/, '');
      if (emb.model) process.env.EMBEDDING_MODEL = emb.model;
    }

    // 反思 LLM 配置
    const ref = cfg.reflect || {};
    if (ref.llm_url) process.env.REFLECT_LLM_URL = ref.llm_url.replace(/\/+$/, '');
    if (ref.api_key) process.env.REFLECT_LLM_API_KEY = ref.api_key;
    if (ref.model) process.env.REFLECT_LLM_MODEL = ref.model;

    console.error(`[config] loaded ${CONFIG_PATH} (embed=${emb.mode || 'ollama'}, reflect=${ref.model || 'unset'})`);
  }
} catch (e: any) {
  console.error('[config] load failed:', e.message);
}
