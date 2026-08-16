# dsh 任务 4/4：库管理设置页（手动调整记忆库归属）

你是 Castalia 记忆体系统的开发代理。任务：做一个「库管理」设置页，让用户**手动调整记忆归属**（跨库移动、批量迁移、改分类、软删）——解决"AIRI 库混杂 Hermes 早期记忆，需要人工分拣"的问题。主开发仓库：`/path\ai-memory`（当前工作目录）。

**模型指令：本任务必须使用 pro 模型（deepseek-v4-pro）执行**——用户明确指定界面开发交给 pro 模型。

## 环境事实（必须遵守）

- 完全权限已开启（danger-full-access）：允许写工作区外目录（如 `/path/to/castalia-run\viz`），但**只写任务需要的文件，其余一概不动**
- node 用 137：`D:\system\New Folder\node.exe`（native 模块 ABI）
- **不要 git commit；不要重启托盘/桥/viz 服务；不要动密钥；临时文件用完即删**
- **测试移动 API 必须在临时拷贝的库上做（如复制 anima-run 库到临时目录当测试库），严禁直接对真实库执行移动/删除**

## 现有代码结构（先读再改）

- `web/server.mjs`：Express；已有 `openDb(readonly)`（含 sqliteVec.load）、`openLibDb(file, readonly)`、`libFiles()`（扫描各实例 memory 目录返回 [{instance, project, file}]）、`/api/graph`、`/api/aggregate/*`、`POST /api/memory/delete`、`POST /api/memory/toggle_important`、`POST /api/memory/update`；`CONFIG_PATH` 读 config.json（含 embedding 配置）；**无静态中间件，新页面需显式路由**
- `web/public/index.html`：3D 星图/总成视图（顶部有「🗂 记忆总成」链接到 /aggregate.html）；现有 CSS 变量 `--bg/--panel/--border/--t-primary/--t-border`
- `web/public/aggregate.html`：跨库总览页（可参考其样式/API 调用风格）
- memory 表字段：`id/text/project/type/mem_type/category/subcategory/tags/importance/character_id/source/subject/tier/expires_at/is_active/created_at/updated_at/last_accessed_at/accessed_count/reference_count`
- 向量表：查 `dist/db.ts` 或 `dist/store.ts` 里 sqlite-vec 的表名和结构（形如 `vec_memory(id TEXT PRIMARY KEY, vector BLOB)` 或类似——**以实际代码为准**，移动时必须把向量行一并复制到目标库）
- 各实例库目录：`/path\anima-run\memory`（airi 110 条）、`/path/to/castalia-run\memory`（hermes/shared/default）、`/path/to/run\memory`（lobehub/custom-project/shared）——`libFiles()` 已有聚合逻辑可复用

## 功能要求

### 1. 后端 `POST /api/memory/move`
- 请求：`{ids: string[], toProject: string}`（toProject = 目标库名，如 'hermes'；不含 'project-' 前缀）
- 逻辑：
  - 对每个 id：在**所有实例的库**中定位该记忆（用 libFiles 逐个查，或前端先传 fromProject 减少扫描——**推荐前端传 {ids, fromProject, toProject}**，后端直接开源库）
  - 源库读全字段 + 向量行（vec 表）→ 目标库（`<DB_DIR>/project-<toProject>.sqlite`，不存在则按现有 schema 建表：memory 表 + vec 表 + 必要索引）→ INSERT 保留 id/text/type/mem_type/category/tags/importance/character_id/source/subject/tier/expires_at/is_active/created_at/updated_at（created_at 必须保留历史）→ 向量行复制（文本不变向量不变，**不要重新嵌入**）
  - 源库删除：memory 行 + vec 行 + 该记忆相关的 edges 行（关系边跨库无效，直接删）
  - 目标库与源库相同（toProject == fromProject）→ 直接返回 ok 不动
  - 返回：`{ok: true, moved: N, failed: [{id, error}]}`；单条失败不影响其他（逐个 try）
  - 幂等：目标库已存在同 id → 跳过该条（计入 failed 或 skipped）
- 事务：每个 id 的移动用事务（源删 + 目标插 原子）

### 2. 后端 `GET /api/manage/libraries`
- 返回所有库及记忆数：`{ok: true, libraries: [{project, instance, file, active, total}]}`（active=is_active=1 数，total=全量数）
- 复用 libFiles() + openLibDb() 只读计数

### 3. 前端 `web/public/manage.html`（新页面，风格对齐 aggregate.html）
- **库总览区**：库卡片网格（库名 + 实例 + 活跃/总数），点卡片进入该库列表
- **库内列表区**：
  - 顶部：库名 + 「⬅ 返回总览」+ 搜索框（过滤文本/类型）+ **批量移动选择器**（目标库下拉 + 「移动选中」按钮 + 「移动全部匹配」按钮）
  - 记忆行：checkbox + 文本摘要（60 字符截断）+ mem_type 徽章 + 类型 + 时间（created_at）
  - 每行操作：单条移动（目标库下拉）+ 改 mem_type（下拉：user/feedback/project/reference/general）+ 软删
  - 移动/删除/改类后本地更新列表（不整页刷新），统计同步
- **改 mem_type**：调现有 `POST /api/memory/update`（fields: {memType}——**先确认 update 端点接受 memType 字段**，若不接受则改字段名或加处理）
- **安全确认**：批量移动/删除前 confirm() 显示数量与目标
- 移动中的记忆显示「移动中…」禁用，完成刷新

### 4. server.mjs 静态路由
- 加 `app.get('/manage.html', ...)` 显式路由（读 public/manage.html 返回，参考 aggregate.html 的路由写法）

### 5. index.html 入口
- 顶部工具栏加「🗂 库管理」链接（指向 /manage.html，样式同「记忆总成」链接）

## 验证要求（逐项做）

1. `node --check web/server.mjs`（137 node）exit 0
2. **副本库实测**（严禁真实库）：
   - 复制 `/path\anima-run\memory\project-airi.sqlite` 到临时目录（如 `/path\ai-memory\_test_libs\`），用 `WEB_PORT=3347 MEMORY_DB_DIR=<临时目录>` 起临时 viz
   - 但 move 需要跨实例目录（libFiles 扫描 AGGREGATE_DIRS）——用 `AGGREGATE_DIRS` env 指向临时目录 + 再放一个空的 project-hermes.sqlite 在临时目录，验证移动 airi→hermes 生效：目标库出现该记忆+向量行、源库消失
   - 移动前后对比：字段完整（created_at 保留）、向量行存在（SELECT COUNT(*) 对比）、edges 清理
   - 幂等：重复移动同 id → skipped
   - 测完删临时目录
3. index.html/manage.html 内联 JS 语法检查（node vm.Script）或等价手段
4. 目检：无 XSS（文本插入用 textContent 或转义）、无未定义变量

## 同步要求

- `cp web/server.mjs` → `/path/to/castalia-run\viz\server.mjs` 和 `/path/to/run\viz\server.mjs`
- `cp web/public/manage.html` → 两个实例的 `viz\public\manage.html`
- `cp web/public/index.html` → 两个实例的 `viz\public\index.html`

## 交付报告

最后输出：改动文件清单、每个功能完成状态（✅/⚠️+原因）、副本库实测结果（移动前后对比数据）、同步确认（SHA256 或一致性说明）。**如实报告失败项**。
