import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CatherdError, errorMessage } from "../domain/errors.ts";
import { assertLaneHeader, LANE_HEADER_FIX, parseLaneHeader } from "../domain/lane.ts";
import { checkEnv } from "../infra/env.ts";
import { heavySlots, withHeavySlotWithin } from "../infra/heavy-lock.ts";
import { loginEnv } from "../infra/login-env.ts";
import { killGroup } from "../infra/proc.ts";
import { readGateEnv, resolveGateEnv } from "./gate-env.ts";
import { landedMilestones } from "./milestones.ts";
import type { Deps } from "./ports.ts";
import { TAIL_LINES } from "./run-debug.ts";
import { findRun, type Run, runPaths } from "./run-store.ts";

/** Spec §4.7. Only `cannot-start` blocks the run; `lock-busy` (plan 23) means: run preflight again. */
export type PreflightOutcome = "pass" | "fails-as-expected" | "skipped" | "cannot-start" | "lock-busy";

interface PreflightResult {
  lane: string;
  check: string | null;
  outcome: PreflightOutcome;
  exitCode: number | null;
  tail: string[];
  note: string | null;
}

export type PreflightReport =
  | { needsConfirmation: true; commands: { lane: string; check: string | null }[] }
  | {
      needsConfirmation: false;
      commands: { lane: string; check: string | null }[];
      results: PreflightResult[];
      blocked: boolean;
      /** plan 23: lanes whose fast check runs no linter while the repo has one */
      warnings: string[];
    };

const CHECK_TIMEOUT_MS = 120_000;

/** Whose uid preflight runs under; tests stand in for root with it. */
export const preflightUser = { uid: (): number => process.getuid?.() ?? -1 };

/**
 * Spec §10.4: a lane's check never runs as root. A machine that says it is disposable (IS_SANDBOX, the
 * rule claude itself applies to root) is the one exception.
 */
const refusesRoot = (): boolean => preflightUser.uid() === 0 && !process.env.IS_SANDBOX;
const AS_ROOT =
  "not run: catherd runs as root, and preflight never runs a lane's check as root (spec §10.4); run catherd as a normal user, or set IS_SANDBOX=1 on a disposable machine";

interface LaneCheck {
  lane: string;
  check: string | null;
  owns: string[];
  problem: string | null;
  /** spec 1.1 §6: why its Kind: or Difficulty: line is refused */
  invalid: string | null;
}

function laneChecks(run: Run): LaneCheck[] {
  const dir = runPaths(run.dir).lanes;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const lane = f.slice(0, -".md".length);
      let invalid: string | null = null;
      try {
        const text = readFileSync(join(dir, f), "utf8");
        try {
          assertLaneHeader(text, `lanes/${f}`);
        } catch (e) {
          invalid = errorMessage(e);
        }
        const h = parseLaneHeader(text);
        return {
          lane,
          check: h.fastCheck,
          owns: h.owns,
          problem: h.fastCheck ? null : `lanes/${f} has no Fast check: line`,
          invalid,
        };
      } catch (e) {
        return { lane, check: null, owns: [], problem: (e as Error).message, invalid };
      }
    });
}

/** How long the pipes may stay open after the check's own process exits. */
export const DRAIN_MS = 500;

/** Reads a pipe chunk by chunk, so what arrived is kept when the reading stops early. */
export function collect(stream: ReadableStream<Uint8Array>): {
  done: Promise<void>;
  text: () => string;
  stop: () => void;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += decoder.decode(value, { stream: true });
    }
  })().catch(() => {
    // a pipe that breaks ends the reading; what arrived is kept
  });
  // cancelling a pipe that is already closed has nothing to report
  return { done, text: () => text, stop: () => void reader.cancel().catch(() => {}) };
}

/**
 * Runs `check` with `sh -c` in its own process group, with an allowlisted env (no credentials), killing the
 * group on timeout. A process the check leaves behind (even in a new session) may hold the pipes open: once
 * the check exits, the pipes get DRAIN_MS to close, then the reading stops with what arrived.
 */
export async function runCheck(
  repo: string,
  check: string,
  timeoutMs: number,
  env: Record<string, string> = checkEnv(process.env, repo),
): Promise<{ code: number | null; timedOut: boolean; tail: string[] }> {
  const p = Bun.spawn(["sh", "-c", check], {
    cwd: repo,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(p.pid, "SIGKILL");
  }, timeoutMs);
  const out = collect(p.stdout);
  const err = collect(p.stderr);
  try {
    // the timeout kills the group, so the check's own process always exits
    const code = await p.exited;
    clearTimeout(timer); // the check is done: a slow drain is not a timeout
    const drained = await Promise.race([
      Promise.all([out.done, err.done]).then(() => true),
      Bun.sleep(DRAIN_MS).then(() => false),
    ]);
    if (!drained) killGroup(p.pid, "SIGKILL"); // leftovers still in the check's group
    const tail = `${out.text()}${err.text()}`
      .split("\n")
      .filter((l) => l.trim())
      .slice(-TAIL_LINES);
    return { code: timedOut ? null : code, timedOut, tail };
  } finally {
    clearTimeout(timer);
    out.stop();
    err.stop();
  }
}

/**
 * Plan 23: a check that failed on the machine, not on the code: no Docker (or none at DOCKER_HOST), no DNS, a
 * permission the sandbox or the OS denied. Such a check cannot start; it never fails as expected.
 */
const ENVIRONMENT = [
  /command not found/i,
  /Cannot connect to the Docker daemon/i,
  /rootless Docker not found/i,
  /Could not find a valid Docker environment/i,
  /docker\.sock: connect: no such file or directory/i,
  /Temporary failure in name resolution|Could not resolve host|no such host|Name or service not known|nodename nor servname|getaddrinfo (ENOTFOUND|EAI_AGAIN)/i,
  /permission denied|operation not permitted|\bEACCES\b|\bEPERM\b/i,
];

/** pnpm exits 0 on a `--filter` that matches no package: the lane creates it, so there is nothing to run yet. */
const EMPTY_FILTER = /No projects matched the filters/i;

/** The first tail line an ENVIRONMENT pattern matches, or null. */
export const environmentLine = (tail: string[]): string | null =>
  tail.find((l) => ENVIRONMENT.some((re) => re.test(l))) ?? null;

/** One `pnpm … --filter …` command, nothing chained, piped or backgrounded beside it. */
const SINGLE_PNPM_FILTER = /^\s*pnpm\s(?:[^;&|\n`$()<>]*\s)?(?:--filter|-F)(?:[\s=])[^;&|\n`$()<>]*$/;

/**
 * An unmatched pnpm filter is "skipped" only when it is provably the check's sole failure: the whole check
 * exited 0, or the check is a single pnpm --filter command. In a compound check (`pnpm --filter new test;
 * docker compose up`) a later command's failure decides.
 */
export function classify(
  r: { code: number | null; timedOut: boolean; tail: string[] },
  command?: string,
): PreflightOutcome {
  if (r.timedOut || r.code === 126 || r.code === 127) return "cannot-start";
  const soleFailure = r.code === 0 || (command !== undefined && SINGLE_PNPM_FILTER.test(command));
  if (soleFailure && r.tail.some((l) => EMPTY_FILTER.test(l))) return "skipped";
  if (r.code === 0) return "pass";
  return environmentLine(r.tail) !== null ? "cannot-start" : "fails-as-expected";
}

/** Why a classified result says what it says, for its note. */
function noteOf(
  r: { code: number | null; timedOut: boolean; tail: string[] },
  outcome: PreflightOutcome,
  timeoutMs: number,
): string | null {
  if (r.timedOut) return `timed out after ${timeoutMs / 1000} s`;
  if (outcome === "skipped") return "the pnpm filter matches no package yet; the lane creates it";
  const env = outcome === "cannot-start" ? environmentLine(r.tail) : null;
  return env ? `environment: ${env.trim()}` : null;
}

/** How long one check waits for a heavy slot before it reports lock-busy; tests shorten it. */
export const preflightLimits = { lockWaitMs: 60_000 };

/**
 * Plan 23: a check runs in the user's login environment (DOCKER_HOST and the rest a login shell sets), through
 * the allowlist, plus the repo's gate environment. A login PATH comes first, with the server's own after it.
 */
export function checkEnvFor(repo: string): Record<string, string> {
  const login = loginEnv();
  const base: Record<string, string | undefined> = { ...process.env, ...login };
  const path = [
    ...new Set([...(login.PATH ?? "").split(":"), ...(process.env.PATH ?? "").split(":")].filter(Boolean)),
  ];
  if (path.length) base.PATH = path.join(":");
  return { ...checkEnv(base, repo), ...resolveGateEnv(readGateEnv(repo), base).env };
}

/** What a fast check names when it lints: a lint script, or a linter by name. */
const LINT_STEP = /\b(lint|eslint|biome|oxlint|golangci-lint|ruff|clippy|vet|check)\b/i;

/** Root files that say the repo has a linter, by the linter they configure. */
const LINT_CONFIGS: [RegExp, string][] = [
  [/^\.golangci\.(ya?ml|toml|json)$/, "golangci-lint"],
  [/^(biome\.jsonc?)$/, "biome"],
  [/^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?)$/, "eslint"],
  [/^\.?oxlintrc\.json$/, "oxlint"],
  [/^\.?ruff\.toml$/, "ruff"],
];

/** The linter the repo has, by name, or null: a root lint config, or a `lint` script in package.json. */
export function repoLinter(repo: string): string | null {
  for (const name of existsSync(repo) ? readdirSync(repo) : [])
    for (const [re, linter] of LINT_CONFIGS) if (re.test(name)) return linter;
  try {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    if (typeof pkg.scripts?.lint === "string") return "the lint script";
  } catch {
    // no package.json, or one that does not parse: no lint script
  }
  return null;
}

/**
 * Spec §4.7: each lane's fast check once, on the base tree, behind the heavy lock. A check on a file the
 * lane itself creates is skipped. With `profile.preflight.confirm`, the first call only lists the commands.
 */
export async function preflight(
  deps: Deps,
  i: { run: string; confirmed?: boolean; timeoutMs?: number; milestone?: string },
): Promise<PreflightReport> {
  const run = findRun(i.run);
  const profile = deps.profiles.forRepo(run.meta.repo);
  // plan 23: one milestone's lanes, or by default every lane whose milestone has not landed
  const landed = new Set(landedMilestones(run));
  const milestoneOf = (lane: string) => lane.split(".")[0] as string;
  const lanes = laneChecks(run).filter((l) =>
    i.milestone ? milestoneOf(l.lane) === i.milestone : !landed.has(milestoneOf(l.lane)),
  );
  // spec 1.1 §6: refuse before running anything, naming every lane whose header the catalog cannot route
  const invalid = lanes.flatMap((l) => (l.invalid ? [l.invalid] : []));
  if (invalid.length) throw new CatherdError("E_LANE_INVALID", invalid.join("; "), { fix: LANE_HEADER_FIX });
  const commands = lanes.map((l) => ({ lane: l.lane, check: l.check }));
  if (profile.preflight.confirm && !i.confirmed) return { needsConfirmation: true, commands };
  const timeoutMs = i.timeoutMs ?? CHECK_TIMEOUT_MS;
  const results: PreflightResult[] = [];
  // the login env is captured once per server; the gate env is read once per preflight
  let env: Record<string, string> | undefined;
  for (const l of lanes) {
    const check = l.check;
    if (!check) {
      results.push({
        lane: l.lane,
        check,
        outcome: "cannot-start",
        exitCode: null,
        tail: [],
        note: l.problem,
      });
      continue;
    }
    if (refusesRoot()) {
      results.push({ lane: l.lane, check, outcome: "skipped", exitCode: null, tail: [], note: AS_ROOT });
      continue;
    }
    const unborn = l.owns.filter(
      (p) => check.includes(p.replace(/\/$/, "")) && !existsSync(join(run.meta.repo, p)),
    );
    if (unborn.length) {
      const note = `${unborn.join(", ")} does not exist yet; the lane creates it`;
      results.push({ lane: l.lane, check, outcome: "skipped", exitCode: null, tail: [], note });
      continue;
    }
    env ??= checkEnvFor(run.meta.repo);
    const checkEnvironment = env;
    // plan 23: each check waits for its slot within its own budget, and says lock-busy past it
    const slot = await withHeavySlotWithin(heavySlots(profile.heavy), preflightLimits.lockWaitMs, () =>
      runCheck(run.meta.repo, check, timeoutMs, checkEnvironment),
    );
    if (slot.busy) {
      const note = `every heavy slot stayed busy for ${preflightLimits.lockWaitMs / 1000} s (other lanes' checks); run preflight again when they finish`;
      results.push({ lane: l.lane, check, outcome: "lock-busy", exitCode: null, tail: [], note });
      continue;
    }
    const r = slot.value;
    const outcome = classify(r, check);
    results.push({
      lane: l.lane,
      check,
      outcome,
      exitCode: r.code,
      tail: r.tail,
      note: noteOf(r, outcome, timeoutMs),
    });
  }
  // plan 23: lint reaches the worker only through its fast check
  const linter = repoLinter(run.meta.repo);
  const warnings = linter
    ? lanes
        .filter((l) => l.check && !LINT_STEP.test(l.check))
        .map(
          (l) =>
            `${l.lane}: its fast check runs no linter, and the repo has one (${linter}): add the linter of every package the lane touches to its Fast check: line`,
        )
    : [];
  return {
    needsConfirmation: false,
    commands,
    results,
    blocked: results.some((r) => r.outcome === "cannot-start"),
    warnings,
  };
}
