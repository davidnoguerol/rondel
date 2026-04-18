"use client";

import {
  Bot,
  Brain,
  LayoutDashboard,
  Moon,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useHotkeys } from "react-hotkeys-hook";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import type { AgentSummary } from "@/lib/bridge";

type Ctx = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
};

const CommandPaletteContext = createContext<Ctx | null>(null);

export function useCommandPalette(): Ctx {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) {
    throw new Error(
      "useCommandPalette must be used inside <CommandPaletteProvider>"
    );
  }
  return ctx;
}

export function CommandPaletteProvider({
  agents,
  children,
}: {
  agents: readonly AgentSummary[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  useHotkeys(
    "mod+k",
    (event) => {
      event.preventDefault();
      toggle();
    },
    { enableOnFormTags: true, enableOnContentEditable: true }
  );

  const value = useMemo(() => ({ open, setOpen, toggle }), [open, toggle]);

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <Palette agents={agents} open={open} onOpenChange={setOpen} />
    </CommandPaletteContext.Provider>
  );
}

function Palette({
  agents,
  open,
  onOpenChange,
}: {
  agents: readonly AgentSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();

  const close = () => onOpenChange(false);

  const go = (href: string) => {
    close();
    router.push(href);
  };

  const toggleTheme = () => {
    close();
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command menu"
      description="Search agents, navigate, change preferences"
    >
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        <CommandGroup heading="Navigate">
          <CommandItem onSelect={() => go("/agents")}>
            <LayoutDashboard className="size-4" />
            All agents
          </CommandItem>
          <CommandItem onSelect={() => go("/approvals")}>
            <ShieldCheck className="size-4" />
            Approvals
          </CommandItem>
        </CommandGroup>

        {agents.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Agents">
              {agents.map((agent) => (
                <CommandItem
                  key={`chat-${agent.name}`}
                  value={`chat ${agent.name} ${agent.org ?? ""}`}
                  onSelect={() => go(`/agents/${agent.name}/chat`)}
                >
                  <Bot className="size-4" />
                  <span className="flex-1">{agent.name}</span>
                  {agent.org && (
                    <span className="text-[11px] text-muted-foreground">
                      org · {agent.org}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>

            <CommandSeparator />
            <CommandGroup heading="Memory">
              {agents.map((agent) => (
                <CommandItem
                  key={`memory-${agent.name}`}
                  value={`memory ${agent.name}`}
                  onSelect={() => go(`/agents/${agent.name}/memory`)}
                >
                  <Brain className="size-4" />
                  Memory — {agent.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="Preferences">
          <CommandItem onSelect={toggleTheme}>
            {resolvedTheme === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
            Switch to {resolvedTheme === "dark" ? "light" : "dark"} mode
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
