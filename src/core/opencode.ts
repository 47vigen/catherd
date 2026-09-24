import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../paths.ts";
import { ROLE_SANDBOX, splitRung, type RunRecord, type RunStatus } from "../types.ts";
import type { DispatchOpts } from "./codex.ts";
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

/** An empty config home for isolated runs; opencode's credentials and session db live in its data dir, which stays. */
export function opencodeConfigHome(): string {
  const dir = join(dataDir(), "opencode-home", "config");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function opencodeArgs(o: DispatchOpts, brief: string): string[] {
  const { model, effort } = splitRung(o.rung);
  const spec = effort === "default" ? model : `${model}#${effort}`;
  const sandbox = ROLE_SANDBOX[o.role];
  const mode =
    sandbox === "read-only"
      ? ["--agent", "explore", "--auto"]
      : sandbox === "danger-full-access"
        ? ["--auto"]
        : [];
  // The background service resolves config, so only a private server sees the isolated XDG_CONFIG_HOME.
  const server = o.isolated ? ["--standalone"] : [];
  return [
    "run",
    ...server,
    "--format",
    "json",
    "-m",
    spec,
    ...mode,
    ...(o.thread ? ["-s", o.thread] : []),
    brief,
  ];
}

async function api(cwd: string, ...a: string[]): Promise<string> {
  // env must be explicit: Bun.spawn's default env is a snapshot from when this process launched,
  // not the current process.env, so a runtime PATH/FAKE_* override would otherwise be invisible here.
  const proc = Bun.spawn(["opencode", "api", ...a], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "ignore",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out;
}

/** Verified live on opencode 2.0.15: no "status":"running" field exists. `.data` is newest-first;
 * the session is idle iff the newest entry has `type: "idle"`, and busy otherwise (an in-flight
 * assistant message, still streaming a tool). */
async function sessionBusy(cwd: string, session: string): Promise<boolean> {
  try {
    const res = JSON.parse((await api(cwd, "GET", `/api/session/${session}/message`)) || "{}");
    return res?.data?.[0]?.type !== "idle";
  } catch {
    return false;
  }
}

function parse(lines: string[]) {
  let session: string | null = null;
  const texts: string[] = [];
  const errors: string[] = [];
  for (const l of lines) {
    let e: Record<string, any>;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    session ??= e.sessionID ?? null;
    if (e.type === "text" && e.part?.text) texts.push(e.part.text);
    if (e.type === "error") errors.push(e.error?.message ?? "error");
  }
  return { session, texts, errors };
}

export async function finalizeOpencode(
  runDir: string,
  live: LiveMarker,
  code: number | null,
  timedOut = false,
): Promise<RunRecord> {
  const p = rolePaths(runDir, live.name);
  const ev = parse(readLines(p.jsonl));
  const session = ev.session ?? live.thread;
  const reply = ev.texts.join("\n");
  writeFileSync(p.out, reply);
  let cost = 0;
  if (session) {
    try {
      cost = Number(
        JSON.parse((await api(live.cwd, "GET", `/api/session/${session}`)) || "{}")?.data?.cost ?? 0,
      );
    } catch {
      cost = 0;
    }
  }
  const status: RunStatus = timedOut
    ? "timeout"
    : ev.errors.length
      ? "failed"
      : code !== 0 && !reply
        ? "failed"
        : "ok";
  const rs = parseReplyStatus(reply);
  const record: RunRecord = {
    name: live.name,
    role: live.role,
    backend: "opencode",
    rung: live.rung,
    thread: session,
    status,
    startedAt: live.startedAt,
    secs: Math.round((Date.now() - Date.parse(live.startedAt)) / 1000),
    pid: live.pid,
    tokens: { input: 0, cached: 0, output: 0 },
    costUsd: cost,
    changedOwned: changedSince(live.cwd, new Map(Object.entries(live.before)), live.ownedFiles),
    replyStatus: rs.status,
    replyWhy: rs.why,
    threadHeavy: false,
    isolated: live.isolated,
    images: [],
    error:
      status === "ok"
        ? null
        : timedOut
          ? "no event within the idle limit and not busy"
          : (ev.errors.at(-1) ?? `exit ${code}`),
    replyPath: p.out,
  };
  appendRunRecord(runDir, record);
  clearLive(runDir, live.name);
  return record;
}

export async function runOpencode(o: DispatchOpts): Promise<RunRecord> {
  const p = rolePaths(o.runDir, o.name);
  rotateRound(o.runDir, o.name);
  const brief = readFileSync(o.thread ? p.fix : p.brief, "utf8");
  const isolated = o.isolated ?? false;
  const before = Object.fromEntries(snapshotOwned(o.cwd, o.ownedFiles));
  const startedAt = new Date().toISOString();
  const idleMs = (o.idleSecs ?? 600) * 1000;
  let session: string | null = o.thread ?? null;
  let lastEventAt = Date.now();
  let timedOut = false;
  let kill: (() => void) | null = null;
  let live: LiveMarker | null = null;
  let checking = false;

  // A quiet session that the server says is not running a tool is stuck: interrupt it server-side
  // (killing the client alone leaves it running and editing files), then stop the client.
  const watchdog = setInterval(
    () => {
      if (Date.now() - lastEventAt < idleMs || checking) return;
      checking = true;
      void (async () => {
        try {
          if (session && (await sessionBusy(o.cwd, session))) {
            lastEventAt = Date.now();
            return;
          }
          timedOut = true;
          if (session) await api(o.cwd, "POST", `/api/session/${session}/interrupt`);
          kill?.();
        } finally {
          checking = false;
        }
      })();
    },
    Math.min(1000, idleMs),
  );

  const res = await runChild("opencode", opencodeArgs(o, brief), {
    cwd: o.cwd,
    env: isolated ? { ...process.env, XDG_CONFIG_HOME: opencodeConfigHome() } : process.env,
    stdoutFile: p.jsonl,
    stderrFile: p.err,
    pollMs: 250,
    onSpawn: ({ pid, kill: k }) => {
      kill = k;
      live = {
        name: o.name,
        role: o.role,
        backend: "opencode",
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
      lastEventAt = Date.now();
      session ??= parse(lines).session;
    },
    tickMs: Number(process.env.CATHERD_TICK_MS ?? 60_000),
    onTick: () =>
      o.onProgress?.({ secs: Math.round((Date.now() - Date.parse(startedAt)) / 1000), lastEvent: null }),
  }).finally(() => clearInterval(watchdog));
  if (!live) throw new Error("catherd: opencode did not start");
  return finalizeOpencode(o.runDir, live, res.code, timedOut);
}
