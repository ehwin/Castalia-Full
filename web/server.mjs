/**
 * Castalia Web Console — 3D 可视化主界面 + 管理副界面(入口)
 *
 * 独立 Express 服务器。路由已拆分到 routes/*.js:
 *   - routes/graph.js     /api/graph /api/stats /api/status
 *   - routes/memory.js    /api/memory CRUD /move /toggle_important /update
 *   - routes/config.js    /api/config GET/POST
 *   - routes/reflect.js   /api/reflect/run /api/reflect/history
 *   - routes/aggregate.js /api/aggregate/* /api/manage/*
 *
 * 环境变量:
 *   WEB_PORT         默认 3345
 *   MEMORY_DB_DIR    默认 <项目根>/memory/(按项目分库)
 *   MEMORY_DB_PATH   旧单库路径(兼容模式)
 *   NODE_BIN         默认 node(PATH)
 */
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { PORT, DB_DIR } from './routes/lib.js';

import graphRouter from './routes/graph.js';
import memoryRouter from './routes/memory.js';
import configRouter from './routes/config.js';
import reflectRouter from './routes/reflect.js';
import aggregateRouter from './routes/aggregate.js';
import membersRouter from './routes/members.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));

// 所有写请求只接受本机同源:挡 DNS rebinding / 跨站 CSRF(2026-10-17)。
// 星图/管理 API 会软删/迁移记忆、改写 config,不能只靠"绑了 127.0.0.1"。
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const host = String(req.headers.host || '').toLowerCase();
  const hostname = host.startsWith('[') ? host.split(']')[0] + ']' : (host.includes(':') ? host.split(':')[0] : host);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
    return res.status(403).json({ ok: false, error: '仅允许本机访问' });
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      const ohost = new URL(origin).hostname;
      if (!['127.0.0.1', 'localhost', '::1'].includes(ohost)) {
        return res.status(403).json({ ok: false, error: '拒绝跨站请求' });
      }
    } catch { return res.status(403).json({ ok: false, error: '拒绝跨站请求' }); }
  }
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    return res.status(403).json({ ok: false, error: '拒绝跨站请求' });
  }
  next();
});

// API 路由
app.use('/api', graphRouter);
app.use('/api', memoryRouter);
app.use('/api', configRouter);
app.use('/api', reflectRouter);
app.use('/api', aggregateRouter);
app.use('/api', membersRouter);

// ═══ 静态服务 ═══
// 本地 3D 依赖(three.js / 3d-force-graph)——离线可用;文件名带版本号,升级即换名防缓存
app.use('/vendor', express.static(join(__dirname, 'public', 'vendor'), { maxAge: '1h' }));
// 前端自身的 CSS/JS(2026-09-19 从 index.html 内联样式/脚本抽出,便于维护;no-cache 由下面中间件统一加)
app.use('/assets', express.static(join(__dirname, 'public', 'assets'), { maxAge: 0, etag: false }));
for (const f of ['castalia-mark.png', 'castalia.png', 'favicon.png']) {
  app.get('/' + f, (_req, res) => res.sendFile(join(__dirname, 'public', f)));
}
// 拆分后的前端模块(普通 script,no-cache 防开发期缓存)
// 页面/API 不缓存
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-cache'); next(); });
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // 2026-10-28: 汇总星图的本库是空的,数据只在 federation 视图里 —— 直接访问 / 时页面
  // 默认 scope=local 会得到一张 0 节点空星图。这里把"本实例默认作用域"注入页面:
  //   优先 GRAPH_SCOPE,其次"进程里配了联邦成员"(castalia_config 会为 federation:true 注入
  //   FEDERATION_DIRS/MEMBERS),否则 local。页面只在 URL 未带 scope 时才采用它。
  const fedEnv = ['FEDERATION_DIRS', 'FEDERATION_MEMBERS']
    .some(k => String(process.env[k] || '[]').replace(/[\[\]\s"]/g, '') !== '');
  const defaultScope = String(process.env.GRAPH_SCOPE || (fedEnv ? 'federation' : 'local')).toLowerCase();
  const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf-8')
    .replace('</head>', `<script>window.__GRAPH_DEFAULT_SCOPE__=${JSON.stringify(defaultScope)};</script></head>`);
  res.send(html);
});
app.get('/aggregate.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(readFileSync(join(__dirname, 'public', 'aggregate.html'), 'utf-8'));
});
app.get('/manage.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(readFileSync(join(__dirname, 'public', 'manage.html'), 'utf-8'));
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   Castalia Web Console                  ║
  ║   http://127.0.0.1:${PORT}                  ║
  ║   DB_DIR: ${DB_DIR}  ║
  ╚══════════════════════════════════════════╝
  `);
});
