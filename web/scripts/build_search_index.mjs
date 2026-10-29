/**
 * 统一检索索引 —— 把 90 个库(5 个 bank)汇编成**一个** sqlite:
 *   docs(id, instance, project, mem_type, text, created_at, importance)
 *   docs_fts(text_bi, tags_bi)  ← unicode61 + 预切 CJK bigram(没有原生 bigram 分词器时的标准做法)
 *   docs_vec(embedding float[1024]) ← 直接从各库 vec_memory 拷二进制,不重新调 API
 *
 * 为什么必须合并(这是实测出来的,不是抄架构):
 *  1) BM25 的 idf 是**每个库自己算**的。90 个库各 40~600 条,"掉档"这种词在一个库里可能 df=1
 *     → idf 极高,在另一个库里 df=30 → idf 极低。两者分数不可比,合并排序就成了掷骰子。
 *  2) RRF 也救不了:它只信名次,而"每库 top8 的第 3 名"和"另一库的第 1 名"没有共同尺度
 *     (实测 RRF 在这个语料上 recall 从 5/11 掉到 1/13)。
 *  3) 90 次 fan-out 每条查询固定 ~400ms 开销,合并后是一次 KNN + 一次 MATCH。
 *
 * 用法:CastaliaNode.exe build_search_index.mjs [--force]
 */
import D from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';

/** bank 根:env 优先;否则按 新部署根(D:/castalia) → 旧仓根 的顺序取第一个存在的 */
function defaultBankRoot() {
  for (const c of (process.env.CASTALIA_BANK_ROOT && [process.env.CASTALIA_BANK_ROOT]) || ['D:/castalia/memory-banks', 'D:/AI/castalia/memory-banks', 'D:/system/AIRI/castalia/memory-banks']) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'D:/castalia/memory-banks';
}
const ROOT = defaultBankRoot();
const OUT = process.env.SEARCH_INDEX_FILE || path.join(ROOT, '.search-index.sqlite');
const BANKS = ['hermes', 'dsh', 'lobehub', 'airi', 'full'];
const FORCE = process.argv.includes('--force');

/** CJK 段切 bigram,ASCII 段原样保留 → 空格分隔的"伪分词"文本,给 unicode61 建 BM25 索引 */
function toBigramText(s) {
  const out = [];
  for (const seg of String(s || '').split(/[\s\u3000]+/)) {
    if (!seg) continue;
    if (!/[\u4e00-\u9fff]/.test(seg)) { out.push(seg.toLowerCase()); continue; }
    // 中英混排:先把 ASCII 片段摘出来,剩下的 CJK 连续段切 bigram
    for (const m of seg.matchAll(/[A-Za-z0-9_.\-/]+|[\u4e00-\u9fff]+|[^\s]/g)) {
      const t = m[0];
      if (/^[A-Za-z0-9_.\-/]+$/.test(t)) out.push(t.toLowerCase());
      else if (/^[\u4e00-\u9fff]+$/.test(t)) {
        if (t.length === 1) out.push(t);
        for (let i = 0; i + 2 <= t.length; i++) out.push(t.slice(i, i + 2));
      }
    }
  }
  return out.join(' ');
}

function listLibs() {
  const out = [];
  for (const b of BANKS) {
    const bd = path.join(ROOT, b);
    if (!fs.existsSync(bd)) continue;
    for (const p of fs.readdirSync(bd)) {
      const pd = path.join(bd, p);
      if (!fs.statSync(pd).isDirectory() || p.startsWith('_')) continue;
      for (const mt of fs.readdirSync(pd)) {
        const f = path.join(pd, mt, 'memory.sqlite');
        if (fs.existsSync(f)) out.push({ instance: b, project: p, memType: mt, file: f });
      }
    }
  }
  return out;
}

const libs = listLibs();
const libKey = l => `${l.instance}/${l.project}/${l.mtSafe = l.memType}`;
const stat = f => { try { return fs.statSync(f); } catch { return null; } };

// --force:清空重建。**不能删文件** —— web 进程常驻持有只读句柄,rm 会 EPERM;
// 在库内 DELETE 一样是干净的,而且和并发读者兼容(WAL)。
if (FORCE && fs.existsSync(OUT)) {
  const fdb = new D(OUT);
  try { sqliteVec.load(fdb); } catch { /* ignore */ }
  fdb.exec('DELETE FROM docs_vec; DELETE FROM docs_fts; DELETE FROM docs; DELETE FROM sources;');
  fdb.close();
}
const db = new D(OUT);
sqliteVec.load(db);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS docs (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL, instance TEXT, project TEXT, mem_type TEXT,
    text TEXT NOT NULL, created_at TEXT, importance REAL, sha TEXT
  );
  DROP INDEX IF EXISTS idx_docs_id;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_lib_id ON docs(instance, project, mem_type, id);
  CREATE INDEX IF NOT EXISTS idx_docs_lib ON docs(instance, project, mem_type);
  CREATE TABLE IF NOT EXISTS sources (
    key TEXT PRIMARY KEY, file TEXT, mtime REAL, rows INTEGER, synced_at TEXT
  );
`);
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(text_bi, tokenize='unicode61')`);
try { db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS docs_vec USING vec0(embedding float[1024])'); }
catch (e) { console.log('vec0 表已存在或维度不同:', e.message.slice(0, 60)); }

const synced = new Map(db.prepare('SELECT key, mtime, rows FROM sources').all().map(r => [r.key, r]));
let scanned = 0, inserted = 0, updated = 0, kept = 0, noVec = 0;
const t0 = Date.now();

db.exec('BEGIN');
try {
  const delDocs = db.prepare('DELETE FROM docs WHERE instance=? AND project=? AND mem_type=?');
  const delVecByRow = db.prepare('DELETE FROM docs_vec WHERE rowid=?');
  const insDoc = db.prepare('INSERT INTO docs (id, instance, project, mem_type, text, created_at, importance, sha) VALUES (?,?,?,?,?,?,?,?)');
  const insFts = db.prepare('INSERT INTO docs_fts (rowid, text_bi) VALUES (?, ?)');
  const insVec = db.prepare('INSERT INTO docs_vec (rowid, embedding) VALUES (?, ?)');
  const updSrc = db.prepare('INSERT OR REPLACE INTO sources (key, file, mtime, rows, synced_at) VALUES (?,?,?,?,?)');

  for (const l of libs) {
    const st = stat(l.file);
    if (!st) continue;
    scanned++;
    const key = libKey(l);
    const prev = synced.get(key);
    let count = 0;
    try {
      const s = new D(l.file, { readonly: true });
      count = s.prepare('SELECT count(*) n FROM memory WHERE is_active=1').get().n;
      if (prev && Math.abs(prev.mtime - st.mtimeMs) < 1 && prev.rows === count) { kept++; s.close(); continue; }

      const rows = s.prepare(`SELECT rowid, id, text, created_at, importance FROM memory
        WHERE is_active=1 AND COALESCE(status,'') <> 'superseded'`).all();
      // 向量直接从源库 vec_memory 拷 float32 blob(4096B = 1024 维),不重新调 API
      const vecRows = new Map();
      try {
        sqliteVec.load(s);
        for (const v of s.prepare('SELECT rowid rid, embedding FROM vec_memory').all()) vecRows.set(v.rid, v.embedding);
      } catch { /* 无 vec0 或维度不同 → 这些行只进词法索引 */ }

      db.exec('SAVEPOINT lib');
      const oldRows = db.prepare('SELECT rowid FROM docs WHERE instance=? AND project=? AND mem_type=?').all(l.instance, l.project, l.memType);
      for (const r of oldRows) delVecByRow.run(r.rowid);
      delDocs.run(l.instance, l.project, l.memType);

      for (const r of rows) {
        const info = insDoc.run(String(r.id), l.instance, l.project, l.memType, String(r.text ?? ''), r.created_at ? String(r.created_at) : null, Number.isFinite(Number(r.importance)) ? Number(r.importance) : null, null);
        const rid = Number(info.lastInsertRowid);
        insFts.run(rid, toBigramText(String(r.text ?? '')));
        inserted++;
        // 向量:从源库 vec_memory 按 rowid 拷 float32(不调 API)
        let blob = vecRows.get(r.rowid);
        if (!blob) {
          try {
            const v = s.prepare('SELECT embedding FROM vec_memory WHERE rowid=?').get(r.rowid);
            blob = v?.embedding;
          } catch { blob = null; }
        }
        if (blob) {
          // vec0 不接受把 rowid 当参数绑定(better-sqlite3 传进去会被当成非整数),
          // 只能用整型字面量;rid 来自 lastInsertRowid,强校验后再拼。
          if (Number.isSafeInteger(rid)) db.prepare(`INSERT INTO docs_vec (rowid, embedding) VALUES (${rid}, ?)`).run(blob);
          else noVec++;
        } else noVec++;
      }
      updSrc.run(key, l.file, st.mtimeMs, count, new Date().toISOString());
      db.exec('RELEASE lib');
      s.close();
    } catch (e) {
      try { db.exec('ROLLBACK TO lib'); db.exec('RELEASE lib'); } catch { /* savepoint 可能已释放 */ }
      console.log('库处理失败', key, e.message.slice(0, 80));
    }
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

const total = db.prepare('SELECT count(*) n FROM docs').get().n;
const vecs = db.prepare('SELECT count(*) n FROM docs_vec').get().n;
console.log(JSON.stringify({ libs: scanned, kept, inserted, total, vecs, noVec, seconds: +((Date.now() - t0) / 1000).toFixed(1), file: OUT }));
db.close();
