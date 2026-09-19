/* ══════════════════════════════════════════════════════════════════════════
   app-05-star.js — 星图视图:renderStar / 星图图例 / 视图切换
   (2026-09-19 从单文件 app.js 按段落边界切出;加载顺序即依赖顺序,
    全部是普通 script,共享同一个全局作用域 —— 不要在这些文件之间挪动顺序)
   ═══════════════════════════════════════════════════════════════════════ */
function onStarNodeClick(node) {
  if (!node) return;
  if (node.group === 'galaxy-core') return onGalaxyCoreClick(node);
  if (node.group === 'subgalaxy-core') return onSubGalaxyCoreClick(node);
  if (node.group === 'nebula-inst-core' || node.group === 'nebula-lib-core') return onNebulaStructClick(node);
  stopAutoTour();
  selectedNodeId = node.id;
  /* v1.18.8 选中态三档亮度:主点 0.95 / 一跳邻居 0.30 弱亮 / 其余 dim——
     修复"点一个点跳出一堆亮点"(原来邻居与主点同亮) */
  hoverSet = null;
  selNeighbors = oneHopNeighbors(node.id);
  refreshNodeVisuals();
  showPanel(node);
  if (graphInstance) {
    graphInstance.linkVisibility(l => lodLinkVisible(l));
    try { graphInstance.nodeColor(n => selectedNodeId === n.id ? '#ffffff' : memColor(n)); } catch (e) {}
  }
  flyTo(node, 900);
}

function renderStar(data) {
  window.__galaxyMode = true;
  hoverSet = null; hoveredNodeId = null;   // 重渲染时清空悬停状态
  /* 清理上一次追加的合成边(renderStar 会被多次调用,避免重复) */
  data.links = (data.links || []).filter(l =>
    l.type !== 'galaxy-bridge' && l.type !== 'subgalaxy-spoke' && l.type !== 'subgalaxy-bridge');
  /* 多种星系形态：旋涡 / 棒旋 / 椭圆 / 环状 / 不规则。实例按数据或名字各用一种。 */
  const memTypeOf = n => n.memType || 'general';
  const hash01 = (i, salt) => {
    const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const basisFromNormal = (nx, ny, nz) => {
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    let ax = 0, ay = 1, az = 0;
    if (Math.abs(ny) > 0.92) { ax = 1; ay = 0; }
    let ux = ay * nz - az * ny, uy = az * nx - ax * nz, uz = ax * ny - ay * nx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    return {
      n: { x: nx, y: ny, z: nz },
      u: { x: ux, y: uy, z: uz },
      v: { x: ny * uz - nz * uy, y: nz * ux - nx * uz, z: nx * uy - ny * ux },
    };
  };
  const toWorld = (c, f, lx, ly, lz) => ({
    x: c.x + f.u.x * lx + f.v.x * ly + f.n.x * lz,
    y: c.y + f.u.y * lx + f.v.y * ly + f.n.y * lz,
    z: c.z + f.u.z * lx + f.v.z * ly + f.n.z * lz,
  });

  data.nodes.forEach(n => {
    n.size = 2.2 + (n.importance || 0.5) * 2.4;
    n.starred = (n.importance || 0.5) >= 0.9;
  });

  const groups = [...new Set(data.nodes.map(structKey))];
  const galaxyMorph = {};
  groups.forEach((p, gi) => {
    const ns = data.nodes.filter(n => structKey(n) === p);
    galaxyMorph[p] = pickGalaxyMorph(p, ns.length, new Set(ns.map(memTypeOf)).size, gi);
  });
  window.__galaxyMorph = galaxyMorph;
  const clusters = [];
  groups.forEach((p, gi) => {
    const items = [];
    MEM_TYPE_ORDER.forEach(mt => {
      const ns = data.nodes.filter(n => structKey(n) === p && memTypeOf(n) === mt);
      if (!ns.length) return;
      items.push({ p, mt, nodes: ns });
    });
    if (!items.length) return;
    const morph = galaxyMorph[p];
    const nArms = Math.max(items.length, 1);
    const gap = 5.6;
    const twist = (gi % 2 === 0 ? 1 : -1) * (morph === 'barred' ? 1.15 : 1.45);
    const showCap = 48;
    const barType = items.slice().sort((a, b) => b.nodes.length - a.nodes.length)[0].mt;
    items.forEach((it, ai) => {
      it.sorted = it.nodes.slice().sort((a, b) => (b.importance || 0) - (a.importance || 0));
      it.showN = Math.min(it.sorted.length, showCap);
      it.packR = gap * Math.sqrt(it.showN + 0.4) + 8;
      it.gap = gap;
      it.armIndex = ai;
      it.nArms = nArms;
      it.twist = twist;
      it.morph = morph;
      it.isBar = morph === 'barred' && it.mt === barType;
    });
    items.forEach(it => clusters.push(it));
  });

  /* 两层不混：四座相对位置不动；座内每个文件夹占一块扇区；扇区内才用 embedding。 */
  const CORE_CLEAR = 22;
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const visR = 6.4;
  function collide2d(pts, minDist, iters) {
    for (let iter = 0; iter < iters; iter++) {
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i].__local, b = pts[j].__local;
          let dx = b.lx - a.lx, dy = b.ly - a.ly;
          const d = Math.hypot(dx, dy) || 1e-6;
          if (d < minDist) {
            const push = (minDist - d) * 0.46;
            dx /= d; dy /= d;
            a.lx -= dx * push; a.ly -= dy * push;
            b.lx += dx * push; b.ly += dy * push;
          }
        }
      }
    }
  }
  function layoutFolderWedge(nodes, a0, a1, r0, r1) {
    const pad = Math.max(0.08, (a1 - a0) * 0.14);
    const t0 = a0 + pad, t1 = a1 - pad;
    const has = nodes.filter(n => Number.isFinite(n.atlasX) && Number.isFinite(n.atlasY));
    const rest = nodes.filter(n => !has.includes(n));
    if (has.length >= 2) {
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      has.forEach(n => {
        minx = Math.min(minx, n.atlasX); maxx = Math.max(maxx, n.atlasX);
        miny = Math.min(miny, n.atlasY); maxy = Math.max(maxy, n.atlasY);
      });
      const dx = Math.max(maxx - minx, 1e-6), dy = Math.max(maxy - miny, 1e-6);
      has.forEach(n => {
        const u = (n.atlasX - minx) / dx;
        const v = (n.atlasY - miny) / dy;
        const theta = t0 + u * (t1 - t0);
        const rr = r0 + (0.18 + 0.82 * v) * (r1 - r0);
        n.__local = { lx: rr * Math.cos(theta), ly: rr * Math.sin(theta), lz: 0 };
      });
      collide2d(has, visR * 1.9, 22);
      has.forEach(n => {
        let th = Math.atan2(n.__local.ly, n.__local.lx);
        let r = Math.hypot(n.__local.lx, n.__local.ly);
        while (th < t0) th += Math.PI * 2;
        while (th > t1) th -= Math.PI * 2;
        th = Math.max(t0, Math.min(t1, th));
        r = Math.max(r0, Math.min(r1, r));
        n.__local.lx = r * Math.cos(th);
        n.__local.ly = r * Math.sin(th);
      });
    }
    rest.forEach((n, i) => {
      const t = rest.length <= 1 ? 0.5 : (i + 0.5) / rest.length;
      const theta = t0 + t * (t1 - t0);
      const rr = r0 + (0.35 + 0.45 * ((i * 0.37) % 1)) * (r1 - r0);
      n.__local = { lx: rr * Math.cos(theta), ly: rr * Math.sin(theta), lz: 0 };
    });
  }
  groups.forEach(p => {
    const items = clusters.filter(c => c.p === p);
    if (!items.length) return;
    const weights = items.map(it => Math.sqrt(it.nodes.length) + 0.6);
    const sumW = weights.reduce((a, b) => a + b, 0);
    let ang = -Math.PI / 2;
    items.forEach((it, i) => {
      const span = (weights[i] / sumW) * Math.PI * 2;
      const r1 = CORE_CLEAR + visR * 3.2 * Math.sqrt(Math.max(it.nodes.length, 2));
      layoutFolderWedge(it.nodes, ang, ang + span, CORE_CLEAR, r1);
      const mid = ang + span / 2;
      const rc = (CORE_CLEAR + r1) * 0.55;
      it.clx = rc * Math.cos(mid);
      it.cly = rc * Math.sin(mid);
      it.clz = 0;
      it.packR = (r1 - CORE_CLEAR) * 0.5;
      ang += span;
    });
  });

  const groupBound = {};
  groups.forEach(p => {
    let maxr = CORE_CLEAR;
    data.nodes.forEach(n => {
      if (structKey(n) !== p || !n.__local) return;
      maxr = Math.max(maxr, Math.hypot(n.__local.lx, n.__local.ly) + visR);
    });
    groupBound[p] = maxr + 24;
  });

  const galaxyFrame = {};
  {
    const view = { x: 0.78, y: 0.52, z: 1.18 };
    const vl = Math.hypot(view.x, view.y, view.z) || 1;
    view.x /= vl; view.y /= vl; view.z /= vl;
    const vb = basisFromNormal(view.x, view.y, view.z);
    groups.forEach((p, i) => {
      const morph = galaxyMorph[p];
      const tilt = ((morph === 'elliptical' || morph === 'irregular') ? 52 : 26 + (i * 8) % 14) * Math.PI / 180;
      const roll = i * 1.73 + 0.35;
      const px = vb.u.x * Math.cos(roll) + vb.v.x * Math.sin(roll);
      const py = vb.u.y * Math.cos(roll) + vb.v.y * Math.sin(roll);
      const pz = vb.u.z * Math.cos(roll) + vb.v.z * Math.sin(roll);
      const s = Math.sin(tilt), c = Math.cos(tilt);
      galaxyFrame[p] = basisFromNormal(view.x * c + px * s, view.y * c + py * s, view.z * c + pz * s);
    });
  }

  const galaxyCenter = {};
  if (groups.length === 1) {
    galaxyCenter[groups[0]] = { x: 0, y: 0, z: 0 };
  } else {
    const dirs = [];
    if (groups.length === 2) {
      dirs.push({ x: -1, y: 0.28, z: -0.62 }, { x: 1, y: -0.22, z: 0.62 });
    } else if (groups.length === 3) {
      dirs.push({ x: 1, y: 0.25, z: 0.48 }, { x: -0.62, y: 0.72, z: -0.5 }, { x: -0.48, y: -0.78, z: 0.38 });
    } else if (groups.length === 4) {
      dirs.push({ x: 1, y: 1, z: 1 }, { x: 1, y: -1, z: -1 }, { x: -1, y: 1, z: -1 }, { x: -1, y: -1, z: 1 });
    } else {
      groups.forEach((_, i) => {
        const phi = Math.acos(1 - 2 * (i + 0.5) / groups.length);
        const theta = Math.PI * (1 + Math.sqrt(5)) * i;
        dirs.push({
          x: Math.sin(phi) * Math.cos(theta),
          y: Math.sin(phi) * Math.sin(theta),
          z: Math.cos(phi),
        });
      });
    }
    dirs.forEach(d => {
      const l = Math.hypot(d.x, d.y, d.z) || 1;
      d.x /= l; d.y /= l; d.z /= l;
    });
    let scale = 1;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const dist = Math.hypot(dirs[i].x - dirs[j].x, dirs[i].y - dirs[j].y, dirs[i].z - dirs[j].z);
        const need = groupBound[groups[i]] + groupBound[groups[j]] + 90;
        if (dist > 1e-6) scale = Math.max(scale, need / dist);
      }
    }
    groups.forEach((p, i) => {
      galaxyCenter[p] = { x: dirs[i].x * scale, y: dirs[i].y * scale, z: dirs[i].z * scale };
    });
  }

  const subCenter = {};
  const subCoreNodes = [];
  clusters.forEach(cl => {
    const g = galaxyCenter[cl.p];
    const f = galaxyFrame[cl.p];
    const mid = { lx: cl.clx || 0, ly: cl.cly || 0, lz: cl.clz || 0 };
    const c = toWorld(g, f, mid.lx, mid.ly, mid.lz * 0.2);
    const key = cl.p + '::' + cl.mt;
    subCenter[key] = c;
    cl.center = c;
    cl.key = key;
    cl.midLocal = mid;
    const sc = {
      id: 'subgalaxy:' + key,
      rawId: 'subgalaxy:' + key,
      lib: cl.p,
      project: cl.p,
      instance: IS_FED ? cl.p : '',
      __struct: cl.p,
      __clusterKey: key,
      shortLabel: MEM_TYPE_LABELS[cl.mt] || cl.mt,
      label: (MEM_TYPE_LABELS[cl.mt] || cl.mt) + ' · ' + cl.nodes.length,
      fullText: `${cl.p} · ${MEM_TYPE_LABELS[cl.mt] || cl.mt} · ${cl.nodes.length} 条`,
      group: 'subgalaxy-core',
      memType: cl.mt,
      category: 'subgalaxy',
      size: 8 + Math.log2(cl.nodes.length + 1) * 1.4,
      importance: 0.8,
      __galaxyColor: MEM_TYPE_COLORS[cl.mt] || '#64748b',
      __galaxyCenter: g,
      __frame: f,
      __local: { lx: mid.lx, ly: mid.ly, lz: mid.lz * 0.2 },
      x: c.x, y: c.y, z: c.z,
      fx: c.x, fy: c.y, fz: c.z,
    };
    subCoreNodes.push(sc);
  });

  /* 星系核心代表节点 */
  const coreNodes = groups.map(p => ({
    id: 'galaxy:' + p,
    rawId: 'galaxy:' + p,
    lib: p,
    project: p,
    instance: IS_FED ? p : '',
    __struct: p,
    shortLabel: structLabel(p),
    label: structLabel(p) + ' · ' + (MORPH_LABELS[galaxyMorph[p]] || '') + ' · ' + data.nodes.filter(n => structKey(n) === p).length,
    fullText: (IS_FED ? (p + ' 实例') : (p + ' 项目')) + ' · ' + (MORPH_LABELS[galaxyMorph[p]] || '星系'),
    group: 'galaxy-core',
    memType: 'general',
    category: 'galaxy',
    size: 8 + Math.log2(data.nodes.filter(n => structKey(n) === p).length + 1) * 1.05,
    count: data.nodes.filter(n => structKey(n) === p).length,
    importance: 1,
    __galaxyColor: STRUCT_COLORS[p] || '#fbbf24',
    __morph: galaxyMorph[p],
    __galaxyCenter: galaxyCenter[p],
    __frame: galaxyFrame[p],
    x: galaxyCenter[p].x, y: galaxyCenter[p].y, z: galaxyCenter[p].z,
    fx: galaxyCenter[p].x, fy: galaxyCenter[p].y, fz: galaxyCenter[p].z,
  }));

  const nodeById = {};
  clusters.forEach(cl => {
    const g = galaxyCenter[cl.p];
    const f = galaxyFrame[cl.p];
    const sorted = cl.sorted || cl.nodes.slice().sort((a, b) => (b.importance || 0) - (a.importance || 0));
    sorted.forEach((node, i) => {
      nodeById[node.id] = node;
      node.__struct = cl.p;
      node.__clusterKey = cl.p + '::' + cl.mt;
      node.__galaxyCenter = g;
      node.__subCenter = cl.center;
      node.__frame = f;
      node.__shown = i < (cl.showN || 20) || !!node.starred || (node.importance || 0) >= 0.9;
      const loc = node.__local || { lx: cl.clx || 0, ly: cl.cly || 0, lz: 0 };
      node.__local = loc;
      const w = toWorld(g, f, loc.lx, loc.ly, loc.lz || 0);
      node.x = w.x; node.y = w.y; node.z = w.z;
      node.__rest = { x: w.x, y: w.y, z: w.z };
      node.__orbitSpeed = 0.000035 + (i % 9) * 0.000008;
      node.fx = node.x; node.fy = node.y; node.fz = node.z;
    });
  });
  data.nodes.forEach(n => { if (!nodeById[n.id]) nodeById[n.id] = n; });
  (function fitLayout(nodes, target) {
    let maxR = 1;
    nodes.forEach(n => {
      const r = Math.hypot(n.x || 0, n.y || 0, n.z || 0);
      if (r > maxR) maxR = r;
    });
    const s = maxR > target ? target / maxR : 1;
    if (s !== 1) {
      nodes.forEach(n => {
        n.x = (n.x || 0) * s; n.y = (n.y || 0) * s; n.z = (n.z || 0) * s;
        if (n.fx != null) { n.fx = n.x; n.fy = n.y; n.fz = n.z; }
        if (n.__rest) { n.__rest.x *= s; n.__rest.y *= s; n.__rest.z *= s; }
        if (n.__local) n.__local = { lx: n.__local.lx * s, ly: n.__local.ly * s, lz: n.__local.lz * s };
        if (n.__subCenter) n.__subCenter = { x: n.__subCenter.x * s, y: n.__subCenter.y * s, z: n.__subCenter.z * s };
        if (n.__galaxyCenter) n.__galaxyCenter = { x: n.__galaxyCenter.x * s, y: n.__galaxyCenter.y * s, z: n.__galaxyCenter.z * s };
      });
    }
    window.__layoutRadius = maxR * s;
  })(coreNodes.concat(subCoreNodes).concat(data.nodes), 560);

  /* 座间金线：只留最强的 n-1 条，不要四面体全连 */
  const bridges = [];
  const ranked = (data.clusterBridges || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  const want = Math.max(0, groups.length - 1);
  const used = new Set();
  ranked.forEach(br => {
    if (bridges.length >= want) return;
    if (!groups.includes(br.a) || !groups.includes(br.b)) return;
    const key = [br.a, br.b].sort().join('|');
    if (used.has(key)) return;
    used.add(key);
    bridges.push({
      source: 'galaxy:' + br.a,
      target: 'galaxy:' + br.b,
      type: 'galaxy-bridge',
      dir: 'both',
      width: 1.2 + Math.min(br.score || 0, 1) * 0.8,
    });
  });
  if (!bridges.length && groups.length > 1) {
    for (let i = 0; i < groups.length - 1; i++) {
      bridges.push({ source: 'galaxy:' + groups[i], target: 'galaxy:' + groups[i + 1], type: 'galaxy-bridge', dir: 'both', width: 1.3 });
    }
  }

  /* ── 小星系层级边:项目核心 ↔ 小核心(spoke)+ 同项目小核心之间(bridge)── */
  const linkSrc = l => (l.source && typeof l.source === 'object') ? l.source.id : l.source;
  const linkTgt = l => (l.target && typeof l.target === 'object') ? l.target.id : l.target;
  const spokes = subCoreNodes.map(sc => ({ source: 'galaxy:' + sc.project, target: sc.id, type: 'subgalaxy-spoke', value: 1 }));
  const subBridgeWeight = {};
  (data.links || []).forEach(l => {
    const s = linkSrc(l), t = linkTgt(l);
    const ns = nodeById[s], nt = nodeById[t];
    if (!ns || !nt) return;
    const ps = structKey(ns), pt = structKey(nt);
    if (ps !== pt) return;
    const ks = ps + '::' + memTypeOf(ns);
    const kt = pt + '::' + memTypeOf(nt);
    if (ks === kt) return;                    // 同小星系内不重复
    if (!subCenter[ks] || !subCenter[kt]) return;
    const key = [ks, kt].sort().join('|');
    subBridgeWeight[key] = (subBridgeWeight[key] || 0) + 1;
  });
  const subBridges = Object.entries(subBridgeWeight).map(([key, w]) => {
    const [a, b] = key.split('|');
    return { source: 'subgalaxy:' + a, target: 'subgalaxy:' + b, type: 'subgalaxy-bridge', value: w, width: Math.min(0.5 + w * 0.18, 1.8) };
  });

  data.links = data.links || [];
  const allNodes = coreNodes.concat(subCoreNodes).concat(data.nodes);
  const allLinks = data.links.concat(bridges, spokes);

  /* ── 语义簇聚类(借鉴 supermemory computeClusterAssignments):
   * 在真实关系边(非合成边)上做 BFS 连通分量,同簇节点共享簇色
   * 视觉:节点光晕 = 簇色(半透明),簇内连线 = 簇色,跨簇=灰——"扎堆"一眼可见 */
  const clusterOf = {};      // node.id → clusterKey
  const clusterColor = {};   // clusterKey → 颜色
  // 只用强关系边聚类(排除 similarity 自动相似边——supermemory 经验:纯视觉边不进结构聚类)
  const realLinks = allLinks.filter(l => !isSyntheticLink(l) && l.type !== 'similarity');
  const adj = {};
  realLinks.forEach(l => {
    const s = linkSrcId(l), t = linkTgtId(l);
    if (s === t) return;
    (adj[s] = adj[s] || new Set()).add(t);
    (adj[t] = adj[t] || new Set()).add(s);
  });
  let clusterIdx = 0;
  const visited = new Set();
  Object.keys(adj).forEach(startId => {
    if (visited.has(startId)) return;
    const comp = [];
    const queue = [startId];
    visited.add(startId);
    while (queue.length) {
      const id = queue.shift();
      comp.push(id);
      (adj[id] || []).forEach(nid => { if (!visited.has(nid)) { visited.add(nid); queue.push(nid); } });
    }
    if (comp.length < 2) return;                      // 孤立节点不成簇
    const key = 'cluster:' + clusterIdx++;
    const color = CLUSTER_COLORS_GLOBAL[clusterIdx % CLUSTER_COLORS_GLOBAL.length];
    clusterColor[key] = color;
    comp.forEach(id => { clusterOf[id] = key; });
  });
  // 节点打簇标记(供 buildNode/applyNodeVisual 用):__cluster=key,__clusterColorKey=色板下标
  allNodes.forEach(n => {
    n.__cluster = clusterOf[n.id] || null;
    n.__clusterColorKey = n.__cluster ? (parseInt(n.__cluster.split(':')[1], 10) % CLUSTER_COLORS_GLOBAL.length) : null;
  });
  // 簇内真实边染色;合成边(桥/spoke/bridge)保持原逻辑
  allLinks.forEach(l => {
    if (isSyntheticLink(l)) return;
    const k = clusterOf[linkSrcId(l)];
    if (k && clusterOf[linkTgtId(l)] === k) l.__clusterColor = clusterColor[k];
  });

  graphInstance = (graphInstance || new ForceGraph3D(document.getElementById('graph')))
    .graphData({ nodes: allNodes, links: allLinks })
    .backgroundColor(document.fullscreenElement ? '#000000' : '#07090D')
    .nodeThreeObject(node => buildNode(node))
    .nodeThreeObjectExtend(false)
    .nodeRelSize(4)
    .nodeVal(n => {
      if (n.group === 'galaxy-core') return 24;
      if (n.group === 'subgalaxy-core') return 10;
      return 3 + (n.importance || 0.5) * 4;
    })
    .nodeColor(n => selectedNodeId === n.id ? '#ffffff' : memColor(n))
    .nodeOpacity(1)
    .nodeLabel(n => {
      if (n.group === 'galaxy-core' || n.group === 'subgalaxy-core') return n.label || '';
      return (n.fullText || n.label || '').slice(0, 80);
    })
    .enablePointerInteraction(true)
    .enableNodeDrag(false)
    .linkColor(l => {
      if (l.type === 'galaxy-bridge') return 'rgba(255,214,120,0.55)';
      if (l.type === 'subgalaxy-bridge') return 'rgba(190,200,235,0.5)';
      if (l.type === 'subgalaxy-spoke') return 'rgba(150,160,185,0.22)';
      if (l.type === 'similarity') return 'rgba(100,100,120,0.12)';
      if (l.__clusterColor) return l.__clusterColor;   // 语义簇内连线:簇色
      const tc = linkTypeColor(l);
      if (tc) return tc;
      return 'rgba(0,168,154,0.25)';
    })
    .linkWidth(l => {
      if (l.type === 'galaxy-bridge') return (l.width || 1.2);
      if (l.type === 'subgalaxy-bridge') return (l.width || 0.8);
      if (l.type === 'subgalaxy-spoke') return 0.4;
      if (l.type === 'similarity') return 0.15;
      if (isWarmLinkType(l.type)) return 0.7;
      if (l.type === 'same_subject') return 0.3;
      if (l.type === 'related_to' || l.type === 'context' || l.type === 'part_of' || l.type === 'same_event') return 0.45;
      return 0.5;
    })
    .linkDirectionalParticles(l => {
      if (l.type === 'subgalaxy-spoke' || l.type === 'similarity') return 0;
      const s = linkSrcId(l), t = linkTgtId(l);
      const focus = (selectedNodeId && (s === selectedNodeId || t === selectedNodeId))
        || (hoverSet && hoverSet.has(s) && hoverSet.has(t));
      if (focus) return l.type === 'galaxy-bridge' ? 4 : 5;
      if (l.type === 'galaxy-bridge') return 1;
      return 0;
    })
    .linkDirectionalParticleWidth(1.35)
    .linkDirectionalParticleSpeed(0.0055)
    // 单向桥:粒子从子节点流向 reflect,并加箭头标注方向;语义边按类型上色
    .linkDirectionalParticleColor(l => {
      if (l.type === 'galaxy-bridge') return '#ffd678';
      return linkTypeColor(l) || undefined;
    })
    .linkDirectionalArrowLength(l => (l.type === 'galaxy-bridge' && l.dir === 'oneway') ? 6 : 0)
    .linkDirectionalArrowColor(() => 'rgba(255,214,120,0.9)')
    .linkDirectionalArrowRelPos(0.5)
    .linkOpacity(0.85)
    .showNavInfo(false)
    .onNodeClick(node => {
      onStarNodeClick(node);
    })
    .onNodeHover(node => {
      document.body.style.cursor = node ? 'pointer' : 'default';
      onHoverNode(node);
    })
    .onLinkClick(l => {
      if (l && graphInstance && typeof graphInstance.emitParticle === 'function') graphInstance.emitParticle(l);
    })
    .onBackgroundClick(() => {
      if (hoveredNodeId) {
        const n = (allData.nodes || []).find(x => x.id === hoveredNodeId);
        if (n) { onStarNodeClick(n); return; }
      }
      expandedKey = null;
      selectedNodeId = null;
      closePanel();
      if (graphInstance) graphInstance.nodeVisibility(n => lodVisible(n));
    });
  addStarField();
  startOrbit();
  bindInteraction();
  softenControls();
  /* v1.28 结构标签节点表:必须放在 addNebulaWeb()/addNebulaClouds() **之后**
   * —— 它们内部会 removeNebulaObjects(),那里面会把这张表清空。 */
  window.__nebulaNodes = allNodes;
  try { updateLabels(true); startLabelTick(); } catch (e) {}
  try {
    ['charge', 'link', 'center', 'collide', 'subgalaxy-attract', 'galaxy-attract'].forEach(name => {
      try { graphInstance.d3Force(name, null); } catch (e) {}
    });
    if (typeof graphInstance.warmupTicks === 'function') graphInstance.warmupTicks(0);
    if (typeof graphInstance.cooldownTicks === 'function') graphInstance.cooldownTicks(0);
    allNodes.forEach(n => {
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.z = n.fz; }
    });
    graphInstance.nodeVisibility(n => lodVisible(n));
    graphInstance.linkVisibility(l => lodLinkVisible(l));
    graphInstance.enableNodeDrag(false);
    const scene = graphInstance.scene();
    if (scene && !scene.__castaliaLit) {
      scene.add(new THREE.AmbientLight(0xffffff, 2.4));
      const dir = new THREE.DirectionalLight(0xffffff, 1.8);
      dir.position.set(80, 120, 160);
      scene.add(dir);
      scene.__castaliaLit = true;
    }
    if (typeof graphInstance.numDimensions === 'function') graphInstance.numDimensions(3);
  } catch (e) { console.error('galaxy force:', e.message); }
  try {
    const ctrl = graphInstance.controls();
    if (ctrl && ctrl.maxPolarAngle != null) {
      ctrl.minPolarAngle = 0;
      ctrl.maxPolarAngle = Math.PI;
    }
    const R = window.__layoutRadius || 280;
    graphInstance.cameraPosition({ x: R * 0.78, y: R * 0.52, z: Math.max(180, R * 1.18) }, { x: 0, y: 0, z: 0 }, 0);
  } catch (e) {}
  window.graphInstance = graphInstance;
  window.flyTo = flyTo;
  try { startLabelTick(); } catch (e) {}
  renderStarLegend(data);
}

function renderStarLegend(data) {
  const real = (data.nodes || []).filter(n => !n.group);
  const structCounts = {};
  real.forEach(n => {
    const k = structKey(n);
    structCounts[k] = (structCounts[k] || 0) + 1;
  });
  const structKeys = IS_FED ? ['Hermes', 'LobeHub', 'AIRI', '联邦'] : Object.keys(structCounts);
  const items = [];
  structKeys.forEach(k => {
    const members = real.filter(n => structKey(n) === k);
    items.push({
      color: STRUCT_COLORS[k] || '#8A94A3',
      label: structLabel(k) + (window.__galaxyMorph && window.__galaxyMorph[k] ? ' · ' + (MORPH_LABELS[window.__galaxyMorph[k]] || '') : ''),
      count: members.length,
      cls: 'parent',
      filter: { kind: IS_FED ? 'instance' : 'project', id: k },
    });
    MEM_TYPE_ORDER.forEach(mt => {
      const c = members.filter(n => (n.memType || 'general') === mt).length;
      if (!c) return;
      items.push({
        color: MEM_TYPE_COLORS[mt],
        label: MEM_TYPE_LABELS[mt] || mt,
        count: c,
        cls: 'child',
        filter: { kind: 'nested', struct: k, type: mt },
      });
    });
  });
  const titleEl = document.getElementById('legend-struct-title');
  if (titleEl) titleEl.textContent = IS_FED ? '结构' : '结构 · 项目';
  fillLegendList(document.getElementById('legend-struct'), items);
}

function syncViewButtons() {
  const star = document.getElementById('view-star');
  const uni = document.getElementById('view-universe');
  if (star) star.classList.toggle('active', currentView === 'galaxy');
  if (uni) uni.classList.toggle('active', currentView === 'nebula');
  const hint = document.getElementById('controls-hint');
  if (hint) {
    if (currentView === 'nebula') {
      const nb = (allData && allData.nebula) || null;
      const badge = (nb && nb.ok)
        ? ' · 布局:' + (nb.usedUmap ? 'UMAP3D' : 'PCA3D') + ' ' + ((nb.blobs || []).length) + '块 深度' + (nb.zRatio != null ? nb.zRatio : '?') + '%' + (nb.extents ? ' (' + nb.extents.join('/') + ')' : '')
        : ' · 布局:未生效';
      hint.textContent = '星域→星座→库 · 色系=星域 · 色阶=星座 · 点=星座色' + badge;
    } else {
      hint.textContent = '星系 · 座内按文件夹分区 · 座间主桥';
    }
  }
}

function setView(mode) {
  if (!allData) return;
  if (mode === currentView) return;
  closePanel();
  selectedNodeId = null;
  stopAutoTour();
  currentView = mode;
  if (mode === 'galaxy') {
    renderStar(allData);
    renderStarLegend(allData);
  } else {
    renderNebula(allData);
  }
  syncViewButtons();
  const tourBtn = document.getElementById('tour-btn');
  if (tourBtn) tourBtn.disabled = false;
  renderStats();
  setTimeout(applySearchVisuals, 0);
}
