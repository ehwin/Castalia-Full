# dsh 任务 1/2：Castalia 反思模块 reflect_all（跨库反思 → reflect 总库）

你是 Castalia 记忆体系统的开发代理。任务：实现"末端反思模块"——从全机所有记忆库取记忆，做跨库 LLM 反思整合，把提炼出的洞察写入一个专用总库（project=`reflect`）。**只从记忆库取记忆，不碰对话日志**。非破坏性：不修改任何源库。

## 环境事实（必须遵守）

- 主开发仓库（当前工作目录）：`/path\ai-memory`（通用版 Castalia，TypeScript，`npm run build` = `tsc -p tsconfig.build.json`）
- node 必须用 137：`D:\system\New Folder\node.exe`（better-sqlite3/sqlite-vec 按 NODE_MODULE_VERSION 137 编译；PATH 里的 hermes node 是 127 会 ABI 崩溃）
- 单文件 tsc 检查（编辑器 lint）报的 esModuleInterop/downlevelIteration 错误是既有噪音，**忽略**；以 `npm run build` exit 0 为准
- 冒烟：`python -u scripts/smoke_test.py`（已内置 137 node 路径）
- **不要 git commit**（我事后统一提交）；**不要重启桥/托盘/viz 服务**（运维我来）；**不要动 keys.enc / config.json 里的密钥**
- 临时测试文件用完即删；测试记忆写入后要删除

## 已有基础设施（v1.12.0，不要重复造）

- `src/federation.ts`：`resolveFedLibraries(ownDir)` 返回 `[{instance, project, file}]`（本实例 + FEDERATION_DIRS 的外部实例库文件清单）；`fedTextSearch(libs, query, topK)` 只读 LIKE 搜索
- `src/db.ts`：`DatabaseManager.getInstance(project)`（打开/创建 project-<name>.sqlite）、`listProjectNames()`、`currentMemDir()`、`safeFilePart(name)`
- `src/reflectDriver.ts`：`makeLlmChannel('REFLECT')` 返回 `{url, apiKey, model}`（OpenAI 兼容通道，配置来自 config.json 的 reflect 段）；`callLlm(systemPrompt, userPrompt, channel?)` 调用 `{url}/chat/completions` 返回 `{content}` 或 null
- `src/store.ts`：`saveMemory(...)` 存记忆（看签名，或直接 SQL INSERT memory 表——参照 store.ts 现有写法）
- `src/index.ts`：`register(name, group, desc, schema, handler)` 注册工具；`TOOL_GROUPS.admin` 数组加工具名；`ok(data)`/`err(msg, code)` 返回信封；`z` 来自 zod；`DatabaseManager` 已导入
- 项目隔离：所有工具支持 `project` 参数；`project='reflect'` 不存在时 getInstance 会自动建库

## 实现要求

### 1. 新建 `src/reflectAll.ts`

导出 `runReflectAll(opts)`：

```ts
export interface ReflectAllOptions {
  maxTotal?: number;   // 总记忆数上限,默认 300
  maxPerLib?: number;  // 每库上限,默认 100
  dryRun?: boolean;    // true = 只分析不写入
}
```

流程：
1. `resolveFedLibraries(currentMemDir())` 拿到全部库文件清单；跳过 project 名为 `reflect` 的库（自己）
2. 每库 better-sqlite3 **只读**打开（参照 federation.ts 的 `{readonly:true, fileMustExist:true}` 模式），取活跃记忆：`SELECT id, text, mem_type, importance, created_at FROM memory WHERE is_active=1 ORDER BY created_at DESC LIMIT ?`，text 截断到 300 字符；逐库 try/catch，单库失败不影响整体
3. 组装 LLM 输入：按 `[instance/project]` 前缀分组列出各库记忆；系统提示参照 `REFLECT_SYSTEM_PROMPT` 的 JSON 输出风格（从 reflect.ts 或 reflectDriver.ts 导入/仿写）；用户提示要求输出**严格 JSON**：
   ```json
   {"insights": [{"text": "跨库整合后的洞察/合并后的记忆", "memType": "user|feedback|project|reference|general", "importance": 0.0-1.0, "tags": ["..."], "sources": [{"instance":"...","project":"..."}]}]}
   ```
   要求：跨库去重合并（语义重复的只留一条，sources 列出所有来源）；从源记忆提炼高价值洞察；数量不超过输入库数的 3 倍、最多 50 条
4. 调用 `makeLlmChannel('REFLECT')` + `callLlm`（LLM 未配置时返回错误说明，不崩）
5. dryRun：返回分析结果不写入
6. 写入（非 dryRun）：每条 insight 存进 project=`reflect`：
   - text = insight.text；memType/importance/tags 按结果；`source='reflect-all'`
   - 查重：写入前查 reflect 库 `SELECT 1 FROM memory WHERE is_active=1 AND text=?`，已存在则跳过（计数 skipped）
   - tags 里附上每个来源的 `instance:project` 标记
7. 返回 `{ok, op:'reflect_all', dryRun, scanned:{libraries, memories}, llm:{insights, skipped, saved}, errors:[...]}`

### 2. `src/index.ts` 注册 `reflect_all`（admin 组）

- import：`import { runReflectAll } from './reflectAll.js';`
- `TOOL_GROUPS.admin` 数组加 `'reflect_all'`
- 注册：name=`reflect_all`，schema `{maxTotal?, maxPerLib?, dryRun?}`，描述说明"跨库反思整合：从所有记忆库取记忆→LLM 提炼→写入 reflect 总库（非破坏）"

### 3. 构建 + 冒烟

- `npm run build` exit 0
- `python -u scripts/smoke_test.py` 全 PASSED（工具数应为 32，含 reflect_all）
- 自测一次 `reflect_all`（dryRun=true，maxTotal=50）确认不崩（LLM 通道走 config.json 的 reflect 配置，本机已配 DeepSeek）

### 4. 三仓库同步（维护铁律）

- `src/reflectAll.ts` 复制到：`/path/to/ai-memory\src\` 和 `D:\system\AIRI\memory\memory-fused\src\`
- 两个衍生仓库的 `src/index.ts` 同样加 import + TOOL_GROUPS.admin + 注册块（**锚点式补丁，不要整文件覆盖**——Anima 有 charFor/情感增强，主系统有 mood_journal；追加即可。注册块可以放在 project_create 注册后面，用 `register(` 开头、`);` 结尾的完整块插入）
- 两个衍生仓库各自 `npm run build` exit 0
- dist 全量同步（18+ 文件）：`cp /path\ai-memory\dist\*.js` → `/path/to/castalia-run\dist\`、`/path/to/run\dist\`、`/path\anima-run\dist\`；再 `cp /path/to/ai-memory\dist\*.js` → `/path\anima-run\dist\`（anima-run 用 Anima 版构建产物覆盖）

## 交付报告

最后输出：改动的文件清单（每个文件一句话）、三个仓库 build 结果、smoke 结果、reflect_all dryRun 自测结果、dist 同步确认。**如实报告失败项**，不要编造成功。
