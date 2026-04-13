"use client";

/**
 * Editable memory textarea + save button.
 *
 * Uses `useActionState` (React 19) with the Server Action, which gives
 * us progressive enhancement for free — the form works with JS disabled
 * (native form POST) and upgrades to non-blocking saves when hydrated.
 */
import { useActionState } from "react";

import { saveMemoryAction, type SaveMemoryState } from "./actions";

const INITIAL_STATE: SaveMemoryState = { status: "idle" };

interface MemoryFormProps {
  agent: string;
  initialContent: string;
}

export function MemoryForm({ agent, initialContent }: MemoryFormProps) {
  const [state, formAction, isPending] = useActionState(
    saveMemoryAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col h-full">
      <input type="hidden" name="agent" value={agent} />
      <textarea
        name="content"
        defaultValue={initialContent}
        spellCheck={false}
        className="flex-1 min-h-[400px] p-4 font-mono text-sm text-ink bg-surface-raised border border-border rounded-md resize-y focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        placeholder="# MEMORY.md&#10;&#10;Notes the agent should remember across conversations…"
      />

      <div className="flex items-center justify-between mt-4">
        <div className="text-xs min-h-[1.25rem]">
          {state.status === "ok" && (
            <span className="text-success">{state.message}</span>
          )}
          {state.status === "error" && (
            <span className="text-danger">{state.message}</span>
          )}
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex items-center px-4 py-2 bg-accent text-accent-foreground rounded-md text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isPending ? "Saving…" : "Save memory"}
        </button>
      </div>
    </form>
  );
}
