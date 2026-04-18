"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const isDark = mounted ? resolvedTheme === "dark" : true;
  const next = isDark ? "light" : "dark";
  const label = `Switch to ${next} mode`;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setTheme(next)}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-md",
        "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <Sun
        className={cn(
          "size-4 transition-all",
          isDark ? "-rotate-90 scale-0" : "rotate-0 scale-100"
        )}
      />
      <Moon
        className={cn(
          "absolute size-4 transition-all",
          isDark ? "rotate-0 scale-100" : "rotate-90 scale-0"
        )}
      />
    </button>
  );
}
