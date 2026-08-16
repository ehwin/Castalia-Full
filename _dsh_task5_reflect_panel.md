# dsh 任务 5/5：反思面板（一键总反思 + 文本框输出 + 历史记录防误提交）

你是 Castalia 记忆体系统的开发代理。任务：在「库管理」页（manage.html）加一个**反思面板**——情感端/管理端一键调用总反思（reflect_all），结果输出到下方文本框，并保存**反思历史记录**（可回看，防止反思提交错误）。主开发仓库：`/path\ai-memory`（当前工作目录）。

**模型指令：本任务必须使用 pro 模型（deepseek-v4-pro）执行**——用户明确指定界面开发交给 pro 模型。

## 环境事实（必须遵守）

- 完全权限已开启（danger-full-access）：允许写工作区外目录，但**只写任务需要的文件**
- node 用 137：`D:\system\New Folder\node.exe`
- **不要 git commit；不要重启托盘/桥/viz 服务；不要动密钥；临时文件用完即删**
- 测试时严禁污染真实 reflect 库：dryRun 测试为主；真实提交测试前先确认（或只在用户确认后做一次）

## 现有代码结构（先读再改）

- `web/server.mjs`：已有 `mcpCall(toolName, args)`（spawn 当前实例 `dist/index.js`，env 带 MEMORY_DB_DIR/MEMORY_CONFIG/MCP_TOOLS；**超时硬编码 120s**——reflect_all 要调 LLM 可能超，需支持超时参数）、`/api/manage/*`（库管理）、`/api/memory/move`、`openDb/openLibDb/libFiles`、`DB_DIR`（当前实例记忆目录）、`CONFIG_PATH`（config.json，含 reflect.llm_url/api_key/model 配置）
- `web/public/manage.html`：库管理页（库总览卡片/库内列表/移动/改类/软删；有 `esc()` 转义工具、事件委托风格、CSS 变量 `--bg/--panel/--border/--t-primary`）
- **3345/3346 viz 启动 env 已配 `FEDERATION_DIRS`**（Hermes + AIRI 目录）→ mcpCall 子进程继承后，reflect_all 可扫全机库（hermes 12 条 + airi 98 条等）
- reflect_all 参数：`maxTotal/maxPerLib/dryRun/projects`（projects=['hermes'] 只反思指定库）
- 运行中服务：3345（castalia-run viz）/3346（lobehub-run viz）/3310/3312（桥）——**不要重启它们**

## 功能要求

### 1. 后端 `POST /api/reflect/run`
- 请求：`{ mode: 'all' | 'project', projects?: string[], dryRun?: boolean, maxTotal?: number, maxPerLib?: number }`
  - mode='all' → reflect_all 不带 projects（全机总反思）
  - mode='project' → 必须带 projects（如 ['hermes']）
  - dryRun 默认 false；dryRun=true 只分析不写入 reflect 库
- 实现：
  - `mcpCall('reflect_all', {maxTotal, maxPerLib, dryRun, projects})`——**先给 mcpCall 加 timeoutMs 参数（默认 120000，reflect 调用传 300000）**
  - 返回：`{ok, mode, dryRun, scanned, llm, errors, insightList}`（insightList 含每条 text/memType/importance/tags/sources）
  - **同时把本次反思追加到历史记录**（见下）
- 错误处理：reflect LLM 未配置（config.json 无 reflect key）时返回明确错误信息，不崩

### 2. 历史记录（防止反思提交错误/可回看）
- 存储：`<DB_DIR>/reflect_history.jsonl`（每行一条 JSON，追加写）
- 每条：`{ts, mode, projects, dryRun, ok, scanned:{libraries,memories}, llm:{insights,skipped,saved}, errors, insightTexts: [每条洞察text], sources: [[{instance,project}...]...]}`（insightTexts 与 sources 按顺序对应）
- 文件不存在则创建；写入失败不阻塞主流程（catch 记 console.error）
- 上限：超过 200 条时裁剪保留最新 200 条

### 3. 后端 `GET /api/reflect/history?limit=20`
- 读 jsonl，倒序（最新在前），返回 `{ok, history: [{ts, mode, dryRun, ok, scanned, llm, errors, insightTexts, sources}]}`
- limit 默认 20，最大 100

### 4. 前端 manage.html 加「🧠 反思」面板
- 位置：库总览区上方或独立区块（与库管理并列），标题「🧠 反思（跨库整合）」
- 控件：
  - 模式选择：radio「总反思（全库）/ 项目级反思」+ 项目级时输入库名（默认 hermes，可填 airi 等）
  - 「dryRun 预演」勾选框（默认勾选——**防止误提交**；取消勾选时按钮文字变红提示"将写入 reflect 库"）
  - 「🧠 运行反思」按钮（运行时禁用显示"反思中…"，LLM 调用可能 1-3 分钟，给足耐心提示）
- **下方文本框**（textarea 或 pre，只读，可选中复制）：显示本次结果——统计（扫描 N 库 M 条）、每条洞察全文（编号+文本+来源 [instance/project]）、错误列表
- **历史记录区**：倒序列表（时间 / 模式 / 洞察数 / 是否 dryRun），点击条目展开显示该次完整洞察文本（可复制）；「刷新历史」按钮
- 防错细节：dryRun 未勾选时 confirm() 提示"将真实写入 reflect 库，继续？"；历史展开的旧记录不影响当前文本框内容
- 样式对齐 manage.html 现有风格；文本一律 `esc()` 转义

### 5. 验证要求（逐项做）

1. `node --check web/server.mjs`（137 node）exit 0
2. 临时起 viz 实测（**用真实服务 3345 的端口会冲突——用 `WEB_PORT=3349` 另起临时实例，env 带 MEMORY_DB_DIR=真实目录 + FEDERATION_DIRS=真实配置**，测完杀）：
   - `POST /api/reflect/run {mode:'all', dryRun:true, maxTotal:30, maxPerLib:20}` → 返回 ok、scanned 覆盖多库（hermes+airi）、insightList 有内容、**不写入 reflect 库**（dryRun）
   - `POST /api/reflect/run {mode:'project', projects:['hermes'], dryRun:true}` → 只扫 hermes 库
   - `GET /api/reflect/history` → 返回刚才的记录（含 dryRun 标记）
   - 历史文件 `reflect_history.jsonl` 出现在对应 DB_DIR 且内容正确
   - 超时测试：reflect 调用传 timeoutMs=300000 生效（无需真的等 5 分钟，检查代码路径即可）
3. manage.html 内联 JS 语法检查（node vm.Script）+ 目检（esc 转义、无未定义变量）
4. **真实提交测试 1 次**：确认 dryRun=false 写入 reflect 库成功（可先用 projects:['hermes'] 小范围），并在历史中记录

## 同步要求

- `cp web/server.mjs` → `/path/to/castalia-run\viz\server.mjs` 和 `/path/to/run\viz\server.mjs`
- `cp web/public/manage.html` → 两个实例的 `viz\public\manage.html`
- （index.html 不改动——反思入口只在 manage.html）

## 交付报告

最后输出：改动文件清单、每个功能完成状态（✅/⚠️+原因）、实测结果（dryRun 总反思扫描库/历史记录样例/真实提交 1 次）、同步确认（SHA256）。**如实报告失败项**。
