/* layout-worker.mjs — 在 worker_threads 里跑星云几何,并按 epoch 把进度回报主线程
 *
 * 只有"全量重排"(新点占比 >40%、或布局文件不存在)才走这里;
 * 增量落位在毫秒级,留在主线程。为什么非要 worker:UMAP 的 kNN + SGD 是纯 CPU 的同步循环,
 * 跑在主线程会把这期间的所有 HTTP(/api/status、/api/graph/progress、其它星图页)全部堵住
 * —— 2026-10-30 实测:构建期间 /api/status 连 1s 都答不上,托盘健康探针据此会判"掉线"。
 */
import { parentPort } from 'node:worker_threads';
import { nebulaGeometry } from './layout-geometry.mjs';

parentPort.on('message', (msg) => {
  try {
    const { flat, n, dim } = msg;
    const f32 = new Float32Array(flat);          // 收到的是被转移的 ArrayBuffer(零拷贝)
    const pairs = new Array(n);
    for (let i = 0; i < n; i++) pairs[i] = { n: null, v: f32.subarray(i * dim, (i + 1) * dim) };
    /* worker 里一律走全量重排(调用方只在覆盖率不足时派单),所以不需要 prior/节点元数据 */
    const geom = nebulaGeometry(pairs, msg.groupOf, null, (stage, pct) => {
      parentPort.postMessage({ type: 'progress', stage, pct });
    });
    if (!geom) { parentPort.postMessage({ type: 'error', error: 'geometry unavailable' }); return; }
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const p = geom.P[i] || [0, 0, 0];
      out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2];
    }
    parentPort.postMessage(
      { type: 'done', coords: out.buffer, usedUmap: geom.usedUmap, stretch: geom.stretch },
      [out.buffer],
    );
  } catch (e) {
    parentPort.postMessage({ type: 'error', error: String((e && e.message) || e) });
  }
});
