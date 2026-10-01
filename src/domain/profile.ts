import type { OrchestrationHost } from "./host.ts";
import { z } from "zod";
import type { Budget } from "./budget.ts";
import { BILLING_KEYS, type BillingKey } from "./catalog.ts";
import { BILLING_MODES, type BillingMode, DEFAULT_BILLING } from "./cost.ts";
import { CatherdError } from "./errors.ts";
import { ADAPTER_IDS, parseRung, tryParseRung } from "./ids.ts";
import { ACCESS, type Access } from "./record.ts";
import { DEFAULT_ACCESS, ROLES, type Role } from "./roles.ts";
import { isPlain, slug } from "./util.ts";

/** Spec §3.4: every file carries its schema version; a profile is schema 1. */
const PROFILE_SCHEMA = 1;

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
export const HARNESS_KEYS = ADAPTER_IDS;

const isRung = (s: string): boolean => tryParseRung(s) !== null;
/** A `<backend>:<model>#<effort>` rung, for input schemas; stored profiles keep any string and validate. */
const RungSchema = z.string().refine(isRung, "a rung is <backend>:<model>#<effort>");

const positive = z.number().positive();

// Stored files: every level is loose, so fields a newer catherd wrote survive a rewrite (spec §3.4), and
// rung strings are checked by validateProfile rather than making the whole file unreadable. The same holds
// for values: a stored enum takes any string, resolveProfile reads one it does not know as STORED_FALLBACK
// says, validateProfile warns, and the file keeps it.
const RoleDocSchema = z.looseObject({
  enabled: z.boolean().optional(),
  access: z.string().optional(),
  rungs: z.array(z.string()).optional(),
  defaultRung: z.string().optional(),
  network: z.boolean().optional(),
});

export const ProfileDocSchema = z.looseObject({
  schema: z.literal(PROFILE_SCHEMA),
  name: z.string().optional(),
  objective: z.string().optional(),
  jev: z.looseObject({ use: z.string().optional() }).optional(),
  billing: z.record(z.string(), z.string()).optional(),
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
  notify: z.array(z.string()).optional(),
});
export type ProfileDoc = z.infer<typeof ProfileDocSchema>;

const OBJECTIVES = ["cost", "speed"] as const;
const JEV_USES = ["auto", "off"] as const;
const known = <T extends string>(values: readonly T[], v: string | undefined): v is T =>
  v !== undefined && (values as readonly string[]).includes(v);

/**
 * How a stored value this catherd does not know (a newer one wrote it) is read, always the cautious way:
 * access as read-only, billing as the key's default mode, Jev as off, so nothing is sent or written that
 * the value may not allow; an unknown notify moment is skipped.
 */
const STORED_FALLBACK = {
  objective: "cost",
  jevUse: "off",
  access: "read-only",
  billing: (key: string): BillingMode => DEFAULT_BILLING[key as BillingKey] ?? "metered",
} as const;

/** A stored value this catherd does not know, with what it is read as. */
export interface UnknownValue {
  path: string;
  value: string;
  readAs: string;
}

/** Every stored enum value in `doc` this catherd does not know (spec §3.4: newer files stay readable). */
export function unknownValues(doc: ProfileDoc): UnknownValue[] {
  const out: UnknownValue[] = [];
  const check = (path: string, values: readonly string[], v: string | undefined, readAs: string) => {
    if (v !== undefined && !values.includes(v)) out.push({ path, value: v, readAs });
  };
  check("objective", OBJECTIVES, doc.objective, STORED_FALLBACK.objective);
  check("jev.use", JEV_USES, doc.jev?.use, STORED_FALLBACK.jevUse);
  for (const [k, v] of Object.entries(doc.billing ?? {}))
    check(`billing.${k}`, BILLING_MODES, v, STORED_FALLBACK.billing(k));
  for (const role of ROLES)
    check(`roles.${role}.access`, ACCESS, doc.roles?.[role]?.access, STORED_FALLBACK.access);
  for (const n of doc.notify ?? []) check("notify", NOTIFY, n, "skipped");
  return out;
}

// a type, not an interface, so the built-in roles can be written into a loose (indexed) document
export type RoleConfig = {
  enabled: boolean;
  access: Access;
  /** in ladder order, each `backend:model#effort`; `claude:` runs as a native subagent, `claude-code:` headless */
  rungs: string[];
  defaultRung?: string;
  /** spec §5: false drops a workspace-write role's network, loopback and Docker grants; absent means granted */
  network?: false;
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
 * Spec 1.1 §11: each shipped worker rung fails over to the best stand-in the shipped catalog offers
 * (`rankStandIns` over `catalogRungs`, pinned by test/domain/failover.test.ts): on another quota, paid
 * from a plan, and no downgrade on the dims the rung's bars use. Go serves GPT-6 Luna itself; Kimi K3
 * borrows Sol medium's scores (a shipped treat-like). Sol high and xhigh have no such stand-in on the
 * owner's plans, so they have none: a limit on them pauses the lane instead of dropping it a tier.
 */
export const DEFAULT_FAILOVER: Record<string, string> = {
  [LUNA_HIGH]: "opencode:opencode-go/gpt-6-luna#high",
  [SOL("medium")]: "opencode:opencode-go/kimi-k3#max",
};

/**
 * Cursor's live slug and efforts for a paired family (`cursor-agent models`, 2026-10-01). Empty efforts means the
 * bare slug.
 */
const CURSOR_PAIR: Record<string, { id: string; efforts: readonly string[] }> = {
  "grok-4.7": { id: "grok-4.7", efforts: ["low", "medium", "high", "xhigh"] },
  "grok-4.6": { id: "cursor-grok-4.6", efforts: ["low", "medium", "high", "xhigh"] },
  "grok-4.5": { id: "cursor-grok-4.5", efforts: ["low", "medium", "high"] },
  "gemini-3.8-flash": { id: "gemini-3.8-flash", efforts: ["low", "medium", "high"] },
  "gemini-3.7-flash": { id: "gemini-3.7-flash", efforts: ["low", "medium", "high"] },
  "gemini-3.6-flash": { id: "gemini-3.6-flash", efforts: ["minimal", "low", "medium", "high"] },
  "gemini-3.1-pro": { id: "gemini-3.1-pro", efforts: [] },
};

/** The Cursor effort a paired rung can actually run: the same one when listed, else `high`, else the bare slug. */
function cursorPairEffort(model: string, effort: string): string {
  const list = CURSOR_PAIR[model]?.efforts ?? [];
  if (list.length === 0) return "default";
  if (effort !== "default" && list.includes(effort)) return effort;
  return list.includes("high") ? "high" : (list[0] as string);
}

/**
 * Spec 1.3 §7.3: the same model through two backends bills two pools, so each stands in for the other on a
 * limit, at the same effort where both list it. Otherwise the stand-in runs at `high`: Grok 4.5 `xhigh` at Cursor
 * `high`, Cursor's Gemini 3.6 `minimal` at agy `high`; Gemini 3.1 Pro's bare Cursor slug pairs with agy `high`.
 * Grok and Gemini are paired with Cursor. Consulted after the profile's own failover and never written into a
 * profile, where a pair whose rung is on no ladder would warn "never runs"; never a stand-in for a shipped Codex,
 * Claude or opencode rung.
 */
export const PAIRED_FAILOVER: Record<string, string> = Object.fromEntries(
  (
    [
      ["grok", ["grok-4.7", "grok-4.6", "grok-4.5"], ["low", "medium", "high", "xhigh"]],
      [
        "antigravity",
        ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"],
        ["low", "medium", "high"],
      ],
      ["antigravity", ["gemini-3.1-pro"], ["low", "high"]],
    ] as const
  ).flatMap(([backend, models, efforts]) =>
    models.flatMap((m) => {
      const cursor = CURSOR_PAIR[m] as { id: string; efforts: readonly string[] };
      const back = ["default", ...efforts].map(
        (e) => [`${backend}:${m}#${e}`, `cursor:${cursor.id}#${cursorPairEffort(m, e)}`] as const,
      );
      // `#default` too, as on the other side: a Cursor rung with no effort flag fails over the same way
      const fore = [...new Set(["default", ...cursor.efforts])].map((e) => {
        const there = e !== "default" && (efforts as readonly string[]).includes(e) ? e : "high";
        return [`cursor:${cursor.id}#${e}`, `${backend}:${m}#${there}`] as const;
      });
      return [...back, ...fore];
    }),
  ),
);

/** The five billing keys spec §7.1 writes out; cursor and grok arrive with their backends. */
const WRITTEN_BILLING: BillingKey[] = ["codex", "claude", "claude-code", "opencode-go", "opencode"];

/** Stored defaults for init/new; architect/verifier rungs resolve from the current host. */
export function defaultProfileDoc(name = "default"): ProfileDoc {
  return {
    schema: PROFILE_SCHEMA,
    name,
    objective: "cost",
    jev: { use: "auto" },
    billing: Object.fromEntries(WRITTEN_BILLING.map((k) => [k, DEFAULT_BILLING[k]])),
    roles: hostDefaultsDoc({ schema: PROFILE_SCHEMA, roles: structuredClone(BUILTIN_ROLES) }).roles,
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

/** Remove only the four architect/verifier execution choices, preserving other stored fields. */
export function hostDefaultsDoc(doc: ProfileDoc): ProfileDoc {
  const next = structuredClone(doc);
  for (const role of ["architect", "verifier"] as const) {
    const r = next.roles?.[role];
    if (r) {
      delete r.rungs;
      delete r.defaultRung;
    }
  }
  return next;
}

/** Resolve omitted role execution choices from the explicit orchestration host. */
export function resolveProfile(doc: ProfileDoc, name: string, host: OrchestrationHost): Profile {
  const roles = {} as Record<Role, RoleConfig>;
  for (const role of ROLES) {
    const d = doc.roles?.[role];
    const b = BUILTIN_ROLES[role];
    let omitted = b.rungs;
    if ((role === "architect" || role === "verifier") && d?.rungs === undefined) {
      if (host === "unknown" && (d?.enabled ?? b.enabled))
        throw new CatherdError("E_CONFIG_INVALID", `roles.${role}.rungs needs an orchestration host`, {
          fix: "pass --host codex or --host claude-code, or set explicit role rungs",
        });
      omitted =
        host === "codex"
          ? [`codex:gpt-6.1-sol#${role === "architect" ? "high" : "low"}`]
          : host === "unknown"
            ? []
            : b.rungs;
    }
    // a role that lists its own rungs never inherits the built-in default rung, which may not be among them
    const defaultRung = d?.defaultRung ?? (d?.rungs === undefined ? b.defaultRung : undefined);
    roles[role] = {
      enabled: d?.enabled ?? b.enabled,
      access:
        d?.access === undefined
          ? DEFAULT_ACCESS[role]
          : known(ACCESS, d.access)
            ? d.access
            : STORED_FALLBACK.access,
      rungs: [...(d?.rungs ?? omitted)],
      ...(defaultRung ? { defaultRung } : {}),
      ...(d?.network === false ? { network: false as const } : {}),
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
  const billing: Record<string, BillingMode> = { ...DEFAULT_BILLING };
  for (const [k, v] of Object.entries(doc.billing ?? {}))
    billing[k] = known(BILLING_MODES, v) ? v : STORED_FALLBACK.billing(k);
  const use = doc.jev?.use;
  return {
    name,
    objective: known(OBJECTIVES, doc.objective) ? doc.objective : STORED_FALLBACK.objective,
    jev: { use: use === undefined ? "auto" : known(JEV_USES, use) ? use : STORED_FALLBACK.jevUse },
    billing,
    roles,
    harness,
    failover: { ...doc.failover },
    budget,
    timeouts: { idleMin: doc.timeouts?.idleMin ?? 15, wallMin: doc.timeouts?.wallMin ?? 90 },
    preflight: { confirm: doc.preflight?.confirm ?? false },
    lock: { heavy: doc.lock?.heavy ?? "cpus/2" },
    notify: doc.notify === undefined ? [...NOTIFY] : doc.notify.filter((n) => known(NOTIFY, n)),
  };
}

/** Spec §7.3: `catherd-<profile>-<role>-<model slug>-<effort>`, the native subagent for a `claude:` rung. */
export function agentName(profile: string, role: Role, rung: string): string {
  const r = parseRung(rung);
  return `catherd-${profile}-${role}-${slug(r.model)}-${slug(r.effort)}`;
}

// Patches: what profile_set and `catherd profile set` accept. Strict at every level, so a misspelt key is
// refused with E_INPUT_INVALID instead of dropped (plan-2 review m9). `null` removes a map entry or a nullable
// field (a role's `network` among them: absent means granted).
const RolePatchSchema = z
  .strictObject({
    enabled: z.boolean(),
    access: z.enum(ACCESS),
    rungs: z.array(RungSchema),
    defaultRung: RungSchema.nullable(),
    network: z.boolean().nullable(),
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

/** RFC 7396 merge: objects merge key by key, `null` deletes, anything else (arrays too) replaces. */
function mergePatch(target: unknown, patch: unknown): unknown {
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

/**
 * The patch that turns `a` into `b`: the leaves that differ, lists whole, a removed key as `null`. Fields
 * both documents share unchanged, known or not, are left out, so applying it over a newer copy of `a`
 * keeps whatever else changed there. Throws E_INPUT_INVALID when `b` holds what no patch may set.
 */
export function patchBetween(a: ProfileDoc, b: ProfileDoc): ProfilePatch {
  const diff = (x: unknown, y: unknown): unknown => {
    if (!isPlain(x) || !isPlain(y)) return y;
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (!(k in y)) out[k] = null;
      else if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) out[k] = diff(x[k], y[k]);
    }
    return out;
  };
  const r = ProfilePatchSchema.safeParse(diff(a, b));
  if (!r.success)
    throw new CatherdError(
      "E_INPUT_INVALID",
      `these changes cannot be saved: ${z.prettifyError(r.error).replace(/\n\s*/g, " ")}`,
      {
        fix: "undo the last change, or edit the field with catherd profile set",
      },
    );
  return r.data;
}
