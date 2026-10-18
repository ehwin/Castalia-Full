/* ══════════════════════════════════════════════════════════════════════════════
 *  共享可变状态清单(app-01..07 共用一个全局作用域,这里是全部"谁都能改"的顶层变量)
 *  —— 改前端前先扫一眼这张表:它们大多是渲染流程的临时状态,不要顺手改名/挪文件。
 *
 *  文件列 = 该变量声明在哪个模块(声明文件之前的模块看不到它);
 *  提示   = 声明处的初始值。
 *   graphInstance          02       = null;
 *   allData                02       = null;
 *   currentView            02       = 'nebula';
 *   selectedNodeId         02       = null;
 *   selNeighbors           02       = null;
 *   panelNode              02       = null;
 *   autoTourActive         02       = false;
 *   autoTourTimer          02       = null;
 *   autoTargetId           02       = null;
 *   panelStack             02       = [];
 *   flyingUntil            02       = 0;
 *   lodFar                 02       = null;
 *   labelTier              03       = 'mid';
 *   labelRAF               03       = null;
 *   starField              04       = null;
 *   orbitRAF               04       = null;
 *   orbitAngle             04       = null;
 *   lastInteraction        04       = 0;
 *   interactionBound       04       = false;
 *   hoverSet               04       = null;
 *   hoveredNodeId          04       = null;
 *   searchQuery            04       = '';
 *   typeFilter             04       = null;
 *   projectFilter          04       = null;
 *   instanceFilter         04       = null;
 *   expandedKey            04       = null;
 *   nebulaPoints           06       = null, nebulaGlow = null, nebulaWeb = null;
 *   nebulaTrunk            06       = null, nebulaIntra = null, nebulaSparse = null;
 *   _nebulaSprite          06       = null;
 *   tourCursor             07       = null;
 *   tourSeen               07       = new Set();
 *   allMems                07       = [];
 *
 *  2026-09-19 评估过把这些收进一个 state 对象:收益(名字空间清晰)远小于风险
 *  (全库 ~500 处引用要一起改,视觉回归难查),故保留扁平全局 + 本清单。
 * ═══════════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════════════
   app-01-config.js — 常量与配色口径 / 作用域判定 / 连线语义编码
   (2026-09-19 从单文件 app.js 按段落边界切出;加载顺序即依赖顺序,
    全部是普通 script,共享同一个全局作用域 —— 不要在这些文件之间挪动顺序)
   ═══════════════════════════════════════════════════════════════════════ */
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
const GRAPH_PROJECT = new URLSearchParams(location.search).get('project') || '';
const MAP_LINKS = {
  DSH: { href: 'http://127.0.0.1:3347/?scope=local', label: 'DeepSeek Harness' },
  federation: { href: 'http://127.0.0.1:3348/?scope=federation', label: '联邦' },
  Hermes: { href: 'http://127.0.0.1:3345/?scope=local', label: 'Hermes' },
  LobeHub: { href: 'http://127.0.0.1:3346/?scope=local', label: 'LobeHub' },
  AIRI: { href: 'http://127.0.0.1:3344/?scope=local', label: 'AIRI' },
  联邦: { href: 'http://127.0.0.1:3348/?scope=federation', label: '联邦' },
};
function currentMapId() {
  if (GRAPH_PROJECT === 'dsh') return 'dsh';
  const port = String(location.port || '');
  if (port === '3347') return 'dsh';
  if (port === '3348') return 'federation';
  if (port === '3346') return 'lobehub';
  if (port === '3344') return 'airi';
  if (IS_FED) return 'federation';
  return 'hermes';
}
const STRUCT_COLORS = {
  Hermes: '#5FF5D6', LobeHub: '#7EB0FF', AIRI: '#FF8FB8', 联邦: '#FFD056', DSH: '#56B4FF',
  hermes: '#3EE8C8', lobehub: '#5B8CFF', airi: '#A78BFA',
  reflect: '#F5B942', default: '#6B7585', shared: '#8A94A3',
};
const STRUCT_LABELS = {
  Hermes: 'Hermes', LobeHub: 'LobeHub', AIRI: 'AIRI', 联邦: '联邦',
  hermes: 'Hermes', lobehub: '对话', airi: 'AIRI',
  dsh: 'DeepSeek Harness', reflect: '反思产物', shared: '共享', default: '默认',
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
  const names = { federation: '联邦总图', dsh: 'DeepSeek Harness', hermes: 'Hermes', lobehub: 'LobeHub', airi: 'AIRI' };
  const name = new URLSearchParams(location.search).get('instance') || names[id] || ((s && s.instance) ? s.instance : '星图');
  if (sub) sub.textContent = name;
  document.title = 'Castalia · ' + name;
  ['federation', 'hermes', 'dsh', 'lobehub', 'airi'].forEach(k => {
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
