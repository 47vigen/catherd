import { Chip } from "@heroui/react";

import type { TimelineEntry } from "../../../../client";
import { formatRelative } from "../../../../lib/time";

/** A run's events, one line each, in the order given (newest first). */
export function Timeline({ entries, now }: { entries: TimelineEntry[]; now: Date }) {
  return (
    <ol aria-label="Timeline" className="border-border bg-surface divide-border divide-y rounded-sm border">
      {entries.map((e) => (
        <li key={e.seq} className="grid grid-cols-[3rem_5rem_9rem_1fr] items-baseline gap-3 px-3 py-2 text-[13px]">
          <span className="text-muted font-mono text-xs tabular-nums">{e.seq}</span>
          <span className="text-muted whitespace-nowrap">{formatRelative(e.at, now)}</span>
          <Chip size="sm" variant="soft" className="w-fit">
            <Chip.Label className="font-mono text-[11px]">{e.type}</Chip.Label>
          </Chip>
          <span className="min-w-0 break-words">{e.text}</span>
        </li>
      ))}
    </ol>
  );
}
