import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendAdapter, FinishedRun } from "../adapters/backend.ts";
import { isCatherdError } from "../domain/errors.ts";
import { parseRung } from "../domain/ids.ts";
import type { Access } from "../domain/record.ts";
import { sanitize, type Scrub, secretValues } from "../domain/sanitize.ts";
import { workerEnv } from "../infra/env.ts";
import { git } from "../infra/git.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { readyAdapter } from "./backends.ts";

export interface CaptureCase {
  backend: string;
  name: string;
  rung: string;
  access: Access;
  brief: string;
}

const SAY_HELLO =
  "Reply with the single word hello. The last line of your reply is exactly: STATUS: complete — said hello";
const TRY_WRITE =
  "Create a file named out.txt containing the word hi. If you cannot, say why. The last line of your reply is: STATUS: complete|blocked — <one line why>";
const HAIKU = "claude-code:claude-haiku-4-5-20251001#default";
const BUNNY = "opencode:opencode/space-bunny-free#default";

/** Spec §11.7–8: one cheap run per backend, plus a read-only role trying to write where enforcement is advisory. */
export const CAPTURE_CASES: CaptureCase[] = [
  { backend: "codex", name: "ok", rung: "codex:gpt-6-luna#low", access: "read-only", brief: SAY_HELLO },
  { backend: "claude-code", name: "ok", rung: HAIKU, access: "read-only", brief: SAY_HELLO },
  { backend: "claude-code", name: "read-only-write", rung: HAIKU, access: "read-only", brief: TRY_WRITE },
  { backend: "opencode", name: "ok", rung: BUNNY, access: "read-only", brief: SAY_HELLO },
  { backend: "opencode", name: "read-only-write", rung: BUNNY, access: "read-only", brief: TRY_WRITE },
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

/** Runs one case the way a dispatch would (prepare, plan, the worker env), without the supervisor. */
async function captureOne(
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
    await adapter.prepare?.({ rung, access: c.access, isolated: false, repo });
    const request = {
      rung,
      access: c.access,
      thread: null,
      isolated: false,
      repo,
      briefPath,
      replyPath: join(work, "reply.md"),
      dispatchDir: work,
    };
    const plan = adapter.plan(request);
    const startedAtMs = Date.now();
    const p = Bun.spawn([plan.cmd, ...plan.args], {
      cwd: plan.cwd,
      env: workerEnv(process.env, plan.env, plan.cwd),
      stdin: Bun.file(briefPath),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    const [events, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    clearTimeout(timer);
    const run: FinishedRun = {
      request,
      eventLines: events.split("\n").filter((l) => l.trim()),
      reply: "",
      stderr,
      exit: {
        code: p.signalCode ? null : code,
        signal: p.signalCode ?? null,
        reason: "exited",
        endedAt: new Date().toISOString(),
      },
      startedAtMs,
    };
    const o = adapter.finalize(run);
    const scrub: Scrub = {
      secrets: secretValues(process.env),
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
      JSON.parse(
        clean(
          JSON.stringify({
            schema: 1,
            backend: c.backend,
            cliVersion: version,
            case: c.name,
            rung: c.rung,
            access: c.access,
            brief: c.brief,
            exitCode: run.exit.code,
            capturedAt: new Date().toISOString(),
            outcome: {
              status: o.status,
              thread: o.thread,
              tokens: o.tokens,
              costUsd: o.costUsd,
              error: o.error,
            },
          }),
        ),
      ),
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
