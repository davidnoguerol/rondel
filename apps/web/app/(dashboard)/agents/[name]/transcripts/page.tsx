/**
 * /agents/[name]/transcripts — the transcript browser (observability,
 * design §7.3).
 *
 * Server-rendered: conversations + session chains in the left column,
 * a paginated entry view for the selected session (via ?session= &offset=)
 * on the right, plus the usage rollup header. Entries arrive redacted and
 * tool-payload-truncated from the daemon — this page never re-derives
 * content. Live updates are deliberately out of scope for v1 (the
 * "transcripts" multiplex topic exists for a future live tail).
 */
import Link from "next/link";
import { bridge } from "@/lib/bridge/client";
import type { TranscriptEntryWire } from "@/lib/bridge/schemas";

const PAGE_SIZE = 50;

export default async function AgentTranscriptsPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ session?: string; offset?: string }>;
}) {
  const { name } = await params;
  const { session, offset: offsetRaw } = await searchParams;
  const offset = Math.max(0, parseInt(offsetRaw ?? "0", 10) || 0);

  const [sessions, usage] = await Promise.all([
    bridge.transcripts.sessions(name),
    bridge.transcripts.usage(name).catch(() => null),
  ]);

  const entries = session ? await bridge.transcripts.entries(name, session, { offset, limit: PAGE_SIZE }).catch(() => null) : null;

  return (
    <div className="p-8">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-ink">Transcripts</h2>
        <p className="text-xs text-ink-subtle mt-0.5">
          Every session, verbatim and redacted — the substrate for memory, recall, and skill auditing.
          {usage && (
            <span className="ml-2">
              {usage.totals.turns} turns · {formatTokens(usage.totals.inputTokens + usage.totals.outputTokens)} tokens · ~$
              {usage.totals.estimatedCostUsd.toFixed(2)} est.
            </span>
          )}
        </p>
      </div>

      <div className="grid grid-cols-[280px_1fr] gap-6">
        <aside className="space-y-4">
          {sessions.conversations.length === 0 && <p className="text-xs text-ink-subtle">No transcripts yet.</p>}
          {sessions.conversations.map((conversation) => (
            <div key={conversation.conversationKey}>
              <h3 className="text-xs font-medium text-ink truncate" title={conversation.conversationKey}>
                {conversation.conversationKey}
              </h3>
              <ul className="mt-1 space-y-0.5">
                {[...conversation.sessions].reverse().map((s) => (
                  <li key={s.sessionId}>
                    <Link
                      href={`/agents/${encodeURIComponent(name)}/transcripts?session=${encodeURIComponent(s.sessionId)}`}
                      className={`block text-xs truncate rounded px-2 py-1 hover:bg-card ${
                        s.sessionId === session ? "bg-card text-ink" : "text-ink-subtle"
                      }`}
                      title={s.sessionId}
                    >
                      {s.sessionId.slice(0, 8)} · {s.reason} · {s.startedAt.slice(0, 10)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>

        <section>
          {!session && <p className="text-xs text-ink-subtle">Select a session to view its transcript.</p>}
          {session && !entries && <p className="text-xs text-red-500">Transcript not found for session {session}.</p>}
          {entries && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-ink-subtle">
                  {entries.sessionId} — entries {entries.offset + 1}–{Math.min(entries.offset + PAGE_SIZE, entries.total)} of {entries.total}
                </p>
                <div className="flex gap-2 text-xs">
                  {entries.offset > 0 && (
                    <Link
                      className="text-accent hover:underline"
                      href={`/agents/${encodeURIComponent(name)}/transcripts?session=${encodeURIComponent(session!)}&offset=${Math.max(0, entries.offset - PAGE_SIZE)}`}
                    >
                      ← newer page
                    </Link>
                  )}
                  {entries.offset + PAGE_SIZE < entries.total && (
                    <Link
                      className="text-accent hover:underline"
                      href={`/agents/${encodeURIComponent(name)}/transcripts?session=${encodeURIComponent(session!)}&offset=${entries.offset + PAGE_SIZE}`}
                    >
                      older page →
                    </Link>
                  )}
                </div>
              </div>
              <ol className="space-y-2">
                {entries.entries.map((entry) => (
                  <li key={entry.index}>
                    <TranscriptEntry entry={entry} />
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function TranscriptEntry({ entry }: { entry: TranscriptEntryWire }) {
  const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : "";
  switch (entry.type) {
    case "session_start":
      return (
        <Meta ts={ts}>
          session start{entry.mode ? ` (${entry.mode})` : ""}
          {entry.parentSessionId ? ` — continues ${entry.parentSessionId.slice(0, 8)}` : ""}
        </Meta>
      );
    case "user":
      return <Bubble ts={ts} label="user" tone="border-accent" text={entry.text} />;
    case "assistant":
      return <Bubble ts={ts} label="assistant" tone="border-border" text={entry.text} />;
    case "tool_use":
      return <Bubble ts={ts} label={`→ ${entry.name}`} tone="border-amber-500/40" text={entry.input} truncated={entry.truncated} mono />;
    case "tool_result":
      return (
        <Bubble
          ts={ts}
          label={`← ${entry.name} ${entry.ok ? "ok" : "FAILED"}${entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : ""}`}
          tone={entry.ok ? "border-emerald-500/40" : "border-red-500/60"}
          text={entry.result ?? entry.error ?? ""}
          truncated={entry.truncated}
          mono
        />
      );
    case "turn":
      return (
        <Meta ts={ts}>
          turn complete — {entry.usage.inputTokens + entry.usage.outputTokens} tokens
          {entry.costUsd !== undefined ? ` · ~$${entry.costUsd.toFixed(4)} est.` : ""}
          {entry.toolNames && entry.toolNames.length > 0 ? ` · tools: ${entry.toolNames.join(", ")}` : ""}
          {entry.isError ? " · ERROR" : ""}
        </Meta>
      );
    case "compaction":
      return <Bubble ts={ts} label={`compaction (${entry.trigger ?? "auto"})`} tone="border-purple-500/40" text={entry.summary} />;
    case "cli_session":
      return <Meta ts={ts}>CLI session {entry.cliSessionId.slice(0, 8)}</Meta>;
    default:
      return null;
  }
}

function Bubble({ ts, label, tone, text, truncated, mono }: { ts: string; label: string; tone: string; text: string; truncated?: boolean; mono?: boolean }) {
  return (
    <div className={`border-l-2 ${tone} pl-3`}>
      <p className="text-[10px] uppercase tracking-wide text-ink-subtle">
        {label} {ts && <span className="normal-case">· {ts}</span>}
        {truncated && <span className="ml-1 rounded bg-card px-1">truncated</span>}
      </p>
      <pre className={`text-xs whitespace-pre-wrap break-words text-ink ${mono ? "font-mono" : "font-sans"}`}>{text}</pre>
    </div>
  );
}

function Meta({ ts, children }: { ts: string; children: React.ReactNode }) {
  return (
    <p className="text-[11px] text-ink-subtle italic">
      {children} {ts && `· ${ts}`}
    </p>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
