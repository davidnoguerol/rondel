# Phase 2 Kickoff — Semantic Knowledge Base

## Your job in this chat

Design the **semantic knowledge base (KB)** for Rondel, to spec-level quality, following our modularity contract. **Do not implement it.** Produce a design document I can review, iterate on, and then hand to a future implementation chat. You will: (1) load context, (2) run two parallel research subagents to study OpenClaw and CortexOS, (3) study Rondel's patterns, (4) synthesize a clean design proposal.

---

## Context

### Rondel, in one paragraph
Rondel is a multi-agent orchestration framework built on the Claude CLI. It bridges messaging channels to Claude processes with per-conversation isolation, durable scheduling, memory, approvals, and inter-agent messaging — all via first-class MCP tools. Today it is reactive. The long-term vision is an **agentic self-evolving harness** that manages real operations.

### What Phase 2 is
Phase 2 adds the intelligence substrate: three layers of memory (daily log, long-term learnings, **semantic KB**) and a self-improving guardrails loop. Full plan in [`docs/PHASE-1-PLAN.md`](../PHASE-1-PLAN.md) for Phase 1 context, and the gap analysis at [`docs/GAP-ANALYSIS-CORTEXTOS.md`](../GAP-ANALYSIS-CORTEXTOS.md) sections 3.

### This item — Semantic KB
Agents currently can't ask "has anyone in the org researched this topic before?" They just redo the work. The KB fixes that. Per-org collection (shared across agents in the org), per-agent private collection (my research), per-agent memory-reindex collection (auto-reindexed from MEMORY.md + daily memory on every heartbeat). Agents **must** `rondel_kb_query` before starting substantial research and **must** `rondel_kb_ingest` after producing a substantial output. Institutional memory accumulates. CortexOS uses ChromaDB + Python subprocess via `src/bus/knowledge-base.ts` → `knowledge-base/scripts/mmrag.py`. Implementation choices for Rondel (local ChromaDB, local LanceDB, Anthropic-embedding + SQLite-vec, hosted Pinecone/Weaviate) are part of this design.

### Dependencies
Phase 2 item 1 (daily memory) should be assumed built — the KB auto-reindexes daily-memory files.

### Files to read if you need depth
- `CLAUDE.md` — coding standards
- `docs/GAP-ANALYSIS-CORTEXTOS.md` — section 3
- `docs/phase-2/01-daily-memory-kickoff.md` — what KB consumes

---

## Step 1 — Parallel research (dispatch two subagents)

### Subagent A — OpenClaw
**Path**: `/Users/david/Code/openclaw`
**Focus**: does OpenClaw have any RAG / vector / semantic search / knowledge base? Any cross-session retrieval beyond flat memory? Any mechanism for agents to share research across instances? If no explicit KB, any adjacent patterns (documentation mounts, file-system search, subagent-delegated search)?

### Subagent B — CortexOS
**Path**: `/Users/david/Code/cortextos`
**Focus**: map the full KB. Key files: `src/bus/knowledge-base.ts` (Node/TS wrapper), `knowledge-base/scripts/mmrag.py` (Python RAG engine), `templates/agent/.claude/skills/knowledge-base/SKILL.md` (the discipline), `AGENTS.md` step 7 (`recall-facts`) and step 9 (`kb-query` before tasks), heartbeat re-ingestion logic (Layer 3 auto-index of memory files). Cover: collection taxonomy (`shared-{org}`, `agent-{name}`, `memory-{agent}`), embedding model used, storage backend (ChromaDB local? Supabase in multi-machine mode?), chunking strategy, result format (content + source + score + metadata), how `recall-facts --days 3` works, how `kb-ingest` discovers what to index, the performance characteristics (query latency, index size, re-index frequency).

### Shared output schema

```
## 1. Concept presence
Yes / Partial / No — 1-sentence summary

## 2. Collection taxonomy
- What collections exist
- Scoping (org, agent, private, shared)
- Who reads / writes each

## 3. Storage + embedding
- Vector store (ChromaDB, LanceDB, Pinecone, custom)
- Embedding model (Gemini, OpenAI, sentence-transformers, other)
- Chunking strategy (size, overlap, boundary rules)
- Metadata schema

## 4. Runtime integration
- Is this a separate process (Python subprocess, gRPC, HTTP)?
- Or in-process library?
- Startup cost / latency

## 5. Ingest surface
- When ingestion fires (explicit call, auto on heartbeat, watcher)
- What gets ingested (files, prose, JSON, memory)
- Dedup / re-index strategy

## 6. Query surface
- Query parameters (text, collection, top_k, filters)
- Result format
- How results reach the agent (tool response, prompt injection)

## 7. Discipline / contract
- When agents MUST query before acting
- When agents MUST ingest after acting
- Where encoded (skill, guardrails, system prompt)

## 8. Multi-machine / distributed story
- Single-node only? Networked? Synced?

## 9. Integration points
- Memory (auto-reindex daily + MEMORY.md)
- Tasks (result summaries feed KB)
- Experiments (learnings feed KB)
- Morning/evening reviews

## 10. Strengths worth adopting for Rondel
## 11. Anti-patterns / not to copy
## 12. Key file paths (absolute)
```

---

## Step 2 — Rondel codebase research

1. **Runtime deps** — `apps/daemon/package.json`. Do we want to add Python as a dependency (Rondel is Node-only today)? JS-native options (local `@lancedb/lancedb`, `chromadb` client, `sqlite-vec`)? Study what exists.
2. **Existing memory tools** — `rondel_memory_read` / `rondel_memory_save`. KB is adjacent but distinct.
3. **MCP tool pattern** — `apps/daemon/src/bridge/mcp-server.ts` — how tools get registered. New `rondel_kb_*` tools land here.
4. **Bridge HTTP** — `apps/daemon/src/bridge/bridge.ts`. Does the KB live behind the bridge (queried over HTTP) or via the same MCP tool layer?
5. **Org / agent isolation** — how the bridge enforces org boundaries; KB must respect this (cross-org queries blocked).
6. **Heartbeat integration** — the Phase 1 heartbeat skill; the Phase 2 daily-memory design. KB re-ingest of memory fires here.
7. **State directory conventions** — where KB storage lives under `state/`. What's committed vs ephemeral.
8. **Streams** — do we want a KB activity stream (last 10 ingests, last 10 queries) for the web UI?
9. **User-space vs framework-space** — KB is framework-space (the index is internal; users don't hand-edit it). But collections reflect user-owned content (MEMORY.md, deliverables).

---

## Step 3 — Synthesize the design

1. **Scope** — Phase 2 KB: per-org + per-agent + per-agent-memory collections; query + ingest tools; heartbeat re-ingest. Defer: multi-machine sync, cross-org search, hybrid BM25, query-understanding LLM.
2. **Backend decision** — recommend one (with 2–3 alternatives analyzed). Criteria: Node-native preferred, local-first, low operational cost, good Claude + Anthropic-embeddings story. Candidates: LanceDB (embedded, columnar), ChromaDB-js (embedded / server), SQLite + `sqlite-vec`, a vendor (Pinecone, Weaviate). Recommend.
3. **Embedding decision** — recommend one (with alternatives). Anthropic doesn't ship embeddings; options: Voyage AI (Anthropic-endorsed), OpenAI `text-embedding-3-small`, local (sentence-transformers via HF inference endpoint or Ollama). Recommend with cost + quality analysis.
4. **Module layout** — file tree under `apps/daemon/src/knowledge-base/`: `kb-store.ts`, `kb-service.ts`, `kb-embedder.ts` (pluggable), `kb-chunker.ts` (pluggable), barrel.
5. **Collection schema** — names (`org:{org}:shared`, `agent:{org}:{name}:private`, `agent:{org}:{name}:memory`), metadata fields per doc (source_path, doc_type, ingested_at, agent, org, content_hash for dedup).
6. **Chunking policy** — size, overlap, boundary rules (paragraph / heading / line). Decision per doc type (Markdown memory files chunked differently from prose outputs).
7. **MCP tool surface** — `rondel_kb_query`, `rondel_kb_ingest`, `rondel_kb_list_collections`, `rondel_kb_delete` (admin-only). Schemas, privilege (which collections can which agents read/write).
8. **Heartbeat re-ingest** — how memory files get auto-indexed on each heartbeat. Dedup via content_hash.
9. **Query-before / ingest-after discipline** — skill prose for `rondel-knowledge-base/SKILL.md`: rules, examples, when to skip.
10. **Bridge endpoints** — `GET /kb/:org/collections`, read-only status; query goes through MCP, not HTTP (avoids another auth surface).
11. **Isolation enforcement** — how cross-org reads are blocked at the tool layer.
12. **Retention + index maintenance** — compaction, vacuum, re-embed-on-model-change, failure recovery.
13. **Testing strategy** — unit (chunker, dedup), integration (real embedding call with a test model, query roundtrip), end-to-end (ingest 10 docs, query, get expected top result).
14. **Cost model** — rough embedding cost per agent-day of activity. Is this bounded?
15. **Migration** — new state directory; fresh install works; existing installs get empty collections.
16. **Open questions** — local-only vs hosted, embedding model choice, whether to support non-text content in Phase 2 (images? PDFs?), whether queries should be Claude-rewritten before embedding (HyDE-style).

---

## Deliverable

Save to `docs/phase-2/02-semantic-kb-design.md`. Editable.

---

## Guardrails for this chat

- **Do not implement.** Design only.
- **Follow Rondel patterns** (CLAUDE.md). Storage backend should be swappable behind an interface.
- **Do not over-engineer.** No multi-machine, no hybrid search, no re-ranker for Phase 2.
- **Flag every trade-off** — especially backend + embedding choices.
- **Preserve what Rondel has** — memory tools stay; KB is new and adjacent.
- **Minimize this chat's context** — rely on subagents.
