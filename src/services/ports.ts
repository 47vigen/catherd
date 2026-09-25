import type { Budget } from "../domain/budget.ts";
import type { Difficulty, Kind } from "../domain/lane.ts";
import type { Access } from "../domain/record.ts";
import type { Role } from "../domain/roles.ts";
import type { RouteSource } from "../domain/route.ts";

/** What the run lifecycle reads from a profile. Rungs are `backend:model#effort`; a role's in ladder order. */
export interface ProfileView {
  name: string;
  roles: Partial<Record<Role, { enabled: boolean; access: Access; rungs: string[] }>>;
  /** per backend id: run its harness isolated (spec §7.1 `harness`) */
  isolated: Partial<Record<string, boolean>>;
  /** rung → its stand-in on a usage limit (spec §4.5) */
  failover: Record<string, string>;
  budget: Budget;
  timeouts: { idleMin: number; wallMin: number };
  preflight: { confirm: boolean };
  heavy: number | "cpus/2";
  notify: string[];
}

/** `profile_set`'s patch, in 1.0 rungs. */
export interface ProfilePatch {
  objective?: "cost" | "speed";
  roles?: Partial<Record<Role, { enabled?: boolean; rungs?: string[]; defaultRung?: string }>>;
  harness?: Partial<Record<"codex" | "opencode", { isolated: boolean }>>;
  lock?: { heavy: number | "cpus/2" };
  notify?: ("milestone" | "finish" | "blocked")[];
  failover?: Record<string, string>;
  budget?: Budget;
}

export interface ProfilePort {
  /** The profile bound to `repo` (a git toplevel), else the active one; null asks for the active one. */
  forRepo(repo: string | null): ProfileView;
  get(name?: string): { active: string; profiles: string[]; profile: ProfileView };
  validate(name?: string): { valid: boolean; errors: string[] };
  set(
    name: string | undefined,
    patch: ProfilePatch,
  ): { saved: boolean; errors: string[]; diff: unknown[]; newSessionNeededFor: string[] };
}

export interface RouteRequest {
  runDir: string;
  repo: string;
  role: Role;
  laneText: string | null;
  spentFraction: number;
}

export interface RouteAnswer {
  rung: string;
  ladder: string[];
  source: RouteSource;
  kind: Kind | null;
  difficulty: Difficulty | null;
}

export interface Verdict<T extends string> {
  value: T;
  confidence: number | null;
  source: "jev" | "default";
}

export interface CatalogFilter {
  role?: Role;
  backend?: string;
  text?: string;
  scoredOnly: boolean;
  limit: number;
}

export interface RoutingPort {
  route(req: RouteRequest): Promise<RouteAnswer>;
  /** The native Claude agent that runs `rung` for `role`; null unless the rung is a `claude:` one. */
  agentFor(role: Role, rung: string): string | null;
  finding(runDir: string, laneText: string, finding: string): Promise<Verdict<"design" | "code" | "unclear">>;
  sameDefect(runDir: string, before: string, after: string): Promise<Verdict<"yes" | "no">>;
  catalog(filter: CatalogFilter): { total: number; models: unknown[] };
}

/** Everything a service needs from outside it; the entry layer builds one, tests build fakes. */
export interface Deps {
  profiles: ProfilePort;
  routing: RoutingPort;
  version: string;
  /** how often the supervisor and the dispatch wait poll, in ms */
  pollMs: number;
  /** how often a running dispatch reports progress, in ms (spec §4.4: 30 s) */
  tickMs: number;
  now: () => number;
}
