/* routes/graph.js — /api/graph /api/stats /api/status */
import { Router } from 'express';
import { existsSync } from 'fs';
import { DB_DIR, DB_PATH, LEGACY_DB_PATH, CONFIG_PATH, loadConfig, openLibDb, libFiles, currentInstanceLibs, dbDirHasData, AGGREGATE_DIRS } from './lib.js';

const router = Router();

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
  return proj || 'default';
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

      // 库内相似度链接(该库 <=100 节点时)
      if (libNodes.length > 0 && libNodes.length <= 100) {
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
  res.json({ nodes, links, stats, clusterBridges });
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
  });
});

export default router;
