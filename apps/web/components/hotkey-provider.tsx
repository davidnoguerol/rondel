"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { useHotkeys } from "react-hotkeys-hook";

/**
 * Global keyboard shortcut layer.
 *
 * ⌘K is bound inside CommandPalette itself (because the palette owns its
 * open state). Everything else — navigation and theme toggle — lives here
 * so the bindings work regardless of whether the palette has been opened.
 *
 * `g a` / `g p` are two-key sequences in the Linear style. Handled via
 * react-hotkeys-hook's `>` separator.
 */
export function HotkeyProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();

  useHotkeys("g>a", () => router.push("/agents"));
  useHotkeys("g>p", () => router.push("/approvals"));
  useHotkeys("mod+.", (event) => {
    event.preventDefault();
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  });

  return <>{children}</>;
}
