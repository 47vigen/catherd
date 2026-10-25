import { appendFileSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CatherdError } from "../domain/errors.ts";
import {
  checkFailLines,
  checkItems,
  coveredDir,
  FAIL_DISPLAY_CAP,
  failFiles,
  newFails,
} from "../domain/fail-lines.ts";
import { parseLaneHeader } from "../domain/lane.ts";
import type { RunEvent } from "../domain/run-events.ts";
import { replay } from "../domain/run-state.ts";
import { baselineItems, isAccept, milestoneCheck } from "../domain/plan-doc.ts";
import { git } from "../infra/git.ts";
import {
  heavySlots,
  LOCK_HELD_ENV,
  type LockWait,
  withHeavySlot,
  withRoleLock,
} from "../infra/heavy-lock.ts";
import { launchCheckWorker } from "../infra/launch.ts";
import { repoDir } from "../infra/paths.ts";
import { isAlive, killGroup, processStartTime } from "../infra/proc.ts";
import {
  appendJsonl,
  ensureJsonlHeader,
  ensurePrivateDir,
  readJsonl,
  writeJsonAtomic,
} from "../infra/store.ts";
import { gateItemInputs } from "./gate-service.ts";
import { checkEnvFor } from "./preflight.ts";
import { activeName, readProfileDoc } from "./profile-store.ts";
import { readEvents } from "./run-events-store.ts";
import { findRun, readRecords, type Run, runPaths } from "./run-store.ts";
import { composeProjectOf, treeOf } from "./tree-path.ts";

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
  /** each fail line's repo files (plan 43 D2); older records have none */
  failFiles: z.record(z.string(), z.array(z.string())).optional(),
  log: z.string(),
  baseline: z.literal(true).optional(),
  /** the first run's exit, when a failure with new lines was rerun once */
  rerunOf: z.number().optional(),
  /** "clean" | "found" | "skipped: <why>"; non-baseline records only */
  secrets: z.string().optional(),
  /** when the command started, after its locks: durationMs runs from here, and waitedMs is the wait before */
  startedAt: z.string().optional(),
  waitedMs: z.number().optional(),
  /** the record whose result this one carries (plan 40 D3) */
  carriedFrom: z.string().optional(),
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
 * The commit the baseline and the secret scan start from: the one place the base is chosen. A run in the repo scans
 * from where it started; a base run's milestone from where its branch left origin's base (plan 35), null when git
 * cannot say.
 */
export async function checkBase(run: Run, m?: string): Promise<string | null> {
  if (!run.meta.base || m === undefined) return run.meta.startHead ?? null;
  const r = await git(treeOf(run, m), ["merge-base", `origin/${run.meta.base}`, "HEAD"]);
  return r.kind === "ok" ? r.out.trim() || null : null;
}

/** The baseline record of `command` on `base`; another commit's is none. Without a base, the newest. */
export function baselineFor(toplevel: string, command: string, base: string | null): CheckRecord | null {
  const all = readChecks(toplevel).filter((r) => r.baseline && r.command === command);
  return (base ? all.filter((r) => r.head === base) : all).at(-1) ?? null;
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
  /** the tree's compose project (plan 43 D16); the gate env's own COMPOSE_PROJECT_NAME wins */
  compose?: string | null;
}

const invalid = (message: string, fix: string) => new CatherdError("E_INPUT_INVALID", message, { fix });

/** The exit code of an item that ran past `checkLimits.itemMs`, as timeout(1) reports one. */
const TIMED_OUT = 124;

/**
 * One logged run of the command: its merged output goes to the log, its exit code is kept. The command runs with
 * CATHERD_LOCK_HELD set, so a `catherd lock` inside it runs at once. Past the item budget its group is killed,
 * and the log gets a FAIL line, which checkFailLines keeps.
 */
async function runLogged(job: CheckJob, log: string, tmp: string | null): Promise<number> {
  const env = await checkEnvFor(job.repo);
  if (job.compose) env.COMPOSE_PROJECT_NAME ??= job.compose;
  const p = Bun.spawn(["sh", "-c", 'exec > "$1" 2>&1; eval "$2"', "sh", log, job.command], {
    cwd: job.cwd,
    env: { ...(tmp ? { ...env, TMPDIR: tmp, GOTMPDIR: tmp } : env), [LOCK_HELD_ENV]: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(p.pid, "SIGKILL");
  }, checkLimits.itemMs);
  const code = (await p.exited) ?? 1;
  clearTimeout(timer);
  if (!timedOut) return code;
  appendFileSync(log, `FAIL catherd: timed out after ${Math.round(checkLimits.itemMs / 60_000)} min\n`);
  return TIMED_OUT;
}

/**
 * A record names the commit it ran on: the checkout must still be at `job.head`, with no tracked edits (a
 * baseline's worktree is the base's own), or what ran is not what the record would claim.
 */
async function assertCheckout(job: CheckJob, when: string): Promise<void> {
  const moved = (why: string) =>
    invalid(
      `the checkout moved ${when} the check (${why}); nothing is recorded for ${job.head.slice(0, 12)}`,
      "commit the milestone, then call gate_run again",
    );
  const head = await git(job.cwd, ["rev-parse", "HEAD"]);
  if (head.kind !== "ok") throw moved("HEAD is unreadable");
  if (head.out.trim() !== job.head) throw moved(`HEAD is ${head.out.trim().slice(0, 12)}`);
  if (job.baseline) return;
  const dirty = await git(job.cwd, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.kind !== "ok" || dirty.out.trim()) throw moved("tracked files changed");
}

/**
 * Runs a milestone's check under the verifier lock and a heavy slot, records its exit code and failing lines
 * against `head`, reruns a failure with lines the base lacks once, and scans the run's commits for secrets.
 * `onWait` hears each lock wait, and null once the command runs (the detached worker keeps it in its flight).
 */
export async function execMilestoneCheck(
  job: CheckJob,
  o: { onWait?: (w: LockWait | null) => void } = {},
): Promise<CheckRecord> {
  const dir = checkLogDir(job.repo);
  ensurePrivateDir(dir);
  const one = async () => {
    const log = join(
      dir,
      `${job.milestone}-${job.head.slice(0, 12)}${job.baseline ? "-base" : ""}-${Date.now()}.log`,
    );
    const requested = Date.now();
    let started = requested;
    // the locks may have been waited for while the checkout moved on, and the command may move it
    const guarded = async (tmp: string | null): Promise<number> => {
      started = Date.now();
      o.onWait?.(null);
      await assertCheckout(job, "before");
      const code = await runLogged(job, log, tmp);
      await assertCheckout(job, "during");
      return code;
    };
    let exit: number;
    if (process.env[LOCK_HELD_ENV] === "1") exit = await guarded(null);
    else {
      let setting: number | "cpus/2" = "cpus/2";
      try {
        setting = readProfileDoc(activeName(job.repo)).lock?.heavy ?? "cpus/2";
      } catch {
        // a profile that cannot be read leaves the default
      }
      const onWait = (w: LockWait) => o.onWait?.(w);
      // no tmpBase: a slot dir under the verifier's scratch would make the check a role (checkEnv)
      exit = await withRoleLock(
        "verifier",
        `run:${job.run}`,
        () => withHeavySlot(heavySlots(setting), (_slot, tmp) => guarded(tmp), { onWait }),
        { onWait },
      );
    }
    const out = readFileSync(log, "utf8");
    const fails = checkFailLines(out);
    return {
      exit,
      durationMs: Date.now() - started,
      startedAt: new Date(started).toISOString(),
      waitedMs: started - requested,
      fails,
      ...(fails.length ? { failFiles: failFiles(out, job.cwd) } : {}),
      log,
    };
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

/** Pair an owner's explicit accept with the land question they actually answered. */
function acceptedLandQuestions(
  run: Run,
  milestone: string,
): Extract<RunEvent, { type: "question.parked" }>[] {
  const accepted: Extract<RunEvent, { type: "question.parked" }>[] = [];
  let parked: Extract<RunEvent, { type: "question.parked" }> | null = null;
  for (const event of readEvents(run)) {
    if (event.type === "question.parked" && event.unit === milestone) parked = event;
    else if (event.type === "question.answered" && event.unit === milestone) {
      if (parked?.reason === "land" && event.by === "owner" && isAccept(event.answer)) accepted.push(parked);
      parked = null;
    }
  }
  return accepted;
}

const gateInputTag = (identity: string): string => `gate inputs ${identity}`;

const checkRecordId = (rec: CheckRecord): string =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(rec)).digest("hex");

const baselineFailure = (rec: CheckRecord, base: CheckRecord): string =>
  `\`${rec.command}\` exits ${rec.exit} here and ${base.exit} on the base ${base.head.slice(0, 12)}; pre-existing failing lines (${rec.fails.length}): ${rec.fails.slice(0, FAIL_DISPLAY_CAP).join(" | ")}; check record ${checkRecordId(rec)}`;

/** The refusal identifies the exact full record, even when a rerun finishes before the question is parked. */
function baselineWaived(
  rec: CheckRecord,
  base: CheckRecord,
  records: CheckRecord[],
  accepted: Extract<RunEvent, { type: "question.parked" }>[],
): boolean {
  if (base.exit === 0 || rec.fails.length === 0 || newFails(rec.fails, base.fails).length > 0) return false;
  return records.some(
    (previous) =>
      previous.command === rec.command &&
      previous.head === rec.head &&
      previous.exit === rec.exit &&
      previous.fails.length > 0 &&
      newFails(rec.fails, previous.fails).length === 0 &&
      accepted.some((q) => q.question.includes(baselineFailure(previous, base))),
  );
}

/** An item's parts all passed or were explicitly waived on this head, including at least one waived failure. */
export async function acceptedBaselineItem(
  run: Run,
  milestone: string,
  head: string,
  command: string | null,
  item: string,
): Promise<boolean> {
  if (command === null) return false;
  const records = readChecks(run.meta.repo).filter(
    (r) => r.run === run.id && r.milestone === milestone && r.head === head && !r.baseline,
  );
  const inputs = (await gateItemInputs(run, milestone, head)).find(
    (s) => s.item === item && s.command === command,
  );
  const identity = inputs?.identity;
  if (!identity) return false;
  const accepted = acceptedLandQuestions(run, milestone).filter((q) =>
    q.question.includes(gateInputTag(identity)),
  );
  if (accepted.length === 0) return false;
  const start = await checkBase(run, milestone);
  let waived = false;
  for (const item of checkItems(command)) {
    const rec = records.findLast((r) => r.command === item);
    if (!rec || rec.secrets === "found") return false;
    if (rec.exit === 0) continue;
    const base = baselineFor(run.meta.repo, item, start);
    if (!base || !baselineWaived(rec, base, records, accepted)) return false;
    waived = true;
  }
  if (!waived) return false;
  const cwd = treeOf(run, milestone);
  const [current, dirty] = await Promise.all([
    git(cwd, ["rev-parse", "HEAD"]),
    git(cwd, ["status", "--porcelain", "--untracked-files=no"]),
  ]);
  return current.kind === "ok" && current.out.trim() === head && dirty.kind === "ok" && !dirty.out.trim();
}

/**
 * The machine half of the land gate: every required check item has a successful record on `head`.
 * Red baselines block unless the owner accepted those failures; `audit` lists waivers, skipped scans and reruns.
 */
export async function machineGate(
  run: Run,
  m: string,
  head: string,
): Promise<{ missing: string[]; audit: string[] }> {
  const missing: string[] = [];
  const audit: string[] = [];
  const records = readChecks(run.meta.repo).filter(
    (r) => r.run === run.id && r.milestone === m && !r.baseline,
  );
  const latest = new Map<string, CheckRecord>();
  for (const r of records) if (r.head === head) latest.set(r.command, r);
  const planFile = join(run.dir, "plan.md");
  const plan = existsSync(planFile) ? readFileSync(planFile, "utf8") : null;
  const command = plan === null ? null : milestoneCheck(plan, m);
  // plan 40 D13: a Baseline line of the plan accepts its item's pre-existing failing lines
  const baselines = plan === null ? [] : baselineItems(plan, m);
  const required = new Set(
    command === null ? records.flatMap((r) => checkItems(r.command)) : checkItems(command),
  );
  if (required.size === 0) {
    missing.push(
      `no machine check of ${m} on ${head.slice(0, 12)}: the verifier runs its full check with gate_run(run, "${m}", <command>) on the committed HEAD`,
    );
    return { missing, audit };
  }
  for (const item of required)
    if (!latest.has(item))
      missing.push(`no machine check of \`${item}\` for ${m} on ${head.slice(0, 12)}: run it with gate_run`);
  const start = await checkBase(run, m);
  const accepted = acceptedLandQuestions(run, m);
  let inputs: Awaited<ReturnType<typeof gateItemInputs>> | undefined;
  let waivedOn: string | null | undefined;
  const checkedItems = new Set([
    ...required,
    ...[...latest.keys()].filter((item) => checkItems(item).length === 1),
  ]);
  for (const item of checkedItems) {
    const rec = latest.get(item);
    if (!rec) continue;
    if (rec.secrets === "found")
      missing.push(
        `gitleaks found secrets in ${(start ?? "").slice(0, 12)}..${head.slice(0, 12)}; see ${rec.log}`,
      );
    if (rec.secrets?.startsWith("skipped")) audit.push(`secret scan ${rec.secrets}`);
    if (rec.rerunOf !== undefined)
      audit.push(`\`${rec.command}\` exited ${rec.rerunOf} once and was rerun (exit ${rec.exit})`);
    if (rec.exit === 0) continue;
    waivedOn ??= replay(readEvents(run), run.id).milestones.find((x) => x.id === m)?.checkWaivedOn ?? null;
    if (waivedOn === head) {
      audit.push(
        `the failing lines of \`${rec.command}\` on ${head.slice(0, 12)} were accepted as known issues`,
      );
      continue;
    }
    const base = baselineFor(run.meta.repo, rec.command, start);
    const fresh = newFails(rec.fails, base?.fails ?? null);
    if (!base || base.exit === 0)
      missing.push(
        `\`${rec.command}\` exits ${rec.exit} on ${head.slice(0, 12)}${fresh.length ? `: ${fresh.slice(0, FAIL_DISPLAY_CAP).join(" | ")}` : ""}`,
      );
    else if (fresh.length)
      missing.push(
        `\`${rec.command}\` has failing lines the base does not have: ${fresh.slice(0, FAIL_DISPLAY_CAP).join(" | ")}`,
      );
    // a failure catherd cannot read is never matched against the base: it could be anything
    else if (rec.fails.length === 0)
      missing.push(
        `\`${rec.command}\` exits ${rec.exit} with no failing line catherd can compare; see ${rec.log}`,
      );
    else if (baselines.includes(rec.command))
      audit.push(
        `the plan's Baseline line accepts the pre-existing failing lines of \`${rec.command}\` on ${head.slice(0, 12)}`,
      );
    else {
      inputs ??= await gateItemInputs(run, m, head);
      const relevant = inputs.filter(
        (s) => s.command !== null && checkItems(s.command).includes(rec.command),
      );
      const scoped = accepted.filter((q) =>
        relevant.every((s) => s.identity !== null && q.question.includes(gateInputTag(s.identity))),
      );
      const waived = baselineWaived(rec, base, records, scoped);
      if (waived)
        audit.push(`owner accepted the pre-existing failures of \`${rec.command}\` on ${head.slice(0, 12)}`);
      else {
        const tags = relevant.flatMap((s) =>
          s.identity === null ? [] : [`${gateInputTag(s.identity)} (${s.item})`],
        );
        missing.push([baselineFailure(rec, base), ...tags].join("; "));
      }
    }
  }
  return { missing, audit };
}

/** The latest machine record of each item on `head`, for this run's milestone `m`. */
function latestOnHead(run: Run, m: string, head: string): CheckRecord[] {
  const latest = new Map<string, CheckRecord>();
  for (const r of readChecks(run.meta.repo))
    if (r.run === run.id && r.milestone === m && !r.baseline && r.head === head) latest.set(r.command, r);
  return [...latest.values()];
}

/** Each failing item on `head` with the lines its base record lacks; with no base record, all of its lines. */
export async function freshFailures(
  run: Run,
  m: string,
  head: string,
): Promise<{ item: string; lines: string[]; files: Record<string, string[]> }[]> {
  const start = await checkBase(run, m);
  return latestOnHead(run, m, head)
    .filter((r) => r.exit !== 0)
    .map((r) => ({
      item: r.command,
      lines: newFails(r.fails, baselineFor(run.meta.repo, r.command, start)?.fails ?? null),
      files: r.failFiles ?? {},
    }));
}

/** The failing items on `head` that have no base record, so nothing says whether they were red before. */
export async function missingBaselines(run: Run, m: string, head: string): Promise<string[]> {
  const start = await checkBase(run, m);
  return latestOnHead(run, m, head)
    .filter((r) => r.exit !== 0 && baselineFor(run.meta.repo, r.command, start) === null)
    .map((r) => r.command);
}

/** The paths a milestone is about: its lanes' Owns, and the files its lanes' records changed outside them. */
function milestonePaths(run: Run, m: string): string[] {
  const dir = runPaths(run.dir).lanes;
  const owns = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.startsWith(`${m}.`) && f.endsWith(".md"))
    .flatMap((f) => parseLaneHeader(readFileSync(join(dir, f), "utf8")).owns);
  const { records } = readRecords(run);
  // Owns keeps a directory's slash; verdictCarries compares a path as a prefix, so the slash goes
  return [
    ...owns,
    ...records
      .filter((r) => r.lane?.startsWith(`${m}.`))
      .flatMap((r) => [...r.changedOwned, ...r.violations]),
  ].map((p) => p.replace(/\/+$/, ""));
}

/** Plan 40 D3(b): a verifier's PASS on `from` answers `to` when no file of the milestone's paths changed between them. */
export async function verdictCarries(run: Run, m: string, from: string, to: string): Promise<boolean> {
  const diff = await git(treeOf(run, m), ["diff", "--name-only", "--no-renames", from, to]);
  if (diff.kind !== "ok") return false;
  const paths = milestonePaths(run, m);
  return diff.out.split("\n").every((f) => !f || !paths.some((p) => f === p || f.startsWith(`${p}/`)));
}

/**
 * What a caller waits for, and how often it looks; a worker that has not written its pid yet gets `graceMs`.
 * An item runs at most `itemMs` (plan 40 D12), then its group is killed.
 */
export const checkLimits = { waitMs: 600_000, pollMs: 1_000, graceMs: 30_000, itemMs: 1_800_000 };

export type GateRunResult =
  | { running: true; log: string | null; hint: string }
  | {
      running: false;
      cached: boolean;
      record: CheckRecord;
      missing: string[];
      audit: string[];
      hints?: string[];
    };

interface Flight {
  schema: 1;
  pid: number;
  startTime: string | null;
  at: string;
  job: CheckJob;
  /** the lock the worker waits on, while it waits; null once it runs */
  waiting?: LockWait | null;
}

const flightOf = (job: CheckJob): string =>
  join(
    checkLogDir(job.repo),
    `inflight-${new Bun.CryptoHasher("sha1")
      .update(JSON.stringify([job.run, job.milestone, job.command, job.head, job.baseline]))
      .digest("hex")}.json`,
  );

function readFlight(file: string): Flight | null {
  try {
    const f = JSON.parse(readFileSync(file, "utf8")) as Flight;
    return typeof f?.pid === "number" && typeof f.at === "string" ? f : null;
  } catch {
    return null;
  }
}

/** The worker's lock wait, kept in its flight file for the caller that waits on it. */
function markWaiting(file: string, waiting: LockWait | null): void {
  const f = readFlight(file);
  // the launcher writes the pid once: a flight without it, or removed, is not the worker's to rewrite
  if (f && f.pid > 0) writeJsonAtomic(file, { ...f, waiting });
}

/** A flight is live while its worker is, or while a worker that has not written its pid yet is within its grace. */
const flightLive = (f: Flight): boolean =>
  f.pid > 0 ? isAlive(f.pid, f.startTime) : Date.now() - Date.parse(f.at) < checkLimits.graceMs;

/**
 * The verifier's full check of a milestone on the committed HEAD (spec 2.0 decision 18): the same run,
 * milestone, command and HEAD answer the recorded result; else a detached worker runs it. Past `waitMs` the
 * answer is `running`, and the next call waits for that same run.
 */
export async function runMilestoneCheck(
  i: { run: string; milestone: string; command: string; at?: string; force?: boolean },
  o: { onWait?: (w: LockWait | null) => void } = {},
): Promise<GateRunResult> {
  let last: Extract<GateRunResult, { running: false }> | undefined;
  let cached = true;
  const hints = new Set<string>();
  for (const command of checkItems(i.command)) {
    const r = await runCheckItem({ ...i, command }, o);
    if (r.running) return r;
    last = r;
    cached &&= r.cached;
    for (const hint of r.hints ?? []) hints.add(hint);
  }
  // checkItems always returns at least one item, including for an empty command.
  return { ...last!, cached, ...(hints.size ? { hints: [...hints] } : {}) };
}

/**
 * Plan 40 D3(a): a folder item's latest pass answers a new HEAD when `git diff` leaves that folder alone. The copy
 * keeps the old exit and lines, names its source, and is scanned again, since the scan covers base..HEAD.
 */
async function carriedRecord(
  run: Run,
  m: string,
  command: string,
  head: string,
  cwd: string,
  base: string | null,
): Promise<CheckRecord | null> {
  const dir = coveredDir(command);
  if (dir === null) return null;
  const old = readChecks(run.meta.repo)
    .filter(
      (r) =>
        r.run === run.id &&
        r.milestone === m &&
        r.command === command &&
        !r.baseline &&
        r.exit === 0 &&
        r.head !== head,
    )
    .at(-1);
  if (!old) return null;
  const diff = await git(cwd, ["diff", "--name-only", "--no-renames", old.head, head]);
  if (diff.kind !== "ok" || diff.out.split("\n").some((f) => f.startsWith(dir))) return null;
  const rec: CheckRecord = {
    ...old,
    at: new Date().toISOString(),
    head,
    carriedFrom: old.head,
    secrets: await secretScan(cwd, base),
  };
  appendCheckRecord(run.meta.repo, rec);
  return rec;
}

async function runCheckItem(
  i: { run: string; milestone: string; command: string; at?: string; force?: boolean },
  o: { onWait?: (w: LockWait | null) => void },
): Promise<GateRunResult> {
  const run = findRun(i.run);
  const repo = run.meta.repo;
  const cwd = i.at ?? treeOf(run, i.milestone);
  const baseline = i.at !== undefined;
  const headOut = await git(cwd, ["rev-parse", "HEAD"]);
  if (headOut.kind !== "ok" || !headOut.out.trim())
    throw invalid(`cannot read HEAD in ${cwd}`, "run it in a git checkout with a commit");
  const head = headOut.out.trim();
  const base = await checkBase(run, i.milestone);
  if (baseline) {
    if (!base || head !== base)
      throw invalid(
        `${cwd} is at ${head.slice(0, 12)}, not at the run's base ${base ? base.slice(0, 12) : "(none)"}`,
        `git worktree add --detach <dir> ${base ?? "<base>"}, then pass it as at`,
      );
  } else {
    const dirty = await git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty.kind !== "ok") throw invalid(`git status failed in ${cwd}`, "check that git works there");
    if (dirty.out.trim())
      throw invalid(
        "tracked files have uncommitted changes, and a check record names a commit",
        "commit the milestone first",
      );
  }
  const mine = (r: CheckRecord): boolean =>
    r.run === i.run &&
    r.milestone === i.milestone &&
    r.command === i.command &&
    r.head === head &&
    Boolean(r.baseline) === baseline;
  const result = async (record: CheckRecord, cached: boolean): Promise<GateRunResult> => {
    const gate = baseline ? { missing: [], audit: [] } : await machineGate(run, i.milestone, head);
    const hints =
      record.exit !== 0 && !baseline && !baselineFor(repo, i.command, base) && base
        ? [
            `the base's own failures are not recorded: git worktree add --detach <dir> ${base.slice(0, 12)}, run gate_run with at: <dir> there, then git worktree remove <dir>`,
          ]
        : [];
    return { running: false, cached, record, ...gate, ...(hints.length ? { hints } : {}) };
  };
  if (!i.force) {
    const prior = readChecks(repo).filter(mine).at(-1);
    if (prior) return result(prior, true);
    const carried = baseline ? null : await carriedRecord(run, i.milestone, i.command, head, cwd, base);
    if (carried) return result(carried, true);
  }
  const job: CheckJob = {
    run: i.run,
    repo,
    cwd,
    milestone: i.milestone,
    command: i.command,
    head,
    base,
    baseline,
    compose: composeProjectOf(run, i.milestone, baseline),
  };
  const file = flightOf(job);
  ensurePrivateDir(checkLogDir(repo));
  let started: string | null = null;
  for (let tries = 0; tries < 3 && started === null; tries++) {
    const at = new Date().toISOString();
    try {
      writeFileSync(file, JSON.stringify({ schema: 1, pid: -1, startTime: null, at, job } satisfies Flight), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const other = readFlight(file);
      if (other && flightLive(other)) {
        started = other.at;
        break;
      }
      try {
        unlinkSync(file);
      } catch {
        // another caller removed it first
      }
      continue;
    }
    const pid = launchCheckWorker(file);
    // the worker may be done and its flight removed already: never write the file back
    if (existsSync(file))
      writeJsonAtomic(file, { schema: 1, pid, startTime: processStartTime(pid), at, job } satisfies Flight);
    started = at;
  }
  if (started === null)
    throw new CatherdError("E_IO_UNEXPECTED", "the check could not be started", { fix: `remove ${file}` });
  const deadline = Date.now() + checkLimits.waitMs;
  for (;;) {
    const f = existsSync(file) ? readFlight(file) : null;
    if (!f) break;
    if (!flightLive(f)) {
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
      break;
    }
    if (Date.now() >= deadline)
      return {
        running: true,
        log: checkLogDir(repo),
        hint: "the check is still running; call gate_run again with the same arguments to wait for it",
      };
    o.onWait?.(f.waiting ?? null);
    await Bun.sleep(Math.min(checkLimits.pollMs, Math.max(1, deadline - Date.now())));
  }
  const record = readChecks(repo)
    .filter((r) => mine(r) && r.at >= started)
    .at(-1);
  if (!record)
    throw new CatherdError("E_IO_UNEXPECTED", "the check worker stopped without a record", {
      fix: `see worker.log in ${checkLogDir(repo)}`,
    });
  return result(record, false);
}

/** The detached worker: runs the job its flight file holds, records it, and removes the flight. */
export async function checkWorker(flight: string): Promise<void> {
  const f = readFlight(flight);
  if (!f) throw new Error(`no readable flight file ${flight}`);
  try {
    await execMilestoneCheck(f.job, { onWait: (waiting) => markWaiting(flight, waiting) });
  } finally {
    try {
      unlinkSync(flight);
    } catch {
      // the caller removed a stale one
    }
  }
}
