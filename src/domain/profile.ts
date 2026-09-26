import { z } from "zod";
import type { Budget } from "./budget.ts";
import { BILLING_KEYS, type BillingKey } from "./catalog.ts";
import { BILLING_MODES, type BillingMode, DEFAULT_BILLING } from "./cost.ts";
import { CatherdError } from "./errors.ts";
import { parseRung } from "./ids.ts";
import { ACCESS, type Access } from "./record.ts";
import { DEFAULT_ACCESS, ROLES, type Role } from "./roles.ts";

/** Spec §3.4: every file carries its schema version; a profile is schema 1. */
export const PROFILE_SCHEMA = 1;

/** Profile names end up in agent names (`catherd-<profile>-…`), which Claude Code wants lowercase. */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function assertProfileName(name: string): string {
  if (!PROFILE_NAME.test(name))
    throw new CatherdError("E_INPUT_INVALID", `bad profile name "${name}"`, {
      fix: "use lowercase letters, digits and '-', at most 32, starting with a letter or digit",
    });
  return name;
}

export const NOTIFY = ["milestone", "finish", "blocked"] as const;
export type NotifyMoment = (typeof NOTIFY)[number];

/** The harnesses a profile can isolate (spec §7.1 `harness`); the native `claude` path has none. */
export const HARNESS_KEYS = ["codex", "claude-code", "opencode", "cursor", "grok"] as const;

const isRung = (s: string): boolean => {
  try {
    parseRung(s);
    return true;
  } catch {
    return false;
  }
};
/** A `<backend>:<model>#<effort>` rung, for input schemas; stored profiles keep any string and validate. */
export const RungSchema = z.string().refine(isRung, "a rung is <backend>:<model>#<effort>");

const positive = z.number().positive();

// Stored files: every level is loose, so fields a newer catherd wrote survive a rewrite (spec §3.4), and
// rung strings are checked by validateProfile rather than making the whole file unreadable.
const RoleDocSchema = z.looseObject({
  enabled: z.boolean().optional(),
  access: z.enum(ACCESS).optional(),
  rungs: z.array(z.string()).optional(),
  defaultRung: z.string().optional(),
});

export const ProfileDocSchema = z.looseObject({
  schema: z.literal(PROFILE_SCHEMA),
  name: z.string().optional(),
  objective: z.enum(["cost", "speed"]).optional(),
  jev: z.looseObject({ use: z.enum(["auto", "off"]).optional() }).optional(),
  billing: z.record(z.string(), z.enum(BILLING_MODES)).optional(),
  roles: z.record(z.string(), RoleDocSchema).optional(),
  harness: z.record(z.string(), z.looseObject({ isolated: z.boolean().optional() })).optional(),
  failover: z.record(z.string(), z.string()).optional(),
  budget: z
    .looseObject({ minutes: positive.optional(), tokens: positive.optional(), usd: positive.optional() })
    .optional(),
  timeouts: z.looseObject({ idleMin: positive.optional(), wallMin: positive.optional() }).optional(),
  preflight: z.looseObject({ confirm: z.boolean().optional() }).optional(),
  lock: z
    .looseObject({ heavy: z.union([z.number().int().positive(), z.literal("cpus/2")]).optional() })
    .optional(),
  notify: z.array(z.enum(NOTIFY)).optional(),
});
export type ProfileDoc = z.infer<typeof ProfileDocSchema>;

// a type, not an interface, so the built-in roles can be written into a loose (indexed) document
export type RoleConfig = {
  enabled: boolean;
  access: Access;
  /** in ladder order, each `backend:model#effort`; `claude:` runs as a native subagent, `claude-code:` headless */
  rungs: string[];
  defaultRung?: string;
};

/** A profile with every default filled in: what the run engine, the CLI and the agent files read. */
export interface Profile {
  name: string;
  objective: "cost" | "speed";
  jev: { use: "auto" | "off" };
  billing: Record<string, BillingMode>;
  roles: Record<Role, RoleConfig>;
  harness: Record<string, { isolated: boolean }>;
  failover: Record<string, string>;
  budget: Budget;
  timeouts: { idleMin: number; wallMin: number };
  preflight: { confirm: boolean };
  lock: { heavy: number | "cpus/2" };
  notify: NotifyMoment[];
}

const LUNA_HIGH = "codex:gpt-6-luna#high";
const SOL = (effort: string) => `codex:gpt-6-sol#${effort}`;

/**
 * Spec §7.2, the owner's setup (Codex on a ChatGPT plan, a Claude plan, OpenCode Go). A role missing
 * from a profile takes its entry here. Architect and verifier run as native Claude subagents (D3).
 */
export const BUILTIN_ROLES: Record<Role, RoleConfig> = {
  architect: { enabled: true, access: DEFAULT_ACCESS.architect, rungs: ["claude:claude-opus-5-5#high"] },
  verifier: { enabled: true, access: DEFAULT_ACCESS.verifier, rungs: ["claude:claude-opus-5-5#low"] },
  worker: {
    enabled: true,
    access: DEFAULT_ACCESS.worker,
    rungs: [LUNA_HIGH, SOL("medium"), SOL("high"), SOL("xhigh")],
    defaultRung: SOL("medium"),
  },
  reviewer: { enabled: true, access: DEFAULT_ACCESS.reviewer, rungs: [SOL("high")] },
  "ui-reviewer": { enabled: true, access: DEFAULT_ACCESS["ui-reviewer"], rungs: [SOL("medium")] },
  artist: { enabled: true, access: DEFAULT_ACCESS.artist, rungs: [SOL("medium")] },
  writer: { enabled: true, access: DEFAULT_ACCESS.writer, rungs: [LUNA_HIGH] },
  researcher: { enabled: true, access: DEFAULT_ACCESS.researcher, rungs: [LUNA_HIGH] },
};

/**
 * Spec §7.2: each Codex rung fails over to the best-matching OpenCode Go model. Go serves GPT-6 Luna
 * itself; for Sol it has no GPT model, so Kimi K3 stands in through a shipped treat-like (scores.json),
 * which `profile show` marks inferred.
 */
export const DEFAULT_FAILOVER: Record<string, string> = {
  [LUNA_HIGH]: "opencode:opencode-go/gpt-6-luna#high",
  [SOL("medium")]: "opencode:opencode-go/kimi-k3#max",
  [SOL("high")]: "opencode:opencode-go/kimi-k3#max",
  [SOL("xhigh")]: "opencode:opencode-go/kimi-k3#max",
};

/** The five billing keys spec §7.1 writes out; cursor and grok arrive with their backends. */
const WRITTEN_BILLING: BillingKey[] = ["codex", "claude", "claude-code", "opencode-go", "opencode"];

/** The full default profile document, every field written out: what `init` and `profile new` save. */
export function defaultProfileDoc(name = "default"): ProfileDoc {
  return {
    schema: PROFILE_SCHEMA,
    name,
    objective: "cost",
    jev: { use: "auto" },
    billing: Object.fromEntries(WRITTEN_BILLING.map((k) => [k, DEFAULT_BILLING[k]])),
    roles: structuredClone(BUILTIN_ROLES),
    harness: {
      codex: { isolated: false },
      "claude-code": { isolated: false },
      opencode: { isolated: false },
    },
    failover: { ...DEFAULT_FAILOVER },
    budget: {},
    timeouts: { idleMin: 15, wallMin: 90 },
    preflight: { confirm: false },
    lock: { heavy: "cpus/2" },
    notify: [...NOTIFY],
  };
}

/** Spec §7.1: every field a document leaves out takes its default; a missing role takes the built-in one. */
export function resolveProfile(doc: ProfileDoc, name: string): Profile {
  const roles = {} as Record<Role, RoleConfig>;
  for (const role of ROLES) {
    const d = doc.roles?.[role];
    const b = BUILTIN_ROLES[role];
    // a role that lists its own rungs never inherits the built-in default rung, which may not be among them
    const defaultRung = d?.defaultRung ?? (d?.rungs === undefined ? b.defaultRung : undefined);
    roles[role] = {
      enabled: d?.enabled ?? b.enabled,
      access: d?.access ?? DEFAULT_ACCESS[role],
      rungs: [...(d?.rungs ?? b.rungs)],
      ...(defaultRung ? { defaultRung } : {}),
    };
  }
  const harness: Profile["harness"] = {};
  for (const k of new Set([...HARNESS_KEYS, ...Object.keys(doc.harness ?? {})]))
    harness[k] = { isolated: doc.harness?.[k]?.isolated ?? false };
  const budget: Budget = {};
  for (const k of ["minutes", "tokens", "usd"] as const) {
    const v = doc.budget?.[k];
    if (v !== undefined) budget[k] = v;
  }
  return {
    name,
    objective: doc.objective ?? "cost",
    jev: { use: doc.jev?.use ?? "auto" },
    billing: { ...DEFAULT_BILLING, ...doc.billing },
    roles,
    harness,
    failover: { ...doc.failover },
    budget,
    timeouts: { idleMin: doc.timeouts?.idleMin ?? 15, wallMin: doc.timeouts?.wallMin ?? 90 },
    preflight: { confirm: doc.preflight?.confirm ?? false },
    lock: { heavy: doc.lock?.heavy ?? "cpus/2" },
    notify: [...(doc.notify ?? NOTIFY)],
  };
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Spec §7.3: `catherd-<profile>-<role>-<model slug>-<effort>`, the native subagent for a `claude:` rung. */
export function agentName(profile: string, role: Role, rung: string): string {
  const r = parseRung(rung);
  return `catherd-${profile}-${role}-${slug(r.model)}-${slug(r.effort)}`;
}

// Patches: what profile_set and `catherd profile set` accept. Strict at every level, so a misspelt key is
// refused with E_INPUT_INVALID instead of dropped (plan-2 review m9). `null` removes a map entry.
const RolePatchSchema = z
  .strictObject({
    enabled: z.boolean(),
    access: z.enum(ACCESS),
    rungs: z.array(RungSchema),
    defaultRung: RungSchema.nullable(),
  })
  .partial();

export const ProfilePatchSchema = z.strictObject({
  objective: z.enum(["cost", "speed"]).optional(),
  jev: z.strictObject({ use: z.enum(["auto", "off"]) }).optional(),
  billing: z.partialRecord(z.enum(BILLING_KEYS), z.enum(BILLING_MODES).nullable()).optional(),
  roles: z.partialRecord(z.enum(ROLES), RolePatchSchema).optional(),
  harness: z.partialRecord(z.enum(HARNESS_KEYS), z.strictObject({ isolated: z.boolean() })).optional(),
  failover: z.record(RungSchema, RungSchema.nullable()).optional(),
  budget: z
    .strictObject({ minutes: positive.nullable(), tokens: positive.nullable(), usd: positive.nullable() })
    .partial()
    .optional(),
  timeouts: z.strictObject({ idleMin: positive, wallMin: positive }).partial().optional(),
  preflight: z.strictObject({ confirm: z.boolean() }).optional(),
  lock: z.strictObject({ heavy: z.union([z.number().int().positive(), z.literal("cpus/2")]) }).optional(),
  notify: z.array(z.enum(NOTIFY)).optional(),
});
export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** RFC 7396 merge: objects merge key by key, `null` deletes, anything else (arrays too) replaces. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlain(patch)) return patch;
  const out: Record<string, unknown> = isPlain(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/** The document with `patch` applied; every field the patch does not name, known or not, is kept. */
export function applyPatch(doc: ProfileDoc, patch: ProfilePatch): ProfileDoc {
  return ProfileDocSchema.parse(mergePatch(doc, patch));
}

/** Map fields whose keys are rungs or billing keys, which may hold dots: the rest of the path is one key. */
const MAP_FIELDS = new Set(["failover", "billing"]);
const LIST_FIELDS = (keys: string[]) =>
  (keys[0] === "roles" && keys[2] === "rungs") || (keys[0] === "notify" && keys.length === 1);

/**
 * `catherd profile set <path> <value>` as a patch. The value is JSON when it parses (numbers, booleans,
 * `null`, arrays), else the plain word; a rung list may also be comma-separated.
 */
export function patchAt(path: string, raw: string): ProfilePatch {
  const segs = path.split(".");
  const keys =
    MAP_FIELDS.has(segs[0] ?? "") && segs.length > 1 ? [segs[0] as string, segs.slice(1).join(".")] : segs;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  if (LIST_FIELDS(keys) && typeof value === "string")
    value = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const patch = keys.reduceRight<unknown>((inner, k) => ({ [k]: inner }), value);
  const r = keys.some((k) => !k) ? null : ProfilePatchSchema.safeParse(patch);
  if (!r?.success)
    throw new CatherdError(
      "E_INPUT_INVALID",
      `cannot set ${path} to ${raw}${r ? `: ${z.prettifyError(r.error).replace(/\n\s*/g, " ")}` : ""}`,
      {
        fix: "catherd profile show --json lists the fields; e.g. catherd profile set roles.worker.access read-only",
      },
    );
  return r.data;
}

export interface Change {
  path: string;
  before: unknown;
  after: unknown;
}

/** Leaves by dotted path; an empty object has none, so `budget: {}` → `budget.usd: 5` is one change. */
function flatten(v: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isPlain(v)) for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  else if (v !== undefined) out.set(prefix, v);
}

/** Every leaf that differs between two profiles; lists compare whole. */
export function diffProfiles(a: Profile, b: Profile): Change[] {
  const fa = new Map<string, unknown>();
  const fb = new Map<string, unknown>();
  flatten({ ...a, name: undefined }, "", fa);
  flatten({ ...b, name: undefined }, "", fb);
  const changes: Change[] = [];
  for (const path of [...new Set([...fa.keys(), ...fb.keys()])].sort()) {
    const before = fa.get(path) ?? null;
    const after = fb.get(path) ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ path, before, after });
  }
  return changes;
}
