/* v1.45 图例抽屉:点标题收起/展开,状态记在 localStorage */
(function initLegendDrawer() {
  const lg = document.getElementById('legend');
  const ti = document.getElementById('legend-struct-title');
  if (!lg || !ti) return;
  try { if (localStorage.getItem('legendCollapsed') === '1') lg.classList.add('collapsed'); } catch (e) {}
  ti.addEventListener('click', () => {
    lg.classList.toggle('collapsed');
    try { localStorage.setItem('legendCollapsed', lg.classList.contains('collapsed') ? '1' : '0'); } catch (e) {}
  });
})();

/* ?embed=1 → 嵌入式模式(见上方 body.embed 样式)
   v1.45 兜底:光看 URL 参数不牢(星图内部一跳转就把 embed 弄丢 → 自带 rail 又冒出来,双侧栏);
   再加两条判据:① 被 iframe 承载(在控制台外壳里) ② 保留参数写法 embed(不带值)。
   并且不只加 class,直接给 #rail 上内联 display:none —— 不吃样式层叠/时序的亏。 */
const IS_EMBEDDED = (() => {
  try {
    const q = String(location.search || '');
    if (/[?&]embed(=|&|$)/.test(q)) return true;
    if (window.self !== window.top) return true;
    return false;
  } catch (e) { return true; }
})();
if (IS_EMBEDDED) {
  const applyEmbed = () => {
    try {
      document.body.classList.add('embed');
      const r = document.getElementById('rail');
      if (r) { r.style.display = 'none'; r.setAttribute('aria-hidden', 'true'); }
    } catch (e) {}
  };
  applyEmbed();
  document.addEventListener('DOMContentLoaded', applyEmbed);
  setTimeout(applyEmbed, 500);
  setTimeout(applyEmbed, 1800);
}

/* 嵌入式模式下:星图自己顶栏/rail 里的站内链接要带上 embed 参数,
   否则一跳转就丢掉了 embed(自带 rail 会重新冒出来,形成双侧边栏) */
(function () {
  if (!document.body.classList.contains('embed')) return;
  function patch() {
    document.querySelectorAll('a[href]').forEach(function (a) {
      const h = a.getAttribute('href') || '';
      if (!h || h.indexOf('embed=') >= 0) return;
      if (!/^https?:\/\/127\.0\.0\.1:\d+\//.test(h) && !h.startsWith('/')) return;
      a.setAttribute('href', h + (h.indexOf('?') >= 0 ? '&' : '?') + 'embed=1');
    });
  }
  patch();
  setTimeout(patch, 800);   // 顶栏/抽屉里的链接可能是稍后渲染的
})();




  /* 最新版: three r160 + 3d-force-graph 1.80, esbuild 全打进单文件(自包含,零外部依赖) */
  import ForceGraph3D, { THREE } from '/vendor/fg-1.80-full-v2.mjs';
  window.THREE = THREE;
  window.ForceGraph3D = ForceGraph3D;
  window.dispatchEvent(new CustomEvent('viz-libs-ready'));
