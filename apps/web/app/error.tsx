"use client";

/**
 * Root error boundary.
 *
 * Catches errors thrown in RSC rendering inside `app/layout.tsx`'s tree.
 * Branches on `error.name` (the only identifier that survives the RSC
 * serialization boundary — custom properties are lost).
 *
 * See `lib/bridge/errors.ts` for the set of error name tags.
 */
import { useEffect } from "react";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function RootError({ error, reset }: ErrorProps) {
  useEffect(() => {
    // Surface to browser devtools for local debugging.
    // eslint-disable-next-line no-console
    console.error("[rondel-web]", error);
  }, [error]);

  if (error.name === "RondelNotRunningError") {
    return (
      <ErrorCard
        title="Rondel is not running"
        body={
          <>
            Start the daemon with{" "}
            <code className="px-1.5 py-0.5 rounded bg-surface-muted font-mono text-sm">
              rondel start
            </code>{" "}
            and then reload this page.
          </>
        }
        onRetry={reset}
      />
    );
  }

  if (error.name === "BridgeVersionMismatchError") {
    return (
      <ErrorCard
        title="Rondel daemon is out of date"
        body={
          <>
            The running daemon's bridge API is older than this web UI
            expects. Upgrade the daemon, then reload this page.
            <br />
            <span className="block mt-2 text-ink-muted font-mono text-sm">
              {error.message}
            </span>
          </>
        }
        onRetry={reset}
      />
    );
  }

  if (error.name === "BridgeSchemaError") {
    return (
      <ErrorCard
        title="Unexpected response from Rondel"
        body={
          <>
            The daemon returned data that did not match the shape this
            web UI expects. This usually means the daemon and web
            package versions have drifted. Upgrade one or both.
            <br />
            <span className="block mt-2 text-ink-muted font-mono text-sm">
              {error.message}
            </span>
          </>
        }
        onRetry={reset}
      />
    );
  }

  return (
    <ErrorCard
      title="Something went wrong"
      body={
        <span className="font-mono text-sm text-ink-muted">
          {error.message}
        </span>
      }
      onRetry={reset}
    />
  );
}

function ErrorCard({
  title,
  body,
  onRetry,
}: {
  title: string;
  body: React.ReactNode;
  onRetry: () => void;
}) {
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-lg w-full bg-surface-raised border border-border rounded-lg p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-ink mb-3">{title}</h1>
        <div className="text-ink-muted leading-relaxed mb-6">{body}</div>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center px-4 py-2 bg-accent text-accent-foreground rounded-md text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
