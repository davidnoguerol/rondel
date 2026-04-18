/**
 * Pure helpers for the TopBar breadcrumbs.
 *
 * Extracted from topbar.tsx so they can be unit-tested without pulling
 * in the `"use client"` React/Next chain. The component re-exports
 * these for its own use — there's one source of truth.
 */

export type Crumb = { label: string; href: string };

/**
 * Pathname → breadcrumb segments.
 * Well-known static segments get title-cased labels; dynamic segments
 * (agent name, chat id, …) are URI-decoded for display while the raw
 * encoded form is preserved in the href.
 */
export function breadcrumbs(pathname: string): Crumb[] {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return [{ label: "Home", href: "/" }];

  const crumbs: Crumb[] = [];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({ label: labelFor(part), href: acc });
  }
  return crumbs;
}

export function labelFor(segment: string): string {
  const known: Record<string, string> = {
    agents: "Agents",
    approvals: "Approvals",
    chat: "Chat",
    ledger: "Ledger",
    memory: "Memory",
    telegram: "Telegram",
    web: "Web",
    internal: "Internal",
  };
  if (known[segment]) return known[segment];
  // Dynamic segment — decode so "%20" etc. renders as its original form.
  // Fall back to the raw segment if decoding fails (malformed input).
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
