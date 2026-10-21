import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { checkFailLines, newFails } from "../domain/fail-lines.ts";
import { heavySlots, LOCK_HELD_ENV, withHeavySlot, withRoleLock } from "../infra/heavy-lock.ts";
import { repoDir } from "../infra/paths.ts";
import { appendJsonl, ensureJsonlHeader, ensurePrivateDir, readJsonl } from "../infra/store.ts";
import { checkEnvFor } from "./preflight.ts";
import { activeName, readProfileDoc } from "./profile-store.ts";
import type { Run } from "./run-store.ts";

/** One run of a milestone's full check on one commit (spec 2.0 decision 18), or of the base's own (a baseline). */
export const CheckRecordSchema = z.looseObject({
  at: z.string(),
  run: z.string(),
  milestone: z.string(),
  command: z.string(),
  /** the full sha the check ran on */
  head: z.string(),
  exit: z.number(),
  durationMs: z.number(),
  fails: z.array(z.string()),
  log: z.string(),
  baseline: z.literal(true).optional(),
  /** the first run's exit, when a failure with new lines was rerun once */
  rerunOf: z.number().optional(),
  /** "clean" | "found" | "skipped: <why>"; non-baseline records only */
  secrets: z.string().optional(),
});
export type CheckRecord = z.infer<typeof CheckRecordSchema>;

/** `<data>/repos/<repo key>/checks.jsonl`, beside gates.jsonl. */
export const checksFile = (toplevel: string): string => join(repoDir(toplevel), "checks.jsonl");
export const checkLogDir = (toplevel: string): string => join(repoDir(toplevel), "checks");

export function readChecks(toplevel: string): CheckRecord[] {
  return readJsonl<unknown>(checksFile(toplevel)).rows.flatMap((row) => {
    const r = CheckRecordSchema.safeParse(row);
    return r.success ? [r.data] : [];
  });
}

export function appendCheckRecord(toplevel: string, rec: CheckRecord): void {
  const file = checksFile(toplevel);
  ensureJsonlHeader(file, "checks");
  appendJsonl(file, rec);
}

/**
 * The commit the baseline and the secret scan start from: the one place the base is chosen. Until plan 35 it is
 * where the run started (a run scans from there); null without one.
 */
export async function checkBase(run: Run): Promise<string | null> {
  return run.meta.startHead ?? null;
}

/** The baseline record of `command`: the one on `base`, else the newest. */
export function baselineFor(toplevel: string, command: string, base: string | null): CheckRecord | null {
  const all = readChecks(toplevel).filter((r) => r.baseline && r.command === command);
  return (base ? all.filter((r) => r.head === base).at(-1) : undefined) ?? all.at(-1) ?? null;
}

/** The scanner a test replaces. */
export const checkTools = { gitleaks: (): string | null => Bun.which("gitleaks") };

/** `gitleaks` over `base..HEAD` in `cwd`: "found" blocks, a missing or failing scanner is an audit note. */
export async function secretScan(cwd: string, base: string | null): Promise<string> {
  if (!base) return "skipped: no base commit to scan from";
  const bin = checkTools.gitleaks();
  if (!bin) return "skipped: gitleaks is not installed";
  const p = Bun.spawn(
    [bin, "git", "--no-banner", "--redact", "--exit-code", "1", `--log-opts=${base}..HEAD`],
    { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  const code = await p.exited;
  return code === 0 ? "clean" : code === 1 ? "found" : `skipped: gitleaks exited ${code}`;
}

export interface CheckJob {
  run: string;
  repo: string;
  cwd: string;
  milestone: string;
  command: string;
  head: string;
  base: string | null;
  baseline: boolean;
}

/** One logged run of the command: its merged output goes to the log, its exit code is kept. */
async function runLogged(job: CheckJob, log: string, tmp: string | null): Promise<number> {
  const env = await checkEnvFor(job.repo);
  const p = Bun.spawn(["sh", "-c", 'exec > "$1" 2>&1; eval "$2"', "sh", log, job.command], {
    cwd: job.cwd,
    env: tmp ? { ...env, TMPDIR: tmp, GOTMPDIR: tmp } : env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  return (await p.exited) ?? 1;
}

/**
 * Runs a milestone's check under the verifier lock and a heavy slot, records its exit code and failing lines
 * against `head`, reruns a failure with lines the base lacks once, and scans the run's commits for secrets.
 */
export async function execMilestoneCheck(job: CheckJob): Promise<CheckRecord> {
  const dir = checkLogDir(job.repo);
  ensurePrivateDir(dir);
  const one = async () => {
    const log = join(
      dir,
      `${job.milestone}-${job.head.slice(0, 12)}${job.baseline ? "-base" : ""}-${Date.now()}.log`,
    );
    const start = Date.now();
    let exit: number;
    if (process.env[LOCK_HELD_ENV] === "1") exit = await runLogged(job, log, null);
    else {
      let setting: number | "cpus/2" = "cpus/2";
      try {
        setting = readProfileDoc(activeName(job.repo)).lock?.heavy ?? "cpus/2";
      } catch {
        // a profile that cannot be read leaves the default
      }
      exit = await withRoleLock("verifier", `run:${job.run}`, () =>
        withHeavySlot(heavySlots(setting), (_slot, tmp) => runLogged(job, log, tmp), {
          tmpBase: process.env.TMPDIR,
        }),
      );
    }
    const out = readFileSync(log, "utf8");
    return { exit, durationMs: Date.now() - start, fails: checkFailLines(out), log };
  };
  let r = await one();
  let rerunOf: number | undefined;
  if (r.exit !== 0 && !job.baseline) {
    // a failure with lines the base lacks gets one rerun: load flakes are common on a shared host
    const base = baselineFor(job.repo, job.command, job.base);
    if (!base || newFails(r.fails, base.fails).length > 0) {
      rerunOf = r.exit;
      r = await one();
    }
  }
  const rec: CheckRecord = {
    at: new Date().toISOString(),
    run: job.run,
    milestone: job.milestone,
    command: job.command,
    head: job.head,
    ...r,
    ...(job.baseline ? { baseline: true as const } : { secrets: await secretScan(job.cwd, job.base) }),
    ...(rerunOf !== undefined ? { rerunOf } : {}),
  };
  appendCheckRecord(job.repo, rec);
  return rec;
}

/**
 * The machine half of the land gate for milestone `m` on `head`: every command the run checked on it exits 0, or
 * fails only in lines the base fails in too. `audit` lists what passed only because of the base or a rerun.
 */
export async function machineGate(
  run: Run,
  m: string,
  head: string,
): Promise<{ missing: string[]; audit: string[] }> {
  const missing: string[] = [];
  const audit: string[] = [];
  const latest = new Map<string, CheckRecord>();
  for (const r of readChecks(run.meta.repo))
    if (r.run === run.id && r.milestone === m && r.head === head && !r.baseline) latest.set(r.command, r);
  if (latest.size === 0) {
    missing.push(
      `no machine check of ${m} on ${head.slice(0, 12)}: the verifier runs its full check with gate_run(run, "${m}", <command>) on the committed HEAD`,
    );
    return { missing, audit };
  }
  const start = await checkBase(run);
  for (const rec of latest.values()) {
    if (rec.secrets === "found")
      missing.push(
        `gitleaks found secrets in ${(start ?? "").slice(0, 12)}..${head.slice(0, 12)}; see ${rec.log}`,
      );
    if (rec.secrets?.startsWith("skipped")) audit.push(`secret scan ${rec.secrets}`);
    if (rec.rerunOf !== undefined)
      audit.push(`\`${rec.command}\` exited ${rec.rerunOf} once and was rerun (exit ${rec.exit})`);
    if (rec.exit === 0) continue;
    const base = baselineFor(run.meta.repo, rec.command, start);
    const fresh = newFails(rec.fails, base?.fails ?? null);
    if (!base || base.exit === 0)
      missing.push(
        `\`${rec.command}\` exits ${rec.exit} on ${head.slice(0, 12)}${fresh.length ? `: ${fresh.slice(0, 5).join(" | ")}` : ""}`,
      );
    else if (fresh.length)
      missing.push(`failing lines the base does not have: ${fresh.slice(0, 8).join(" | ")}`);
    // a failure catherd cannot read is never matched against the base: it could be anything
    else if (rec.fails.length === 0)
      missing.push(
        `\`${rec.command}\` exits ${rec.exit} with no failing line catherd can compare; see ${rec.log}`,
      );
    else
      audit.push(
        `\`${rec.command}\` exits ${rec.exit} here and ${base.exit} on the base ${base.head.slice(0, 12)}; every failing line is pre-existing (${rec.fails.length})`,
      );
  }
  return { missing, audit };
}
