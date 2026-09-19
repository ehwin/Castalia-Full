/* ═══════════════════ MNEMO 风格常量 ═══════════════════ */
const MEM_TYPE_COLORS = {
  user: '#5FF5D6',
  feedback: '#FFD056',
  project: '#C4A6FF',
  reference: '#7EB0FF',
  general: '#9AA6B8',
};
const MEM_TYPE_LABELS = {
  user: '用户画像',
  feedback: '反馈纠偏',
  project: '项目上下文',
  reference: '外部引用',
  general: '通用',
}
/* 星座口径:memtype(默认,= 四个文件夹) / category(实例设 GRAPH_CONSTELLATION=category 时,
   服务端会在响应里带 consKind → AIRI 这种"不用四个文件夹"的实例按 category 分星座)。
   全部挂 window,避免跨 <script> 的作用域/TDZ 问题;复用已有的 CATEGORY_LABELS。 */
window.CONS_KIND = 'memtype';
window.consLabel = function (k) {
  /* 联邦里各星域口径可能不同(有的按文件夹、有的按 category),两套表都试,键名不冲突 */
  return CATEGORY_LABELS[k] || MEM_TYPE_LABELS[k] || k;
};;
/* 配色口径(用户):L2 四个文件夹 = 不同色相;L3 库(同文件夹内)= 同色相深浅 */
const TYPE_FALLBACK_COLORS = { episodic: '#f59e0b', semantic: '#8b5cf6', working: '#14b8a6' };
const MEM_TYPE_ORDER = ['user', 'feedback', 'project', 'reference', 'general'];
const MORPH_LABELS = {
  spiral: '旋涡',
  barred: '棒旋',
  elliptical: '椭圆',
  ring: '环状',
  irregular: '不规则',
};
function pickGalaxyMorph(p, count, nTypes, gi) {
  const k = String(p || '').toLowerCase();
  if (k === 'custom-project') return 'spiral';
  if (k === 'lobehub' || k === 'lobe') return 'barred';
  if (k === 'airi') return 'barred';
  if (k === 'hermes') return 'irregular';
  if (k === '联邦' || k === 'reflect') return 'ring';
  if (count < 20) return 'irregular';
  if (nTypes <= 2) return 'elliptical';
  if (nTypes >= 4 && count > 90) return gi % 2 ? 'barred' : 'spiral';
  if (nTypes >= 3 && count > 28) return 'spiral';
  return 'elliptical';
}
const GRAPH_SCOPE = (new URLSearchParams(location.search).get('scope') || 'local').toLowerCase();
const IS_FED = GRAPH_SCOPE === 'federation' || GRAPH_SCOPE === 'all' || GRAPH_SCOPE === 'fed';
const MAP_LINKS = {
  federation: { href: 'http://127.0.0.1:3345/?scope=federation', label: '联邦' },
  Hermes: { href: 'http://127.0.0.1:3345/?scope=local', label: 'Hermes' },
  LobeHub: { href: 'http://127.0.0.1:3346/?scope=local', label: 'LobeHub' },
  AIRI: { href: 'http://127.0.0.1:3344/?scope=local', label: 'AIRI' },
  联邦: { href: 'http://127.0.0.1:3345/?scope=federation', label: '联邦' },
};
function currentMapId() {
  const port = String(location.port || '');
  if (port === '3346') return 'lobehub';
  if (port === '3344') return 'airi';
  if (IS_FED) return 'federation';
  return 'hermes';
}
const STRUCT_COLORS = {
  Hermes: '#5FF5D6', LobeHub: '#7EB0FF', AIRI: '#FF8FB8', 联邦: '#FFD056',
  hermes: '#3EE8C8', lobehub: '#5B8CFF', airi: '#A78BFA',
  reflect: '#F5B942', default: '#6B7585', shared: '#8A94A3', custom-project: '#E8A54B',
};
const STRUCT_LABELS = {
  Hermes: 'Hermes', LobeHub: 'LobeHub', AIRI: 'AIRI', 联邦: '联邦',
  hermes: 'Hermes', lobehub: '对话', airi: 'AIRI',
  custom-project: '自定义领域', reflect: '反思产物', shared: '共享', default: '默认',
};
function structLabel(k) { return STRUCT_LABELS[k] || k; }
function structKey(n) {
  const proj = n.project || n.lib || '';
  if (IS_FED) {
    if (proj === 'reflect') return '联邦';
    return n.instance || '未知';
  }
  return proj || 'default';
}

function applyInstanceChrome(s) {
  const sub = document.getElementById('app-sub');
  const id = currentMapId();
  const names = { federation: '联邦总图', hermes: 'Hermes', lobehub: 'LobeHub', airi: 'AIRI' };
  const name = names[id] || ((s && s.instance) ? s.instance : '星图');
  if (sub) sub.textContent = name;
  document.title = 'Castalia · ' + name;
  ['federation', 'hermes', 'lobehub', 'airi'].forEach(k => {
    const tab = document.getElementById('tab-' + k);
    const rail = document.getElementById('rail-' + (k === 'federation' ? 'fed' : k));
    if (tab) tab.classList.toggle('active', k === id);
    if (rail) rail.classList.toggle('active', k === id);
  });
}
applyInstanceChrome(null);

/* ═══════════════════ 连线语义编码 (ContextOS / V1) ═══════════════════ */
/* 关系边按类型着色:暖色=因果/时序,冷色=同主题/相关/跟随 */
const LINK_TYPE_COLORS = {
  causes: '#ff7a45', caused_by: '#ff7a45',
  leads_to: '#ffa940', sequence: '#ffc53d',
  same_subject: '#5cdbd3', related_to: '#69c0ff',
  follows: '#40a9ff', context: '#b37feb', part_of: '#ff85c0', same_event: '#ffadd2',
};
/* 强度估算(server 端已返回 strength,这里仅作回退) */
const LINK_TYPE_STRENGTH = {
  part_of: 0.9, same_event: 0.85, causes: 0.7, caused_by: 0.7,
  leads_to: 0.65, sequence: 0.6, context: 0.5, same_subject: 0.5,
  related_to: 0.4, follows: 0.4, similarity: 0.5,
};

function isWarmLinkType(t) { return t === 'causes' || t === 'caused_by' || t === 'leads_to' || t === 'sequence'; }
function linkTypeColor(l) { return LINK_TYPE_COLORS[l.type] || null; }
function isSyntheticLink(l) {
  return l.type === 'galaxy-bridge' || l.type === 'subgalaxy-spoke' || l.type === 'subgalaxy-bridge' || l.type === 'nebula-spoke';
}
function linkSrcId(l) { return (l.source && typeof l.source === 'object') ? l.source.id : l.source; }
function linkTgtId(l) { return (l.target && typeof l.target === 'object') ? l.target.id : l.target; }

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

/* ═══════════ v1.28 地图式分级标签(2026-09-18)═══════════════════════════════
 * 需求:像地图一样"缩放换标签" —— 远看只有星域名,放大一档出星座名,再放大出星系/记忆名。
 *   远(far)  :只显示星域标签(Hermes / LobeHub / AIRI / 总反思),字号最大
 *   中(mid)  :+ 星座标签(用户画像 / 知识 / 定案 …)
 *   近(near) :+ 星系锚标签;记忆点名称仍只在 hover/选中时出现(不在近档也不常驻)
 * 判据:场景半径占视口高度的比例 frac(与窗口尺寸无关的"看图比例"),相机每次变化都会重算。
 * 关键点:标签按**屏幕像素**定尺寸(scale 随距离补偿)→ 远近都清晰,不会缩成小点。
 * 自检:控制台 window.__labelDebug() → {tier, frac}。
 */
const LABEL_TIER_FRAC = { far: 0.85, near: 1.35 };   /* frac < far → 远档;> near → 近档 */
let labelTier = 'mid';
function labelFrac() {
  try {
    const cam = graphInstance.camera();
    const h = (typeof graphInstance.height === 'function' ? graphInstance.height() : 0) || window.innerHeight || 800;
    const R = window.__nebulaR || 900;
    return (R / Math.max(1, cameraDist())) * (h / 2) / Math.tan((cam.fov || 50) * Math.PI / 360) / h;
  } catch (e) { return 0.8; }
}
function labelTierNow() {
  try {   /* 调试:?lbltier=far|mid|near 强制档位(用于逐档验收) */
    const m = /[?&]lbltier=(far|mid|near)/.exec(location.search);
    if (m) return m[1];
  } catch (e) {}
  const f = labelFrac();
  return f > LABEL_TIER_FRAC.near ? 'near' : (f < LABEL_TIER_FRAC.far ? 'far' : 'mid');
}
function updateLabels(force) {
  const t = labelTierNow();
  const changed = force || t !== labelTier;
  if (changed) labelTier = t;
  const struct = window.__nebulaNodes || [];
  if (changed) {
    /* v1.29:结构标签(星域/星座/星系)一律交给 DOM 层 —— 3D sprite 永久隐藏,避免双份 */
    for (const n of struct) if (n.__labelLevel && n.__labelSprite) n.__labelSprite.visible = false;
    /* 记忆点标签:近档才常驻"重要记忆"名,其余靠 hover/选中(applyNodeVisual 里判定) */
    if (typeof refreshNodeVisuals === 'function') refreshNodeVisuals();
  }
  syncDomLabels();
  labelHud();
}
/* ═══════════ v1.29 地图式分级标签:**DOM 覆盖层**版 ══════════════════════
 * 为什么不用 THREE.Sprite:v1.28 实测本场景的相机 far 面很紧 —— 结构标签的世界坐标投影
 * z_ndc≈1.000(贴着远平面),整个 sprite 四边形被 GPU 裁掉;表现极具迷惑性:
 * sprite.visible=true、贴图有像素(maxA=233)、父级可见、NDC xy 在屏幕内,但屏幕上什么都没有。
 * 换 DOM 后:用投影出的屏幕坐标摆 div —— 完全不受远平面/裁剪影响,字号就是真实像素(地图的观感、不糊)。
 */
const LABEL_LAYER = { el: null, host: null, map: Object.create(null), css: false };
const LABEL_PX = {
  region: { far: 17, mid: 15, near: 13.5 },
  cons:   { far: 12.5, mid: 12.5, near: 12 },
  gal:    { far: 11, mid: 11, near: 11 },
};
function ensureLabelLayer() {
  if (LABEL_LAYER.el && LABEL_LAYER.el.parentNode) return LABEL_LAYER.el;
  const host = document.getElementById('graph') || document.body;
  if (!LABEL_LAYER.css) {
    const st = document.createElement('style');
    st.textContent = [
      '#label-layer{position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;overflow:hidden;z-index:6}',
      '#label-layer .map-label{position:absolute;left:0;top:0;white-space:nowrap;',
      'font-family:"JetBrains Mono",Consolas,monospace;font-weight:700;letter-spacing:.03em;',
      'border-radius:6px;padding:1px 6px;background:rgba(6,10,16,.58);',
      'text-shadow:0 1px 3px rgba(0,0,0,.95);will-change:transform,opacity;transition:opacity .16s linear}',
      /* 边框用 currentColor + 伪元素控透明度 → 三级标签共用一套配色,只有"描边轻重"不同 */
      '#label-layer .map-label::before{content:"";position:absolute;inset:0;border-radius:inherit;',
      'border:1px solid currentColor;opacity:.40;pointer-events:none}',
      '#label-layer .lv-region{padding:1px 8px;border-radius:9px;background:rgba(6,10,16,.66);',
      'box-shadow:0 0 14px rgba(0,0,0,.55)}',
      '#label-layer .lv-region::before{opacity:.92}',
      '#label-layer .lv-cons{background:rgba(6,10,16,.52)}',
      '#label-layer .lv-cons::before{opacity:.42}',
      '#label-layer .lv-gal{background:rgba(6,10,16,.46);border-radius:5px}',
      '#label-layer .lv-gal::before{opacity:.26}',
      '#label-layer .map-label i{font-style:normal;font-weight:600;opacity:.62;margin-left:.42em;font-size:.82em}',
      '#label-layer .lv-cons,#label-layer .lv-gal{visibility:hidden}',
      '#label-layer.tier-mid .lv-cons,#label-layer.tier-near .lv-cons{visibility:visible}',
      '#label-layer.tier-near .lv-gal{visibility:visible}',
    ].join('');
    document.head.appendChild(st);
    LABEL_LAYER.css = true;
  }
  const d = document.createElement('div');
  d.id = 'label-layer';
  document.body.appendChild(d);
  LABEL_LAYER.el = d; LABEL_LAYER.host = host;
  LABEL_LAYER.map = Object.create(null);
  if (!LABEL_LAYER.mouseBound) {   /* 鼠标规避要用的光标位置(视口坐标) */
    LABEL_LAYER.mouseBound = true;
    try {
      const m = /[?&]lbldodge=(\d+),(\d+)/.exec(location.search);
      if (m) LABEL_LAYER.mouse = { x: +m[1], y: +m[2], forced: true };
    } catch (e) {}
    window.addEventListener('mousemove', e => {
      if (LABEL_LAYER.mouse && LABEL_LAYER.mouse.forced) return;
      LABEL_LAYER.mouse = { x: e.clientX, y: e.clientY };
    }, { passive: true });
    window.addEventListener('mouseleave', () => { LABEL_LAYER.mouse = null; }, { passive: true });
  }
  return d;
}
function labelDiv(n) {
  const key = n.id;
  let el = LABEL_LAYER.map[key];
  if (el && el.parentNode) return el;
  ensureLabelLayer();
  el = document.createElement('div');
  el.className = 'map-label lv-' + (n.__labelLevel || 'cons');
  el.style.color = n.__galaxyColor || '#94a3b8';     /* 边框/文字取星域色系 */
  const name = n.__labelLevel === 'region' ? (n.shortLabel || '')
    : (n.__labelLevel === 'cons' ? catLabel(n.lib || n.__constellation || '') : (MEM_TYPE_LABELS[n.memType] || n.shortLabel || ''));
  const cnt = String(n.label || '').split('·')[1];
  el.innerHTML = String(name) + (cnt ? '<i>' + cnt.trim() + '</i>' : '');
  LABEL_LAYER.el.appendChild(el);
  LABEL_LAYER.map[key] = el;
  return el;
}
/* 各档基准不透明度(鼠标规避在此基础上再压) */
const LABEL_BASE_OPACITY = { region: 1, cons: 0.95, gal: 0.85 };
const _labV = { p: null };
function syncDomLabels() {
  if (!graphInstance || typeof THREE === 'undefined') return;
  const nodes = (window.__nebulaNodes || []).filter(n => n.__labelLevel);
  if (!nodes.length) return;
  ensureLabelLayer();
  const layer = LABEL_LAYER.el;
  const cls = 'tier-' + labelTier;
  if (layer.className !== cls) layer.className = cls;
  const cam = graphInstance.camera();
  const host = document.getElementById('graph');
  const rect = host ? host.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  if (!_labV.p) _labV.p = new (cam.position.constructor)();
  const v = _labV.p, W = rect.width, H = rect.height;
  const active = { region: true, cons: labelTier !== 'far', gal: labelTier === 'near' };
  /* 鼠标规避(v1.30):光标越近越淡、并轻轻推离光标 —— 标签永远不挡你要看/要点的地方。
   * 方向按"锚点"算(不按推完的位置),避免反馈抖动。 */
  const mp = LABEL_LAYER.mouse;
  const DODGE = 34, FADE = 110, PUSH = 16;
  /* 星域名别被右上角统计卡片/图例压住:被压就往下让(地图里标签也会躲 UI) */
  const uiRects = [];
  for (const id of ['stats-grid', 'stats-bar', 'top-bar', 'legend']) {
    const e = document.getElementById(id);
    if (!e || e.offsetParent === null) continue;
    const r = e.getBoundingClientRect();
    if (r.width > 4 && r.height > 4) uiRects.push(r);
  }
  const nudgeOut = (tx, ty, w, h) => {
    for (let i = 0; i < 6; i++) {
      const L = tx - w / 2, R2 = tx + w / 2, T = ty - h / 2, B = ty + h / 2;
      let hit = null;
      for (const r of uiRects) if (L < r.right && R2 > r.left && T < r.bottom && B > r.top) { hit = r; break; }
      if (!hit) break;
      ty = Math.round(hit.bottom + h / 2 + 8);
    }
    return [tx, ty];
  };
  const prio0 = { region: 100000, cons: 1000, gal: 100 };
  const cand = [];
  for (const n of nodes) {
    const el = labelDiv(n);
    const level = n.__labelLevel;
    if (!active[level]) { el.style.visibility = ''; continue; }   /* 非本档:交给 CSS 档位样式 */
    v.set(n.x || 0, n.y || 0, n.z || 0);
    v.applyMatrix4(cam.matrixWorldInverse);
    if (v.z > -1) { el.style.visibility = 'hidden'; continue; }    /* 相机背后 */
    v.applyMatrix4(cam.projectionMatrix);
    const x = (v.x + 1) / 2 * W, y = (1 - v.y) / 2 * H;
    if (x < -60 || y < -30 || x > W + 60 || y > H + 30) { el.style.visibility = 'hidden'; continue; }
    const fs = (LABEL_PX[level] && LABEL_PX[level][labelTier]) || 12;
    const key = level + '|' + fs + '|' + el.textContent;
    if (el.__key !== key) {          /* 只在文案/字号变化时量一次尺寸,避免每帧强制布局 */
      el.__key = key; el.style.fontSize = fs + 'px';
      el.__w = el.offsetWidth; el.__h = el.offsetHeight;
    }
    const cnt = parseInt(String(n.label || '').split('·')[1], 10) || 0;
    let tx = Math.round(rect.left + x), ty = Math.round(rect.top + y);
    const w = el.__w || 60, h = el.__h || 16;
    if (level === 'region') { const n2 = nudgeOut(tx, ty, w, h); tx = n2[0]; ty = n2[1]; }
    let dodgeK = 1;
    if (mp) {
      const L0 = tx - w / 2, R0 = tx + w / 2, T0 = ty - h / 2, B0 = ty + h / 2;
      const dx = Math.max(L0 - mp.x, 0, mp.x - R0), dy = Math.max(T0 - mp.y, 0, mp.y - B0);
      const dist = Math.hypot(dx, dy);
      if (dist < FADE) {
        dodgeK = Math.max(0, Math.min(1, (dist - DODGE) / (FADE - DODGE)));
        const push = (1 - dodgeK) * PUSH;
        if (push > 0.5) {
          const vx = tx - mp.x, vy = ty - mp.y, vl = Math.hypot(vx, vy) || 1;
          tx = Math.round(tx + vx / vl * push);
          ty = Math.round(ty + vy / vl * push);
        }
      }
    }
    cand.push({ el, w, h, prio: prio0[level] + cnt, tx, ty, dodgeK });
  }
  /* 地图式避让:优先级高的先落位(星域 > 星座按成员数 > 星系按成员数),被压住的一律隐藏 */
  cand.sort((a, b) => b.prio - a.prio);
  const placed = [], PAD = 3;
  for (const c of cand) {
    const L = c.tx - c.w / 2 - PAD, R = c.tx + c.w / 2 + PAD, T = c.ty - c.h / 2 - PAD, B = c.ty + c.h / 2 + PAD;
    let hit = false;
    for (const q of placed) if (L < q.R && R > q.L && T < q.B && B > q.T) { hit = true; break; }
    if (!hit) placed.push({ L, R, T, B });
    c.el.style.visibility = hit ? 'hidden' : '';
    const base = LABEL_BASE_OPACITY[(c.el.className.match(/lv-(\w+)/) || [])[1]] || 0.9;
    c.el.style.opacity = (base * (0.10 + 0.90 * (c.dodgeK == null ? 1 : c.dodgeK))).toFixed(2);
    c.el.style.transform = 'translate(-50%,-50%) translate(' + c.tx + 'px,' + c.ty + 'px)';
  }
  LABEL_LAYER.shown = placed.length;
}
window.__labelDomCount = () => Object.keys(LABEL_LAYER.map).length;

/* 相机随时可能变(滚轮/拖拽/flyTo)→ 标签档位必须自驱:自己的轻量 rAF,
 * 不依赖 orbitTick()(那个只在导览/自动漫步时跑,平时是停的 —— v1.28 首版就栽在这)。 */
let labelRAF = null;
function labelTick() {
  labelRAF = requestAnimationFrame(labelTick);
  try { updateLabels(); } catch (e) {}
}
function startLabelTick() { if (labelRAF == null) labelRAF = requestAnimationFrame(labelTick); }

/* 一次性探针(仅 ?lblprobe=1):把三种 sprite 摆法同时放进场景,看哪种真能渲染出来
 *  A 直接在 scene 上、sizeAttenuation=true ; B 在 scene 上、sizeAttenuation=false ;
 *  C 挂到节点组上(与我们的星域标签同路径) */
/* 诊断陷阱:记录"本 pass 之后"对结构标签 visible 的写入者(找是谁把标签又显出来了) */
/* ═══ 调试钩子(全部只在 URL 带参数时生效,平时零开销、不影响观感)══════════════
 *   &lblhud=1            → 显示诊断 HUD(档位/结构标签数/线层自检/配色自检)
 *   &lbltier=far|mid|near → 强制标签档位(逐档验收,不用滚轮)
 *   &lbldodge=x,y        → 假装光标在该位置(验收"鼠标规避")
 *   控制台自检:window.__labelDebug() / __intraStrength / __intraDebug / __nebulaDbg
 * ═══════════════════════════════════════════════════════════════════════════════ */
/* 调试 HUD:仅当 URL 带 &lblhud=1 时出现(诊断标签档位/可见性/尺寸) */
function labelHud() {
  try {
    if (!/[?&]lblhud=1/.test(location.search)) return;
    let h = document.getElementById('label-hud');
    if (!h) {
      h = document.createElement('div'); h.id = 'label-hud';
      h.style.cssText = 'position:fixed;left:340px;top:76px;z-index:99999;font:bold 15px/1.6 Consolas,monospace;color:#7fffd4;background:rgba(0,0,0,.85);padding:6px 10px;white-space:pre;border-radius:6px;border:1px solid #7fffd4;pointer-events:none';
      document.body.appendChild(h);
    }
    const struct = (window.__nebulaNodes || []).filter(n => n.__labelLevel);
    const cnt = {};
    for (const n of struct) cnt[n.__labelLevel] = (cnt[n.__labelLevel] || 0) + 1;
    const mp = LABEL_LAYER.mouse;
    const dodging = [];
    for (const n of struct) {
      const el = LABEL_LAYER.map[n.id];
      if (el && el.style.visibility !== 'hidden' && parseFloat(el.style.opacity || '1') < 0.9) dodging.push((n.shortLabel || n.id) + '@' + el.style.opacity);
    }
    const regs = struct.filter(n => n.__labelLevel === 'region' && LABEL_LAYER.map[n.id])
      .map(n => {   /* 视口坐标(可直接喂给 &lbldodge=x,y) */
        const el = LABEL_LAYER.map[n.id], r2 = el.getBoundingClientRect();
        return (n.shortLabel || '') + '=' + Math.round(r2.left + r2.width / 2) + ',' + Math.round(r2.top + r2.height / 2);
      });
    h.textContent = '档位=' + labelTier + ' frac=' + labelFrac().toFixed(2) + ' 场景半径=' + Math.round(window.__nebulaR || 0) +
      '  结构标签=' + JSON.stringify(cnt) + '  DOM标签=' + (window.__labelDomCount ? window.__labelDomCount() : 0) +
      '  屏上可见=' + ((LABEL_LAYER && LABEL_LAYER.shown) || 0) +
      '\n线层:' + JSON.stringify(window.__intraStrength || {}) + ' ' + JSON.stringify(window.__intraDebug || {}) +
      '\n光标=' + (mp ? Math.round(mp.x) + ',' + Math.round(mp.y) + (mp.forced ? '(强制)' : '') : '未捕获') +
      '  躲避中=' + dodging.length + (dodging.length ? ' [' + dodging.slice(0, 4).join(' ') + ']' : '') +
      '\n星域标签视口坐标: ' + regs.join('  ') +
      '\n点云配色自检(渲染缓冲里的真实颜色): ' + (() => {
        const R = window.__nebulaReal || [], B = window.__nebulaColBuf || [];
        const seen = {}, out = [];
        R.forEach((n, i) => {
          const rg = String(n.__region || '?');
          if (seen[rg]) return; seen[rg] = 1;
          const hex = '#' + [Math.round(B[i*3]*255), Math.round(B[i*3+1]*255), Math.round(B[i*3+2]*255)]
            .map(x => ('0' + x.toString(16)).slice(-2)).join('');
          out.push(rg + '(' + (n.memType || '-') + ') tint=' + (n.__nebulaTint || '无') + ' → ' +
            (hslStyleToHex(n.__nebulaTint) || '-') + ' 缓冲=' + hex);
        });
        return out.join('   ');
      })() +
      '\n配色自检: ' + struct.filter(n => n.__labelLevel === 'region').map(n => {
        const el = LABEL_LAYER.map[n.id];
        const comp = el ? getComputedStyle(el).color : '?';
        const tint = (window.__nebulaNodes || []).find(m => m.__region === n.__region && !m.group);
        return (n.shortLabel || '') + ' src=' + (n.__galaxyColor || 'undefined') + ' comp=' + comp + ' 成员tint=' + ((tint && tint.__nebulaTint) || '-');
      }).join('  |  ');
  } catch (e) {}
}
window.__labelDebug = () => ({ tier: labelTier, frac: +labelFrac().toFixed(3), far: LABEL_TIER_FRAC.far, near: LABEL_TIER_FRAC.near });

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
      const sizeWant = vis ? (emph ? 6.0 : 4.0) : 1.3;
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
     * 原实现星座=库(custom-project/对话),文件夹只当子行 → 多出一层,且"自定义领域/对话"看起来像两个平级星座。 */
    /* 星座键:服务端已按实例口径算进 blobId(星域/星座),优先用它;没有则退回本页口径 */
  const cons = String(n.blobId ? String(n.blobId).split('/').slice(1).join('/') || 'general'
                               : (window.CONS_KIND === 'category' ? (n.category || 'general') : (n.memType || 'general')));
    const consLib = String(n.lib || 'default');           /* 细分 = 库(lobehub/custom-project/reflect…) */
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
      sizes[i]=4.0; alphas[i]=1.0;
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
      /* 程序化径向衰减:不再依赖 sprite 贴图(sprite 一旦是空贴图,tex.a<0.01 会把整层 discard 掉,
       * 症状就是"记忆点一个都不出现"且无任何报错)。 */
      /* v1.41 撤回 v1.40 的"实心盘+描边"(用户:观感太差)→ 回到柔光圆点 */
      fragmentShader: `varying vec3 vColor; varying float vAlpha;
        void main(){ float d=length(gl_PointCoord-vec2(0.5)); float a=smoothstep(0.5,0.04,d);
        if(a<0.02) discard; gl_FragColor=vec4(vColor*(0.55+0.45*a), a*vAlpha*${alphaScale}); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
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
fetch('/api/graph?scope=' + encodeURIComponent(GRAPH_SCOPE) + '&layout=folder-wedges')
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
    if (s && s.dbExists === false) {
      loading.innerHTML = '📭 记忆库为空或未创建——启动 MCP server 或写入第一条记忆后,图谱会自动出现';
      loading.classList.add('error');
      loading.style.display = '';
    } else {
      loading.style.display = 'none';
    }
  })
  .catch(err => {
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
