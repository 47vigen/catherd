import {
  CircleCheck,
  CircleDashed,
  CircleExclamation,
  CirclePlay,
  CircleQuestion,
  CircleXmark,
  Flag,
  ListCheck,
  Pause,
  Pencil,
} from "@gravity-ui/icons";
import { cn } from "@heroui/react";
import type { ComponentType, SVGProps } from "react";

import { formatDuration } from "../-lib/node-view";
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

type Mark = { icon: ComponentType<SVGProps<SVGSVGElement>>; tone: string };

/** One icon and colour per kind of event, and the outcome read from its text where the type alone does not say. */
function markOf(e: TimelineEntry): Mark {
  const bad = /\b(failed|cancel|timeout|limit|refused|blocked)/i.test(e.text);
  switch (e.type) {
    case "dispatch.started":
      return { icon: CirclePlay, tone: "text-chart-1" };
    case "dispatch.ended":
      return bad ? { icon: CircleXmark, tone: "text-danger" } : { icon: CircleCheck, tone: "text-success" };
    case "check.requested":
      return { icon: CircleDashed, tone: "text-muted" };
    case "check.done":
      return bad ? { icon: CircleXmark, tone: "text-danger" } : { icon: ListCheck, tone: "text-success" };
    case "question.parked":
      return { icon: CircleQuestion, tone: "text-chart-5" };
    case "question.answered":
      return { icon: CircleCheck, tone: "text-chart-5" };
    case "ledger.changed":
    case "task.delegated":
    case "plan.approved":
      return { icon: Pencil, tone: "text-chart-4" };
    case "run.paused":
    case "cancel.requested":
      return { icon: Pause, tone: "text-warning" };
    case "run.ended":
      return bad ? { icon: CircleExclamation, tone: "text-danger" } : { icon: Flag, tone: "text-foreground" };
    default:
      return { icon: CircleDashed, tone: "text-muted" };
  }
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * A run's events on one rail, in the order given (newest first): the clock time and how far into the run, an icon for
 * the kind of event and its outcome, then the line itself. The seqs in `arrived` came over the socket.
 */
export function Timeline({
  entries,
  now,
  arrived,
  startedAt,
}: {
  entries: TimelineEntry[];
  now: Date;
  arrived?: ReadonlySet<number>;
  startedAt?: string;
}) {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  return (
    <ol aria-label="Timeline" className="py-2">
      {entries.map((e, i) => {
        const { icon: Icon, tone } = markOf(e);
        const at = new Date(e.at);
        const offset = Date.parse(e.at) - start;
        return (
          <li
            key={e.seq}
            className={cn(
              "group hover:bg-surface-secondary/60 grid grid-cols-[4.5rem_1.25rem_minmax(0,1fr)] gap-x-3 px-4 transition-colors md:grid-cols-[6.5rem_1.25rem_minmax(0,1fr)_auto]",
              arrived?.has(e.seq) && "row-arrive",
            )}
          >
            <span className="flex flex-col py-2 text-right font-mono text-[11px] leading-4 tabular-nums">
              <span title={at.toLocaleString()}>{Number.isNaN(at.getTime()) ? "–" : clock.format(at)}</span>
              <span className="text-muted">{Number.isFinite(offset) ? `+${formatDuration(offset / 1000)}` : ""}</span>
            </span>
            <span aria-hidden="true" className="relative flex justify-center">
              <span
                className={cn(
                  "bg-border absolute w-px",
                  i === 0 ? "top-3.5" : "top-0",
                  i === entries.length - 1 ? "h-3.5" : "bottom-0",
                )}
              />
              <span
                className={cn("bg-surface relative mt-2 flex size-5 items-center justify-center rounded-full", tone)}
              >
                <Icon className="size-3.5" />
              </span>
            </span>
            <span className="flex min-w-0 flex-col gap-0.5 py-2">
              <span className="text-foreground text-[13px] leading-5 break-words">{e.text}</span>
              <span className="text-muted font-mono text-[10.5px]">
                {e.type} · #{e.seq}
              </span>
            </span>
            <span className="text-muted py-2 text-xs whitespace-nowrap tabular-nums max-md:hidden">
              {formatRelative(e.at, now)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
