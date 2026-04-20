# Rondel Test Strategy

Reference document for writing, organising, and growing the Rondel test suite. Audience: contributors adding tests.

If you're adding tests and something in this document contradicts what's actually in the suite, the suite wins — update this document to match.

---

## 1. Philosophy

- **Evidence beats assumption.** Every load-bearing invariant is worth a test. Production bugs that a test would have caught are failures of the suite, not the implementation.
- **Test behaviour, not implementation.** A refactor that keeps the public contract should never break a test. If it does, the test was asserting the wrong thing.
- **Volume unit > integration > e2e. Confidence integration > unit.** Write lots of fast unit tests for pure functions; write fewer integration tests for state that actually touches disk; reserve e2e for the narrow cases where nothing else works.
- **Tests are documentation.** A new contributor should be able to read your `describe`/`it` names and know what the module is supposed to do. Unclear names are a bug.
- **Design for extractable purity.** If a piece of logic is hard to test without mocks, the problem is usually the code's shape. Extract a pure function (see [apps/daemon/src/bridge/org-isolation.ts](../apps/daemon/src/bridge/org-isolation.ts) for the template — it used to be a private method on the `Bridge` class).

---

## 2. Framework & setup

**Vitest.** Chosen because it runs native ESM against Node 22's `module: Node16` resolution without any extra toolchain — no Babel, no ts-node, no `--experimental-*` flags. First-class `vi.mock` / `vi.useFakeTimers` for Tier 2+. Watch-mode DX that `node:test` can't match.

Installation is already done. If you're starting from scratch:

```bash
pnpm --filter @rondel/daemon add -D vitest
```

### tsconfig

Test files live inside `apps/daemon/src/` but are excluded from `tsc --build` via [apps/daemon/tsconfig.json](../apps/daemon/tsconfig.json):

```json
"exclude": ["node_modules", "dist", "src/**/*.test.ts", "tests"]
```

Vitest still typechecks them at run time via its own transform, so there's no gap.

### Vitest config

[apps/daemon/vitest.config.ts](../apps/daemon/vitest.config.ts) sets the default include globs for both the daemon's `src/` and the shared `tests/` tree at the repo root, keeps `clearMocks`/`restoreMocks` enabled, and otherwise uses defaults. Integration tests reach `tests/helpers/` via the relative path `../../tests/helpers/...` (vitest's resolver walks up from the daemon package to the workspace root).

### Scripts

All scripts run via pnpm from anywhere in the workspace:

| Script | What it runs | When to use |
|---|---|---|
| `pnpm test` | Full daemon suite (unit + integration) — root shortcut | Default pre-PR gate |
| `pnpm --filter @rondel/daemon test:unit` | Every `*.unit.test.ts` (substring filter) | Fast-feedback during development |
| `pnpm --filter @rondel/daemon test:integration` | Every `*.integration.test.ts` | Before committing fs-touching changes |
| `pnpm --filter @rondel/daemon test:watch` | Unit suite in watch mode | Active development on pure functions |
| `pnpm --filter @rondel/daemon test:all` | Every test file vitest sees | Reserved for when contract/e2e buckets exist |
| `pnpm --filter @rondel/web test` | Web UI fixture schema tests | When touching `apps/web/lib/bridge/` |

> **Why substring filters?** Vitest 4 positional args are filename filters, not globs. `vitest run unit.test` matches every file whose path contains `unit.test`. This is a deliberate idiom — shell-expanded globs are brittle across platforms.

---

## 3. Directory conventions

**Hybrid layout: colocated unit + integration under the daemon package, shared helpers at the workspace root.**

```
apps/daemon/src/shared/types/sessions.ts
apps/daemon/src/shared/types/sessions.unit.test.ts          ← colocated unit test
apps/daemon/src/messaging/inbox.ts
apps/daemon/src/messaging/inbox.integration.test.ts         ← colocated integration test

tests/                     ← at the REPO ROOT (not under apps/daemon)
  helpers/           ← shared test utilities (tmp, logger, hooks, fixtures)
  contract/          ← Tier 2+: adapter contract batteries
  e2e/               ← Tier 3: mocked Claude CLI end-to-end
```

`tests/` sits at the repo root, not inside `apps/daemon/`, so the same helpers can be reused by future packages under `apps/` without duplicating them. Integration tests inside `apps/daemon/src/...` import helpers via `../../tests/helpers/tmp.js` — vitest's resolver handles the walk into the workspace root.

### Rules

- **Colocate unit + integration tests with their source file.** A test that lives next to its source travels with it through refactors, git history, grep, and file moves. A parallel tree would duplicate `apps/daemon/src/` and drift.
- **Top-level `tests/helpers/` only for things used by ≥2 test files.** If only one test needs a fake, inline it in that test file.
- **`tests/contract/` and `tests/e2e/` are pre-created empty.** They exist so Tier 2/3 doesn't trigger another reorg. Don't delete them.
- **Never import from `dist/`.** Always import the `.ts` source with `.js` suffix (`import { ... } from "./sessions.js"`). Node16 resolution requires the suffix; vitest handles the TS transform.

---

## 4. Taxonomy

Four categories, discriminated by filename suffix so runners can target each independently.

| Category | Suffix | Location | Allowed I/O | Status |
|---|---|---|---|---|
| **Unit** | `*.unit.test.ts` | colocated | **none** — pure functions, in-memory only | Tier 1 |
| **Integration** | `*.integration.test.ts` | colocated | real fs inside `os.tmpdir()` only | Tier 1 |
| **Contract** | `*.contract.test.ts` | `tests/contract/` | reserved | Tier 2+ |
| **E2E** | `*.e2e.test.ts` | `tests/e2e/` | reserved | Tier 3 |

### How to pick a category

**If your test touches the filesystem, it is an integration test.** Always. Even for a single `readFile`. The rule exists so a developer can trust that `pnpm --filter @rondel/daemon test:unit` is fast and deterministic.

**If your test would fail on a different machine for reasons unrelated to the code,** it's not a unit test. Examples: anything involving real timestamps, real network, real subprocesses, real sleeps. These go into integration or higher.

**If you find yourself mocking a Rondel module to test another Rondel module,** stop. Extract a pure function from the module being tested — see §7.

---

## 5. Writing a unit test — worked example

Template: [apps/daemon/src/shared/types/sessions.unit.test.ts](../apps/daemon/src/shared/types/sessions.unit.test.ts).

```ts
import { describe, it, expect } from "vitest";
import { conversationKey, parseConversationKey } from "./sessions.js";

describe("conversationKey", () => {
  it("builds a key in the documented order {agent}:{channel}:{chat}", () => {
    expect(conversationKey("kai", "telegram", "123")).toBe("kai:telegram:123");
  });

  it("produces distinct keys for the same chatId on different channels", () => {
    const a = conversationKey("kai", "telegram", "1");
    const b = conversationKey("kai", "slack", "1");
    expect(a).not.toBe(b);
  });
});
```

### What to notice

- **One `describe` per function or class.** Name it after the unit, not the file.
- **`it` names are plain English behaviour, no "should" prefix.** `"builds a key in the documented order"` beats `"should build the key correctly"`. A good name documents the contract.
- **Zero mocks, zero I/O.** Unit tests import, call, assert. If you need more than that, it's an integration test.
- **Tables via `it.each` for parametric cases.** See the `parseInterval` cases in [apps/daemon/src/scheduling/scheduler.unit.test.ts](../apps/daemon/src/scheduling/scheduler.unit.test.ts) — six input/output pairs in one screen.

### Parametric tables

```ts
it.each([
  ["30s", 30_000],
  ["5m", 5 * 60_000],
  ["2h30m", 2 * 60 * 60_000 + 30 * 60_000],
] as const)("parses %s → %d ms", (input, expected) => {
  expect(parseInterval(input)).toBe(expected);
});
```

Use `as const` so the tuple types narrow. Use `%s`, `%d` placeholders so test IDs are readable in output.

---

## 6. Writing an integration test — worked example

Template: [apps/daemon/src/messaging/inbox.integration.test.ts](../apps/daemon/src/messaging/inbox.integration.test.ts).

```ts
import { describe, it, expect } from "vitest";
import { appendToInbox, readAllInboxes } from "./inbox.js";
import { withTmpRondel } from "../../tests/helpers/tmp.js";
import { makeInterAgentMessage } from "../../tests/helpers/fixtures.js";

describe("appendToInbox", () => {
  it("appends to an existing file preserving order", async () => {
    const tmp = withTmpRondel();
    await appendToInbox(tmp.stateDir, makeInterAgentMessage({ id: "m1", to: "bob" }));
    await appendToInbox(tmp.stateDir, makeInterAgentMessage({ id: "m2", to: "bob" }));
    await appendToInbox(tmp.stateDir, makeInterAgentMessage({ id: "m3", to: "bob" }));
    const all = await readAllInboxes(tmp.stateDir);
    expect(all.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });
});
```

### What to notice

- **`withTmpRondel()` at the top of every test.** It creates an isolated `mkdtempSync` directory and registers `afterEach` cleanup automatically. Tests never write outside `os.tmpdir()`.
- **Test the real module's behaviour, not a mock.** The real `appendToInbox`, `readAllInboxes`, and atomic-write machinery all run exactly as in production. Only the paths are scoped to a tmpdir.
- **Use fixture factories for test data.** `makeInterAgentMessage({ id: "m1", to: "bob" })` documents what fields matter to this specific test. The factory fills in sensible defaults for the rest.
- **Cleanup is not your responsibility.** `withTmpRondel` registers `afterEach(rm)` for you. If a test dies mid-run, the next test gets its own directory regardless.

### When to reach for `vi.mock("node:fs/promises")` instead of real fs

Almost never. Use it only to trigger error branches that real fs can't easily produce on a healthy machine — e.g. "what happens if `rename` throws EPERM halfway through an atomic write". For happy paths and ordinary edge cases, real fs inside `os.tmpdir()` is both faster and more honest.

---

## 7. Mocking philosophy

**Prefer not to mock.** If the code is hard to test without a mock, that's usually a design signal — refactor for purity instead of wrapping tape around the edges.

### Rules

- **Never mock code you own.** If you feel the urge, extract a pure function from the module under test and mock the extraction instead. [apps/daemon/src/bridge/org-isolation.ts](../apps/daemon/src/bridge/org-isolation.ts) is the canonical example: the private `Bridge.checkOrgIsolation` method was extracted into a pure function that takes a `lookup` callback, and the test drives that callback with a table-driven fake.
- **Do mock at the edges.** `child_process.spawn`, external HTTP (Telegram), and `node:fs/promises` for error branches are legitimate mock targets. These are things Rondel doesn't own.
- **`vi.mock` goes at the top of the file, never inside a test.** Hoisting makes it deterministic.
- **Hand-written fakes beat auto-mocks for anything with more than two methods.** A fake that implements the real interface (see [tests/helpers/logger.ts](../tests/helpers/logger.ts) or [tests/helpers/hooks.ts](../tests/helpers/hooks.ts)) gives you type safety and readable test code. A blob of `vi.fn()` doesn't.
- **Fakes live in `tests/helpers/` once they're used by ≥2 files.** Before that, inline them.

---

## 8. Shared helpers reference

All helpers live in [tests/helpers/](../tests/helpers/). Import with relative paths from test files; they are never part of the shipped bundle.

### `withTmpRondel()` — [tests/helpers/tmp.ts](../tests/helpers/tmp.ts)

Creates an isolated Rondel-shaped directory under `os.tmpdir()` and registers `afterEach` cleanup.

```ts
const tmp = withTmpRondel();

tmp.rondelHome       // absolute path to the tmp root
tmp.stateDir         // rondelHome/state
tmp.workspacesDir    // rondelHome/workspaces
tmp.globalDir        // rondelHome/workspaces/global

tmp.mkAgent("kai", { "AGENT.md": "..." })
// creates workspaces/global/agents/kai/ with the seeded files

tmp.mkOrgAgent("acme", "kai", { "AGENT.md": "..." })
// creates workspaces/acme/agents/kai/ and workspaces/acme/shared/
// returns { agentDir, orgDir }

tmp.writeGlobalFile("CONTEXT.md", "body")
tmp.writeOrgSharedFile("acme", "CONTEXT.md", "body")
```

**Guarantees:** every test gets a fresh directory; cleanup runs unconditionally after each test; nothing outside `os.tmpdir()` is ever touched.

### `createCapturingLogger()` — [tests/helpers/logger.ts](../tests/helpers/logger.ts)

Returns a full `Logger` implementation whose calls push into a `.records` array. Pass it to any source function that expects a `Logger`.

```ts
const log = createCapturingLogger();
await assembleContext(agentDir, log);
// log.records is available but tests should NOT assert on log message text —
// logs are not a contract, and assertions on them rot on every refactor.
```

The `.records` field exists for debugging a failing test, not for assertions.

### `createRecordingHooks()` — [tests/helpers/hooks.ts](../tests/helpers/hooks.ts)

Wraps a real `RondelHooks` instance and captures every `emit` call.

```ts
const { hooks, records } = createRecordingHooks();
someModule.doThing(hooks);
expect(records.map((r) => r.event)).toContain("message:sent");
```

Use for: scheduler/ledger tests that need to assert on emitted events, or simply to satisfy constructor signatures that require a `RondelHooks`.

### Fixture factories — [tests/helpers/fixtures.ts](../tests/helpers/fixtures.ts)

Pure functions that return valid instances of common types with optional overrides:

```ts
makeInterAgentMessage({ id: "m1", to: "bob" })
makeSessionEntry({ agentName: "kai", chatId: "123" })
makeAgentConfig({ admin: true })
makeSendMessageBody({ content: "hi" })   // for schema tests
```

**Rule: factories only contain fields with sensible defaults.** If a field is required, the factory sets it. If a test wants something specific, it overrides.

### Adding a new helper

Before adding one, check: is this used by two or more tests yet? If not, inline it. If yes, add a module to `tests/helpers/` **and add an entry to this section of this document**.

---

## 9. Naming & style standards

| Element | Rule | Example |
|---|---|---|
| File | `<source-basename>.unit.test.ts` or `<source-basename>.integration.test.ts` | `sessions.unit.test.ts` |
| `describe` | Name of the function or class under test | `describe("conversationKey", ...)` |
| `it` | Behaviour in plain English, no `"should"` prefix | `"round-trips a key with colons in chatId"` |
| Assertions | One behaviour per `it`; multiple asserts OK for round-trips | — |
| Conditionals | None inside tests. If you need a branch, write two tests. | — |
| `console.log` | Banned. Use `createCapturingLogger` if you need to pass a logger. | — |
| `.only` / `.skip` | Banned in committed code. Use locally, clean up before commit. | — |

**Why no `"should"` prefix:** `"should round-trip a key"` reads as aspiration; `"round-trips a key"` reads as a documented fact. The second one tells you what the code *does*.

---

## 10. What to test vs. defer

Decision tree when adding a new test:

1. **Is it a pure function with a clear input/output contract?** → unit test, now.
2. **Does it read/write files inside Rondel's own state?** → integration test with `withTmpRondel`, now.
3. **Does it require a real subprocess, real network, or a real timer?** → defer until the relevant tier.
4. **Does it need mocks of Rondel code to be testable at all?** → stop. Refactor for purity first, then test the extraction.

### Currently deferred (Tier 1 does not cover)

- **`apps/daemon/src/agents/`** — per-conversation Claude CLI process lifecycle. Needs a mocked-CLI harness; will be covered in Tier 3 once the `fake-claude` stub binary exists. *Exception:* pure in-memory surfaces on `ConversationManager` that don't touch a process (e.g. the `pendingRestarts` Set used by `rondel_reload_skills`) are fair game for unit tests today — see [conversation-manager.unit.test.ts](../apps/daemon/src/agents/conversation-manager.unit.test.ts) for the pattern. The header on that file documents which sibling behaviours stay deferred.
- **`apps/daemon/src/channels/telegram/`** — polling loop. Pure boundary code with little domain logic; covered by the Tier 3 adapter contract battery when a second channel is added.
- **`apps/daemon/src/cli/`** — thin wrappers over `AgentManager`. The risky logic they delegate to is already covered by schema + `config/prompt/` tests (unit per section + one integration covering the full pipeline across all four `PromptMode`s).
- **`apps/daemon/src/bridge/mcp-server.ts`** — MCP protocol bindings. The Zod schemas already lock the HTTP contract that MCP tools call.
- **Bridge HTTP server end-to-end** — trivially thin once `checkOrgIsolation` is extracted and `validateBody` is tested. Add in Tier 2 only if regressions appear.
- **`AdminApi` business logic** — file I/O over `workspaces/`. Covered in Tier 2 as integration tests reusing `withTmpRondel`.

---

## 11. Anti-patterns

Things not to do, and why.

- **Writing outside `os.tmpdir()`.** Tests that pollute the user's real filesystem are a footgun. `withTmpRondel` exists so you never have to.
- **Tests that depend on execution order.** Every test must be runnable in isolation. Use `beforeEach` (not `beforeAll`) for setup that shouldn't leak.
- **Assertions on log message text.** Logs are not a contract. A refactor that rewords a log line shouldn't fail a test. **One narrow exception**: _error-channel contracts_. When the source promises "surface failures instead of silently swallowing them" (e.g. `persistInBackground` replacing a `.catch(() => {})`), a test may assert that *something* was logged at `error` level — and may filter on a short, stable substring of the log topic (e.g. `/session index/i`) when multiple unrelated error paths could otherwise both satisfy the assertion. Don't assert full messages; the topic is the contract, not the prose.
- **Snapshot tests for anything non-trivial.** Snapshots rot. A regenerated snapshot after an unrelated change is worse than no test at all. Prefer explicit asserts on the fields you actually care about.
- **Setup blocks longer than ~50 lines.** The code is probably too coupled. Either extract a helper or refactor the source.
- **Mocking the module under test.** This is always wrong. See §7 — refactor for purity instead.
- **`.only` or `.skip` in committed code.** They silently disable parts of the suite. Use them locally, strip them before commit.
- **Testing via reflection or private APIs.** If a private method is worth testing, promote it to a pure function in a separate file. See the `checkOrgIsolation` extraction.

---

## 12. Adding a new test — checklist

Before opening a PR:

- [ ] File lives next to its source (unit/integration) or under `tests/contract|e2e/`
- [ ] Filename has the correct suffix (`.unit.test.ts` or `.integration.test.ts`)
- [ ] `describe` names the function/class under test
- [ ] `it` names describe behaviour, not implementation
- [ ] No mocks of Rondel code
- [ ] Integration tests use `withTmpRondel` (never `os.tmpdir()` directly)
- [ ] No `.only` / `.skip` / `console.log`
- [ ] `pnpm test` passes locally
- [ ] `pnpm build` still succeeds (test files are excluded from emit)

---

## 13. Growth checkpoints — when to graduate tiers

Tier 1 is the current state. Add Tier 2 / Tier 3 when the triggers below fire, not on a schedule.

### Tier 2 triggers

Add router, ledger, and scheduler class tests when **either**:

- A production incident happens that a router or ledger test would have caught, **or**
- Inter-agent messaging is modified substantively (new delivery semantics, new queue types, new backoff logic).

Tier 2 requires one new helper: `tests/helpers/fake-agent-manager.ts`. It reuses `withTmpRondel`, `createRecordingHooks`, and the fixture factories with zero rework.

### Tier 3 triggers

Add channel adapter contract tests when **a second channel adapter is added**. One adapter doesn't need a contract — the interface is whatever that one adapter does. Two adapters need a shared battery of assertions that both must pass.

Add mocked-CLI end-to-end tests when **the first regression in agent process lifecycle ships**. Until then, the transitive coverage from router/ledger integration tests is sufficient.

---

## 14. References

- [Vitest documentation](https://vitest.dev/)
- [CLAUDE.md](../CLAUDE.md) — project coding standards (apply to test code too)
- [ARCHITECTURE.md](../ARCHITECTURE.md) — system-level context for what the tests are guarding
- [apps/daemon/vitest.config.ts](../apps/daemon/vitest.config.ts) — daemon test runner config
- [apps/web/vitest.config.ts](../apps/web/vitest.config.ts) — web UI fixture test config
- [tests/helpers/](../tests/helpers/) — shared test utilities (workspace root)
