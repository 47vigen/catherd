import type { Budget } from "../domain/budget.ts";
import type { BillingMode } from "../domain/cost.ts";
import type { Verdict } from "../domain/jev.ts";
import type { Difficulty, Kind } from "../domain/lane.ts";
import type { Access } from "../domain/record.ts";
import type { Role } from "../domain/roles.ts";
import type { Change, ProfilePatch } from "../domain/profile.ts";
import type { Issue } from "../domain/profile-rules.ts";
import type { RouteJev, RouteSource } from "../domain/route.ts";

/** What the run lifecycle reads from a profile. Rungs are `backend:model#effort`; a role's in ladder order. */
export interface ProfileView {
  name: string;
  objective: "cost" | "speed";
  /** `defaultRung`, when set, is where a lane starts without a kind and difficulty (spec §5.4) */
  roles: Partial<Record<Role, { enabled: boolean; access: Access; rungs: string[]; defaultRung?: string }>>;
  /** per billing key (spec §7.1); a missing key bills as DEFAULT_BILLING */
  billing: Partial<Record<string, BillingMode>>;
  jev: { use: "auto" | "off" };
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

export type { ProfilePatch };

/** What a profile write returns (spec §7.3): whether it saved, why not, what changed, and the agents it touched. */
export interface ProfileSaved {
  saved: boolean;
  errors: Issue[];
  warnings: Issue[];
  diff: Change[];
  linked: string[];
  pruned: string[];
  /** agents whose link is new or whose file changed: they apply from the next Claude Code session */
  newSessionNeededFor: string[];
}

export interface ProfilePort {
  /** The profile bound to `repo` (a git toplevel), else the active one; null asks for the active one. */
  forRepo(repo: string | null): ProfileView;
  /** Without a name (get, validate, set): the profile `repo`, a repository's toplevel, runs on. */
  get(
    name?: string,
    repo?: string | null,
  ): {
    /** the global active profile */
    active: string;
    /** the profile `repo` runs on: its binding, else the active one */
    here: string;
    profiles: string[];
    profile: ProfileView;
    /** per role: whether its backend holds it to its access mode (spec D10) */
    enforcement: Partial<Record<Role, "enforced" | "advisory">>;
  };
  validate(name?: string, repo?: string | null): { valid: boolean; errors: Issue[]; warnings: Issue[] };
  set(name: string | undefined, patch: ProfilePatch, repo?: string | null): ProfileSaved;
  /** The native agent that runs `rung` for `role` under `repo`'s profile; null unless it is a `claude:` rung. */
  agentFor(repo: string | null, role: Role, rung: string): string | null;
}

export interface RouteRequest {
  runDir: string;
  repo: string;
  profile: ProfileView;
  role: Role;
  /** the lane's id, for jev.jsonl; null when routing a role without a lane */
  lane: string | null;
  laneText: string | null;
  spentFraction: number;
}

export interface RouteAnswer {
  rung: string;
  ladder: string[];
  source: RouteSource;
  kind: Kind | null;
  difficulty: Difficulty | null;
  /** the Jev question set asked, and its summed probabilities, for outcomes.jsonl (spec §5.6) */
  questionSet: string | null;
  jev: RouteJev | null;
}

export type { Verdict };

export interface CatalogFilter {
  role?: Role;
  backend?: string;
  text?: string;
  scoredOnly: boolean;
  limit: number;
  /** the git toplevel whose per-repository listings (opencode's) to read; none reads the global ones */
  repo?: string;
}

export interface RoutingPort {
  route(req: RouteRequest): Promise<RouteAnswer>;
  /** `use` is the repo profile's `jev.use`: "off" answers with the rule's default and never asks Jev */
  finding(
    runDir: string,
    laneText: string,
    finding: string,
    use: "auto" | "off",
  ): Promise<Verdict<"design" | "code" | "unclear">>;
  sameDefect(
    runDir: string,
    before: string,
    after: string,
    use: "auto" | "off",
  ): Promise<Verdict<"yes" | "no">>;
  /** `billing` prices the rungs (spec §5.3); absent keys bill as DEFAULT_BILLING */
  catalog(
    filter: CatalogFilter,
    billing?: Partial<Record<string, BillingMode>>,
  ): { total: number; models: unknown[] };
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
