import type { Caps } from "../domain/caps.ts";
import type { NoRungCause } from "../domain/select.ts";
import type { HostContext } from "../domain/host.ts";
import type { Budget } from "../domain/budget.ts";
import type { SessionEnv } from "../infra/claude-session.ts";
import type { BillingMode } from "../domain/cost.ts";
import type { Access } from "../domain/record.ts";
import type { Role } from "../domain/roles.ts";
import type { RoleScope } from "../domain/role-scope.ts";
import type { Change, ProfileDoc, ProfilePatch } from "../domain/profile.ts";
import type { Issue } from "../domain/profile-rules.ts";
import type { IndexFile } from "../domain/slopalytics.ts";
import type { IndexStatus } from "./catalog-service.ts";

/** What the run lifecycle reads from a profile. Rungs are `backend:model#effort`; a role's in ladder order. */
export interface ProfileView {
  name: string;
  roles: Partial<
    Record<
      Role,
      {
        enabled: boolean;
        access: Access;
        rungs: string[];
        defaultRung?: string;
        network?: false;
        /** plan 23: the role's own timeouts over the profile's */
        timeouts?: { idleMin?: number; wallMin?: number };
      }
    >
  >;
  /** per billing key (spec §7.1); a missing key bills as DEFAULT_BILLING */
  billing: Partial<Record<string, BillingMode>>;
  /** per backend id: run its harness isolated (spec §7.1 `harness`) */
  isolated: Partial<Record<string, boolean>>;
  /** rung → its stand-in on a usage limit (spec §4.5) */
  failover: Record<string, string>;
  /** `<backend>:<model>` → the highest effort routing starts it at (plan 33) */
  maxEffort?: Record<string, string>;
  budget: Budget;
  timeouts: { idleMin: number; wallMin: number };
  /** plan 48, spec D10; absent means DEFAULT_CAPS */
  caps?: Caps;
  preflight: { confirm: boolean };
  land: { autoMerge: boolean };
  heavy: number | "cpus/2";
  notify: string[];
  /** plan 35: the memory numbers that cap milestones side by side, defaults filled */
  limits: { memory: { reserveMb: number; perMilestoneMb: number; floorMb: number } };
  /** plan 53, spec D6: the fast check a worker task without its own gets */
  fastCheck?: string;
}

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
  withHost?(host: () => HostContext): ProfilePort;
  raw?(name?: string, repo?: string | null): ProfileDoc;
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
  /**
   * What `set` would do, writing nothing; `expect` is the stored document the patch was applied to, `wouldSave`
   * whether `set` would write it, `added` the errors the patch adds.
   */
  preview?(
    name: string | undefined,
    patch: ProfilePatch,
    repo?: string | null,
  ): ProfileSaved & { expect: ProfileDoc; wouldSave: boolean; added: Issue[] };
  /** With `expect` (from `preview`), it writes nothing when the stored profile is no longer that one. */
  set(name: string | undefined, patch: ProfilePatch, repo?: string | null, expect?: ProfileDoc): ProfileSaved;
  /** The native agent that runs `rung` for `role` under `repo`'s profile; null unless it is a `claude:` rung. */
  agentFor(repo: string | null, role: Role, rung: string): string | null;
  /** The ntfy topic url of the phone messages: config's `notify.url`, a random ntfy.sh topic made once. */
  notifyUrl(): string;
  /** Replaces it; an http(s) url only. */
  setNotifyUrl(url: string): void;
}

export interface CatalogFilter {
  role?: Role;
  backend?: string;
  text?: string;
  /** include models a newer version replaces on their backend */
  older?: boolean;
  limit: number;
  /** the git toplevel whose per-repository listings (opencode's) to read; none reads the global ones */
  repo?: string;
}

export interface RoutingPort {
  /**
   * A run's start check: refreshes the index if it is due, reads it once, and names the enabled roles of `view`
   * that no indexed pair can fill; `index` is what the run pins (null when there is none).
   */
  checkStart(
    view: ProfileView,
    repo: string,
  ): Promise<{ unusable: Role[]; causes?: Partial<Record<Role, NoRungCause>>; index: IndexFile | null }>;
  /** `billing` prices the rungs (spec §5.3); absent keys bill as DEFAULT_BILLING */
  catalog(
    filter: CatalogFilter,
    billing?: Partial<Record<string, BillingMode>>,
  ): { total: number; models: unknown[] };
}

/** Everything a service needs from outside it; the entry layer builds one, tests build fakes. */
export interface Deps {
  host: HostContext;
  profiles: ProfilePort;
  routing: RoutingPort;
  version: string;
  /** how often the supervisor and the dispatch watchers poll, in ms */
  pollMs: number;
  /** Claude transport credentials and registry refresh; host identity lives in `host`. */
  session: SessionEnv | null;
  now: () => number;
  /** `catalog_sync`; default: the real refresh (tests inject one that never reaches the network) */
  sync?: (o: { force: boolean }) => Promise<IndexStatus>;
  /**
   * Spec 1.5 plan 21: the role this process works for (CATHERD_ROLE, or a role's scratch TMPDIR); null or
   * absent for the orchestrator's own server. A role never claims a run and never reaches a coordinator tool.
   */
  role?: RoleScope | null;
}
