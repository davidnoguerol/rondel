import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-md w-full text-center">
        <p className="text-sm uppercase tracking-wider text-ink-subtle mb-2">
          404
        </p>
        <h1 className="text-xl font-semibold text-ink mb-4">Page not found</h1>
        <Link
          href="/agents"
          className="text-accent hover:underline text-sm font-medium"
        >
          Go to agents →
        </Link>
      </div>
    </main>
  );
}
