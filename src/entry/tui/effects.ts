import { statSync } from "node:fs";
import { adapterFor } from "../../adapters/registry.ts";
import "../../adapters/all.ts";
import { agentFiles } from "../../domain/agents.ts";
import type { Catalog } from "../../domain/catalog.ts";
import { HARNESS_KEYS, type Profile, type ProfileDoc, type ProfilePatch } from "../../domain/profile.ts";
import { type Validation, validateProfile } from "../../domain/profile-rules.ts";
import type { Access } from "../../domain/record.ts";
import type { RouteSource } from "../../domain/route.ts";
import { VERSION } from "../../infra/version.ts";
import {
  type CatalogModel,
  catalogQuery,
  loadCatalog,
  type Refreshed,
  refreshDiscovery,
  saveTreatLike,
} from "../../services/catalog-service.ts";
import { cancel } from "../../services/dispatch-service.ts";
import { type DoctorReport, doctor } from "../../services/doctor.ts";
import type { Synced } from "../../services/agent-links.ts";
import {
  activate,
  createProfile,
  deleteProfile,
  patchProfile,
  type Saved,
} from "../../services/profile-service.ts";
import {
  activeName,
  configFile,
  enforcementOf,
  listProfiles,
  profilesDir,
  projectsFile,
  readProfileDoc,
  readProjects,
  runnableBackends,
} from "../../services/profile-store.ts";
import { findRun, listRuns, readRoutes, type Run, runPaths } from "../../services/run-store.ts";
import { type RunSummary, summarizeRun } from "../../services/summary.ts";
import { defaultDeps } from "../deps.ts";
import { mcpHandshake } from "../mcp/handshake.ts";

/** A save refused because the profile changed on disk since its preview read it carries this path. */
export { CHANGED_ON_DISK } from "../../services/profile-service.ts";

/** One line of the run list. */
export interface RunRow {
  id: string;
  title: string;
  repo: string;
  createdAt: string;
  live: number;
  roleRuns: number;
  landed: number;
  /** the budget's spent fraction, null without a cap */
  budget: number | null;
}

interface Climb {
  lane: string;
  from: string;
  to: string;
  reason: string;
  /** the environment's fault (a limit, a missing service), not the rung's */
  env: boolean;
}

interface Decision {
  lane: string;
  role: string;
  source: RouteSource;
  kind: string | null;
  difficulty: string | null;
  rung: string;
}

/** Spec §9.1's run view: live lanes, climbs, Jev decisions, budget, landed milestones. */
export interface RunDetail {
  summary: RunSummary;
  climbs: Climb[];
  decisions: Decision[];
}

/**
 * Everything the TUI reads or changes, behind one seam (spec §9.4 `effects.ts`: services injected).
 * The live set calls the services; tests and the storybook pass fakes.
 */
export interface Effects {
  version: string;
  doctor(): Promise<DoctorReport>;
  runs(): { rows: RunRow[]; warnings: string[] };
  run(id: string): RunDetail;
  /** stops a live role; resolves to the line the toast shows */
  cancel(run: string, name: string): Promise<string>;
  profiles(): {
    names: string[];
    /** global */
    active: string;
    /** what this directory runs on */
    here: string;
    /** the bound repo, null outside one or unbound */
    repo: string | null;
  };
  readProfile(name: string): ProfileDoc;
  catalog(billing: Profile["billing"]): { catalog: Catalog; models: CatalogModel[] };
  validate(p: Profile, c: Catalog): Validation;
  enforcement(rung: string, access: Access): "enforced" | "advisory";
  /** the harnesses a profile can isolate */
  harnesses: readonly string[];
  /** the native agents a profile links, by name */
  agents(p: Profile): string[];
  /**
   * writes the staged treat-likes, then the profile patch, through the ProfileService (validation reads
   * the treat-likes, so they go first); a refused patch leaves the treat-likes written. With `shown` (the
   * profile as the save dialog's last preview read it), the patch is written only over that profile: when
   * another process changed it meanwhile (while a treat-like waited for the catalog lock, say), nothing
   * is written and the result's one error has the path CHANGED_ON_DISK
   */
  save(
    name: string,
    patch: ProfilePatch,
    treatLikes: Record<string, string>,
    shown?: ProfileDoc,
  ): Promise<Saved>;
  /**
   * applies the scope the user confirmed: binds `repo` (this TUI's repo) to it, or with null makes it the
   * global active profile; never a scope recomputed as it writes
   */
  activate(name: string, repo: string | null): Synced;
  create(name: string, from?: string): Saved;
  remove(name: string): Synced;
  refreshCatalog(): Promise<Refreshed[]>;
}

/** The word for `here`: the bound repo's profile, or the global active one. */
export const hereWord = (p: { repo: string | null }): string => (p.repo ? "this repo" : "active");

/**
 * What changes when a run changes: the mtimes of its record files and of its roles folder, plus the
 * profiles folder, config.json and projects.json (a saved budget cap or another active profile moves the
 * run's budget fraction).
 */
export function stampOf(dir: string): string {
  const p = runPaths(dir);
  return [
    p.runs,
    p.routes,
    p.jev,
    p.agents,
    p.state,
    p.ledger,
    p.roles,
    profilesDir(),
    configFile(),
    projectsFile(),
  ]
    .map((f) => {
      try {
        return String(statSync(f).mtimeMs);
      } catch {
        return "-";
      }
    })
    .join(" ");
}

/**
 * The run list, each row computed again only when its run's files changed or a role is live (spec §9.4:
 * runs data memoised by mtime). A live run's elapsed times move without any file changing.
 */
export function memoRuns(compute: (run: Run) => RunRow, stamp: (dir: string) => string = stampOf) {
  const cache = new Map<string, { stamp: string; row: RunRow }>();
  return (runs: Run[]): RunRow[] =>
    runs.map((r) => {
      const s = stamp(r.dir);
      const hit = cache.get(r.dir);
      if (hit && hit.stamp === s && hit.row.live === 0) return hit.row;
      const row = compute(r);
      cache.set(r.dir, { stamp: s, row });
      return row;
    });
}

export function rowOf(s: RunSummary): RunRow {
  return {
    id: s.id,
    title: s.title,
    repo: s.repo,
    createdAt: s.createdAt,
    live: s.live.length,
    roleRuns: s.totals.runs,
    landed: s.milestones.length,
    budget: s.budget?.fraction ?? null,
  };
}

/** The climbs and route decisions in a run's routes.jsonl. */
function routesOf(run: Run): { climbs: Climb[]; decisions: Decision[] } {
  const rows = readRoutes(run);
  return {
    climbs: rows
      .filter((r) => r.source === "climb" && r.from !== null)
      .map((r) => ({
        lane: r.lane,
        from: r.from as string,
        to: r.rung,
        reason: r.reason ?? "",
        env: r.env === true,
      })),
    decisions: rows
      .filter((r) => r.source === "route")
      .map((r) => ({
        lane: r.lane,
        role: r.role,
        source: r.decidedBy,
        kind: r.kind,
        difficulty: r.difficulty,
        rung: r.rung,
      })),
  };
}

/**
 * The live effects. `repo` is the git toplevel the TUI was opened in (null outside one): inside a repo
 * bound to a profile, `here` is that profile and activating binds the repo instead of the global profile.
 */
export function liveEffects(repo: string | null = null): Effects {
  const deps = defaultDeps();
  const rows = memoRuns((r) => rowOf(summarizeRun(deps, r)));
  const harnesses = HARNESS_KEYS.filter((h) => adapterFor(h));
  const bound = () => (repo !== null && readProjects().bindings[repo] !== undefined ? repo : null);
  return {
    version: VERSION,
    doctor: () => doctor({ bunVersion: Bun.version, version: VERSION, handshake: () => mcpHandshake() }),
    runs() {
      const { runs, corrupt } = listRuns();
      return { rows: rows(runs), warnings: corrupt.map((c) => `skipped run ${c.id}: ${c.reason}`) };
    },
    run(id) {
      const run = findRun(id);
      return { summary: summarizeRun(deps, run), ...routesOf(run) };
    },
    async cancel(run, name) {
      const r = await cancel(deps, run, name);
      return `${r.record.name} ${r.record.status}`;
    },
    profiles: () => ({ names: listProfiles(), active: activeName(), here: activeName(repo), repo: bound() }),
    readProfile: readProfileDoc,
    catalog(billing) {
      return {
        catalog: loadCatalog({ timings: false }),
        models: catalogQuery({ scoredOnly: false, limit: Number.MAX_SAFE_INTEGER }, billing).models,
      };
    },
    validate: (p, c) => validateProfile(p, c, runnableBackends()),
    enforcement: enforcementOf,
    harnesses,
    agents: (p) => agentFiles(p, VERSION).map((f) => f.name),
    async save(name, patch, treatLikes, shown) {
      for (const [rung, like] of Object.entries(treatLikes)) await saveTreatLike(rung, like);
      return patchProfile(name, patch, shown === undefined ? {} : { expect: shown });
    },
    activate: (name, scope) => activate(name, scope),
    create: createProfile,
    remove: deleteProfile,
    refreshCatalog: () => refreshDiscovery(),
  };
}
