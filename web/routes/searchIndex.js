/* routes/searchIndex.js —— 统一检索索引的读取层(供 aggregate.js 使用)
 *
 * 为什么单独一个模块:90 个库 fan-out 时每次查询都要开 90 个连接、各自算 BM25(每个库的 idf 只基于自己那
 * 40~600 条,分数彼此不可比);合并成一个 sqlite 后,BM25 有全局语料、KNN 只有一张表,分数才有共同尺度。
 * 实测:检索 432ms → 26ms,MRR 0.32 → 0.41(见 bench_v4)。
 *
 * 索引文件由 scripts/build_search_index.mjs 生成,增量同步(mtime+行数),空跑 0.1s。
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { existsSync, statSync } from 'fs';
import { execFile } from 'child_process';
import path from 'path';
import { getAggregateDirs } from './lib.js';

/** 索引文件位置:显式 env > 各 member bank 的共同父目录(memory-banks)/.search-index.sqlite > 兜底
 *  不能写死 D:/AI —— 这台机器同时有 D:/system/AIRI 那套平行栈,写死会让那边必然退回 fan-out。 */
function resolveIndexFile() {
  if (process.env.SEARCH_INDEX_FILE) return process.env.SEARCH_INDEX_FILE;
  try {
    const parents = [...new Set(getAggregateDirs().map(d => path.dirname(path.resolve(d.dir))))];
    if (parents.length === 1) return path.join(parents[0], '.search-index.sqlite');
    const marker = parents.find(p => /memory-banks$/i.test(p));
    if (marker) return path.join(marker, '.search-index.sqlite');
  } catch { /* ignore */ }
  return path.join(process.env.CASTALIA_BANK_ROOT || 'D:/AI/castalia/memory-banks', '.search-index.sqlite');
}

let INDEX_FILE = resolveIndexFile();
const BUILDER = process.env.SEARCH_INDEX_BUILDER
  || path.resolve(process.cwd(), 'scripts/build_search_index.mjs');
const NODE = process.env.NODE_BIN || process.execPath;

let _db = null;
let _builderRunning = false;

export function openIndex() {
  INDEX_FILE = resolveIndexFile();
  if (!existsSync(INDEX_FILE)) return null;
  if (_db) {
    try { _db.prepare('SELECT 1').get(); return _db; } catch { try { _db.close(); } catch {} _db = null; }
  }
  try {
    const db = new Database(INDEX_FILE, { readonly: true });
    if (!db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='docs_fts'").get().n) { db.close(); return null; }
    try { sqliteVec.load(db); } catch { /* 没扩展 → 只有词法 */ }
    try { db.pragma('busy_timeout = 3000'); } catch {}
    _db = db;
    return db;
  } catch { return null; }
}

/** 后台增量刷新:索引过期(mtime 落后于最近写入)时异步跑一次,不阻塞本次查询 */
export function refreshIndexAsync() {
  if (_builderRunning) return;
  if (!existsSync(BUILDER)) return;
  _builderRunning = true;
  execFile(NODE, [BUILDER], { cwd: path.dirname(path.dirname(BUILDER)), timeout: 120000 }, (err) => {
    _builderRunning = false;
    if (err) console.error('[search-index] 刷新失败:', String(err.message).slice(0, 200));
  });
}

/** 索引超过 STALE_SEC 秒没更新就后台重建一次(空跑 0.1s,全量 0.7s),不阻塞本次查询 */
export function refreshIfStale(staleSec = 120) {
  try {
    INDEX_FILE = resolveIndexFile();
    if (!existsSync(INDEX_FILE)) return;
    const age = (Date.now() - statSync(INDEX_FILE).mtimeMs) / 1000;
    if (age > staleSec) refreshIndexAsync();
  } catch { /* ignore */ }
}

export function indexStats() {
  const db = openIndex();
  if (!db) return { available: false, file: INDEX_FILE };
  try {
    const docs = db.prepare('SELECT count(*) n FROM docs').get().n;
    const vecs = db.prepare('SELECT count(*) n FROM docs_vec').get().n;
    const mtime = statSync(INDEX_FILE).mtime.toISOString();
    return { available: true, file: INDEX_FILE, docs, vecs, mtime };
  } catch { return { available: false, file: INDEX_FILE }; }
}

const SEG = /[\s,，。！？、；：""''（）()\[\]【】]+/;
const STOP = new Set(['怎么', '什么', '如何', '是不', '不是', '这个', '那个', '有没', '没有', '可以', '需要']);

/** CJK bigram + ASCII 整词:与建索引时的切词保持一致,否则 FTS 匹配不到 */
export function indexTerms(q, max = 24) {
  const out = new Set();
  for (const seg of String(q).split(SEG)) {
    const s = seg.trim();
    if (s.length < 2) continue;
    if (!/[\u4e00-\u9fff]/.test(s)) out.add(s.toLowerCase());
    else for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
    if (out.size >= max) break;
  }
  return [...out].filter(t => !STOP.has(t)).slice(0, max);
}

const blobOf = a => Buffer.from(new Float32Array(a).buffer);

export function ftsDocs(db, q, k = 50) {
  const terms = indexTerms(q);
  if (!terms.length) return [];
  const match = terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  const rows = db.prepare('SELECT rowid, bm25(docs_fts) AS rank FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?').all(match, k);
  return rows.map((r, i) => ({ rowid: r.rowid, score: Math.max(0.3, 0.95 - i * 0.01), basis: 'fts' }));
}

export function vecDocs(db, qvec, k = 50) {
  if (!qvec) return [];
  try {
    const rows = db.prepare('SELECT rowid, distance FROM docs_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?').all(blobOf(qvec), k);
    return rows.map(r => ({ rowid: r.rowid, score: Math.max(0, 1 - Number(r.distance) ** 2 / 2), basis: 'vector' }));
  } catch { return []; }
}

/** 每通道 min-max 归一后相加 —— 直接比原始分会变成"只信词法"(FTS 0.3~0.95 vs cos 0.4~0.7) */
function normalize(hits) {
  if (!hits.length) return hits;
  const xs = hits.map(h => h.score);
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const span = hi - lo || 1;
  return hits.map(h => ({ ...h, nscore: (h.score - lo) / span }));
}

export function mergeDocs(db, channels, k = 40) {
  const m = new Map();
  const used = channels.filter(c => c.length).length || 1;
  for (const hits of channels) for (const h of normalize(hits)) {
    const prev = m.get(h.rowid);
    if (!prev) m.set(h.rowid, { ...h, score: h.nscore / used });
    else m.set(h.rowid, { ...prev, score: prev.score + h.nscore / used, basis: prev.basis === h.basis ? h.basis : 'both' });
  }
  const ranked = [...m.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(k * 3, k + 20));
  if (!ranked.length) return [];
  const ids = JSON.stringify(ranked.map(t => t.rowid));
  const rows = db.prepare('SELECT rowid, id, instance, project, mem_type, text, created_at FROM docs WHERE rowid IN (SELECT value FROM json_each(?))').all(ids);
  const byRow = new Map(rows.map(r => [r.rowid, r]));
  // 先补正文,再按正文去重 —— 不 hydrate 就比字符串会把所有行压成同一个空 key(踩过:count 变 1)
  const hydrated = ranked.map(t => ({ ...(byRow.get(t.rowid) || {}), score: Math.round(t.score * 1000) / 1000, basis: t.basis })).filter(x => x.id);
  const byText = new Map();
  for (const h of hydrated) {
    const key = String(h.text || '').replace(/\s+/g, '').slice(0, 100);
    const prev = byText.get(key);
    if (!prev || h.score > prev.score) byText.set(key, h);
  }
  return [...byText.values()].slice(0, k);
}

