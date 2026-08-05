# Changelog — Castalia(公共版)

> 本文件记录每次功能/架构变更,供 AIRI 主系统(`D:\system\AIRI\memory`)吸收改进时快速对账。
> 格式:Keep a Changelog 简化版(Added / Changed / Fixed / Removed)。

## [v1.5.3] — 2026-08-05 嵌入管线三档可选(EMBED_MODE)

### Added
- **`EMBED_MODE` 环境变量**三档可选:
  - `none` → **纯本地**:标签/正则 + 文本回退检索,零外部服务(不调 Ollama/API,记忆照常存取)
  - `ollama` → 本地嵌入服务(默认,`OLLAMA_URL`,零 API 成本)
  - `api` → OpenAI 兼容 API(`EMBEDDING_API_KEY`)
- `isEmbedEnabled()`(env.ts):全链路统一开关;`embed()` 在 none 模式直接抛错兜底
- 语义降级:`EMBED_MODE=none` 时搜索跳过向量 KNN 走文本回退、saveMemory 跳过向量去重、batchEmbedPending 返回 disabled、saveFacts 跳过向量回写——**全部实测通过**(嵌入服务指向死端口也不报错)

### Changed
- search.ts Phase 2 / searchFacts / store.ts 向量路径全部加 `isEmbedEnabled()` 守卫

## [v1.5.2] — 2026-08-05 memory_save 支持自定义过期时间

### Added
- `memory_save` 新增可选 `expiresAt` 参数(ISO datetime):temporary 记忆可覆盖默认 3 天 TTL;standard/critical 显式传入时也生效(语义更灵活)
- 底层 `saveMemory` 原本已支持 `expiresAt`(SQL 列 + 清理逻辑都在),仅工具 schema 未暴露 — 已实测:自定义过期时间正确落库

## [v1.5.1] — 2026-08-05 项目隔离边界修复(opencode 全项目测试发现)

### Fixed
- **fact_search 事实跨项目泄漏**(真 bug):二段查询漏 `f.project = ?`,`proj` 变量算了但从未用于查询 → 项目 A 搜索能返回项目 B 的事实,与隔离承诺相悖(openCode 边界测试发现,已实测无重叠)
- **batchEmbedPending 隐藏 bug**:`m.source != 'conversation_log'` 对 `source=NULL` 恒为假,`memory_save`(source 默认 null)的记忆**永远无法被批量嵌入**;改为 `COALESCE(m.source,'') != 'conversation_log'`
- **saveFacts 向量回写跨项目**:同 SPO 事实跨项目会被重复 embed,补 `project = ?`
- **reflect 流水线跨项目批量嵌入**:`applyReflectActions` 末尾 `batchEmbedPending` 未透传 project

### Changed
- **`normalizeProject()`**(env.ts):项目名 trim + 空/空白回退默认项目,应用于全部写/读入口,消除 `''`/`' '`/`' alpha '` 脏命名空间
- **`reflect_batch_embed` 工具**新增可选 `project` 参数;`batchEmbedPending(characterId, project?)` 支持项目过滤
- `batchEmbedPending` 不传 project 时只处理默认项目(隔离语义一致;跨项目 pending 记忆不自动嵌入,不会串项目,仅漏嵌)

### Note(设计内,不改)
- `memory_get`/`delete`/`update` 凭全局唯一 UUID 操作,无 project 参数是刻意的(ID 即能力令牌,风险仅当 ID 泄露)
- digest 过期清理 / promoteByAccess / restore-critical 全局执行:`expires_at` 是时间语义,与项目正交

## [v1.5] — 2026-08-05 项目隔离(Project Namespace)

> 对齐 Hermes Project 概念:记忆按项目分区,不同项目调用各自的记忆空间,互不串扰。默认 `default` 项目完全向后兼容(老数据/老调用不受影响)。

### Added
- **`project` 维度**:`memory` / `facts` 表新增 `project` 列(默认 `'default'`),索引 `idx_memory_project` / `idx_facts_project`;facts 唯一去重索引改为 `(subject, predicate, object, project)` — 同一事实允许在不同项目各自存在
- **`project_list` 工具**(admin):列出所有项目 + 各项目记忆数/事实数 + 当前项目(`CASTALIA_PROJECT` env)
- **环境变量 `CASTALIA_PROJECT`**:全局默认项目,工具不传 `project` 参数时使用(默认 `'default'`)
- **所有 23 个现有工具新增可选 `project` 参数**(search/save/list/recent/get/stats/context/graph/reflect/auto_process/conversation_save/daily_summary 等),传参即切换到该项目的记忆空间

### Changed
- **去重按项目隔离**:精确去重与向量近重复判定都限定同项目 — 同一文本在不同项目各自落库(不误判重复)
- **向量检索按项目过滤**:vec0 KNN 保持全库候选(候选集放大 topK×8/60 保证单项目召回),在 memory/facts 查询层用 `project=?` 过滤 — 项目 A 的语义查询永远看不到项目 B 的记忆
- **全链路透传**:store / search / reflect(applyReflectActions / applyReflectResult / getUnanalyzedConversations / listAllMemories / getMemoryGraph)/ digest / autoProcessor / reflectDriver 均支持 project 参数

### Fixed
- vec0 虚拟表 KNN 查询不能 JOIN(silent 失败被 catch 吞掉 → 向量搜索返回空);改为 KNN 后按 project 过滤

## [2026-08-05] 全库改名 + Hermes 接入支持

### Changed
- **内部名称统一为 Castalia**:package.json / MCP_SERVER_NAME 默认值 / web console / 示例配置 / 文档全部 `ai-memory → castalia`(GitHub 仓库名同步,`github.com/ehwin/Castalia`)
- **测试脚本路径动态化**:smoke_test / vec_test 不再写死 `/path/...` 本机路径,改为基于脚本位置推导(公共版可在任意 clone 位置运行);node 探测优先 PATH,本机路径仅作 fallback
- **mcp-config.example.json** 改为通用占位符路径,不再泄露作者机器路径

### Added
- **Hermes Agent 安装支持**:`python scripts/setup.py hermes` 输出 `hermes config set mcp_servers '...'` 命令;README 新增 Hermes 安装章节(含 Windows node 不在 PATH 的绝对路径坑、重启生效说明、MCP_TOOLS 建议)

### Fixed
- `memory_save` INSERT 语句 VALUES 19 个占位符 vs 18 列,所有写入报 `19 values for 18 columns` → 已修正为 18 个(影响全部写入路径,冒烟测试因此从 save 开始全挂)

## [2026-08-04] 协议统一 + 上 GitHub

### Changed
- **License: Apache-2.0 → MIT**(统一协议;JPlag 已验证无代码级复制,上游致谢保留在 README Credits)
- 仓库改名 **Castalia**,推至 `github.com/ehwin/Castalia`(Private),默认分支 main
- AIRI 版仓库名规划:**Castalia Anima**(情感线,自用版暂不上传,改完吸收进主项目后转通用情感支线)

## [v1.4] — 2026-08-04 彻底去情感(Castalia = harness 定位)

### Removed
- `mood_journal` 工具(无情绪写入方的死工具)
- `emotional_impact` / `agent_mood` / `agent_desire` 列 + v6.0 VAD 迁移块(建表与迁移)
- 评分公式的情绪维度:`WEIGHT_EMOTION` 删除,权重归一 **一致性 0.65 + 时间衰减 0.35**
- `memory_save` / `memory_get` 的 emotionalImpact 参数与返回字段
- 预设分类 `emotional` / `mood_snapshot`;`VALID_CATEGORIES` 白名单同步清理

> 情感能力完整保留在 AIRI 版(未来情感特化,仓库名规划 Castalia Anima);Castalia 定位纯 harness 记忆后端,零情感残留(全 src 0 处)。

## [v1.3] — 2026-08-04 热度升格 + reflect 回执

### Added
- **热度升格**(借鉴 UPSP memory_heat):`promoteByAccess()` — accessed_count ≥ `HEAT_PROMOTE_THRESHOLD`(默认 5)的 temporary 记忆自动升 standard(免清理)。清理前先升格(cleanupExpiredMemories 内)。`memory_get` 访问 +1 热度
- **reflect 逐动作回执**:`applyReflectActions` 返回 `receipts[]` — 每条动作 {action, status: applied/failed/skipped, targetId, reason, rowsAffected}。UPDATE 影响 0 行 = failed("target not found"),不再静默算成功
- **回执落盘**:`reflect-receipts/reflect-receipt-<ts>.json`(目录可用 `REFLECT_RECEIPT_DIR` 配置)— 含动作原文 + 每条回执,失败动作可事后人工修正

### Fixed
- reflect 幻觉 id 动作此前误计 applied(静默成功),现在 failed + errors 明确原因

## [Unreleased] — 2026-08-04 工具分级与暴露面矫正

### Added
- **工具分级机制**(借鉴 engram ProfileAgent/ProfileAdmin):环境变量 `MCP_TOOLS` 控制注册集(逗号分隔 profile 或工具名)。
  - `agent`(默认,5 个只读):memory_search / fact_search / memory_get / memory_recent / memory_graph
  - `harness`(10 个):写入 + 对话管线 + 反思
  - `admin`(9 个):管理 + context + 手动反思
  - `all`(24 个):全部注册,向后兼容
- `memory_get(id)` 按 id 展开全文(上一版已加,本版归入 agent 组)
- `memory_log(kind: decision|pattern|mistake)` 单一认知记录工具(替代三个 log_*)
- `reflect_auto` 新增 `mode: daily|deep` 参数(deep=原 reflect_deep,合并入口)

### Changed
- **默认暴露面**:主 Agent 只见 5 个只读工具(之前 25 个全暴露)——MCP 回归"记忆后端"职责,上下文组装交给 harness
- `memory_context` / `context_get` 降级为 admin 组(不再给主 Agent)——避免"第二个 harness"架构风险
- `memory_list` 硬上限 50 条(之前默认 200,易灌爆上下文)
- `memory_graph` 默认只返回邻域(节点上限 50,边仅保留两端都在的),不再 dump 全图
- `reflect_deep` 标注 [Legacy],建议改用 `reflect_auto(mode="deep")`
- 统一信封 `{ok, op, count, results:[{id, text(截断200), truncated, kind, score, createdAt}]}` + 失败 `{ok:false, error:{code, message}}`(v1.1 起)

### Fixed
- `stats_get` 未按 CHAR_ID 分区——多实例共用 DB 时统计全库串数据(已加 `AND character_id=?`)

### Removed
- `memory_log_decision` / `memory_log_pattern` / `memory_log_mistake` 三个工具 → 合并为 `memory_log`

## [v1.1] — 2026-08-03 返回格式对齐主流规范

### Added
- 统一信封:读类工具 `{ok, op, query?, count, results, hint}`;失败 `{ok:false, error:{code, message}}`
- 每条 result 带 `id` + `text` 截断 200 字 + `truncated` 标志
- `memory_get(id)` 全文展开(短证据 + 可回查 id 模式)
- `kind` 字段映射(episodic→episode / semantic→reflection)

### Changed
- `ok()`/`err()` 辅助函数:信封化,err 支持错误码(默认 ERROR)
- memory_search / fact_search / memory_recent / memory_list 返回结构统一

## [v1.0] — 2026-08-03 接入体验与上下文包

### Added
- `scripts/setup.py` 一键接入(借鉴 engram setup):claude/opencode/cursor/vscode/codex/json
- `memory_context` 注入包工具(近期+相关+认知+事实+GroundTruth,借鉴 engram mem_context / memory-os fabric_brief)
- `docs/TECHNICAL_REPORT.md` 技术报告(架构/运行机制/评分/配置全量)
- Web Console `web/`(3345):3D 星图主界面 + 管理抽屉副界面,内嵌 MCP client,config.json 持久化
- `configLoader.ts`:启动时读 config.json 覆盖环境变量(嵌入/反思配置双通道)
- ollama.ts 双模式嵌入:Ollama `/api/embed` / 云端 API key `/embeddings`

### Changed
- 25 工具(基础 19 + reflect_auto/reflect_deep + 认知记录×3 + memory_context)

## [v0.9] — 2026-08-03 独立分支建立

### Added
- 从 AIRI 分支剥离:删除 emotion/agentState/bias/userLearning 四模块
- 中性化:CHAR_ID 默认 'default'、SERVER_NAME 'castalia'、subject 枚举 ['user','agent','environment']
- `reflectDriver.ts` 反思驱动打包进 server(日常+深度,LLM 环境变量配置,无 key 优雅跳过)
- 19 工具 + reflect_auto/reflect_deep

### Changed
- 评分中性化:一致性 60% + 时间衰减 30% + 情绪标记 10%(权重全可环境变量调)
- `digest.ts`/`autoProcessor.ts` 去 VAD 简化

### Removed
- `user_observe` 工具(人格化,公共版删)
