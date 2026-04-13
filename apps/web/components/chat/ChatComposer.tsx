"use client";

/**
 * Message composer for the web chat.
 *
 * Enter sends, Shift+Enter inserts a newline. Disabled while an in-flight
 * send is pending — a second Enter during send is a no-op rather than
 * interleaving with the optimistic update in ChatView.
 */

import { useRef, useState, type KeyboardEvent, type FormEvent } from "react";

interface ChatComposerProps {
  readonly disabled?: boolean;
  readonly onSend: (text: string) => Promise<void> | void;
  readonly placeholder?: string;
}

export function ChatComposer({ disabled, onSend, placeholder }: ChatComposerProps) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || pending || disabled) return;
    setPending(true);
    try {
      await onSend(trimmed);
      setValue("");
      // Refocus so the user can keep typing without reaching for the mouse.
      textareaRef.current?.focus();
    } finally {
      setPending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const handleForm = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void submit();
  };

  const inputDisabled = disabled || pending;

  return (
    <form
      onSubmit={handleForm}
      className="flex items-end gap-2 border-t border-border bg-surface-raised p-3"
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        disabled={inputDisabled}
        placeholder={placeholder ?? "Message the agent…"}
        className={[
          "flex-1 resize-none rounded-md border border-border bg-surface px-3 py-2",
          "text-sm text-ink placeholder:text-ink-subtle",
          "focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent",
          inputDisabled ? "opacity-60 cursor-not-allowed" : "",
        ].join(" ")}
      />
      <button
        type="submit"
        disabled={inputDisabled || !value.trim()}
        className={[
          "inline-flex items-center rounded-md px-4 py-2 text-sm font-medium",
          "bg-accent text-accent-foreground",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "hover:brightness-110 transition",
        ].join(" ")}
      >
        {pending ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
