"use client";

/**
 * Dashboard segment error boundary.
 *
 * Renders inside the main content area; the sidebar stays visible because
 * layout.tsx is a parent of this boundary (Next's nested error rule).
 *
 * Branches on `error.name` — see `app/error.tsx` for the rationale.
 * We don't re-export the root error.tsx because it uses `min-h-screen`
 * which looks wrong inside a flex child.
 */
import { useEffect } from "react";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function DashboardError({ error, reset }: ErrorProps) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[rondel-web]", error);
  }, [error]);

  const { title, body } = messageFor(error);

  return (
    <div className="p-8">
      <div className="max-w-lg bg-surface-raised border border-border rounded-lg p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-ink mb-2">{title}</h1>
        <div className="text-sm text-ink-muted leading-relaxed mb-5">{body}</div>
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center px-3 py-1.5 bg-accent text-accent-foreground rounded-md text-xs font-medium hover:opacity-90 transition-opacity"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

function messageFor(error: Error): { title: string; body: React.ReactNode } {
  if (error.name === "RondelNotRunningError") {
    return {
      title: "Rondel is not running",
      body: (
        <>
          Start the daemon with{" "}
          <code className="px-1.5 py-0.5 rounded bg-surface-muted font-mono text-xs">
            rondel start
          </code>
          .
        </>
      ),
    };
  }
  if (error.name === "BridgeVersionMismatchError") {
    return {
      title: "Daemon is out of date",
      body: (
        <>
          {error.message}
          <br />
          Upgrade the Rondel daemon and reload.
        </>
      ),
    };
  }
  if (error.name === "BridgeSchemaError") {
    return {
      title: "Unexpected response from Rondel",
      body: (
        <span className="font-mono text-xs break-words">{error.message}</span>
      ),
    };
  }
  return {
    title: "Something went wrong",
    body: (
      <span className="font-mono text-xs break-words">{error.message}</span>
    ),
  };
}
