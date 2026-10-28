import { formatCost, formatTokens, tokenTotal } from "../-lib/format";
import { formatDuration, modelName, parseRung } from "../-lib/node-view";
import type { RunModel, RunView } from "../../../../client";
import { ProviderIcon } from "../../../../components/provider-icon/ProviderIcon";
import { type Status, StatusChip } from "../../../../components/status-chip/StatusChip";
import { Tile } from "../../../../components/tile/Tile";

const MILESTONE_STATUS: Record<string, Status> = {
  landed: "done",
  failed: "failed",
  parked: "parked",
  pending: "pending",
  planned: "pending",
  cancelled: "cancelled",
};

/** The milestones of the run: where each stands, the commit it landed and the rounds it took. */
export function Milestones({ milestones }: { milestones: RunView["milestones"] }) {
  return (
    <Tile title="Milestones" aside={<span className="text-muted font-mono text-xs">{milestones.length}</span>}>
      {milestones.length === 0 ? (
        <p className="text-muted px-4 py-3 text-sm">None yet. They appear once the plan is ready.</p>
      ) : (
        <ul aria-label="Milestones" className="divide-separator divide-y">
          {milestones.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-4 py-3">
              <span className="label-caps text-foreground w-8 shrink-0">{m.id}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[13px] font-medium">{m.title}</span>
                <span className="text-muted font-mono text-[11px]">
                  {m.commit ? m.commit.slice(0, 7) : "no commit yet"}
                </span>
              </span>
              <StatusChip status={MILESTONE_STATUS[m.status] ?? "running"} label={m.status} />
            </li>
          ))}
        </ul>
      )}
    </Tile>
  );
}

type Row = { rung: string; roles: Set<string>; runs: number; tokens: number; cost: number | null; secs: number };

/** Who did the work: one row per model the roles ran on, with what it used. */
export function Models({ dispatches }: { dispatches: RunModel["dispatches"] }) {
  const rows = new Map<string, Row>();
  for (const d of dispatches) {
    if (!d.rung) continue;
    const r = rows.get(d.rung) ?? { rung: d.rung, roles: new Set(), runs: 0, tokens: 0, cost: null, secs: 0 };
    if (d.role) r.roles.add(d.role);
    r.runs += 1;
    r.tokens += tokenTotal(d.tokens);
    r.secs += d.secs ?? 0;
    if (d.costUsd != null) r.cost = (r.cost ?? 0) + d.costUsd;
    rows.set(d.rung, r);
  }
  const list = [...rows.values()].sort((a, b) => b.tokens - a.tokens);
  return (
    <Tile title="Models">
      {list.length === 0 ? (
        <p className="text-muted px-4 py-3 text-sm">No role has run yet.</p>
      ) : (
        <ul aria-label="Models" className="divide-separator divide-y">
          {list.map((r) => {
            const p = parseRung(r.rung);
            return (
              <li key={r.rung} className="flex items-center gap-3 px-4 py-3" title={r.rung}>
                <ProviderIcon backend={p.backend} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px] font-medium">
                    {p.model ? modelName(p.model) : p.backend}
                    {p.effort ? <span className="text-muted font-normal"> · {p.effort}</span> : null}
                  </span>
                  <span className="text-muted truncate text-[11px]">
                    {[...r.roles].join(", ")} · {r.runs}× · {formatDuration(r.secs)}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5 font-mono tabular-nums">
                  <span className="text-[13px]">{formatTokens(r.tokens)}</span>
                  <span className="text-muted text-[11px]">{formatCost(r.cost)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Tile>
  );
}

const pct = (n: number): string => `${Math.round(n)}%`;
const mins = (n: number): string => `${Math.round(n)} min`;

/** Spec D17: where the run's time went, the numbers each stage is measured on. */
export function Metrics({ metrics }: { metrics: NonNullable<RunView["metrics"]> }) {
  const blocked = Object.entries(metrics.blockedMin).sort((a, b) => b[1] - a[1]);
  const rows: [string, string, string | null][] = [
    ["Idle", pct(metrics.idlePct), "no role running"],
    ["Concurrency", metrics.concurrency.toFixed(2), "roles at once, on average"],
    [
      "Blocked",
      mins(blocked.reduce((n, [, m]) => n + m, 0)),
      blocked.length ? blocked.map(([why, m]) => `${why} ${mins(m)}`).join(" · ") : null,
    ],
    ["Checks", metrics.checkShare === null ? "–" : pct(metrics.checkShare * 100), "of the wall time"],
    ["Review rounds", String(metrics.rounds.total), `at most ${metrics.rounds.max} on one task`],
    ["Climbs", String(metrics.climbs), "a retry on another rung"],
    [
      "Standing start",
      metrics.standingStartSec === null ? "–" : `${Math.round(metrics.standingStartSec)} s`,
      "researcher or writer, call to start",
    ],
  ];
  return (
    <Tile title="Metrics">
      <ul aria-label="Metrics" className="divide-separator divide-y">
        {rows.map(([label, value, hint]) => (
          <li key={label} className="flex items-center gap-3 px-4 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[13px] font-medium">{label}</span>
              {hint ? <span className="text-muted truncate text-[11px]">{hint}</span> : null}
            </span>
            <span className="shrink-0 font-mono text-[13px] tabular-nums">{value}</span>
          </li>
        ))}
      </ul>
    </Tile>
  );
}
