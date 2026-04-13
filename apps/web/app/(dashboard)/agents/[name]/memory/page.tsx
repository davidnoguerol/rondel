/**
 * /agents/[name]/memory — read/write the agent's MEMORY.md.
 *
 * Server-renders the current content; the form is a Client Component
 * that wraps a Server Action (useActionState). `revalidateTag` in the
 * action triggers this page to re-fetch on the next visit.
 */
import { bridge } from "@/lib/bridge";

import { MemoryForm } from "./MemoryForm";

export default async function AgentMemoryPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const content = await bridge.memory.read(name);

  return (
    <div className="p-8">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-ink">MEMORY.md</h2>
        <p className="text-xs text-ink-subtle mt-0.5">
          Persistent notes the agent sees on every conversation. Survives
          session resets and restarts. Markdown is stored verbatim.
        </p>
      </div>

      <MemoryForm agent={name} initialContent={content ?? ""} />
    </div>
  );
}
