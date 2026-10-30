/* routes/graph.js — /api/graph /api/stats /api/status */
import { Router } from 'express';
import { existsSync, statSync, readFileSync as fsRead, writeFileSync as fsWrite, mkdirSync, renameSync } from 'fs';
import { gzipSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { createRequire } from 'module';
import { createHash } from 'node:crypto';
import { DB_DIR, DB_PATH, LEGACY_DB_PATH, CONFIG_PATH, loadConfig, openLibDb, libFiles, currentInstanceLibs, dbDirHasData, AGGREGATE_DIRS, sameDbDir } from './lib.js';
import { groupIndex, priorCoverage, nebulaGeometry, flattenVectors, pca2d } from './layout-geometry.mjs';

/* 星座键:默认=文件夹(memType,通用版口径);实例设 GRAPH_CONSTELLATION=category 时按 category 分
 * (anima 不用四个 memType 文件夹,它的分类轴是 category → AIRI 星域才不会只剩一个「通用」星座) */
const CONS_KIND = (process.env.GRAPH_CONSTELLATION || 'memtype').toLowerCase();
/* 按实例分类星座的名单:联邦视图由一个进程渲染多个星域,不同星域口径可能不同(如 AIRI 用 category)
 * 用法:GRAPH_CATEGORY_INSTANCES=airi  → 该实例的节点按 category 分星座,其余实例照旧按文件夹 */
const CATEGORY_INSTANCES = (process.env.GRAPH_CATEGORY_INSTANCES || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const consKeyOf = (n) => {
  const inst = String(n.layoutGroup || n.instance || n.lib || n.project || '').toLowerCase();
  const byCat = CONS_KIND === 'category' || CATEGORY_INSTANCES.includes(inst);
  return byCat ? String(n.category || 'general') : String(n.memType || 'general');
};

const router = Router();

/* ═══ 打开速度(v1.19):整响应缓存 + 增量布局 ═══
 * 旧实现的代价叠起来就是"每次打开都要等几十秒"(2026-10-30 实测 Full 汇总 4306 点):
 *   · 布局签名 = 把一个节点的 JSON + 1024 维向量全喂进 sha256(约 17MB)→ 记忆体每 2 分钟
 *     有新写入就整盘失效,缓存几乎从不命中;
 *   · 失效即全量重算:全局 UMAP(4302 点 × 1024 维 × 350 epoch)18s + 每星座 UMAP 13s;
 *   · 同一次请求还算了两块前端根本不读的投影,其中整库 PCA 是 n×n Gram 矩阵(O(n²d));
 * 现在:签名只看各库文件(含 -wal)的 size/mtime(毫秒级、写入立即可见),
 * 命中直接回缓存的整段 JSON(带 ETag + gzip);未命中则优先"旧坐标不动 + 新点就地插入"。 */
const GRAPH_CACHE = new Map();          /* key: scope|project|instance → { sig, body, gzip, etag } */
const GRAPH_CACHE_MAX = 4;
const LAYOUT_REUSE = String(process.env.GRAPH_LAYOUT_REUSE ?? '1') !== '0';
const UNIVERSE_LAYOUT = String(process.env.GRAPH_UNIVERSE_LAYOUT || '') === '1';
/* 文件指纹:主库 + WAL。记忆体是 WAL 模式(写入先进 -wal,主文件可能几分钟不动),
 * 只看主文件 mtime 会把"刚写的记忆"判成没变 —— 那是缓存最危险的错法。 */
function fileStamp(file) {
  const parts = [];
  for (const f of [file, file + '-wal']) {
    try { const st = statSync(f); parts.push(st.size + ':' + Math.round(st.mtimeMs)); }
    catch { parts.push('-'); }
  }
  return parts.join('/');
}
function snapshotSignature(libs, scope, project, instance) {
  return [scope, project, instance, CONS_KIND, CATEGORY_INSTANCES.join(',')]
    .concat(libs.map(l => `${l.instance || ''}~${l.project}~${l.file}~${fileStamp(l.file)}`))
    .join(';');
}

/* 布局持久化:进程重启/看护重启不该从头再算一遍 UMAP(坐标是纯几何,存下来就能用) */
function layoutCacheDir() {
  const base = process.env.VIZ_LAYOUT_DIR
    || join(process.env.LOCALAPPDATA || process.env.TMPDIR || '.', 'Castalia', 'viz-layouts');
  try { mkdirSync(base, { recursive: true }); } catch { /* 只读环境:退回纯内存 */ }
  return base;
}
/* 文件名必须带**库身份**:scope=local 在四个星图里指四个不同的记忆库,
 * 只按 scope 取名会让 Hermes 星图读到 Full 的坐标(实测:覆盖率不足 → 退化成全量重排)。 */
function layoutCacheFile(scope, project, instance) {
  const owner = instanceName() || 'local';
  const dbTag = String(DB_DIR || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(-48);
  const name = ['layout', owner, dbTag, scope, project || '_', instance || '_'].join('_')
    .replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(layoutCacheDir(), name + '.json');
}
function loadPriorLayout(scope, project, instance) {
  try {
    const f = layoutCacheFile(scope, project, instance);
    if (!existsSync(f)) return null;
    const j = JSON.parse(fsRead(f, 'utf-8'));
    if (!j || !j.coords || typeof j.coords !== 'object') return null;
    const m = new Map(Object.entries(j.coords));
    m.mode = j.mode || '';
    m.savedAt = j.savedAt || 0;
    return m;
  } catch { return null; }
}
function savePriorLayout(scope, project, instance, nodeXY, mode) {
  try {
    const f = layoutCacheFile(scope, project, instance);
    const coords = {};
    for (const [id, v] of nodeXY) coords[id] = [v[0], v[1], v[2]];
    const tmp = f + '.tmp';
    fsWrite(tmp, JSON.stringify({ savedAt: Date.now(), count: nodeXY.size, mode: mode || '', coords }));
    renameSync(tmp, f);
  } catch (e) { console.error('layout persist failed:', e.message); }
}

// IDs describe storage ownership, not mutable memory metadata. JSON tuples avoid separator collisions.
function graphNodeId(lib, rawId) {
  return JSON.stringify([lib.instance || '', lib.project, lib.memType || 'general', rawId]);
}
function relationLookupKey(instance, project, rawId) {
  return JSON.stringify([instance || '', project, rawId]);
}
function resolveGraphRelations(nodes, pendingEdges) {
  const byStorage = new Map(), byProject = new Map();
  const add = (map, key, id) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(id);
  };
  for (const n of nodes) {
    add(byStorage, n.id, n.id);
    add(byProject, relationLookupKey(n.instance, n.lib, n.rawId), n.id);
  }
  const endpoint = (lib, rawId) => {
    // Prefer the edge's own SQLite file; otherwise resolve only a unique active cross-memType endpoint.
    const own = byStorage.get(graphNodeId(lib, rawId));
    if (own?.size === 1) return [...own][0];
    const matches = byProject.get(relationLookupKey(lib.instance, lib.project, rawId));
    return matches?.size === 1 ? [...matches][0] : null;
  };
  const out = [], seen = new Set();
  for (const { lib, edge } of pendingEdges) {
    const source = endpoint(lib, edge.source_id), target = endpoint(lib, edge.target_id);
    if (!source || !target || source === target) continue;
    const key = JSON.stringify([source, target, edge.relation_type]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source, target, type: edge.relation_type, strength: edgeStrength(edge.relation_type) });
  }
  return out;
}

/* D1:边强度(server 侧计算,不改引擎 schema)
 *  - similarity 直接用向量余弦相似度
 *  - 关系边按类型给语义默认强度(引擎 edges 表尚无 strength 列) */
const EDGE_TYPE_STRENGTH = {
  part_of: 0.9, same_event: 0.85, causes: 0.7, caused_by: 0.7,
  leads_to: 0.65, sequence: 0.6, context: 0.5, same_subject: 0.5,
  related_to: 0.4, follows: 0.4,
};
function edgeStrength(type, similarity) {
  if (type === 'similarity') return similarity != null ? similarity : 0.7;
  return EDGE_TYPE_STRENGTH[type] != null ? EDGE_TYPE_STRENGTH[type] : 0.5;
}

// ═══ API: GET /api/graph ═══
/**
 * 本实例的默认作用域（请求没带 scope 时用）。
 * 2026-10-28: 汇总星图(Full)的内存库是空的,它的数据只在 federation 视图里 —— 裸调用
 * /api/graph 会得到 0 节点。castalia_config 会给 `federation: true` 的实例注入
 * FEDERATION_DIRS/MEMBERS,这里据此判断默认作用域,和页面注入的
 * __GRAPH_DEFAULT_SCOPE__ 用同一套规则,避免"页面有数据、接口却空"。
 */
function defaultScope() {
  if (process.env.GRAPH_SCOPE) return String(process.env.GRAPH_SCOPE).toLowerCase();
  const fed = ['FEDERATION_DIRS', 'FEDERATION_MEMBERS']
    .some(k => String(process.env[k] || '[]').replace(/[\[\]\s"]/g, '') !== '');
  return fed ? 'federation' : 'local';
}
function graphScope(req) {
  return String(req.query.scope || '').toLowerCase() || defaultScope();
}
function libsForScope(scope) {
  if (scope === 'federation' || scope === 'all' || scope === 'fed') return libFiles();
  return currentInstanceLibs();
}
function instanceName() {
  const self = AGGREGATE_DIRS.find(c => sameDbDir(c.dir, DB_DIR));
  return self ? self.name : 'local';
}

function isFedScope(scope) {
  return scope === 'federation' || scope === 'all' || scope === 'fed';
}
function layoutGroupOf(n, fed) {
  const proj = n.project || n.lib || '';
  if (fed) {
    if (proj === 'reflect') return '联邦';
    return n.instance || '未知';
  }
  /* v1.18.11:local 星域=实例(不再按库拆成多个星域,多库盘在星域内分星座) */
  return n.instance || proj || 'default';
}
function parseVec(buf) {
  if (!buf) return null;
  const raw = buf.buffer ? buf : Buffer.from(buf);
  const f = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  return f.length ? Array.from(f) : null;
}
function cosine(a, b) {
  let dot = 0, ma = 0, mb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
  const d = Math.sqrt(ma) * Math.sqrt(mb);
  return d ? dot / d : 0;
}
function centroid(vecs) {
  const d = vecs[0].length;
  const c = new Float64Array(d);
  for (const v of vecs) for (let i = 0; i < d; i++) c[i] += v[i];
  const n = vecs.length;
  for (let i = 0; i < d; i++) c[i] /= n;
  return Array.from(c);
}
/* ═══════════════════════════════════════════════════════════════════
 * P0 星云布局(2026-09-13)
 * 口径:形状由点自己长(橡皮泥),不画球/不缩容器;块 = L2 分文件夹(lib+memType);
 *      块间留真空;UMAP 保"近的像一伙";z 只取 XY 的 ~15%(扁星盘,转相机不散)。
 * 产出:nebulaX/Y/Z(覆盖旧布局 → 前端零改动就能看到新排布)、embX/Y/Z、blobId,
 *      以及 nebula:{blobs[], metaEdges[]}(块轮廓/元边,供图例与干道使用)。
 * 依赖:vendor/umap-js(离线自包含);UMAP 失败自动退回 PCA,绝不影响主图返回。
 * ═══════════════════════════════════════════════════════════════════ */
/* 稀疏随机投影(Johnson-Lindenstrauss):1024 维 → k 维,距离近似保持。
 * 为什么在这里做:UMAP 每轮都要在**原始维度**上算距离,1024 维是它最大的成本项;
 * 先压到 32 维再跑,形状等价(固定 seed,可复现),冷启动从 18s 掉到 1s 级。 */
/* 2D 凸包(单调链) */
function convexHull2D(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}
/* 凹包:凸包按边分裂(边中段确有内点且离边 > alpha 时插入该点)——壳跟着点长,不是圆 */
function concaveHull2D(pts, alpha) {
  if (pts.length < 4) return null;
  let hull = convexHull2D(pts);
  for (let pass = 0; pass < 4; pass++) {
    const out = [];
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      out.push(a);
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const el = Math.hypot(ex, ey) || 1e-6;
      let best = null, bestD = 0;
      for (const q of pts) {
        const t = ((q[0] - a[0]) * ex + (q[1] - a[1]) * ey) / (el * el);
        if (t <= 0.08 || t >= 0.92) continue;
        const d = Math.abs((q[0] - a[0]) * ey - (q[1] - a[1]) * ex) / el;
        if (d > bestD) { bestD = d; best = q; }
      }
      if (best && bestD > alpha && bestD < el * 0.55) out.push(best);
    }
    hull = out;
  }
  return hull.length >= 3 ? hull : null;
}
/* z 轴:局部密度(kNN 半径倒数),鲁棒分位归一化到 ±amp —— "中间厚、边上散" */
function densityZ2D(pts, amp) {
  if (pts.length < 3) return pts.map(() => 0);
  const k = Math.max(2, Math.min(8, Math.round(Math.sqrt(pts.length))));
  const dens = pts.map((p, i) => {
    const ds = [];
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(p[0] - pts[j][0], p[1] - pts[j][1]);
      if (ds.length < k) ds.push(d);
      else {
        let mi = 0;
        for (let t = 1; t < ds.length; t++) if (ds[t] > ds[mi]) mi = t;
        if (d < ds[mi]) ds[mi] = d;
      }
    }
    ds.sort((a, b) => a - b);
    const rk = ds[Math.min(k, ds.length) - 1] || 1e-6;
    return Math.log(1 / (rk + 1e-6));
  });
  /* 鲁棒归一化:p5~p95 映射到 ±amp 并截断,避免个别离群点把整块压平 */
  const sorted = dens.slice().sort((a, b) => a - b);
  const lo = sorted[Math.max(0, Math.floor(sorted.length * 0.05))];
  const hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const mid = (lo + hi) / 2, half = Math.max((hi - lo) / 2, 1e-6);
  return dens.map(v => Math.max(-1, Math.min(1, (v - mid) / half)) * amp);
}
/* 块分离:每个块整体刚性平移(块内形状原样保留),直到块间留出 gap 真空。
 * 支持 N 维 —— 三维时三个方向都留真空,星云才有体积感而不是平盘。 */
/* 增量落位:已定位的点原地不动,新点插进自己星座(块)现有的体积里。
 * 返回 null = 旧坐标覆盖不足(换库/换作用域),交给全量重排。
 * 为什么要这层:记忆体每 2 分钟就有新写入,而全量 UMAP 要 30s 级 ——
 * "每次打开都慢"的本质不是算得慢,是**每次都从头算**,新增一两条也重排整张图。 */
/* 布局入口(异步):覆盖率高 → 主线程增量落位(毫秒级);否则派给 worker 全量重排。
 * 为什么分两条路:增量只是"往已有坐标里插几个新点",主线程跑完不影响任何人;
 * 而全量重排是 5~20s 的纯 CPU 同步循环,放在主线程会把 /api/status 一起堵死
 * (2026-10-30 实测:构建期间 3 次 1s 超时 → 托盘探针误判掉线)。 */
async function applyNebulaLayout(nodes, links, vecById, prior, progress) {
  const pairs = nodes.map(n => ({ n, v: vecById.get(n.id) })).filter(p => p.v);
  if (pairs.length < 6) return null;
  /* 块 = 主文件夹/分文件夹 两层 */
  const blobKey = (n) => `${n.layoutGroup || n.instance || n.lib || n.project || 'default'}/${consKeyOf(n)}`;
  const { groupOf } = groupIndex(pairs, blobKey);
  const cover = priorCoverage(pairs, prior);
  const geoProgress = (stage, pct) => progress(stage, 0.34 + 0.58 * pct);
  let geom = null;
  if (cover >= 0.6 || pairs.length < 400) {
    /* 小图 / 增量:直接在主线程算(几十毫秒~几百毫秒) */
    geom = nebulaGeometry(pairs, groupOf, prior, geoProgress);
  } else {
    try {
      geom = await geometryInWorker(pairs, groupOf, geoProgress);
    } catch (e) {
      console.error('layout worker failed, falling back to in-process:', e.message);
      progress('worker 不可用，退回主线程重算（会卡住其它请求）', 0.40);
      geom = nebulaGeometry(pairs, groupOf, null, geoProgress);
    }
  }
  if (!geom) return null;
  return finalizeNebula(nodes, links, pairs, blobKey, geom);
}

/* 落元数据:坐标 → 节点字段 / 块轮廓 / 干道 / 链接标记(纯主线程,几十毫秒) */
function finalizeNebula(nodes, links, pairs, blobKey, geom) {
  const { P, usedUmap, incremental, stretch } = geom;
  const groups = new Map();
  pairs.forEach((p, i) => {
    const k = blobKey(p.n);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  const gs = [...groups.entries()].map(([key, idx]) => ({ key, idx, pts: idx.map(i => P[i]) }));
  const blobCenter = (g) => [0, 1, 2].map(a =>
    g.pts.reduce((sum, p) => sum + p[a], 0) / g.pts.length);

  /* Write coordinates and replay them from the layout cache on later requests. */
  const placed = new Set();
  const nodeXY = new Map();
  pairs.forEach((p, i) => {
    p.n.nebulaX = Math.round(P[i][0] * 100) / 100;
    p.n.nebulaY = Math.round(P[i][1] * 100) / 100;
    p.n.nebulaZ = Math.round(P[i][2] * 100) / 100;
    p.n.embX = p.n.nebulaX; p.n.embY = p.n.nebulaY; p.n.embZ = p.n.nebulaZ;
    p.n.blobId = blobKey(p.n);
    nodeXY.set(p.n.id, [p.n.nebulaX, p.n.nebulaY, p.n.nebulaZ, p.n.blobId]);
    placed.add(p.n.id);
  });
  /* 无向量的节点(如 conversation_log)不参与布局,但**绝不能全堆在质心**——
   * 实测 airi/general 18 条叠成同一个坐标 → 渲染成一个超亮点,且块半径按"有向量的点数"算,
   * 肉眼读成"挤成一团"(2026-09-13 用户报"airi 端密度没改")。
   * 改为:在自己的块内沿**确定性黄金角螺旋**分散落位(半径 ≤0.62R,面积均匀,点不重叠)。 */
  const r2 = (v) => Math.round(v * 100) / 100;
  const centroidOf = new Map(gs.map(g => [g.key, blobCenter(g)]));
  const radiusOf = new Map(gs.map(g => {
    const c = blobCenter(g);
    let r = 1;
    for (const i of g.idx) r = Math.max(r, Math.hypot(P[i][0] - c[0], P[i][1] - c[1], P[i][2] - c[2]));
    return [g.key, r];
  }));
  const orphanTotal = new Map();
  const orphanSeen = new Map();
  for (const n of nodes) {
    if (placed.has(n.id)) continue;
    const k = blobKey(n);
    n.blobId = k;
    orphanTotal.set(k, (orphanTotal.get(k) || 0) + 1);
  }
  for (const n of nodes) {
    if (placed.has(n.id)) continue;
    const k = n.blobId;
    const c = centroidOf.get(k) || [0, 0, 0];
    const R = radiusOf.get(k) || 25;
    const j = orphanSeen.get(k) || 0;
    orphanSeen.set(k, j + 1);
    const total = Math.max(1, orphanTotal.get(k) || 1);
    const t = (j + 0.5) / total;                       /* 0..1,面积均匀 */
    const rad = R * 0.62 * Math.sqrt(t);
    const a = j * 2.399963229728653;                   /* 黄金角 */
    const z = Math.cos(Math.sqrt(t) * Math.PI) * rad * 0.5;
    n.nebulaX = r2(c[0] + rad * Math.cos(a));
    n.nebulaY = r2(c[1] + rad * Math.sin(a));
    n.nebulaZ = r2(c[2] + z);
    n.embX = n.nebulaX; n.embY = n.nebulaY; n.embZ = n.nebulaZ;
    nodeXY.set(n.id, [n.nebulaX, n.nebulaY, n.nebulaZ, k]);
  }
  /* 块元信息(图例/点击展开用)+ 三维质心/半径 + XY 投影轮廓(壳留给 P1)
   * count 必须**含无向量的散落点**,否则块半径按"有向量的点数"算 → 看着挤(当年 airi/general 13 vs 31) */
  const blobs = gs.map(g => {
    const pts = g.idx.map(i => P[i]);
    const c = blobCenter(g);
    const r = Math.max(...pts.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])));
    const [lib, memType] = [g.key.slice(0, g.key.lastIndexOf('/')), g.key.slice(g.key.lastIndexOf('/') + 1)];
    const cats = new Map();
    for (const i of g.idx) {
      const c2 = String(pairs[i].n.category || 'general');
      cats.set(c2, (cats.get(c2) || 0) + 1);
    }
    return {
      id: g.key, lib, memType, count: g.idx.length + (orphanTotal.get(g.key) || 0),
      cx: r2(c[0]), cy: r2(c[1]), cz: r2(c[2]), r: r2(r),
      categories: [...cats.entries()].map(([cc, v]) => ({ category: cc, count: v })).sort((a, b) => b.count - a.count),
      hull: concaveHull2D(pts.map(p => [p[0], p[1]]), Math.max(6, r * 0.4)),
    };
  });
  /* 干道 v1.22(用户定稿):端点必须是**块对块的支撑点**,不能用记忆点。
   * 一根线要连的是"真实对端",而节点被推到的是"朝所有对端的加权平均方向"(一个点同时连 B、C 就落在 B、C 中间)
   * → 用节点当端点几何上必然斜切。这里用**分离之后**的团心 + 沿 V 方向最靠外的实点(支撑点)算 gateA/gateB。
   * 每对只出一条干道(count/weight 供亮度分级);点对点关系留给 hover。 */
  const byId = new Map(nodes.map(n => [n.id, n]));
  const cenAfter = new Map(gs.map(g => [g.key, blobCenter(g)]));
  const agg = new Map();
  for (const l of links) {
    const a = byId.get(typeof l.source === 'object' ? l.source.id : l.source);
    const b = byId.get(typeof l.target === 'object' ? l.target.id : l.target);
    if (!a || !b) continue;
    l.internal = a.blobId === b.blobId;
    if (l.internal) continue;
    const key = [a.blobId, b.blobId].sort().join('|');
    if (!agg.has(key)) agg.set(key, { a: a.blobId, b: b.blobId, count: 0, wsum: 0, best: null, bestW: -1 });
    const e = agg.get(key);
    e.count++; e.wsum += (l.strength || 0.5);
    /* samples 只留"最强的那 1 条"(旧实现是遇见谁收谁;samples 仅供 hover/取证) */
    if ((l.strength || 0.5) > e.bestW) { e.bestW = l.strength || 0.5; e.best = l; }
  }
  const GATE_GAP = 4;
  const supportAlong = (bk, V) => {                 /* 该块沿 V 方向最靠外的实点距离(支撑点半径) */
    const g = gs.find(x => x.key === bk);
    const c = cenAfter.get(bk);
    if (!g || !c) return null;
    let best = -Infinity;
    for (const i of g.idx) {
      const p = P[i];
      const d = (p[0] - c[0]) * V[0] + (p[1] - c[1]) * V[1] + (p[2] - c[2]) * V[2];
      if (d > best) best = d;
    }
    return Math.max(best, 1);
  };
  const metaEdges = [...agg.values()].map(e => {
    const ca = cenAfter.get(e.a), cb = cenAfter.get(e.b);
    let gateA = null, gateB = null, dist = null;
    if (ca && cb) {
      const v = [cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]];
      const L = Math.hypot(v[0], v[1], v[2]);
      if (L > 1e-6) {
        const V = [v[0] / L, v[1] / L, v[2] / L];
        const ra = supportAlong(e.a, V), rb = supportAlong(e.b, [-V[0], -V[1], -V[2]]);
        dist = Math.round(L * 10) / 10;
        if (ra != null && rb != null) {
          gateA = [ca[0] + V[0] * (ra + GATE_GAP), ca[1] + V[1] * (ra + GATE_GAP), ca[2] + V[2] * (ra + GATE_GAP)].map(r2);
          gateB = [cb[0] - V[0] * (rb + GATE_GAP), cb[1] - V[1] * (rb + GATE_GAP), cb[2] - V[2] * (rb + GATE_GAP)].map(r2);
        }
      }
    }
    return {
      a: e.a, b: e.b, count: e.count, weight: Math.round((e.wsum / e.count) * 100) / 100,
      dist, gateA, gateB, samples: e.best ? [e.best] : [],
    };
  }).sort((x, y) => y.count - x.count);
  const metaSet = new Set(metaEdges.flatMap(e => e.samples));
  const linkFlags = new Map();
  for (const l of links) {
    const sa = typeof l.source === 'object' ? l.source.id : l.source;
    const ta = typeof l.target === 'object' ? l.target.id : l.target;
    if (!l.internal) l.meta = metaSet.has(l);
    linkFlags.set(`${sa}|${ta}`, { internal: !!l.internal, meta: !!l.meta });
  }
  /* 三轴实际尺寸 + 深度比(最小方向 ÷ 最大方向),供前端徽标自检 */
  const ex = [0, 1, 2].map(a => {
    let lo = Infinity, hi = -Infinity;
    for (const p of P) { if (p[a] < lo) lo = p[a]; if (p[a] > hi) hi = p[a]; }
    return Math.round(hi - lo);
  });
  const zRatio = Math.round(Math.min(...ex) / Math.max(...ex) * 100);
  return { ok: true, usedUmap, incremental, blobs, metaEdges, nodeXY, linkFlags, nodeCount: pairs.length, extents: ex, zRatio, stretch: stretch.map(v => Math.round(v * 100) / 100) };
}

/**
 * 把(可能来自缓存的)布局重放到本次请求的节点/链路上。
 * 必须走这一步:节点对象每次请求都是新建的,只回缓存元数据会让坐标退回旧布局。
 */
function paintNebula(nodes, links, L) {
  if (!L) return { ok: false, error: 'layout unavailable' };
  for (const n of nodes) {
    const v = L.nodeXY.get(n.id);
    if (!v) continue;
    n.nebulaX = v[0]; n.nebulaY = v[1]; n.nebulaZ = v[2];
    n.embX = v[0]; n.embY = v[1]; n.embZ = v[2];
    n.blobId = v[3];
  }
  for (const l of links) {
    const sa = typeof l.source === 'object' ? l.source.id : l.source;
    const ta = typeof l.target === 'object' ? l.target.id : l.target;
    const f = L.linkFlags.get(`${sa}|${ta}`);
    if (f) { l.internal = f.internal; l.meta = f.meta; }
  }
  return { ok: true, usedUmap: L.usedUmap, incremental: !!L.incremental, blobs: L.blobs, metaEdges: L.metaEdges, nodeCount: L.nodeCount, zRatio: L.zRatio, extents: L.extents, stretch: L.stretch, cached: !!L.cached };
}
function hash01Lib(id) {
  const s = String(id || '') + ':neb';
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/* 每个库的原始读取结果(记忆行 / 边 / 向量)按文件指纹缓存。
 * 为什么要:一次联邦请求要开 100 个 sqlite 文件(每个都要 pragma + 加载 sqlite-vec),
 * 实测 1.8s —— 而"打开星图"时通常只有 1~2 个库真的变了。 */
const LIB_ROWS = new Map();
const LIB_ROWS_MAX = 400;
function readLibRows(lib) {
  const stamp = fileStamp(lib.file);
  const memo = LIB_ROWS.get(lib.file);
  if (memo && memo.stamp === stamp) { LIB_ROWS.delete(lib.file); LIB_ROWS.set(lib.file, memo); return memo; }
  const out = { stamp, memories: [], edges: [], vecs: [] };
  let db = null;
  try {
    db = openLibDb(lib.file);
    if (db) {
      out.memories = db.prepare(`
        SELECT id, text, project, type, mem_type, category, subcategory, tags,
               importance, character_id, source,
               subject, tier, expires_at, created_at, accessed_count
        FROM memory WHERE is_active = 1 ORDER BY created_at ASC
      `).all();
      try { out.edges = db.prepare('SELECT source_id, target_id, relation_type FROM edges').all(); } catch { }
      try {
        const vecRows = db.prepare(`
          SELECT m.id, v.embedding FROM memory m
          JOIN vec_memory v ON m.rowid = v.rowid WHERE m.is_active = 1
        `).all();
        for (const r of vecRows) {
          const vec = parseVec(r.embedding);
          if (vec) out.vecs.push([r.id, vec]);
        }
      } catch (e) { console.error('vec load failed:', e.message); }
    }
  } catch (e) { console.error(`graph lib ${lib.file} failed:`, e.message); }
  finally { if (db) db.close(); }
  LIB_ROWS.set(lib.file, out);
  while (LIB_ROWS.size > LIB_ROWS_MAX) LIB_ROWS.delete(LIB_ROWS.keys().next().value);
  return out;
}

/* 统一出口:ETag/304 + gzip。7.7MB 未压缩的 JSON 在 localhost 也要几百毫秒解析,
 * gzip 后约 1MB —— 浏览器解析时间也一并省掉。 */
function sendGraph(req, res, entry) {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', entry.etag);
  res.setHeader('X-Graph-Built', String(entry.builtAt));
  if (req.headers['if-none-match'] === entry.etag) return res.status(304).end();
  const accepts = String(req.headers['accept-encoding'] || '');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (/\bgzip\b/.test(accepts)) {
    if (!entry.gzip) entry.gzip = gzipSync(entry.body);
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    return res.end(entry.gzip);
  }
  res.end(entry.body);
}

/* ═══ 构建进度 / 并发合并 ═══
 * 进度能"实时"的前提是重排跑在 worker 里 —— 主线程空着,才答得上这个接口;
 * 否则构建期间连它自己都会超时(2026-10-30 实测 /api/status 连续 1s 无响应)。 */
const BUILD_PROGRESS = new Map();   /* cacheKey → { stage, pct, startedAt } */
const INFLIGHT = new Map();         /* cacheKey → Promise<entry>:同一快照只算一次 */
const LAYOUT_WORKER_TIMEOUT = parseInt(process.env.GRAPH_WORKER_TIMEOUT || '180000', 10);

function progressSet(cacheKey, stage, pct) {
  const cur = BUILD_PROGRESS.get(cacheKey) || {};
  BUILD_PROGRESS.set(cacheKey, {
    stage,
    pct: Math.min(0.99, Math.max(cur.pct || 0, pct)),   /* 单调,避免来回跳 */
    startedAt: cur.startedAt || Date.now(),
    at: Date.now(),
  });
}

/* 把几何计算派给 worker_threads:整段 UMAP 期间事件循环是空的(实测主线程最大卡顿 15ms),
 * 所以 /api/status、/api/graph/progress、别的星图页都照常应答。 */
function geometryInWorker(pairs, groupOf, progress) {
  const { flat, n, dim } = flattenVectors(pairs);
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./layout-worker.mjs', import.meta.url)); }
    catch (e) { reject(e); return; }
    let settled = false;
    const finish = (err, geom) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      Promise.resolve(w.terminate()).catch(() => { });
      if (err) reject(err); else resolve(geom);
    };
    const timer = setTimeout(() => finish(new Error('layout worker 超时')), LAYOUT_WORKER_TIMEOUT);
    w.on('message', (m) => {
      if (!m) return;
      if (m.type === 'progress') { progress(m.stage, m.pct); return; }
      if (m.type === 'error') { finish(new Error(m.error || 'worker error')); return; }
      if (m.type === 'done') {
        const c = new Float32Array(m.coords);
        const P = new Array(n);
        for (let i = 0; i < n; i++) P[i] = [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]];
        finish(null, { P, usedUmap: !!m.usedUmap, incremental: false, stretch: m.stretch || [1, 1, 1] });
      }
    });
    w.on('error', (e) => finish(e));
    w.postMessage({ flat: flat.buffer, n, dim, groupOf }, [flat.buffer]);
  });
}

router.get('/graph', async (req, res) => {
  const scope = graphScope(req);
  const fed = isFedScope(scope);
  const project = String(req.query.project || '');
  const instance = String(req.query.instance || '');
  const libs = libsForScope(scope).filter(lib => (!project || lib.project === project) && (!instance || lib.instance === instance));
  /* 快照没变就直接回上一次的整段 JSON(实测 4306 点:重建 36s → 命中 30ms) */
  const snapSig = snapshotSignature(libs, scope, project, instance);
  const cacheKey = `${scope}|${project}|${instance}`;
  const cacheHit = GRAPH_CACHE.get(cacheKey);
  if (cacheHit && cacheHit.sig === snapSig && String(req.query.fresh || '') !== '1') {
    GRAPH_CACHE.delete(cacheKey); GRAPH_CACHE.set(cacheKey, cacheHit);   /* LRU 提升 */
    return sendGraph(req, res, cacheHit);
  }
  let build = INFLIGHT.get(cacheKey);
  if (!build) {
    build = buildGraphPayload({
      scope, fed, project, instance, libs, cacheKey, snapSig,
      layouts: String(req.query.layouts || ''),
      progress: (stage, pct) => progressSet(cacheKey, stage, pct),
    });
    INFLIGHT.set(cacheKey, build);
    build.catch(() => { }).finally(() => INFLIGHT.delete(cacheKey));
  }
  let entry;
  try { entry = await build; }
  catch (e) {
    console.error('graph build failed:', e && e.message);
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
  BUILD_PROGRESS.delete(cacheKey);
  sendGraph(req, res, entry);
});

/* 真实进度:页面在等 /api/graph 时轮询这里(worker 在跑,主线程答得动) */
router.get('/graph/progress', (req, res) => {
  const key = `${graphScope(req)}|${String(req.query.project || '')}|${String(req.query.instance || '')}`;
  res.setHeader('Cache-Control', 'no-store');
  const p = BUILD_PROGRESS.get(key);
  if (!p) return res.json({ building: false, cached: !!GRAPH_CACHE.get(key) });
  res.json({ building: true, stage: p.stage, pct: Math.round(p.pct * 1000) / 1000, elapsedMs: Date.now() - p.startedAt });
});

/* 构建主体(原 /api/graph 内联代码,独立出来只为合并并发请求) */
async function buildGraphPayload({ scope, fed, project, instance, libs, cacheKey, snapSig, layouts, progress }) {
  progress('读取记忆库', 0.02);
  const nodes = [];
  const links = [];
  const vecById = new Map();
  const pendingEdges = [];
  let totalMemories = 0;
  const categoryColors = {
    emotional: '#FF6B6B', milestone: '#FFA726', identity: '#66BB6A',
    relationship: '#42A5F5', mood_snapshot: '#FFD54F', conversation: '#AB47BC',
    knowledge: '#26A69A', preference: '#EC407A', decision: '#FFA726',
    mistake: '#EF5350', general: '#78909C',
  };
  for (let li = 0; li < libs.length; li++) {
    const lib = libs[li];
    /* 100 个 sqlite 全同步读,整体 1~2s:每 8 个库让一次事件循环,免得把 /api/status 堵死 */
    progress('读取记忆库', 0.02 + 0.16 * ((li + 1) / Math.max(1, libs.length)));
    if ((li & 7) === 7) await new Promise(r => setImmediate(r));
    try {
      const snap = readLibRows(lib);
      const memories = snap.memories;
      totalMemories += memories.length;

      const edges = snap.edges;

      const libNodes = memories.map(m => {
        let tags = [];
        try { tags = JSON.parse(m.tags || '[]'); } catch {}
        const isTemporary = m.tier === 'temporary';
        const isCritical = m.tier === 'critical';
        return {
          id: graphNodeId(lib, m.id),
          rawId: m.id,
          instance: lib.instance || '',
          lib: lib.project,
          label: m.text.length > 60 ? m.text.slice(0, 60) + '...' : m.text,
          fullText: m.text,
          project: m.project || lib.project,
          type: m.type, memType: m.mem_type || 'general', category: m.category, subcategory: m.subcategory,
          tags, importance: m.importance,
          source: m.source, subject: m.subject, tier: m.tier || 'standard',
          expiresAt: m.expires_at, createdAt: m.created_at, accessedCount: m.accessed_count,
          starred: (m.importance || 0.5) >= 0.9,
          valence: isCritical ? (m.importance * 12 + 5) : isTemporary ? (m.importance * 5 + 2) : (m.importance * 8 + 3),
          color: categoryColors[m.category] || '#90A4AE',
          isTemporary, isCritical,
        };
      });

       // Resolve after all files are read, so relations can span memType databases.
       pendingEdges.push(...edges.map(edge => ({ lib, edge })));

      for (const [rawId, vec] of snap.vecs) vecById.set(graphNodeId(lib, rawId), vec);

      /* ═══ 团内相似度边(2026-10-30 重写)══════════════════════════════════════════════
       * 旧代码的硬上限 `libNodes.length <= 400` 会**整库跳过**:超过 400 条的库一条边都不发。
       * 实测后果(先是"某个星域内部看不到线"的现象,根因就在这里,与元数据、与前端都无关):
       *   reflect/user 450 条 → 0 段线;hermes/project 619 条 → 0 段线;
       *   而同一个库里 132 条的 feedback 有 137 段 —— 团越大越像空的。
       * 现在:不限规模,每个点只留最近的 2 条(相似度 < 0.65 丢弃),向量先归一化,
       *   扫描时只留 best1/best2,不再为每个点分配 n 个 {id,sim} 对象:
       *   450 / 619 这种规模的库 = 几千万次乘加,每 32 行让一次事件循环。
       * **只连同一个文件(=同一个星座/团)内部的点**:跨团、跨星域一条都不发
       *   —— 连线只表达"团内语义相近",团与团之间没有结构边,免得图上看着很密、实际全是噪声。 */
      if (libNodes.length >= 2) {
        try {
          const src = libNodes.map(n => ({ id: n.id, v: vecById.get(n.id) })).filter(x => x.v);
          if (src.length >= 2) {
            const dim = src[0].v.length;
            const norm = src.map(e => {
              let s2 = 0;
              for (let i = 0; i < dim; i++) s2 += e.v[i] * e.v[i];
              const d = Math.sqrt(s2) || 1;
              const v = new Float64Array(dim);
              for (let i = 0; i < dim; i++) v[i] = e.v[i] / d;
              return { id: e.id, v };
            });
            const SIM_THRESHOLD = 0.65;
            const existing = new Set(links.map(l => `${l.source}|${l.target}`));
            for (let i = 0; i < norm.length; i++) {
              if ((i & 31) === 31) await new Promise(r => setImmediate(r));   /* 别堵死 /api/status */
              const a = norm[i].v;
              let s1 = -2, j1 = -1, s2 = -2, j2 = -1;
              for (let j = 0; j < norm.length; j++) {
                if (i === j) continue;
                const b = norm[j].v;
                let dot = 0;
                for (let k = 0; k < dim; k++) dot += a[k] * b[k];
                if (dot > s1) { s2 = s1; j2 = j1; s1 = dot; j1 = j; }
                else if (dot > s2) { s2 = dot; j2 = j; }
              }
              for (const [sim, j] of [[s1, j1], [s2, j2]]) {
                if (j < 0 || sim < SIM_THRESHOLD) continue;
                const sid = norm[i].id, tid = norm[j].id;
                const k1 = `${sid}|${tid}`, k2 = `${tid}|${sid}`;
                if (existing.has(k1) || existing.has(k2)) continue;
                existing.add(k1);
                const rounded = Math.round(sim * 100) / 100;
                links.push({ source: sid, target: tid, type: 'similarity', similarity: rounded, strength: edgeStrength('similarity', rounded) });
              }
            }
          }
        } catch (e) { console.error('Similarity links failed:', e.message); }
      }

      nodes.push(...libNodes);
    } catch (e) { console.error(`graph lib ${lib.file} failed:`, e.message); }
  }

  progress('整理关系边', 0.19);
  links.push(...resolveGraphRelations(nodes, pendingEdges));
  // Cross-library links must see the final region before grouping (previously all used "default").
  for (const n of nodes) n.layoutGroup = layoutGroupOf(n, fed);

  /* ── 跨团相似边(原 v1.18.11"星门干线原料"):2026-10-30 停发 ──────────────────────
   * 为什么停:这些边连的是**同一个星域里不同团(星座)之间**的点,而画它们的干道层
   * 在 v1.25 已按产品定稿整体删除 —— 于是它们只剩下两个作用:
   *   ① 顶部"连线 N"里白白多出 2410 条(实测 Hermes 734 + LobeHub 1114 + AIRI 562),
   *      点开却一条都看不到(现象:连线很多,图反而更乱);
   *   ② 把每点的度数抬高,影响标签/亮度排名和语义聚类。
   * 产品口径:**每个团内部要有线,团外不连**。所以这里不再生成跨团边,
   * 只保留上面每个库(团)内部的 kNN。恢复办法:从 git 历史取回这段(2a50506 及以前)。
   */

  progress('计算语义投影', 0.24);
  const byGroup = new Map();
  for (const n of nodes) {
    const g = layoutGroupOf(n, fed);
    n.layoutGroup = g;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(n);
  }
  for (const [, ns] of byGroup) {
    const byFolder = new Map();
    for (const n of ns) {
      const f = n.memType || 'general';
      if (!byFolder.has(f)) byFolder.set(f, []);
      byFolder.get(f).push(n);
    }
    for (const [, fns] of byFolder) {
      await new Promise(r => setImmediate(r));
      const pairs = fns.map(n => ({ n, vec: vecById.get(n.id) })).filter(p => p.vec);
      if (pairs.length < 2) continue;
      const coords = pca2d(pairs.map(p => p.vec));
      pairs.forEach((p, i) => {
        p.n.atlasX = coords[i][0];
        p.n.atlasY = coords[i][1];
      });
    }
  }
  /* cosmograph 宇宙图:全库 embedding PCA(对应 point_x_by / point_y_by,仿真关闭)
   * n×n Gram 矩阵,节点过多时抽样,失败不影响主图返回。
   * v1.19:前端星图/星座图都不读 universeX/Y/Z(全仓 grep 无引用),默认不算;
   * 需要时设 GRAPH_UNIVERSE_LAYOUT=1 或请求带 ?layouts=universe。 */
  try {
    if (UNIVERSE_LAYOUT || String(layouts || '').includes('universe')) {
    let uniPairs = nodes.map(n => ({ n, vec: vecById.get(n.id) })).filter(p => p.vec);
    const UNI_CAP = 800;
    if (uniPairs.length > UNI_CAP) {
      uniPairs = uniPairs.filter((_, i) => i % Math.ceil(uniPairs.length / UNI_CAP) === 0).slice(0, UNI_CAP);
    }
    if (uniPairs.length >= 2) {
      const uni = pcaCoords(uniPairs.map(p => p.vec), 3);
      uniPairs.forEach((p, i) => {
        p.n.universeX = uni[i][0];
        p.n.universeY = uni[i][1];
        p.n.universeZ = uni[i][2] || 0;
      });
    }
    }
  } catch (e) { console.error('universe PCA failed:', e.message); }
/* v1.17.3 EVE 式三级星图:星域(实例)→星座(文件夹)→星系(记忆)
   * 关键是尺度分离:同库内密度近似恒定(r∝cbrt(n)),星座间隙/星域间隙由锚环逐级放大保证 */
  try {
    const instKey = (n) => (n.layoutGroup || 'default'); /* v1.18.11: 星域=实例(local/联邦统一),多库星域内星座=主文件夹 */
    const regions = new Map();    /* region -> lib -> nodes */
    const regionGals = new Map(); /* region -> lib -> memType -> nodes */
    const isMultiRg = new Map();  /* region 内主文件夹数>1 = 多库星域 */
    for (const n of nodes) {
      const r = instKey(n);
      if (!regions.has(r)) regions.set(r, new Map());
      if (!regionGals.has(r)) regionGals.set(r, new Map());
      const l = String(n.lib || n.project || 'default');
      const lm = regions.get(r);
      if (!lm.has(l)) lm.set(l, []);
      lm.get(l).push(n);
      const gm = regionGals.get(r);
      if (!gm.has(l)) gm.set(l, new Map());
      const g = String(n.memType || 'general');
      const mm = gm.get(l);
      if (!mm.has(g)) mm.set(g, []);
      mm.get(g).push(n);
    }
    for (const [r, lm] of regions) isMultiRg.set(r, lm.size > 1);
    const cRadius = (cnt) => 11 + 7 * Math.log(Math.max(cnt, 4) / 4); /* v1.18.4: 半径压回星系尺度(8星座≈17/50星座≈19);域由星座环承载 */
    function fib(n) {
      const out = [];
      for (let i = 0; i < n; i++) {
        const phi = Math.acos(1 - 2 * (i + 0.5) / n);
        const theta = Math.PI * (1 + Math.sqrt(5)) * i;
        out.push({ x: Math.sin(phi) * Math.cos(theta), y: Math.sin(phi) * Math.sin(theta), z: Math.cos(phi) });
      }
      return out;
    }
    function sepRing(units, radii, gap, base) {
      /* 放大公共半径 s,直到任意对 |s·vi−s·vj| ≥ ri+rj+gap */
      let s = base;
      for (let it = 0; it < 60; it++) {
        let ok = true;
        for (let i = 0; i < units.length; i++) {
          for (let j = i + 1; j < units.length; j++) {
            const d = Math.hypot(units[i].x * s - units[j].x * s, units[i].y * s - units[j].y * s, units[i].z * s - units[j].z * s) || 1e-6;
            const need = radii[i] + radii[j] + gap;
            if (d < need) { s *= Math.max(need / d, 1.03); ok = false; }
          }
        }
        if (ok) break;
      }
      return s;
    }
    /* L2 星座锚:多库星域=主文件夹(库)环排;单库星域=category(现状,视觉 8-9 文件夹) */
    const libRadius = (cnt) => 22 + 8 * Math.log(Math.max(cnt, 4) / 4); /* v1.18.11 星座(库)尺度:100~200 节点库 → ~30~40 */
    const constAnchor = new Map();
    const constR = new Map();
    for (const [r, lm] of regions) {
      if (isMultiRg.get(r)) {
        const names = [...lm.keys()].sort();
        const rs = names.map((l) => libRadius(lm.get(l).length));
        names.forEach((l, i) => constR.set(r + '/' + l, rs[i]));
        const us = fib(names.length);
        const s = sepRing(us, rs, 16, 92);
        names.forEach((l, i) => {
          constAnchor.set(r + '/' + l, { x: us[i].x * s, y: us[i].y * s, z: us[i].z * s });
        });
      } else {
        const byCat = new Map();
        for (const [, ms] of lm) for (const n of ms) {
          const ck = String(n.category || n.memType || 'general');
          if (!byCat.has(ck)) byCat.set(ck, []);
          byCat.get(ck).push(n);
        }
        const names = [...byCat.keys()].sort();
        const rs = names.map((k) => cRadius(byCat.get(k).length));
        names.forEach((k, i) => constR.set(r + '/' + k, rs[i]));
        if (names.length === 1) {
          constAnchor.set(r + '/' + names[0], { x: 0, y: 0, z: 0 });
        } else {
          const us = fib(names.length);
          const s = sepRing(us, rs, 10, 56);
          names.forEach((k, i) => {
            constAnchor.set(r + '/' + k, { x: us[i].x * s, y: us[i].y * s, z: us[i].z * s });
          });
        }
      }
    }
    /* L1 星域锚 */
    const regionNames = [...regions.keys()];
    const regionCloud = {};
    for (const r of regionNames) {
      let ring = 0, maxR = 0;
      for (const [k, rad] of constR) if (k.startsWith(r + '/') && rad > maxR) maxR = rad;
      for (const [k, p] of constAnchor) if (k.startsWith(r + '/')) ring = Math.max(ring, Math.hypot(p.x, p.y, p.z));
      regionCloud[r] = ring + maxR;
    }
    const instPos = new Map();
    if (regionNames.length === 1) {
      instPos.set(regionNames[0], { x: 0, y: 0, z: 0 });
    } else {
      const us = fib(regionNames.length);
      const s = sepRing(us, regionNames.map((r) => regionCloud[r]), 30, 120);
      regionNames.forEach((r, i) => instPos.set(r, { x: us[i].x * s, y: us[i].y * s, z: us[i].z * s }));
    }
    /* L3/L4:多库星域=星座(库)内星系(memType)锚 + 恒星绕星系锚 PCA 径向;
     * 单库星域=星座(category)内恒星 PCA 径向(现状,层级不变) */
    for (const [r, lm] of regions) {
      const A0 = instPos.get(r);
      if (isMultiRg.get(r)) {
        for (const [l, members] of lm) {
          const key = r + '/' + l;
          const off = constAnchor.get(key) || { x: 0, y: 0, z: 0 };
          const A = { x: A0.x + off.x, y: A0.y + off.y, z: A0.z + off.z };
          const rc = constR.get(key) || 30;
          /* 星系锚:副文件夹(memType)在星座球内小环排 */
          const galMembers = regionGals.get(r).get(l) || new Map();
          const galKeys = [...galMembers.keys()];
          const ga = new Map();
          if (galKeys.length === 1) {
            ga.set(galKeys[0], { x: 0, y: 0, z: 0 });
          } else {
            const uf = fib(Math.max(galKeys.length, 1));
            const gf = sepRing(uf, galKeys.map(() => 6), 4, rc * 0.42);
            galKeys.forEach((g, i) => ga.set(g, { x: uf[i].x * gf, y: uf[i].y * gf, z: uf[i].z * gf }));
          }
          /* 恒星:绕本星系锚 PCA 径向(星系半径=星座半径×0.34,星系团不溢出星座球) */
          const gR = rc * 0.34;
          for (const [g, ms] of galMembers) {
            const G = ga.get(g) || { x: 0, y: 0, z: 0 };
            const GA0 = { x: A.x + G.x, y: A.y + G.y, z: A.z + G.z };
            const withU = ms.filter(n => Number.isFinite(n.universeX));
            let cx = 0, cy = 0, cz = 0;
            if (withU.length) {
              cx = withU.reduce((a, n) => a + n.universeX, 0) / withU.length;
              cy = withU.reduce((a, n) => a + n.universeY, 0) / withU.length;
              cz = withU.reduce((a, n) => a + (Number.isFinite(n.universeZ) ? n.universeZ : 0), 0) / withU.length;
            }
            let dmax = 0;
            const rel = [];
            for (const n of withU) {
              const dx = n.universeX - cx, dy = n.universeY - cy, dz = (Number.isFinite(n.universeZ) ? n.universeZ : cz) - cz;
              const d = Math.hypot(dx, dy, dz) || 1e-9;
              rel.push([n, dx, dy, dz, d]);
              if (d > dmax) dmax = d;
            }
            const relMap = new Map(rel.map(e => [e[0], e]));
            let placed = 0;
            for (const n of ms) {
              const e = relMap.get(n);
              if (e) {
                let dx = e[1], dy = e[2], dz = e[3];
                let d = e[4];
                if (d < 1e-9) { dx = 1; dy = 0.35; dz = 0.2; d = Math.hypot(dx, dy, dz); }
                if (dmax < 1e-9) dmax = 1;
                const rr = d / dmax;
                const rr2 = 0.18 + 0.82 * Math.sqrt(rr);
                const rad = gR * rr2;
                const GA = placed * Math.PI * (3 - Math.sqrt(5)) * 0.0031;
                const cosG = Math.cos(GA), sinG = Math.sin(GA);
                const ux = (dx / d) * cosG - (dy / d) * sinG;
                const uy = (dx / d) * sinG + (dy / d) * cosG;
                n.nebulaX = GA0.x + ux * rad * 0.88 + (dx / d) * rad * 0.12;
                n.nebulaY = GA0.y + uy * rad;
                n.nebulaZ = GA0.z + (dz / d) * rad * 0.45 + (hash01Lib(n.id) - 0.5) * gR * 0.16;
              } else {
                const ang = placed * Math.PI * (3 - Math.sqrt(5));
                const rr2 = 0.22 + 0.72 * Math.sqrt((placed % 17 + 0.4) / 17);
                n.nebulaX = GA0.x + Math.cos(ang) * gR * rr2;
                n.nebulaY = GA0.y + Math.sin(ang) * gR * rr2;
                n.nebulaZ = GA0.z + (hash01Lib(n.id) - 0.5) * gR * 0.3;
              }
              placed++;
            }
          }
        }
      } else {
        const byCat = new Map();
        for (const [, ms] of lm) for (const n of ms) {
          const ck = String(n.category || n.memType || 'general');
          if (!byCat.has(ck)) byCat.set(ck, []);
          byCat.get(ck).push(n);
        }
        for (const [cat, members] of byCat) {
          const key = r + '/' + cat;
          const off = constAnchor.get(key) || { x: 0, y: 0, z: 0 };
          const A = { x: A0.x + off.x, y: A0.y + off.y, z: A0.z + off.z };
          const rc = constR.get(key) || 15;
          const withU = members.filter(n => Number.isFinite(n.universeX));
          let cx = 0, cy = 0, cz = 0;
          if (withU.length) {
            cx = withU.reduce((a, n) => a + n.universeX, 0) / withU.length;
            cy = withU.reduce((a, n) => a + n.universeY, 0) / withU.length;
            cz = withU.reduce((a, n) => a + (Number.isFinite(n.universeZ) ? n.universeZ : 0), 0) / withU.length;
          }
          let dmax = 0;
          const rel = [];
          for (const n of withU) {
            const dx = n.universeX - cx, dy = n.universeY - cy, dz = (Number.isFinite(n.universeZ) ? n.universeZ : cz) - cz;
            const d = Math.hypot(dx, dy, dz) || 1e-9;
            rel.push([n, dx, dy, dz, d]);
            if (d > dmax) dmax = d;
          }
          const relMap = new Map(rel.map(e => [e[0], e]));
          let placed = 0;
          for (const n of members) {
            const e = relMap.get(n);
            if (e) {
              let dx = e[1], dy = e[2], dz = e[3];
              let d = e[4];
              if (d < 1e-9) { dx = 1; dy = 0.35; dz = 0.2; d = Math.hypot(dx, dy, dz); }
              if (dmax < 1e-9) dmax = 1;
              const rr = d / dmax;
              const rr2 = 0.18 + 0.82 * Math.sqrt(rr);
              const rad = rc * rr2;
              const GA = placed * Math.PI * (3 - Math.sqrt(5)) * 0.0031;
              const cosG = Math.cos(GA), sinG = Math.sin(GA);
              const ux = (dx / d) * cosG - (dy / d) * sinG;
              const uy = (dx / d) * sinG + (dy / d) * cosG;
              n.nebulaX = A.x + ux * rad * 0.88 + (dx / d) * rad * 0.12;
              n.nebulaY = A.y + uy * rad;
              n.nebulaZ = A.z + (dz / d) * rad * 0.45 + (hash01Lib(n.id) - 0.5) * rc * 0.16;
            } else {
              const ang = placed * Math.PI * (3 - Math.sqrt(5));
              const rr2 = 0.22 + 0.72 * Math.sqrt((placed % 17 + 0.4) / 17);
              n.nebulaX = A.x + Math.cos(ang) * rc * rr2;
              n.nebulaY = A.y + Math.sin(ang) * rc * rr2;
              n.nebulaZ = A.z + (hash01Lib(n.id) - 0.5) * rc * 0.3;
            }
            placed++;
          }
        }
      }
    }
} catch (e) { console.error('nebula layout failed:', e.message); }

const gNames = [...byGroup.keys()];
  const pairScores = [];
  for (let i = 0; i < gNames.length; i++) {
    for (let j = i + 1; j < gNames.length; j++) {
      const va = byGroup.get(gNames[i]).map(n => vecById.get(n.id)).filter(Boolean);
      const vb = byGroup.get(gNames[j]).map(n => vecById.get(n.id)).filter(Boolean);
      if (!va.length || !vb.length) continue;
      pairScores.push({ a: gNames[i], b: gNames[j], score: cosine(centroid(va), centroid(vb)) });
    }
  }
  pairScores.sort((x, y) => y.score - x.score);
  const parent = Object.fromEntries(gNames.map(g => [g, g]));
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const clusterBridges = [];
  for (const p of pairScores) {
    const a = find(p.a), b = find(p.b);
    if (a === b) continue;
    parent[a] = b;
    clusterBridges.push(p);
    if (clusterBridges.length >= Math.max(0, gNames.length - 1)) break;
  }

  const stats = { totalNodes: nodes.length, totalLinks: links.length, byType: {}, byCategory: {}, byTier: {}, byMemType: {} };
  for (const n of nodes) {
    stats.byType[n.type] = (stats.byType[n.type] || 0) + 1;
    stats.byCategory[n.category] = (stats.byCategory[n.category] || 0) + 1;
    stats.byTier[n.tier] = (stats.byTier[n.tier] || 0) + 1;
    stats.byMemType[n.memType] = (stats.byMemType[n.memType] || 0) + 1;
  }
  /* P0 星云布局:UMAP 2D + 块内密度 z(每块一个穹顶)+ 按分文件夹的块分离。
   * 缓存存"每个节点的坐标 + 每条边的标记",命中时必须重放(paintNebula);
   * 只回缓存元数据会让坐标退回旧布局 —— 这是"刷新一次新、再刷又变旧"的根因。 */
  let nebula = null;
  try {
    const prior = LAYOUT_REUSE ? loadPriorLayout(scope, project, instance) : null;
    const L = await applyNebulaLayout(nodes, links, vecById, prior, progress);
    nebula = L ? paintNebula(nodes, links, L) : { ok: false, error: 'layout unavailable' };
    if (L) savePriorLayout(scope, project, instance, L.nodeXY, L.usedUmap ? 'umap' : 'pca');
  } catch (e) {
    console.error('nebula layout failed:', e.message);
    nebula = { ok: false, error: String(e.message || e) };
  }
  progress('编码与传输', 0.94);
  const body = JSON.stringify({
    consKind: CONS_KIND,          // 星座口径:memtype(默认)/ category(实例开关)
    nodes, links, stats, clusterBridges, nebula });
  const entry = {
    sig: snapSig, body, gzip: null, builtAt: Date.now(),
    etag: '"' + createHash('sha1').update(body).digest('hex').slice(0, 20) + '"',
  };
  GRAPH_CACHE.set(cacheKey, entry);
  while (GRAPH_CACHE.size > GRAPH_CACHE_MAX) GRAPH_CACHE.delete(GRAPH_CACHE.keys().next().value);
  return entry;
}

// ═══ API: GET /api/stats ═══
router.get('/stats', (req, res) => {
  // 2026-10-28: 原来恒读本实例库 → 汇总星图(本库为空)永远返回 0,和 /api/graph 吵架。
  // 现在与 /api/graph 同一套作用域规则(未传 scope 时按实例默认,联邦实例=federation)。
  const libs = libsForScope(graphScope(req));
  if (!libs.length) return res.json({ total: 0, edges: 0 });
  let total = 0, edges = 0;
  for (const l of libs) {
    try {
      const db = openLibDb(l.file);
      if (!db) continue;
      total += db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active=1').get().c;
      try { edges += db.prepare('SELECT COUNT(*) as c FROM edges').get().c; } catch {}
      db.close();
    } catch (err) { console.error(`stats lib ${l.file} failed:`, err.message); }
  }
  res.json({ total, edges });
});

// api_key 通常为空,真实密钥在 keys.enc(AES-GCM);只看 config.api_key 会永远显示“未配置”。
function keysEncConfigured() {
  try {
    const enc = process.env.CASTALIA_KEYS_FILE || join(DB_DIR, 'keys.enc');
    const key = process.env.CASTALIA_KEY_FILE || join(DB_DIR, 'keys.key');
    return existsSync(enc) && existsSync(key);
  } catch { return false; }
}

// ═══ API: GET /api/status ═══
router.get('/status', (req, res) => {
  const cfg = loadConfig();
  const dbPath = DB_PATH;
  res.json({
    db: LEGACY_DB_PATH ? DB_PATH : DB_DIR,
    dbPath,
    config: CONFIG_PATH,
    dbExists: existsSync(dbPath) || dbDirHasData(DB_DIR),
    embedMode: cfg.embedding?.mode || 'ollama',
    reflectConfigured: !!(cfg.reflect?.api_key) || keysEncConfigured(),
    instance: instanceName(),
  consKind: CONS_KIND,
  });
});

export default router;
