/**
 * A single chat message bubble — user or agent. Pure presentation.
 *
 * v1 renders plain text with `white-space: pre-wrap` so newlines, indentation,
 * and code blocks display legibly without pulling in a markdown library.
 */

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
          "max-w-[80%] rounded-lg px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words",
          isUser
            ? "bg-accent text-accent-foreground"
            : "bg-surface-raised text-ink border border-border",
        ].join(" ")}
      >
        {text}
        {ts && (
          <div
            className={[
              "mt-1 text-[10px] font-mono",
              isUser ? "text-accent-foreground/70" : "text-ink-subtle",
            ].join(" ")}
          >
            {formatTs(ts)}
          </div>
        )}
      </div>
    </div>
  );
}

function formatTs(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}
