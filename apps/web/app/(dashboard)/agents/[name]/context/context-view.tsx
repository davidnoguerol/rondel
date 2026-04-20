"use client";

/**
 * Client-side variant switcher for the context page. Two tabs (Main and
 * Agent-Mail), each rendering the raw prompt string in a scrollable pre
 * block with a byte counter and a copy-to-clipboard button.
 *
 * Kept intentionally minimal — the goal is to show bytes-on-the-wire, not
 * to prettify them. If the user wants section-by-section breakdown later
 * that's a different surface.
 */
import { useState } from "react";

type Variant = "main" | "agent-mail";

interface ContextViewProps {
  systemPrompt: string;
  agentMailPrompt: string | null;
}

export function ContextView({ systemPrompt, agentMailPrompt }: ContextViewProps) {
  const [variant, setVariant] = useState<Variant>("main");
  const [copied, setCopied] = useState(false);

  const shown = variant === "main" ? systemPrompt : (agentMailPrompt ?? "");
  const hasAgentMail = agentMailPrompt !== null && agentMailPrompt.length > 0;

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable — silent fail, the copy button is a convenience
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="mb-3 flex items-center justify-between gap-4 flex-none">
        <nav className="flex gap-1 text-xs">
          <button
            type="button"
            onClick={() => setVariant("main")}
            className={`px-3 py-1.5 rounded-md border transition-colors ${
              variant === "main"
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            Main conversation
          </button>
          <button
            type="button"
            onClick={() => setVariant("agent-mail")}
            disabled={!hasAgentMail}
            className={`px-3 py-1.5 rounded-md border transition-colors ${
              variant === "agent-mail"
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            Agent-mail
          </button>
        </nav>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            {shown.length.toLocaleString()} chars · {shown.split("\n").length.toLocaleString()} lines
          </span>
          <button
            type="button"
            onClick={copyToClipboard}
            className="px-2 py-1 border border-border rounded-md hover:text-foreground transition-colors"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <pre className="flex-1 min-h-0 overflow-auto rounded-md border border-border bg-muted/30 p-4 text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
        {shown}
      </pre>
    </div>
  );
}
