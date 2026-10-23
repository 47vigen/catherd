import { cn } from "@heroui/react";
import type { NodeProps } from "@xyflow/react";

import type { GroupNode } from "../../-lib/layout";
import { type Tone, toneOf } from "../../-lib/node-view";

const FRAME: Record<Tone, string> = {
  running: "border-success/60",
  success: "border-border",
  danger: "border-danger/60",
  warning: "border-warning/60",
  muted: "border-border border-dashed",
};
const DOT: Record<Tone, string> = {
  running: "bg-success motion-safe:animate-pulse",
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
  muted: "bg-muted",
};

/** A milestone as a stage: a labelled box around its steps, with where it stands and the commit it landed. */
export function MilestoneGroup({ data }: NodeProps<GroupNode>) {
  const tone = toneOf(data.nodes);
  return (
    // React Flow draws the steps as siblings of this box, not inside it, so it is a backdrop with a header only.
    <div className={cn("bg-surface/55 size-full rounded-lg border", FRAME[tone])}>
      <div className="flex h-10 items-center gap-2 px-4 pt-1">
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />
        <span className="label-caps text-foreground shrink-0">{data.milestone}</span>
        {data.title ? <span className="text-muted min-w-0 truncate text-xs">{data.title}</span> : null}
        {data.status ? <span className="label-caps text-muted ms-auto shrink-0">{data.status}</span> : null}
      </div>
    </div>
  );
}
