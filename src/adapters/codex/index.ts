import { CatherdError } from "../../domain/errors.ts";
import type { Access, RunStatus } from "../../domain/record.ts";
import {
  type BackendAdapter,
  compareVersions,
  type DiscoveredModel,
  extractVersion,
  type FinishedRun,
  type Outcome,
  type Probe,
  type RunRequest,
  type SpawnPlan,
} from "../backend.ts";
import { CODEX_LIMIT, CODEX_TOO_OLD, foldCodexEvents, parseCodexLine } from "./events.ts";
import { generatedImages, isolatedCodexHome, userCodexHome } from "./home.ts";

export const CODEX_MIN_VERSION = "0.157.0";
const THREAD = /^[A-Za-z0-9][A-Za-z0-9-]{3,127}$/;

const SANDBOX: Record<Access, string> = {
  "read-only": "read-only",
  "workspace-write": "workspace-write",
  full: "danger-full-access",
};

function sh(args: string[]): { ok: boolean; out: string; err: string } | null {
  if (!Bun.which("codex", { PATH: process.env.PATH ?? "" })) return null;
  const p = Bun.spawnSync(["codex", ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });
  return { ok: p.success, out: p.stdout.toString("utf8"), err: p.stderr.toString("utf8") };
}

function plan(r: RunRequest): SpawnPlan {
  if (r.thread !== null && !THREAD.test(r.thread))
    throw new CatherdError("E_ADMIT_THREAD", `"${r.thread}" is not a Codex thread id`, {
      fix: "pass the thread from the earlier RunRecord",
    });
  const common = [
    ...(r.isolated ? ["--ignore-user-config"] : []),
    "-m",
    r.rung.model,
    "-c",
    `model_reasoning_effort=${r.rung.effort}`,
    "--json",
    "-o",
    r.replyPath,
  ];
  const sandbox = SANDBOX[r.access];
  const args =
    r.thread === null
      ? ["exec", ...common, "-s", sandbox, "--", "-"]
      : ["exec", "resume", ...common, "-c", `sandbox_mode=${sandbox}`, "--", r.thread, "-"];
  return {
    cmd: "codex",
    args,
    env: r.isolated ? { CODEX_HOME: isolatedCodexHome() } : {},
    cwd: r.repo,
    stdinPath: r.briefPath,
  };
}

function finalize(run: FinishedRun): Outcome {
  const f = foldCodexEvents(run.eventLines);
  const tooOld = f.tooOld || CODEX_TOO_OLD.some((re) => re.test(run.stderr));
  const stopped = run.exit.reason;
  const status: RunStatus =
    stopped === "cancelled"
      ? "cancelled"
      : stopped === "idle-timeout" || stopped === "wall-timeout"
        ? "timeout"
        : tooOld
          ? "cli-too-old"
          : f.limit
            ? "limit"
            : f.turnFailed
              ? "failed"
              : run.exit.code !== 0 && !run.reply.trim()
                ? "failed"
                : "ok";
  const lastErr = run.stderr.trim().split("\n").at(-1) ?? "";
  const home = run.request.isolated ? isolatedCodexHome() : userCodexHome();
  return {
    status,
    thread: f.thread ?? run.request.thread,
    tokens: f.tokens,
    costUsd: null,
    images: generatedImages(home, f.thread ?? run.request.thread, run.startedAtMs),
    error:
      status === "ok"
        ? null
        : {
            code: status,
            message: f.failure ?? (lastErr || `${stopped}, exit ${run.exit.code ?? run.exit.signal}`),
          },
  };
}

async function probe(): Promise<Probe> {
  const v = sh(["--version"]);
  if (!v)
    return {
      installed: false,
      version: null,
      versionOk: false,
      loggedIn: null,
      problems: [
        { code: "E_BACKEND_MISSING", message: "codex is not on PATH", fix: "npm i -g @openai/codex" },
      ],
    };
  const version = extractVersion(v.out);
  const versionOk = version !== null && compareVersions(version, CODEX_MIN_VERSION) >= 0;
  const loggedIn = sh(["login", "status"])?.ok ?? false;
  const problems: Probe["problems"] = [];
  if (!versionOk)
    problems.push({
      code: "E_BACKEND_TOO_OLD",
      message: `codex ${version ?? "?"} is older than ${CODEX_MIN_VERSION}`,
      fix: "npm i -g @openai/codex@latest",
    });
  if (!loggedIn)
    problems.push({ code: "E_BACKEND_NOT_LOGGED_IN", message: "codex is not logged in", fix: "codex login" });
  return { installed: true, version, versionOk, loggedIn, problems };
}

async function listModels(): Promise<DiscoveredModel[]> {
  const r = sh(["debug", "models"]);
  const raw = r?.ok ? r.out : (sh(["debug", "models", "--bundled"])?.out ?? "");
  let data: { models?: Record<string, any>[] };
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  return (data.models ?? [])
    .filter((m) => m.visibility === "list" && typeof m.slug === "string")
    .map((m) => ({
      id: m.slug as string,
      efforts: ((m.supported_reasoning_levels ?? []) as { effort?: string }[])
        .map((l) => l.effort)
        .filter((e): e is string => typeof e === "string"),
      context: typeof m.context_window === "number" ? m.context_window : null,
      imageIn: Array.isArray(m.input_modalities) && m.input_modalities.includes("image"),
    }));
}

export const codexAdapter: BackendAdapter = {
  id: "codex",
  minVersion: CODEX_MIN_VERSION,
  probe,
  listModels,
  plan,
  parse(line) {
    const e = parseCodexLine(line);
    if (!e) return {};
    const f = foldCodexEvents([line]);
    return {
      ...(f.thread ? { thread: f.thread } : {}),
      ...(e.type === "turn.completed" ? { tokens: f.tokens } : {}),
      lastEvent: f.lastEvent ?? undefined,
      ...(f.turnFailed ? { failure: f.failure ?? "turn failed" } : {}),
      ...(f.limit ? { limit: true } : {}),
      ...(f.tooOld ? { tooOld: true } : {}),
    };
  },
  finalize,
  enforcement: { "read-only": "enforced", "workspace-write": "enforced", full: "enforced" },
  errors: { limit: CODEX_LIMIT, tooOld: CODEX_TOO_OLD },
  resume: { supported: true, sameAccessOnly: false, threadPattern: THREAD },
  graceAfterFinalMs: null,
};
