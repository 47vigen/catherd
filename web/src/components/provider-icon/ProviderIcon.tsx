import { cn } from "@heroui/react";

import { MARKS } from "./marks";

export type Provider = "anthropic" | "openai" | "opencode" | "cursor";

const PROVIDER: Record<string, Provider> = {
  claude: "anthropic",
  "claude-code": "anthropic",
  codex: "openai",
  opencode: "opencode",
  "opencode-go": "opencode",
  cursor: "cursor",
};

const MARK = {
  anthropic: MARKS.anthropic,
  openai: MARKS.openai,
  opencode: MARKS["opencode-go"],
  cursor: MARKS.cursor,
};

const NAME: Record<string, string> = {
  "claude-code": "Claude Code",
  claude: "Claude",
  codex: "Codex",
  opencode: "opencode",
  "opencode-go": "opencode",
  cursor: "Cursor",
};

/** The backend id of a backend or a rung (`backend:model#effort`). */
const backendId = (backendOrRung: string) => backendOrRung.split(":")[0]!;

export function providerOf(backendOrRung: string): Provider | null {
  return PROVIDER[backendId(backendOrRung)] ?? null;
}

export function backendName(backendOrRung: string): string {
  const id = backendId(backendOrRung);
  return NAME[id] ?? id;
}

const SIZE = {
  xs: { px: 16, box: "size-4 text-[9px]" },
  sm: { px: 20, box: "size-5 text-[10px]" },
  md: { px: 24, box: "size-6 text-xs" },
} as const;

/** The decorative mark of a backend; a letter for one without a mark. The name always sits next to it. */
export function ProviderIcon({
  backend,
  size = "sm",
  className,
}: {
  backend: string;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const provider = providerOf(backend);
  const Mark = provider ? MARK[provider] : null;
  const { px, box } = SIZE[size];
  return (
    <span aria-hidden="true" className={cn("text-foreground inline-flex shrink-0", className)}>
      {Mark ? (
        <Mark size={px} />
      ) : (
        <span
          className={cn(
            "border-border bg-surface-secondary text-muted inline-flex items-center justify-center rounded-sm border font-mono font-medium",
            box,
          )}
        >
          {(backendName(backend)[0] ?? "?").toUpperCase()}
        </span>
      )}
    </span>
  );
}
