# ai-memory — Standalone MCP Memory Server for Agent Harnesses

Standard MCP stdio server (19 tools). Local vector memory on SQLite + sqlite-vec — **zero API cost**, works offline once the embedding model is cached.

Forked from the AIRI memory system as an independent, neutral, general-purpose memory component. No personality layer, no vendor lock-in — bring your own LLM, bring your own embedding service (any Ollama-compatible `/api/embed`, 1024-dim).

## Quick Start

### 1. Start the embedding service (first load ~30-60s)

```bat
scripts\start-embed.bat
```

Listens on `http://127.0.0.1:11436` (Ollama-compatible `/api/embed`, 1024-dim, model `IEITYuan/Yuan-embedding-2.0-zh`, cached locally — no re-download).
> Any Ollama-compatible embed service outputting **1024-dim** works: point `OLLAMA_URL` + `EMBEDDING_MODEL` at it and skip this step.

### 2. Connect from your MCP client

```json
{
  "mcpServers": {
    "ai-memory": {
      "command": "node",
      "args": ["D:\\AI\\ai-memory\\dist\\index.js"],
      "env": {
        "OLLAMA_URL": "http://127.0.0.1:11436",
        "EMBEDDING_MODEL": "yuan-embedding-2.0-zh",
        "MEMORY_DB_PATH": "D:\\AI\\ai-memory\\memory.sqlite",
        "CHAR_ID": "default"
      }
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Embedding service address (bundled service runs on 11436) |
| `EMBEDDING_MODEL` | `yuan-embedding-2.0-zh` | Embedding model name; must output **1024-dim** |
| `MEMORY_DB_PATH` | `./memory.sqlite` | SQLite database path (auto-created on first run) |
| `CHAR_ID` | `default` | Instance/partition ID. Multiple instances can share one DB without cross-talk |
| `MCP_SERVER_NAME` | `ai-memory` | MCP server display name |
| `SEARCH_MIN_SCORE` | `0.15` | Min score threshold for vector search results |
| `WEIGHT_CONSISTENCY` | `0.60` | Scoring: semantic/tag consistency weight |
| `WEIGHT_EMOTION` | `0.10` | Scoring: stored emotional-impact weight (weak) |
| `WEIGHT_TIME` | `0.30` | Scoring: time-decay weight |
| `HALF_LIFE_HOURS` | `720` | Time-decay half-life (hours, default 30 days) |
| `REFLECT_LLM_URL` | `https://api.deepseek.com/v1` | OpenAI-compatible LLM endpoint for reflection |
| `REFLECT_LLM_API_KEY` | *(unset)* | Reflection LLM key; reflection skipped when unset |
| `REFLECT_LLM_MODEL` | `deepseek-chat` | Reflection LLM model |
| `REFLECT_INTERVAL_HOURS` | `0` | Auto-reflect interval in hours; `0` = manual only |

## Tools (24)

**Search**
- `memory_search` — tag-first, vector KNN fallback, neutral scoring
- `fact_search` — semantic search over fact triples (subject-predicate-object)

**Memory CRUD**
- `memory_save` — store a memory (`skipEmbed` to skip vectorization)
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
- `context_get` — recent memories + stats for prompt injection
- `stats_get` — memory statistics
- `mood_journal` — emotional history (uses stored `emotionalImpact`)

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

License: Apache-2.0, see `LICENSE`.

## Troubleshooting

- Embedding service down → `memory_save` reports embed failure; check `curl http://127.0.0.1:11436/health`
- Empty search results → lower `SEARCH_MIN_SCORE`, or verify `CHAR_ID` matches the writer
- Port conflict → change port in `scripts\start-embed.bat` + `OLLAMA_URL`
