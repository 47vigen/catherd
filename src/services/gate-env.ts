import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CatherdError } from "../domain/errors.ts";
import { withFileLock } from "../infra/filelock.ts";
import { gitToplevel } from "../infra/git.ts";
import { repoDir } from "../infra/paths.ts";
import { ensurePrivateDir, readVersioned, writeJsonAtomic } from "../infra/store.ts";

// Plan 23: the gate environment a repo's verifier and preflight need (DOCKER_HOST, HTTPS_PROXY, a
// TESTCONTAINERS_* setting), kept beside the repo's knowledge.md, so no verifier sets it up by hand. A value is
// stored as is; a secret is stored by reference only: the name of the env var that holds it, read when a
// role or a check starts, never written to disk.

const GATE_ENV_SCHEMA = 1;

const EntrySchema = z.union([z.strictObject({ value: z.string() }), z.strictObject({ from: z.string() })]);
export type GateEnvEntry = z.infer<typeof EntrySchema>;

const GateEnvSchema = z.looseObject({
  schema: z.literal(GATE_ENV_SCHEMA),
  vars: z.record(z.string(), EntrySchema),
});
type GateEnvFile = z.infer<typeof GateEnvSchema>;

/** `<data>/repos/<repo key>/gate-env.json`, beside knowledge.md and gates.jsonl. */
export const gateEnvFile = (toplevel: string): string => join(repoDir(toplevel), "gate-env.json");

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A name a secret goes by: such a variable is set by reference (--from), never by value. */
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

/** The repo's gate environment, by name; empty when none is set. */
export function readGateEnv(toplevel: string): Record<string, GateEnvEntry> {
  const file = gateEnvFile(toplevel);
  if (!existsSync(file)) return {};
  return readVersioned<GateEnvFile>(file, GateEnvSchema, GATE_ENV_SCHEMA).vars;
}

async function top(repo: string): Promise<string> {
  const t = await gitToplevel(repo);
  if (!t)
    throw new CatherdError("E_IO_PATH", `${repo} is not inside a git repository`, {
      fix: "pass the path of the repository",
    });
  return t;
}

function assertName(name: string): void {
  if (!NAME.test(name))
    throw new CatherdError("E_INPUT_INVALID", `"${name}" is not an env var name`, {
      fix: "use letters, digits and _, not starting with a digit, e.g. DOCKER_HOST",
    });
}

async function update(
  repo: string,
  change: (vars: Record<string, GateEnvEntry>) => void,
): Promise<{ repo: string; vars: Record<string, GateEnvEntry> }> {
  const t = await top(repo);
  const file = gateEnvFile(t);
  ensurePrivateDir(repoDir(t));
  return withFileLock(file, () => {
    const vars = { ...readGateEnv(t) };
    change(vars);
    writeJsonAtomic(file, { schema: GATE_ENV_SCHEMA, vars } satisfies GateEnvFile);
    return { repo: t, vars };
  });
}

/**
 * Sets one variable of the repo's gate environment: a value, or `from`, the name of the env var that holds a
 * secret. A secret-looking name (…KEY, …TOKEN, …PASSWORD) takes `from` only, so no secret lands on disk.
 */
export async function setGateEnv(
  repo: string,
  name: string,
  entry: GateEnvEntry,
): Promise<{ repo: string; vars: Record<string, GateEnvEntry> }> {
  assertName(name);
  if ("from" in entry) assertName(entry.from);
  else if (SECRET_NAME.test(name))
    throw new CatherdError(
      "E_INPUT_INVALID",
      `${name} looks like a secret: catherd stores it by reference only`,
      {
        fix: `export it in your shell, then: catherd knowledge env set ${name} --from <the env var that holds it>`,
      },
    );
  return update(repo, (vars) => {
    vars[name] = entry;
  });
}

/** Removes one variable; refused when it is not set. */
export function removeGateEnv(
  repo: string,
  name: string,
): Promise<{ repo: string; vars: Record<string, GateEnvEntry> }> {
  return update(repo, (vars) => {
    if (!(name in vars))
      throw new CatherdError("E_INPUT_INVALID", `${name} is not in the gate environment`, {
        fix: "catherd knowledge env list shows what is set",
      });
    delete vars[name];
  });
}

/** The variables as briefs show them: `NAME=value`, a reference as `NAME=$FROM`. */
export const gateEnvLines = (vars: Record<string, GateEnvEntry>): string[] =>
  Object.entries(vars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, e]) => ("from" in e ? `${k}=$${e.from}` : `${k}=${e.value}`));

/** The literal values, for a spec written to disk; references stay names (`refs`), resolved at spawn. */
export function gateEnvParts(vars: Record<string, GateEnvEntry>): {
  values: Record<string, string>;
  refs: Record<string, string>;
} {
  const values: Record<string, string> = {};
  const refs: Record<string, string> = {};
  for (const [k, e] of Object.entries(vars)) {
    if ("from" in e) refs[k] = e.from;
    else values[k] = e.value;
  }
  return { values, refs };
}

/**
 * The env the gate environment adds to `base`: its values, and each reference read from `base`, else from
 * `fallback` (the login env); a reference neither holds is left out, and named in `missing`.
 */
export function resolveGateEnv(
  vars: Record<string, GateEnvEntry>,
  base: Record<string, string | undefined>,
  fallback: () => Record<string, string | undefined> = () => ({}),
): { env: Record<string, string>; missing: string[] } {
  const { values, refs } = gateEnvParts(vars);
  return resolveRefs(values, refs, base, fallback);
}

/** `values` plus each of `refs` (name → the env var holding it) read from `base`, else `fallback`. */
export function resolveRefs(
  values: Record<string, string>,
  refs: Record<string, string>,
  base: Record<string, string | undefined>,
  fallback: () => Record<string, string | undefined> = () => ({}),
): { env: Record<string, string>; missing: string[] } {
  const env = { ...values };
  const missing: string[] = [];
  let login: Record<string, string | undefined> | null = null;
  for (const [k, from] of Object.entries(refs)) {
    const v = base[from] ?? (login ??= fallback())[from];
    if (v === undefined) missing.push(k);
    else env[k] = v;
  }
  return { env, missing };
}
