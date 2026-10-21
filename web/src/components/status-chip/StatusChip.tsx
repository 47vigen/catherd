import { Chip, cn } from "@heroui/react";

export type Status =
  | "running"
  | "planning"
  | "approval"
  | "parked"
  | "held"
  | "done"
  | "cancelled"
  | "failed"
  | "alive"
  | "dead"
  | "ok"
  | "warn"
  | "fail"
  | "skip"
  | "info";

type ChipColor = "success" | "warning" | "danger" | "default";

const COLORS: Record<Status, ChipColor> = {
  running: "success",
  done: "success",
  alive: "success",
  ok: "success",
  planning: "warning",
  approval: "warning",
  parked: "warning",
  held: "warning",
  warn: "warning",
  failed: "danger",
  dead: "danger",
  fail: "danger",
  cancelled: "default",
  skip: "default",
  info: "default",
};

const DOT: Record<ChipColor, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  default: "bg-muted",
};

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** `label` replaces the status word when a row has a word of its own ("missing" on a failed check). */
export function StatusChip({ status, until, label: word }: { status: Status; until?: string; label?: string }) {
  const color = COLORS[status];
  const label = (word ?? status).charAt(0).toUpperCase() + (word ?? status).slice(1);
  const end = status === "held" && until ? new Date(until) : undefined;
  return (
    <Chip color={color} variant="soft" size="sm" data-color={color} className="gap-1.5 pl-1.5">
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT[color])} />
      <Chip.Label className="text-[11px]">
        {label}
        {end && !Number.isNaN(end.getTime()) ? (
          <>
            {" until "}
            <time dateTime={until}>{timeFormat.format(end)}</time>
          </>
        ) : null}
      </Chip.Label>
    </Chip>
  );
}
