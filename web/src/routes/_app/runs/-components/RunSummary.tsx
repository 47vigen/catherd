import { CircleExclamation, TriangleExclamation } from "@gravity-ui/icons";
import { Button, cn } from "@heroui/react";

import { formatCost, formatTokens } from "../-lib/format";
import {
  costSplit,
  FAMILY_LABEL,
  type Family,
  type Finding,
  formatAmount,
  familyOf,
  spends,
  TIME_LABEL,
  type TimeKey,
  timeSplit,
} from "../-lib/insights";
import { formatDuration, modelName, parseRung } from "../-lib/node-view";
import type { Attempt, FlowSelection, RunFlow, RunNode, RunView } from "../../../../client";
import { Blocks } from "../../../../components/charts/Blocks";
import { Tile } from "../../../../components/tile/Tile";

const FAMILY_FILL: Record<Family, string> = {
  architect: "fill-chart-4",
  build: "fill-chart-1",
  review: "fill-chart-2",
  research: "fill-chart-3",
  other: "fill-muted",
};
const FAMILY_DOT: Record<Family, string> = {
  architect: "bg-chart-4",
  build: "bg-chart-1",
  review: "bg-chart-2",
  research: "bg-chart-3",
  other: "bg-muted",
};
const TIME_FILL: Record<TimeKey, string> = {
  working: "fill-chart-1",
  check: "fill-muted/70",
  owner: "fill-chart-5",
  quota: "fill-warning",
  gap: "fill-muted/25",
};
const TIME_DOT: Record<TimeKey, string> = {
  working: "bg-chart-1",
  check: "bg-muted/70",
  owner: "bg-chart-5",
  quota: "bg-warning",
  gap: "bg-muted/25",
};

/** A share of a whole as one thin bar of segments; SVG attributes size it, so it needs no inline style. */
function Segments({ parts, label }: { parts: { key: string; value: number; fill: string }[]; label: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  let x = 0;
  return (
    <svg aria-hidden="true" data-label={label} viewBox="0 0 100 6" preserveAspectRatio="none" className="h-2 w-full">
      {total > 0
        ? parts.map((p) => {
            const width = (p.value / total) * 100;
            const rect = (
              <rect key={p.key} x={x} y="0" width={Math.max(0, width - 0.4)} height="6" className={p.fill} />
            );
            x += width;
            return rect;
          })
        : null}
    </svg>
  );
}

function Legend({ rows }: { rows: { key: string; dot: string; label: string; value: string; share: number }[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center gap-2 text-[13px]">
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-[2px]", r.dot)} />
          <span className="min-w-0 flex-1 truncate">{r.label}</span>
          <span className="text-muted w-10 shrink-0 text-right font-mono text-xs tabular-nums">
            {Math.round(r.share * 100)}%
          </span>
          <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** The questions a run is parked on: the one thing on the page that needs the owner, so it comes first. */
export function NeedsYou({ nodes, onOpen }: { nodes: RunNode[]; onOpen: (id: string) => void }) {
  const asks = nodes.filter((n) => n.question);
  if (asks.length === 0) return null;
  return (
    <section
      aria-label="Needs you"
      className="border-warning/40 bg-warning/8 flex flex-col divide-y divide-[color-mix(in_oklch,var(--warning)_25%,transparent)] rounded-sm border lg:col-span-12"
    >
      {asks.map((n) => (
        <div key={n.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <CircleExclamation aria-hidden="true" className="text-warning size-4 shrink-0" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-medium">{n.question!.question}</span>
            <span className="text-muted font-mono text-[11px]">
              {n.title} · {n.question!.reason.replace(/_/g, " ")}
            </span>
          </span>
          <Button size="sm" variant="secondary" aria-label={`Answer ${n.title}`} onPress={() => onOpen(n.id)}>
            Answer
          </Button>
        </div>
      ))}
    </section>
  );
}

/** Who is working right now: one row per live role, which opens it. */
export function Now({
  run,
  flow,
  now,
  onOpen,
  className,
}: {
  run: RunView;
  flow: RunFlow;
  now: number;
  onOpen: (s: FlowSelection) => void;
  className?: string;
}) {
  const running = [...flow.architect, ...flow.dispatches].filter((d) => d.status === "running");
  const rows = run.live.map((l) => ({
    live: l,
    dispatch: running.find((d) => d.name === l.name || d.name === l.unit),
  }));
  return (
    <Tile
      title="Now"
      className={className}
      aside={<span className="text-muted font-mono text-xs">{rows.length ? `${rows.length} working` : "idle"}</span>}
    >
      {rows.length === 0 ? (
        <p className="text-muted px-4 py-3 text-sm">
          {run.holds.length ? `Held by quota: ${run.holds.map((h) => h.quota).join(", ")}.` : "No role is working."}
          {run.last ? <span className="text-foreground mt-1 block font-mono text-xs">{run.last}</span> : null}
        </p>
      ) : (
        <ul aria-label="Working now" className="divide-separator divide-y">
          {rows.map(({ live: l, dispatch: d }) => {
            const p = parseRung(l.rung);
            const body = (
              <>
                <span aria-hidden="true" className="relative flex size-2 shrink-0">
                  <span
                    className={cn(
                      "absolute inset-0 rounded-full motion-safe:animate-ping opacity-50",
                      FAMILY_DOT[familyOf(l.role)],
                    )}
                  />
                  <span className={cn("relative size-2 rounded-full", FAMILY_DOT[familyOf(l.role)])} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                  <span className="truncate text-[13px] font-medium">
                    {l.name} <span className="text-muted font-normal">· {l.role}</span>
                  </span>
                  <span className="text-muted truncate text-[11px]">
                    {d?.why ?? (p.model ? modelName(p.model) : p.backend)}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className="font-mono text-[13px] tabular-nums">
                    {formatDuration(Math.max(0, now - Date.parse(l.since)) / 1000)}
                  </span>
                  <span className="text-muted text-[11px]">
                    {p.model ? modelName(p.model) : p.backend}
                    {p.effort ? ` · ${p.effort}` : ""}
                  </span>
                </span>
              </>
            );
            return (
              <li key={l.name}>
                {d ? (
                  <button
                    type="button"
                    onClick={() => onOpen(d.selection)}
                    className="hover:bg-surface-secondary focus-visible:outline-accent flex w-full items-center gap-3 px-4 py-3 outline-offset-[-2px] transition-colors"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex items-center gap-3 px-4 py-3">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Tile>
  );
}

const TONE_ICON = { danger: CircleExclamation, warning: TriangleExclamation, neutral: null } as const;
const TONE_TEXT = { danger: "text-danger", warning: "text-warning", neutral: "text-muted" } as const;

/** The stories of the run, worst first; each opens what it is about. */
export function Findings({
  items,
  onOpen,
  className,
}: {
  items: Finding[];
  onOpen: (s: FlowSelection) => void;
  className?: string;
}) {
  return (
    <Tile
      title="What stands out"
      aside={<span className="text-muted font-mono text-xs">{items.length || ""}</span>}
      className={className}
    >
      {items.length === 0 ? (
        <p className="text-muted px-4 py-3 text-sm">Nothing stands out: no failure, no long wait, no outlier.</p>
      ) : (
        <ul aria-label="What stands out" className="divide-separator divide-y">
          {items.map((f) => {
            const Icon = TONE_ICON[f.tone];
            const body = (
              <>
                <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center", TONE_TEXT[f.tone])}>
                  {Icon ? (
                    <Icon aria-hidden="true" className="size-4" />
                  ) : (
                    <span aria-hidden="true" className="bg-muted size-1.5 rounded-full" />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                  <span className="text-[13px] font-medium">{f.title}</span>
                  {f.detail ? <span className="text-muted truncate font-mono text-[11px]">{f.detail}</span> : null}
                </span>
                {f.selection ? (
                  <span aria-hidden="true" className="text-muted group-hover:text-foreground shrink-0 text-xs">
                    Open →
                  </span>
                ) : null}
              </>
            );
            return (
              <li key={f.id} data-tone={f.tone}>
                {f.selection ? (
                  <button
                    type="button"
                    onClick={() => onOpen(f.selection!)}
                    className="group hover:bg-surface-secondary focus-visible:outline-accent flex w-full items-start gap-3 px-4 py-3 outline-offset-[-2px] transition-colors"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex items-start gap-3 px-4 py-3">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Tile>
  );
}

/** Where the wall time went, as one bar: working, checks only, waiting on the owner, quota, gaps. */
export function TimeSpent({
  run,
  flow,
  attempts,
  now,
  className,
}: {
  run: RunView;
  flow: RunFlow;
  attempts: readonly Attempt[];
  now: number;
  className?: string;
}) {
  const { wallMs, parts } = timeSplit(flow, now);
  const finished = spends(flow, attempts, now)
    .filter((s) => s.dispatch.role !== "architect" && s.dispatch.endedAt)
    .map((s) => s.ms)
    .sort((a, b) => a - b);
  const m = run.metrics;
  const facts: [string, string][] = [
    ["Roles at once", m ? m.concurrency.toFixed(2) : "–"],
    ["Median role run", finished.length ? formatDuration(finished[Math.floor(finished.length / 2)]! / 1000) : "–"],
    ["Longest role run", finished.length ? formatDuration(finished.at(-1)! / 1000) : "–"],
    ["Architect turns", String(flow.architect.length)],
  ];
  return (
    <Tile
      className={className}
      title="Where the time went"
      aside={<span className="text-muted font-mono text-xs tabular-nums">{formatDuration(wallMs / 1000)}</span>}
    >
      <div className="flex flex-col gap-4 p-4">
        <Segments
          label="Wall time by activity"
          parts={parts.map((p) => ({ key: p.key, value: p.ms, fill: TIME_FILL[p.key] }))}
        />
        <Legend
          rows={parts.map((p) => ({
            key: p.key,
            dot: TIME_DOT[p.key],
            label: TIME_LABEL[p.key],
            value: formatDuration(p.ms / 1000),
            share: wallMs ? p.ms / wallMs : 0,
          }))}
        />
      </div>
      <dl className="bg-separator border-border mt-auto grid grid-cols-2 gap-px border-t">
        {facts.map(([label, value]) => (
          <div key={label} className="bg-surface flex flex-col gap-1 px-4 py-2.5">
            <dt className="text-muted text-[11px]">{label}</dt>
            <dd className="font-mono text-[13px] tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </Tile>
  );
}

/** Where the money went: by role family, then the role runs that used the most, each opening its run. */
export function CostSpent({
  flow,
  attempts,
  now,
  onOpen,
  className,
}: {
  flow: RunFlow;
  attempts: readonly Attempt[];
  now: number;
  onOpen: (s: FlowSelection) => void;
  className?: string;
}) {
  const all = spends(flow, attempts, now);
  const { unit, total, families, top } = costSplit(all);
  const sum = (pick: (t: NonNullable<Attempt["tokens"]>) => number) =>
    attempts.reduce((a, d) => a + (d.tokens ? pick(d.tokens) : 0), 0);
  const priced = all.filter((s) => s.cost != null);
  const facts: [string, string][] = [
    ["Uncached in", formatTokens(sum((t) => t.input - t.cached - (t.cacheWrite ?? 0)))],
    ["Cache read", formatTokens(sum((t) => t.cached))],
    ["Output", formatTokens(sum((t) => t.output))],
    ["Per role run", priced.length ? formatCost(priced.reduce((a, s) => a + (s.cost ?? 0), 0) / priced.length) : "–"],
  ];
  return (
    <Tile
      className={className}
      title={unit === "cost" ? "Where the cost went" : "Where the tokens went"}
      aside={
        <span className="text-muted font-mono text-xs tabular-nums">{total ? formatAmount(unit, total) : "—"}</span>
      }
    >
      {total === 0 ? (
        <p className="text-muted px-4 py-3 text-sm">Nothing used yet.</p>
      ) : (
        <>
          <div className="flex flex-col gap-4 p-4">
            <Segments
              label={`${unit === "cost" ? "Cost" : "Tokens"} by role`}
              parts={families.map((f) => ({ key: f.family, value: f.value, fill: FAMILY_FILL[f.family] }))}
            />
            <Legend
              rows={families.map((f) => ({
                key: f.family,
                dot: FAMILY_DOT[f.family],
                label: FAMILY_LABEL[f.family],
                value: formatAmount(unit, f.value),
                share: f.value / total,
              }))}
            />
          </div>
          {/* With every role run at the same price, a ranking says nothing. */}
          {top.length > 1 && top[0]!.value > top.at(-1)!.value ? (
            <>
              <h4 className="label-caps text-muted border-border border-t px-4 pt-3 pb-1">Most expensive</h4>
              <ul aria-label="Most expensive role runs" className="pb-1.5">
                {top.map(({ spend: s, value }) => (
                  <li key={s.dispatch.dispatchId}>
                    <button
                      type="button"
                      onClick={() => onOpen(s.dispatch.selection)}
                      className="hover:bg-surface-secondary focus-visible:outline-accent grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2 text-left outline-offset-[-2px] transition-colors"
                    >
                      <span className="truncate text-[13px]">
                        <span className="font-medium">{s.dispatch.name}</span>{" "}
                        <span className="text-muted">
                          · {s.dispatch.role} · {formatDuration(s.ms / 1000)}
                        </span>
                      </span>
                      <span className="font-mono text-xs tabular-nums">{formatAmount(unit, value)}</span>
                      <Blocks
                        value={value}
                        max={top[0]!.value}
                        tone={FAMILY_DOT[familyOf(s.dispatch.role)]}
                        className="col-span-2"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <dl className="bg-separator border-border mt-auto grid grid-cols-2 gap-px border-t">
            {facts.map(([label, value]) => (
              <div key={label} className="bg-surface flex flex-col gap-1 px-4 py-2.5">
                <dt className="text-muted text-[11px]">{label}</dt>
                <dd className="font-mono text-[13px] tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </Tile>
  );
}
