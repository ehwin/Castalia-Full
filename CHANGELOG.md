# Changelog — ai-memory(公共版)

> 本文件记录每次功能/架构变更,供 AIRI 主系统(`D:\system\AIRI\memory`)吸收改进时快速对账。
> 格式:Keep a Changelog 简化版(Added / Changed / Fixed / Removed)。

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
- 中性化:CHAR_ID 默认 'default'、SERVER_NAME 'ai-memory'、subject 枚举 ['user','agent','environment']
- `reflectDriver.ts` 反思驱动打包进 server(日常+深度,LLM 环境变量配置,无 key 优雅跳过)
- 19 工具 + reflect_auto/reflect_deep

### Changed
- 评分中性化:一致性 60% + 时间衰减 30% + 情绪标记 10%(权重全可环境变量调)
- `digest.ts`/`autoProcessor.ts` 去 VAD 简化

### Removed
- `user_observe` 工具(人格化,公共版删)
