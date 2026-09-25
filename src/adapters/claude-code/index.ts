import { CatherdError } from "../../domain/errors.ts";
import type { Rung } from "../../domain/ids.ts";
import type { Access, RunStatus } from "../../domain/record.ts";
import {
  type BackendAdapter,
  compareVersions,
  type EventDelta,
  extractVersion,
  type FinishedRun,
  type Outcome,
  type Probe,
  type RunRequest,
  type SpawnPlan,
} from "../backend.ts";
import { jsonOf, runCli } from "../cli.ts";
import {
  CLAUDE_LIMIT,
  CLAUDE_TOO_OLD,
  claudeTokens,
  eventName,
  foldClaudeEvents,
  parseClaudeLine,
} from "./events.ts";
import { CLAUDE_ALIASES, CLAUDE_EFFORTS, CLAUDE_MODELS } from "./models.ts";

/** The version whose flags catherd was verified against (`claude --help`, 2026-09-25). */
export const CLAUDE_MIN_VERSION = "2.1.282";
const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a `claude` query (version, login) may take before it counts as failed. */
export const claudeShell = { timeoutMs: 15_000 };

const READ_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];
const NEVER = ["git commit", "git push", "git reset --hard"].map((c) => `Bash(${c} *)`);

/**
 * Spec §6.2 access → Claude Code permission flags (advisory: Bash can still write where it likes).
 * `dontAsk` denies anything not allowed; `--permission-prompts none` (always passed) denies any prompt.
 * Read-only gets no Bash at all, as catherd-ro on opencode: `rg --pre=<cmd>` executes and
 * `git diff --output=<file>` writes, so no Bash pattern is read-only. It reads with Read, Glob and Grep.
 */
export const CLAUDE_ACCESS: Record<Access, string[]> = {
  "read-only": [
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    READ_TOOLS.join(","),
    "--disallowedTools",
    "Edit,Write,NotebookEdit,Bash",
  ],
  "workspace-write": [
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    [...READ_TOOLS, "Edit", "Write", "NotebookEdit", "Bash"].join(","),
    "--disallowedTools",
    NEVER.join(","),
  ],
  full: ["--permission-mode", "bypassPermissions"],
};

function plan(r: RunRequest): SpawnPlan {
  if (r.thread !== null && !THREAD.test(r.thread))
    throw new CatherdError("E_ADMIT_THREAD", `"${r.thread}" is not a Claude Code session id`, {
      fix: "pass the thread from the earlier RunRecord",
    });
  return {
    cmd: "claude",
    args: [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      r.rung.model,
      // "default" leaves the effort to Claude Code (spec §5.1); Haiku has none
      ...(r.rung.effort === "default" ? [] : ["--effort", r.rung.effort]),
      // a fresh session gets its id from catherd, so the thread is known before the first event
      ...(r.thread === null ? ["--session-id", crypto.randomUUID()] : ["--resume", r.thread]),
      "--permission-prompts",
      "none",
      ...CLAUDE_ACCESS[r.access],
      // --bare would also drop OAuth, so a Claude plan could not log in; --safe-mode keeps auth
      ...(r.isolated ? ["--safe-mode"] : []),
    ],
    env: {},
    cwd: r.repo,
    stdinPath: r.briefPath,
  };
}

/** Spec §6.2: full model ids only, and an effort the model has. */
async function prepare(req: { rung: Rung; access: Access; isolated: boolean }): Promise<void> {
  const { model, effort } = req.rung;
  const full = CLAUDE_ALIASES[model];
  if (full || !model.startsWith("claude-"))
    throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", `"${model}" is not a full Claude model id`, {
      fix: `use the full id${full ? `, ${full}` : ", e.g. claude-opus-5-5"}`,
    });
  const known = CLAUDE_MODELS.find((m) => m.id === model);
  const efforts = known ? known.efforts : CLAUDE_EFFORTS;
  if (effort !== "default" && !efforts.includes(effort))
    throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", `${model} has no effort "${effort}"`, {
      fix: efforts.length ? `use one of: default, ${efforts.join(", ")}` : `use ${model}#default`,
    });
  if (req.access === "full" && process.getuid?.() === 0 && !process.env.IS_SANDBOX)
    throw new CatherdError(
      "E_ADMIT_RUNG",
      "claude refuses full access (bypassPermissions) when run as root",
      {
        fix: "run catherd as a normal user, or give this role workspace-write access",
      },
    );
}

function finalize(run: FinishedRun): Outcome {
  const f = foldClaudeEvents(run.eventLines);
  const res = f.result;
  const stopped = run.exit.reason;
  const failed = res === null || res.isError;
  const status: RunStatus =
    stopped === "cancelled"
      ? "cancelled"
      : stopped === "idle-timeout" || stopped === "wall-timeout"
        ? "timeout"
        : !failed
          ? "ok"
          : res === null && CLAUDE_TOO_OLD.some((r) => r.test(run.stderr))
            ? "cli-too-old"
            : f.limit
              ? "limit"
              : "failed";
  const lastErr = run.stderr.trim().split("\n").at(-1) ?? "";
  const message =
    res?.isError && res.text
      ? res.text
      : lastErr || (res ? "" : `no result event (${stopped}, exit ${run.exit.code ?? run.exit.signal})`);
  return {
    status,
    thread: f.thread ?? run.request.thread,
    tokens: res?.tokens ?? claudeTokens(undefined),
    costUsd: res?.costUsd ?? null,
    images: [],
    error: status === "ok" ? null : { code: status, message: message || status },
    ...(res && !res.isError ? { reply: res.text } : {}),
  };
}

function parse(line: string): EventDelta {
  const e = parseClaudeLine(line);
  if (!e) return {};
  const d: EventDelta = { lastEvent: eventName(e) };
  if (typeof e.session_id === "string" && e.session_id) d.thread = e.session_id;
  if (e.type === "system" && e.subtype === "api_retry") d.retrying = true;
  if (e.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected") d.limit = true;
  if (e.type === "result") {
    const f = foldClaudeEvents([line]);
    d.final = true;
    d.tokens = f.result?.tokens;
    if (typeof e.total_cost_usd === "number") d.costUsd = e.total_cost_usd;
    if (e.is_error === true) d.failure = String(e.result ?? "error");
    if (f.limit) d.limit = true;
  }
  return d;
}

async function probe(): Promise<Probe> {
  const v = await runCli("claude", ["--version"], claudeShell);
  if (!v)
    return {
      installed: false,
      version: null,
      versionOk: false,
      loggedIn: null,
      problems: [
        {
          code: "E_BACKEND_MISSING",
          message: "claude is not on PATH",
          fix: "npm i -g @anthropic-ai/claude-code",
        },
      ],
    };
  const version = extractVersion(v.out);
  const versionOk = version !== null && compareVersions(version, CLAUDE_MIN_VERSION) >= 0;
  const status = jsonOf((await runCli("claude", ["auth", "status", "--json"], claudeShell))?.out) as {
    loggedIn?: unknown;
  } | null;
  const loggedIn = status?.loggedIn === true;
  const problems: Probe["problems"] = [];
  if (!versionOk)
    problems.push({
      code: "E_BACKEND_TOO_OLD",
      message: `claude ${version ?? "?"} is older than ${CLAUDE_MIN_VERSION}`,
      fix: "claude update",
    });
  if (!loggedIn)
    problems.push({
      code: "E_BACKEND_NOT_LOGGED_IN",
      message: "claude is not logged in",
      fix: "claude auth login",
    });
  return { installed: true, version, versionOk, loggedIn, problems };
}

export const claudeCodeAdapter: BackendAdapter = {
  id: "claude-code",
  minVersion: CLAUDE_MIN_VERSION,
  probe,
  listModels: async () => CLAUDE_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] })),
  prepare,
  plan,
  parse,
  finalize,
  enforcement: { "read-only": "advisory", "workspace-write": "advisory", full: "advisory" },
  errors: { limit: CLAUDE_LIMIT, tooOld: CLAUDE_TOO_OLD },
  resume: { supported: true, sameAccessOnly: false, threadPattern: THREAD },
  // the `result` event is the last thing claude prints; a CLI still running 30 s later is stuck
  graceAfterFinalMs: 30_000,
};
