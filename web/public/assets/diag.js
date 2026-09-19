/* [viz-diag] 3D 库加载诊断(排查 ForceGraph3D is not defined) */
window.__vizDiag = { three: typeof THREE, forceGraph3D: typeof ForceGraph3D };
console.log('[viz-diag]', JSON.stringify(window.__vizDiag));
/* 超时兜底: module script 若不执行(浏览器不支持 ESM), 4 秒后提示 */
setTimeout(function () {
  if (typeof ForceGraph3D === 'undefined') {
    var el = document.getElementById('loading');
    if (el) el.innerHTML = '❌ 3D 库诊断: three=' + typeof THREE + ' | ForceGraph3D=undefined — 浏览器未执行 module script(不支持 ESM)或加载失败,请用较新浏览器';
  }
}, 4000);
window.addEventListener('viz-libs-ready', function () {
  window.__vizDiag = { three: typeof THREE, forceGraph3D: typeof ForceGraph3D };
  console.log('[viz-diag] ready:', JSON.stringify(window.__vizDiag));
  if (typeof ForceGraph3D === 'undefined') {
    var el = document.getElementById('loading');
    if (el) el.innerHTML = '❌ 3D 库诊断: three=' + window.__vizDiag.three + ' | ForceGraph3D=' + window.__vizDiag.forceGraph3D + ' — 浏览器不支持 ESM(module script)或脚本被拦截,请用较新浏览器';
  }
});

/* 运行期错误上屏:JS 抛错/未处理的 Promise 拒绝 → 右上角红条显示(排查拆文件后的加载/作用域问题) */
(function () {
  function bar(txt) {
    var d = document.getElementById('viz-error-bar');
    if (!d) {
      d = document.createElement('div'); d.id = 'viz-error-bar';
      d.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:999999;max-width:44vw;'
        + 'font:12px/1.5 Consolas,monospace;color:#ffd9d9;background:rgba(120,20,20,.92);'
        + 'border:1px solid #ff6b6b;border-radius:8px;padding:8px 10px;white-space:pre-wrap;pointer-events:none';
      (document.body || document.documentElement).appendChild(d);
    }
    d.textContent = (d.textContent ? d.textContent + '\n' : '') + txt;
  }
  window.addEventListener('error', function (e) {
    bar('✖ ' + (e.message || e.error) + (e.filename ? '  @' + String(e.filename).split('/').pop() + ':' + e.lineno : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason; bar('✖ Promise: ' + (r && (r.message || r) || 'unknown'));
  });
})();
