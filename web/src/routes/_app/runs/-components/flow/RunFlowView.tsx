import { Button, Chip, cn } from "@heroui/react";
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
  owner: "fill-accent",
  quota: "fill-warning",
  check: "fill-chart-2",
  gap: "fill-muted",
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
    bars: mergeIdle(flow.idle).map((i, index) => ({
      ...geometry.interval(i.startedAt, i.endedAt),
      id: `idle-${index}`,
      label: IDLE[i.reason],
      detail: `Idle · ${IDLE[i.reason]} · ${(Math.max(0, (i.endedAt ? Date.parse(i.endedAt) : geometry.end) - Date.parse(i.startedAt)) / 60000).toFixed(1)} min`,
      family: "idle",
      idleReason: i.reason,
    })),
  });
  const positioned = rows.map((row, index) => ({ ...row, y: 32 + index * 36, height: 36 }));
  const y = 32 + rows.length * 36;
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
        </div>
        <span className="text-muted text-xs" aria-hidden="true">
          ›
        </span>
        <Button size="sm" variant="tertiary" aria-label="Zoom out" onPress={() => zoom(0.5)}>
          −
        </Button>
        <Button size="sm" variant="tertiary" aria-label="Zoom in" onPress={() => zoom(2)}>
          +
        </Button>
        <Button size="sm" variant="tertiary" onPress={fit}>
          Fit
        </Button>
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
        <svg
          width="180"
          height={y}
          className="bg-surface sticky left-0 z-10 w-[120px] shrink-0 sm:w-[180px]"
          aria-label="Flow rows"
        >
          {positioned.map((row) => (
            <g key={row.id}>
              <line x1="0" x2="100%" y1={row.y} y2={row.y} className="stroke-border" />
              <foreignObject x="0" y={row.y + 6} width="100%" height={row.height - 6}>
                <div
                  className="flex min-w-0 items-center gap-1 px-2"
                  title={[row.id, row.goal, row.depends?.length ? `Depends on ${row.depends.join(", ")}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  <span className="min-w-0 truncate font-mono text-xs">{row.id}</span>
                  {row.state ? (
                    <Chip size="sm" variant="soft">
                      <Chip.Label className="text-[10px]">{row.state}</Chip.Label>
                    </Chip>
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
            {axisTicks.map(({ seconds, x, label, endAligned }) => (
              <g key={seconds}>
                <line x1={x} x2={x} y1="24" y2={y} className="stroke-border/40" />
                <text x={x} y="17" textAnchor={endAligned ? "end" : "start"} className="fill-muted">
                  {label}
                </text>
              </g>
            ))}
            {positioned.map((row) => (
              <g key={row.id}>
                <line x1="0" x2={geometry.width} y1={row.y} y2={row.y} className="stroke-border" />
                {row.bars.map((bar) => {
                  const top = row.y + 4;
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
                          >
                            <title>Timing unknown</title>
                          </path>
                        </g>
                      ) : (
                        <rect
                          x={bar.x}
                          y={bar.idleReason ? row.y : top + 7}
                          width={bar.width}
                          height={bar.idleReason ? row.height : 14}
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
                          {bar.visibleLabel && bar.width >= bar.visibleLabel.length * 6 + 8 ? bar.visibleLabel : ""}
                        </text>
                      </svg>
                      {bar.climbed ? (
                        <text x={bar.x} y={top + 9} className="fill-foreground" aria-hidden="true">
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
                  strokeDasharray="3 3"
                />
                <text x={geometry.nowX} y="17" textAnchor="end" className="fill-foreground">
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
