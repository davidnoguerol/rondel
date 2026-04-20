# Phase 3 Kickoff — Activity Dashboard (Web UI Expansion)

## Your job in this chat

Design the **web dashboard expansion** for Rondel, to spec-level quality, following our modularity contract. **Do not implement it.** Produce a design document I can review, iterate on, and then hand to a future implementation chat.

---

## Context

### Rondel, in one paragraph
Rondel is a multi-agent orchestration framework built on the Claude CLI. The long-term vision is an **agentic self-evolving harness** that manages real operations. Rondel already has a basic web UI at `apps/web/` (Next.js, Tailwind v4, shadcn/ui, assistant-ui) for per-agent chat and basic dashboard views — this item expands it to expose the full Phase 1–3 capability set visually.

### What Phase 3 is
Phase 3 adds self-evolution: per-agent experiments, analyst + theta-wave, and **the activity dashboard that surfaces everything**. After Phase 3, the user can see fleet state, task board, goal tree, experiment history, and recent activity at a glance.

### This item — Activity dashboard
New surfaces on the existing `apps/web/`: (1) **Fleet grid** — all agents with heartbeat status, current task, last seen; (2) **Task board** — Trello-style Kanban per org, with DAG visualization; (3) **Goal tree** — north-star → daily focus → per-agent goals, with staleness indicators; (4) **Experiment history** — per-agent cycles, recent experiments, keep/discard trajectory; (5) **Activity feed** — live ledger stream per agent / per org. All data is read-only from the daemon's HTTP bridge + SSE streams; the dashboard is a client. No data mutation beyond chat (which already exists).

### Dependencies
All prior phases are assumed built. This item consumes everything they produce.

### Files to read if you need depth
- `CLAUDE.md` (especially the `apps/web` conventions section)
- `ARCHITECTURE.md` (web package boundary)
- All prior kickoff briefs — the dashboard surfaces what they define

---

## Step 1 — Parallel research (dispatch two subagents)

### Subagent A — OpenClaw
**Path**: `/Users/david/Code/openclaw`
**Focus**: does OpenClaw have a web UI / dashboard? If yes, what surfaces (agents, tasks, logs, metrics)? Architecture (SPA / SSR / desktop app)? Real-time (SSE / WebSocket / polling)? Any patterns Rondel should adopt or avoid? Auth model for the dashboard? Loopback-only vs networked?

### Subagent B — CortexOS
**Path**: `/Users/david/Code/cortextos`
**Focus**: map the dashboard. Key paths: `dashboard/` (Next.js 14 web app), `dashboard/AGENTS.md` (live agent roster), any SSE / Chokidar / Supabase-realtime logic, task board, experiments view, activity feed, approval inline-action rendering. Cover: information architecture, data-fetching strategy, component structure, real-time mechanism, auth / security model, what's rendered server-side vs client-side.

### Shared output schema

```
## 1. Concept presence
Yes / Partial / No — 1-sentence summary

## 2. Surfaces
- Pages / views available
- Information hierarchy per page
- Empty states / loading states

## 3. Tech stack
- Framework (Next.js, Vite, custom)
- State management
- Styling
- Real-time layer

## 4. Data flow
- How data reaches the page (SSR fetch, client-side fetch, SSE, WebSocket)
- Schemas at the boundary
- Cache / revalidation strategy

## 5. Interactivity
- What the user can do (read, mutate, chat)
- Form / action pattern

## 6. Auth + security
- Who can access
- Loopback-only vs networked
- Multi-user considerations

## 7. Strengths worth adopting for Rondel
## 8. Anti-patterns / not to copy
## 9. Key file paths (absolute)
```

---

## Step 2 — Rondel codebase research

1. **Existing apps/web structure** — `apps/web/app/` routes, `apps/web/components/`, `apps/web/lib/bridge/` (HTTP + SSE clients), `apps/web/components/assistant-ui/` (chat surface). Fully understand what's there.
2. **Bridge schemas + types** — `apps/web/lib/bridge/schemas.ts` — canonical source of boundary types. New schemas go here.
3. **Streams** — `apps/daemon/src/streams/`. What's already exposed (ledger, agent-state)? Add: task stream, goal stream, heartbeat stream, experiment stream.
4. **Bridge endpoints** — `apps/daemon/src/bridge/bridge.ts` — existing GET routes. What's new needed.
5. **shadcn/ui primitives** — `apps/web/components/ui/`. Already-owned components (edit freely). What we'd need to add via the shadcn CLI (no custom primitives invented).
6. **Tailwind v4 theme** — `apps/web/styles/globals.css`. CSS-first tokens, dark-default, no tailwind.config.ts.
7. **Routing conventions** — App Router groups like `(dashboard)/agents/[name]/...`. Add `(dashboard)/tasks/`, `(dashboard)/goals/`, `(dashboard)/experiments/`.
8. **Loopback gate** — `apps/web/middleware.ts`. The web UI is loopback-only; new routes inherit this.
9. **Hotkeys + command palette** — `apps/web/components/hotkey-provider.tsx`, `command-palette.tsx`. New navigation entries.
10. **Assistant-UI boundary** — `apps/web/components/chat/rondel-runtime.tsx`. Do not talk to the bridge from inside Thread; stay within the pattern.

---

## Step 3 — Synthesize the design

1. **Scope** — Phase 3 dashboard: fleet grid, task board, goal tree, experiment history, activity feed. Defer: admin mutations beyond chat, multi-tab / persistent filters, mobile layout beyond responsive-graceful.
2. **Information architecture** — route map, page layouts, navigation (sidebar, topbar, command palette entries).
3. **Fleet grid** — data source, row schema, status colors, click-to-drill-in.
4. **Task board** — Kanban columns (pending/in_progress/blocked/completed), DAG visualization approach (inline hints vs dedicated graph), drag-drop behavior (client-only or mutation via API).
5. **Goal tree** — render style (tree, cards, breadcrumb), staleness indicator, inline edit (orchestrator-authored only — probably read-only in dashboard for Phase 3).
6. **Experiment history** — per-agent view, per-cycle view, timeline of results.tsv, learnings.md rendered as prose.
7. **Activity feed** — live ledger stream, per-agent + per-org filters, event-kind filters.
8. **Schema additions** — new Zod schemas in `apps/web/lib/bridge/schemas.ts` for tasks, goals, experiments, heartbeats.
9. **Stream source integration** — client-side React hooks (`use-event-stream` pattern).
10. **Empty states** — designed copy + visuals for each surface on a fresh install (no agents, no tasks, no experiments yet).
11. **Loading states** — skeleton patterns; avoid flashing.
12. **Performance budget** — initial-bundle cap, page-load target, SSE reconnection strategy.
13. **Accessibility** — keyboard navigation, focus states, aria labels.
14. **Testing strategy** — component (Storybook or inline), bridge-schema roundtrip, playwright for happy paths.
15. **Migration** — purely additive routes; existing routes untouched.
16. **Open questions** — Does the dashboard support mutations beyond chat (create task, set goal)? Or is it strictly read-only for Phase 3? Multi-org navigation pattern. Whether to add a global "live" indicator (SSE connected) somewhere visible.

---

## Deliverable

Save to `docs/phase-3/03-activity-dashboard-design.md`. Include mockup-level descriptions per surface (not actual designs — pseudo-wireframes in prose are fine). Editable.

---

## Guardrails for this chat

- **Do not implement.** Design only.
- **Follow apps/web conventions** from CLAUDE.md strictly — shadcn primitives owned in-repo, Tailwind v4 CSS-first, no tailwind.config.ts, assistant-ui stays behind the runtime adapter, bridge schemas are the canonical type source.
- **Do not over-engineer.** Read-only dashboard for Phase 3. No optimistic UI, no complex client state.
- **Preserve what's there** — the existing chat surface stays; new surfaces slot alongside.
- **Loopback-only** — no thinking about networked deployment.
- **Minimize this chat's context** — rely on subagents for external research.
