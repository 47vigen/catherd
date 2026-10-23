import { Chip, cn } from "@heroui/react";

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

/** A run's events, one line each, in the order given (newest first); the seqs in `arrived` came over the socket. */
export function Timeline({
  entries,
  now,
  arrived,
}: {
  entries: TimelineEntry[];
  now: Date;
  arrived?: ReadonlySet<number>;
}) {
  return (
    <ol aria-label="Timeline" className="divide-separator divide-y">
      {entries.map((e) => (
        <li
          key={e.seq}
          className={cn(
            "grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-[13px] md:grid-cols-[2.5rem_10rem_1fr_5rem]",
            arrived?.has(e.seq) && "row-arrive",
          )}
        >
          <span className="text-muted font-mono text-xs tabular-nums max-md:hidden">{e.seq}</span>
          <Chip size="sm" variant="soft" className="w-fit max-w-full">
            <Chip.Label className="truncate font-mono text-[11px]">{e.type}</Chip.Label>
          </Chip>
          <span className="min-w-0 break-words max-md:order-last max-md:col-span-3">{e.text}</span>
          <span className="text-muted text-end text-xs whitespace-nowrap tabular-nums max-md:col-start-3 max-md:row-start-1">
            {formatRelative(e.at, now)}
          </span>
        </li>
      ))}
    </ol>
  );
}
