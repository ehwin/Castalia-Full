# dsh 任务 3/3：Castalia 3D 可视化全面改造（mnemo 外貌 + supermemory 架构思维）

你是 Castalia 记忆体系统的开发代理。任务：把 3D 可视化界面升级成 **MNEMO 风格**（3D 星座外貌：球体+光晕节点、3D 空间文字标签、Auto-Tour 自动导览、沉浸全屏、详情卡片、统计宫格），同时保留现有全部功能。主开发仓库：`/path\ai-memory`（当前工作目录）。

**模型指令：本任务必须使用 pro 模型（deepseek-v4-pro）执行**——用户明确指定 3D 视图开发交给 pro 模型。

## 环境事实（必须遵守）

- 完全权限已开启（danger-full-access）：允许写工作区外目录（如 `/path/to/castalia-run\viz`），但**只写任务需要的文件，其余一概不动**
- node 用 137：`D:\system\New Folder\node.exe`（native 模块 ABI）
- **不要 git commit；不要重启托盘/桥/viz 服务；不要动密钥；临时文件用完即删**

## 参考代码（MNEMO 外貌，先 curl 抓下来读）

- 星座核心：`https://raw.githubusercontent.com/crastatelvin/mnemo-memory-os/master/frontend/src/components/MemoryConstellation.jsx`
- 详情卡片：`https://raw.githubusercontent.com/crastatelvin/mnemo-memory-os/master/frontend/src/components/MemoryDetail.jsx`
- 统计宫格：`https://raw.githubusercontent.com/crastatelvin/mnemo-memory-os/master/frontend/src/components/MemoryStats.jsx`

要点摘录（已核实）：
- 节点 = THREE.Group：核心球体(`SphereGeometry(size*0.5)` 基础色) + 光晕球(`SphereGeometry(size*0.85)`, 半透明, 选中 0.7/普通 0.25, 图片节点线框) + 文字 Sprite(CanvasTexture 512x64, bold 24px 等宽字体, 22 字符截断+…, 阴影 shadowBlur 6, 类型色, globalAlpha 0.85, 放在节点下方 `(0,-(size+4),0)`)
- Auto-Tour：60 秒 setInterval 随机选节点 → `cameraPosition(节点方向×distRatio, 节点, 2500ms)` 飞近 + 金色高亮；**用户手动点击节点即停止 auto-tour**
- 点击节点：cameraPosition 飞近(1500ms) + 打开详情
- 全屏：`containerRef.requestFullscreen()` / `document.exitFullscreen()`，监听 `fullscreenchange`
- 详情卡：右侧 360px 绝对定位卡片，类型色边框(星标 2px/普通 1px)、`backdropFilter: blur(20px)`、`background: rgba(0,0,0,0.5)`、spring 入场动画
- 统计：6 宫格 grid，大数字 + 小标签，每格类型色

## 现有代码结构（先读再改）

- `web/server.mjs`：Express；`/api/graph`（星图：nodes+stats）、`/api/aggregate/graph`（总成二分图）、`/api/aggregate/overview|search|recent|projects`、`/api/status`；`openDb()` 只读/读写皆可；memory 表字段见下
- `web/public/index.html`：单页 ForceGraph3D；`graphInstance` 全局复用；`renderStar()`/`renderAssembly()`/`toggleView()` 双视图切换；`showPanel(node)` 详情面板；顶部 `#top-bar`（`#view-btn` 总成视图按钮、`#admin-btn` 管理、搜索框 `#search-input`）；CSS 变量 `--t-primary/--t-border/--panel/--bg`；图例 `#legend`
- memory 表字段：`id/text/project/type(默认episodic)/mem_type(默认general, 五类:user|feedback|project|reference|general)/category/subcategory/tags/importance(0-1)/tier/source/subject/created_at/updated_at/is_active`
- `/api/graph` 的 stats 已含 byType/byCategory/byTier

## 改造清单（全部做完）

### 1. 节点渲染升级（nodeThreeObject 自定义 THREE.Group）
- 每个节点 = 核心球 + 光晕 + 文字 Sprite 标签，用 `nodeThreeObject` 实现（同款引擎 react-force-graph-3d / force-graph-3d，API 一致）
- **着色维度：按 `mem_type`**（星图节点；总成视图保持 software/library 两色逻辑不变）——五色：user=青 `#14b8a6`、feedback=琥珀 `#f59e0b`、project=紫 `#8b5cf6`、reference=蓝 `#3b82f6`、general=灰 `#64748b`；无 mem_type 的记忆用 type 色回退（episodic 琥珀/semantic 紫/working 青）
- 标签 Sprite：显示记忆文本截断（22 字符，截断加…），颜色=节点色；**星图与总成视图都加**（总成视图 label 显示 `group·label`）
- 节点大小按 importance（保留现有 `nodeVal(n => n.importance*6+4)` 语义，但改由 nodeThreeObject 内 size 控制，确保与光晕/标签比例协调）
- 选中节点光晕增强（0.7 opacity），其余 0.25
- 保留 hover 光标变化、点击飞近、点击开详情（onNodeClick）

### 2. Auto-Tour 自动导览
- 顶部工具栏加「▶ 自动导览」按钮：开启后每 60s 随机选一个节点飞近（cameraPosition 2500ms），当前飞向的节点**金色(#fbbf24)高亮**（光晕变金/或加金环）
- **用户手动点击任意节点 → 自动停止**（按钮状态复位）
- 再点按钮关闭；无节点数据时不崩
- 只在星图视图生效；总成视图下按钮禁用或自动忽略

### 3. 沉浸全屏
- 顶部工具栏加「⛶ 全屏」按钮：对 graph 容器 `requestFullscreen()`，全屏时背景转黑，监听 fullscreenchange 同步按钮状态

### 4. 详情卡片升级（右侧滑出）
- 现有 `showPanel` 升级为 MNEMO 风：右侧固定 360px、`backdropFilter: blur(20px)`、半透明黑底、**左边框=记忆类型色**（按 mem_type 五色；星标/重要度高亮 2px）
- 内容：类型徽章(mem_type + type)、全文、时间(created_at)、来源(source/project)、重要度、标签
- **加「⭐ 星标」按钮**：调后端切换 starred（若 memory 表无 starred 字段则用 importance 置 1.0/0.5 模拟，或在服务端加字段——以最小改动为原则，优先 importance）
- **加「🗑 删除」按钮**（确认后调后端软删 `is_active=0`，成功后从图中移除该节点）
- 若 server.mjs 缺更新/删除端点则补（如 `POST /api/memory/toggle_important`、`POST /api/memory/delete`，读写 openDb，返回 ok）——补端点时保持现有风格

### 5. 统计宫格
- 顶部加 6 宫格统计条（可折叠/紧凑）：TOTAL / 按 mem_type 五类的计数（user/feedback/project/reference/general）——数据来自 `/api/graph` 的 stats（若无 byMemType 则在前端从 nodes 统计）
- 每格：大数字(着色) + 小标签，与 MNEMO MemoryStats 一致；总成视图下切换为软件/库计数或隐藏

### 6. 总成视图同步升级
- 总成视图节点同样用球体+光晕+标签渲染（software 青绿 #00A89A / library 紫 #7c6ff7 不变），连线粗细按 value 不变
- Auto-Tour/全屏在总成视图的表现：全屏可用；Auto-Tour 禁用

### 7. 保持现有功能不回归
- 记忆星图/总成视图切换、搜索过滤（总成视图下失效保护）、管理按钮、图例、空库提示——全部保留
- `/api/graph`、`/api/aggregate/graph` 响应结构不变（兼容既有前端逻辑）

## 验证要求（逐项做）

1. `node --check web/server.mjs`（137 node）exit 0
2. 临时起 viz：`cd web && WEB_PORT=3347 "D:/system/New Folder/node.exe" server.mjs`（后台），`curl http://127.0.0.1:3347/api/graph` 确认 nodes 含 mem_type/importance/type 字段、stats 结构正常；新增端点(若有)实测返回合法 JSON；测完杀进程
3. index.html 内联 JS 语法检查（node `vm.Script` 提取 script 块编译，或等价手段），确认无引用未定义变量（特别检查 THREE、ForceGraph3D、graphInstance、allData、loading、CATEGORY_COLORS 等既有符号）
4. 目检 nodeThreeObject 代码：无内存泄漏隐患（texture/sprite 不每帧重建）、标签不遮挡交互

## 同步要求

- `cp web/server.mjs` → `/path/to/castalia-run\viz\server.mjs` 和 `/path/to/run\viz\server.mjs`
- `cp web/public/index.html` → 两个实例的 `viz\public\index.html`
- （aggregate.html 不变）

## 交付报告

最后输出：改动文件清单、每项改造的完成状态（✅/⚠️+原因）、`/api/graph` 实测样例（节点字段）、新增端点实测、同步确认（SHA256 或文件一致性说明）。**如实报告失败项**，不隐瞒。
