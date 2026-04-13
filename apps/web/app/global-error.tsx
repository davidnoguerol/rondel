"use client";

/**
 * Last-resort error boundary for errors thrown in the root layout itself.
 * Must render its own <html> and <body> because the root layout has
 * already failed.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
          padding: "2rem",
          color: "#1c1917",
          backgroundColor: "#fafaf9",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}>
          Rondel web UI crashed
        </h1>
        <p style={{ color: "#57534e", marginBottom: "1rem" }}>
          The application failed to render its root layout. This should not
          happen — please check daemon logs and open an issue if it recurs.
        </p>
        <pre style={{ fontSize: "0.8rem", color: "#78716c" }}>
          {error.name}: {error.message}
        </pre>
      </body>
    </html>
  );
}
