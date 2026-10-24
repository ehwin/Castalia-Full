/**
 * 真实 LLM 验证整合修复（只跑副本库，不碰线上）：
 *  - 系统提示词应为"整合"而非"保真提取"
 *  - evidence 策略下 merge 能真正落地（此前被整段拒绝）
 *  - extract 不再被当作整合动作
 */
import path from 'node:path';
import fs from 'node:fs';

const bank = process.argv[2];
if (!bank) { console.error('need bank dir'); process.exit(2); }
process.env.MEMORY_DB_DIR = bank;
process.env.MEMORY_CONFIG = path.join(bank, 'config.json');
process.env.CASTALIA_KEYS_FILE = path.join(bank, 'keys.enc');
process.env.CASTALIA_KEY_FILE = path.join(bank, 'keys.key');
process.env.CASTALIA_PROJECT = 'lobehub';
process.env.CHAR_ID = 'lobehub';
process.env.CONSOLIDATE_AUTO_ON_START = '0';
process.env.REFLECT_MIN_GAP_HOURS = '0';

const load = async (n) => import(new URL('../dist/' + n + '.js', import.meta.url).href);
await load('configLoader');   // 先加载配置/解密 keys.enc（服务端 index.ts 也是这个顺序）
const { runConsolidate } = await load('reflectDriver');
const { DatabaseManager } = await load('db');
console.log('reflect_key_set=', !!process.env.REFLECT_LLM_API_KEY, 'model=', process.env.REFLECT_LLM_MODEL);

console.log('bank=', bank);
const started = Date.now();
const r = await runConsolidate('lobehub', 'lobehub', undefined, undefined, { force: true });
console.log('result=', JSON.stringify(r, null, 1));
console.log('elapsed_ms=', Date.now() - started);

// 落地检查
const db = DatabaseManager.getInstance('lobehub');
const mergedRows = db.prepare("SELECT id, substr(text,1,60) t, created_at FROM memory WHERE source='reflect_merge' ORDER BY created_at DESC LIMIT 5").all();
console.log('reflect_merge rows=', JSON.stringify(mergedRows, null, 1));
const counts = db.prepare("SELECT source, COUNT(*) c FROM memory WHERE is_active=1 GROUP BY source ORDER BY c DESC").all();
console.log('active by source=', JSON.stringify(counts));
const statePath = path.join(bank, 'consolidate-state-lobehub.json');
console.log('state=', fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '(none)');
