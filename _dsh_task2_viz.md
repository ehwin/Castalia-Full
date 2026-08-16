# dsh 任务 2/2：Castalia 3D 总成视图（软件一团 / 库一团 / 中间连线）

你是 Castalia 记忆体系统的开发代理。任务：给 viz 3D 可视化加"总成视图"——**软件节点一团、库节点一团、中间显示归属连线**（二分图）。主开发仓库：`/path\ai-memory`（当前工作目录）。

## 环境事实（必须遵守）

- node 用 137：`D:\system\New Folder\node.exe`（native 模块 ABI）
- viz = `web/server.mjs`（Express，无静态中间件，页面需显式路由）+ `web/public/index.html`（ForceGraph3D 单页）
- server.mjs 已有 `/api/aggregate/overview|search|recent|projects` 和 `AGGREGATE_DIRS`（默认 Hermes/LobeHub/AIRI/当前实例 memory 目录，按目录去重）、`openLibDb(file, readonly)`、`libFiles()`（返回 [{instance, project, file}]）
- index.html 现有结构：`fetch('/api/graph')` → `new ForceGraph3D(document.getElementById('graph'))`（graphInstance），顶部 `#top-bar` 有「⚙ 管理」按钮；CSS 变量 `--t-primary/--t-border`
- **不要 git commit；不要重启 viz/桥服务；不要动密钥；临时文件用完即删**

## 实现要求

### 1. `web/server.mjs` 加 `GET /api/aggregate/graph`

返回二分图数据（总成视图专用）：
```json
{
  "ok": true,
  "nodes": [
    {"id": "software:Hermes", "group": "software", "label": "Hermes", "value": 0},
    {"id": "library:default", "group": "library", "label": "default", "value": 0},
    ...
  ],
  "links": [
    {"source": "software:Hermes", "target": "library:default", "value": 0}
  ]
}
```
- software 节点 = 每个实例（AGGREGATE_DIRS 的 name），value = 该实例所有库记忆总数
- library 节点 = 去重后的 project 名（跨实例同名库合并），value = 该库跨实例记忆总数
- links = 实例拥有该库（该实例目录下存在该 project 文件），value = 该实例该库的记忆数
- 复用 `libFiles()` + `openLibDb()` 计数（只读）

### 2. `web/public/index.html` 加「总成视图」切换

- `#top-bar` 加按钮「🗂 总成视图」；再点切换回「记忆星图」（或两个按钮互斥高亮）
- 总成视图渲染：fetch `/api/aggregate/graph` → 用同一个 graphInstance 渲染（`graphInstance.graphData({nodes, links})` 或重建）：
  - **布局**：software 节点 `fx=-250`、library 节点 `fx=250`（y/z 随机散开或按 value 排布），形成左右两团
  - 节点大小按 `value`（`nodeVal` 或 `nodeSize`），label 显示 `group:label`；连线粗细按 `value`
  - 颜色区分：software 团一色（如青绿 --t-primary #00A89A 系）、library 团另一色（如紫 #7c6ff7）
- 「记忆星图」视图 = 现有 `/api/graph` 渲染逻辑（原样保留，切换回来要能恢复）
- 视图切换时清理/重建节点状态；空库（nodes 为空）显示提示文本不崩
- 现有 3D 交互（拖拽/缩放/节点标签）保持可用

### 3. 构建验证

- `node --check web/server.mjs` 通过（用 137 node）
- 起一个临时 viz 测 API：`cd web && WEB_PORT=3347 "D:/system/New Folder/node.exe" server.mjs`（后台），`curl http://127.0.0.1:3347/api/aggregate/graph` 确认返回合法二分图结构（当前有数据：AIRI/default 约 110 条记忆）；测完杀掉进程
- index.html 用浏览器打开会报 3D 依赖加载问题就跳过（本机无头），但 JS 语法用 `node --check` 等价检查不可行（HTML 内联）——目检代码正确性，确保没有引用未定义变量

### 4. 同步到运行实例 viz

- `cp web/server.mjs` → `/path/to/castalia-run\viz\server.mjs` 和 `/path/to/run\viz\server.mjs`
- `cp web/public/index.html` → 两个实例的 `viz/public/index.html`
- （aggregate.html 不变，不用动）

## 交付报告

最后输出：改动文件清单、/api/aggregate/graph 实测返回样例（节点/边数量）、同步确认。**如实报告失败项**。
