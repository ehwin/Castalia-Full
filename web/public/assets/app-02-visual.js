/* ══════════════════════════════════════════════════════════════════════════
   app-02-visual.js — 节点视觉模型:结构色系、取色、核心星、节点构建、LOD
   (2026-09-19 从单文件 app.js 按段落边界切出;加载顺序即依赖顺序,
    全部是普通 script,共享同一个全局作用域 —— 不要在这些文件之间挪动顺序)
   ═══════════════════════════════════════════════════════════════════════ */
const sidePanel = document.getElementById('side-panel');
const loading = document.getElementById('loading');
const adminDrawer = document.getElementById('admin-drawer');
let graphInstance = null;
let allData = null;
let currentView = 'nebula';
let selectedNodeId = null;
let selNeighbors = null;
let panelNode = null;
let autoTourActive = false;
let autoTourTimer = null;
let autoTargetId = null;
let panelStack = [];

/* ═══════════════════ 节点渲染 (THREE.Group = 核心球 + 光晕 + 文字 Sprite) ═══════════════════ */
const _geoCache = new Map();
const _texCache = new Map();

function sphereGeo(radius) {
  const key = Math.round(radius * 100);
  if (!_geoCache.has(key)) _geoCache.set(key, new THREE.SphereGeometry(radius, 24, 24));
  return _geoCache.get(key);
}

function makeLabelTexture(text, color) {
  const key = text + '|' + color;
  if (_texCache.has(key)) return _texCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const maxChars = 22;
  const displayText = text.length > maxChars ? text.substring(0, maxChars) + '…' : text;
  ctx.font = 'bold 24px "JetBrains Mono", Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.fillText(displayText, 256, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  if (_texCache.size > 800) { const first = _texCache.keys().next().value; _texCache.delete(first); }
  _texCache.set(key, texture);
  return texture;
}

/* v1.17.3 色系:星域→大色相,星座→同色系色阶 */

const CATEGORY_LABELS = {
  conversation: '对话', knowledge: '知识', milestone: '里程碑', identity: '身份',
  relationship: '关系', emotional: '情绪', mood_snapshot: '心境快照', preference: '偏好',
  decision: '定案', mistake: '教训', session: '会话', session_promoted: '会话沉淀',
  agent_mood: '心境', general: '通用', 'custom': 'custom', default: '默认',
};
function catLabel(c) { return CATEGORY_LABELS[c] || c; }
const RG_HUE = { 'Hermes': 168, 'LobeHub': 212, 'AIRI': 335, '联邦': 44,
  'hermes': 168, 'lobehub': 212, 'airi': 335, 'lobehub ': 212 };
const RG_NAME = { 'Hermes': 'Hermes', 'LobeHub': 'LobeHub', 'AIRI': 'AIRI', '联邦': '总反思', 'federation': '联邦总图',
  'hermes': 'Hermes', 'lobehub': 'LobeHub', 'airi': 'AIRI' };
function regionHueOf(rg) { return RG_HUE[rg] != null ? RG_HUE[rg] : Math.floor(hash01(String(rg), 7) * 360); }
function regionColorOf(rg) { return 'hsl(' + regionHueOf(rg) + ', 72%, 56%)'; }
/* v1.32 亮度拉齐:同样 L 下蓝/紫的**感知亮度**只有青绿/琥珀的约 1/3
 * —— 用户实测:"LobeHub 看着比 Hermes 暗淡好多"(LobeHub 主色 hsl(216,66%,50%) Y=0.17,
 * Hermes 主色 hsl(172,66%,50%) Y=0.51)。做法:按感知亮度给每个色相算一个整体提亮量
 * (以 50% 亮度的基准色为准),色阶梯度(l=50→80)照旧保留,只是整片抬亮。 */
const _shadeLift = new Map();
function hslRelLum(h, s, l) {   /* s,l ∈ 0..1;返回 sRGB 相对亮度(与 hslStyleToHex 同一套公式) */
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(f(0)) + 0.7152 * lin(f(8)) + 0.0722 * lin(f(4));
}
function lightForRelLum(h, s, target) {   /* 二分出最接近目标感知亮度的 L(百分数) */
  let lo = 20, hi = 92;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (hslRelLum(h, s, mid / 100) < target) lo = mid; else hi = mid;
  }
  return hi;
}
const SHADE_MIN_LUM = 0.30;   /* 基准色最低感知亮度(达不到就抬亮;已经更亮的星域不动) */
const SHADE_MAX_L = 88;       /* 抬亮后最高亮度上限,避免糊成白 */
function consShadeOf(rg, cons, ci, total) {
  const h = regionHueOf(rg);
  const drift = (ci % 2 === 0 ? -1 : 1) * (4 + (ci % 3) * 3);
  const t = total > 1 ? ci / (total - 1) : 0.4;
  const hue = (h + drift + 360) % 360;
  const sat = Math.round(66 - 10 * t);
  let lift = _shadeLift.get(hue);
  if (lift == null) {
    lift = Math.max(0, lightForRelLum(hue, 0.66, SHADE_MIN_LUM) - 50);
    _shadeLift.set(hue, lift);
  }
  const l = Math.min(SHADE_MAX_L, Math.round(50 + 30 * t + lift));
  return 'hsl(' + hue + ', ' + sat + '%, ' + l + '%)';
}

/* v1.31:hsl 串('hsl(168, 72%, 56%)')→ hex(three 的 Color 解析各版本不一,自己转最稳) */
/* ═══ v1.43 亮度/色相平衡 ═════════════════════════════════════════════════
 * 用户:"亮度够了,但是色相低了" —— 往白里提(liftColor)虽然提亮,但饱和度被稀释。
 * 做法:把目标亮度定为"白化 t=0.42 时的**感知亮度 Y**"不变,色相不动、饱和度 +0.22,
 * 再二分求出达到该亮度所需的 L → 亮度一样,颜色更实(色相回来了)。
 */
const TINT_SAT_BOOST = 0.22;      /* 饱和度补偿(白化丢掉的色) */
const TINT_MAX_SAT = 0.94, TINT_MAX_L = 88;
const WHITE_LERP_EQ = 0.42;       /* 等价于原 liftColor(...,0.42) 的亮度 */
const _lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function hsl2rgb01(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}
function relLum01(r, g, b) { return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b); }
function hex01(r, g, b) {
  return '#' + [r, g, b].map((c) => ('0' + Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16)).slice(-2)).join('');
}
/* 'hsl(h,s%,l%)' → 亮度对齐、饱和度补偿后的 hex */
function brightenTintHex(str) {
  const m = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/.exec(String(str || ''));
  if (!m) return null;
  const h = +m[1], s = +m[2] / 100, l = +m[3] / 100;
  const base = hsl2rgb01(h, s, l);
  /* 目标亮度 = 白化后的感知亮度 */
  const wl = base.map((c) => c + (1 - c) * WHITE_LERP_EQ);
  const targetY = relLum01(wl[0], wl[1], wl[2]);
  const s2 = Math.min(TINT_MAX_SAT, s + TINT_SAT_BOOST);
  let lo = 0.05, hi = TINT_MAX_L / 100;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const c = hsl2rgb01(h, s2, mid);
    if (relLum01(c[0], c[1], c[2]) < targetY) lo = mid; else hi = mid;
  }
  const rgb = hsl2rgb01(h, s2, hi);
  return hex01(rgb[0], rgb[1], rgb[2]);
}

/* v1.40 提亮:把任意颜色往白里提 t(0~1),色相基本不变、只提亮度 */
function liftColor(css, t) {
  try {
    const c = new THREE.Color(css);
    c.lerp(new THREE.Color(0xffffff), Math.max(0, Math.min(0.5, t || 0)));
    return '#' + c.getHexString();
  } catch (e) { return css; }
}

function hslStyleToHex(str) {
  const m = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/.exec(String(str || ''));
  if (!m) return null;
  const h = +m[1], s2 = +m[2] / 100, l = +m[3] / 100;
  const a = s2 * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return '#' + [f(0), f(8), f(4)].map(x => ('0' + x.toString(16)).slice(-2)).join('');
}

function memColor(node) {
  if (node.group === 'galaxy-core' || node.group === 'nebula-inst-core') return node.__galaxyColor || '#fbbf24';
  if (node.group === 'subgalaxy-core' || node.group === 'nebula-lib-core') return node.__galaxyColor || '#64748b';
  if (node.memType && MEM_TYPE_COLORS[node.memType]) return MEM_TYPE_COLORS[node.memType];
  if (node.type && TYPE_FALLBACK_COLORS[node.type]) return TYPE_FALLBACK_COLORS[node.type];
  return '#64748b';
}

/* 核心大星通用构建:大球 + 双层光晕 + 名字标签(柔和低调,不抢节点) */
function buildCoreNode(node, R, labelW) {
  const color = brightenTintHex(node.__galaxyColor) || liftColor(hslStyleToHex(node.__galaxyColor) || node.__galaxyColor || '#fbbf24', 0.36);   /* v1.43 同亮度+饱和度补偿 */
  const group = new THREE.Group();
  const core = new THREE.Mesh(sphereGeo(R), new THREE.MeshBasicMaterial({ color, transparent: false, opacity: 1 }));
  group.add(core);
  /* v1.36:内圈彩色辉光恢复,外圈白色大环(2.2 倍)仍按"外圈光晕"删除 */
  const glow1 = new THREE.Mesh(sphereGeo(R * 1.35), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false }));   /* v1.39 回一点亮 */
  group.add(glow1);
  const name = (node.shortLabel || node.label || node.project || '').split('·')[0].trim();
  let spr = null;   /* v1.28:提到外层 —— 标签 sprite 必须存回节点,否则分级标签管不到它 */
  if (name) {
    const mat = new THREE.SpriteMaterial({ map: makeLabelTexture(name, color), transparent: true, depthTest: false, sizeAttenuation: true });
    spr = new THREE.Sprite(mat);
    const w = Math.max(16, Math.min(32, 10 + name.length * 1.5));
    spr.scale.set(w, 4.2, 1);
    spr.position.set(0, -(R + 5), 0);
    group.add(spr);
  }
  node.__group = group;
  node.__coreMesh = core;
  node.__glowMesh = glow1;
  node.__baseColor = color;
  /* v1.28 修:核心节点的标签 sprite 之前**没有存回节点**(buildNode 里那句
   * `if (node.__labelAlways && node.__labelSprite)` 因此永远为假 = 死代码),
   * 导致星座名既不归分级标签管、也一直是建图时的小尺寸(远看等于没有)。 */
  if (spr) { node.__labelSprite = spr; node.__labelMat = spr.material; }
  return group;
}

/* 小星系核心小星(分类级,memType 色) */

/* 点击星系核心:飞行到该星系并弹出项目统计 */
function onGalaxyCoreClick(node) {
  if (!node) return;
  stopAutoTour();
  panelStack = [];
  expandedKey = null;
  selectedNodeId = node.id;
  if (graphInstance) graphInstance.nodeVisibility(n => lodVisible(n));
  flyTo(node, 1000);
  showPanel(node);
}

/* 点击小星系核心:飞行到该小星系并弹出分类统计 */
function onSubGalaxyCoreClick(node) {
  if (!node) return;
  stopAutoTour();
  const p = node.__struct || node.project || node.lib || '';
  const mt = node.memType || 'general';
  expandedKey = p + '::' + mt;
  selectedNodeId = node.id;
  if (graphInstance) {
    graphInstance.nodeVisibility(n => lodVisible(n));
    graphInstance.linkVisibility(l => lodLinkVisible(l));
  }
  flyTo(node, 900);
  showPanel(node);
}

/* 星云结构核心点击:v1.17.2 三层下钻 */
function onNebulaStructClick(node) {
  if (!node) return;
  stopAutoTour();
  const isInst = node.group === 'nebula-inst-core';
  selectedNodeId = node.id;
  if (isInst) {
    /* 实例:过滤到该软件 */
    instanceFilter = node.__struct;
    typeFilter = null; projectFilter = null;
  } else {
    /* 文件夹:过滤到该库(instance+lib) */
    instanceFilter = node.instance;
    projectFilter = node.lib;
    typeFilter = null;
  }
  recomputeDim();
  updateNebulaState((allData.nodes || []).filter(n => !n.group));
  flyTo(node, 900);
  showPanel(node);
}

/* 语义簇色板(renderStar 聚类时使用,下标与 __clusterColorKey 对应) */
const CLUSTER_COLORS_GLOBAL = ['#5cdbd3', '#ffa940', '#b37feb', '#69c0ff', '#ff85c0', '#95de64', '#ffd666', '#f759ab', '#40a9ff', '#a0d911'];

function buildNode(node) {
  if (typeof THREE === 'undefined') return null; // CDN 失败时回退默认球体
  if (node.group === 'galaxy-core') return buildCoreNode(node, 5.6, 5);
  if (node.group === 'nebula-inst-core') {
    /* v1.28 星域级标签:只出名字(不复活 v1.17.5 删掉的"星域大星"),尺寸由 updateLabelScales 按屏幕像素给 */
    const g = new THREE.Group();
    const color = node.__galaxyColor || '#fbbf24';
    const mat = new THREE.SpriteMaterial({ map: makeLabelTexture(node.shortLabel || node.label || '', color), transparent: true, depthTest: false, sizeAttenuation: true });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(200, 25, 1);
    g.add(spr);
    node.__group = g; node.__labelSprite = spr; node.__labelMat = mat; node.__labelLevel = 'region';
    return g;
  }
  if (node.group === 'subgalaxy-core' || node.group === 'nebula-lib-core') {
    const grp = buildCoreNode(node, node.__labelAlways ? 2.2 : 2.6, 3.4);
    /* v1.17.5:星座名常驻——标签更大更靠上,以星团为锚 */
    if (node.__labelAlways && node.__labelSprite) {
      const nm = catLabel(node.lib || node.project || '');
      const w = Math.max(18, Math.min(40, 12 + String(nm).length * 2.2));
      node.__labelSprite.scale.set(w, 5, 1);
      node.__labelSprite.position.set(0, -(node.size + 10), 0);
      node.__importantLabel = true;
    }
    return grp;
  }
  const size = node.size || 6;
  /* v1.31 配色口径:星云视图里点 = 所属星座色阶(星域一个色系)。
   * 原来固定 memColor()(=memType 色),于是 Hermes 的 user 星团与 LobeHub 的 user 星团
   * 撞成同一种青绿 —— 用户实测"Hermes 的颜色怎么和 LobeHub 一样了"。 */
  const color = (currentView === 'nebula' && brightenTintHex(node.__nebulaTint)) || memColor(node);
  const important = (node.importance || 0) >= 0.85;   // V3:重要记忆更强发光
  const clusterCol = node.__cluster ? CLUSTER_COLORS_GLOBAL[node.__clusterColorKey || 0] : null;
  const group = new THREE.Group();

  const coreMesh = new THREE.Mesh(sphereGeo(size * 0.42), new THREE.MeshBasicMaterial({ color }));
  /* v1.36 按用户口径回退一半:删的是**外圈光晕**(那层大雾 + important 的 1.7 倍外环),
   * 而点自身的**内圈柔光**要留(否则整片过于暗淡)。内圈亮度比原来再抬一点(op .16→.22 / .4→.5)。 */
  /* v1.37:光晕改成"点自己的颜色 + 更小更淡" —— 原来是 ① 用语义簇色(于是青绿点套粉圈、看着像外环)
   * ② 半径 0.7~1.15 倍、op .22/.50(圈太显眼,用户:"右上角的外圈光晕看着太多了")。
   * 现在 0.5~0.85 倍 + op .18/.38,只是把点"点亮",不再形成可见外环。 */
  const glowColor = color;
  /* v1.38:光晕统一(不再按 important 加大) —— 只做点外一小圈同色柔光,半径 0.5 倍、op .16,
   * 保证相邻点的柔光不互相叠成一片。 */
  const glowMesh = new THREE.Mesh(
    sphereGeo(size * 0.62),
    new THREE.MeshBasicMaterial({ color: glowColor, transparent: true, opacity: 0.30,
      blending: THREE.AdditiveBlending, depthWrite: false })
  );
  group.add(glowMesh);
  const hit = new THREE.Mesh(
    sphereGeo(Math.max(size * 2.1, 6)),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, depthTest: false })
  );
  group.add(hit);

  let labelSprite = null, labelMat = null;
  // V3:文字标签默认隐藏(防密集),选中/悬停时才显示;星系/小星系核心始终显示
  const labelText = node.fullText || node.label || '';
  if (labelText) {
    labelMat = new THREE.SpriteMaterial({ map: makeLabelTexture(labelText, color), transparent: true, depthTest: false, sizeAttenuation: true });
    labelSprite = new THREE.Sprite(labelMat);
    labelSprite.scale.set(size * 6, size * 0.9, 1);
    labelSprite.position.set(0, -(size + 4), 0);
    labelSprite.visible = false;
    group.add(labelSprite);
  }

  let starMesh = null;
  if (node.starred) {
    starMesh = new THREE.Mesh(sphereGeo(size * 0.2), new THREE.MeshBasicMaterial({ color: 0xf43f5e }));
    starMesh.position.set(0, size + 2, 0);
    group.add(starMesh);
  }

  node.__group = group;
  node.__coreMesh = coreMesh;
  node.__glowMesh = glowMesh;
  node.__coreMat = coreMesh.material;
  node.__glowMat = glowMesh.material;
  node.__labelSprite = labelSprite;
  node.__labelMat = labelMat;
  node.__starMesh = starMesh;
  node.__important = important;
  node.__baseColor = color;

  return group;
}

/* 单节点视觉状态刷新(选中/导览金高亮/搜索变灰) — 直接改材质,不重建几何/纹理 */
function applyNodeVisual(node) {
  const isDim = !!node.dimmed;
  const isTour = autoTargetId != null && node.id === autoTargetId;
  const isSel = selectedNodeId != null && node.id === selectedNodeId;
  const isHover = hoveredNodeId != null && node.id === hoveredNodeId;
  /* v1.28 标签分级:结构标签(星域/星座/星系)按缩放档位显隐;记忆点名称只 hover/选中(近档才常驻重要记忆) */
  if (node.__labelSprite) {
    const lv = node.__labelLevel;
    if (lv) node.__labelSprite.visible = !isDim && labelVisibleAt(lv);
    else {
      const isCore = node.group === 'galaxy-core' || node.group === 'subgalaxy-core';
      const canAlways = !!(node.__importantLabel || node.__labelAlways);
      node.__labelSprite.visible = !isDim && (isSel || isHover || isCore || (canAlways && labelTier === 'near'));
    }
    if (node.__labelMat) node.__labelMat.opacity = isDim ? 0 : (lv ? 0.95 : (node.group === 'nebula-gal-core' ? 0.7 : 0.95));
  }
  if (node.__coreMat) {   /* v1.35:光晕删掉后,由核心球自身承担高亮(hover/选中变白)与暗化反馈 */
    node.__coreMat.color.set(isDim ? '#3c3c46' : (isTour ? '#fbbf24' : (isSel || isHover ? '#ffffff' : (node.__baseColor || '#64748b'))));
    node.__coreMat.opacity = isDim ? 0.3 : 1;
  }
  if (!node.__glowMat) return;
  const base = node.__baseColor || '#64748b';
  // 簇成员:基础光晕色 = 簇色(非 dim/导览/选中/悬停态时显示簇色扎堆)
  const baseGlowColor = base;   /* v1.37:不再用语义簇色,光晕跟点同色(避免异色外环) */
  const glowColor = isDim ? '#3c3c46' : (isTour ? '#fbbf24' : baseGlowColor);
  const isNbr = !isSel && !isHover && !isDim && selNeighbors != null && selNeighbors.has(node.id);
  const baseGlow = 0.30;   /* v1.39 统一提亮(0.16 → 0.26) */
  const glowOpacity = isDim ? 0.03 : (isTour ? 0.88 : (isSel ? 0.95 : (isHover ? 0.58 : (isNbr ? 0.30 : baseGlow))));
  node.__glowMat.color.set(glowColor);
  node.__glowMat.opacity = glowOpacity;
  if (node.__coreMat) node.__coreMat.color.set(isDim ? '#3c3c46' : (isTour ? '#fbbf24' : base));
}

function refreshNodeVisuals() {
  if (!allData || !allData.nodes) return;
  for (const n of allData.nodes) applyNodeVisual(n);
}

/* 星标切换 → 重设尺寸/星标小球(保留相机视角) */
function applyNodeSizeAndStar(node) {
  if (typeof THREE === 'undefined') return;
  const size = node.size || 6;
  if (node.__coreMesh) node.__coreMesh.geometry = sphereGeo(size * 0.5);
  if (node.__glowMesh) node.__glowMesh.geometry = sphereGeo(node.__important ? size * 1.15 : size * 0.85);
  if (node.__labelSprite) {
    node.__labelSprite.position.set(0, -(size + 4), 0);
    node.__labelSprite.scale.set(size * 6, size * 0.9, 1);
  }
  if (node.starred && !node.__starMesh) {
    node.__starMesh = new THREE.Mesh(sphereGeo(size * 0.2), new THREE.MeshBasicMaterial({ color: 0xf43f5e }));
    node.__starMesh.position.set(0, size + 2, 0);
    node.__group.add(node.__starMesh);
  } else if (!node.starred && node.__starMesh) {
    node.__group.remove(node.__starMesh);
    node.__starMesh = null;
  }
}

let flyingUntil = 0;
function flyTo(node, ms) {
  if (!graphInstance || !node) return;
  markInteraction();
  flyingUntil = Date.now() + (ms || 2000) + 100;
  if (currentView === 'nebula') {
    const nx = node.x || 0, ny = node.y || 0, nz = node.z || 0;
    const distance = Math.max(90, (window.__universeR || 220) * 0.45);
    let dx = 0, dy = 18, dz = distance;
    try {
      const cam = graphInstance.camera();
      dx = cam.position.x - nx;
      dy = cam.position.y - ny;
      dz = cam.position.z - nz;
    } catch (e) {}
    const len = Math.hypot(dx, dy, dz) || 1;
    graphInstance.cameraPosition({
      x: nx + dx / len * distance,
      y: ny + dy / len * distance,
      z: nz + dz / len * distance,
    }, node, ms == null ? 900 : ms);
    try { graphInstance.controls().target.set(nx, ny, nz); } catch (e) {}
    return;
  }
  const distance = node.group === 'galaxy-core' ? 110 : (node.group === 'subgalaxy-core' ? 64 : 72);
  let dx = 0, dy = 18, dz = distance;
  try {
    const cam = graphInstance.camera();
    dx = cam.position.x - (node.x || 0);
    dy = cam.position.y - (node.y || 0);
    dz = cam.position.z - (node.z || 0);
  } catch (e) {}
  const len = Math.hypot(dx, dy, dz) || 1;
  const newPos = {
    x: (node.x || 0) + dx / len * distance,
    y: (node.y || 0) + dy / len * distance,
    z: (node.z || 0) + dz / len * distance,
  };
  graphInstance.cameraPosition(newPos, node, ms == null ? 2000 : ms);
  try { graphInstance.controls().target.set(node.x, node.y, node.z); } catch (e) {}
}
window.flyTo = flyTo;

const LOD_DIST = 1600;
let lodFar = null;
function cameraDist() {
  try {
    const c = graphInstance.camera();
    return Math.hypot(c.position.x, c.position.y, c.position.z);
  } catch (e) { return 0; }
}
function lodVisible(n) {
  if (n.group === 'galaxy-core' || n.group === 'subgalaxy-core') return true;
  if (n.group === 'nebula-inst-core' || n.group === 'nebula-lib-core') return true;
  if (currentView === 'nebula') return n.__shown !== false;
  if (expandedKey && n.__clusterKey === expandedKey) return true;
  return n.__shown !== false;
}
function lodLinkVisible(l) {
  if (currentView === 'nebula') {
    /* 星云视图:力导连线**默认全隐**(结构与干道由 addNebulaWeb 的管线层负责),
     * 只有 hover/选中时才出"点对点"。原实现在无 hover 时 return true,
     * 一旦 linkWidth 非 0 就会退化成满屏跨团直线。 */
    if (!hoverSet && !selectedNodeId) return false;
    const s = linkSrcId(l), t = linkTgtId(l);
    if (selectedNodeId) return s === selectedNodeId || t === selectedNodeId;
    return hoverSet.has(s) && hoverSet.has(t);
  }
  if (isSyntheticLink(l)) return true;
  const focus = selectedNodeId || hoveredNodeId;
  if (!focus) return false;
  const s = linkSrcId(l), t = linkTgtId(l);
  return s === focus || t === focus;
}
function applyLod() {
  if (!graphInstance) return;
  const far = cameraDist() > LOD_DIST;
  updateLabels();
  if (lodFar === far) {
    graphInstance.linkVisibility(l => lodLinkVisible(l));
    return;
  }
  lodFar = far;
  graphInstance.nodeVisibility(n => lodVisible(n));
  graphInstance.linkVisibility(l => lodLinkVisible(l));
}
