export const ROLES = [
  "architect",
  "verifier",
  "worker",
  "reviewer",
  "ui-reviewer",
  "artist",
  "writer",
  "researcher",
] as const;
export type Role = (typeof ROLES)[number];

export type Backend = "codex" | "opencode" | "claude";

/** "<model-id>#<effort>". Model ids may contain "/" (opencode providers); split at the LAST "#". */
export type RungId = string;

export function splitRung(rung: RungId): { model: string; effort: string } {
  const i = rung.lastIndexOf("#");
  if (i < 1 || i === rung.length - 1) throw new Error(`catherd: bad rung "${rung}", expected model#effort`);
  return { model: rung.slice(0, i), effort: rung.slice(i + 1) };
}

export const rungOf = (model: string, effort: string): RungId => `${model}#${effort}`;

export type Sandbox = "read-only" | "workspace-write" | "danger-full-access";

/** Spec §4: the sandbox a Codex or opencode run of each role gets. */
export const ROLE_SANDBOX: Record<Role, Sandbox> = {
  architect: "read-only",
  verifier: "danger-full-access",
  worker: "workspace-write",
  reviewer: "read-only",
  "ui-reviewer": "danger-full-access",
  artist: "workspace-write",
  writer: "workspace-write",
  researcher: "read-only",
};

export interface Capabilities {
  toolCall: boolean;
  imageIn: boolean;
  imageOut: boolean;
  reasoning: boolean;
  context: number;
}

/** Spec §4: what a model must have to be offered for a role. */
export const ROLE_NEEDS: Record<Role, Partial<Capabilities>> = {
  architect: { toolCall: true },
  verifier: { toolCall: true },
  worker: { toolCall: true },
  reviewer: { toolCall: true },
  "ui-reviewer": { toolCall: true, imageIn: true },
  artist: { imageOut: true },
  writer: { toolCall: true },
  researcher: { toolCall: true },
};

export const KINDS = ["repo_code", "terminal", "ui", "prose", "research"] as const;
export type Kind = (typeof KINDS)[number];

export const DIFFICULTIES = ["copy", "build", "logic", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export type ScoreDim = "repo_code" | "terminal" | "honesty";

export interface Scores {
  repo_code?: number;
  terminal?: number;
  honesty?: number;
  secs_per_task?: number;
}

export interface CatalogModel {
  id: string;
  backend: Backend;
  efforts: string[];
  capabilities: Capabilities;
}

export interface CatalogEntry {
  rung: RungId;
  scores: Scores;
  costRank: number;
}

export type Bars = Record<Kind, Record<Difficulty, Partial<Record<ScoreDim, number>>>>;

export interface Catalog {
  version: string;
  models: CatalogModel[];
  entries: CatalogEntry[];
  bars: Bars;
  /** unscored rung -> scored rung whose scores it borrows */
  treatLike: Record<RungId, RungId>;
}

export interface RoleConfig {
  enabled: boolean;
  /** model id -> enabled efforts */
  models: Record<string, string[]>;
  defaultRung?: RungId;
}

export type NotifyMoment = "milestone" | "finish" | "blocked";

/** Spec §8.2: false (the default) runs the vendor harness exactly as the user configured it. */
export interface HarnessConfig {
  isolated: boolean;
}

export interface Profile {
  name: string;
  objective: "cost" | "speed";
  roles: Record<Role, RoleConfig>;
  harness: { codex: HarnessConfig; opencode: HarnessConfig };
  lock: { heavy: number | "cpus/2" };
  notify: NotifyMoment[];
  /** spec §11b: a rung's stand-in on another backend, used on a `limit` result */
  failover?: Record<RungId, RungId>;
  /** spec §11b: the run budget; `status` shows spend against it, `route` and `dispatch` react at 80%/100% */
  budget?: { minutes?: number; tokens?: number; usd?: number };
}

export interface RouteDecision {
  kind: Kind | null;
  difficulty: Difficulty | null;
  confidence: { kind: number | null; difficulty: number | null };
  source: "jev" | "default";
  rung: RungId;
  ladder: RungId[];
}

export type ReplyStatus = "complete" | "partial" | "blocked" | "refused";
export type RunStatus = "ok" | "failed" | "limit" | "cli-too-old" | "timeout" | "interrupted";

export interface Tokens {
  input: number;
  cached: number;
  output: number;
}

/** One Codex or opencode role run. Appended to <run>/runs.jsonl; the only record of it. */
export interface RunRecord {
  name: string;
  role: Role;
  backend: "codex" | "opencode";
  rung: RungId;
  thread: string | null;
  status: RunStatus;
  startedAt: string;
  secs: number;
  pid: number | null;
  tokens: Tokens;
  costUsd: number | null;
  changedOwned: string[];
  replyStatus: ReplyStatus | null;
  replyWhy: string | null;
  threadHeavy: boolean;
  /** the harness ran isolated (spec §8.2); lets reports measure what the user's customizations cost */
  isolated: boolean;
  images: string[];
  error: string | null;
  replyPath: string;
}

export interface RunMeta {
  id: string;
  repo: string;
  title: string;
  aLines: string[];
  createdAt: string;
}

export interface StateSnapshot {
  head: string;
  dirty: { path: string; owner: string | null }[];
  running: { name: string; rung: RungId; thread: string | null; brief: string; since: string }[];
  lastCheck: string | null;
  next: string;
}

export const THREAD_HEAVY_INPUT = 8_000_000;
