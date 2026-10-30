import { Button, cn } from "@heroui/react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { flowGeometry, mergeIdle, tickStep } from "../../-lib/flow-view";
import { formatDuration } from "../../-lib/node-view";
import type { FlowSelection, RunFlow, RunView } from "../../../../../client";

type Bar = {
  id: string;
  label: string;
  visibleLabel?: string;
  detail: string;
  x: number;
  width: number;
  family: string;
  tone?: string;
  selection?: FlowSelection;
  climbed?: boolean;
  unknown?: boolean;
  idleReason?: RunFlow["idle"][number]["reason"];
};
type Row = { id: string; goal?: string; state?: string; depends?: string[]; bars: Bar[]; section?: boolean };
/** One colour per role family, shared with the run summary: body tint, solid edge and the legend swatch. */
const FAMILY: Record<string, { body: string; edge: string; swatch: string }> = {
  architect: { body: "fill-chart-4/30", edge: "fill-chart-4", swatch: "bg-chart-4" },
  worker: { body: "fill-chart-1/32", edge: "fill-chart-1", swatch: "bg-chart-1" },
  writer: { body: "fill-chart-1/32", edge: "fill-chart-1", swatch: "bg-chart-1" },
  artist: { body: "fill-chart-1/32", edge: "fill-chart-1", swatch: "bg-chart-1" },
  reviewer: { body: "fill-chart-2/30", edge: "fill-chart-2", swatch: "bg-chart-2" },
  verifier: { body: "fill-chart-2/30", edge: "fill-chart-2", swatch: "bg-chart-2" },
  researcher: { body: "fill-chart-3/34", edge: "fill-chart-3", swatch: "bg-chart-3" },
  check: { body: "fill-muted/20", edge: "fill-muted", swatch: "bg-muted" },
};
const LEGEND = [
  ["Architect", "architect"],
  ["Worker, writer, artist", "worker"],
  ["Reviewer, verifier", "reviewer"],
  ["Researcher", "researcher"],
  ["Check", "check"],
] as const;
const IDLE = { owner: "Owner", quota: "Quota", check: "Check", gap: "Gap" };
const IDLE_FILL = {
  owner: "fill-chart-5/45",
  quota: "fill-warning/45",
  check: "fill-muted/22",
  gap: "fill-muted/12",
};
const IDLE_SWATCH = { owner: "bg-chart-5/60", quota: "bg-warning/60", check: "bg-muted/50", gap: "bg-muted/20" };
/** Waits that hold the whole run back are washed across every row, so what they stopped is plain to see. */
const WASH = { owner: "fill-chart-5/7", quota: "fill-warning/7" } as const;
const STATE_DOT: Record<string, string> = {
  running: "bg-accent",
  review: "bg-chart-2",
  done: "bg-success",
  blocked: "bg-danger",
  impossible: "bg-danger",
  todo: "bg-muted/50",
};
const ROW = 40;
const TOP = 32;

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
  const track = useRef<HTMLElement>(null);
  const [viewport, setViewport] = useState(600);
  const [scale, setScale] = useState<number>();
  const pendingScroll = useRef<number | null>(null);
  const pointers = useRef(new Map<number, number>());
  const drag = useRef<{
    x: number;
    scroll: number;
    pinch?: { distance: number; anchor: number; scroll: number; pixelsPerMs: number };
  } | null>(null);
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => setViewport(el.clientWidth || 600);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const geometry = flowGeometry(flow, now, viewport, scale);
  useLayoutEffect(() => {
    if (pendingScroll.current !== null && track.current) {
      track.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
  }, [geometry.width]);
  const zoom = (
    factor: number,
    anchor = viewport / 2,
    origin = { anchor, scroll: track.current?.scrollLeft ?? 0, pixelsPerMs: geometry.pixelsPerMs },
  ) => {
    const el = track.current;
    if (!el) return;
    const next = Math.max(
      (viewport - 32) / Math.max(1, geometry.end - Date.parse(flow.startedAt)),
      Math.min(origin.pixelsPerMs * factor, 1),
    );
    const scroll = ((origin.scroll + origin.anchor - 16) * next) / origin.pixelsPerMs + 16 - anchor;
    if (next === geometry.pixelsPerMs) el.scrollLeft = scroll;
    else pendingScroll.current = scroll;
    setScale(next);
  };
  const fit = () => {
    setScale(undefined);
    if (track.current) track.current.scrollLeft = 0;
  };
  const wheel = useEffectEvent((e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoom(Math.exp(-e.deltaY * 0.01), e.clientX - track.current!.getBoundingClientRect().left);
    } else if (e.deltaX !== 0) setScale(geometry.pixelsPerMs);
  });
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const handler = (e: WheelEvent) => wheel(e);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);
  const live = flow.endedAt === null && run.phase !== "ended";
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
      visibleLabel:
        d.role === "architect" ? `turn ${flow.architect.findIndex((a) => a.dispatchId === d.dispatchId) + 1}` : d.name,
      detail: `${d.name} · ${d.role} · ${d.rung} · ${d.status} · ${duration}${d.ledgerTask ? ` · ${d.ledgerTask}` : ""}${marker ? ` · ${marker}` : ""}`,
      family: d.role,
      selection: d.selection,
      climbed: Boolean(d.climbFrom),
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
  if (unassigned.length) rows.push({ id: "Unassigned roles", bars: unassigned.map(dispatchBar), section: true });
  if (flow.checks.length)
    rows.push({
      id: "Run checks",
      section: !unassigned.length,
      bars: flow.checks.map((c) => {
        const interval = c.startedAt
          ? geometry.interval(c.startedAt, c.endedAt)
          : { x: c.endedAt ? geometry.x(c.endedAt) : 16, width: 2 };
        const status = c.endedAt ? (c.verdict ?? (c.exit === 0 ? "pass" : "failed")) : "running";
        return {
          ...interval,
          id: c.checkId,
          label: `${c.checkId} check · ${status}`,
          visibleLabel: c.checkId,
          detail: `${c.checkId} · check · ${c.scope} · ${status} · ${c.startedAt ? formatDuration(Math.max(0, ((c.endedAt ? Date.parse(c.endedAt) : geometry.end) - Date.parse(c.startedAt)) / 1000)) : "Timing unknown"}`,
          family: "check",
          selection: c.selection,
          tone: c.endedAt && c.exit !== 0 && c.verdict !== "inherited" ? "danger" : undefined,
          unknown: c.startedAt === null,
        };
      }),
    });
  rows.push({
    id: "Idle",
    section: !unassigned.length && !flow.checks.length,
    bars: mergeIdle(flow.idle).map((i, index) => ({
      ...geometry.interval(i.startedAt, i.endedAt),
      id: `idle-${index}`,
      label: IDLE[i.reason],
      detail: `Idle · ${IDLE[i.reason]} · ${(Math.max(0, (i.endedAt ? Date.parse(i.endedAt) : geometry.end) - Date.parse(i.startedAt)) / 60000).toFixed(1)} min`,
      family: "idle",
      idleReason: i.reason,
    })),
  });
  const positioned = rows.map((row, index) => ({ ...row, y: TOP + index * ROW, height: ROW }));
  const y = TOP + rows.length * ROW;
  const washes = mergeIdle(flow.idle).filter(
    (i): i is typeof i & { reason: keyof typeof WASH } => i.reason === "owner" || i.reason === "quota",
  );
  const step = tickStep((geometry.end - Date.parse(flow.startedAt)) / 1000, geometry.width);
  const ticks = Array.from(
    { length: Math.floor((geometry.end - Date.parse(flow.startedAt)) / 1000 / step) + 1 },
    (_, i) => i * step,
  );
  // Reserve the rightmost label first; inward endpoint alignment can crowd the preceding tick.
  const axisTicks: { seconds: number; x: number; label: string; endAligned: boolean }[] = [];
  let nextLabelLeft = live ? geometry.nowX - 24 : Infinity;
  for (const seconds of ticks.toReversed()) {
    const x = 16 + seconds * 1000 * geometry.pixelsPerMs;
    const label = formatDuration(seconds);
    const labelWidth = label.length * 7;
    const endAligned = x + labelWidth > geometry.width - 4;
    const left = endAligned ? x - labelWidth : x;
    if (left + labelWidth + 8 > nextLabelLeft) continue;
    axisTicks.unshift({ seconds, x, label, endAligned });
    nextLabelLeft = left;
  }
  const [head, ...rest] = (detail ?? "").split(" · ");
  return (
    <section
      aria-label="Run flow"
      className={cn("min-w-0 max-w-full", fill && "flex flex-1 flex-col overflow-y-auto pt-16")}
    >
      <div className="flex min-w-0 items-center gap-2 px-4 py-3">
        <div
          aria-label="Flow legend"
          className="text-muted flex min-w-0 flex-1 items-center gap-4 overflow-x-auto text-xs whitespace-nowrap"
        >
          {LEGEND.map(([label, family]) => (
            <span key={family} className="text-foreground flex items-center gap-1.5">
              <span aria-hidden="true" className={cn("size-2.5 rounded-[3px]", FAMILY[family]!.swatch)} />
              {label}
            </span>
          ))}
          <span aria-hidden="true" className="bg-border h-3.5 w-px shrink-0" />
          {(["owner", "quota", "gap"] as const).map((reason) => (
            <span key={reason} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={cn("size-2.5 rounded-[3px]", IDLE_SWATCH[reason])} />
              {reason === "owner" ? "Waiting on you" : reason === "quota" ? "Quota hold" : "Idle"}
            </span>
          ))}
        </div>
        <div className="border-border flex shrink-0 items-center rounded-sm border">
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label="Zoom out"
            className="rounded-none"
            onPress={() => zoom(0.5)}
          >
            −
          </Button>
          <span aria-hidden="true" className="bg-border h-4 w-px" />
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label="Zoom in"
            className="rounded-none"
            onPress={() => zoom(2)}
          >
            +
          </Button>
          <span aria-hidden="true" className="bg-border h-4 w-px" />
          <Button size="sm" variant="ghost" className="rounded-none" onPress={fit}>
            Fit
          </Button>
        </div>
        {onExpand ? (
          <Button size="sm" variant="tertiary" onPress={onExpand}>
            Full screen
          </Button>
        ) : null}
      </div>
      <div className="border-border bg-surface-secondary/50 flex h-9 min-w-0 items-center gap-2 border-y px-4 font-mono text-xs">
        {detail ? (
          <p role="tooltip" className="min-w-0 truncate">
            <span className="text-foreground font-medium">{head}</span>
            {rest.map((part, i) => (
              <span key={i} className="text-muted">
                {" · "}
                {part}
              </span>
            ))}
          </p>
        ) : (
          <p className="text-muted min-w-0 truncate">
            {live ? "Live · " : ""}Point at a bar for its role, model, status and time; click it to open.
          </p>
        )}
      </div>
      {!flow.architect.length && !flow.dispatches.length && !flow.checks.length ? (
        <p className="text-muted px-4 py-2 text-sm">No activity recorded yet.</p>
      ) : null}
      <div className="flex max-w-full min-w-0">
        <svg
          width="180"
          height={y}
          className="bg-surface border-border sticky left-0 z-10 w-[120px] shrink-0 border-r sm:w-[180px]"
          aria-label="Flow rows"
        >
          {positioned.map((row) => (
            <g key={row.id}>
              <line
                x1="0"
                x2="100%"
                y1={row.y}
                y2={row.y}
                className={row.section || row.id === "Architect" ? "stroke-border" : "stroke-separator"}
              />
              <foreignObject x="0" y={row.y} width="100%" height={row.height}>
                <div
                  className="flex h-full min-w-0 items-center gap-2 px-3"
                  title={[row.id, row.goal, row.depends?.length ? `Depends on ${row.depends.join(", ")}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  <span
                    className={cn(
                      "min-w-0 truncate font-mono text-xs whitespace-nowrap",
                      row.state ? "text-foreground" : "text-muted",
                    )}
                  >
                    {row.id}
                  </span>
                  {row.state ? (
                    <span className="text-muted ml-auto flex shrink-0 items-center gap-1 text-[10px]">
                      <span
                        aria-hidden="true"
                        className={cn("size-1.5 rounded-full", STATE_DOT[row.state] ?? "bg-muted")}
                      />
                      {row.state}
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
          className="max-w-full min-w-0 flex-1 touch-pan-y overflow-x-auto overscroll-x-contain"
          onScroll={(e) => {
            if (e.currentTarget.scrollLeft > 0 && scale === undefined) setScale(geometry.pixelsPerMs);
          }}
          onPointerDown={(e) => {
            if ((e.target as Element).closest('[role="button"]')) return;
            pointers.current.set(e.pointerId, e.clientX);
            e.currentTarget.setPointerCapture(e.pointerId);
            const values = [...pointers.current.values()];
            drag.current = {
              x: e.clientX,
              scroll: e.currentTarget.scrollLeft,
              pinch:
                values.length === 2
                  ? {
                      distance: Math.abs(values[0]! - values[1]!),
                      anchor: (values[0]! + values[1]!) / 2 - e.currentTarget.getBoundingClientRect().left,
                      scroll: e.currentTarget.scrollLeft,
                      pixelsPerMs: geometry.pixelsPerMs,
                    }
                  : undefined,
            };
          }}
          onPointerMove={(e) => {
            if (!pointers.current.has(e.pointerId) || !drag.current) return;
            pointers.current.set(e.pointerId, e.clientX);
            const values = [...pointers.current.values()];
            if (values.length === 2 && drag.current.pinch?.distance) {
              const distance = Math.abs(values[0]! - values[1]!);
              zoom(
                distance / drag.current.pinch.distance,
                (values[0]! + values[1]!) / 2 - e.currentTarget.getBoundingClientRect().left,
                drag.current.pinch,
              );
            } else if (values.length === 1) {
              e.currentTarget.scrollLeft = drag.current.scroll + drag.current.x - e.clientX;
              if (Math.abs(drag.current.x - e.clientX) > 2) setScale(geometry.pixelsPerMs);
            }
          }}
          onPointerUp={(e) => {
            pointers.current.delete(e.pointerId);
            drag.current = null;
          }}
          onPointerCancel={(e) => {
            pointers.current.delete(e.pointerId);
            drag.current = null;
          }}
        >
          <svg
            width={geometry.width}
            height={y}
            viewBox={`0 0 ${geometry.width} ${y}`}
            className="font-mono text-[10px] tabular-nums"
          >
            {washes.map((w, i) => {
              const span = geometry.interval(w.startedAt, w.endedAt);
              return (
                <rect
                  key={`wash-${i}`}
                  x={span.x}
                  y={TOP}
                  width={span.width}
                  height={y - TOP}
                  className={WASH[w.reason]}
                />
              );
            })}
            {axisTicks.map(({ seconds, x, label, endAligned }) => (
              <g key={seconds}>
                <line x1={x} x2={x} y1="24" y2={y} className="stroke-separator" />
                <text x={x} y="17" textAnchor={endAligned ? "end" : "start"} className="fill-muted">
                  {label}
                </text>
              </g>
            ))}
            {positioned.map((row) => (
              <g key={row.id}>
                <line
                  x1="0"
                  x2={geometry.width}
                  y1={row.y}
                  y2={row.y}
                  className={row.section || row.id === "Architect" ? "stroke-border" : "stroke-separator"}
                />
                {row.bars.map((bar) => {
                  const top = row.y + 9;
                  const color = FAMILY[bar.family] ?? FAMILY.worker!;
                  const running = bar.detail.includes(" · running · ");
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
                        x={bar.x - 2}
                        y={bar.idleReason ? row.y : top - 3}
                        width={Math.max(28, bar.width) + 4}
                        height={bar.idleReason ? row.height : 28}
                        rx="5"
                        className={cn(
                          "fill-transparent group-focus-visible:stroke-focus",
                          bar.selection && "group-hover:fill-foreground/5",
                          selected && bar.selection?.nodeId === selected && "stroke-focus",
                        )}
                      />
                      {bar.unknown ? (
                        <path
                          data-timing-unknown="true"
                          d={`M ${bar.x + 11} ${top + 2} l 9 9 l -9 9 l -9 -9 Z`}
                          strokeWidth="1.5"
                          className={cn("fill-surface", bar.tone === "danger" ? "stroke-danger" : "stroke-muted")}
                        >
                          <title>Timing unknown</title>
                        </path>
                      ) : bar.idleReason ? (
                        <rect
                          x={bar.x}
                          y={row.y + 1}
                          width={bar.width}
                          height={row.height - 1}
                          className={cn(IDLE_FILL[bar.idleReason], "stroke-transparent")}
                        />
                      ) : (
                        <>
                          <rect
                            x={bar.x}
                            y={top}
                            width={Math.min(3, bar.width)}
                            height="22"
                            rx="1.5"
                            className={color.edge}
                          />
                          <rect
                            x={bar.x}
                            y={top}
                            width={bar.width}
                            height="22"
                            rx="4"
                            strokeWidth={bar.tone ? 1.5 : 1}
                            className={cn(
                              color.body,
                              running && "motion-safe:animate-pulse",
                              bar.tone === "danger"
                                ? "stroke-danger"
                                : bar.tone === "warning"
                                  ? "stroke-warning"
                                  : "stroke-transparent",
                            )}
                          />
                        </>
                      )}
                      <svg
                        x={bar.x + 6}
                        y={top}
                        width={Math.max(0, bar.width - 8)}
                        height="22"
                        className="pointer-events-none overflow-hidden"
                      >
                        <text
                          x="1"
                          y="14.5"
                          className={cn(bar.unknown ? "sr-only" : "fill-foreground", "text-[11px] font-medium")}
                        >
                          {bar.visibleLabel && bar.width >= bar.visibleLabel.length * 6.5 + 12 ? bar.visibleLabel : ""}
                        </text>
                      </svg>
                      {bar.climbed ? (
                        <text x={bar.x - 1} y={top - 2} className="fill-warning text-[10px]" aria-hidden="true">
                          ↗
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
                  strokeWidth="1.5"
                />
                <circle cx={geometry.nowX} cy="24" r="3" className="fill-accent" />
                <text x={geometry.nowX - 6} y="17" textAnchor="end" className="fill-accent font-medium">
                  Now
                </text>
              </g>
            ) : null}
          </svg>
        </section>
      </div>
    </section>
  );
}
