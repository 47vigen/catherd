import { CircleCheckFill, CircleDashed, CircleMinus, CircleQuestionFill, CircleXmarkFill } from "@gravity-ui/icons";
import { Chip, cn, Spinner } from "@heroui/react";
import { Handle, type NodeProps, Position } from "@xyflow/react";

import type { StepNode } from "../../-lib/layout";
import {
  formatDuration,
  modelName,
  nodeSecs,
  nodeView,
  nowLine,
  parseRung,
  shortTitle,
  STATUS_LABEL,
  type Tone,
} from "../../-lib/node-view";
import type { RunNode } from "../../../../../client";
import { ProviderIcon } from "../../../../../components/provider-icon/ProviderIcon";

// Status is a colour on the frame, a glyph and a word, never colour alone.
const FRAME: Record<Tone, string> = {
  running: "border-success ring-running",
  success: "border-success/40",
  danger: "border-danger bg-danger/5",
  warning: "border-warning bg-warning/5",
  muted: "border-border border-dashed",
};
const WORD: Record<Tone, string> = {
  running: "text-success",
  success: "text-muted",
  danger: "text-danger",
  warning: "text-warning",
  muted: "text-muted",
};

const glyph = "size-4 shrink-0";

export function StatusGlyph({ status }: { status: RunNode["status"] }) {
  switch (status) {
    case "running":
      return <Spinner size="sm" color="success" aria-hidden="true" className="size-4" />;
    case "done":
      return <CircleCheckFill aria-hidden="true" className={cn(glyph, "text-success")} />;
    case "failed":
      return <CircleXmarkFill aria-hidden="true" className={cn(glyph, "text-danger")} />;
    case "parked":
      return <CircleQuestionFill aria-hidden="true" className={cn(glyph, "text-warning")} />;
    case "pending":
      return <CircleDashed aria-hidden="true" className={cn(glyph, "text-muted")} />;
    default:
      return <CircleMinus aria-hidden="true" className={cn(glyph, "text-muted")} />;
  }
}

// The handles only anchor the edges: nothing is connected by hand.
const HANDLE = "size-px! min-h-0! min-w-0! border-0! bg-transparent! opacity-0";
export function Anchors() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className={HANDLE} />
      <Handle type="source" position={Position.Right} isConnectable={false} className={HANDLE} />
    </>
  );
}

const label = (n: RunNode) => [n.title, STATUS_LABEL[n.status], nowLine(n)].filter(Boolean).join(". ");

const BUTTON =
  "nopan nodrag focus-visible:outline-focus text-left transition-[border-color,background-color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2";

/** One step of the run: its status, what it is doing now, who does it on which model, and how long it took. */
export function NodeCard({ data, selected }: NodeProps<StepNode>) {
  const n = data.node;
  const view = nodeView(n);
  const secs = nodeSecs(n, data.now);
  const rung = n.rung && n.kind !== "check" ? parseRung(n.rung) : null;
  const line = nowLine(n);

  return (
    <div className={cn("relative size-full", view.muted && "opacity-70")} data-status={n.status}>
      <Anchors />
      <button
        type="button"
        aria-label={label(n)}
        aria-current={selected ? "true" : undefined}
        onClick={() => data.onOpen?.(n.id)}
        className={cn(
          BUTTON,
          "bg-surface hover:bg-surface-secondary flex size-full flex-col justify-center gap-1 rounded-md border px-3 shadow-xs",
          FRAME[view.tone],
          selected && "outline-focus outline-2 outline-offset-2",
        )}
      >
        <span className="flex h-5 items-center gap-2">
          <StatusGlyph status={n.status} />
          <span className="text-foreground min-w-0 flex-1 truncate text-[13px] leading-5 font-medium">
            {shortTitle(n)}
          </span>
          {secs !== null ? (
            <span className="text-muted shrink-0 font-mono text-[11px] tabular-nums">{formatDuration(secs)}</span>
          ) : null}
        </span>
        {/* A done step says so with its glyph and frame; any other status, or what it is doing, gets a line. */}
        {line || n.status !== "done" ? (
          <span className={cn("truncate ps-6 text-xs leading-4", WORD[view.tone])} title={line ?? undefined}>
            {line ?? STATUS_LABEL[n.status]}
          </span>
        ) : null}
        {rung || view.badge ? (
          <span className="flex h-4 items-center gap-1.5 ps-6">
            {rung ? (
              <span className="text-muted flex min-w-0 flex-1 items-center gap-1.5 text-[11px]" title={n.rung ?? ""}>
                <ProviderIcon backend={rung.backend} size="xs" />
                <span className="truncate">
                  {rung.model ? modelName(rung.model) : rung.backend}
                  {rung.effort ? <span className="text-muted/70"> · {rung.effort}</span> : null}
                </span>
              </span>
            ) : (
              <span className="flex-1" />
            )}
            {view.badge ? (
              <Chip
                size="sm"
                variant="soft"
                color={n.status === "parked" ? "warning" : "default"}
                className="h-4 shrink-0"
              >
                <Chip.Label className="text-[10px]">{view.badge}</Chip.Label>
              </Chip>
            ) : null}
          </span>
        ) : null}
      </button>
    </div>
  );
}

/** The start and the end of the run: small pills, since they only mark where the flow begins and stops. */
export function EndPill({ data, selected }: NodeProps<StepNode>) {
  const n = data.node;
  const view = nodeView(n);
  return (
    <div className="relative size-full" data-status={n.status}>
      <Anchors />
      <button
        type="button"
        aria-label={label(n)}
        aria-current={selected ? "true" : undefined}
        onClick={() => data.onOpen?.(n.id)}
        className={cn(
          BUTTON,
          "bg-surface hover:bg-surface-secondary flex size-full items-center justify-center gap-1.5 rounded-full border text-xs font-medium shadow-xs",
          FRAME[view.tone],
          selected && "outline-focus outline-2 outline-offset-2",
        )}
      >
        <StatusGlyph status={n.status} />
        {n.kind === "start" ? "Start" : "End"}
      </button>
    </div>
  );
}
