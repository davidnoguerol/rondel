"use client";

/**
 * Single shared form used by the Create and Edit dialogs.
 *
 * Both flows serialize the same `ScheduleCreateInput` shape — Edit maps
 * to `ScheduleUpdateInput` by passing the whole object as a patch (every
 * field is optional, so omitting `targetAgent` works). Keeping one form
 * file means the kind/delivery/advanced controls live in one place.
 *
 * The form submits via `useActionState` against the provided Server
 * Action so progressive enhancement keeps working (native form POST if
 * JS is off). The submit button is disabled while pending.
 *
 * Controlled client-side state for the radio-driven conditionals only
 * (kind, delivery mode). Everything else is uncontrolled — we read
 * values with `FormData` at submit, serialize to JSON, and hand it to
 * the action. This avoids having to pair every input with a useState.
 */

import { useActionState, useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ScheduleCreateInput, ScheduleSummary } from "@/lib/bridge";

import type { ScheduleActionState } from "./actions";

type ScheduleKindMode = "every" | "at" | "cron";
type DeliveryMode = "none" | "announce";

export interface ScheduleFormProps {
  /** Initial values when editing an existing schedule. */
  readonly initial?: ScheduleSummary;
  /** Server Action that receives `FormData` with `agent`, `input`/`patch` (JSON). */
  readonly action: (state: ScheduleActionState, payload: FormData) => Promise<ScheduleActionState>;
  /** Field names — `"input"` for create, `"patch"` for update. */
  readonly payloadField: "input" | "patch";
  /** Agent name — baked into the hidden field. */
  readonly agent: string;
  /** Optional schedule id — baked into a hidden field for update flows. */
  readonly scheduleId?: string;
  /** Called after a successful submit so the dialog can close itself. */
  readonly onSuccess?: () => void;
  /** Submit label — defaults to "Create schedule". */
  readonly submitLabel?: string;
}

const INITIAL: ScheduleActionState = { status: "idle" };

export function ScheduleForm(props: ScheduleFormProps) {
  const {
    initial,
    action,
    payloadField,
    agent,
    scheduleId,
    onSuccess,
    submitLabel = "Create schedule",
  } = props;

  // --- Bridge the Server Action into useActionState ---
  // The handler serializes the current form values into the payload JSON
  // before calling the action. We keep the kind / delivery mode as
  // controlled state so conditional inputs appear/disappear correctly,
  // but otherwise rely on uncontrolled inputs read via FormData.
  const [state, runAction, isPending] = useActionState(
    async (prev: ScheduleActionState, raw: FormData) => {
      const res = await action(prev, raw);
      if (res.status === "ok") onSuccess?.();
      return res;
    },
    INITIAL,
  );

  // ---------------------------------------------------------------------------
  // Client-side state for conditional inputs
  // ---------------------------------------------------------------------------

  const initialKind = initial?.schedule.kind ?? "every";
  const [kindMode, setKindMode] = useState<ScheduleKindMode>(initialKind);

  const initialDelivery: DeliveryMode = initial?.delivery?.mode ?? "none";
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>(initialDelivery);

  // ---------------------------------------------------------------------------
  // Build the submit handler that serializes values into JSON
  // ---------------------------------------------------------------------------

  const handleSubmit = (rawForm: FormData) => {
    const input = serializeForm(rawForm, { kindMode, deliveryMode });

    const payload = new FormData();
    payload.set("agent", agent);
    if (scheduleId) payload.set("scheduleId", scheduleId);
    payload.set(payloadField, JSON.stringify(input));

    return runAction(payload);
  };

  // ---------------------------------------------------------------------------
  // IDs
  // ---------------------------------------------------------------------------

  const formId = useId();
  const id = (suffix: string) => `${formId}-${suffix}`;

  return (
    <form
      action={handleSubmit}
      className="flex flex-col gap-4"
    >
      <Field label="Name" htmlFor={id("name")}>
        <Input
          id={id("name")}
          name="name"
          defaultValue={initial?.name}
          placeholder="Morning ping"
          required
          maxLength={200}
        />
      </Field>

      <Field label="Prompt" htmlFor={id("prompt")} help="What the agent is asked to do when the schedule fires.">
        <Textarea
          id={id("prompt")}
          name="prompt"
          defaultValue={initial?.prompt}
          placeholder="check the overnight ops summary"
          rows={4}
          required
        />
      </Field>

      <Field label="Schedule" help="Pick one kind. Intervals and cron expressions repeat; 'at' is one-shot.">
        <RadioGroup
          value={kindMode}
          onValueChange={(v) => setKindMode(v as ScheduleKindMode)}
          className="flex gap-4"
        >
          <RadioChip value="every" label="Every" />
          <RadioChip value="at" label="At" />
          <RadioChip value="cron" label="Cron" />
        </RadioGroup>

        <div className="mt-3">
          {kindMode === "every" && (
            <Input
              name="kind-every-interval"
              defaultValue={initial?.schedule.kind === "every" ? initial.schedule.interval : ""}
              placeholder='30s · 5m · 1h · 2h30m · 7d'
              pattern="^\d+[dhms](\d+[dhms])*$"
              required
              className="font-mono text-sm"
            />
          )}
          {kindMode === "at" && (
            <Input
              type="text"
              name="kind-at-value"
              defaultValue={initial?.schedule.kind === "at" ? initial.schedule.at : ""}
              placeholder='2026-05-01T09:00:00Z  or  20m'
              required
              className="font-mono text-sm"
            />
          )}
          {kindMode === "cron" && (
            <div className="grid grid-cols-3 gap-2">
              <Input
                name="kind-cron-expression"
                defaultValue={initial?.schedule.kind === "cron" ? initial.schedule.expression : ""}
                placeholder="0 8 * * *"
                required
                className="col-span-2 font-mono text-sm"
              />
              <Input
                name="kind-cron-timezone"
                defaultValue={initial?.schedule.kind === "cron" ? initial.schedule.timezone ?? "" : ""}
                placeholder="America/Sao_Paulo"
                className="font-mono text-sm"
              />
            </div>
          )}
        </div>
      </Field>

      <Field label="Delivery" help="Where the agent's response goes. 'None' means the result stays in the agent's session.">
        <RadioGroup
          value={deliveryMode}
          onValueChange={(v) => setDeliveryMode(v as DeliveryMode)}
          className="flex gap-4"
        >
          <RadioChip value="none" label="None" />
          <RadioChip value="announce" label="Announce to chat" />
        </RadioGroup>

        {deliveryMode === "announce" && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Input
              name="delivery-chatId"
              defaultValue={initial?.delivery?.mode === "announce" ? initial.delivery.chatId : ""}
              placeholder="Chat ID"
              required
              className="font-mono text-sm"
            />
            <Input
              name="delivery-channelType"
              defaultValue={initial?.delivery?.mode === "announce" ? initial.delivery.channelType ?? "" : ""}
              placeholder="telegram"
              className="font-mono text-sm"
            />
            <Input
              name="delivery-accountId"
              defaultValue={initial?.delivery?.mode === "announce" ? initial.delivery.accountId ?? "" : ""}
              placeholder="Account ID"
              className="font-mono text-sm"
            />
          </div>
        )}
      </Field>

      <div className="flex items-center gap-3">
        <Switch id={id("enabled")} name="enabled" defaultChecked={initial?.enabled ?? true} />
        <Label htmlFor={id("enabled")} className="cursor-pointer">
          Enabled
        </Label>
      </div>

      {/* --- Advanced fields in a collapsible --- */}
      <Collapsible className="mt-2 rounded-md border border-border bg-muted/40">
        <CollapsibleTrigger
          type="button"
          className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <span>Advanced</span>
          <span className="text-muted-foreground">▸</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="grid grid-cols-2 gap-3 px-3 pb-3 pt-1">
          <Field label="Session target" help='"isolated" or "session:&lt;name&gt;"'>
            <Input
              name="sessionTarget"
              defaultValue={initial?.sessionTarget ?? "isolated"}
              className="font-mono text-sm"
            />
          </Field>
          <Field label="Model override">
            <Input
              name="model"
              defaultValue={initial?.model ?? ""}
              placeholder="(agent default)"
              className="font-mono text-sm"
            />
          </Field>
          <Field label="Timeout (minutes)" help="0 = default">
            <Input
              type="number"
              name="timeoutMin"
              defaultValue={initial?.timeoutMs ? Math.round(initial.timeoutMs / 60_000) : ""}
              placeholder="0"
              min={0}
              max={120}
            />
          </Field>
          <div className="flex items-center gap-3 self-end pb-2">
            <Switch
              id={id("deleteAfterRun")}
              name="deleteAfterRun"
              defaultChecked={initial?.deleteAfterRun ?? false}
            />
            <Label htmlFor={id("deleteAfterRun")} className="cursor-pointer text-sm">
              Delete after run
            </Label>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* --- Status + submit --- */}
      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="min-h-[1.25rem] text-xs">
          {state.status === "ok" && <span className="text-success">{state.message}</span>}
          {state.status === "error" && <span className="text-destructive">{state.message}</span>}
        </div>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

// -----------------------------------------------------------------------------
// Presentational helpers
// -----------------------------------------------------------------------------

function Field({
  label,
  htmlFor,
  help,
  children,
}: {
  label: string;
  htmlFor?: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={htmlFor} className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {children}
      {help && <p className="text-[11px] text-muted-foreground">{help}</p>}
    </div>
  );
}

function RadioChip({ value, label }: { value: string; label: string }) {
  const id = `chip-${value}`;
  return (
    <div className="flex items-center gap-2">
      <RadioGroupItem value={value} id={id} />
      <Label htmlFor={id} className="cursor-pointer text-sm">
        {label}
      </Label>
    </div>
  );
}

// -----------------------------------------------------------------------------
// FormData → payload
// -----------------------------------------------------------------------------

/**
 * Read the uncontrolled inputs via FormData and assemble a
 * `ScheduleCreateInput`-shaped object. The client-controlled `kindMode`
 * and `deliveryMode` pick which branch of the union is built.
 *
 * Empty optional strings collapse to `undefined` rather than empty string
 * so the daemon schema doesn't flag min(1) on optional fields.
 */
function serializeForm(
  form: FormData,
  selections: { kindMode: ScheduleKindMode; deliveryMode: DeliveryMode },
): ScheduleCreateInput {
  const str = (name: string): string | undefined => {
    const v = form.get(name);
    if (typeof v !== "string") return undefined;
    const trimmed = v.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  };

  const schedule = (() => {
    if (selections.kindMode === "every") {
      return { kind: "every" as const, interval: str("kind-every-interval") ?? "" };
    }
    if (selections.kindMode === "at") {
      return { kind: "at" as const, at: str("kind-at-value") ?? "" };
    }
    return {
      kind: "cron" as const,
      expression: str("kind-cron-expression") ?? "",
      timezone: str("kind-cron-timezone"),
    };
  })();

  const delivery = (() => {
    if (selections.deliveryMode === "none") return { mode: "none" as const };
    return {
      mode: "announce" as const,
      chatId: str("delivery-chatId") ?? "",
      channelType: str("delivery-channelType"),
      accountId: str("delivery-accountId"),
    };
  })();

  const timeoutMin = form.get("timeoutMin");
  const timeoutMs =
    typeof timeoutMin === "string" && timeoutMin.length > 0 && Number(timeoutMin) > 0
      ? Number(timeoutMin) * 60_000
      : undefined;

  const sessionTargetRaw = str("sessionTarget");
  const sessionTarget =
    sessionTargetRaw === undefined
      ? undefined
      : sessionTargetRaw === "isolated"
        ? ("isolated" as const)
        : (sessionTargetRaw as `session:${string}`);

  return {
    name: str("name") ?? "",
    schedule,
    prompt: str("prompt") ?? "",
    delivery,
    sessionTarget,
    model: str("model"),
    timeoutMs,
    // HTML Switch: checked → "on", unchecked → absent. Surface as boolean.
    enabled: form.get("enabled") === "on",
    deleteAfterRun: form.get("deleteAfterRun") === "on",
  };
}
