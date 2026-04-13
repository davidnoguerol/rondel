"use server";

/**
 * Memory write action — the one mutation in M1.
 *
 * Called from the memory page form. Goes through the bridge client, then
 * `revalidateTag(memory:<name>)` so the server-rendered page re-fetches
 * on next navigation/refresh without a full route invalidation.
 */
import { revalidateTag } from "next/cache";

import { bridge } from "@/lib/bridge/client";
import { requireUser } from "@/lib/auth/require-user";

export interface SaveMemoryState {
  readonly status: "idle" | "ok" | "error";
  readonly message?: string;
}

export async function saveMemoryAction(
  _prevState: SaveMemoryState,
  formData: FormData,
): Promise<SaveMemoryState> {
  await requireUser();

  const agent = formData.get("agent");
  const content = formData.get("content");

  if (typeof agent !== "string" || typeof content !== "string") {
    return { status: "error", message: "Malformed form submission." };
  }

  try {
    await bridge.memory.write(agent, content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", message };
  }

  revalidateTag(`memory:${agent}`);
  return { status: "ok", message: "Memory saved." };
}
