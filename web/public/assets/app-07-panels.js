/* ══════════════════════════════════════════════════════════════════════════
   app-07-panels.js — 面板与交互:详情卡、星标、导览、全屏、搜索、管理抽屉
   (2026-09-19 从单文件 app.js 按段落边界切出;加载顺序即依赖顺序,
    全部是普通 script,共享同一个全局作用域 —— 不要在这些文件之间挪动顺序)
   ═══════════════════════════════════════════════════════════════════════ */
if (typeof ForceGraph3D !== 'undefined') __init();
else window.addEventListener('viz-libs-ready', __init);
function graphAllNodes() {
  try { return (graphInstance && graphInstance.graphData().nodes) || allData.nodes || []; }
  catch (e) { return allData.nodes || []; }
}
function memSnippet(n) {
  return String(n.fullText || n.label || n.text || '').replace(/\s+/g, ' ').trim();
}
function addTreeLabel(el, text) {
  const lab = document.createElement('div');
  lab.className = 'panel-section-label';
  lab.style.marginTop = '10px';
  lab.textContent = text;
  el.appendChild(lab);
}
function addTreeRow(el, opts) {
  const row = document.createElement('div');
  row.className = 'panel-tree-row';
  const dot = document.createElement('span');
  dot.className = 'panel-tree-dot';
  dot.style.background = opts.color || '#8A94A3';
  const title = document.createElement('span');
  title.className = 'panel-tree-title';
  title.textContent = opts.title;
  title.title = opts.title;
  row.appendChild(dot);
  row.appendChild(title);
  if (opts.count != null) {
    const c = document.createElement('span');
    c.className = 'panel-tree-count';
    c.textContent = String(opts.count);
    row.appendChild(c);
  }
  row.onclick = opts.onClick;
  el.appendChild(row);
}
function fillGalaxyTree(node, tree) {
  const p = node.__struct || node.project || node.lib;
  const mems = (allData.nodes || []).filter(n => !n.group && structKey(n) === p)
    .sort((a, b) => (b.importance || 0) - (a.importance || 0));
  const byType = {};
  mems.forEach(n => {
    const mt = n.memType || 'general';
    (byType[mt] = byType[mt] || []).push(n);
  });
  addTreeLabel(tree, '分节点');
  MEM_TYPE_ORDER.forEach(mt => {
    const list = byType[mt];
    if (!list) return;
    const sub = graphAllNodes().find(n => n.group === 'subgalaxy-core' && n.__struct === p && n.memType === mt);
    addTreeRow(tree, {
      color: MEM_TYPE_COLORS[mt] || '#8A94A3',
      title: MEM_TYPE_LABELS[mt] || mt,
      count: list.length,
      onClick: () => {
        panelStack.push(node);
        if (sub) onSubGalaxyCoreClick(sub);
      },
    });
  });
  const map = MAP_LINKS[p];
  if (map && currentMapId() === 'federation' && p !== '联邦') {
    addTreeRow(tree, {
      color: STRUCT_COLORS[p] || '#8A94A3',
      title: '打开 ' + map.label + ' 星图',
      onClick: () => { location.href = map.href; },
    });
  }
  addTreeLabel(tree, '记忆 · ' + mems.length);
  mems.forEach(n => {
    addTreeRow(tree, {
      color: memColor(n),
      title: memSnippet(n).slice(0, 72) || n.id,
      onClick: () => { panelStack.push(node); onStarNodeClick(n); },
    });
  });
}
function fillSubTree(node, tree) {
  const p = node.__struct || node.project || node.lib;
  const mt = node.memType || 'general';
  const parent = graphAllNodes().find(n => n.group === 'galaxy-core' && n.__struct === p);
  const mems = (allData.nodes || []).filter(n => !n.group && structKey(n) === p && (n.memType || 'general') === mt)
    .sort((a, b) => (b.importance || 0) - (a.importance || 0));
  if (parent) {
    const back = document.createElement('div');
    back.className = 'panel-tree-back';
    back.textContent = '← ' + (parent.__struct || parent.label || p);
    back.onclick = () => { panelStack = []; onGalaxyCoreClick(parent); };
    tree.appendChild(back);
  }
  addTreeLabel(tree, '记忆 · ' + mems.length);
  mems.forEach(n => {
    addTreeRow(tree, {
      color: memColor(n),
      title: memSnippet(n).slice(0, 72) || n.id,
      onClick: () => { panelStack.push(node); onStarNodeClick(n); },
    });
  });
}
function panelGoBack() {
  const prev = panelStack.pop();
  if (!prev) { closePanel(); return; }
  if (prev.group === 'galaxy-core') { panelStack = []; onGalaxyCoreClick(prev); }
  else if (prev.group === 'subgalaxy-core') onSubGalaxyCoreClick(prev);
  else showPanel(prev);
}
window.panelGoBack = panelGoBack;

function showPanel(node) {
  panelNode = node;
  const color = hslStyleToHex(node.__nebulaTint) || node.__galaxyColor || memColor(node);
  const starred = !!(node.starred);
  const isStruct = node.group === 'galaxy-core' || node.group === 'subgalaxy-core';
  const panel = sidePanel;
  panel.style.borderLeftColor = color;
  panel.style.borderLeftWidth = starred ? '2px' : '1px';
  panel.style.borderLeftStyle = 'solid';

  document.getElementById('panel-dot').style.background = color;
  const backBtn = document.getElementById('panel-back-btn');
  if (backBtn) backBtn.style.display = panelStack.length ? 'inline-block' : 'none';
  document.getElementById('panel-star-btn').style.display = isStruct ? 'none' : '';
  document.getElementById('panel-del-btn').style.display = isStruct ? 'none' : '';

  if (node.group === 'galaxy-core' || node.group === 'nebula-inst-core') {
    const p = node.__struct || node.project || node.lib || '';
    const nMem = (allData.nodes || []).filter(n => !n.group &&
      (node.group === 'nebula-inst-core' ? (n.instance || n.layoutGroup) === p : structKey(n) === p)).length;
    document.getElementById('panel-badge').textContent = (structLabel(p) + ' · ' + (node.group === 'nebula-inst-core' ? '星域' : (MORPH_LABELS[node.__morph] || '星系'))).toUpperCase();
    document.getElementById('panel-text').textContent = nMem + ' 条记忆';
  } else if (node.group === 'subgalaxy-core' || node.group === 'nebula-lib-core') {
    if (node.group === 'nebula-lib-core') {
      const lm = (allData.nodes || []).filter(n => !n.group && (n.instance || n.layoutGroup || n.lib) === node.instance && (n.lib || 'default') === node.lib);
      document.getElementById('panel-badge').textContent = (structLabel(node.lib) || node.lib).toUpperCase();
      document.getElementById('panel-text').textContent = (RG_NAME[node.instance] || node.instance || '') + ' 星域 / ' + (structLabel(node.lib) || node.lib) + ' 星座 · ' + lm.length + ' 星系';
    } else {
      const mt = node.memType || 'general';
      document.getElementById('panel-badge').textContent = (MEM_TYPE_LABELS[mt] || mt).toUpperCase();
      document.getElementById('panel-text').textContent = (node.__struct || '') + ' · ' + ((allData.nodes || []).filter(n => n.__clusterKey === node.__clusterKey || (structKey(n) === node.__struct && (n.memType || 'general') === mt && !n.group)).length) + ' 条记忆';
    }
  } else {
    document.getElementById('panel-badge').textContent = `${(node.memType || node.type || 'general').toUpperCase()} · ${(node.type || '').toUpperCase()}`;
    document.getElementById('panel-text').textContent = node.fullText || node.text || '';
  }
  document.getElementById('panel-badge').style.color = color;

  const hideMeta = isStruct;
  ['panel-time', 'panel-source', 'panel-importance', 'panel-importance-val'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.parentElement && el.parentElement.classList.contains('panel-section')) el.parentElement.style.display = hideMeta ? 'none' : '';
  });
  const timeSec = document.getElementById('panel-time');
  if (timeSec) {
    timeSec.textContent = node.createdAt ? new Date(node.createdAt).toLocaleString('zh-CN') : '—';
    const sec = timeSec.closest('.panel-section');
    if (sec) sec.style.display = hideMeta ? 'none' : '';
  }
  const srcEl = document.getElementById('panel-source');
  if (srcEl) {
    const srcParts = [];
    if (node.instance) srcParts.push('实例: ' + node.instance);
    if (node.source) srcParts.push('来源: ' + node.source);
    if (node.project) srcParts.push('项目: ' + node.project);
    srcEl.textContent = srcParts.join(' · ') || '—';
    const sec = srcEl.closest('.panel-section');
    if (sec) sec.style.display = hideMeta ? 'none' : '';
  }
  const impFill = document.getElementById('panel-importance');
  if (impFill) {
    impFill.style.width = ((node.importance || 0) * 100) + '%';
    const sec = impFill.closest('.panel-section');
    if (sec) sec.style.display = hideMeta ? 'none' : '';
  }
  document.getElementById('panel-importance-val').textContent = Math.round((node.importance || 0) * 100) + '%';

  const tagsEl = document.getElementById('panel-tags');
  tagsEl.innerHTML = '';
  document.getElementById('panel-tags-section').style.display = (hideMeta || !node.tags || !node.tags.length) ? 'none' : '';
  if (!hideMeta && node.tags && node.tags.length) {
    for (const t of node.tags) {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = t;
      tagsEl.appendChild(span);
    }
  }

  const treeSec = document.getElementById('panel-tree-section');
  const tree = document.getElementById('panel-tree');
  if (treeSec && tree) {
    tree.innerHTML = '';
    if (node.group === 'galaxy-core') { treeSec.style.display = ''; fillGalaxyTree(node, tree); }
    else if (node.group === 'subgalaxy-core') { treeSec.style.display = ''; fillSubTree(node, tree); }
    else treeSec.style.display = 'none';
  }

  const relEl = document.getElementById('panel-rel');
  const relSec = document.getElementById('panel-rel-section');
  if (relEl && relSec) {
    relEl.innerHTML = '';
    if (isStruct) relSec.style.display = 'none';
    else {
      const nbr = oneHopNeighbors(node.id);
      const others = [...nbr].filter(id => id !== node.id).slice(0, 6)
        .map(id => (allData.nodes || []).find(n => n.id === id)).filter(Boolean);
      if (!others.length) relSec.style.display = 'none';
      else {
        relSec.style.display = '';
        others.forEach(n => {
          const row = document.createElement('div');
          row.className = 'panel-value';
          row.style.cursor = 'pointer';
          row.style.marginBottom = '6px';
          row.textContent = (n.fullText || n.label || '').slice(0, 72);
          row.onclick = () => onStarNodeClick(n);
          relEl.appendChild(row);
        });
      }
    }
  }

  updateStarButton();
  panel.classList.add('open');
  document.body.classList.add('panel-open');
}

function updateStarButton() {
  const btn = document.getElementById('panel-star-btn');
  if (!panelNode) return;
  btn.classList.toggle('on', !!panelNode.starred);
}

async function toggleStar() {
  if (!panelNode) return;
  const id = panelNode.rawId !== undefined ? panelNode.rawId : panelNode.id;
  const lib = panelNode.lib;
  try {
    const r = await fetch('/api/memory/toggle_important', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, project: lib })
    });
    const d = await r.json();
    if (!d.ok) return;
    panelNode.importance = d.importance;
    panelNode.starred = d.starred;
    panelNode.size = (d.importance || 0.5) * 6 + 4;
    const inAll = allData && allData.nodes ? allData.nodes.find(n => n.id === panelNode.id) : null;
    if (inAll) { inAll.importance = d.importance; inAll.starred = d.starred; inAll.size = panelNode.size; }
    applyNodeSizeAndStar(panelNode);
    refreshNodeVisuals();
    updateStarButton();
    document.getElementById('panel-importance').style.width = (d.importance * 100) + '%';
    document.getElementById('panel-importance-val').textContent = Math.round(d.importance * 100) + '%';
    sidePanel.style.borderLeftWidth = d.starred ? '2px' : '1px';
  } catch (e) { /* ignore */ }
}

async function deletePanelNode() {
  if (!panelNode) return;
  const id = panelNode.rawId !== undefined ? panelNode.rawId : panelNode.id;
  const lib = panelNode.lib;
  if (!confirm('删除这条记忆?')) return;
  try {
    const r = await fetch('/api/memory/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, project: lib })
    });
    const d = await r.json();
    if (d.deleted) {
      allData.nodes = allData.nodes.filter(n => n.id !== id);
      allData.links = (allData.links || []).filter(l => {
        const s = typeof l.source === 'object' ? l.source.id : l.source;
        const t = typeof l.target === 'object' ? l.target.id : l.target;
        return s !== id && t !== id;
      });
      allData.stats = allData.stats || {};
      allData.stats.totalLinks = allData.links.length;
      closePanel();
      renderStar(allData);
      renderStarLegend(allData);
      updateStats(allData.nodes.length, allData.links.length);
      renderStats();
    }
  } catch (e) { /* ignore */ }
}

function closePanel() {
  sidePanel.classList.remove('open');
  document.body.classList.remove('panel-open');
  selectedNodeId = null;
  selNeighbors = null;
  panelNode = null;
  panelStack = [];
  refreshNodeVisuals();
}

/* ═══════════════════ 搜索过滤(直接改材质) ═══════════════════ */

/* ═══════════════════ Auto-Tour 自动导览 ═══════════════════ */
function toggleTour() {
  if (currentView !== 'galaxy' && currentView !== 'nebula') return;
  if (autoTourActive) stopAutoTour();
  else startAutoTour();
}

function startAutoTour() {
  if (!allData || !allData.nodes || !allData.nodes.length) return;
  autoTourActive = true;
  tourSeen = new Set();
  tourCursor = null;
  const btn = document.getElementById('tour-btn');
  btn.classList.add('active');
  btn.title = '停止导览';
  document.getElementById('tour-indicator').classList.add('on');
  walkToNextMemory();
  autoTourTimer = setInterval(walkToNextMemory, 9000);
}

let tourCursor = null;
let tourSeen = new Set();

function tourNeighbors(node) {
  if (!graphInstance || !node) return [];
  const links = graphInstance.graphData().links || [];
  const id = node.id;
  const out = [];
  links.forEach(l => {
    if (l.type === 'similarity' || (l.type || '').indexOf('galaxy') === 0 || (l.type || '').indexOf('subgalaxy') === 0) return;
    const s = (l.source && typeof l.source === 'object') ? l.source.id : l.source;
    const t = (l.target && typeof l.target === 'object') ? l.target.id : l.target;
    if (s === id) out.push(t);
    else if (t === id) out.push(s);
  });
  return out.map(nid => (allData.nodes || []).find(n => n.id === nid)).filter(Boolean);
}

function pickWalkNode() {
  const nodes = (allData.nodes || []).filter(n => !n.dimmed && !n.group);
  if (!nodes.length) return null;
  if (tourSeen.size >= nodes.length) tourSeen = new Set();
  if (tourCursor) {
    const nbr = tourNeighbors(tourCursor).filter(n => !tourSeen.has(n.id));
    if (nbr.length) return nbr[Math.floor(Math.random() * nbr.length)];
    const same = nodes.filter(n => !tourSeen.has(n.id) && n.memType === tourCursor.memType && (n.project || n.lib) === (tourCursor.project || tourCursor.lib));
    if (same.length) return same[0];
    const sameProj = nodes.filter(n => !tourSeen.has(n.id) && (n.project || n.lib) === (tourCursor.project || tourCursor.lib));
    if (sameProj.length) return sameProj[0];
  }
  const rest = nodes.filter(n => !tourSeen.has(n.id));
  rest.sort((a, b) => (b.importance || 0) - (a.importance || 0));
  return rest[0] || nodes[0];
}

function walkToNextMemory() {
  if (!allData || !allData.nodes || !allData.nodes.length || !graphInstance) return;
  const node = pickWalkNode();
  if (!node) return;
  tourCursor = node;
  tourSeen.add(node.id);
  autoTargetId = node.id;
  document.getElementById('tour-indicator-label').textContent = '散步 · ' + ((node.fullText || node.label || '').substring(0, 25));
  refreshNodeVisuals();
  showPanel(node);
  const nx = node.x || 0, ny = node.y || 0, nz = node.z || 0;
  const d = Math.hypot(nx, ny, nz) || 1;
  graphInstance.cameraPosition({ x: nx * (1 + 70 / d), y: ny * (1 + 70 / d) + 18, z: nz * (1 + 70 / d) }, { x: nx, y: ny, z: nz }, 2200);
}

function stopAutoTour() {
  if (autoTourTimer) { clearInterval(autoTourTimer); autoTourTimer = null; }
  autoTourActive = false;
  autoTargetId = null;
  const btn = document.getElementById('tour-btn');
  if (btn) { btn.classList.remove('active'); btn.title = '导览'; }
  document.getElementById('tour-indicator').classList.remove('on');
  refreshNodeVisuals();
}

/* ═══════════════════ 沉浸全屏 ═══════════════════ */
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    const el = document.body;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (fn) { try { fn.call(el); } catch (e) {} }
  }
}

document.addEventListener('fullscreenchange', () => {
  const fs = !!document.fullscreenElement;
  const btn = document.getElementById('fs-btn');
  btn.title = fs ? '退出全屏' : '全屏';
  btn.classList.toggle('active', fs);
  btn.classList.toggle('active', fs);
  if (graphInstance) graphInstance.backgroundColor(fs ? '#000000' : '#07090D');
  document.body.style.background = fs ? '#000' : '';
});

/* ═══════════════════ 详情卡片 ═══════════════════ */

function matchesNode(n, q) {
  return (n.fullText || '').toLowerCase().includes(q) ||
    (n.tags || []).some(t => (t || '').toLowerCase().includes(q)) ||
    (n.category || '').toLowerCase().includes(q) ||
    (n.type || '').toLowerCase().includes(q) ||
    (n.memType || '').toLowerCase().includes(q);
}

function applySearchVisuals() {
  if (!allData || !allData.nodes) return;
  searchQuery = (document.getElementById('search-input').value || '').trim().toLowerCase();
  recomputeDim();
}

document.getElementById('search-input').addEventListener('input', () => {
  if (currentView !== 'galaxy' && currentView !== 'nebula') return;
  applySearchVisuals();
});

/* ═══════════════════ 管理抽屉逻辑 ═══════════════════ */
function toggleAdmin() {
  const open = adminDrawer.classList.toggle('open');
  document.getElementById('admin-btn').classList.toggle('active', open);
  if (open) { loadConfig(); loadMems(); }
}

function toggleEmbedMode() {
  const mode = document.getElementById('embedMode').value;
  document.getElementById('embedOllamaFields').style.display = mode === 'ollama' ? '' : 'none';
  document.getElementById('embedApiFields').style.display = mode === 'api' ? '' : 'none';
}

function log(msg, cls='log-info') {
  const el = document.getElementById('log');
  const time = new Date().toLocaleTimeString();
  el.innerHTML += `<span class="${cls}">[${time}] ${msg}</span>\n`;
  el.scrollTop = el.scrollHeight;
}

function fillConfigForm(d) {
  const emb = d.embedding || {};
  document.getElementById('embedMode').value = emb.mode || 'ollama';
  document.getElementById('embOllamaUrl').value = emb.ollama_url || 'http://127.0.0.1:11436';
  document.getElementById('embOllamaModel').value = emb.model || 'yuan-embedding-2.0-zh';
  document.getElementById('embApiUrl').value = emb.api_url || '';
  document.getElementById('embApiKey').value = emb.api_key && emb.api_key !== '****' ? emb.api_key : '';
  document.getElementById('embApiModel').value = emb.api_model || '';
  const ref = d.reflect || {};
  document.getElementById('refUrl').value = ref.llm_url || 'https://api.deepseek.com/v1';
  document.getElementById('refKey').value = ref.api_key && ref.api_key !== '****' ? ref.api_key : '';
  document.getElementById('refModel').value = ref.model || 'deepseek-chat';
  document.getElementById('refFactExtract').value = ref.factExtraction || 'auto';
  document.getElementById('refMaxFacts').value = ref.maxFacts ?? 15;
  document.getElementById('refMinGap').value = ref.minGapHours ?? 24;
  document.getElementById('refMinUnan').value = ref.minUnanalyzed ?? 5;
  document.getElementById('refInterval').value = ref.intervalHours ?? 0;
  const tri = d.triage || {};
  document.getElementById('triUrl').value = tri.llm_url || '';
  document.getElementById('triKey').value = tri.api_key && tri.api_key !== '****' ? tri.api_key : '';
  document.getElementById('triModel').value = tri.model || '';
  document.getElementById('triBuffer').value = tri.bufferSize ?? 5;
  document.getElementById('triBufTok').value = tri.bufferTokens ?? 4000;
  document.getElementById('triTtl').value = tri.sessionTtlDays ?? 7;
  const cons = d.consolidate || {};
  document.getElementById('consMin').value = cons.minMemories ?? 15;
  document.getElementById('consSim').value = cons.similarity ?? 0.88;
  document.getElementById('consAuto').value = (cons.autoOnStart === false || cons.autoOnStart === 0 || cons.autoOnStart === '0') ? '0' : '1';
  toggleEmbedMode();
}

async function loadConfig() {
  try {
    const r = await fetch('/api/config?scope=all');
    const d = await r.json();
    fillConfigForm(d.config || d);
    const box = document.getElementById('cfgInstances');
    if (box && Array.isArray(d.instances)) {
      box.innerHTML = d.instances.map((it) => {
        const cls = it.exists ? 'cfg-chip on' : 'cfg-chip warn';
        const st = it.exists ? '已有配置' : '保存时创建';
        return `<span class="${cls}">${it.name} · ${st}</span>`;
      }).join('');
      if (d.inSync === false) {
        box.innerHTML += '<span class="cfg-chip warn">各端不一致，表单显示第一份。保存到全部可对齐</span>';
      }
    }
    document.getElementById('configStatus').innerHTML = '<span class="badge badge-ok">已加载</span>';
  } catch (e) {
    document.getElementById('configStatus').innerHTML = '<span class="badge badge-err">加载失败</span>';
    log('加载配置失败: ' + e.message, 'log-err');
  }
}

async function saveAllConfig() {
  const mode = document.getElementById('embedMode').value;
  const cfg = {
    embedding: {
      mode,
      ollama_url: document.getElementById('embOllamaUrl').value.trim(),
      model: document.getElementById('embOllamaModel').value.trim(),
      api_url: document.getElementById('embApiUrl').value.trim(),
      api_key: document.getElementById('embApiKey').value.trim(),
      api_model: document.getElementById('embApiModel').value.trim(),
    },
    reflect: {
      llm_url: document.getElementById('refUrl').value.trim(),
      api_key: document.getElementById('refKey').value.trim(),
      model: document.getElementById('refModel').value.trim() || 'deepseek-chat',
      factExtraction: document.getElementById('refFactExtract').value === 'off' ? 'off' : 'auto',
      maxFacts: parseInt(document.getElementById('refMaxFacts').value, 10) || 15,
      minGapHours: parseFloat(document.getElementById('refMinGap').value) || 24,
      minUnanalyzed: parseInt(document.getElementById('refMinUnan').value, 10) || 0,
      intervalHours: parseFloat(document.getElementById('refInterval').value) || 0,
    },
    triage: {
      llm_url: document.getElementById('triUrl').value.trim(),
      api_key: document.getElementById('triKey').value.trim(),
      model: document.getElementById('triModel').value.trim(),
      bufferSize: parseInt(document.getElementById('triBuffer').value, 10) || 5,
      bufferTokens: parseInt(document.getElementById('triBufTok').value, 10) || 4000,
      sessionTtlDays: parseInt(document.getElementById('triTtl').value, 10) || 7,
    },
    consolidate: {
      minMemories: parseInt(document.getElementById('consMin').value, 10) || 15,
      similarity: parseFloat(document.getElementById('consSim').value) || 0.88,
      autoOnStart: document.getElementById('consAuto').value !== '0',
    },
  };
  try {
    cfg.applyTo = (document.getElementById('cfgApplyTo') || {}).value || 'all';
    const r = await fetch('/api/config', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(cfg)
    });
    const d = await r.json();
    document.getElementById('configStatus').innerHTML = '<span class="badge badge-ok">已保存</span>';
    log('配置已保存 ✓ ' + (d.note || ''), 'log-ok');
  } catch(e) {
    document.getElementById('configStatus').innerHTML = '<span class="badge badge-err">保存失败</span>';
    log('保存失败: ' + e.message, 'log-err');
  }
}

async function runReflect(mode) {
  const btn = mode === 'deep' ? document.getElementById('btnDeep') : document.getElementById('btnRun');
  btn.disabled = true; btn.textContent = '⏳ 反思中(可能需 1-2 分钟)...';
  log(mode === 'deep' ? '🔬 深度校准 — 分析全部记忆...' : '▶ 日常反思...', 'log-hl');
  try {
    const r = await fetch('/api/reflect/run', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ mode })
    });
    const d = await r.json();
    if (d.error) {
      log('❌ ' + d.error, 'log-err');
    } else if (d.skipped) {
      log('⏭ 跳过: ' + (d.errors || []).join('; '), 'log-info');
    } else {
      log(`✅ 完成! 分析 ${d.conversationCount || d.memoryCount || '?'} 条,应用了 ${d.applied}/${d.actions} 个操作`, 'log-ok');
      (d.errors || []).forEach(e => log('⚠️ ' + e, 'log-err'));
      document.getElementById('lastRun').textContent = '上次运行: ' + new Date().toLocaleString();
      refreshGraph();
    }
  } catch(e) {
    log('❌ 反思失败: ' + e.message, 'log-err');
  }
  btn.disabled = false; btn.textContent = mode === 'deep' ? '🔬 深度校准' : '▶ 日常反思';
}

function clearLog() { document.getElementById('log').innerHTML = ''; }

let allMems = [];

async function loadMems() {
  try {
    const r = await fetch('/api/memory?limit=200');
    allMems = await r.json();
    renderMems(allMems);
  } catch(e) { log('记忆加载失败: '+e.message, 'log-err'); }
}

function filterMems() {
  const q = document.getElementById('memFilter').value.toLowerCase();
  renderMems(q ? allMems.filter(m => (m.text||'').toLowerCase().includes(q)) : allMems);
}

function renderMems(list) {
  const el = document.getElementById('memList');
  el.innerHTML = list.slice(0,80).map(m => {
    return `<div class="mem-item">
      <div class="mem-body">
        <span class="mem-cat">${m.category||'?'}</span>
        ${m.tier==='critical'?'<span class="badge badge-ok">critical</span>':''}
        ${m.locked?'<span style="color:#f90">🔒</span>':''}
        <div class="mem-text">${(m.text||'').substring(0,70)}</div>
        <div class="mem-meta">${(m.id||'').substring(0,8)} | ${(m.createdAt||'').substring(0,10)} | ${(m.source||'').substring(0,12)}</div>
      </div>
      <div class="mem-actions">
        <button class="btn btn-danger" onclick="delMem('${m.id}')">✕</button>
      </div>
    </div>`;
  }).join('');
}

async function delMem(id) {
  if (!confirm('删除这条记忆?')) return;
  try {
    const r = await fetch('/api/memory/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id}) });
    const d = await r.json();
    log(d.deleted ? '已删除: '+id.substring(0,8) : '删除失败', d.deleted ? 'log-ok' : 'log-err');
    loadMems();
    refreshGraph();
  } catch(e) { log('删除失败: '+e.message, 'log-err'); }
}

function refreshGraph() {
  fetch('/api/graph?scope=' + encodeURIComponent(GRAPH_SCOPE) + '&layout=folder-wedges').then(r => r.json()).then(data => {
    allData = data;
    updateStats(data.nodes.length, data.stats ? data.stats.totalLinks : data.links.length);
    if (currentView === 'nebula') {
      renderNebula(data);
      renderStats();
      setTimeout(applySearchVisuals, 0);
    } else if (currentView === 'galaxy') {
      renderStar(data);
      renderStarLegend(data);
      renderStats();
      setTimeout(applySearchVisuals, 0);
    }
  }).catch(() => {});
}
