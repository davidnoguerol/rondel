# shared/safety

Pure classification logic for safety checks. Two concerns live here:
(1) tool-use classification — whether a given first-class `rondel_*`
tool call can auto-allow locally or needs to escalate to a human via
the HITL approval service; (2) memory threat scanning —
prompt-injection persistence defense for memory/knowledge content.

## No runtime dependencies

Every file in this directory imports only:

- other files in this directory, and
- `node:path` (only `safe-zones.ts`)

No logger, no config, no hooks, no filesystem, no process.env reads at
module load. All context is passed in by the caller. This keeps the
module cheap to import from per-tool callers in
`apps/daemon/src/tools/` — each tool calls the relevant helper
(`classifyBash`, `isPathInSafeZone`, `scanForSecrets`) inline as part
of its own validation.

If you need to add a runtime dependency, you're in the wrong directory.

## Consumers

The tool-use classifiers (`classifyBash`, `isPathInSafeZone`) run
entirely inside the first-class `rondel_*` MCP tools. Native
Bash/Write/Edit/MultiEdit are hard-disallowed via
`FRAMEWORK_DISALLOWED_TOOLS` and never reach the classifier.

`threat-scan` (which folds in the secret scanner) is also consumed
daemon-side: `memory/memory-service.ts` (write-time warnings),
`knowledge/kb-service.ts` and `config/prompt/bootstrap.ts`
(injection-time masking).

## Module layout

- `types.ts` — `Classification`, `EscalationReason`, `ClassificationResult`
- `classify-bash.ts` — dangerous command / system-write-redirect heuristics (used by `rondel_bash`)
- `safe-zones.ts` — `isPathInSafeZone(path, ctx)` path math (used by `rondel_write_file` / `rondel_edit_file` / `rondel_multi_edit_file`)
- `secret-scanner.ts` — regex scan for leaked credentials (used by filesystem write tools)
- `threat-scan.ts` — `scanMemoryThreats` / `maskThreats`: prompt-injection persistence defense for memory files. Scans at write time (warn, never block) and masks flagged lines at injection time with a visible `[BLOCKED: …]` placeholder (used by `memory/`, `knowledge/`, and `config/` prompt injection masking)
- `index.ts` — barrel

## Tests

Sibling-colocated `*.unit.test.ts` files. All
pure-function assertions, no fs I/O, no process spawning. The
behavioral contract for end-to-end escalation is covered by the
approval-service and per-tool integration tests.
