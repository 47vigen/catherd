import { CatherdError } from "../../domain/errors.ts";
import type { Rung } from "../../domain/ids.ts";
import type { Access, RunStatus } from "../../domain/record.ts";
import {
  type AccessShell,
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeHome } from "../../infra/paths.ts";
import { ROLE_MCP_SERVER, roleMcpTools } from "../../domain/role-tools.ts";
import { roleMcpConfig } from "../../infra/role-mcp.ts";
import { dockerSocket, scratchShell, writableRoots } from "../access.ts";
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
import { listClaudeModels } from "./models-api.ts";

/** The version whose flags catherd was verified against (`claude --help`, 2026-09-25). */
const CLAUDE_MIN_VERSION = "2.1.282";
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

/**
 * Spec §5 for headless Claude Code. Its Bash runs unsandboxed unless the user turned Claude Code's own
 * sandbox on (`sandbox.enabled`); then these settings, merged over the user's, add the lock and temp dirs,
 * loopback binds, the Docker socket and `docker` itself (which cannot run inside that sandbox). Outbound
 * domains stay the user's `sandbox.network.allowedDomains`: doctor's `access:claude-code` row says when
 * the registry is not among them. `network: false` drops the network grants and the web tools (and with
 * them Docker: the socket and `docker *` are network grants) and sets `allowLocalBinding: false`, so the
 * user's own `true` does not carry over (their allowedDomains and other array grants merge in and stay;
 * doctor says `network: false` is not enforced by claude-code's shell). With the user's sandbox on, `enabled: true`
 * goes in too, so a merge that replaces the whole `sandbox` object cannot turn it off.
 */
export function claudeAccessArgs(
  access: Access,
  network = true,
  repo?: string,
  extra: string[] = [],
): string[] {
  const base = CLAUDE_ACCESS[access];
  if (access !== "workspace-write") return base;
  const sock = dockerSocket();
  const sandbox = {
    ...(claudeSandboxOn(repo) ? { enabled: true } : {}),
    filesystem: { allowWrite: [...new Set([...writableRoots(), ...extra])] },
    ...(network
      ? {
          network: { allowLocalBinding: true, ...(sock ? { allowUnixSockets: [sock] } : {}) },
          excludedCommands: ["docker *"],
        }
      : // a boolean overrides the user's own `allowLocalBinding: true`; their array grants cannot be revoked here
        { network: { allowLocalBinding: false } }),
  };
  const args = [...base, "--settings", JSON.stringify({ sandbox })];
  if (!network) {
    const i = args.indexOf("--disallowedTools") + 1;
    args[i] = [args[i], "WebFetch", "WebSearch"].join(",");
  }
  return args;
}

/** `sandbox.enabled` in one settings file, when it says true or false; undefined when absent or unreadable. */
function sandboxEnabledIn(file: string): boolean | undefined {
  try {
    const on = JSON.parse(readFileSync(file, "utf8"))?.sandbox?.enabled;
    return typeof on === "boolean" ? on : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether Claude Code's Bash sandbox is on for a worker in `repo` (`sandbox.enabled`): the most specific
 * settings file that says wins, as Claude Code layers them: the user's settings.json, then the project's
 * .claude/settings.json and .claude/settings.local.json (Claude Code has no user-level settings.local.json).
 */
export function claudeSandboxOn(repo: string = process.cwd()): boolean {
  const files = [
    join(claudeHome(), "settings.json"),
    join(repo, ".claude", "settings.json"),
    join(repo, ".claude", "settings.local.json"),
  ];
  return files.map(sandboxEnabledIn).findLast((on) => on !== undefined) ?? false;
}

/**
 * Spec §5: with Claude Code's own sandbox off (its default) a headless worker's Bash is an unsandboxed
 * shell, which doctor probes as is. With it on, only a model turn runs inside it, so doctor says what to
 * check instead of spending one.
 */
async function accessShell(): Promise<AccessShell | string> {
  if (claudeSandboxOn())
    return "Claude Code's own sandbox is on (sandbox.enabled): catherd passes the lock, temp, loopback and Docker grants in --settings; outbound HTTPS reaches only sandbox.network.allowedDomains, so add registry.npmjs.org and the hosts your checks need there";
  return scratchShell("an unsandboxed shell (Claude Code's sandbox is off)", []);
}

function plan(r: RunRequest): SpawnPlan {
  if (r.thread !== null && !THREAD.test(r.thread))
    throw new CatherdError("E_ADMIT_THREAD", `"${r.thread}" is not a Claude Code session id`, {
      fix: "pass the thread from the earlier RunRecord",
    });
  const accessArgs = [...claudeAccessArgs(r.access, r.network, r.repo, r.scratch ? [r.scratch] : [])];
  if (r.roleMcp) {
    const tools = roleMcpTools(r.roleMcp.role).map((tool) => `mcp__${ROLE_MCP_SERVER}__${tool}`);
    const allowed = accessArgs.indexOf("--allowedTools");
    if (allowed >= 0) accessArgs[allowed + 1] = [accessArgs[allowed + 1], ...tools].join(",");
    else accessArgs.push("--allowedTools", tools.join(","));
    accessArgs.push(
      "--mcp-config",
      JSON.stringify({ mcpServers: { [ROLE_MCP_SERVER]: roleMcpConfig(r.roleMcp) } }),
    );
  }
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
      ...accessArgs,
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

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Spec §3.7: the main thread's last tool call (a command, a file edit, another tool) or its text. */
function claudeActivity(e: Record<string, any>): string | undefined {
  if (e.type !== "assistant" || e.parent_tool_use_id) return undefined;
  const c = (e.message?.content ?? []).at(-1);
  if (c?.type === "tool_use") {
    const input = c.input ?? {};
    if (typeof input.command === "string") return `$ ${input.command}`;
    if (typeof input.file_path === "string")
      return `${EDIT_TOOLS.has(c.name) ? "edit" : String(c.name)} ${input.file_path}`;
    return String(c.name ?? "tool");
  }
  if (c?.type === "text" && typeof c.text === "string") return c.text;
  return undefined;
}

function parse(line: string): EventDelta {
  const e = parseClaudeLine(line);
  if (!e) return {};
  const d: EventDelta = { lastEvent: eventName(e) };
  const activity = claudeActivity(e);
  if (activity) d.activity = activity;
  if (typeof e.session_id === "string" && e.session_id) d.thread = e.session_id;
  if (e.type === "system" && e.subtype === "api_retry") d.retrying = true;
  if (e.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected") d.limit = true;
  // each assistant message of the main thread carries its own request's usage; `result` sums the session
  if (e.type === "assistant" && !e.parent_tool_use_id && e.message?.usage)
    d.requestInput = claudeTokens(e.message.usage).input;
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
  install: "npm i -g @anthropic-ai/claude-code",
  probe,
  listModels: () => listClaudeModels(),
  prepare,
  plan,
  parse,
  finalize,
  enforcement: { "read-only": "advisory", "workspace-write": "advisory", full: "advisory" },
  errors: { limit: CLAUDE_LIMIT, tooOld: CLAUDE_TOO_OLD },
  resume: { supported: true, sameAccessOnly: false, threadPattern: THREAD },
  accessShell,
  // the `result` event is the last thing claude prints; a CLI still running 30 s later is stuck
  graceAfterFinalMs: 30_000,
  reportsCost: true,
};
