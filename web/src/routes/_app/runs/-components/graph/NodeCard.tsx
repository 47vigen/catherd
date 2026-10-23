import { CircleCheckFill, CircleDashed, CircleMinus, CircleQuestionFill, CircleXmarkFill } from "@gravity-ui/icons";
import { Chip, cn, Spinner } from "@heroui/react";
import { Handle, type NodeProps, Position } from "@xyflow/react";

import type { StepNode } from "../../-lib/layout";
import { formatDuration, nodeSecs, nodeView, parseRung, STATUS_LABEL, type Tone } from "../../-lib/node-view";
import { ProviderIcon } from "../../../../../components/provider-icon/ProviderIcon";

// Frame, icon tile and status mark per tone: status is colour plus a glyph plus a word, never colour alone.
const FRAME: Record<Tone, string> = {
  running: "border-success ring-running",
  success: "border-success/45",
  danger: "border-danger",
  warning: "border-warning",
  muted: "border-border border-dashed",
};
const TILE: Record<Tone, string> = {
  running: "bg-success/15 text-success",
  success: "bg-success/12 text-success",
  danger: "bg-danger/12 text-danger",
  warning: "bg-warning/20 text-warning",
  muted: "bg-surface-tertiary text-muted",
};

const iconClass = "size-4 shrink-0";

function StatusMark({ status }: { status: StepNode["data"]["node"]["status"] }) {
  switch (status) {
    case "running":
      return <Spinner size="sm" color="success" aria-hidden="true" />;
    case "done":
      return <CircleCheckFill aria-hidden="true" className={cn(iconClass, "text-success")} />;
    case "failed":
      return <CircleXmarkFill aria-hidden="true" className={cn(iconClass, "text-danger")} />;
    case "parked":
      return <CircleQuestionFill aria-hidden="true" className={cn(iconClass, "text-warning")} />;
    case "pending":
      return <CircleDashed aria-hidden="true" className={cn(iconClass, "text-muted")} />;
    default:
      return <CircleMinus aria-hidden="true" className={cn(iconClass, "text-muted")} />;
  }
}

/** One step of the run: what it is, where it stands, what it is doing now, and who is doing it. */
export function NodeCard({ data, selected }: NodeProps<StepNode>) {
  const n = data.node;
  const view = nodeView(n);
  const Icon = view.icon;
  const secs = nodeSecs(n, data.now);
  const rung = n.rung && n.kind !== "check" ? parseRung(n.rung) : null;
  const status = STATUS_LABEL[n.status];

  return (
    <div className={cn("relative", view.muted && "opacity-60")} data-status={n.status}>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="size-px! min-h-0! min-w-0! border-0! bg-transparent!"
      />
      <button
        type="button"
        aria-label={`${n.title}. ${status}. ${n.now}`}
        aria-current={selected ? "true" : undefined}
        onClick={() => data.onOpen?.(n.id)}
        className={cn(
          "nopan nodrag bg-surface focus-visible:outline-focus flex flex-col justify-between rounded-sm border p-2.5 text-left transition-[border-color,background-color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2",
          "h-[84px] w-[232px] hover:bg-surface-secondary",
          FRAME[view.tone],
          selected && "bg-surface-secondary outline-focus outline-2 outline-offset-2",
        )}
      >
        <span className="flex items-center gap-2">
          <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-sm", TILE[view.tone])}>
            <Icon aria-hidden="true" className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] leading-5 font-medium">{n.title}</span>
          <StatusMark status={n.status} />
          <span className="sr-only">{status}</span>
        </span>
        <span className="text-muted truncate text-xs leading-4" title={n.now}>
          {n.now}
        </span>
        <span className="flex h-5 items-center gap-1.5">
          {rung ? (
            <span
              className="text-muted flex min-w-0 flex-1 items-center gap-1 font-mono text-[11px]"
              title={n.rung ?? undefined}
            >
              <ProviderIcon backend={rung.backend} size="xs" />
              <span className="truncate">
                {rung.model || rung.backend}
                {rung.effort ? ` · ${rung.effort}` : ""}
              </span>
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {view.badge ? (
            <Chip size="sm" variant="soft" color={n.status === "parked" ? "warning" : "default"} className="shrink-0">
              <Chip.Label className="text-[10px]">{view.badge}</Chip.Label>
            </Chip>
          ) : null}
          {secs !== null ? (
            <span className="text-muted shrink-0 font-mono text-[11px] tabular-nums">{formatDuration(secs)}</span>
          ) : null}
        </span>
      </button>
    </div>
  );
}
