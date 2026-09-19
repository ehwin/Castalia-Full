/* ══════════════════════════════════════════════════════════════════════════
   app-03-labels.js — 标签体系:分级(LOD tier)、DOM 覆盖层、避让、鼠标规避、调试 HUD
   (2026-09-19 从单文件 app.js 按段落边界切出;加载顺序即依赖顺序,
    全部是普通 script,共享同一个全局作用域 —— 不要在这些文件之间挪动顺序)
   ═══════════════════════════════════════════════════════════════════════ */
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
  try {   /* 调试:?lblfrac=0.86 强行指定 frac(验收档位淡入带用) */
    const fm = /[?&]lblfrac=([\d.]+)/.exec(location.search);
    if (fm) return +fm[1];
  } catch (e) {}
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
      'text-shadow:0 1px 3px rgba(0,0,0,.95);will-change:transform,opacity;transition:opacity .22s linear}',
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
      /* 档位淡入淡出由 JS 按 frac 插值(见 labelWeights),这里不再用 visibility 硬切 */
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
/* ═══ v1.49 标签渲染重做(参考 Mapbox symbol 的 cross-fade + variable-anchor)═══
 *  旧版三个毛病:① 档位硬切(滚轮一过阈值标签"啪"地蹦出来)② 被压住直接 visibility:hidden(闪)
 *  ③ 标签贴边被 overflow 切一半、位置每帧硬跳(轻微抖)。
 *  现在:档位按 frac 走"淡入带"(smoothstep)+ 字号同步插值;碰撞先试 5 个候选锚位,实在放不下
 *  才降级淡出(不闪);屏幕边 6px 内夹住不出界;位置做指数平滑(位移过大直接吸附,不拖影);
 *  z-index 按相机距离排,近的压在上面 —— 与 3D 前景观感一致。
 */
const LABEL_TIER_BAND = 0.07;                    /* 档位淡入带宽度(以 frac 计) */
const _sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function labelWeights() {
  const force = (() => { try { const m = /[?&]lbltier=(far|mid|near)/.exec(location.search); return m ? m[1] : null; } catch (e) { return null; } })();
  if (force) return { wCons: force === 'far' ? 0 : 1, wGal: force === 'near' ? 1 : 0, f: labelFrac(), forced: force };
  const f = labelFrac(), half = LABEL_TIER_BAND / 2;
  if (!isFinite(f)) return { wCons: 0, wGal: 0, f: 0.5, forced: null };   /* 首帧相机未就绪:先按"只看星域名"处理 */
  return {
    wCons: _sstep(LABEL_TIER_FRAC.far - half, LABEL_TIER_FRAC.far + half, f),
    wGal:  _sstep(LABEL_TIER_FRAC.near - half, LABEL_TIER_FRAC.near + half, f),
    f, forced: null,
  };
}
function labelPxFor(level, w) {
  const q = v => Math.round(v * 2) / 2;          /* 量化到 .5px:字号插值时避免每帧重排 */
  if (level === 'region') return q(LABEL_PX.region.far + (LABEL_PX.region.mid - LABEL_PX.region.far) * w.wCons
                                     + (LABEL_PX.region.near - LABEL_PX.region.mid) * w.wGal);
  if (level === 'cons') return q(LABEL_PX.cons.mid + (LABEL_PX.cons.near - LABEL_PX.cons.mid) * w.wGal);
  return q(LABEL_PX.gal.near);
}
const LABEL_DIM = 0.12;                          /* 被压住时淡到多低(而不是直接隐藏) */
/* v1.51 前后大小关系(近大远小 + 远处略暗):按"在相机坐标系里离相机多近"给每个标签一个 depth 权重,
 * front=1 表示位于场景最靠近相机的一层。visual 上等价于地图的"近处标注大、远处小",但因为是 DOM,
 * 用的是 CSS transform: scale()(不重排、字体仍清晰),而不是改字号(改字号会每帧强制 layout)。 */
const LABEL_DEPTH = { min: 0.78, max: 1.16, dim: 0.74 };
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
  const w = labelWeights();
  const lvW = { region: 1, cons: w.wCons, gal: w.wGal };
  const mp = LABEL_LAYER.mouse;
  const DODGE = 34, FADE = 110, PUSH = 16;
  /* 星域名别被右上角统计卡片/图例压住:被压就往下让 */
  const uiRects = [];
  for (const id of ['stats-grid', 'stats-bar', 'top-bar', 'legend']) {
    const e = document.getElementById(id);
    if (!e || e.offsetParent === null) continue;
    const r = e.getBoundingClientRect();
    if (r.width > 4 && r.height > 4) uiRects.push(r);
  }
  const nudgeOut = (tx, ty, w2, h2) => {
    for (let i = 0; i < 6; i++) {
      const L = tx - w2 / 2, R2 = tx + w2 / 2, T = ty - h2 / 2, B = ty + h2 / 2;
      let hit = null;
      for (const r of uiRects) if (L < r.right && R2 > r.left && T < r.bottom && B > r.top) { hit = r; break; }
      if (!hit) break;
      ty = Math.round(hit.bottom + h2 / 2 + 8);
    }
    return [tx, ty];
  };
  const prio0 = { region: 100000, cons: 1000, gal: 100 };
  const cand = [];
  const camPos = cam.position;
  for (const n of nodes) {
    const el = labelDiv(n);
    const level = n.__labelLevel;
    const wgt = lvW[level] == null ? 1 : lvW[level];
    if (wgt < 0.02) { el.style.opacity = '0'; el.style.visibility = 'hidden'; el.__sx = null; continue; }
    v.set(n.x || 0, n.y || 0, n.z || 0);
    const depth = v.distanceTo(camPos);
    /* 前后关系:场景球心在原点、半径 R;相机距离 camD → 把 depth 归一到 [0,1],front=1 最靠前 */
    const R = window.__nebulaR || 900;
    const camD = camPos.length();
    const front = Math.max(0, Math.min(1, 1 - (depth - Math.max(0, camD - R)) / (2 * R)));
    const dscale = LABEL_DEPTH.min + (LABEL_DEPTH.max - LABEL_DEPTH.min) * front;
    v.applyMatrix4(cam.matrixWorldInverse);
    if (v.z > -1) { el.style.visibility = 'hidden'; el.__sx = null; continue; }
    v.applyMatrix4(cam.projectionMatrix);
    const x = (v.x + 1) / 2 * W, y = (1 - v.y) / 2 * H;
    if (x < -80 || y < -50 || x > W + 80 || y > H + 50) { el.style.visibility = 'hidden'; el.__sx = null; continue; }
    const fs = labelPxFor(level, w);
    const key = level + '|' + fs + '|' + el.textContent;
    if (el.__key !== key) {          /* 只在文案/字号变化时量一次尺寸,避免每帧强制布局 */
      el.__key = key; el.style.fontSize = fs + 'px';
      el.__w = el.offsetWidth; el.__h = el.offsetHeight;
    }
    const cnt = parseInt(String(n.label || '').split('·')[1], 10) || 0;
    const lw = el.__w || 60, lh = el.__h || 16;
    /* 目标位置:① 投影点 ② 夹进屏幕(留 6px 边距,地图标签不出界) */
    let tx = Math.round(rect.left + x), ty = Math.round(rect.top + y);
    tx = Math.max(rect.left + lw / 2 + 6, Math.min(rect.left + W - lw / 2 - 6, tx));
    ty = Math.max(rect.top + lh / 2 + 6, Math.min(rect.top + H - lh / 2 - 6, ty));
    if (level === 'region') { const n2 = nudgeOut(tx, ty, lw, lh); tx = n2[0]; ty = n2[1]; }
    let dodgeK = 1;
    if (mp) {
      const L0 = tx - lw / 2, R0 = tx + lw / 2, T0 = ty - lh / 2, B0 = ty + lh / 2;
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
    /* 位置平滑(指数滤波):相机推移/节点轻微晃动时标签不再逐帧硬跳;位移过大(就近跳转)直接吸附 */
    if (el.__sx == null || Math.abs(tx - el.__sx) > 120 || Math.abs(ty - el.__sy) > 120) { el.__sx = tx; el.__sy = ty; }
    else { el.__sx += (tx - el.__sx) * 0.35; el.__sy += (ty - el.__sy) * 0.35; }
    cand.push({ el, w: lw * dscale, h: lh * dscale, prio: prio0[level] + cnt, tx: el.__sx, ty: el.__sy,
                dodgeK, wgt, depth, dscale, front, node: n });
  }
  /* 碰撞避让(地图式):优先级高的先落位;放不下先试候选锚位(上/下/左/右),仍不行才降级淡出 —— 
   * Mapbox 的 text-variable-anchor 就是这个思路:换位置优先于丢标签。 */
  cand.sort((a, b) => b.prio - a.prio);
  const placed = [], PAD = 4, OFFS = [[0, 0], [0, -1], [0, 1], [1, 0], [-1, 0]];
  let degraded = 0;
  for (const c of cand) {
    const fits = (tx, ty) => {
      const L = tx - c.w / 2 - PAD, R = tx + c.w / 2 + PAD, T = ty - c.h / 2 - PAD, B = ty + c.h / 2 + PAD;
      for (const q of placed) if (L < q.R && R > q.L && T < q.B && B > q.T) return false;
      return true;
    };
    let ok = false, bx = c.tx, by = c.ty;
    for (const [ox, oy] of OFFS) {
      const tx = Math.round(c.tx + ox * (c.w / 2 + PAD + 4)), ty = Math.round(c.ty + oy * (c.h + PAD + 2));
      if (fits(tx, ty)) { ok = true; bx = tx; by = ty; break; }
    }
    if (ok) {
      placed.push({ L: bx - c.w / 2 - PAD, R: bx + c.w / 2 + PAD, T: by - c.h / 2 - PAD, B: by + c.h / 2 + PAD });
    } else { degraded++; }
    const base = LABEL_BASE_OPACITY[(c.el.className.match(/lv-(\w+)/) || [])[1]] || 0.9;
    const depthDim = LABEL_DEPTH.dim + (1 - LABEL_DEPTH.dim) * c.front;   /* 越靠后越暗(空气透视) */
    const alpha = base * c.wgt * (0.10 + 0.90 * c.dodgeK) * (ok ? 1 : LABEL_DIM) * depthDim;
    c.el.style.visibility = '';
    c.el.style.opacity = alpha.toFixed(3);
    /* 近的标签压在上面(与 3D 前景一致) */
    c.el.style.zIndex = String(Math.max(1, Math.min(999, 999 - Math.round(c.depth / 8))));
    c.el.style.transform = 'translate(-50%,-50%) translate(' + Math.round(bx) + 'px,' + Math.round(by) + 'px)'
      + ' scale(' + c.dscale.toFixed(3) + ')';
  }
  LABEL_LAYER.shown = placed.length;
  LABEL_LAYER.sizes = cand.filter(c => c.node && c.node.__labelLevel === 'region')
    .map(c => String(c.node.shortLabel || '').slice(0, 8) + '=' + c.dscale.toFixed(2)).join(' ');
  LABEL_LAYER.degraded = degraded;
  LABEL_LAYER.weights = { cons: +w.wCons.toFixed(2), gal: +w.wGal.toFixed(2) };
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
      h.style.cssText = 'position:fixed;left:340px;top:76px;z-index:99999;font:bold 15px/1.6 Consolas,monospace;color:#7fffd4;background:rgba(0,0,0,.85);padding:6px 10px;white-space:pre-wrap;max-width:58vw;border-radius:6px;border:1px solid #7fffd4;pointer-events:none';
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
    h.textContent = '档位=' + labelTier + ' frac=' + labelFrac().toFixed(2) + ' R=' + Math.round(window.__nebulaR || 0) +
      ' wC=' + (LABEL_LAYER.weights ? LABEL_LAYER.weights.cons : '-') + ' wG=' + (LABEL_LAYER.weights ? LABEL_LAYER.weights.gal : '-') +
      ' deg=' + (LABEL_LAYER.degraded|0) + ' shown=' + (LABEL_LAYER.shown|0) +
      '  前后:' + (LABEL_LAYER.sizes || '-') +
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
