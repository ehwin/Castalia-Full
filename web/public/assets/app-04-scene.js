/* ══════════════════════════════════════════════════════════════════════════
   app-04-scene.js — 场景层:星空背景、相机环绕、悬停/过滤、统计宫格、图例树
   (2026-09-19 从单文件 app.js 按段落边界切出;加载顺序即依赖顺序,
    全部是普通 script,共享同一个全局作用域 —— 不要在这些文件之间挪动顺序)
   ═══════════════════════════════════════════════════════════════════════ */
/* ═══════════════════ 星空背景 (V2) ═══════════════════ */
let starField = null;
function addStarField() {
  if (!graphInstance || typeof THREE === 'undefined') return;
  try {
    const scene = graphInstance.scene();
    if (starField && starField.parent === scene) return;   // 已添加
    if (starField && starField.parent) starField.parent.remove(starField);
    const N = 4200, R = 2400;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = R * (0.35 + 0.65 * Math.random());
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i * 3 + 2] = r * Math.cos(phi);
      const bright = 0.45 + Math.random() * 0.55;
      col[i * 3] = 0.72 * bright;
      col[i * 3 + 1] = 0.84 * bright;
      col[i * 3 + 2] = 1.0 * bright;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      vertexColors: true, size: 2.2, sizeAttenuation: true,
      transparent: true, opacity: 0.9, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    starField = new THREE.Points(geo, mat);
    scene.add(starField);
    if (!scene.fog) scene.fog = new THREE.FogExp2(0x07090D, 0.00055);
  } catch (e) { console.error('starfield:', e.message); }
}

/* ═══════════════════ 宇宙图 (cosmograph-org: embedding scatter + 细丝连线) ═══════════════════ */
function computeDegrees(nodes, links) {
  const deg = {};
  (nodes || []).forEach(n => { deg[n.id] = 0; });
  (links || []).forEach(l => {
    if (isSyntheticLink(l)) return;
    const s = linkSrcId(l), t = linkTgtId(l);
    if (deg[s] != null) deg[s]++;
    if (deg[t] != null) deg[t]++;
  });
  return deg;
}
function hash01(id, salt) {
  const s = String(id || '') + ':' + salt;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}
/* ═══════════════════ 相机自动环绕 (M2) ═══════════════════ */
let orbitRAF = null;
let orbitAngle = null;
let lastInteraction = 0;
let interactionBound = false;
function markInteraction() { lastInteraction = Date.now(); }
function strollMemories() {
  if (currentView !== 'galaxy' || !graphInstance) return;
  const gd = graphInstance.graphData();
  if (!gd || !gd.nodes) return;
  const t = Date.now();
  gd.nodes.forEach(n => {
    if (!n.__frame || !n.__local || !n.__galaxyCenter) return;
    if (n.group === 'galaxy-core') return;
    if (n.id === selectedNodeId) return;
    const g = n.__galaxyCenter, f = n.__frame, loc = n.__local;
    const ang = t * (n.__orbitSpeed || 0.00005);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const lx = loc.lx * cos - loc.ly * sin;
    const ly = loc.lx * sin + loc.ly * cos;
    const lz = loc.lz;
    n.x = n.fx = g.x + f.u.x * lx + f.v.x * ly + f.n.x * lz;
    n.y = n.fy = g.y + f.u.y * lx + f.v.y * ly + f.n.y * lz;
    n.z = n.fz = g.z + f.u.z * lx + f.v.z * ly + f.n.z * lz;
  });
}
function orbitTick() {
  if (orbitRAF == null) return;
  if (Date.now() > flyingUntil) strollMemories();
  applyLod();
  orbitRAF = requestAnimationFrame(orbitTick);
}
function startOrbit() {
  markInteraction();
  if (orbitRAF == null) orbitRAF = requestAnimationFrame(orbitTick);
}
function bindInteraction() {
  if (interactionBound) return;
  interactionBound = true;
  const graphEl = document.getElementById('graph');
  graphEl.addEventListener('pointerdown', markInteraction);
  graphEl.addEventListener('wheel', markInteraction, { passive: true });
  graphEl.addEventListener('touchstart', markInteraction);
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && (e.target.tagName || '') !== 'INPUT' && (e.target.tagName || '') !== 'TEXTAREA') {
      e.preventDefault();
      const inp = document.getElementById('search-input');
      if (inp) inp.focus();
      return;
    }
    if (e.key === 'Escape') {
      selectedNodeId = null;
      typeFilter = null;
      projectFilter = null;
      instanceFilter = null;
      hoverSet = null;
      closePanel();
      recomputeDim();
      if (allData) renderStarLegend(allData);
      renderNebulaLegend(allData);
    }
  });
}

function softenControls() {
  try {
    const c = graphInstance && graphInstance.controls && graphInstance.controls();
    if (!c) return;
    if (c.rotateSpeed != null) c.rotateSpeed = 0.28;
    if (c.zoomSpeed != null) c.zoomSpeed = 0.5;
    if (c.panSpeed != null) c.panSpeed = 0.4;
    if (c.dynamicDampingFactor != null) c.dynamicDampingFactor = 0.18;
  } catch (e) {}
}

/* ═══════════════════ 悬停邻居高亮 (I1) ═══════════════════ */
let hoverSet = null;
let hoveredNodeId = null;
let searchQuery = '';
let typeFilter = null;
let projectFilter = null;
let instanceFilter = null;
let expandedKey = null;
function oneHopNeighbors(nodeId) {
  const set = new Set([nodeId]);
  for (const l of (allData?.links || [])) {
    if (isSyntheticLink(l)) continue;
    const s = linkSrcId(l), t = linkTgtId(l);
    if (s === nodeId) set.add(t);
    if (t === nodeId) set.add(s);
  }
  return set;
}
function recomputeDim() {
  for (const n of (allData?.nodes || [])) {
    let dim = false;
    if (searchQuery && !matchesNode(n, searchQuery)) dim = true;
    if (hoverSet != null && !hoverSet.has(n.id) && n.group !== 'galaxy-core' && n.group !== 'subgalaxy-core') dim = true;
    if (selNeighbors != null && selNeighbors.has(n.id)) dim = false; /* v1.18.8 邻居弱亮档 */
    if (typeFilter) {
      if (n.group === 'subgalaxy-core' && n.memType !== typeFilter) dim = true;
      if (!n.group && (n.memType || 'general') !== typeFilter) dim = true;
    }
    if (instanceFilter) {
      const inst = n.instance || n.__struct;
      if (n.group === 'galaxy-core' && n.__struct !== instanceFilter) dim = true;
      if (n.group !== 'galaxy-core' && inst !== instanceFilter) dim = true;
    }
    if (projectFilter) {
      const p = n.project || n.lib;
      if (n.group === 'galaxy-core' && n.__struct !== projectFilter) dim = true;
      if (n.group !== 'galaxy-core' && p !== projectFilter) dim = true;
    }
    n.dimmed = dim;
  }
  refreshNodeVisuals();
  applyLinkHoverVisibility();
}
function applyLinkHoverVisibility() {
  if (!graphInstance || typeof graphInstance.linkVisibility !== 'function') return;
  graphInstance.linkVisibility(l => lodLinkVisible(l));
}
function onHoverNode(node) {
  if (currentView !== 'galaxy' && currentView !== 'nebula') return;
  const isCore = !!node && (node.group === 'galaxy-core' || node.group === 'subgalaxy-core');
  hoveredNodeId = (node && !isCore) ? node.id : null;
  hoverSet = (node && !isCore) ? oneHopNeighbors(node.id) : null;
  recomputeDim();
  applyLinkHoverVisibility();
}

/* ═══════════════════ 统计宫格 ═══════════════════ */
function addStatCell(grid, value, label, color) {
  const cell = document.createElement('div');
  cell.className = 'stat-cell';
  cell.style.borderColor = color + '55';
  cell.innerHTML = `<div class="stat-num" style="color:${color};text-shadow:0 2px 8px ${color}30">${value}</div><div class="stat-label">${label}</div>`;
  grid.appendChild(cell);
}

function renderStats() {
  const grid = document.getElementById('stats-grid');
  grid.innerHTML = '';
  if (allData) {
    const real = allData.nodes.filter(n => !n.group);
    addStatCell(grid, real.length, 'TOTAL', '#3EE8C8');
    if (IS_FED) {
      ['Hermes', 'LobeHub', 'AIRI', '联邦'].forEach(name => {
        const c = real.filter(n => structKey(n) === name).length;
        addStatCell(grid, c, name, STRUCT_COLORS[name]);
      });
    }
  }
}

function toggleStats() {
  const bar = document.getElementById('stats-bar');
  bar.classList.toggle('collapsed');
}

/* ═══════════════════ 视图渲染 ═══════════════════ */
function updateStats(nodes, links) {
  document.getElementById('stat-nodes').textContent = nodes;
  document.getElementById('stat-links').textContent = links;
}

const LEGEND_OPEN = new Set();
try { (JSON.parse(localStorage.getItem('legendOpen') || '[]') || []).forEach(k => LEGEND_OPEN.add(k)); } catch (e) {}
function legendSaveOpen() { try { localStorage.setItem('legendOpen', JSON.stringify([...LEGEND_OPEN])); } catch (e) {} }
function legendToggle(key) {
  if (!key) return;
  const el = document.getElementById('legend-struct');
  if (!el || !el.querySelector('.legend-item[data-parent="' + key + '"]')) return;   /* 没有下一层:不响应 */
  if (LEGEND_OPEN.has(key)) LEGEND_OPEN.delete(key); else LEGEND_OPEN.add(key);
  legendSaveOpen(); paintLegendTree();
}
function paintLegendTree() {
  const el = document.getElementById('legend-struct');
  if (!el) return;
  const rows = [...el.querySelectorAll('.legend-item')];
  const byKey = new Map(rows.filter(r => r.dataset.key).map(r => [r.dataset.key, r]));
  for (const r of rows) {
    const key = r.dataset.key || '';
    if (key) {
      let vis = true, cur = r.dataset.parent || '';
      while (cur) { if (!LEGEND_OPEN.has(cur)) { vis = false; break; } const n = byKey.get(cur); cur = n ? (n.dataset.parent || '') : ''; }
      r.style.display = vis ? '' : 'none';
      const caret = r.querySelector('.legend-caret');
      if (caret) {
        const hasKids = !!el.querySelector('.legend-item[data-parent="' + key + '"]');
        caret.textContent = hasKids ? (LEGEND_OPEN.has(key) ? '▾' : '▸') : '';
      }
    }
  }
}
function applyLegendFilter(f) {
  if (!f) return;
  if (f.kind === 'type') { typeFilter = typeFilter === f.id ? null : f.id; instanceFilter = null; projectFilter = null; }
  if (f.kind === 'project') { projectFilter = projectFilter === f.id ? null : f.id; typeFilter = null; instanceFilter = null; }
  if (f.kind === 'instance') { instanceFilter = instanceFilter === f.id ? null : f.id; typeFilter = null; projectFilter = null; }
  if (f.kind === 'nested') {
    const same = typeFilter === f.type && (instanceFilter === f.struct || projectFilter === f.struct);
    if (same) { typeFilter = null; instanceFilter = null; projectFilter = null; }
    else {
      typeFilter = f.type;
      if (IS_FED) { instanceFilter = f.struct; projectFilter = null; }
      else { projectFilter = f.struct; instanceFilter = null; }
    }
  }
  recomputeDim();
  if (allData) {
    if (currentView === 'nebula') {
      const real = allData.nodes.filter(n => !n.group);
      renderNebulaLegend(allData, real);
    } else renderStarLegend(allData);
  }
}

function fillLegendList(el, items) {
  if (!el) return;
  el.innerHTML = '';
  const anyFilter = !!(typeFilter || projectFilter || instanceFilter);
  for (const it of items) {
    const item = document.createElement('div');
    item.className = 'legend-item' + (it.cls ? ' ' + it.cls : '');
    const f = it.filter || {};
    const active = (
      (f.kind === 'type' && typeFilter === f.id && !instanceFilter && !projectFilter) ||
      (f.kind === 'project' && projectFilter === f.id && !typeFilter) ||
      (f.kind === 'instance' && instanceFilter === f.id && !typeFilter) ||
      (f.kind === 'nested' && typeFilter === f.type && (instanceFilter === f.struct || projectFilter === f.struct))
    );
    item.style.cursor = 'pointer';
    item.style.opacity = (!anyFilter || active || (it.cls === 'parent' && (instanceFilter === f.id || projectFilter === f.id))) ? '1' : '0.38';
    if (active) item.style.color = 'var(--t-primary)';
    /* v1.46 抽屉树:第一层=星域(文件夹),点一层出一层;圆点=筛选(原来整行点击筛选,与抽屉冲突) */
    if (it.key != null) {
      item.dataset.key = it.key;
      item.dataset.parent = it.parent || '';
      item.style.paddingLeft = (4 + (it.lvl || 0) * 11) + 'px';
    }
    item.innerHTML = `<span class="legend-caret"></span><span class="legend-dot" style="background:${it.color}"></span> ${it.label} <span class="legend-count">${it.count}</span>`;
    const dotEl = item.querySelector('.legend-dot');
    if (dotEl) {
      dotEl.style.cursor = it.filter ? 'pointer' : 'default';
      if (it.filter) {
        dotEl.title = '点圆点=筛选,再点一次取消';
        dotEl.onclick = (ev) => {
          ev.stopPropagation();
          applyLegendFilter(it.filter);
        };
      }
    }
    if (it.key != null) {
      item.onclick = () => { legendToggle(it.key); };
      item.title = '点这一行=展开/收起下一层';
    } else if (it.filter) {
      item.title = '点击筛选，再点一次取消';
      item.onclick = () => { applyLegendFilter(it.filter); };
    }
    el.appendChild(item);
  }
  paintLegendTree();
}
