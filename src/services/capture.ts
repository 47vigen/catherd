import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendAdapter, FinishedRun, Outcome, RunRequest } from "../adapters/backend.ts";
import { isCatherdError } from "../domain/errors.ts";
import { parseRung } from "../domain/ids.ts";
import type { Access } from "../domain/record.ts";
import { sanitize, type Scrub } from "../domain/sanitize.ts";
import { secretEnvValues } from "../domain/secrets.ts";
import { workerEnv } from "../infra/env.ts";
import { git } from "../infra/git.ts";
import { killGroup } from "../infra/proc.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { readyAdapter } from "./backends.ts";
import { settled } from "./finalize.ts";
import { collect, DRAIN_MS } from "./preflight.ts";

interface CaptureCase {
  backend: string;
  name: string;
  rung: string;
  access: Access;
  brief: string;
  /** a second brief that resumes the first run's thread in the same repo; the resumed run is captured */
  resume?: string;
}

const SAY_HELLO =
  "Reply with the single word hello. The last line of your reply is exactly: STATUS: complete — said hello";
const TRY_WRITE =
  "Create a file named out.txt containing the word hi. If you cannot, say why. The last line of your reply is: STATUS: complete|blocked — <one line why>";
const WORK =
  "Create a file named notes.txt containing hi, read it back, then run the shell command `git status --short`. The last line of your reply is exactly: STATUS: complete — wrote notes.txt";
const RECALL =
  "Which single word did you reply with earlier in this chat? Reply with it. The last line of your reply is exactly: STATUS: complete — recalled";
const HAIKU = "claude-code:claude-haiku-4-5-20251001#default";
/** spec 1.3 §4.6: `auto` has no family; only the live kit and the capture run it */
const AUTO = "cursor:auto#default";
const BUNNY = "opencode:opencode/space-bunny-free#default";
/** spec 1.3 §5.6: grok 1.0.44's default model (research §3.4) at its cheapest effort */
const GROK = "grok:grok-4.6#low";

/** Spec §11.7–8: one cheap run per backend, plus a read-only role trying to write where enforcement is advisory. */
const CAPTURE_CASES: CaptureCase[] = [
  { backend: "codex", name: "ok", rung: "codex:gpt-6-luna#low", access: "read-only", brief: SAY_HELLO },
  { backend: "claude-code", name: "ok", rung: HAIKU, access: "read-only", brief: SAY_HELLO },
  { backend: "claude-code", name: "read-only-write", rung: HAIKU, access: "read-only", brief: TRY_WRITE },
  { backend: "opencode", name: "ok", rung: BUNNY, access: "read-only", brief: SAY_HELLO },
  { backend: "opencode", name: "read-only-write", rung: BUNNY, access: "read-only", brief: TRY_WRITE },
  // spec 1.3 §4.7: a read, a write and a shell call; a resumed chat (research §2.5); ask mode trying to write
  { backend: "cursor", name: "ok", rung: AUTO, access: "workspace-write", brief: WORK },
  { backend: "cursor", name: "resume", rung: AUTO, access: "read-only", brief: SAY_HELLO, resume: RECALL },
  { backend: "cursor", name: "read-only-write", rung: AUTO, access: "read-only", brief: TRY_WRITE },
  // spec 1.3 §5.6: the same three on grok; its read-only is the kernel profile, or the read tools on a Mac
  // with a symlinked docker socket
  { backend: "grok", name: "ok", rung: GROK, access: "workspace-write", brief: WORK },
  { backend: "grok", name: "resume", rung: GROK, access: "read-only", brief: SAY_HELLO, resume: RECALL },
  { backend: "grok", name: "read-only-write", rung: GROK, access: "read-only", brief: TRY_WRITE },
];
export const CAPTURE_BACKENDS = [...new Set(CAPTURE_CASES.map((c) => c.backend))];

export type Captured =
  | {
      backend: string;
      name: string;
      status: "captured";
      dir: string;
      cliVersion: string;
      exitCode: number | null;
    }
  | { backend: string; name: string; status: "skipped"; reason: string };

async function scratchRepo(): Promise<{ work: string; repo: string }> {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "catherd-capture-")));
  const repo = join(work, "repo");
  mkdirSync(repo);
  await git(repo, ["init", "-q"]);
  await git(repo, [
    "-c",
    "user.name=catherd",
    "-c",
    "user.email=capture@catherd.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
  return { work, repo };
}

/** Every string in `v`, cleaned: meta values are sanitized before JSON escapes them, not after. */
function cleanStrings(v: unknown, clean: (s: string) => string): unknown {
  if (typeof v === "string") return clean(v);
  if (Array.isArray(v)) return v.map((x) => cleanStrings(x, clean));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanStrings(x, clean)]));
  return v;
}

/** One run as an isolated dispatch would start it (plan, the worker env), without the supervisor. */
async function runOnce(
  adapter: BackendAdapter,
  request: RunRequest,
  timeoutMs: number,
): Promise<{ run: FinishedRun; events: string; stderr: string; o: Outcome }> {
  const plan = adapter.plan(request);
  const startedAtMs = Date.now();
  const p = Bun.spawn([plan.cmd, ...plan.args], {
    cwd: plan.cwd,
    env: workerEnv(process.env, plan.env, plan.cwd),
    // spec 1.3 §3.3: the brief goes on stdin only to a CLI whose plan reads it there (grok reads a file)
    stdin: plan.stdinPath ? Bun.file(plan.stdinPath) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // its own group, so a timeout stops whatever the CLI started too, as the supervisor does
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(p.pid, "SIGKILL");
  }, timeoutMs);
  // as preflight does: a process the CLI left behind (in its own session) may hold the pipes open
  const out = collect(p.stdout);
  const err = collect(p.stderr);
  const code = await p.exited;
  clearTimeout(timer);
  const drained = await Promise.race([
    Promise.all([out.done, err.done]).then(() => true),
    Bun.sleep(DRAIN_MS).then(() => false),
  ]);
  if (!drained) killGroup(p.pid, "SIGKILL"); // leftovers still in the CLI's group
  out.stop();
  err.stop();
  const events = out.text();
  const stderr = err.text();
  const run: FinishedRun = {
    request,
    eventLines: events.split("\n").filter((l) => l.trim()),
    reply: "",
    stderr,
    exit: {
      code: p.signalCode ? null : code,
      signal: p.signalCode ?? null,
      reason: timedOut ? "wall-timeout" : "exited",
      endedAt: new Date().toISOString(),
    },
    startedAtMs,
  };
  // as a dispatch records it: the backend's own totals and limits, on a fresh thread (nothing prior)
  const o = await settled(adapter, adapter.finalize(run), run, () => ({
    tokens: { input: 0, cached: 0, output: 0 },
    costUsd: 0,
  }));
  return { run, events, stderr, o };
}

/**
 * Runs one case the way an isolated dispatch would (prepare, plan, the worker env), without the
 * supervisor. Isolated, so the stream names none of the owner's own hooks, plugins, MCP servers or config:
 * the fixtures are committed. A case with `resume` runs its brief, then resumes that thread in the same
 * scratch repo with `resume`, and captures the resumed run.
 */
export async function captureOne(
  adapter: BackendAdapter,
  version: string,
  c: CaptureCase,
  outDir: string,
  timeoutMs: number,
): Promise<Captured> {
  const { work, repo } = await scratchRepo();
  try {
    const briefPath = join(work, "brief.md");
    writeFileSync(briefPath, c.brief);
    const rung = parseRung(c.rung);
    await adapter.prepare?.({ rung, access: c.access, isolated: true, repo, network: true });
    const request: RunRequest = {
      rung,
      access: c.access,
      thread: null,
      isolated: true,
      repo,
      briefPath,
      replyPath: join(work, "reply.md"),
      dispatchDir: work,
    };
    let captured = await runOnce(adapter, request, timeoutMs);
    const resumed = c.resume === undefined ? null : captured.o.thread;
    if (c.resume !== undefined) {
      if (!resumed)
        return {
          backend: c.backend,
          name: c.name,
          status: "skipped",
          reason: `the first run left no thread to resume (${captured.o.error?.message ?? captured.o.status})`,
        };
      writeFileSync(briefPath, c.resume);
      captured = await runOnce(adapter, { ...request, thread: resumed }, timeoutMs);
    }
    const { run, events, stderr, o } = captured;
    const scrub: Scrub = {
      secrets: secretEnvValues(process.env),
      paths: [
        { from: repo, to: "<repo>" },
        { from: work, to: "<tmp>" },
        { from: realpathSync(tmpdir()), to: "<tmp>" },
        { from: homedir(), to: "~" },
      ],
    };
    const clean = (t: string) => sanitize(t, scrub);
    const dir = join(outDir, c.backend, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${c.name}.jsonl`), clean(events));
    writeFileSync(join(dir, `${c.name}.stderr`), clean(stderr));
    writeJsonAtomic(
      join(dir, `${c.name}.json`),
      cleanStrings(
        {
          schema: 1,
          backend: c.backend,
          cliVersion: version,
          case: c.name,
          rung: c.rung,
          access: c.access,
          isolated: true,
          brief: c.resume ?? c.brief,
          ...(resumed ? { resumed } : {}),
          exitCode: run.exit.code,
          reason: run.exit.reason,
          capturedAt: new Date().toISOString(),
          outcome: {
            status: o.status,
            thread: o.thread,
            tokens: o.tokens,
            costUsd: o.costUsd,
            error: o.error,
          },
        },
        clean,
      ),
      { mode: 0o644 },
    );
    return {
      backend: c.backend,
      name: c.name,
      status: "captured",
      dir,
      cliVersion: version,
      exitCode: run.exit.code,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Spec §11.8: records the capture cases of every ready backend (or only `backends`) under
 * `<outDir>/<backend>/<cli-version>/`, with secrets and home paths stripped. A backend that is not
 * ready is skipped with the reason.
 */
export async function captureFixtures(o: {
  outDir: string;
  backends?: string[];
  timeoutMs?: number;
}): Promise<Captured[]> {
  const out: Captured[] = [];
  for (const c of CAPTURE_CASES.filter((x) => !o.backends || o.backends.includes(x.backend))) {
    try {
      const { adapter, probe } = await readyAdapter(c.backend);
      out.push(await captureOne(adapter, probe.version ?? "unknown", c, o.outDir, o.timeoutMs ?? 300_000));
    } catch (e) {
      if (!isCatherdError(e)) throw e;
      out.push({ backend: c.backend, name: c.name, status: "skipped", reason: `${e.code}: ${e.message}` });
    }
  }
  return out;
}
