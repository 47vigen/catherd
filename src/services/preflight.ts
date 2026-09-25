import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLaneHeader } from "../domain/lane.ts";
import { workerEnv } from "../infra/env.ts";
import { heavySlots, withHeavySlot } from "../infra/heavy-lock.ts";
import { killGroup } from "../infra/proc.ts";
import type { Deps } from "./ports.ts";
import { findRun, type Run, runPaths } from "./run-store.ts";

/** Spec §4.7. Only `cannot-start` blocks the run. */
export type PreflightOutcome = "pass" | "fails-as-expected" | "skipped" | "cannot-start";

export interface PreflightResult {
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
    };

export const CHECK_TIMEOUT_MS = 120_000;
const TAIL_LINES = 20;

interface LaneCheck {
  lane: string;
  check: string | null;
  owns: string[];
  problem: string | null;
}

function laneChecks(run: Run): LaneCheck[] {
  const dir = runPaths(run.dir).lanes;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const lane = f.slice(0, -".md".length);
      try {
        const h = parseLaneHeader(readFileSync(join(dir, f), "utf8"));
        return {
          lane,
          check: h.fastCheck,
          owns: h.owns,
          problem: h.fastCheck ? null : `lanes/${f} has no Fast check: line`,
        };
      } catch (e) {
        return { lane, check: null, owns: [], problem: (e as Error).message };
      }
    });
}

/** How long the pipes may stay open after the check's own process exits. */
const DRAIN_MS = 500;

/** Reads a pipe chunk by chunk, so what arrived is kept when the reading stops early. */
function collect(stream: ReadableStream<Uint8Array>): {
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
  })().catch(() => {});
  return { done, text: () => text, stop: () => void reader.cancel().catch(() => {}) };
}

/**
 * Runs `check` with `sh -c` in its own process group, with catherd's secrets stripped, killing the group on
 * timeout. A process the check leaves behind (even in a new session) may hold the pipes open: once the check
 * exits, the pipes get DRAIN_MS to close, then the reading stops with what arrived.
 */
export async function runCheck(
  repo: string,
  check: string,
  timeoutMs: number,
): Promise<{ code: number | null; timedOut: boolean; tail: string[] }> {
  const p = Bun.spawn(["sh", "-c", check], {
    cwd: repo,
    env: workerEnv(process.env, {}, repo),
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

export function classify(r: { code: number | null; timedOut: boolean; tail: string[] }): PreflightOutcome {
  if (r.timedOut || r.code === 126 || r.code === 127) return "cannot-start";
  if (r.code === 0) return "pass";
  return r.tail.some((l) => /command not found/i.test(l)) ? "cannot-start" : "fails-as-expected";
}

/**
 * Spec §4.7: each lane's fast check once, on the base tree, behind the heavy lock. A check on a file the
 * lane itself creates is skipped. With `profile.preflight.confirm`, the first call only lists the commands.
 */
export async function preflight(
  deps: Deps,
  i: { run: string; confirmed?: boolean; timeoutMs?: number },
): Promise<PreflightReport> {
  const run = findRun(i.run);
  const profile = deps.profiles.forRepo(run.meta.repo);
  const lanes = laneChecks(run);
  const commands = lanes.map((l) => ({ lane: l.lane, check: l.check }));
  if (profile.preflight.confirm && !i.confirmed) return { needsConfirmation: true, commands };
  const timeoutMs = i.timeoutMs ?? CHECK_TIMEOUT_MS;
  const results: PreflightResult[] = [];
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
    const unborn = l.owns.filter(
      (p) => check.includes(p.replace(/\/$/, "")) && !existsSync(join(run.meta.repo, p)),
    );
    if (unborn.length) {
      const note = `${unborn.join(", ")} does not exist yet; the lane creates it`;
      results.push({ lane: l.lane, check, outcome: "skipped", exitCode: null, tail: [], note });
      continue;
    }
    const r = await withHeavySlot(heavySlots(profile.heavy), () => runCheck(run.meta.repo, check, timeoutMs));
    results.push({
      lane: l.lane,
      check,
      outcome: classify(r),
      exitCode: r.code,
      tail: r.tail,
      note: r.timedOut ? `timed out after ${timeoutMs / 1000} s` : null,
    });
  }
  return {
    needsConfirmation: false,
    commands,
    results,
    blocked: results.some((r) => r.outcome === "cannot-start"),
  };
}
