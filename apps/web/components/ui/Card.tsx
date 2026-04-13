import type { HTMLAttributes } from "react";

type DivProps = HTMLAttributes<HTMLDivElement>;

/** Base surface — the one container primitive every screen composes. */
export function Card({ className = "", ...rest }: DivProps) {
  return (
    <div
      className={`bg-surface-raised border border-border rounded-lg ${className}`}
      {...rest}
    />
  );
}

export function CardHeader({ className = "", ...rest }: DivProps) {
  return (
    <div
      className={`px-5 py-4 border-b border-border ${className}`}
      {...rest}
    />
  );
}

export function CardBody({ className = "", ...rest }: DivProps) {
  return <div className={`px-5 py-4 ${className}`} {...rest} />;
}

export function CardTitle({
  className = "",
  ...rest
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={`text-sm font-semibold text-ink ${className}`}
      {...rest}
    />
  );
}
