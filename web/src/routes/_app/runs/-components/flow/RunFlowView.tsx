import { Button, Chip, cn } from "@heroui/react";
import { useRef, useState } from "react";

import { useFlowFollow } from "../../-hooks/useFlowFollow";
import { flowGeometry, stackIntervals } from "../../-lib/flow-view";
import { formatCost } from "../../-lib/format";
import { formatDuration } from "../../-lib/node-view";
import type { FlowSelection, RunFlow, RunView } from "../../../../../client";

type Bar = {
  id: string;
  label: string;
  detail: string;
  x: number;
  width: number;
  family: string;
  tone?: string;
  selection?: FlowSelection;
  marker?: string;
  unknown?: boolean;
  idleReason?: RunFlow["idle"][number]["reason"];
};
type Row = { id: string; goal?: string; state?: string; depends?: string[]; bars: Bar[] };
const FAMILY: Record<string, string> = {
  worker: "fill-accent",
  writer: "fill-accent",
  artist: "fill-accent",
  reviewer: "fill-success",
  verifier: "fill-success",
  researcher: "fill-warning",
  architect: "fill-foreground",
  check: "fill-muted",
};
const IDLE = { owner: "Owner", quota: "Quota", check: "Check", gap: "Gap" };
const IDLE_FILL = {
  owner: "fill-accent/20",
  quota: "fill-warning/20",
  check: "fill-chart-2/20",
  gap: "fill-surface-tertiary",
};

export function RunFlowView({
  flow,
  run,
  now,
  selected,
  onOpen,
  onExpand,
  fill,
}: {
  flow: RunFlow;
  run: RunView;
  now: number;
  selected?: string;
  onOpen: (selection: FlowSelection) => void;
  onExpand?: () => void;
  fill?: boolean;
}) {
  const geometry = flowGeometry(flow, now);
  const live = flow.endedAt === null && run.phase !== "ended";
  const track = useRef<HTMLElement>(null);
  const follow = useFlowFollow(track, live, geometry.nowX);
  const [detail, setDetail] = useState<string | null>(null);
  const dispatchBar = (d: RunFlow["dispatches"][number]): Bar => {
    const interval = geometry.interval(d.startedAt, d.endedAt);
    const duration = formatDuration(
      Math.max(0, ((d.endedAt ? Date.parse(d.endedAt) : geometry.end) - Date.parse(d.startedAt)) / 1000),
    );
    const status = d.status === "ok" ? (d.replyStatus ?? "done") : d.status;
    const marker = [
      d.status === "limit" ? "△ Limit" : null,
      d.climbFrom ? `↗ Rung changed: ${d.climbFrom} → ${d.rung}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      ...interval,
      id: d.dispatchId,
      label: `${d.name} ${d.role} · ${status}`,
      detail: `${d.name} · ${d.role} · ${d.rung} · ${d.status} · ${duration}${d.ledgerTask ? ` · ${d.ledgerTask}` : ""}${marker ? ` · ${marker}` : ""}`,
      family: d.role,
      selection: d.selection,
      marker,
      tone:
        d.status === "limit"
          ? "warning"
          : ["failed", "timeout", "cli-too-old", "cancelled"].includes(d.status)
            ? "danger"
            : undefined,
    };
  };
  const assigned = new Set(flow.tasks.flatMap((t) => t.dispatchIds));
  const rows: Row[] = [
    { id: "Architect", bars: flow.architect.map(dispatchBar) },
    ...flow.tasks.map((t) => ({
      id: t.id,
      goal: t.goal,
      state: t.state,
      depends: t.depends,
      bars: flow.dispatches.filter((d) => t.dispatchIds.includes(d.dispatchId)).map(dispatchBar),
    })),
  ];
  const unassigned = flow.dispatches.filter((d) => !assigned.has(d.dispatchId));
  if (unassigned.length) rows.push({ id: "Unassigned roles", bars: unassigned.map(dispatchBar) });
  if (flow.checks.length)
    rows.push({
      id: "Run checks",
      bars: flow.checks.map((c) => {
        const interval = c.startedAt
          ? geometry.interval(c.startedAt, c.endedAt)
          : { x: c.endedAt ? geometry.x(c.endedAt) : 16, width: 2 };
        const status = c.endedAt ? (c.verdict ?? (c.exit === 0 ? "pass" : "failed")) : "running";
        return {
          ...interval,
          id: c.checkId,
          label: `${c.checkId} check · ${status}`,
          detail: `${c.checkId} · check · ${c.scope} · ${status} · ${c.startedAt ? formatDuration(Math.max(0, ((c.endedAt ? Date.parse(c.endedAt) : geometry.end) - Date.parse(c.startedAt)) / 1000)) : "Timing unknown"}`,
          family: "check",
          selection: c.selection,
          tone: c.endedAt && c.exit !== 0 ? "danger" : undefined,
          unknown: c.startedAt === null,
        };
      }),
    });
  rows.push({
    id: "Idle",
    bars: flow.idle.map((i, index) => ({
      ...geometry.interval(i.startedAt, i.endedAt),
      id: `idle-${index}`,
      label: IDLE[i.reason],
      detail: `Idle · ${IDLE[i.reason]}`,
      family: "idle",
      idleReason: i.reason,
    })),
  });
  let y = 32;
  const positioned = rows.map((row) => {
    const tracks = stackIntervals(row.bars);
    const height = Math.max(64, (Math.max(-1, ...tracks) + 1) * 42 + 16);
    const placed = { ...row, y, height, tracks };
    y += height;
    return placed;
  });
  const m = run.metrics;
  const stats = [
    ["State", run.outcome ?? run.phase ?? "–"],
    ["Wall time", m ? formatDuration(m.wallMin * 60) : "–"],
    ["Idle", m ? `${Math.round(m.idlePct)}%` : "–"],
    ["Concurrency", m ? m.concurrency.toFixed(2) : "–"],
    ["Check share", m?.checkShare == null ? "–" : `${Math.round(m.checkShare * 100)}%`],
    ["Review rounds", m ? String(m.rounds.total) : "–"],
    ["Cost", m?.costUsd == null ? "–" : formatCost(m.costUsd)],
  ];
  const tickStep = Math.max(30, Math.ceil((geometry.end - Date.parse(flow.startedAt)) / 1000 / 12 / 30) * 30);
  const ticks = Array.from(
    { length: Math.floor((geometry.end - Date.parse(flow.startedAt)) / 1000 / tickStep) + 1 },
    (_, i) => i * tickStep,
  );
  return (
    <section
      aria-label="Run flow"
      className={cn("min-w-0 max-w-full", fill && "flex flex-1 flex-col overflow-y-auto pt-16")}
    >
      <dl
        aria-label="Run statistics"
        className="border-border grid grid-cols-2 gap-x-5 gap-y-3 border-b px-4 py-4 sm:grid-cols-4 xl:grid-cols-7"
      >
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted text-xs">{label}</dt>
            <dd className="mt-1 font-mono text-sm tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="text-muted flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-xs">
        <span className="text-foreground">● Architect</span>
        <span className="text-foreground">
          <span aria-hidden="true" className="text-accent">
            ●
          </span>{" "}
          Worker / writer / artist
        </span>
        <span className="text-foreground">
          <span aria-hidden="true" className="text-success">
            ●
          </span>{" "}
          Reviewer / verifier
        </span>
        <span className="text-foreground">
          <span aria-hidden="true" className="text-warning">
            ●
          </span>{" "}
          Researcher
        </span>
        <span className="text-foreground">▧ Check</span>
        {live ? (
          <Button size="sm" variant="tertiary" onPress={follow.resume} isDisabled={follow.following}>
            Follow now
          </Button>
        ) : null}
        {onExpand ? (
          <Button size="sm" variant="tertiary" onPress={onExpand}>
            Full screen
          </Button>
        ) : null}
      </div>
      {!flow.architect.length && !flow.dispatches.length && !flow.checks.length ? (
        <p className="text-muted px-4 py-2 text-sm">No activity recorded yet.</p>
      ) : null}
      <div className="flex max-w-full min-w-0">
        <svg width="152" height={y} className="bg-surface sticky left-0 z-10 w-[152px] shrink-0" aria-label="Flow rows">
          {positioned.map((row) => (
            <g key={row.id}>
              <line x1="0" x2="152" y1={row.y} y2={row.y} className="stroke-border" />
              <foreignObject x="0" y={row.y + 6} width="152" height={row.height - 6}>
                <div className="flex min-w-0 flex-col gap-1 px-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs">{row.id}</span>
                    {row.state ? (
                      <Chip size="sm" variant="soft">
                        <Chip.Label className="text-[10px]">{row.state}</Chip.Label>
                      </Chip>
                    ) : null}
                  </div>
                  {row.goal ? (
                    <span className="truncate text-xs" title={row.goal}>
                      {row.goal}
                    </span>
                  ) : null}
                  {row.depends?.length ? (
                    <span
                      className="text-muted truncate font-mono text-[10px]"
                      title={`Depends on ${row.depends.join(", ")}`}
                    >
                      Depends on {row.depends.join(", ")}
                    </span>
                  ) : null}
                </div>
              </foreignObject>
            </g>
          ))}
        </svg>
        <section
          ref={track}
          aria-label="Flow timeline"
          className="max-w-full min-w-0 flex-1 overflow-x-auto overscroll-x-contain"
        >
          <svg
            width={geometry.width}
            height={y}
            viewBox={`0 0 ${geometry.width} ${y}`}
            className="font-mono text-[10px] tabular-nums"
          >
            {ticks.map((s) => (
              <g key={s}>
                <line x1={16 + s * 2} x2={16 + s * 2} y1="24" y2={y} className="stroke-border/40" />
                <text x={16 + s * 2} y="17" className="fill-muted">
                  {formatDuration(s)}
                </text>
              </g>
            ))}
            {positioned.map((row) => (
              <g key={row.id}>
                <line x1="0" x2={geometry.width} y1={row.y} y2={row.y} className="stroke-border" />
                {row.bars.map((bar, i) => {
                  const top = row.y + 7 + row.tracks[i]! * 42;
                  return (
                    <g
                      key={bar.id}
                      role={bar.selection ? "button" : undefined}
                      tabIndex={bar.selection ? 0 : undefined}
                      aria-label={bar.selection ? `${bar.label}. ${bar.detail}` : undefined}
                      aria-pressed={bar.selection ? selected === bar.selection.nodeId : undefined}
                      data-tone={bar.tone}
                      data-idle-reason={bar.idleReason}
                      className="group cursor-pointer outline-none"
                      onClick={() => bar.selection && onOpen(bar.selection)}
                      onKeyDown={(e) => {
                        if (bar.selection && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          onOpen(bar.selection);
                        }
                      }}
                      onMouseEnter={() => setDetail(bar.detail)}
                      onMouseLeave={() => setDetail(null)}
                      onFocus={() => setDetail(bar.detail)}
                      onBlur={() => setDetail(null)}
                    >
                      <rect
                        x={bar.x}
                        y={top}
                        width={Math.max(28, bar.width)}
                        height="28"
                        rx="3"
                        className="group-focus-visible:stroke-accent fill-transparent"
                      />
                      {bar.unknown ? (
                        <g>
                          <path
                            data-timing-unknown="true"
                            d={`M ${bar.x + 7} ${top + 7} l 7 7 l -7 7 l -7 -7 Z`}
                            strokeWidth="2"
                            className={cn("fill-surface", bar.tone === "danger" ? "stroke-danger" : "stroke-muted")}
                          />
                          <text x={bar.x + 18} y={top + 19} className="fill-muted">
                            Timing unknown
                          </text>
                        </g>
                      ) : (
                        <rect
                          x={bar.x}
                          y={top + 7}
                          width={bar.width}
                          height="14"
                          rx="2"
                          strokeWidth={bar.tone ? 2 : 1}
                          className={cn(
                            bar.idleReason ? IDLE_FILL[bar.idleReason] : (FAMILY[bar.family] ?? "fill-accent"),
                            bar.tone === "danger"
                              ? "stroke-danger"
                              : bar.tone === "warning"
                                ? "stroke-warning"
                                : "stroke-transparent",
                          )}
                        />
                      )}
                      <svg
                        x={bar.x + 2}
                        y={top + 7}
                        width={Math.max(0, bar.width - 4)}
                        height="14"
                        className="overflow-hidden"
                      >
                        <text
                          x="2"
                          y="10"
                          className={cn(
                            bar.unknown
                              ? "sr-only"
                              : bar.family === "idle"
                                ? "fill-foreground"
                                : bar.family === "architect" || bar.family === "check"
                                  ? "fill-background"
                                  : bar.family === "researcher"
                                    ? "fill-warning-foreground"
                                    : "fill-accent-foreground",
                          )}
                        >
                          {bar.label}
                        </text>
                      </svg>
                      {bar.marker ? (
                        <text x={bar.x} y={top + 37} className="fill-foreground">
                          {bar.marker}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </g>
            ))}
            {live ? (
              <g aria-label="Now">
                <line
                  x1={geometry.nowX}
                  x2={geometry.nowX}
                  y1="24"
                  y2={y}
                  className="stroke-accent"
                  strokeDasharray="3 3"
                />
                <text x={geometry.nowX + 4} y="17" className="fill-foreground">
                  Now
                </text>
              </g>
            ) : null}
          </svg>
        </section>
      </div>
      {detail ? (
        <p role="tooltip" className="text-muted border-border border-t px-4 py-2 font-mono text-xs break-words">
          {detail}
        </p>
      ) : null}
    </section>
  );
}
