/* ══════════════════════════════════════════════════════════════════════════
   app-06-nebula.js — 星云视图:点云、线网、布局、星云图例、__init 引导
   (2026-09-19 从单文件 app.js 按段落边界切出;加载顺序即依赖顺序,
    全部是普通 script,共享同一个全局作用域 —— 不要在这些文件之间挪动顺序)
   ═══════════════════════════════════════════════════════════════════════ */
/* ═══════════════════ 星云视图 (agent-skills-network 语义:纯嵌入坐标 + 点云辉光 + 雾深) ═══════════════════ */
let nebulaPoints = null, nebulaGlow = null, nebulaWeb = null;
let nebulaTrunk = null, nebulaIntra = null, nebulaSparse = null;
function removeNebulaObjects() {
  if (!graphInstance) return;
  const scene = graphInstance.scene();
  for (const obj of [nebulaPoints, nebulaGlow, nebulaWeb, nebulaTrunk, nebulaIntra, nebulaSparse]) {
    if (obj && obj.parent) obj.parent.remove(obj);
  }
  nebulaPoints = nebulaGlow = nebulaWeb = nebulaTrunk = nebulaIntra = nebulaSparse = null;
  window.__nebulaNodes = null;   /* v1.28 结构标签节点表(星域/星座/星系) */
}
function makeNebulaSpriteTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.22)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}
let _nebulaSprite = null;

/* 悬停/选中驱动的点云视觉(仿 updateAlphas):可见→1.0 强度,过滤→0.05,焦点→加大 */
function updateNebulaState(points) {
  if (!nebulaPoints) return;
  const geo = nebulaPoints.geometry;
  const aAlpha = geo.attributes.aAlpha;
  const aSize = geo.attributes.aSize;
  const N = points.length;
  for (let i = 0; i < N; i++) {
    const n = points[i];
    const vis = !n.dimmed;
    const emph = n.id === selectedNodeId || n.id === hoveredNodeId;
    const alpha = aAlpha.array[i];
    const want = vis ? (emph ? 1.0 : 0.85) : 0.05;
    if (alpha !== want) aAlpha.array[i] = want;
    if (aSize) {
      const ss = window.__nebulaSizeScale || 1;
      const sizeWant = (vis ? (emph ? 6.0 : 4.0) : 1.3) * ss;
      if (aSize.array[i] !== sizeWant) aSize.array[i] = sizeWant;
    }
  }
  aAlpha.needsUpdate = true;
  if (aSize) aSize.needsUpdate = true;
}
function renderNebula(data) {
  window.__galaxyMode = false;
  hoverSet = null; hoveredNodeId = null;
  removeNebulaObjects();
  const real = (data.nodes || []).filter(n => !n.group);
  const deg = computeDegrees(real, data.links || []);
  const NEBULA_DOT_SIZE = 3.9;   /* v1.39 用户嫌暗:3.2 → 3.9(所有点统一) */
  const labelBudget = Math.min(15, Math.max(8, Math.round(Math.sqrt(Math.max(real.length, 1)) * 2.8)));
  const ranked = real.slice().sort((a, b) => (deg[b.id] || 0) - (deg[a.id] || 0));
  const importantIds = new Set(ranked.slice(0, labelBudget).map(n => n.id));
  real.forEach(node => {
    node.__shown = true;
    node.__degree = deg[node.id] || 0;
    node.__importantLabel = importantIds.has(node.id) || !!node.starred;
    node.starred = (node.importance || 0.5) >= 0.9;
    
    node.size = NEBULA_DOT_SIZE;
  });
  layoutNebula(real, window.__nebulaSpace || 620);
  const links = (data.links || []).filter(l => !isSyntheticLink(l));

/* v1.17.5:无星域大星;星座中星保留 + 常驻文字标签贴团,代表"这一团是谁" */
  /* v1.18.11 四层:星域(instance)→星座(多库=主文件夹/库,单库=category)→星系(多库=memType 副文件夹)→恒星(记忆) */
  const structNodes = [];
  const byRegion = new Map();
  const libSetByRg = new Map();
  real.forEach(n => {
    const rg = String(n.layoutGroup || n.instance || (n.lib || 'default'));
    if (!libSetByRg.has(rg)) libSetByRg.set(rg, new Set());
    libSetByRg.get(rg).add(String(n.lib || 'default'));
  });
  const isMultiRg = (rg) => (libSetByRg.get(rg)?.size || 0) > 1;
  real.forEach(n => {
    const rg = String(n.layoutGroup || n.instance || (n.lib || 'default'));
    /* 方案③(用户 2026-09-13 定稿):L2 = **四个文件夹(memType)= 星座**;库(lib)退到星座**内部**做细分。
     * 原实现星座=库,文件夹只当子行 → 多出一层,两个库名看起来像两个平级星座。 */
    /* 星座键:服务端已按实例口径算进 blobId(星域/星座),优先用它;没有则退回本页口径 */
  const cons = String(n.blobId ? String(n.blobId).split('/').slice(1).join('/') || 'general'
                               : (window.CONS_KIND === 'category' ? (n.category || 'general') : (n.memType || 'general')));
    const consLib = String(n.lib || 'default');           /* 细分 = 库 */
    n.__region = rg; n.__constellation = cons; n.__consLib = consLib;
    n.__galaxy = consLib;
    if (!byRegion.has(rg)) byRegion.set(rg, new Map());
    const m = byRegion.get(rg);
    m.set(cons, (m.get(cons) || 0) + 1);
    if (!n.__struct) n.__struct = cons;
  });
  for (const rg of byRegion.keys()) {
    const members = real.filter(n => n.__region === rg);
    const consList = [...byRegion.get(rg).keys()].sort((a,b)=>(byRegion.get(rg).get(b)-byRegion.get(rg).get(a)));
    const rgName = RG_NAME[rg] || structLabel(rg) || rg;
    consList.forEach((cons, ci) => {
      const cm = members.filter(n => n.__constellation === cons && n.__region === rg);
      /* 配色口径(用户 2026-09-14 定):**星域=一个色系**(色相)→ **星座=该色系内不同色阶** →
       * **点=所属星座的颜色**(同星座内统一,不再按库分深浅;库的区分保留在图例子行与星系视图) */
      const libsHere = [...new Set(cm.map(n => String(n.__galaxy || 'default')))].sort();
      const tint = consShadeOf(rg, cons, ci, consList.length);
      cm.forEach(n => { n.__nebulaTint = tint; });
      const shade = cm[0] ? cm[0].__nebulaTint : regionColorOf(rg);
      const cx = cm.reduce((a, n) => a + (n.x || 0), 0) / cm.length;
      const cy = cm.reduce((a, n) => a + (n.y || 0), 0) / cm.length;
      const cz = cm.reduce((a, n) => a + (n.z || 0), 0) / cm.length;
      const consNode = {
        id: 'nebcons:' + rg + '/' + cons, rawId: 'nebcons:' + rg + '/' + cons,
        instance: rg, lib: cons, project: cons, __struct: rg + ' / ' + cons,
        shortLabel: catLabel(cons),
        label: catLabel(cons) + ' · ' + cm.length,
        fullText: rgName + ' · ' + catLabel(cons) + ' 星座 · ' + cm.length + ' 星系',
        group: 'nebula-lib-core', memType: 'general', category: 'constellation',
        size: 5 + Math.log2(cm.length + 1) * 1.2, importance: 0.9,
        __galaxyColor: shade,
        x: cx, y: cy, z: cz, fx: cx, fy: cy, fz: cz,
        __labelAlways: true, __labelLevel: 'cons',
      };
      structNodes.push(consNode);
    });
  }
  /* v1.18.11 星系层锚(多库星域):副文件夹(memType)团锚 —— "这团是哪个副文件夹" 常驻标签 */
  const galAnchorNodes = [];
  {
    const rgMap = new Map();
    real.forEach(n => {
      if (!n.__galaxy) return;
      if (!rgMap.has(n.__region)) rgMap.set(n.__region, new Map());
      const lm = rgMap.get(n.__region);
      if (!lm.has(n.__consLib)) lm.set(n.__consLib, new Map());
      const gm = lm.get(n.__consLib);
      if (!gm.has(n.__galaxy)) gm.set(n.__galaxy, []);
      gm.get(n.__galaxy).push(n);
    });
    for (const [rg, lm] of rgMap) {
      for (const [lib, gm] of lm) {
        for (const [gal, members] of gm) {
          const cx = members.reduce((a, n) => a + (n.x || 0), 0) / members.length;
          const cy = members.reduce((a, n) => a + (n.y || 0), 0) / members.length;
          const cz = members.reduce((a, n) => a + (n.z || 0), 0) / members.length;
          galAnchorNodes.push({
            id: 'nebgal:' + rg + '/' + lib + '/' + gal,
            rawId: 'nebgal:' + rg + '/' + lib + '/' + gal,
            instance: rg, lib, project: lib, memType: gal,
            __struct: lib, __region: rg, __constellation: lib, __consLib: lib, __galaxy: gal,
            shortLabel: MEM_TYPE_LABELS[gal] || gal,
            label: (MEM_TYPE_LABELS[gal] || gal) + ' · ' + members.length,
            fullText: (STRUCT_LABELS[rg] || rg) + ' · ' + (STRUCT_LABELS[lib] || lib) + ' · ' + (MEM_TYPE_LABELS[gal] || gal) + ' 星系 · ' + members.length + ' 恒星',
            group: 'nebula-gal-core', category: 'galaxy',
            size: 2.6 + Math.log2(members.length + 1) * 0.9,
            importance: 0.75,
            __galaxyColor: MEM_TYPE_COLORS[gal] || '#64748b',
            __labelAlways: true, __labelLevel: 'gal',
            x: cx, y: cy, z: cz, fx: cx, fy: cy, fz: cz,
          });
        }
      }
    }
  }
  /* v1.28 星域级标签锚(每星域一枚,只出标签,不占力导) */
  const instNodes = [];
  for (const rg of byRegion.keys()) {
    const members = real.filter(n => n.__region === rg);
    if (!members.length) continue;
    /* 标签落位:贴在该星域**最大星座**的质心上(地图习惯:标在最大那块陆地上)。
     * 用全体均值会落到两团之间的空白处 —— Hermes/AIRI 的成员分处两片,均值点会飘到
     * 空隙里甚至投影到屏幕外(实测:4 个星域名只出得来 3 个)。 */
    let bestCons = null, bestN = -1;
    for (const [cons, cnt] of (byRegion.get(rg) || new Map())) if (cnt > bestN) { bestN = cnt; bestCons = cons; }
    const anchor = members.filter(n => n.__constellation === bestCons);
    const pool = anchor.length ? anchor : members;
    const cx = pool.reduce((a, n) => a + (n.x || 0), 0) / pool.length;
    const cy = pool.reduce((a, n) => a + (n.y || 0), 0) / pool.length;
    const cz = pool.reduce((a, n) => a + (n.z || 0), 0) / pool.length;
    const rgName = RG_NAME[rg] || structLabel(rg) || rg;
    instNodes.push({
      id: 'nebrg:' + rg, rawId: 'nebrg:' + rg,
      instance: rg, lib: rg, project: rg,
      __struct: rg, __region: rg, __constellation: rg, __consLib: rg, __galaxy: rg,
      shortLabel: rgName,
      label: rgName + ' · ' + members.length,
      fullText: rgName + ' 星域 · ' + members.length + ' 记忆',
      group: 'nebula-inst-core', memType: 'general', category: 'region',
      size: 4, importance: 0.9, __galaxyColor: regionColorOf(rg),
      __labelLevel: 'region', __labelOnly: true,
      x: cx, y: cy, z: cz, fx: cx, fy: cy, fz: cz,
    });
  }
  // DSH is a project inside Hermes, not another storage instance. Give it a
  // persistent locator in the federation view without changing node ownership.
  if (IS_FED) {
    const dshByInstance = new Map();
    for (const n of real) {
      if (String(n.project || n.lib || '').toLowerCase() !== 'dsh') continue;
      const owner = n.instance || n.__region || 'Hermes';
      if (!dshByInstance.has(owner)) dshByInstance.set(owner, []);
      dshByInstance.get(owner).push(n);
    }
    for (const [owner, members] of dshByInstance) {
      const center = axis => members.reduce((sum, n) => sum + (n[axis] || 0), 0) / members.length;
      const x = center('x'), y = center('y'), z = center('z');
      instNodes.push({
        id: 'nebproject:' + owner + '/dsh', rawId: 'nebproject:' + owner + '/dsh',
        instance: owner, lib: 'dsh', project: 'dsh',
        shortLabel: 'DSH · ' + owner, label: 'DSH · ' + members.length,
        fullText: 'DeepSeek Harness · ' + owner + ' / dsh · ' + members.length + ' 条记忆',
        group: 'nebula-inst-core', category: 'project', memType: 'general',
        __labelLevel: 'region', __labelOnly: true, __galaxyColor: '#56b4ff',
        x, y, z, fx: x, fy: y, fz: z, size: 4, importance: 1,
      });
    }
  }
  /* 分级标签的"看图比例"基准:场景半径 */
  window.__nebulaR = Math.max(1, real.reduce((m, n) => Math.max(m, Math.hypot(n.x || 0, n.y || 0, n.z || 0)), 1));
  const allNodes = structNodes.concat(instNodes, galAnchorNodes, real);

  graphInstance = (graphInstance || new ForceGraph3D(document.getElementById('graph')))
    .graphData({ nodes: allNodes, links: [] })
    .backgroundColor(document.fullscreenElement ? '#000000' : '#07090D')
    .nodeThreeObject(n => buildNode(n))
    .nodeThreeObjectExtend(false)
    .nodeRelSize(3)
    .nodeVal(n => {
      if (n.group === 'nebula-inst-core') return 24;
      if (n.group === 'nebula-lib-core') return 12;
      return 3 + (n.importance || 0.5) * 4;
    })
    .nodeColor(n => selectedNodeId === n.id ? '#ffffff' : (n.__nebulaTint || memColor(n)))
    .nodeOpacity(1)
    .nodeLabel(n => {
      if (n.group === 'nebula-inst-core' || n.group === 'nebula-lib-core') return n.label || '';
      return (n.fullText || n.label || '').slice(0, 80);
    })
    .enablePointerInteraction(true)
    .enableNodeDrag(false)
    .linkColor(l => currentView === 'nebula'
      ? (lodLinkVisible(l) ? 'rgba(196,210,238,0.55)' : 'rgba(0,0,0,0)')
      : (l.type === 'nebula-spoke' ? 'rgba(200,210,240,0.4)' : 'rgba(0,0,0,0)'))
    .linkWidth(l => currentView === 'nebula'
      ? (lodLinkVisible(l) ? 0.8 : 0)
      : (l.type === 'nebula-spoke' ? 0.9 : 0))
    .linkDirectionalParticles(0)
    .linkOpacity(0.6)
    .showNavInfo(false)
    .onNodeClick(node => onStarNodeClick(node))
    .onNodeHover(node => {
      document.body.style.cursor = node ? 'pointer' : 'default';
      onHoverNode(node);
      updateNebulaState(real);
    })
    .onLinkClick(l => { if (l && graphInstance && typeof graphInstance.emitParticle === 'function') graphInstance.emitParticle(l); })
    .onBackgroundClick(() => {
      if (hoveredNodeId) {
        const n = allNodes.find(x => x.id === hoveredNodeId);
        if (n) { onStarNodeClick(n); return; }
      }
      selectedNodeId = null;
      closePanel();
      updateNebulaState(real);
    });
  addStarField();
  /* 顺序要紧:addNebulaWeb() 内部第一行就 removeNebulaObjects()(清上一帧),
   * 若放在 addNebulaClouds() 之后会**把刚建好的记忆点云/辉光删掉** → 症状"记忆点不出现"、
   * 且 nebulaPoints 恒为 null 让 updateNebulaState() 早退(悬停/选中高亮也失效)。 */
  addNebulaWeb(real, links, data.nebula);
  addNebulaClouds(real);
  startOrbit();
  bindInteraction();
  softenControls();
  try {
    if (typeof graphInstance.numDimensions === 'function') graphInstance.numDimensions(3);
    graphInstance.d3Force('charge', null);
    graphInstance.d3Force('link', null);
    if (typeof graphInstance.warmupTicks === 'function') graphInstance.warmupTicks(0);
    if (typeof graphInstance.cooldownTicks === 'function') graphInstance.cooldownTicks(0);
    allNodes.forEach(n => { if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.z = n.fz; } });
    graphInstance.nodeVisibility(n => lodVisible(n));
  } catch (e) { console.error('nebula force:', e.message); }
  try {
    let maxR = 1;
    allNodes.forEach(n => { maxR = Math.max(maxR, Math.hypot(n.x || 0, n.y || 0, n.z || 0)); });
    window.__universeR = maxR;
    window.__layoutRadius = maxR;
    graphInstance.cameraPosition({ x: maxR * 1.05, y: maxR * 0.68, z: maxR * 1.42 }, { x: 0, y: 0, z: 0 }, 0);
    const ctrl = graphInstance.controls();
    if (ctrl) { ctrl.target.set(0, 0, 0); }
  } catch (e) {}
  window.graphInstance = graphInstance;
  window.flyTo = flyTo;
  /* v1.28 结构标签节点表 + 首次定档:必须放在 addNebulaWeb() 之后
   * —— 它内部会 removeNebulaObjects(),那里会把这张表清空(v1.28 首版就栽在这:
   * 表被清空后 struct=0,星域名/星座名全都停在建节点时的小尺寸上 → "一个标签都看不到")。 */
  window.__nebulaNodes = allNodes;
  try { updateLabels(true); startLabelTick(); } catch (e) {}
  renderNebulaLegend(data, real);
  updateNebulaState(real);
}

function layoutNebula(nodes, SPACE) {
  SPACE = SPACE || 520;
  const has = nodes.filter(n => Number.isFinite(n.nebulaX) && Number.isFinite(n.nebulaY));
  let minx=Infinity,maxx=-Infinity,miny=Infinity,maxy=-Infinity,minz=Infinity,maxz=-Infinity;
  has.forEach(n => {
    minx=Math.min(minx,n.nebulaX);maxx=Math.max(maxx,n.nebulaX);
    miny=Math.min(miny,n.nebulaY);maxy=Math.max(maxy,n.nebulaY);
    const z = Number.isFinite(n.nebulaZ) ? n.nebulaZ : 0;
    minz=Math.min(minz,z);maxz=Math.max(maxz,z);
  });
  const dx=Math.max(maxx-minx,1e-6),dy=Math.max(maxy-miny,1e-6),dz=Math.max(maxz-minz,1e-6);
  const span=Math.max(dx,dy,dz,1e-3);
  const s=Math.min(1, SPACE/span);
  has.forEach(n => {
    n.x=(n.nebulaX-(minx+maxx)/2)*s;
    n.y=(n.nebulaY-(miny+maxy)/2)*s;
    n.z=((Number.isFinite(n.nebulaZ)?n.nebulaZ:0)-(minz+maxz)/2)*s;
    n.fx=n.x; n.fy=n.y; n.fz=n.z;
  });
  /* 把这次用的平移/缩放存下来 —— 服务端给的门(gateA/gateB)是**原始星云坐标**,
   * 管线必须走同一个变换,否则线会整体偏离一个值(用户:"线全部偏离了一个值")。 */
  window.__nebulaXform = { cx: (minx + maxx) / 2, cy: (miny + maxy) / 2, cz: (minz + maxz) / 2, s };
  const missing = nodes.filter(n => !has.includes(n));
  missing.forEach(n => {
    n.x=(hash01(n.id,1)-0.5)*SPACE*0.8;
    n.y=(hash01(n.id,2)-0.5)*SPACE*0.8;
    n.z=(hash01(n.id,3)-0.5)*SPACE*0.8;
    n.fx=n.x;n.fy=n.y;n.fz=n.z;
  });
  window.__universeR = Math.max(span, SPACE/2)/2 * (1/s > 0 ? 2 : 1);
}
/* 点云本体 + 外晕(ShaderMaterial,agent-skills-network 双层辉光) */
function addNebulaClouds(real) {
  if (!graphInstance || typeof THREE === 'undefined') return;
  try {
    const scene = graphInstance.scene();
    const N = real.length;
    if (!N) return;
    /* 点精灵尺寸必须随场景尺度走:shader 是 gl_PointSize = aSize*mult/-mv.z,
     * mult 写死 52 时,场景半径 ~430 + 相机距离 ~700 → 屏幕只有 ~0.2px(等于隐形),
     * 这是"记忆点不出现"的第二层原因。mult 按实测半径推,视觉尺寸 ≈ aSize*mult/dist。 */
    const sceneR = Math.max(1, real.reduce((m, n) => Math.max(m, Math.hypot(n.x || 0, n.y || 0, n.z || 0)), 1));
    /* v1.23.2: 点的视觉尺寸随总数收缩——2000+ 点时仍用 4.0，直径大于点间距，
     * 叠加混合后整片糊成"团"；按 N^(1/3) 收缩，并保留 0.34 下限避免看不见。 */
    const sizeScale = Math.max(0.4, Math.min(1, Math.cbrt(700 / Math.max(40, N))));
    window.__nebulaSizeScale = sizeScale;
    const baseDot = 4.0 * sizeScale;
    const positions = new Float32Array(N*3);
    const colors = new Float32Array(N*3);
    const sizes = new Float32Array(N);
    const alphas = new Float32Array(N);
    for (let i=0;i<N;i++) {
      const n = real[i];
      positions[i*3]=n.x||0; positions[i*3+1]=n.y||0; positions[i*3+2]=n.z||0;
      /* v1.31 配色口径对齐(v1.17.3 定稿:星域=一个色系 → 星座=色系内色阶 → 点=所属星座色):
       * 原来这里用 memColor()(=memType 色),于是 Hermes 的"用户画像/项目上下文"跟 LobeHub 的
       * 同名星座撞成一模一样的颜色 —— 用户实测反馈"Hermes 的颜色怎么和 LobeHub 一样了"。 */
      const c = new THREE.Color(brightenTintHex(n.__nebulaTint) || liftColor(memColor(n), 0.42));   /* v1.40 与点色同步提亮 */
      colors[i*3]=c.r; colors[i*3+1]=c.g; colors[i*3+2]=c.b;
      sizes[i]=baseDot; alphas[i]=1.0;
    }
    window.__nebulaReal = real; window.__nebulaColBuf = colors;   /* 自检用 */
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions,3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors,3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes,1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas,1));
    const mkMat = (sizeMult, alphaScale) => new THREE.ShaderMaterial({
      /* uScale 由场景半径推出(不写死):gl_PointSize = aSize*uScale/视深,
       * 视觉尺寸 ≈ aSize*uScale/相机距离 —— 写死常量时换布局尺度就会变成亚像素隐形。 */
      uniforms: { uScale: { value: sizeMult } },
      vertexShader: `attribute float aSize; attribute float aAlpha; uniform float uScale; varying vec3 vColor; varying float vAlpha;
        void main(){ vColor=color; vAlpha=aAlpha; vec4 mv=modelViewMatrix*vec4(position,1.0);
        gl_PointSize=aSize*uScale/max(1.0,-mv.z); gl_Position=projectionMatrix*mv; }`,
      /* v1.23.2: 边界清晰的实心光点 + 很薄的外晕（原实现 0.04~0.5 全段渐变，
       * 点一大就糊成光团，边界看不见）。
       * core 在 d=0.44~0.5 之间快速收边 → 明确的圆边；halo 只保留 0.22 的柔光。 */
      fragmentShader: `varying vec3 vColor; varying float vAlpha;
        void main(){
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float core = smoothstep(0.5, 0.44, d);
          float halo = 0.22 * pow(smoothstep(0.5, 0.06, d), 2.0);
          float a = clamp(core + halo, 0.0, 1.0);
          gl_FragColor = vec4(vColor * (0.74 + 0.26 * core), a * vAlpha * ${alphaScale});
        }`,
      /* v1.23.2: 点层改用普通混合。叠加混合下几百个点重叠会把中心推到纯白，
       * 整团糊成一块；普通混合保留每个点的清晰边界（重叠处只是后画的点覆盖前一个）。 */
      transparent: true, depthWrite: false, blending: THREE.NormalBlending, vertexColors: true,
    });
    nebulaPoints = new THREE.Points(geo, mkMat(String(sceneR * 4.0), '0.95'));
    scene.add(nebulaPoints);
    /* v1.35 去掉所有光晕:这里原本还有一层 sceneR*110 的辉光点(整片光的雾),已删。 */
  } catch (e) { console.error('nebula clouds:', e.message); }
}
/* v1.18.0 星系走线·高速公路模型(用户方案完整版)
 * 结构: 记忆点 → 出港 gwA(团外缘) ──主干(共享亮管)── 入港 gwB → 记忆点
 * 主干数: 两星座间按路由方向聚类 —— 夹角 < 25° 的并为一根(近夹角=无效操作),
 *         只有 ≥25° 的大夹角才保留为独立管线;中轴簇(直穿)单独成中线
 * 三级样式: 星团内短线(极淡 0.20) / 孤立长单线(近隐形 0.10) / 主干亮核(0.90,三重描边) */
function addNebulaWeb(real, links, nebulaMeta) {
  if (!graphInstance || typeof THREE === 'undefined') return;
  try {
    const scene = graphInstance.scene();
    removeNebulaObjects();
    const byId = new Map(real.map(n => [n.id, n]));
    /* v1.18.12 分团键对齐布局的"可见中间层":多库星域=副文件夹(memType),单库星域=category。
     * 之前用 __constellation(=库) → LobeHub 上管道连的是两个巨库质心,与用户看到的团无关(AIRI 单库恰好一致故正常) */
    const clKey = (n) => libKeyOf(n) + '/' + String(n.__galaxy || n.__constellation || n.lib || '?');
    /* v1.18.12 库球几何(region+lib):跨库管道的星门要推到"本库球面",否则门埋在库内别的团里 */
    const libs = new Map();
    for (const n of real) {
      const lk = String(n.__region || n.lib || '?') + '/' + String(n.__consLib || n.lib || '?');
      if (!libs.has(lk)) libs.set(lk, { pts: [], c: null, R: 10 });
      libs.get(lk).pts.push(n);
    }
    for (const [, rec] of libs) {
      rec.c = [0, 1, 2].map(i => rec.pts.reduce((a, p) => a + (p[['x', 'y', 'z'][i]] || 0), 0) / rec.pts.length);
      const dl = rec.pts.map(p => Math.hypot((p.x || 0) - rec.c[0], (p.y || 0) - rec.c[1], (p.z || 0) - rec.c[2])).sort((a, b) => a - b);
      rec.R = Math.max(10, dl[Math.floor(dl.length * 0.9)] || 10);
    }
    const libKeyOf = (n) => String(n.__region || n.lib || '?') + '/' + String(n.__consLib || n.lib || '?');
    /* 星座几何 */
    const cons = new Map();
    const regC = (name) => {
      if (!cons.has(name)) cons.set(name, { pts: [], tint: null, n: 0, c: null, R: 10 });
      return cons.get(name);
    };
    for (const n of real) {
      const c = clKey(n);
      const rec = regC(c);
      rec.pts.push(n); rec.n++;
      if (!rec.tint && n.__nebulaTint) rec.tint = n.__nebulaTint;
    }
    for (const [name, rec] of cons) {
      rec.c = [0, 1, 2].map(i => rec.pts.reduce((a, p) => a + (p[['x','y','z'][i]] || 0), 0) / rec.n);
      /* v1.18.7 星团半径改 p90:σ×2.2 对非正态点云(14 点带远置点)严重低估(p50=12.7 却给 R=9.5)
       * → 星门钻进星团腹地被实点围住("一条管对应 4 个点")。R=p90 实测分布,直接决定门推进量 */
      const dAll = rec.pts.map(p => Math.hypot((p.x || 0) - rec.c[0], (p.y || 0) - rec.c[1], (p.z || 0) - rec.c[2])).sort((a, b) => a - b);
      const p90 = dAll[Math.floor(dAll.length * 0.9)] || dAll[dAll.length - 1] || 10;
      rec.R = Math.max(10, p90);
    }
    const tintOf = (name) => { const t = cons.get(name)?.tint; return t ? new THREE.Color(t) : new THREE.Color('#8fb4d8'); };
    /* 边分类 */
    const intra = [];
    const pairs = new Map();
    for (const l of (links || [])) {
      const s = byId.get(linkSrcId(l)), t = byId.get(linkTgtId(l));
      if (!s || !t) continue;
      const cs = clKey(s);
      const ct = clKey(t);
      if (cs === ct) {
        /* v1.34 重要连线增亮:把边的 strength(相似度 0.4~1.0)带下去,作为"这条线多重"的依据 */
        const sv = Number(l.strength != null ? l.strength : (l.similarity != null ? l.similarity : 0.75));
        intra.push({ s, t, str: Number.isFinite(sv) ? sv : 0.75 });
        continue;
      }
      const k = [cs, ct].sort().join('=>');
      const [ca] = k.split('=>');
      /* v1.18.1 方向归一: s/t 按 ca 侧对齐,否则 sBar 混团、喇叭从 B 直奔 A 出港 */
      const sa = (cs === ca) ? s : t;
      const ta = (cs === ca) ? t : s;
      if (!pairs.has(k)) pairs.set(k, []);
      pairs.get(k).push({ s: sa, t: ta, l });
    }
    const MIN_ANG = 25 * Math.PI / 180;
    const MARGIN = 7;
    const posI = [], colI = [];
    const posS = [], colS = [];
    const posF = [], colF = [];
    const posT = [], colT = [];
    const seg = (pos, col, a, b, c) => { pos.push(a[0], a[1], a[2], b[0], b[1], b[2]); col.push(c[0], c[1], c[2], c[0], c[1], c[2]); };
    /* v1.18.9 双色段:节点端压暗到 f,门端全亮——匝道"渗出"而非硬穿星团 */
    const seg2 = (pos, col, a, b, ca, cb, f) => {
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      col.push(ca[0] * f, ca[1] * f, ca[2] * f, cb[0], cb[1], cb[2]);
    };
    const v3 = (n) => [n.x || 0, n.y || 0, n.z || 0];
    const mid3 = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const norm3 = (v) => { const d = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / d, v[1] / d, v[2] / d]; };
    const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const perpU = (v, u) => { const d = dot3(v, u); return [v[0] - u[0] * d, v[1] - u[1] * d, v[2] - u[2] * d]; };
    
    /* 1) 星团内短线:极淡背景(开关见文件下方 v1.26 说明) */
    let pipeTotal = 0;
    const __pdbg = [];  /* 管道自检转储:window.__pipeDebug 供取证 */
    /* ── v1.25 星系间连线:整体删除(2026-09-18 用户定稿)─────────────────────────
     * 三档都试过:v1.23 每团对一条管(61 条,乱)→ v1.24 收成 6 条星域干道 + 大幅调暗
     * (Hermes 那条色偏深、整体仍属多余)→ 结论:**星域之间不画常驻线**。
     * 常驻线条只剩"团内短线"一层(posI);跨团关系交给 hover/选中高亮(node→node 那层)与图例计数。
     * 恢复办法:v1.24 的实现在 _归档\index.html.bak-20260918-改干道前(改前)之后的版本 / git 历史,
     * 搜 "v1.24 星域干道" 整块贴回这里,再把下面 nebulaTrunk 那行加回来即可。
     */
    /* (干道层已删 → posT/colT 恒空,window.__pipeCount 恒 0) */
    /* 建对象(四个 LineSegments = 三级样式 + 喇叭层) */
    const mk = (pos, col, opacity) => {
      if (pos.length < 6) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
    };
    
    const INTRA_KNN = 2;         /* 每个点保留最短几条(0 = 全部画) */
    const INTRA_MAX_LEN = 0;     /* >0 时丢弃更长的线(场景单位) */
    const INTRA_CELL = 60;       /* 密度网格边长(场景单位) */
    const INTRA_MIN_W = 0.30;    /* 拥挤格的最低亮度系数 */
    const INTRA_BASE = [0.12, 0.16, 0.22];
    const INTRA_ALPHA = 0.32;    /* 整层材质透明度(旧值 0.20) */
    /* v1.34 重要连线增亮(用户 2026-09-18 定):边的 strength 越高线越亮 —— 强关联更实、弱关联更淡。
     * 曲线实测标定(保留下来的 557 条线 strength:min 0.40 / 中位 0.75 / p90 0.85 / max 1.00):
     *   gain = 0.38 + (1.90-0.38) * t^1.5 , t = clamp((str-0.55)/(0.95-0.55))
     *   → 平均增益 0.96(整体墨量不变)、弱线 ~0.4、强线 ~1.9(强弱对比 5 倍,肉眼可辨)。
     * 1px 线宽在 WebGL 里改不了,所以"更实"用亮度表达。 */
    const INTRA_STR = { lo: 0.55, hi: 0.95, dim: 0.50, bright: 2.20, power: 1.5 };
    /* v1.44 长短分级(用户):布局本来就是"按联系扎堆",所以**短线=真结构**、长线=跨团弱关系。
     * → 明显的线留给短的:长度 ≤ INTRA_LEN.short 最亮,≥ INTRA_LEN.long 淡到 floor,中间平滑衰减。 */
    const INTRA_LEN = { short: 40, long: 160, k: 2.33 };   /* v1.45 温和:长线保底 1/(1+k)=0.30 */
    const intraLenGain = (L) => {
      const t = Math.max(0, Math.min(1, ((Number.isFinite(+L) ? +L : 40) - INTRA_LEN.short) / (INTRA_LEN.long - INTRA_LEN.short)));
      return 1 / (1 + INTRA_LEN.k * t * t);   /* t=0→1.00  t=0.5→0.63  t=1→0.30 */
    };
    const intraStrGain = (v) => {
      const t = Math.max(0, Math.min(1, ((Number.isFinite(+v) ? +v : 0.75) - INTRA_STR.lo) / (INTRA_STR.hi - INTRA_STR.lo)));
      return INTRA_STR.dim + (INTRA_STR.bright - INTRA_STR.dim) * Math.pow(t, INTRA_STR.power);
    };
    const intraList = [];
    if (INTRA_KNN > 0) {
      const byNode = new Map(), chosen = new Map();
      for (const { s, t, str } of intra) {
        const A = v3(s), B = v3(t), L = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
        if (INTRA_MAX_LEN > 0 && L > INTRA_MAX_LEN) continue;
        const key = s.id < t.id ? s.id + '|' + t.id : t.id + '|' + s.id;
        for (const n of [s.id, t.id]) {
          if (!byNode.has(n)) byNode.set(n, []);
          byNode.get(n).push({ key, L, a: A, b: B, str });
        }
      }
      for (const lst of byNode.values()) {
        lst.sort((p, q) => p.L - q.L);
        for (let i = 0; i < Math.min(INTRA_KNN, lst.length); i++) chosen.set(lst[i].key, lst[i]);
      }
      for (const c of chosen.values()) intraList.push(c);
    } else {
      for (const { s, t, str } of intra) {
        const A = v3(s), B = v3(t);
        intraList.push({ a: A, b: B, str, L: Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]) });
      }
    }
    /* 长短分级会整体压低墨量 → 先算平均合成增益,再归一化回去(亮度维持现状,只是把明暗重新分配) */
    let gMean = 0;
    for (const it of intraList) { it.g = intraStrGain(it.str) * intraLenGain(it.L); gMean += it.g; }
    gMean = (gMean / Math.max(1, intraList.length)) || 1;
    for (const it of intraList) it.g = it.g / gMean;
    const intCell = (p) => Math.floor(p[0] / INTRA_CELL) + ',' + Math.floor(p[1] / INTRA_CELL) + ',' + Math.floor(p[2] / INTRA_CELL);
    const intSplit = (a, b) => {
      const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / INTRA_CELL));
      const out = [];
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n;
        out.push([[a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0, a[2] + (b[2] - a[2]) * t0],
                  [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1, a[2] + (b[2] - a[2]) * t1]]);
      }
      return out;
    };
    const intCrowd = new Map(), intPieces = [];
    for (const it of intraList) for (const pc of intSplit(it.a, it.b)) {
      const k = intCell([(pc[0][0] + pc[1][0]) / 2, (pc[0][1] + pc[1][1]) / 2, (pc[0][2] + pc[1][2]) / 2]);
      intCrowd.set(k, (intCrowd.get(k) || 0) + 1);
      intPieces.push({ pc, k, g: it.g });
    }
    const intCounts = [...intCrowd.values()].sort((a, b) => a - b);
    const intMed = intCounts.length ? intCounts[Math.floor(intCounts.length / 2)] : 1;
    let gMin = 9, gMax = 0, gSum = 0, gN = 0;
    for (const { pc, k, g } of intPieces) {
      const w = Math.max(INTRA_MIN_W, Math.min(1, Math.sqrt(intMed / (intCrowd.get(k) || 1))));
      const gg = w * g;
      if (g < gMin) gMin = g; if (g > gMax) gMax = g; gSum += g; gN++;
      seg(posI, colI, pc[0], pc[1], [INTRA_BASE[0] * gg, INTRA_BASE[1] * gg, INTRA_BASE[2] * gg]);
    }
    window.__intraStrength = { lines: intraList.length, mean: +(gSum / Math.max(1, gN)).toFixed(2),
      min: +gMin.toFixed(2), max: +gMax.toFixed(2),
      lenGain短: +intraLenGain(12).toFixed(2), lenGain中: +intraLenGain(60).toFixed(2), lenGain长: +intraLenGain(240).toFixed(2),
      近距线: intraList.filter(it => it.L <= INTRA_LEN.short).length, 远距线: intraList.filter(it => it.L >= INTRA_LEN.long).length };
    window.__intraDebug = { lines: intraList.length, pieces: intPieces.length, cells: intCrowd.size,
                            medianCrowd: intMed, knn: INTRA_KNN, cell: INTRA_CELL };
    nebulaIntra = mk(posI, colI, INTRA_ALPHA);  if (nebulaIntra) scene.add(nebulaIntra);
    nebulaSparse = mk(posS, colS, 0.10); if (nebulaSparse) scene.add(nebulaSparse);
    nebulaWeb = mk(posF, colF, 0.38);    if (nebulaWeb) scene.add(nebulaWeb);
    if (!scene.fog) scene.fog = new THREE.FogExp2(0x07090D, 0.00042);
    window.__pipeCount = pipeTotal;
    window.__pipeDebug = __pdbg;
    window.__nebulaDbg = { cons: [...cons.entries()].map(([k, v]) => ({ k, n: v.n, R: +v.R.toFixed(1), c: v.c.map(x => +x.toFixed(1)) })), pairCount: pairs.size };
  } catch (e) { console.error('nebula web:', e.message); }
}

function renderNebulaLegend(data, real) {
  const byRegion = new Map();
  (real || []).forEach(n => {
    const rg = String(n.__region || (IS_FED ? (n.layoutGroup || n.instance || 'default') : String(n.lib || 'default')));
    const cons = String(n.__constellation || n.lib || 'default');
    if (!byRegion.has(rg)) byRegion.set(rg, new Map());
    const m = byRegion.get(rg);
    m.set(cons, (m.get(cons) || 0) + 1);
  });
  const items = [];
  const dshMembers = (real || []).filter(n => String(n.project || n.lib || '').toLowerCase() === 'dsh');
  if (IS_FED && dshMembers.length) {
    items.push({ color: '#56b4ff', label: 'DSH · DeepSeek Harness（项目）', count: dshMembers.length,
      cls: 'parent', key: 'project:dsh', parent: '', lvl: 0, filter: { kind: 'project', id: 'dsh' } });
  }
  const rgs = [...byRegion.keys()].sort((a, b) => {
    const w = (x) => (x === '联邦' ? 1 : 0);
    return w(a) - w(b) || a.localeCompare(b);
  });
  for (const rg of rgs) {
    const total = [...byRegion.get(rg).values()].reduce((a, b) => a + b, 0);
    const rgKey = 'rg:' + rg;
    items.push({ color: regionColorOf(rg), label: (RG_NAME[rg] || structLabel(rg) || rg) + ' 星域', count: total, cls: 'parent',
      key: rgKey, parent: '', lvl: 0, filter: { kind: IS_FED ? 'instance' : 'project', id: IS_FED ? rg : rg } });
    const consList = [...byRegion.get(rg).keys()].sort();
    consList.forEach(cons => {
      const cm = (real || []).filter(n => n.__region === rg && String(n.__constellation || n.lib) === cons);
      const rep = cm.find(n => n.__nebulaTint);
      
      const consName = window.consLabel(cons);
      const consKey = rgKey + '/cons:' + cons;
      items.push({ color: (rep && rep.__nebulaTint) || '#8A94A3',
        label: consName + ' 星座',
        count: cm.length, cls: 'child', key: consKey, parent: rgKey, lvl: 1, filter: { kind: 'project', id: cons } });
      const subs = new Map();
      cm.forEach(n => { const g = String(n.__galaxy || n.lib || 'default'); if (!subs.has(g)) subs.set(g, { n: 0, tint: n.__nebulaTint }); subs.get(g).n++; });
      [...subs.entries()].sort((a, b) => b[1].n - a[1].n).forEach(([g, rec]) => {
        items.push({ color: rec.tint || '#8A94A3', label: structLabel(g), count: rec.n, cls: 'sub',
          key: consKey + '/lib:' + g, parent: consKey, lvl: 2 });
      });
    });
  }
  const titleEl = document.getElementById('legend-struct-title');
  if (titleEl) titleEl.textContent = '星云 · 星域 / 星座 / 星系';
  fillLegendList(document.getElementById('legend-struct'), items);
  const linkEl = document.querySelector('#legend .legend-link');
  if (linkEl) linkEl.textContent = '点行=展开下一层 · 点圆点=筛选 · 点标题=收起面板';
}
function __init() {
fetch('/api/graph?scope=' + encodeURIComponent(GRAPH_SCOPE) + '&project=' + encodeURIComponent(GRAPH_PROJECT) + '&instance=' + encodeURIComponent(new URLSearchParams(location.search).get('instance') || '') + '&layout=folder-wedges')
  .then(r => r.json())
  .then(data => {
      if (data.consKind) window.CONS_KIND = String(data.consKind).toLowerCase();
    if (data.error || !data.nodes) throw new Error(data.error || '无法读取记忆库');
    allData = data;
    updateStats(data.nodes.length, data.stats.totalLinks);
    currentView = 'nebula';
    renderNebula(data);
    syncViewButtons();
    renderStats();
    loading.style.display = 'none';
    document.getElementById('tour-btn').disabled = false;
    return fetch('/api/status').then(r => r.json());
  })
  .then(s => {
    applyInstanceChrome(s);
    /* 空库提示只属于“真的没有节点”的场景:
     * 汇总星图(3348)的本库为空,但 federation 视图有上千节点;旧逻辑只看 dbExists,
     * 会把红字盖在正常星图上(2026-10-18 实测 1503 节点仍出现)。 */
    const hasGraph = !!(allData && Array.isArray(allData.nodes) && allData.nodes.length > 0);
    if (s && s.dbExists === false && !hasGraph) {
      loading.innerHTML = '📭 记忆库为空或未创建——启动 MCP server 或写入第一条记忆后,图谱会自动出现';
      loading.classList.add('error');
      loading.style.display = '';
    } else {
      loading.classList.remove('error');
      loading.style.display = 'none';
    }
  })
  .catch(err => {
    /* 图已经画出来了说明数据没问题;此时 /api/status 抖动不能把红字盖回星图上。 */
    if (allData && Array.isArray(allData.nodes) && allData.nodes.length > 0) {
      loading.style.display = 'none';
      console.error('status check failed after graph render:', err && err.message);
      return;
    }
    fetch('/api/status').then(r => r.json()).then(s => {
      if (s && s.dbExists === false) {
        loading.innerHTML = '📭 记忆库为空或未创建——启动 MCP server 或写入第一条记忆后,图谱会自动出现';
      } else {
        loading.textContent = '❌ 加载失败: ' + err.message;
      }
      loading.classList.add('error');
    }).catch(() => {
      loading.textContent = '❌ 加载失败: ' + err.message;
      loading.classList.add('error');
    });
  });
}
