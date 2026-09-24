import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir } from "../paths.ts";
import {
  ROLE_SANDBOX,
  THREAD_HEAVY_INPUT,
  splitRung,
  type Role,
  type RungId,
  type RunRecord,
  type RunStatus,
} from "../types.ts";
import { parseCodexEvents } from "./codex-events.ts";
import { changedSince, parseReplyStatus, snapshotOwned } from "./reply.ts";
import {
  appendRunRecord,
  clearLive,
  type LiveMarker,
  rolePaths,
  rotateRound,
  writeLive,
} from "./runstore.ts";
import { readLines, runChild } from "./spawn.ts";

export interface DispatchOpts {
  runDir: string;
  name: string;
  role: Role;
  rung: RungId;
  cwd: string;
  thread?: string;
  ownedFiles: string[];
  isolated?: boolean;
  idleSecs?: number;
  onProgress?: (p: { secs: number; lastEvent: string | null }) => void;
}

export function userCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

/** Isolated runs only. `--ignore-user-config` alone still loads the global AGENTS.md, so the home goes too. */
export function codexHome(): string {
  const home = join(dataDir(), "codex-home");
  mkdirSync(home, { recursive: true });
  const auth = join(userCodexHome(), "auth.json");
  const link = join(home, "auth.json");
  if (!existsSync(link) && existsSync(auth)) symlinkSync(auth, link);
  return home;
}

export function codexArgs(o: DispatchOpts, replyPath: string): string[] {
  const { model, effort } = splitRung(o.rung);
  const sandbox = ROLE_SANDBOX[o.role];
  const common = [
    ...(o.isolated ? ["--ignore-user-config"] : []),
    "-m",
    model,
    "-c",
    `model_reasoning_effort=${effort}`,
    "--json",
    "-o",
    replyPath,
  ];
  return o.thread
    ? ["exec", "resume", ...common, "-c", `sandbox_mode=${sandbox}`, o.thread, "-"]
    : ["exec", ...common, "-s", sandbox, "-"];
}

/** Builds and appends the record from the files a finished run left. `code` is null after a reconcile. */
export function finalizeCodex(runDir: string, live: LiveMarker, code: number | null): RunRecord {
  const p = rolePaths(runDir, live.name);
  const ev = parseCodexEvents(readLines(p.jsonl));
  const reply = existsSync(p.out) ? readFileSync(p.out, "utf8") : "";
  const err = existsSync(p.err) ? readFileSync(p.err, "utf8") : "";
  const status: RunStatus =
    ev.cliTooOld || /not supported when using Codex with a ChatGPT account/i.test(err)
      ? "cli-too-old"
      : ev.limit
        ? "limit"
        : ev.turnFailed
          ? "failed"
          : code !== 0 && !reply.trim()
            ? "failed"
            : "ok";
  const rs = parseReplyStatus(reply);
  const started = Date.parse(live.startedAt);
  const record: RunRecord = {
    name: live.name,
    role: live.role,
    backend: "codex",
    rung: live.rung,
    thread: ev.thread ?? live.thread,
    status,
    startedAt: live.startedAt,
    secs: Math.round((Date.now() - started) / 1000),
    pid: live.pid,
    tokens: ev.tokens,
    costUsd: null,
    changedOwned: changedSince(live.cwd, new Map(Object.entries(live.before)), live.ownedFiles),
    replyStatus: rs.status,
    replyWhy: rs.why,
    threadHeavy: ev.tokens.input > THREAD_HEAVY_INPUT,
    isolated: live.isolated,
    images: [],
    error: status === "ok" ? null : (ev.failure ?? (err.trim().split("\n").at(-1) || `exit ${code}`)),
    replyPath: p.out,
  };
  appendRunRecord(runDir, record);
  clearLive(runDir, live.name);
  return record;
}

export async function runCodex(o: DispatchOpts): Promise<RunRecord> {
  const p = rolePaths(o.runDir, o.name);
  rotateRound(o.runDir, o.name);
  const isolated = o.isolated ?? false;
  const before = Object.fromEntries(snapshotOwned(o.cwd, o.ownedFiles));
  const startedAt = new Date().toISOString();
  let live: LiveMarker | null = null;
  let lastEvent: string | null = null;
  const res = await runChild("codex", codexArgs(o, p.out), {
    cwd: o.cwd,
    env: isolated ? { ...process.env, CODEX_HOME: codexHome() } : process.env,
    stdinFile: o.thread ? p.fix : p.brief,
    stdoutFile: p.jsonl,
    stderrFile: p.err,
    onSpawn: ({ pid }) => {
      live = {
        name: o.name,
        role: o.role,
        backend: "codex",
        rung: o.rung,
        pid,
        thread: o.thread ?? null,
        startedAt,
        cwd: o.cwd,
        ownedFiles: o.ownedFiles,
        isolated,
        before,
      };
      writeLive(o.runDir, live);
    },
    onLines: (lines) => {
      lastEvent = parseCodexEvents(lines).lastEvent ?? lastEvent;
    },
    tickMs: Number(process.env.CATHERD_TICK_MS ?? 60_000),
    onTick: () =>
      o.onProgress?.({ secs: Math.round((Date.now() - Date.parse(startedAt)) / 1000), lastEvent }),
  });
  if (!live) throw new Error("catherd: codex did not start");
  return finalizeCodex(o.runDir, live, res.code);
}
