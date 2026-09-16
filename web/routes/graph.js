/* routes/graph.js — /api/graph /api/stats /api/status */
import { Router } from 'express';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { DB_DIR, DB_PATH, LEGACY_DB_PATH, CONFIG_PATH, loadConfig, openLibDb, libFiles, currentInstanceLibs, dbDirHasData, AGGREGATE_DIRS } from './lib.js';

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
const NEBULA_CACHE = new Map();   /* P0:星云布局缓存(键=scope|节点数|最新时间戳;存坐标+边标记,命中时重放) */

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
function graphScope(req) {
  return String(req.query.scope || process.env.GRAPH_SCOPE || 'local').toLowerCase();
}
function libsForScope(scope) {
  if (scope === 'federation' || scope === 'all' || scope === 'fed') return libFiles();
  return currentInstanceLibs();
}
function instanceName() {
  const self = AGGREGATE_DIRS.find(c => c.dir === DB_DIR);
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
function pcaCoords(vectors, dims = 2) {
  const n = vectors.length;
  const k = Math.max(1, Math.min(dims, 3));
  if (!n) return [];
  if (n === 1) return [Array.from({ length: k }, () => 0)];
  if (n === 2) {
    const row0 = Array.from({ length: k }, () => 0); row0[0] = -1;
    const row1 = Array.from({ length: k }, () => 0); row1[0] = 1;
    return [row0, row1];
  }
  const d = vectors[0].length;
  const mean = new Float64Array(d);
  for (let i = 0; i < n; i++) {
    const v = vectors[i];
    for (let t = 0; t < d; t++) mean[t] += v[t];
  }
  for (let t = 0; t < d; t++) mean[t] /= n;
  const X = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = vectors[i], row = new Float64Array(d);
    for (let t = 0; t < d; t++) row[t] = v[t] - mean[t];
    X[i] = row;
  }
  const G = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      const a = X[i], b = X[j];
      for (let t = 0; t < d; t++) s += a[t] * b[t];
      G[i][j] = G[j][i] = s;
    }
  }
  function power(excludes) {
    const list = excludes || [];
    const u = new Float64Array(n);
    for (let i = 0; i < n; i++) u[i] = Math.sin(i * 1.718 + 0.31);
    function ortho(vec) {
      for (const ex of list) {
        let dot = 0;
        for (let i = 0; i < n; i++) dot += vec[i] * ex[i];
        for (let i = 0; i < n; i++) vec[i] -= dot * ex[i];
      }
    }
    ortho(u);
    let norm = 0;
    for (let i = 0; i < n; i++) norm += u[i] * u[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < n; i++) u[i] /= norm;
    for (let it = 0; it < 36; it++) {
      const v = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        const row = G[i];
        for (let j = 0; j < n; j++) s += row[j] * u[j];
        v[i] = s;
      }
      ortho(v);
      norm = 0;
      for (let i = 0; i < n; i++) norm += v[i] * v[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < n; i++) u[i] = v[i] / norm;
    }
    let lam = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += G[i][j] * u[j];
      lam += u[i] * s;
    }
    return { u, lam };
  }
  const axes = [];
  const used = [];
  for (let a = 0; a < k; a++) {
    const e = power(used);
    used.push(e.u);
    axes.push(e);
  }
  const scales = axes.map(e => Math.sqrt(Math.max(e.lam, 0)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let a = 0; a < k; a++) row.push(axes[a].u[i] * scales[a]);
    out.push(row);
  }
  return out;
}
function pca2d(vectors) { return pcaCoords(vectors, 2); }

/* ═══════════════════════════════════════════════════════════════════
 * P0 星云布局(2026-09-13)
 * 口径:形状由点自己长(橡皮泥),不画球/不缩容器;块 = L2 分文件夹(lib+memType);
 *      块间留真空;UMAP 保"近的像一伙";z 只取 XY 的 ~15%(扁星盘,转相机不散)。
 * 产出:nebulaX/Y/Z(覆盖旧布局 → 前端零改动就能看到新排布)、embX/Y/Z、blobId,
 *      以及 nebula:{blobs[], metaEdges[]}(块轮廓/元边,供图例与干道使用)。
 * 依赖:vendor/umap-js(离线自包含);UMAP 失败自动退回 PCA,绝不影响主图返回。
 * ═══════════════════════════════════════════════════════════════════ */
let _UMAP = null;
function getUMAP() {
  if (_UMAP === null) {
    try {
      const req = createRequire(import.meta.url);
      _UMAP = req('../public/vendor/umap-js/index.js').UMAP || false;
    } catch (e) { console.error('umap-js vendor load failed:', e.message); _UMAP = false; }
  }
  return _UMAP || null;
}
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function umapNd(vectors, dim = 3) {
  const UMAP = getUMAP();
  if (!UMAP || vectors.length < 6) return null;
  const n = vectors.length;
  const u = new UMAP({
    nComponents: dim,
    nNeighbors: Math.max(2, Math.min(15, Math.round(Math.sqrt(n)))),
    minDist: 0.45,
    spread: 1.0,
    nEpochs: n < 40 ? 200 : 350,
    random: mulberry32(42),
  });
  const out = u.fit(vectors);
  return out.map(p => Array.from({ length: dim }, (_, a) => Number(p[a]) || 0));
}
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
function sepBlobsND(groups, gap, dim) {
  const D = dim || 3;
  const meta = groups.map(g => {
    const c = new Array(D).fill(0);
    for (const p of g.pts) for (let a = 0; a < D; a++) c[a] += p[a] / g.pts.length;
    let r = 0;
    for (const p of g.pts) {
      let s2 = 0;
      for (let a = 0; a < D; a++) s2 += (p[a] - c[a]) * (p[a] - c[a]);
      r = Math.max(r, Math.sqrt(s2));
    }
    return { key: g.key, c, r: Math.max(r, 1e-6) };
  });
  const off = new Map(meta.map(m => [m.key, new Array(D).fill(0)]));
  for (let it = 0; it < 240; it++) {
    let moved = false;
    for (let i = 0; i < meta.length; i++) {
      for (let j = i + 1; j < meta.length; j++) {
        const A = meta[i], B = meta[j];
        const oa = off.get(A.key), ob = off.get(B.key);
        const d = new Array(D);
        let dist2 = 0;
        for (let a = 0; a < D; a++) { d[a] = (B.c[a] + ob[a]) - (A.c[a] + oa[a]); dist2 += d[a] * d[a]; }
        const dist = Math.sqrt(dist2) || 1e-6;
        const need = A.r + B.r + gap;
        if (dist < need) {
          const k = (need - dist) / 2 / dist;
          for (let a = 0; a < D; a++) { oa[a] -= d[a] * k; ob[a] += d[a] * k; }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return off;
}
function applyNebulaLayout(nodes, links, vecById) {
  const pairs = nodes.map(n => ({ n, v: vecById.get(n.id) })).filter(p => p.v);
  if (pairs.length < 6) return null;
  let xyz = null, usedUmap = false;
  try { xyz = umapNd(pairs.map(p => p.v), 3); usedUmap = !!xyz; } catch (e) { console.error('umap failed:', e.message); }
  if (!xyz) xyz = pcaCoords(pairs.map(p => p.v), 3);   /* 兜底:PCA 三维 */
  if (!xyz) return null;
  /* 三轴归一化:单尺度保持各轴相对比例;再把最扁的轴抬到最大轴的 60%
   * (只做比例校正,不改点序 —— 目的是别让"第三个方向"塌成纸片) */
  const ext = [0, 1, 2].map(a => {
    let lo = Infinity, hi = -Infinity;
    for (const p of xyz) { if (p[a] < lo) lo = p[a]; if (p[a] > hi) hi = p[a]; }
    return { mid: (lo + hi) / 2, span: Math.max(hi - lo, 1e-6) };
  });
  const maxSpan = Math.max(ext[0].span, ext[1].span, ext[2].span);
  const S = 190 / maxSpan;
  const stretch = ext.map(e => Math.min(Math.max((0.6 * maxSpan) / e.span, 1), 3));
  const P = xyz.map(p => [0, 1, 2].map(a => (p[a] - ext[a].mid) * S * stretch[a]));
  /* 块 = 主文件夹/分文件夹 两层 */
  const blobKey = (n) => `${n.layoutGroup || n.instance || n.lib || n.project || 'default'}/${consKeyOf(n)}`;
  const groups = new Map();
  pairs.forEach((p, i) => {
    const k = blobKey(p.n);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  const gs = [...groups.entries()].map(([key, idx]) => ({ key, idx, pts: idx.map(i => P[i]) }));
  /* ── v1.20 按个数排布(用户口径:按个数排布,不然肯定挤)───────────────────
   * ①块半径随点数增长:自锚定 R = R_med × (n/n_med)^0.45 —— 中位块保持原尺寸,
   *   98 点的块会比 3 点的块大好几倍(修前只大 1.6 倍,点的密度差 20 倍 = "挤")。
   * ②点间距由个数反推:minSep = 0.85 × R/√n,于是"每个点占的视觉空间"与点数无关。
   * ③仍然只推"近到糊住"的点对,不改整体形状。 */
  const blobCen = (g) => {
    const c = [0, 0, 0];
    for (const p of g.pts) for (let a = 0; a < 3; a++) c[a] += p[a] / g.pts.length;
    return c;
  };
  const blobRad = (g, c) => {
    let r = 0;
    for (const p of g.pts) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
    return r;
  };
  const nMed = gs.map(g => g.idx.length).sort((a, b) => a - b)[Math.floor(gs.length / 2)] || 1;
  const rSort = gs.map(g => blobRad(g, blobCen(g))).sort((a, b) => a - b);
  const rMed = rSort[Math.floor(rSort.length / 2)] || 1;
  for (const g of gs) {
    const c = blobCen(g), R = blobRad(g, c);
    if (R < 1e-6) continue;
    const Rt = rMed * Math.pow(Math.max(1, g.idx.length) / nMed, 0.45);
    const k = Math.min(6, Math.max(0.35, Rt / R));
    for (const p of g.pts) for (let a = 0; a < 3; a++) p[a] = c[a] + (p[a] - c[a]) * k;
  }
  for (const g of gs) {
    const c0 = blobCen(g), R0 = blobRad(g, c0);
    const minSep = Math.max(0.6, 0.85 * R0 / Math.sqrt(Math.max(1, g.idx.length)));   /* 按个数定间距 */
    /* 完全重合的点对没有方向可用 → 用索引哈希给一个确定性微推(不用随机数,保证可复现) */
    const nudge = (a, b) => ((a * 7919 + b * 104729) % 1000) / 1000 - 0.5;
    for (let it = 0; it < 24; it++) {
      let moved = 0;
      for (let a = 0; a < g.idx.length; a++) {
        for (let b = a + 1; b < g.idx.length; b++) {
          const p = P[g.idx[a]], q = P[g.idx[b]];
          const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
          let L = Math.hypot(d[0], d[1], d[2]);
          if (L >= minSep) continue;
          if (L < 1e-6) { d[0] = nudge(a, b); d[1] = nudge(b, a); d[2] = nudge(a + 1, b + 2); L = Math.hypot(d[0], d[1], d[2]) || 1; }
          const push = (minSep - L) / 2 / L;
          for (let c = 0; c < 3; c++) { p[c] -= d[c] * push; q[c] += d[c] * push; }
          moved++;
        }
      }
      if (!moved) break;
    }
  }
  /* ── v1.21 跨系节点上外缘(用户口径:"按连线位置排布,需要跨系的放在外面")──────────
   * 有跨块连线的节点,被拉到所在块"朝向对端块"那一侧的外缘。
   * 目的:干道/细丝从**外缘**出发,不再从腹地拉一条线穿过本团主节点(用户:直突突穿过主节点,极其奇怪)。 */
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const cenOf = new Map(gs.map(g => [g.key, blobCen(g)]));
  const crossDir = new Map(), crossN = new Map(), degAll = new Map();
  for (const l of links) {
    const a = nodeById.get(typeof l.source === 'object' ? l.source.id : l.source);
    const b = nodeById.get(typeof l.target === 'object' ? l.target.id : l.target);
    if (!a || !b) continue;
    degAll.set(a.id, (degAll.get(a.id) || 0) + 1);
    degAll.set(b.id, (degAll.get(b.id) || 0) + 1);
    const ka = blobKey(a), kb = blobKey(b);
    if (ka === kb) continue;
    const w = (l.strength != null ? l.strength : 0.5) + 0.001;
    for (const [from, toKey] of [[a, kb], [b, ka]]) {
      const cs = cenOf.get(blobKey(from)), cp = cenOf.get(toKey);
      if (!cs || !cp) continue;
      const d = [cp[0] - cs[0], cp[1] - cs[1], cp[2] - cs[2]];
      const dl = Math.hypot(d[0], d[1], d[2]) || 1;
      const acc = crossDir.get(from.id) || [0, 0, 0];
      acc[0] += d[0] / dl * w; acc[1] += d[1] / dl * w; acc[2] += d[2] / dl * w;
      crossDir.set(from.id, acc);
      crossN.set(from.id, (crossN.get(from.id) || 0) + 1);
    }
  }
  for (const g of gs) {
    const c = cenOf.get(g.key), R = blobRad(g, c);
    g.idx.forEach((i, k) => {
      const nd = pairs[i].n;
      const dir = crossDir.get(nd.id);
      if (!dir) return;                                   /* 纯块内节点:不动,保持语义位置 */
      const dl = Math.hypot(dir[0], dir[1], dir[2]);
      if (dl < 1e-6) return;
      const u = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
      const p = P[i];
      let r = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      const rl = Math.hypot(r[0], r[1], r[2]) || 1e-6;
      const keep = Math.min(1, rl / Math.max(1e-6, R));
      r = [r[0] / rl, r[1] / rl, r[2] / rl];
      /* 外向度 = 跨块连线数 ÷ 总连线数。90% 的点都沾跨块连线 —— 全推到外缘会把团掏空成环,
       * 所以按外向度**平滑部分推进**:内向的留在原地(团保住体积),主要靠跨系连接的才上外缘。 */
      const cn = crossN.get(nd.id) || 0;
      const outRatio = cn / Math.max(1, degAll.get(nd.id) || cn);
      const pushK = Math.max(0, Math.min(1, (outRatio - 0.25) / 0.60)) * 0.90;
      if (pushK <= 0.01) return;
      const B = 0.30 + 0.45 * pushK;                      /* 方向:部分朝对端,保留语义切向 */
      let v = [r[0] * (1 - B) + u[0] * B, r[1] * (1 - B) + u[1] * B, r[2] * (1 - B) + u[2] * B];
      const vl = Math.hypot(v[0], v[1], v[2]) || 1;
      v = [v[0] / vl, v[1] / vl, v[2] / vl];
      const targetR = R * (0.62 + 0.34 * Math.min(1, cn / 4));   /* 外向度越高越贴边(最多 0.96R) */
      const radFinal = rl * (1 - pushK) + targetR * pushK;
      for (let a2 = 0; a2 < 3; a2++) p[a2] = c[a2] + v[a2] * radFinal;
    });
  }
  /* 上外缘后再轻推 6 轮,避免贴边时互相重叠 */
  for (const g of gs) {
    const c0 = blobCen(g), R0 = blobRad(g, c0);
    const minSep = Math.max(0.6, 0.80 * R0 / Math.sqrt(Math.max(1, g.idx.length)));
    const nudge = (a, b) => ((a * 7919 + b * 104729) % 1000) / 1000 - 0.5;
    for (let it = 0; it < 6; it++) {
      let moved = 0;
      for (let a = 0; a < g.idx.length; a++) {
        for (let b = a + 1; b < g.idx.length; b++) {
          const p = P[g.idx[a]], q = P[g.idx[b]];
          const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
          let L = Math.hypot(d[0], d[1], d[2]);
          if (L >= minSep) continue;
          if (L < 1e-6) { d[0] = nudge(a, b); d[1] = nudge(b, a); d[2] = nudge(a + 1, b + 2); L = Math.hypot(d[0], d[1], d[2]) || 1; }
          const push = (minSep - L) / 2 / L;
          for (let c2 = 0; c2 < 3; c2++) { p[c2] -= d[c2] * push; q[c2] += d[c2] * push; }
          moved++;
        }
      }
      if (!moved) break;
    }
  }
  const blobCenter = blobCen;   /* 兼容后续调用点 */
  const radii = gs.map(g => {
    const c = blobCenter(g);
    let r = 0;
    for (const p of g.pts) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
    return r;
  }).sort((a, b) => a - b);
  const medR = radii[Math.floor(radii.length / 2)] || 25;
  const off = sepBlobsND(gs, medR * 1.15, 3);   /* 三维刚性分离 → 三个方向都留真空 */
  for (const g of gs) {
    const o = off.get(g.key) || [0, 0, 0];
    for (const i of g.idx) { P[i][0] += o[0]; P[i][1] += o[1]; P[i][2] += o[2]; }
  }
  /* 写回节点(同时记入 nodeXY:缓存命中时用它重放坐标,否则节点会退回旧布局) */
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
  return { ok: true, usedUmap, blobs, metaEdges, nodeXY, linkFlags, nodeCount: pairs.length, extents: ex, zRatio, stretch: stretch.map(v => Math.round(v * 100) / 100) };
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
  return { ok: true, usedUmap: L.usedUmap, blobs: L.blobs, metaEdges: L.metaEdges, nodeCount: L.nodeCount, zRatio: L.zRatio, extents: L.extents, stretch: L.stretch, cached: !!L.cached };
}
function hash01Lib(id) {
  const s = String(id || '') + ':neb';
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

router.get('/graph', (req, res) => {
  const scope = graphScope(req);
  const fed = isFedScope(scope);
  const libs = libsForScope(scope);
  const nodes = [];
  const links = [];
  const vecById = new Map();
  let totalMemories = 0;
  const categoryColors = {
    emotional: '#FF6B6B', milestone: '#FFA726', identity: '#66BB6A',
    relationship: '#42A5F5', mood_snapshot: '#FFD54F', conversation: '#AB47BC',
    knowledge: '#26A69A', preference: '#EC407A', decision: '#FFA726',
    mistake: '#EF5350', general: '#78909C',
  };
  for (const lib of libs) {
    let db = null;
    try {
      db = openLibDb(lib.file);
      if (!db) continue;
      const memories = db.prepare(`
        SELECT id, text, project, type, mem_type, category, subcategory, tags,
               importance, character_id, source,
               subject, tier, expires_at, created_at, accessed_count
        FROM memory WHERE is_active = 1 ORDER BY created_at ASC
      `).all();
      totalMemories += memories.length;

      let edges = [];
      try { edges = db.prepare('SELECT source_id, target_id, relation_type FROM edges').all(); } catch {}

      const libNodes = memories.map(m => {
        let tags = [];
        try { tags = JSON.parse(m.tags || '[]'); } catch {}
        const isTemporary = m.tier === 'temporary';
        const isCritical = m.tier === 'critical';
        return {
          id: `${lib.project}:${m.id}`,
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

      const idSet = new Set(libNodes.map(n => n.id));
      for (const e of edges) {
        const s = `${lib.project}:${e.source_id}`, t = `${lib.project}:${e.target_id}`;
        if (idSet.has(s) && idSet.has(t)) {
          links.push({ source: s, target: t, type: e.relation_type, strength: edgeStrength(e.relation_type) });
        }
      }

      try {
        const vecRows = db.prepare(`
          SELECT m.id, v.embedding FROM memory m
          JOIN vec_memory v ON m.rowid = v.rowid WHERE m.is_active = 1
        `).all();
        for (const r of vecRows) {
          const vec = parseVec(r.embedding);
          if (vec) vecById.set(`${lib.project}:${r.id}`, vec);
        }
      } catch (e) { console.error('vec load failed:', e.message); }

      // 库内相似度链接(v1.18.11:上限 100→400,大库不再整库断链)
      if (libNodes.length > 0 && libNodes.length <= 400) {
        try {
          const embeddings = libNodes
            .map(n => ({ id: n.id, vec: vecById.get(n.id) }))
            .filter(x => x.vec);
          const cosSim = (a, b) => {
            let dot = 0, ma = 0, mb = 0;
            for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
            return dot / (Math.sqrt(ma) * Math.sqrt(mb));
          };
          const SIM_THRESHOLD = 0.65;
          const existing = new Set(links.map(l => `${l.source}|${l.target}`));
          for (let i = 0; i < embeddings.length; i++) {
            const sims = [];
            for (let j = 0; j < embeddings.length; j++) {
              if (i === j) continue;
              sims.push({ id: embeddings[j].id, sim: cosSim(embeddings[i].vec, embeddings[j].vec) });
            }
            sims.sort((a, b) => b.sim - a.sim);
            for (const s of sims.slice(0, 2)) {
              if (s.sim < SIM_THRESHOLD) break;
              const k1 = `${embeddings[i].id}|${s.id}`, k2 = `${s.id}|${embeddings[i].id}`;
              if (!existing.has(k1) && !existing.has(k2)) {
                links.push({ source: embeddings[i].id, target: s.id, type: 'similarity', similarity: Math.round(s.sim * 100) / 100, strength: edgeStrength('similarity', Math.round(s.sim * 100) / 100) });
                existing.add(k1);
              }
            }
          }
        } catch (e) { console.error('Similarity links failed:', e.message); }
      }

      nodes.push(...libNodes);
    } catch (e) { console.error(`graph lib ${lib.file} failed:`, e.message); }
    finally { if (db) db.close(); }
  }

  /* v1.18.11 跨库相似边:同星域内、不同主文件夹(星座)之间 top-2——库间干线原料。
   * 星座=库之后,库内边全是同星座(淡线),星门干线必须靠跨库边。单库星域(AIRI)自动跳过。 */
  try {
    const byInst = new Map();
    for (const n of nodes) {
      const k = String(n.layoutGroup || 'default');
      if (!byInst.has(k)) byInst.set(k, []);
      byInst.get(k).push(n);
    }
    const existing = new Set(links.map(l => `${l.source}|${l.target}`));
    const CROSS_SIM = 0.55;
    for (const [, ns] of byInst) {
      const libs = new Set(ns.map(n => n.lib || 'default'));
      if (libs.size < 2) continue; /* 单库星域无跨库概念 */
      const withV = ns.map(n => ({ n, v: vecById.get(n.id) })).filter(x => x.v);
      if (withV.length < 4) continue;
      for (let i = 0; i < withV.length; i++) {
        const a = withV[i];
        const sims = [];
        for (let j = 0; j < withV.length; j++) {
          if (i === j) continue;
          const b = withV[j];
          if (String(b.n.lib || 'default') === String(a.n.lib || 'default')) continue; /* 只跨库 */
          sims.push({ id: b.n.id, sim: cosine(a.v, b.v) });
        }
        sims.sort((x, y) => y.sim - x.sim);
        for (const s of sims.slice(0, 2)) {
          if (s.sim < CROSS_SIM) break;
          const k1 = `${a.n.id}|${s.id}`, k2 = `${s.id}|${a.n.id}`;
          if (existing.has(k1) || existing.has(k2)) continue;
          existing.add(k1);
          links.push({ source: a.n.id, target: s.id, type: 'similarity', similarity: Math.round(s.sim * 100) / 100, strength: edgeStrength('similarity', Math.round(s.sim * 100) / 100) });
        }
      }
    }
  } catch (e) { console.error('cross-lib links failed:', e.message); }

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
   * n×n Gram 矩阵,节点过多时抽样,失败不影响主图返回 */
  try {
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
    const newest = nodes.reduce((m, n) => (n.createdAt > m ? n.createdAt : m), '');
    const ck = `${graphScope(req)}|${nodes.length}|${newest}`;
    let L = NEBULA_CACHE.get(ck) || null;
    if (!L) {
      L = applyNebulaLayout(nodes, links, vecById);
      if (L) NEBULA_CACHE.set(ck, L);
    } else {
      L.cached = true;
    }
    nebula = L ? paintNebula(nodes, links, L) : { ok: false, error: 'layout unavailable' };
  } catch (e) {
    console.error('nebula layout failed:', e.message);
    nebula = { ok: false, error: String(e.message || e) };
  }
  res.json({
    consKind: CONS_KIND,          // 星座口径:memtype(默认)/ category(实例开关)
    nodes, links, stats, clusterBridges, nebula });
});

// ═══ API: GET /api/stats ═══
router.get('/stats', (req, res) => {
  const libs = currentInstanceLibs();
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
    reflectConfigured: !!(cfg.reflect?.api_key),
    instance: instanceName(),
  consKind: CONS_KIND,
  });
});

export default router;
