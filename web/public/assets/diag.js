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
