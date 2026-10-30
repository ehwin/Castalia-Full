# Castalia-Full — 联邦总线 · 总反思 · 聚合星图

> **引擎不在这个仓。** 这里装的是把多个 Castalia 记忆体收成一张网的那一层：总线进程（跨库检索 + 成员协商）、总反思（跨库 LLM 整合，落到 `reflect` 总库）、以及一台看全部库的聚合星图。

版本以仓库根 `VERSION` 为准（当前 **1.25.4**）：`npm run build` 先用 `scripts/gen_version.mjs` 把它生成到 `src/version.ts`，`package.json` 的 version 只是包管理元数据。

---

## 1. 这个仓和 Castalia（Lite）差在哪

| | **Castalia（Lite）** | **Castalia-Full（本仓）** |
|---|---|---|
| 定位 | 引擎核心源，普通记忆桥跑它 | **总线接口层**：核心照抄 Lite，额外加总线 / 总反思 / 聚合视图 |
| MCP 工具数 | 32 | **34**（多 `reflect_all`、`memory_search_all`）；总线进程另有 `federation_members` |
| 引擎源码 | 唯一权威 | `scripts/sync_core.py` 从 Lite 复制，**不手改核心** |
| 本仓自有代码 | — | `src/index.ts`、`src/version.ts`、`src/fedServer.ts`、`src/reflectAll.ts`、`src/federation/` |
| 写入范围 | 自己的库 | 自己的库 + `project=reflect` 总库（**源库一律只读**） |
| 前端 | 消费方 | `web/` 是**前端单一源**，`sync_frontend.py` 下发到各端 |

一句话记法：**Lite 决定"记忆长什么样"，Full 决定"多个记忆怎么合起来看"。** 单实例记忆体用 Lite；要跨库检索、要一份总成、要一张全库星图才需要这个仓。

## 2. 三仓关系

```
Castalia (Lite)  ──sync_core.py（核心单向复制）──▶  Castalia-Full
  引擎核心源 / 普通记忆桥                          总线接口层 → run/Castalia-Federation
  · src/*.ts 唯一权威                             ├─ 3314 总线（fedServer，MCP over HTTP）
  · VERSION 是版本锚                              ├─ dist/index.js = 核心 + 2 个总线工具
      │                                           └─ 3348 聚合星图
      └──架构回灌（人工）──▶ Castalia-Anima  情感变体，自己一条引擎线、自己的版本号
```

- **核心单向**：Lite → Full，只能由 `sync_core.py` 推动。直接改 Full 的 `src/db.ts`、`src/search.ts` 会被下次同步覆盖，也会被 `check_parity.mjs` 判成漂移。
- **Anima 是参考列**：`check_parity.mjs` 里 Anima 缺失只记 warning、不参与 `ok`——它有自己的一条引擎线，不跟 Lite 同版。
- **输出隔离**：总反思写自己实例的 `reflect` 库，不覆盖源库，也不替代消费者自己的本地反思。消费者（如 AIRI）分别读 Full 与 Anima，各自保留来源标记。

## 3. 运行时布局

| 进程 | 入口 | 默认端口 | 职责 |
|---|---|---|---|
| 引擎入口 | `dist/index.js`（`bin: castalia`） | —（stdio） | 完整核心 + `reflect_all` + `memory_search_all` |
| 总线进程 | `dist/fedServer.js`（`bin: castalia-federation`） | —（stdio） | `memory_search_all` + `federation_members`，对成员**只读** |
| 总线 HTTP 桥 | mcp-proxy 包住 `fedServer.js` | **3314** | 给容器 / 远程 / 别的进程用的 MCP over HTTP |
| Web 控制台 | `web/server.mjs`（只绑 `127.0.0.1`） | **3345**（`WEB_PORT`） | 分区星图 / 记忆总成 / 库管理 |
| 聚合星图 | 同上，`scope=federation` | 约定 **3348** | 一个进程渲染全部成员的全部库 |

端口都可配：总线桥端口在托盘配置的 `federation` 段，星图是 `WEB_PORT`。总线进程本身只说 stdio——**要 HTTP 就自己包一层 mcp-proxy**，和记忆桥同构。

## 4. Quick Start

### 4.1 构建

```bash
npm install
npm run build        # gen_version.mjs → tsc -p tsconfig.build.json
python scripts/smoke_test.py    # 核心 CRUD 往返，不依赖嵌入服务
```

`dist/` 里必须同时有 `index.js`（核心）和 `fedServer.js`（总线）。只有前者就只是又一份 Lite 副本——`deploy_runtime.py` 会拒绝这种产物。

### 4.2 和 Lite 对齐（每次 Lite 发版后）

```bash
py scripts/sync_core.py            # 只检查：核心哈希 + 总线自检，漂移即非零退出
py scripts/sync_core.py --apply    # 从 ../Castalia 拉核心过来
py scripts/port_bus_entry.py       # 重建 src/index.ts = Lite 入口 + 总线两工具
```

`sync_core.py` 是这个仓的守门人：核心漂移 = 总线背后跑着另一个引擎；总线工具消失 = 只剩空壳。两种都算失败。

### 4.3 嵌入服务

```bat
scripts\start-embed.bat
```

默认监听 `http://127.0.0.1:11436`、1024 维；也可用任意 Ollama 兼容 `/api/embed`，或 `EMBED_MODE=api` 走 OpenAI 兼容接口，`EMBED_MODE=none` 则完全不要嵌入服务。换模型只改 `embedding.dim` / `EMBEDDING_DIM`：维度变化时引擎重建 vec 表、清空嵌入缓存，`memory` / `facts` 正文与关系不动。

### 4.4 接进 MCP 客户端

```json
{
  "mcpServers": {
    "castalia-full": {
      "command": "node",
      "args": ["/abs/path/Castalia-Full/dist/index.js"],
      "env": { "MEMORY_DB_DIR": "/abs/path/banks/full", "REFLECT_DIR": "/abs/path/banks/full",
               "MCP_TOOLS": "all", "REFLECT_LLM_API_KEY": "sk-..." }
    }
  }
}
```

或者 `python scripts/setup.py claude|opencode|cursor|vscode|codex|hermes` 生成一版配置。

> ⚠️ `MCP_TOOLS` 默认是 `agent`（7 个只读工具）。**`reflect_all` 与 `memory_search_all` 在 `admin` 组**，不显式放开就看不到它们——这是"这仓的能力没生效"的头号原因。

### 4.5 起总线

成员清单（`FEDERATION_MEMBERS`）：

```jsonc
[
  { "id": "lite-a", "transport": "local-dir", "target": "/abs/path/banks/a" },
  { "id": "full",   "transport": "local-dir", "target": "/abs/path/banks/full" },
  { "id": "anima",  "label": "Castalia Anima", "variant": "anima",
    "capabilities": ["emotion"], "target": "http://127.0.0.1:<port>/mcp" }
]
```

```bash
MEMORY_DB_DIR=/abs/path/banks/full \
FEDERATION_MEMBERS="$(cat members.json)" \
  node dist/fedServer.js
```

### 4.6 起星图

```bash
cd web && npm install
WEB_PORT=3348 FEDERATION_MEMBERS="$(cat members.json)" node server.mjs
```

打开 `http://127.0.0.1:3348/?scope=federation`。汇总实例自己的库可以是空的——数据全来自成员；URL 不带 `scope` 时按"进程里有没有配联邦成员"自动推断，避免得到 0 节点空图。

---

## 5. 总线接口

### 5.1 成员注册（三种来源，可叠加）

| 方式 | 变量 | 说明 |
|---|---|---|
| 声明式 | `FEDERATION_MEMBERS` | `[{id,label,variant,capabilities,transport,target}]`，推荐 |
| 兼容老写法 | `FEDERATION_DIRS` | `[{name,dir}]`，每条变成 `local-dir` 成员，行为不变 |
| 星图注册表 | `GRAPH_MEMBERS_FILE` | 默认 `<MEMORY_DB_DIR>/../federation-viz.json`；「成员」页写入，**仅本机可写**（校验 remote address / Host / Origin / `sec-fetch-site`） |

`transport` 缺省按 target 推断：`http(s)` → `mcp-http`，其它 → `local-dir`。配置写错（不是数组、JSON 坏）只打一行 stderr 并当作"没有成员"，**绝不让服务起不来**；transport 与 target 形态矛盾时以 target 为准并告警。

- `local-dir`：直接读同机库文件（`<project>/<memType>/memory.sqlite`，兼容旧的 `project-<name>.sqlite`），微秒级。
- `mcp-http`：任意暴露 `memory_search` 的 MCP 端点——**对端零改动**，Lite 实例和别的记忆体实现都行。

### 5.2 两个工具

**`memory_search_all`** — 跨成员检索。参数 `query`、`topK`（默认 5、上限 50，**按成员计**）、`members`（限定成员 id）。每条命中带 `instance` / `member` / `project` / `memType` / `id` / `score`；任何成员失败进 `errors[]`，**不会伪装成"没有命中"**。结果不与本地引擎逻辑合并——互通语义由调用方决定。

**`federation_members`** — 成员清单：transport、variant、声明能力、库数与记忆总数，用于能力协商（如只取 `capabilities:["emotion"]` 的成员）和排障。新增一类成员 = 在 `src/federation/` 加一个 provider（实现 `FedProvider` 的 `available()` / `describe()` / `search()`，能直读文件再补 `libraries()`）。

### 5.3 总反思 `reflect_all`

扫**全部**成员的活跃记忆 → 每批喂一次 LLM → 去重 / 合并 / 提炼 → 写入 `project=reflect` 总库。参数：`dryRun`、`projects`（只跑指定库）、`maxTotal` / `maxPerLib`（显式抽样预算，默认全量）、`all`（忽略账本全量重扫，贵）。

边界：只扫 `memory` 表的活跃记忆（**不分析对话日志**），源库只读打开，单库失败只影响该库。

### 5.4 长任务与回执

全量总反思不是一次 HTTP 能扛的活。实测（85 个库 / 2395 条活跃记忆 ≈ 200 批，单批 13–45s）一轮 1–1.5 小时；旧实现挂在 300s 的请求超时上，于是**正常工作也会被记成"反思失败"**。

现在的口径：

- `POST /api/reflect/run` 立刻返回 `jobId`，任务在后台跑。
- `GET /api/reflect/job/:id` 轮询进度与结果；内存里最多留 20 个任务，非 running 的先淘汰。
- 超时退化为兜底：默认 **3 小时**（`REFLECT_JOB_TIMEOUT_MS`），不再等于失败判据。
- 脚本要旧的同步行为可以传 `sync: true`（兜底同样 3 小时）；每轮结果追加到 `reflect-history.jsonl`——失败原因写在那里，而不是只弹一句提示。

## 6. 反射与总反思的省钱机制

| 机制 | 落盘 | 作用 |
|---|---|---|
| **增量账本** | `reflect-ledger.sqlite`（`REFLECT_LEDGER_FILE` 可换位置） | 按 `instance+project+id+内容哈希` 记账，默认只跑"没被任何一轮覆盖过"的记录；内容改了哈希变，会重新覆盖 |
| **批次缓存** | `reflect-batch-cache.sqlite`（`REFLECT_CACHE_FILE`） | key = system+user+model，命中直接复用上次的 LLM 输出；TTL 默认 168h（`REFLECT_CACHE_TTL_HOURS`） |
| **失败退避** | `reflect-state-<project>.json` | 自动反思失败后至少隔 1h 再试（`REFLECT_FAIL_BACKOFF_HOURS`）；显式调工具不受限。防"每次桥重启都重试同一批" |
| **LLM 重试** | — | 默认 3 次、单次 180s 超时（`REFLECT_LLM_RETRIES` / `REFLECT_LLM_TIMEOUT_MS`），半开连接按可重试错误处理 |

批大小：每批 12 条（`REFLECT_ALL_BATCH_RECORDS`），每库附带 3 条已反思的近期记录当上下文（`REFLECT_ALL_CONTEXT_ROWS`）。总库位置由 `REFLECT_DIR` 指定（不设则写本实例 `MEMORY_DB_DIR`）。整合另有硬闸：`CONSOLIDATE_MIN_INTERVAL_HOURS` 默认 6h，避免每次启动都重跑一遍两万多 token 的活。

## 7. Web 控制台

三张页面，一个进程（写请求一律本机同源校验：Host / Origin / `sec-fetch-site`，挡 DNS rebinding 与跨站 CSRF）：

| 页面 | 路径 | 用途 |
|---|---|---|
| 分区星图 | `/` | 3D 星图，`scope=local\|federation`、`instance=` 切星域 |
| 记忆总成 | `/aggregate.html` | 全成员库概览、记忆/事实合计、跨库搜索索引、总反思触发与历史 |
| 库管理 | `/manage.html` | 库级操作与配置下发、成员管理 |

### 7.1 星图：连线口径（重点）

- **只画团内线**：同一个库（同一星座）内部的相似边。**跨团、跨星域一条都不发**——每个团内部要有线，外部不连。
- 生成端：不限库规模，每个点只留最近 **2** 条，相似度 **< 0.65** 丢弃；向量先归一化，只维护 best1/best2 不建全量 `{id,sim}` 对象；每 32 行让一次事件循环，不堵 `/api/status`。
- 旧代码有 `<= 400 条` 的硬上限，会让大库**整库无边**——团越大看着越空，那才是"大库没线"的真因，不是元数据也不是前端。关系边（`leads_to` / `sequence` / `context` / `same_subject`）按元数据生成，与相似边是两套。

### 7.2 星图：速度与进度

- **整响应缓存**：签名只看库文件的 `size:mtime`（含 `-wal`；WAL 模式下漏掉 WAL 会把"刚写的"判成没变），命中直接回整段 JSON（ETag + gzip），`?fresh=1` 强刷；最多缓存 4 个视图。
- **增量布局**：旧坐标不动、新点就地插入；只有新点占比 >40% 或没有布局文件才全量重排（`GRAPH_LAYOUT_REUSE=0` 可关）。实测汇总视图 4306 点（2026-10-30），这两条就是"每次打开几十秒 → 直接回包"的来源。
- **布局跑在 worker_threads**：UMAP 的 kNN + SGD 是纯 CPU 同步循环，留在主线程会把 `/api/status` 堵到 1s 都答不上（托盘健康探针据此判"掉线"）。worker 不可用或超时（`GRAPH_WORKER_TIMEOUT`，默认 180s）才退回主线程并提示。
- **真实进度**：`/api/graph/progress` 报当前阶段与百分比（读库 → 关系边 → 语义投影 → 几何 → 编码传输）；同一快照的并发请求共享一次构建。星座口径默认按文件夹（`memType`），`GRAPH_CONSTELLATION=category` 或 `GRAPH_CATEGORY_INSTANCES=airi` 可让指定星域按 `category` 分。

## 8. 部署与门禁

```bash
python scripts/sync_frontend.py           # Full/web → 各端运行时（--check 只校验）
python scripts/deploy_runtime.py          # dist → run/*，缺 fedServer.js 直接拒
node   scripts/check_parity.mjs --strict  # Lite vs Full 源码标记；Anima 仅参考列
python scripts/release.py --check         # 版本一致 + 构建 + 回归，不部署
python scripts/release.py                 # 全流程：上面 + 部署 + 漂移校验
```

- **前端单一源**：`Castalia-Full/web/` 是唯一源，`sync_frontend.py` 把 `public/` + `routes/` 覆盖到各端；`server.mjs` 各端不同**不同步**；`vendor/` 只校验引用完整性、不搬运。额外实例用 `AIRI_VIZ_DIR` 声明，公共仓不写死本机路径。
- **部署**：只搬代码，不搬库、密钥、实例配置；带导入预检、哈希与回滚。目标目录：`run/Castalia`（Lite 主桥）、`run/Castalia-Federation`（本仓）、`run/Castalia-Anima`。
- **版本门**：Lite 与 Full 同版；Anima 只校验自身一致。
- **回归**：`regression_engine.mjs`、`regression_reflection.mjs`、`regression_embed_dim.mjs`、`regression_cjk_recall.mjs`、`regression_context.mjs`、`smoke_test.py`——`scripts/` 下共 18 个 `.mjs`，这几个是能直接当验收跑的。

## 9. 环境变量（按层分组）

**核心引擎**（完整清单见 Lite 仓 README，这里只列跑总线绕不开的）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MEMORY_DB_DIR` | `./memory` | 库根目录；总线进程设了它，本实例也会作为 `local-dir` 成员加入 |
| `CHAR_ID` / `CASTALIA_PROJECT` | `default` | 实例分区 / 默认项目命名空间 |
| `MCP_TOOLS` | `agent` | `agent`(7) / `harness`(12) / `admin`(15，含两个总线工具) / `all` / 逗号列表 |
| `OLLAMA_URL` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` | `:11434` / `yuan-embedding-2.0-zh` / `1024` | 嵌入通道 |
| `EMBED_MODE` | `ollama` | `ollama` / `api` / `none` |
| `REFLECT_LLM_URL` / `_API_KEY` / `_MODEL` | — | LLM2：反思与整合 |
| `TRIAGE_LLM_URL` / `_API_KEY` / `_MODEL` | 回退 `REFLECT_*` | LLM1：入站分拣 + 渐进反思 |

**总线**：`FEDERATION_MEMBERS` / `FEDERATION_DIRS`（成员声明）· `GRAPH_MEMBERS_FILE`（星图注册表）·
`CASTALIA_INSTANCE_ID` / `_LABEL`（本服务在结果里的标识）· `MCP_LOG_TOOLS=1`（把被 profile 跳过的工具打到 stderr）。

**总反思**

| 变量 | 默认 | 说明 |
|---|---|---|
| `REFLECT_DIR` | 本实例 `MEMORY_DB_DIR` | 总库（`project=reflect`）落在哪个实例下 |
| `REFLECT_LEDGER_FILE` | `<memdir>/reflect-ledger.sqlite` | 增量账本 |
| `REFLECT_CACHE_FILE` / `REFLECT_CACHE_TTL_HOURS` | `<memdir>/reflect-batch-cache.sqlite` / `168` | 批次缓存与寿命 |
| `REFLECT_ALL_BATCH_RECORDS` / `REFLECT_ALL_CONTEXT_ROWS` | `12` / `3` | 每批记录数 / 每库附带上文条数 |
| `REFLECT_FAIL_BACKOFF_HOURS` | `1` | 自动反思失败退避 |
| `REFLECT_LLM_RETRIES` / `REFLECT_LLM_TIMEOUT_MS` | `3` / `180000` | 单次调用重试与超时 |
| `REFLECT_JOB_TIMEOUT_MS` | `10800000`（3h） | 后台任务兜底超时 |

**星图**

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEB_PORT` | `3345` | 控制台端口（汇总实例常用 3348） |
| `AGGREGATE_DIRS` | 回退联邦配置 | 「记忆总成」聚合哪几个库 |
| `GRAPH_SCOPE` | 配了联邦则 `federation` | 不传 `scope` 时的默认作用域 |
| `GRAPH_LAYOUT_REUSE` | `1` | 增量布局开关 |
| `GRAPH_WORKER_TIMEOUT` | `180000` | 布局 worker 超时 |
| `GRAPH_CONSTELLATION` / `GRAPH_CATEGORY_INSTANCES` | `memtype` / 空 | 星座分组口径 |
| `VIZ_LAYOUT_DIR` | 用户缓存目录 | 布局文件落盘 |
| `CASTALIA_MCP` / `ANIMA_DIR` / `NODE_BIN` | — | 控制台调哪个引擎 / 哪个变体 / 用哪个 node |

## 10. 故障排查

| 症状 | 原因与处理 |
|---|---|
| 工具列表里没有 `reflect_all` / `memory_search_all` | `MCP_TOOLS` 默认 `agent`。设 `all`（或至少 `admin`），重启客户端 |
| 总线只看到自己 | 成员配置没被解析。看 stderr 有没有 `[federation] 配置不是数组` / `JSON 解析失败`；非法配置会被忽略（设计如此，不让服务起不来） |
| `memory_search_all` 少了一半成员 | 看返回的 `errors[]`——单成员失败记在那里，不会退化成"没命中" |
| 大库星图一条线都没有 | 老版本 bug（`<=400` 早退）。确认 `web/routes/graph.js` 里没有那个上限；仍无线则看相似度是否全 < 0.65 |
| 星图只有团内线、团之间空着 | **设计如此**：跨团 / 跨星域不画线。要看跨库关系统一在「记忆总成」 |
| 构建星图时 `/api/status` 没响应 | 布局退回了主线程。查星图进程 stderr 的 `worker 不可用` / `layout worker 超时` |
| 总反思"超时失败" | 走了旧同步路径。改用 `POST /api/reflect/run` 拿 `jobId` 轮询 |
| 总反思一轮下来没写新东西 | 先看 `dryRun`；再看账本——默认增量，只有新增记录才进批次 |
| 部署被拒 / 版本对不上 | 部署：`dist/fedServer.js` 不存在，先 `npm run build`。版本：以仓库根 `VERSION` 为准，`package.json` 不参与运行时 |

## 11. Credits

- **[Castalia](https://github.com/ehwin/Castalia)** — 引擎核心源（Lite）。本仓核心逐字节来自它，`sync_core.py` 是唯一入口。
- **[Castalia-Anima](https://github.com/ehwin/Castalia-Anima)** — 情感变体，独立引擎线与版本；本仓把情绪字段当普通元数据转发，不做语义假设。
- **Claude Code**（Anthropic）— 封闭记忆类型、MEMORY.md 索引、渐进式会话维护、整合子代理、快照警告（在核心层实现，本仓只消费）。
- **engram** / **memory-os** / **cognitive-memory** — profile 化工具暴露、setup 脚本、本地向量存储与联邦检索的形态参考。

License: MIT，见 `LICENSE`。安装细节与原生模块坑见 [`INSTALL.md`](INSTALL.md)；架构与数据模型见 [`docs/TECHNICAL.md`](docs/TECHNICAL.md)。
