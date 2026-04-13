/**
 * A single chat message bubble — user or agent.
 *
 * Body content is rendered through `<MessageMarkdown>`, which runs the text
 * through `react-markdown` + `remark-gfm` + `remark-breaks` and sanitizes
 * the result with `rehype-sanitize` (default GitHub schema). The bubble
 * itself is a thin wrapper that owns layout, background color, max width,
 * and the timestamp footer.
 *
 * Timestamps are rendered client-only. `toLocaleTimeString` depends on the
 * runtime's locale and timezone, so SSR and client would otherwise produce
 * different strings and React would throw a hydration mismatch for every
 * history turn. Rendering after mount means the server emits an empty
 * placeholder and the browser fills it in with the user's local time.
 */
"use client";

import { useEffect, useState } from "react";

import { MessageMarkdown } from "./MessageMarkdown";

export type MessageRole = "user" | "assistant";

interface MessageProps {
  readonly role: MessageRole;
  readonly text: string;
  readonly ts?: string;
}

export function Message({ role, text, ts }: MessageProps) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "max-w-[80%] rounded-lg px-4 py-2 text-sm leading-relaxed break-words",
          isUser
            ? "bg-accent text-accent-foreground"
            : "bg-surface-raised text-ink border border-border",
        ].join(" ")}
      >
        <MessageMarkdown text={text} tone={isUser ? "user" : "assistant"} />
        {ts && (
          <div
            className={[
              "mt-1 text-[10px] font-mono",
              isUser ? "text-accent-foreground/70" : "text-ink-subtle",
            ].join(" ")}
          >
            <ClientTimestamp ts={ts} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Render a locale- and timezone-dependent timestamp only after mount so
 * SSR and the first client render always agree. Empty placeholder on the
 * server; real "HH:MM" on the client.
 */
function ClientTimestamp({ ts }: { readonly ts: string }) {
  const [label, setLabel] = useState<string>("");
  useEffect(() => {
    try {
      const d = new Date(ts);
      setLabel(
        d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
      );
    } catch {
      setLabel("");
    }
  }, [ts]);
  // `suppressHydrationWarning` silences the single-node text diff for the
  // first paint — the server renders "" and the client briefly renders ""
  // before the effect populates the real value on the next tick.
  return <span suppressHydrationWarning>{label}</span>;
}
