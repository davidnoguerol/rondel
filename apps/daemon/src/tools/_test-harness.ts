/**
 * Shared test harness for first-class tool integration tests.
 *
 * The filesystem tools (rondel_read_file, _write_file, _edit_file,
 * _multi_edit_file) and rondel_bash share the bridge surface (read-state
 * + history + approvals + ledger). rondel_ask_user uses a distinct prompts
 * surface (POST /prompts/ask-user + GET /prompts/ask-user/:id) that is
 * also mocked here so every first-class-tool integration test imports one
 * harness instead of redefining its own.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AskUserResponse =
  | { status: "pending" }
  | { status: "resolved"; selected_index: number; selected_label: string; resolvedBy?: string }
  | { status: "timeout" };

export interface BridgeCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface MockBridgeHandle {
  url: string;
  readonly calls: BridgeCall[];
  /** In-memory read-state records. Keyed `sessionId::path`. */
  readState: Map<string, { contentHash: string; readAt: string }>;
  /** Counter for backup ids. */
  backupCounter: number;
  /** Approval decision for the next tool-use request. */
  approvalDecision: "allow" | "deny";
  /** Optional delay before approvals resolve. */
  approvalDelayMs: number;
  /** If set, fail (non-404) on GET read-state lookups. */
  failReadStateGet: boolean;
  /** If set, fail on POST record. */
  failReadStateRecord: boolean;
  /** If set, fail on backup creation. */
  failBackup: boolean;
  /**
   * Fires exactly once, after the first `POST /approvals/tool-use` request
   * is registered. Use to simulate external work (e.g. a concurrent edit)
   * that happens while the tool is awaiting operator approval.
   */
  onApprovalCreated?: () => void | Promise<void>;
  /** Static response returned by GET /prompts/ask-user/:id. */
  askUserResponse: AskUserResponse;
  /** If set, GET /prompts/ask-user/:id returns 404 (simulates daemon restart). */
  askUserMissing: boolean;
  stop: () => void;
}

export async function startMockBridge(): Promise<MockBridgeHandle> {
  const calls: BridgeCall[] = [];
  const readState = new Map<string, { contentHash: string; readAt: string }>();
  const approvalFirstSeen = new Map<string, number>();

  const handle: MockBridgeHandle = {
    url: "",
    calls,
    readState,
    backupCounter: 0,
    approvalDecision: "allow",
    approvalDelayMs: 0,
    failReadStateGet: false,
    failReadStateRecord: false,
    failBackup: false,
    askUserResponse: { status: "pending" },
    askUserMissing: false,
    stop: () => undefined,
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    const parsed = body ? JSON.parse(body) : undefined;
    const call: BridgeCall = {
      method: req.method ?? "GET",
      path: req.url ?? "/",
      body: parsed,
    };
    calls.push(call);

    // ---------- read-state ----------
    const readStateMatch = call.path.match(/^\/filesystem\/read-state\/([^/?]+)(\?.*)?$/);
    if (readStateMatch && call.method === "GET") {
      if (handle.failReadStateGet) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forced failure" }));
        return;
      }
      const u = new URL(`http://x${call.path}`);
      const sessionId = u.searchParams.get("sessionId") ?? "";
      const path = u.searchParams.get("path") ?? "";
      const key = `${sessionId}::${path}`;
      const record = readState.get(key);
      if (!record) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(record));
      return;
    }
    if (readStateMatch && call.method === "POST") {
      if (handle.failReadStateRecord) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forced failure" }));
        return;
      }
      const payload = parsed as { sessionId: string; path: string; contentHash: string };
      readState.set(`${payload.sessionId}::${payload.path}`, {
        contentHash: payload.contentHash,
        readAt: new Date().toISOString(),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ---------- file history / backup ----------
    if (call.method === "POST" && call.path.match(/^\/filesystem\/history\/[^/]+\/backup$/)) {
      if (handle.failBackup) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forced backup failure" }));
        return;
      }
      const id = `backup-${++handle.backupCounter}`;
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ backupId: id }));
      return;
    }

    // ---------- approvals ----------
    if (call.method === "POST" && call.path === "/approvals/tool-use") {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ requestId: `appr-${calls.length}` }));
      // Fire the test-injected hook AFTER the response returns so the
      // tool sees a requestId before any external mutation happens.
      const hook = handle.onApprovalCreated;
      if (hook) {
        handle.onApprovalCreated = undefined;
        Promise.resolve()
          .then(() => hook())
          .catch(() => undefined);
      }
      return;
    }
    if (call.method === "GET" && call.path.startsWith("/approvals/")) {
      const id = call.path.slice("/approvals/".length);
      const first = approvalFirstSeen.get(id) ?? Date.now();
      approvalFirstSeen.set(id, first);
      if (Date.now() - first < handle.approvalDelayMs) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "pending" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "resolved",
          decision: handle.approvalDecision,
          resolvedBy: "test",
        }),
      );
      return;
    }

    // ---------- ask-user (prompts, not approvals) ----------
    if (call.method === "POST" && call.path === "/prompts/ask-user") {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ requestId: `askuser-${calls.length}` }));
      return;
    }
    if (call.method === "GET" && call.path.startsWith("/prompts/ask-user/")) {
      if (handle.askUserMissing) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(handle.askUserResponse));
      return;
    }

    // ---------- ledger ----------
    if (call.method === "POST" && call.path === "/ledger/tool-call") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `mock bridge: route not found: ${call.method} ${call.path}` }));
  };

  return new Promise((resolveStart) => {
    const server: Server = createServer((req, res) => {
      void handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bad bridge address");
      handle.url = `http://127.0.0.1:${addr.port}`;
      handle.stop = () => server.close();
      resolveStart(handle);
    });
  });
}

// ---------------------------------------------------------------------------
// Fake McpServer
// ---------------------------------------------------------------------------

export type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

export interface FakeMcpServer {
  readonly handlers: Map<string, ToolHandler>;
  registerTool(name: string, _config: unknown, cb: ToolHandler): void;
}

export function createFakeMcpServer(): FakeMcpServer {
  const handlers = new Map<string, ToolHandler>();
  return {
    handlers,
    registerTool(name, _config, cb) {
      handlers.set(name, cb);
    },
  };
}

export function parseResult(result: {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}): { json: Record<string, unknown>; isError: boolean } {
  if (result.content.length !== 1) {
    throw new Error(`Expected 1 content block, got ${result.content.length}`);
  }
  return {
    json: JSON.parse(result.content[0].text) as Record<string, unknown>,
    isError: result.isError ?? false,
  };
}

// ---------------------------------------------------------------------------
// Scratch dirs
// ---------------------------------------------------------------------------

export interface ScratchContext {
  readonly dirs: string[];
  mk(): string;
  dispose(): Promise<void>;
}

export function makeScratchContext(): ScratchContext {
  const dirs: string[] = [];
  return {
    dirs,
    mk() {
      const d = mkdtempSync(join(tmpdir(), "rondel-fs-test-"));
      dirs.push(d);
      return d;
    },
    async dispose() {
      for (const d of dirs) await rm(d, { recursive: true, force: true });
    },
  };
}
