"use client";

import { Command as CommandIcon, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import { useCommandPalette } from "@/components/command-palette";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ApprovalRecord } from "@/lib/bridge";
import { useApprovalStream } from "@/lib/streams/use-approval-stream";
import { cn } from "@/lib/utils";
import { breadcrumbs } from "./breadcrumbs";

type Props = {
  initialPending: readonly ApprovalRecord[];
  initialResolved: readonly ApprovalRecord[];
};

/**
 * Dashboard top bar. Breadcrumbs on the left; palette trigger, approvals
 * indicator, and theme toggle on the right.
 */
export function TopBar({ initialPending, initialResolved }: Props) {
  const pathname = usePathname();
  const crumbs = breadcrumbs(pathname);
  const { toggle: togglePalette } = useCommandPalette();

  const { pending } = useApprovalStream({
    initialPending,
    initialResolved,
    resolvedLimit: 0,
  });
  const pendingCount = pending.length;

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-border bg-background/85 px-4 backdrop-blur-md">
      <Link
        href="/"
        className="flex items-center gap-2 pr-2 font-semibold tracking-tight text-foreground"
      >
        Rondel
      </Link>
      <Separator orientation="vertical" className="h-6" />

      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList>
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1;
            return (
              <Fragment key={`${crumb.href}-${i}`}>
                <BreadcrumbItem>
                  {last ? (
                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <Link href={crumb.href}>{crumb.label}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {!last && <BreadcrumbSeparator />}
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              variant="ghost"
              size="icon"
              className={cn(
                "relative",
                pendingCount > 0 && "text-foreground"
              )}
            >
              <Link href="/approvals" aria-label="Approvals">
                <ShieldCheck className="size-4" />
                {pendingCount > 0 && (
                  <Badge
                    variant="destructive"
                    className={cn(
                      "absolute -right-1 -top-1 h-4 min-w-4 rounded-full px-1 text-[10px] tabular-nums"
                    )}
                  >
                    {pendingCount > 9 ? "9+" : pendingCount}
                  </Badge>
                )}
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Approvals · g p</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={togglePalette}
              className="gap-2"
            >
              <CommandIcon className="size-3.5" />
              <span className="text-xs text-muted-foreground">Search</span>
              <kbd className="ml-1 hidden rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-block">
                ⌘K
              </kbd>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Command menu</TooltipContent>
        </Tooltip>

        <ThemeToggle />
      </div>
    </header>
  );
}

