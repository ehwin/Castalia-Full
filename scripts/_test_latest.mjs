// 验证最新版组合: three r160 ESM + UMD force-graph 1.80 (浏览器同款加载流程)
import * as THREE from 'file:////path/ai-memory/web/public/vendor/three.module.js';
import { readFileSync } from 'fs';

console.log('[1] three r160 ESM import OK, REVISION =', THREE.REVISION);

// 模拟浏览器 module script: 注入全局 THREE
globalThis.window = globalThis;
globalThis.self = globalThis;
window.THREE = THREE;

// 加载 UMD force-graph 1.80 (bundled, 读全局 THREE)
try {
  const code = readFileSync('/path/ai-memory/web/public/vendor/3d-force-graph-1.80.min.js', 'utf-8');
  (0, eval)(code);
  console.log('[2] ForceGraph3D =', typeof globalThis.ForceGraph3D);
} catch (e) {
  console.log('[2] FORCE-GRAPH LOAD ERR:', e.message.slice(0, 200));
}
