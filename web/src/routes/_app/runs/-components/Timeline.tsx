import { Chip } from "@heroui/react";

import { filterIdOf, TIMELINE_FILTERS } from "../-lib/timeline-filters";
import type { TimelineEntry } from "../../../../client";
import { DataList } from "../../../../components/data-list/DataList";
import { formatRelative } from "../../../../lib/time";

/** Narrows the timeline to a group of events; `types` is the comma list the API takes, undefined for all. */
export function TimelineFilter({ types, onChange }: { types: string | undefined; onChange(types?: string): void }) {
  return (
    <DataList.Filter
      label="Type"
      value={filterIdOf(types)}
      options={TIMELINE_FILTERS}
      allLabel="All events"
      onChange={(id) => onChange(TIMELINE_FILTERS.find((f) => f.id === id)?.types)}
    />
  );
}

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
