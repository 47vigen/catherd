import { availableParallelism } from "node:os";
import { capableFor, entryFor, modelOf } from "../routing/catalog.ts";
import {
  type Backend,
  type Catalog,
  type CatalogModel,
  type NotifyMoment,
  type Profile,
  ROLES,
  type Role,
  type RungId,
  rungOf,
  splitRung,
} from "../types.ts";
import type { BackendStatus } from "./backends.ts";

export const NOTIFY: NotifyMoment[] = ["milestone", "finish", "blocked"];
const BACKENDS: Backend[] = ["claude", "codex", "opencode"];
const HARNESS_BACKENDS: Array<"codex" | "opencode"> = ["codex", "opencode"];

export type BudgetField = "minutes" | "tokens" | "usd";
export const BUDGET_FIELDS: BudgetField[] = ["minutes", "tokens", "usd"];

/** The left pane's rows (ROLES/ROUTING/HARNESS/BUDGET/FAILOVER/NOTIFY): a fixed skeleton,
 * independent of what is open or filtered. Everything else ("detail" rows) belongs to the
 * right pane, and only exists for whichever top row is currently selected. */
export type TopRow =
  | { kind: "role"; role: Role }
  | { kind: "objective" }
  | { kind: "lock" }
  | { kind: "harness"; backend: "codex" | "opencode" }
  | { kind: "budget-summary" }
  | { kind: "failover-summary" }
  | { kind: "notify"; moment: NotifyMoment };

export type DetailRow =
  | { kind: "backend"; role: Role; backend: Backend }
  | { kind: "model"; role: Role; model: CatalogModel }
  | { kind: "effort"; role: Role; model: CatalogModel; effort: string }
  | { kind: "budget"; field: BudgetField }
  | { kind: "failover"; rung: RungId };

export type Row = TopRow | DetailRow;

export type Section = "ROLES" | "ROUTING" | "HARNESS" | "BUDGET" | "FAILOVER" | "NOTIFY";

export function sectionOf(r: TopRow): Section {
  switch (r.kind) {
    case "role":
      return "ROLES";
    case "objective":
    case "lock":
      return "ROUTING";
    case "harness":
      return "HARNESS";
    case "budget-summary":
      return "BUDGET";
    case "failover-summary":
      return "FAILOVER";
    case "notify":
      return "NOTIFY";
  }
}

export type Toggled = { profile: Profile } | { needsTreatLike: RungId } | { refused: string };

export function rowId(r: Row): string {
  switch (r.kind) {
    case "role":
      return `role:${r.role}`;
    case "backend":
      return `backend:${r.role}:${r.backend}`;
    case "harness":
      return `harness:${r.backend}`;
    case "model":
      return `model:${r.role}:${r.model.id}`;
    case "effort":
      return `effort:${r.role}:${rungOf(r.model.id, r.effort)}`;
    case "budget":
      return `budget:${r.field}`;
    case "failover":
      return `failover:${r.rung}`;
    case "notify":
      return `notify:${r.moment}`;
    default:
      return r.kind;
  }
}

/** The `open` key a role/model row expands under `space`/`→`. Only these two kinds fold —
 * budget and failover always show their whole detail once selected, and harness has none. */
export function openKey(r: Row): string | null {
  if (r.kind === "role") return `role:${r.role}`;
  if (r.kind === "model" || r.kind === "effort") return `model:${r.role}:${r.model.id}`;
  return null;
}

export function readySet(backends: BackendStatus[]): Set<Backend> {
  return new Set<Backend>([
    "claude",
    ...backends.filter((b) => b.installed && b.loggedIn).map((b) => b.backend),
  ]);
}

/** The left pane: always these 17 rows, in this order, regardless of `open` or a filter. */
export function topLevelRows(): TopRow[] {
  return [
    ...ROLES.map((role): TopRow => ({ kind: "role", role })),
    { kind: "objective" },
    { kind: "lock" },
    ...HARNESS_BACKENDS.map((backend): TopRow => ({ kind: "harness", backend })),
    { kind: "budget-summary" },
    { kind: "failover-summary" },
    ...NOTIFY.map((moment): TopRow => ({ kind: "notify", moment })),
  ];
}

/** The right pane for a selected role: its capable models grouped by backend, open to their
 * effort ladder once expanded — the harness toggle no longer lives here, it is its own top row. */
export function roleDetailRows(
  p: Profile,
  c: Catalog,
  role: Role,
  open: ReadonlySet<string>,
  filter = "",
): DetailRow[] {
  const f = filter.toLowerCase();
  const out: DetailRow[] = [];
  const models = c.models.filter((m) => capableFor(role, m) && m.id.toLowerCase().includes(f));
  for (const backend of BACKENDS) {
    const group = models.filter((m) => m.backend === backend);
    if (group.length === 0) continue;
    out.push({ kind: "backend", role, backend });
    for (const model of group) {
      out.push({ kind: "model", role, model });
      if (!open.has(`model:${role}:${model.id}`)) continue;
      for (const effort of model.efforts) out.push({ kind: "effort", role, model, effort });
    }
  }
  return out;
}

export function budgetDetailRows(): DetailRow[] {
  return BUDGET_FIELDS.map((field) => ({ kind: "budget", field }));
}

export function failoverDetailRows(p: Profile, c: Catalog): DetailRow[] {
  return enabledFailoverRungs(p, c).map((rung) => ({ kind: "failover", rung }));
}

/** spec §11b: every codex/opencode rung ticked by a currently-enabled role gets a failover row. */
export function enabledFailoverRungs(p: Profile, c: Catalog): RungId[] {
  const set = new Set<RungId>();
  for (const role of ROLES) {
    if (!p.roles[role].enabled) continue;
    for (const rung of ticked(p, role)) {
      const backend = modelOf(c, splitRung(rung).model)?.backend;
      if (backend === "codex" || backend === "opencode") set.add(rung);
    }
  }
  return [...set].sort();
}

/** A failover stand-in must be scored (or treat-like) and on a different backend — the same rule
 * `validateProfile` enforces, kept in sync here so the picker only ever offers a valid choice. */
export function failoverOptions(c: Catalog, rung: RungId): RungId[] {
  const from = modelOf(c, splitRung(rung).model)?.backend;
  const candidates = new Set<RungId>([...c.entries.map((e) => e.rung), ...Object.keys(c.treatLike)]);
  return [...candidates]
    .filter((r) => {
      const backend = modelOf(c, splitRung(r).model)?.backend;
      return backend !== undefined && backend !== from;
    })
    .sort();
}

/** "no cap" or e.g. "30 min · $5" — the BUDGET row's one-line left-pane summary. `sep` is the
 * caller's glyph("dot", ui.plain) — this module stays presentation-neutral, so it takes the
 * separator rather than importing theme.ts's plain/unicode split itself. */
export function budgetSummary(p: Profile, sep = " · "): string {
  const b = p.budget;
  const parts = [
    b?.minutes !== undefined ? `${b.minutes} min` : null,
    b?.tokens !== undefined ? `${Math.round(b.tokens / 1000)}k tok` : null,
    b?.usd !== undefined ? `$${b.usd}` : null,
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(sep) : "no cap";
}

/** "none" or "N set" — the FAILOVER row's one-line left-pane summary. */
export function failoverSummary(p: Profile): string {
  const n = Object.keys(p.failover ?? {}).length;
  return n === 0 ? "none" : `${n} set`;
}

export function isTicked(p: Profile, r: Row): boolean {
  switch (r.kind) {
    case "role":
      return p.roles[r.role].enabled;
    case "harness":
      return p.harness[r.backend].isolated;
    case "model":
      return (p.roles[r.role].models[r.model.id]?.length ?? 0) > 0;
    case "effort":
      return p.roles[r.role].models[r.model.id]?.includes(r.effort) ?? false;
    case "notify":
      return p.notify.includes(r.moment);
    default:
      return false;
  }
}

export function ticked(p: Profile, role: Role): RungId[] {
  return Object.entries(p.roles[role].models).flatMap(([model, efforts]) =>
    efforts.map((e) => rungOf(model, e)),
  );
}

export function nextLock(v: number | "cpus/2", max = availableParallelism()): number | "cpus/2" {
  if (v === "cpus/2") return 1;
  return v >= max ? "cpus/2" : v + 1;
}

export function treatLikeOptions(c: Catalog, role: Role): RungId[] {
  return c.entries
    .map((e) => e.rung)
    .filter((rung) => {
      const m = modelOf(c, splitRung(rung).model);
      return m !== undefined && capableFor(role, m);
    });
}

export function toggle(p: Profile, c: Catalog, r: Row, ready: ReadonlySet<Backend>): Toggled {
  const next = structuredClone(p);
  switch (r.kind) {
    case "role":
      if (r.role === "worker") return { refused: "The worker is always on." };
      next.roles[r.role].enabled = !p.roles[r.role].enabled;
      return { profile: next };
    case "harness":
      next.harness[r.backend].isolated = !p.harness[r.backend].isolated;
      return { profile: next };
    case "model":
      delete next.roles[r.role].models[r.model.id];
      return { profile: next };
    case "effort": {
      const models = next.roles[r.role].models;
      const have = models[r.model.id] ?? [];
      if (have.includes(r.effort)) {
        const rest = have.filter((e) => e !== r.effort);
        if (rest.length > 0) models[r.model.id] = rest;
        else delete models[r.model.id];
        return { profile: next };
      }
      if (!ready.has(r.model.backend)) return { refused: `${r.model.backend} is not ready yet.` };
      const rung = rungOf(r.model.id, r.effort);
      if (!entryFor(c, rung)) return { needsTreatLike: rung };
      models[r.model.id] = r.model.efforts.filter((e) => e === r.effort || have.includes(e));
      return { profile: next };
    }
    case "objective":
      next.objective = p.objective === "cost" ? "speed" : "cost";
      return { profile: next };
    case "lock":
      next.lock.heavy = nextLock(p.lock.heavy);
      return { profile: next };
    case "notify":
      next.notify = NOTIFY.filter((m) => (m === r.moment ? !p.notify.includes(m) : p.notify.includes(m)));
      return { profile: next };
    case "backend":
      return { profile: p };
    case "budget":
    case "failover":
    case "budget-summary":
    case "failover-summary":
      // budget/failover open their own editor/picker in the Matrix component instead of toggling.
      return { profile: p };
  }
}
