"use server";

/**
 * Server Actions for the schedules surface.
 *
 * Every mutation goes through one of these: the web proxy route
 * (`/api/bridge/[...path]`) deliberately doesn't allow POST/PATCH/DELETE
 * on /schedules — mutations must be Server Actions so Next's automatic
 * action-id CSRF hashing kicks in.
 *
 * All actions:
 *   1. `requireUser()` — loopback + same-origin check.
 *   2. Parse the incoming payload against the web bridge schema
 *      (which mirrors the daemon's). Surface a message, not a crash.
 *   3. Call through `bridge.schedules.*`.
 *   4. `revalidateTag(schedules:<agent>)` so the RSC page re-fetches on
 *      next navigation. Live UI state still updates via SSE in the
 *      current tab — the tag is mostly for other tabs / back-forward.
 *   5. Return `{ status, message? }` shaped like the memory action so
 *      forms using `useActionState` render errors inline.
 */

import { revalidateTag } from "next/cache";

import { bridge } from "@/lib/bridge/client";
import {
  ScheduleCreateInputSchema,
  ScheduleUpdateInputSchema,
} from "@/lib/bridge";
import { requireUser } from "@/lib/auth/require-user";

export interface ScheduleActionState {
  readonly status: "idle" | "ok" | "error";
  readonly message?: string;
}

// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------

/**
 * Create a schedule. `payload` is the serialized form object built by the
 * dialog — we re-validate here so a bad client-side submit surfaces a
 * readable error rather than crashing the action.
 */
export async function createScheduleAction(
  _prev: ScheduleActionState,
  payload: FormData,
): Promise<ScheduleActionState> {
  await requireUser();

  const agent = payload.get("agent");
  const raw = payload.get("input");
  if (typeof agent !== "string" || typeof raw !== "string") {
    return { status: "error", message: "Malformed form submission." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "error", message: "Malformed schedule payload." };
  }

  const validated = ScheduleCreateInputSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      status: "error",
      message: validated.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
    };
  }

  try {
    await bridge.schedules.create(agent, validated.data);
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }

  revalidateTag(`schedules:${agent}`);
  return { status: "ok", message: "Schedule created." };
}

// -----------------------------------------------------------------------------
// Update
// -----------------------------------------------------------------------------

export async function updateScheduleAction(
  _prev: ScheduleActionState,
  payload: FormData,
): Promise<ScheduleActionState> {
  await requireUser();

  const agent = payload.get("agent");
  const scheduleId = payload.get("scheduleId");
  const raw = payload.get("patch");
  if (typeof agent !== "string" || typeof scheduleId !== "string" || typeof raw !== "string") {
    return { status: "error", message: "Malformed form submission." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "error", message: "Malformed patch payload." };
  }

  const validated = ScheduleUpdateInputSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      status: "error",
      message: validated.error.issues.map((i) => `${i.path.join(".") || "patch"}: ${i.message}`).join("; "),
    };
  }

  try {
    await bridge.schedules.update(agent, scheduleId, validated.data);
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }

  revalidateTag(`schedules:${agent}`);
  return { status: "ok", message: "Schedule updated." };
}

// -----------------------------------------------------------------------------
// Lightweight one-field mutations — used by per-card buttons without a
// full form. They take typed args directly (not FormData) and return
// the same shape for consistency.
// -----------------------------------------------------------------------------

export async function toggleScheduleEnabledAction(
  agent: string,
  scheduleId: string,
  enabled: boolean,
): Promise<ScheduleActionState> {
  await requireUser();
  try {
    await bridge.schedules.update(agent, scheduleId, { enabled });
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
  revalidateTag(`schedules:${agent}`);
  return { status: "ok", message: enabled ? "Enabled." : "Disabled." };
}

export async function runScheduleNowAction(
  agent: string,
  scheduleId: string,
): Promise<ScheduleActionState> {
  await requireUser();
  try {
    await bridge.schedules.runNow(agent, scheduleId);
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
  // No tag revalidation — the subsequent schedule:ran SSE frame updates
  // the card directly.
  return { status: "ok", message: "Triggered." };
}

export async function deleteScheduleAction(
  agent: string,
  scheduleId: string,
): Promise<ScheduleActionState> {
  await requireUser();
  try {
    await bridge.schedules.remove(agent, scheduleId);
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
  revalidateTag(`schedules:${agent}`);
  return { status: "ok", message: "Schedule deleted." };
}
