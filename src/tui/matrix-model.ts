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

export type Row =
  | { kind: "role"; role: Role }
  | { kind: "backend"; role: Role; backend: Backend }
  | { kind: "harness"; role: Role; backend: "codex" | "opencode" }
  | { kind: "model"; role: Role; model: CatalogModel }
  | { kind: "effort"; role: Role; model: CatalogModel; effort: string }
  | { kind: "objective" }
  | { kind: "lock" }
  | { kind: "notify"; moment: NotifyMoment };

export type Toggled = { profile: Profile } | { needsTreatLike: RungId } | { refused: string };

export function rowId(r: Row): string {
  switch (r.kind) {
    case "role":
      return `role:${r.role}`;
    case "backend":
    case "harness":
      return `${r.kind}:${r.role}:${r.backend}`;
    case "model":
      return `model:${r.role}:${r.model.id}`;
    case "effort":
      return `effort:${r.role}:${rungOf(r.model.id, r.effort)}`;
    case "notify":
      return `notify:${r.moment}`;
    default:
      return r.kind;
  }
}

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

export function rows(p: Profile, c: Catalog, open: ReadonlySet<string>, filter = ""): Row[] {
  const f = filter.toLowerCase();
  const out: Row[] = [];
  for (const role of ROLES) {
    out.push({ kind: "role", role });
    if (!f && !open.has(`role:${role}`)) continue;
    const models = c.models.filter((m) => capableFor(role, m) && m.id.toLowerCase().includes(f));
    for (const backend of BACKENDS) {
      const group = models.filter((m) => m.backend === backend);
      if (group.length === 0) continue;
      out.push({ kind: "backend", role, backend });
      if (backend !== "claude") out.push({ kind: "harness", role, backend });
      for (const model of group) {
        out.push({ kind: "model", role, model });
        if (!open.has(`model:${role}:${model.id}`)) continue;
        for (const effort of model.efforts) out.push({ kind: "effort", role, model, effort });
      }
    }
  }
  out.push(
    { kind: "objective" },
    { kind: "lock" },
    ...NOTIFY.map((moment): Row => ({ kind: "notify", moment })),
  );
  return out;
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
  }
}
