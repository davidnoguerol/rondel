"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import { createScheduleAction } from "./actions";
import { ScheduleForm } from "./ScheduleForm";

export function CreateScheduleDialog({ agent }: { agent: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">New schedule</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New schedule</DialogTitle>
          <DialogDescription>
            A runtime schedule owned by <code className="font-mono">{agent}</code>. Fires as
            specified; delivery and advanced options are optional.
          </DialogDescription>
        </DialogHeader>

        <ScheduleForm
          agent={agent}
          action={createScheduleAction}
          payloadField="input"
          submitLabel="Create schedule"
          onSuccess={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
