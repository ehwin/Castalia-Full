# Castalia — Standalone MCP Memory Server for Agent Harnesses

Standard MCP stdio server (23 tools, profile-gated). Local vector memory on SQLite + sqlite-vec — **zero API cost**, works offline once the embedding model is cached.

Forked from the AIRI memory system as an independent, neutral, general-purpose memory component. No personality layer, no vendor lock-in — bring your own LLM, bring your own embedding service (any Ollama-compatible `/api/embed`, 1024-dim).

## Quick Start

### 1. Build + verify

```bash
npm install
npm run build                  # tsc → dist/index.js
python scripts/smoke_test.py   # core CRUD round-trip (no embedding service needed)
```

### 2. Start the embedding service (first load ~30-60s)

```bat
scripts\start-embed.bat
```

Listens on `http://127.0.0.1:11436` (Ollama-compatible `/api/embed`, 1024-dim, model `IEITYuan/Yuan-embedding-2.0-zh`, cached locally — no re-download).
> Any Ollama-compatible embed service outputting **1024-dim** works: point `OLLAMA_URL` + `EMBEDDING_MODEL` at it and skip this step. E.g. with a local Ollama: `OLLAMA_URL=http://127.0.0.1:11434 EMBEDDING_MODEL=qwen3-embedding:0.6b`.

### 3. One-command agent setup (borrowed from engram's `engram setup`)

```bash
python scripts/setup.py claude     # Claude Code → .mcp.json
python scripts/setup.py opencode   # OpenCode    → .opencode.json
python scripts/setup.py cursor     # Cursor      → .cursor/mcp.json
python scripts/setup.py vscode     # VS Code     → .vscode/mcp.json
python scripts/setup.py codex      # Codex       → prints `codex mcp add` command
python scripts/setup.py hermes     # Hermes Agent → prints `hermes config set` command
python scripts/setup.py json       # print standard mcpServers JSON
```

Or wire it manually:

### 4. Connect from your MCP client

```json
{
  "mcpServers": {
    "castalia": {
      "command": "node",
      "args": ["/absolute/path/to/castalia/dist/index.js"],
      "env": {
        "OLLAMA_URL": "http://127.0.0.1:11436",
        "EMBEDDING_MODEL": "yuan-embedding-2.0-zh",
        "MEMORY_DB_PATH": "/absolute/path/to/castalia/memory.sqlite",
        "CHAR_ID": "default"
      }
    }
  }
}
```

## Hermes Agent

[Hermes Agent](https://hermes-agent.nousresearch.com) has a native MCP client: any server under `mcp_servers` in `config.yaml` is discovered at startup, and its tools appear with the `mcp_castalia_*` prefix (e.g. `mcp_castalia_memory_search`, `mcp_castalia_memory_save`).

### Install

```bash
python scripts/setup.py hermes
```

prints a ready-made `hermes mcp add` command — run it (answer `Y` to enable all tools), then **start a new session** (MCP servers are discovered at startup; no hot reload).

Or add it manually with the built-in CLI — note `--args` **must be the last option**:

```bash
hermes mcp add castalia \
  --command "C:\Program Files\nodejs\node.exe" \
  --env "MEMORY_DB_PATH=C:\path\to\castalia\memory.sqlite" \
        "CHAR_ID=hermes" \
        "EMBEDDING_MODEL=qwen3-embedding:0.6b" \
        "OLLAMA_URL=http://127.0.0.1:11434" \
  --args "C:\path\to\castalia\dist\index.js"
```

> ⚠️ **Do NOT use `hermes config set mcp_servers '{...}'`** — it stores the JSON as a *string*, and the MCP client ignores non-dict values, so the server silently never loads. Always use `hermes mcp add` (writes a real dict under `mcp_servers`).
>
> **Windows note**: if `node` is not on the system `PATH` (git-bash often appends its own paths), use the absolute path to `node.exe` as `command`, e.g. `"C:\Program Files\nodejs\node.exe"`. Hermes passes only a filtered baseline environment to MCP subprocesses, so it won't inherit your shell's ad-hoc PATH additions.

### Verify

```bash
hermes mcp list      # should show castalia with status ✓ enabled
hermes mcp test castalia   # connects, expects "Tools discovered: 23"
```

After starting a new session, ask Hermes "what memory tools do you have?" or look for `mcp_castalia_*` in the tool list. Then:

```
"记住:我的项目叫 Castalia"
→ mcp_castalia_memory_save
"我之前说过什么?"
→ mcp_castalia_memory_search
```

### Recommended env for Hermes

| Var | Value | Why |
|-----|-------|-----|
| `MCP_TOOLS` | `harness` (default `agent`) | agent = read-only (5 tools); `harness` adds writes; `admin` adds management. See Tools section |
| `CHAR_ID` | e.g. `hermes` | separate partition per agent/role, share one DB safely |
| `EMBEDDING_MODEL` | your 1024-dim model | e.g. `qwen3-embedding:0.6b` on a local Ollama |

## Unified Envelope (v1.1)

All read tools return a standard envelope (aligned with Mem0 / Hermes conventions):

```json
{ "ok": true, "op": "search", "query": "...", "count": 3,
  "results": [{ "id": "...", "text": "short snippet…", "truncated": true,
                "kind": "episode", "score": 0.81, "createdAt": "..." }],
  "hint": "用 memory_get(id) 取完整内容" }
```

- Every result carries an `id`; call `memory_get(id)` to expand full text
- `text` is truncated at 200 chars with `truncated: true`
- Failures: `{ "ok": false, "error": { "code": "NOT_FOUND", "message": "..." } }`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Embedding service address (bundled service runs on 11436) |
| `EMBEDDING_MODEL` | `yuan-embedding-2.0-zh` | Embedding model name; must output **1024-dim** |
| `MEMORY_DB_PATH` | `./memory.sqlite` | SQLite database path (auto-created on first run) |
| `CHAR_ID` | `default` | Instance/partition ID. Multiple instances can share one DB without cross-talk |
| `CASTALIA_PROJECT` | `default` | **v1.5** Default project namespace. Memories are scoped per project; every tool accepts an optional `project` arg to switch |
| `MCP_SERVER_NAME` | `castalia` | MCP server display name |
| `SEARCH_MIN_SCORE` | `0.15` | Min score threshold for vector search results |
| `WEIGHT_CONSISTENCY` | `0.65` | Scoring: semantic/tag consistency weight |
| `WEIGHT_TIME` | `0.35` | Scoring: time-decay weight |
| `HALF_LIFE_HOURS` | `720` | Time-decay half-life (hours, default 30 days) |
| `REFLECT_LLM_URL` | `https://api.deepseek.com/v1` | OpenAI-compatible LLM endpoint for reflection |
| `REFLECT_LLM_API_KEY` | *(unset)* | Reflection LLM key; reflection skipped when unset |
| `REFLECT_LLM_MODEL` | `deepseek-chat` | Reflection LLM model |
| `REFLECT_INTERVAL_HOURS` | `0` | Auto-reflect interval in hours; `0` = manual only |
| `MCP_TOOLS` | `agent` | Tool visibility: `agent` (read-only, default) / `harness` / `admin` / `all` / comma list |

## Tools (24, profile-gated)

Tool visibility is controlled by `MCP_TOOLS` (default `agent` — read-only for the main agent):

| Profile | Tools | Purpose |
|---------|-------|---------|
| **agent** (5) | `memory_search` / `fact_search` / `memory_get` / `memory_recent` / `memory_graph` | Read-only recall for the LLM |
| **harness** (10) | `memory_save` / `update` / `delete` / `memory_log` / `auto_process` / `conversation_save` / `digest_run` / `reflect_auto` / `reflect_deep` / `reflect_batch_embed` | Writes + pipeline, called by harness/system |
| **admin** (9) | `memory_list` / `stats_get` / `recent_conversations` / `daily_summary_data` / `reflect_analyze` / `reflect_apply` / `memory_context` / `context_get` / `project_list` | Management, Web Console |

`MCP_TOOLS=all` registers everything (backward compatible).

### Project-scoped memories (v1.5)

Each memory/fact belongs to a **project namespace** (column `project`, default `'default'`). Every read/write tool accepts an optional `project` argument; omit it to use the `CASTALIA_PROJECT` env (or `'default'`).

```json
{ "text": "前端重构计划", "project": "alpha" }        // write into alpha
{ "query": "重构", "project": "alpha" }              // search only alpha
```

- **Isolation**: dedup (exact + vector) is per-project — the same text can exist in different projects. Vector KNN is filtered by project, so project A queries never see project B memories.
- **Discover**: `project_list` shows all namespaces with counts.
- **Backward compatible**: existing memories stay in `'default'`; calls without `project` behave exactly as before.

**Search**
- `memory_search` — tag-first, vector KNN fallback, neutral scoring
- `fact_search` — semantic search over fact triples (subject-predicate-object)

**Memory CRUD**
- `memory_save` — store a memory (`skipEmbed` to skip vectorization)
- `memory_get` — expand one memory by ID (full text + metadata)
- `memory_update` / `memory_delete` — update fields / soft-delete
- `memory_list` / `memory_recent` / `memory_graph` — enumerate / recent important / relation graph

**Cognitive logging** (agent explicitly teaches the memory)
- `memory_log_decision` — log a decision + rationale (category=decision)
- `memory_log_pattern` — log a discovered pattern/insight (category=knowledge, tag=pattern)
- `memory_log_mistake` — log a lesson learned (category=mistake, tier=critical, cleanup-protected)

**Conversation automation** (call per dialog turn)
- `auto_process` — save the turn + trigger digest
- `conversation_save` — save raw turn only
- `digest_run` — run cleanup cycle (expired temporaries, critical restore)
- `daily_summary_data` — conversations + processed data for the last N hours

**Context / stats**
- `memory_context` — **injection-ready context bundle**: recent + task-related (optional query) + cognitive logs + facts, with ground-truth instructions (borrowed from engram's `mem_context` / memory-os `fabric_brief`)
- `context_get` — lightweight recent memories + stats
- `stats_get` — memory statistics

**Reflection** (LLM-driven, bundled in-server)
- `reflect_analyze` — unanalyzed conversations + reflection system prompt
- `reflect_apply` — apply reflection actions (merge/split/extract/reclassify/delete/relate)
- `reflect_auto` — **one-shot auto-reflection**: unanalyzed conversations → configured LLM → apply (needs `REFLECT_LLM_API_KEY`)
- `reflect_deep` — **deep calibration**: all memories → dedup/profile/graph → apply (needs `REFLECT_LLM_API_KEY`)
- `reflect_batch_embed` — batch-vectorize pending memories

## Web Console (3D main + admin side)

Bundled web UI: fullscreen 3D memory graph as the main view, admin drawer (reflection, embedding/LLM config, memory management, logs) as the side panel.

```bat
cd web
npm install
node server.mjs        # → http://127.0.0.1:3345
```

- Config saved to `config.json` (embedding source + reflection LLM), applied on MCP server restart
- Embedding source dropdown: **Ollama** (local URL + model) or **API** (cloud key, OpenAI-compatible `/embeddings`, e.g. SiliconFlow)
- Reflection runs via a built-in MCP client calling `reflect_auto` / `reflect_deep`

## Tests

```bash
python scripts/smoke_test.py   # core CRUD round-trip (no embedding service needed)
python scripts/vec_test.py     # embed + vector semantic search (needs embed service on 11436)
```

## Storage

- Schema auto-created on first run: memory / edges / categories / facts / embedding_cache / vec_memory / vec_facts
- Fixed **1024-dim** vectors; swap embedding models only if same dim (or rebuild the DB)
- WAL mode; auto-checkpoint every 30min; expired temporaries cleaned every 30min; consolidation every 24h
- The DB file is fully portable (copy while stopped)

## Credits & Upstream

Independent evolution of a memory system; storage-layer design inspired by / derived from:

- **cognitive-memory** (Apache-2.0) — SQLite + sqlite-vec local vector storage schema & vector KNN retrieval (concept-level; implementation rewritten)
- **AIRI Alaya scoring design** — emotional-weight / time-decay scoring ideas (design reference only)
- **SynaBun** — hierarchical categories & relevance weighting ideas (design reference only)

License: MIT, see `LICENSE`. Upstream acknowledgements retained above.

## Troubleshooting

- Embedding service down → `memory_save` reports embed failure; check `curl http://127.0.0.1:11436/health`
- Empty search results → lower `SEARCH_MIN_SCORE`, or verify `CHAR_ID` matches the writer
- Port conflict → change port in `scripts\start-embed.bat` + `OLLAMA_URL`
- Hermes: tools not appearing → restart Hermes; verify `hermes config get mcp_servers`; on Windows ensure `command` is an absolute path to `node.exe` (Hermes filters the subprocess environment)
