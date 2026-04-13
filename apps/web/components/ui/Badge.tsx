import type { HTMLAttributes } from "react";

type BadgeTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "muted";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-surface-muted text-ink",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
  info: "bg-accent/10 text-accent",
  muted: "bg-surface-muted text-ink-subtle",
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({
  tone = "neutral",
  className = "",
  ...rest
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${TONE_CLASSES[tone]} ${className}`}
      {...rest}
    />
  );
}
