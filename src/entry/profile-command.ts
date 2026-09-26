import { assertProfileName } from "../domain/profile.ts";
import { defineCommand } from "citty";
import type { Catalog } from "../domain/catalog.ts";
import { rungInfo } from "../domain/catalog.ts";
import { CatherdError } from "../domain/errors.ts";
import { type Change, patchAt, type Profile } from "../domain/profile.ts";
import { inferredScores, type Issue } from "../domain/profile-rules.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { gitToplevel } from "../infra/git.ts";
import { loadCatalog } from "../services/catalog-service.ts";
import {
  activate,
  activeName,
  createProfile,
  deleteProfile,
  diffNamed,
  getProfile,
  keyRunnable,
  listProfiles,
  patchProfile,
  profileExists,
  readProjects,
  requireProfile,
  roleEnforcement,
  runnableBackends,
  type Synced,
  unbind,
  validateNamed,
} from "../services/profile-service.ts";
import { EXIT, mark, printJson } from "./cli-kit.ts";

const json = { json: { type: "boolean", description: "print JSON" } } as const;

export interface StandIn {
  from: string;
  to: string;
  inferred: boolean;
  via: string | null;
}

/** Spec §7.2: each stand-in, marked inferred when its scores are catherd's guess. */
export function standIns(p: Profile, c: Catalog): StandIn[] {
  return Object.entries(p.failover).map(([from, to]) => {
    try {
      return { from, to, ...inferredScores(c, rungInfo(c, to)) };
    } catch {
      return { from, to, inferred: false, via: null };
    }
  });
}

const value = (v: unknown) => (v === null ? "none" : typeof v === "string" ? v : JSON.stringify(v));
export const formatChange = (c: Change): string => `${c.path}: ${value(c.before)} → ${value(c.after)}`;
export const formatIssue = (i: Issue, glyph: string): string[] => [
  `${glyph} ${i.path}: ${i.message}`,
  ...(i.fix ? [`  fix: ${i.fix}`] : []),
];

/** `profile show`: every setting, each role with its access and how strongly its backend holds it (spec D10). */
export function formatProfile(
  p: Profile,
  o: {
    active: boolean;
    enforcement: Record<Role, "enforced" | "advisory">;
    standIns: StandIn[];
    /** the backends catherd can run: runnableBackends() */
    backends: string[];
  },
): string[] {
  const width = Math.max(...ROLES.map((r) => r.length));
  const lines = [
    `profile ${p.name}${o.active ? " (active)" : ""}`,
    `objective ${p.objective} · jev ${p.jev.use} · heavy slots ${p.lock.heavy} · notify ${p.notify.join(", ") || "none"}`,
    "roles",
  ];
  for (const role of ROLES) {
    const rc = p.roles[role];
    if (!rc.enabled) {
      lines.push(`  ${role.padEnd(width)}  off`);
      continue;
    }
    const ladder = rc.rungs.map((r) => (r === rc.defaultRung ? `${r} (default)` : r)).join(" → ");
    lines.push(
      `  ${role.padEnd(width)}  ${`${rc.access}, ${o.enforcement[role]}`.padEnd(27)}  ${ladder || "no rungs"}`,
    );
  }
  // only what catherd can run today: a backend without an adapter has nothing to bill or isolate
  const runs = ([key]: [string, unknown]) => keyRunnable(key, o.backends);
  const billing = Object.entries(p.billing).filter(runs);
  lines.push(`billing ${billing.map(([k, m]) => `${k} ${m}`).join(" · ")}`);
  const harness = Object.entries(p.harness).filter(runs);
  lines.push(`harness ${harness.map(([k, h]) => `${k} ${h.isolated ? "isolated" : "native"}`).join(" · ")}`);
  lines.push(o.standIns.length ? "failover" : "failover none");
  for (const s of o.standIns)
    lines.push(
      `  ${s.from} → ${s.to}${s.inferred ? ` (inferred${s.via ? `: treated like ${s.via}` : ""})` : ""}`,
    );
  const budget = Object.entries(p.budget).map(([k, v]) => (k === "usd" ? `$${v}` : `${v} ${k}`));
  lines.push(`budget ${budget.join(" · ") || "no cap"}`);
  lines.push(`timeouts idle ${p.timeouts.idleMin} min · wall ${p.timeouts.wallMin} min`);
  lines.push(
    `preflight ${p.preflight.confirm ? "shows its commands and asks first" : "runs the checks without asking"}`,
  );
  return lines;
}

function printSynced(r: Pick<Synced, "newSessionNeededFor">): void {
  if (r.newSessionNeededFor.length)
    console.log(`new Claude Code session needed for: ${r.newSessionNeededFor.join(", ")}`);
}

function printIssues(errors: Issue[], warnings: Issue[]): void {
  for (const e of errors) for (const l of formatIssue(e, mark("fail"))) console.log(l);
  for (const w of warnings) for (const l of formatIssue(w, mark("warn"))) console.log(l);
}

const refused = (errors: Issue[]) =>
  new CatherdError(
    "E_CONFIG_INVALID",
    `the profile was not saved: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
    { fix: errors.find((e) => e.fix)?.fix ?? "catherd profile validate lists what to change" },
  );

async function repoHere(): Promise<string> {
  const top = await gitToplevel(process.cwd());
  if (!top)
    throw new CatherdError("E_INPUT_INVALID", `${process.cwd()} is not inside a git repository`, {
      fix: "run it inside the repo to bind, or leave out --repo",
    });
  return top;
}

/** The profile this directory runs on: its repo's binding, else the active one (outside a repo too). */
const activeHere = async (): Promise<string> => activeName(await gitToplevel(process.cwd()));

const list = defineCommand({
  meta: {
    name: "list",
    description: "Every profile, the one this repo runs on (*), and the repos bound to each",
  },
  args: json,
  async run({ args }) {
    const active = await activeHere();
    const bindings = Object.entries(readProjects().bindings);
    const rows = listProfiles().map((name) => ({
      name,
      active: name === active,
      repos: bindings.filter(([, p]) => p === name).map(([r]) => r),
    }));
    if (args.json) return printJson(rows);
    for (const r of rows)
      console.log(
        `${r.active ? "*" : " "} ${r.name}${r.repos.length ? `  bound to ${r.repos.join(", ")}` : ""}`,
      );
  },
});

const show = defineCommand({
  meta: {
    name: "show",
    description: "A profile with every default filled in (without a name: the one this repo runs on)",
  },
  args: { name: { type: "positional", required: false, description: "profile name" }, ...json },
  async run({ args }) {
    const here = await activeHere();
    const name = args.name === undefined ? here : requireProfile(args.name);
    const p = getProfile(name);
    const o = {
      active: name === here,
      enforcement: roleEnforcement(p),
      standIns: standIns(p, loadCatalog({ timings: false })),
    };
    if (args.json) return printJson({ profile: p, ...o });
    for (const l of formatProfile(p, { ...o, backends: runnableBackends() })) console.log(l);
  },
});

const use = defineCommand({
  meta: {
    name: "use",
    description:
      "Make a profile active, bind it to this repo with --repo, or unbind this repo with --repo --clear",
  },
  args: {
    name: { type: "positional", required: false, description: "profile name" },
    repo: { type: "boolean", description: "bind it to the git repo you are in, instead of making it active" },
    clear: { type: "boolean", description: "with --repo and no name: unbind the git repo you are in" },
  },
  async run({ args }) {
    if (args.clear) {
      if (!args.repo || args.name !== undefined)
        throw new CatherdError("E_INPUT_INVALID", "--clear goes with --repo and no profile name", {
          fix: "catherd profile use --repo --clear, inside the repo to unbind",
        });
      const r = unbind(await repoHere());
      console.log(`${mark("ok")} ${r.repo} is unbound`);
      printSynced(r);
      return;
    }
    if (args.name === undefined)
      throw new CatherdError("E_INPUT_INVALID", "which profile? name one", {
        fix: "catherd profile use <name> [--repo], or catherd profile use --repo --clear",
      });
    const r = activate(args.name, args.repo ? await repoHere() : null);
    console.log(`${mark("ok")} ${r.active} ${r.repo ? `is bound to ${r.repo}` : "is active"}`);
    printSynced(r);
  },
});

const create = defineCommand({
  meta: { name: "new", description: "A new profile from the default one, or from --from <profile>" },
  args: {
    name: { type: "positional", required: true, description: "new profile name" },
    from: { type: "string", description: "copy this profile instead of the default one" },
  },
  run({ args }) {
    const r = createProfile(args.name, args.from);
    if (!r.saved) throw refused(r.errors);
    console.log(`${mark("ok")} created ${args.name}${args.from ? ` from ${args.from}` : ""}`);
    printIssues([], r.warnings);
  },
});

const copy = defineCommand({
  meta: { name: "copy", description: "Copy a profile under a new name" },
  args: {
    from: { type: "positional", required: true, description: "profile to copy" },
    to: { type: "positional", required: true, description: "new profile name" },
  },
  run({ args }) {
    const r = createProfile(args.to, args.from);
    if (!r.saved) throw refused(r.errors);
    console.log(`${mark("ok")} copied ${args.from} to ${args.to}`);
    printIssues([], r.warnings);
  },
});

const rm = defineCommand({
  meta: { name: "rm", description: "Delete a profile and its agent files (never the active or a bound one)" },
  args: { name: { type: "positional", required: true, description: "profile name" } },
  run({ args }) {
    deleteProfile(args.name);
    console.log(`${mark("ok")} deleted ${args.name}`);
  },
});

const set = defineCommand({
  meta: {
    name: "set",
    description:
      "Set one field: e.g. roles.worker.access read-only, budget.usd 20, failover.<rung> <rung>, roles.worker.rungs a,b; null removes",
  },
  args: {
    path: { type: "positional", required: true, description: "dotted path, e.g. roles.verifier.access" },
    value: { type: "positional", required: true, description: "JSON, or a plain word; null removes the key" },
    profile: { type: "string", description: "the profile to change (default: the one this repo runs on)" },
  },
  async run({ args }) {
    // the CLI never creates a profile by setting a field of it: a typo would start a new one
    if (args.profile !== undefined && !profileExists(assertProfileName(args.profile)))
      throw new CatherdError("E_INPUT_INVALID", `no profile named "${args.profile}"`, {
        fix: `catherd profile new ${args.profile}`,
      });
    const r = patchProfile(args.profile ?? (await activeHere()), patchAt(args.path, args.value));
    if (!r.saved) throw refused(r.errors);
    if (r.diff.length === 0) console.log("no change");
    for (const c of r.diff) console.log(`${mark("ok")} ${formatChange(c)}`);
    printIssues([], r.warnings);
    printSynced(r);
  },
});

const diff = defineCommand({
  meta: {
    name: "diff",
    description: "What differs between two profiles (the second defaults to the one this repo runs on)",
  },
  args: {
    a: { type: "positional", required: true, description: "profile" },
    b: { type: "positional", required: false, description: "profile (default: the one this repo runs on)" },
    ...json,
  },
  async run({ args }) {
    const changes = diffNamed(
      args.b === undefined ? await activeHere() : requireProfile(args.b),
      requireProfile(args.a),
    );
    if (args.json) return printJson(changes);
    if (changes.length === 0) console.log("no differences");
    for (const c of changes) console.log(formatChange(c));
  },
});

const validate = defineCommand({
  meta: { name: "validate", description: "Errors that block a save, and warnings that do not" },
  args: {
    name: {
      type: "positional",
      required: false,
      description: "profile name (default: the one this repo runs on)",
    },
    ...json,
  },
  async run({ args }) {
    const v = validateNamed(args.name === undefined ? await activeHere() : requireProfile(args.name));
    if (args.json) printJson({ valid: v.errors.length === 0, ...v });
    else if (v.errors.length === 0 && v.warnings.length === 0) console.log(`${mark("ok")} valid`);
    else printIssues(v.errors, v.warnings);
    if (v.errors.length) process.exitCode = EXIT.error;
  },
});

/** Spec §8: `catherd profile list|show|use [--repo [--clear]]|new|copy|rm|set <path> <value>|diff|validate`. */
export const profileCommand = defineCommand({
  meta: { name: "profile", description: "Profiles: which models each role runs, and how" },
  subCommands: { list, show, use, new: create, copy, rm, set, diff, validate },
});
