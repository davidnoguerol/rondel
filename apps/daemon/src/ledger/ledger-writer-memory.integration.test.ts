/**
 * Ledger ↔ memory domain integration: every memory write emits memory:saved,
 * which the ledger persists as a memory_saved row with op/target detail.
 */

import { describe, it, expect } from "vitest";
import { LedgerWriter } from "./ledger-writer.js";
import type { LedgerEvent } from "./ledger-types.js";
import { createHooks } from "../shared/hooks.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";

describe("LedgerWriter — memory_saved", () => {
  it("records memory:saved with op/target/path detail and a truncated summary", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured: LedgerEvent[] = [];
    writer.onAppended((e) => captured.push(e));

    hooks.emit("memory:saved", {
      agentName: "alice",
      op: "append",
      target: "index",
      path: "/x/MEMORY.md",
      summary: "x".repeat(200),
      backupId: "b1",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.kind).toBe("memory_saved");
    expect(captured[0]!.summary.length).toBeLessThanOrEqual(100);
    expect(captured[0]!.detail).toMatchObject({ op: "append", target: "index", path: "/x/MEMORY.md", backupId: "b1" });
  });
});
