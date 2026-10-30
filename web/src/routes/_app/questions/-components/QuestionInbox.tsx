import { cn } from "@heroui/react";
import type { KeyboardEvent } from "react";

import type { QuestionView } from "../../../../client";
import { formatRelative } from "../../../../lib/time";
import { keyOf, reasonLabel, waited } from "./wait";

const DOT = { "text-danger": "bg-danger", "text-warning": "bg-warning", "text-muted": "bg-muted/60" } as const;

/** The questions as an inbox: run, unit, reason and wait, the selected one marked; ↑ and ↓ move through them. */
export function QuestionInbox({
  items,
  selected,
  now,
  onSelect,
}: {
  items: QuestionView[];
  selected: string | undefined;
  now: Date;
  onSelect: (key: string) => void;
}) {
  const move = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const at = items.findIndex((q) => keyOf(q) === selected);
    const next = items[Math.min(items.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    onSelect(keyOf(next));
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(keyOf(next))}"]`)?.focus();
  };
  return (
    <ul aria-label="Waiting questions" className="divide-separator divide-y" onKeyDown={move}>
      {items.map((q) => {
        const key = keyOf(q);
        const wait = waited(q.at, now);
        const active = key === selected;
        return (
          <li key={key}>
            <button
              type="button"
              data-key={key}
              aria-current={active ? "true" : undefined}
              onClick={() => onSelect(key)}
              className={cn(
                "relative flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors outline-offset-[-2px]",
                "focus-visible:outline-accent hover:bg-surface-secondary/70",
                active && "bg-surface-secondary",
              )}
            >
              {active ? <span aria-hidden="true" className="bg-accent absolute inset-y-0 left-0 w-0.5" /> : null}
              <span className="flex min-w-0 items-center gap-2 text-xs">
                <span
                  aria-hidden="true"
                  className={cn("size-1.5 shrink-0 rounded-full", DOT[wait.tone as keyof typeof DOT])}
                />
                <span className="text-foreground min-w-0 truncate font-medium">{q.runTitle}</span>
                {q.unit !== "run" ? <span className="text-muted shrink-0 font-mono">{q.unit}</span> : null}
                <span className={cn("ml-auto shrink-0 tabular-nums", wait.tone)}>{formatRelative(q.at, now)}</span>
              </span>
              <span className="line-clamp-2 text-[13px] leading-5 break-words">{q.question}</span>
              <span className="text-muted font-mono text-[10.5px]">{reasonLabel(q.reason)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
