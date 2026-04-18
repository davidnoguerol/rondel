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
import type { ScheduleSummary } from "@/lib/bridge";

import { updateScheduleAction } from "./actions";
import { ScheduleForm } from "./ScheduleForm";

export function EditScheduleDialog({
  agent,
  schedule,
}: {
  agent: string;
  schedule: ScheduleSummary;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit schedule</DialogTitle>
          <DialogDescription>
            <code className="font-mono">{schedule.name}</code> — changing the schedule kind or
            enabled flag resets the next fire time.
          </DialogDescription>
        </DialogHeader>

        <ScheduleForm
          agent={agent}
          scheduleId={schedule.id}
          initial={schedule}
          action={updateScheduleAction}
          payloadField="patch"
          submitLabel="Save changes"
          onSuccess={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
