/* layout-geometry.mjs — 星云布局的**纯几何**部分(主线程与 worker 共用)
 *
 * 为什么单独成文件:全量重排一次 UMAP 要 5~20s,跑在星图进程的主线程上会把事件循环整个占死
 * (2026-10-30 实测:构建期间 /api/status 连续 3 次 1s 超时 → 托盘健康探针会误判“星图掉线”并重启)。
 * 重排因此必须能进 worker_threads。这里只依赖“向量 + 分组下标”,不碰节点元数据 / express / sqlite,
 * 所以主线程(同步兜底)和 worker 跑的是同一份实现。
 *
 * onProgress(stage, pct) 里的 pct 是**本文件内部**的 0~1,由调用方映射到整体进度区间。
 */
import { createRequire } from 'node:module';

/* 随机投影降维目标:0 = 关。UMAP 算力 ≈ epoch×n×nNeighbors×d,d 从 1024 降到 32 ≈ 30 倍 */
export const PREREDUCE_DIM = (() => {
  const v = parseInt(process.env.GRAPH_UMAP_PREREDUCE || '32', 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
})();

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

function projectVectors(vectors, k = PREREDUCE_DIM) {
  if (!k || !vectors.length) return vectors;
  const d = vectors[0].length;
  if (!d || k >= d) return vectors;
  const scale = 2 / Math.sqrt(k);          /* 1/4 保留率 → 方差补偿 */
  const out = new Array(vectors.length);
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i], row = new Float64Array(k);
    for (let t = 0; t < k; t++) {
      let sum = 0;
      for (let j = 0; j < d; j++) {
        const h = (j * 2654435761 + t * 40503) >>> 0;
        if ((h & 3) !== 0) continue;       /* 3/4 跳过:省掉大部分乘法 */
        sum += (h & 4) ? -v[j] : v[j];
      }
      row[t] = sum * scale;
    }
    out[i] = row;
  }
  return out;
}

function pcaCoords(vectors, dims = 2) {
  vectors = projectVectors(vectors);   /* Gram 矩阵是 O(n²d),先在低维里算 */
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

function umapNd(vectors, dim = 3, onEpoch = null) {
  const UMAP = getUMAP();
  vectors = projectVectors(vectors);
  if (!UMAP || vectors.length < 6) return null;
  const n = vectors.length;
  const u = new UMAP({
    nComponents: dim,
    nNeighbors: Math.max(2, Math.min(32, Math.round(Math.sqrt(n) * 1.7))),
    /* Retain dense knots and sparse chains in the semantic manifold. */
    minDist: 0.30,
    spread: 1.25,
    nEpochs: n < 40 ? 200 : 350,
    random: mulberry32(42),
  });
  /* 有回调 = 先 kNN(不可切片),再每 5 epoch step() 一次并报进度;形状与一次跑完完全一致(same seed) */
  if (!onEpoch) {
    const out = u.fit(vectors);
    return out.map(p => Array.from({ length: dim }, (_, a) => Number(p[a]) || 0));
  }
  onEpoch(0, 1);                       /* kNN 阶段(不可细分,只能报“正在构建近邻图”) */
  u.initializeFit(vectors);
  const total = u.getNEpochs();
  let done = 0;
  onEpoch(done, total);
  while (done < total) {
    const end = Math.min(total, done + 5);
    while (done < end) { u.step(); done++; }
    onEpoch(done, total);
  }
  return u.embedding.map(p => Array.from({ length: dim }, (_, a) => Number(p[a]) || 0));
}

function sepBlobsND(groups, gap, dim, factor = 1) {
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
        const need = (A.r + B.r) * factor + gap;
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

function incrementalCoords(pairs, prior, groupOf) {
  const placed = new Array(pairs.length);
  let hit = 0;
  pairs.forEach((p, i) => {
    const c = prior.get(p.n.id);
    if (c && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Number.isFinite(c[2])) {
      placed[i] = [c[0], c[1], c[2]]; hit++;
    }
  });
  if (hit / pairs.length < 0.6) return null;
  const stats = new Map();   /* 块 → 质心 / 半径,只用已定位点估 */
  pairs.forEach((p, i) => {
    if (!placed[i]) return;
    const k = groupOf[i];
    if (!stats.has(k)) stats.set(k, { c: [0, 0, 0], n: 0, r: 0 });
    const st = stats.get(k);
    st.c[0] += placed[i][0]; st.c[1] += placed[i][1]; st.c[2] += placed[i][2]; st.n++;
  });
  for (const st of stats.values()) st.c = st.c.map(v => v / Math.max(1, st.n));
  pairs.forEach((p, i) => {
    if (!placed[i]) return;
    const st = stats.get(groupOf[i]);
    st.r = Math.max(st.r, Math.hypot(placed[i][0] - st.c[0], placed[i][1] - st.c[1], placed[i][2] - st.c[2]));
  });
  const pending = new Map();  /* 块 → 待落位点序号 */
  pairs.forEach((p, i) => {
    if (placed[i]) return;
    const k = groupOf[i];
    if (!pending.has(k)) pending.set(k, []);
    pending.get(k).push(i);
  });
  let fresh = 0;
  for (const k of pending.keys()) {
    if (stats.has(k)) continue;
    /* 全新星座(新库/新文件夹):沿黄金角在外围排开,别挤在星域质心上 */
    const a = 2.399963229728653 * (fresh++);
    const rad = 120 + 22 * Math.sqrt(pairs.length);
    stats.set(k, { c: [Math.cos(a) * rad, Math.sin(a) * rad * 0.6, Math.sin(a * 0.7) * rad * 0.45], n: 0, r: 26 });
  }
  for (const [k, idx] of pending) {
    const st = stats.get(k);
    const R = Math.max(14, st.r || 14);
    idx.forEach((i, j) => {
      const t = (j + 0.5) / Math.max(1, idx.length);
      const rad = R * (0.5 + 0.45 * Math.sqrt(t));
      const a = j * 2.399963229728653;
      placed[i] = [st.c[0] + rad * Math.cos(a), st.c[1] + rad * Math.sin(a),
                   st.c[2] + Math.cos(Math.sqrt(t) * Math.PI) * rad * 0.5];
    });
  }
  return placed;
}

/* 分组:块 = 主文件夹/分文件夹。返回下标数组(可跨线程传),worker 里不必知道名字 */
export function groupIndex(pairs, blobKey) {
  const keys = [], map = new Map(), groupOf = new Int32Array(pairs.length);
  for (let i = 0; i < pairs.length; i++) {
    const k = blobKey(pairs[i].n);
    let gi = map.get(k);
    if (gi === undefined) { gi = keys.length; map.set(k, gi); keys.push(k); }
    groupOf[i] = gi;
  }
  return { groupOf, keys };
}

/* 旧坐标覆盖率:>=0.6 走增量落位(毫秒级),否则全量重排(几秒~几十秒,应由 worker 跑) */
export function priorCoverage(pairs, prior) {
  if (!prior || !prior.size) return 0;
  let hit = 0;
  for (const p of pairs) {
    const c = prior.get(p.n.id);
    if (c && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Number.isFinite(c[2])) hit++;
  }
  return pairs.length ? hit / pairs.length : 0;
}

/* 几何主入口:P[i] = [x, y, z] */
export function nebulaGeometry(pairs, groupOf, prior, onProgress) {
  const prog = onProgress || (() => {});
  let usedUmap = false, incremental = false, stretch = [1, 1, 1];
  let P = (prior && prior.size) ? incrementalCoords(pairs, prior, groupOf) : null;
  if (P) {
    incremental = true;
    usedUmap = prior.mode === 'umap';
    prog('复用已有布局，插入新点', 0.55);
  }
  if (!P) {
    prog('计算语义投影', 0.05);
    let xyz = null;
    try {
      xyz = umapNd(pairs.map(p => p.v), 3, (done, total) => {
        if (done === 0) prog('构建近邻图（kNN，不可细分）', 0.10);
        else prog(`重算全局布局（UMAP ${done}/${total} 轮）`, 0.14 + 0.36 * (done / Math.max(1, total)));
      });
      usedUmap = !!xyz;
    } catch (e) { console.error('umap failed:', e.message); }
    if (!xyz) {
      prog('投影兜底（PCA）', 0.30);
      xyz = pcaCoords(pairs.map(p => p.v), 3);
    }
    if (!xyz) return null;
    /* 三轴归一化:单尺度保持各轴相对比例;再把最扁的轴抬到最大轴的 60% */
    const ext = [0, 1, 2].map(a => {
      let lo = Infinity, hi = -Infinity;
      for (const p of xyz) { if (p[a] < lo) lo = p[a]; if (p[a] > hi) hi = p[a]; }
      return { mid: (lo + hi) / 2, span: Math.max(hi - lo, 1e-6) };
    });
    const maxSpan = Math.max(ext[0].span, ext[1].span, ext[2].span);
    /* v1.23.2: 全局尺度随点数自适应扩散(以 120 点为基准,半径按 √(N/120)) */
    const countScale = Math.min(3.0, Math.sqrt(Math.max(1, pairs.length) / 120));
    const S = (190 * countScale) / maxSpan;
    stretch = ext.map(e => Math.min(Math.max((0.6 * maxSpan) / e.span, 1), 3));
    P = xyz.map(p => [0, 1, 2].map(a => (p[a] - ext[a].mid) * S * stretch[a]));
  }
  if (!incremental) {
    const groups = new Map();
    for (let i = 0; i < pairs.length; i++) {
      const k = groupOf[i];
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    }
    const gs = [...groups.entries()].map(([key, idx]) => ({ key, idx, pts: idx.map(i => P[i]) }));
    const blobCenter = (g) => [0, 1, 2].map(a =>
      g.pts.reduce((sum, p) => sum + p[a], 0) / g.pts.length);
    const total = Math.max(1, gs.length);
    gs.forEach((g, gi) => {
      const center = blobCenter(g);
      const vectors = g.idx.map(i => pairs[i].v);
      let local = null;
      try { local = umapNd(vectors, 3); } catch (e) { console.error('constellation UMAP failed:', e.message); }
      if (!local) local = pcaCoords(vectors, 3);
      const mean = [0, 1, 2].map(a => local.reduce((s, p) => s + p[a], 0) / local.length);
      const distances = local.map(p => Math.hypot(...p.map((v, a) => v - mean[a])));
      const sorted = distances.slice().sort((a, b) => a - b);
      const radius = Math.max(1e-6, sorted[Math.floor((sorted.length - 1) * 0.95)]);
      const targetRadius = 9 + 8 * Math.sqrt(Math.max(0, g.idx.length - 1));
      const scale = targetRadius / radius;
      local.forEach((p, j) => {
        const t = distances[j] / radius;
        const tail = t > 1 ? (1 + 0.28 * Math.log1p((t - 1) / 0.28)) / t : 1;
        p.forEach((v, a) => { g.pts[j][a] = center[a] + (v - mean[a]) * scale * tail; });
      });
      if (g.pts.length > 2) {
        const nearest = g.pts.map((p, i) => Math.min(...g.pts.filter((q, j) => j !== i)
          .map(q => Math.hypot(...q.map((v, a) => v - p[a]))))).sort((a, b) => a - b);
        const floor = Math.max(0.12, nearest[Math.floor(nearest.length / 2)] * 0.30);
        for (let pass = 0; pass < 8; pass++) {
          for (let i = 0; i < g.pts.length; i++) for (let j = i + 1; j < g.pts.length; j++) {
            const p = g.pts[i], q = g.pts[j];
            let d = q.map((v, a) => v - p[a]), len = Math.hypot(...d);
            if (len >= floor) continue;
            if (len < 1e-9) { d = [Math.sin(i * 7 + j), Math.cos(j * 11 + i), Math.sin(i + j * 3)]; len = Math.hypot(...d); }
            const push = (floor - Math.hypot(...q.map((v, a) => v - p[a]))) * 0.5 / len;
            for (let a = 0; a < 3; a++) { p[a] -= d[a] * push; q[a] += d[a] * push; }
          }
        }
      }
      prog('重算星座布局', 0.55 + 0.40 * ((gi + 1) / total));
    });
    const separation = sepBlobsND(gs, 8, 3, 1.10);
    for (const g of gs) {
      const delta = separation.get(g.key);
      for (const p of g.pts) for (let a = 0; a < 3; a++) p[a] += delta[a];
    }
  }
  prog('布局就绪', 1);
  return { P, usedUmap, incremental, stretch };
}

/* 平铺成 Float32Array(跨线程零拷贝传输) */
export function flattenVectors(pairs) {
  const n = pairs.length, dim = pairs[0].v.length;
  const flat = new Float32Array(n * dim);
  for (let i = 0; i < n; i++) flat.set(pairs[i].v, i * dim);
  return { flat, n, dim };
}

export { projectVectors, pcaCoords, pca2d, umapNd, sepBlobsND };
