import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CatherdError } from "../../domain/errors.ts";
import type { Access, RunStatus } from "../../domain/record.ts";
import {
  type AccessShell,
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
import { type CliResult, runCli } from "../cli.ts";
import { scratchShell, writableRoots } from "../access.ts";
import { CODEX_LIMIT, CODEX_TOO_OLD, foldCodexEvents, parseCodexLine } from "./events.ts";

/** The item types that are a tool call running, as the idle watchdog counts them. */
const CODEX_TOOL_ITEMS = new Set(["command_execution", "mcp_tool_call", "web_search", "file_change"]);
import { generatedImages, isolatedCodexHome, isolatedCodexHomePath, userCodexHome } from "./home.ts";

const CODEX_MIN_VERSION = "0.157.0";
const THREAD = /^[A-Za-z0-9][A-Za-z0-9-]{3,127}$/;

const SANDBOX: Record<Access, string> = {
  "read-only": "read-only",
  "workspace-write": "workspace-write",
  full: "danger-full-access",
};

/**
 * The `writable_roots` the user's Codex config lists under its top-level `[sandbox_workspace_write]`
 * (`$CODEX_HOME/config.toml`). A `-c` override replaces that array, so catherd passes the union. A
 * `--profile`'s or a managed requirements file's roots are not read. Unreadable or absent: none.
 */
export function userWritableRoots(): string[] {
  const file = join(userCodexHome(), "config.toml");
  if (!existsSync(file)) return [];
  try {
    const roots = (Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
      .sandbox_workspace_write as { writable_roots?: unknown } | undefined;
    const list = roots?.writable_roots;
    return Array.isArray(list) ? list.filter((r): r is string => typeof r === "string" && r !== "") : [];
  } catch {
    // a config Codex cannot parse either: Codex reports it on the run itself
    return [];
  }
}

/**
 * Spec §5: a workspace-write worker also writes the lock and temp dirs, and (unless the role says
 * `network: false`) reaches the network and binds loopback. `network_access` is always set, to false for
 * `network: false`, since leaving it out would keep a `network_access = true` from the user's config.toml.
 * The same `-c` overrides go to `codex sandbox` in doctor's probes, so doctor tests exactly what a worker gets. `-c …writable_roots=` replaces the
 * user's own roots, so theirs go in too; an isolated run ignores the user's config, so it has none.
 */
export function codexGrants(access: Access, network = true, isolated = false): string[] {
  if (access !== "workspace-write") return [];
  const roots = [...new Set([...(isolated ? [] : userWritableRoots()), ...writableRoots()])];
  return [
    "-c",
    `sandbox_workspace_write.network_access=${network}`,
    "-c",
    `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
  ];
}

/** How long a `codex` query (version, login, models) may take before it counts as failed. */
export const codexShell = { timeoutMs: 15_000 };

/** Runs `codex <args>` without catherd's secrets; a run past the timeout is killed and counts as failed. */
const sh = (args: string[], cwd?: string): Promise<CliResult | null> =>
  runCli("codex", args, { timeoutMs: codexShell.timeoutMs, cwd });

function plan(r: RunRequest): SpawnPlan {
  if (r.thread !== null && !THREAD.test(r.thread))
    throw new CatherdError("E_ADMIT_THREAD", `"${r.thread}" is not a Codex thread id`, {
      fix: "pass the thread from the earlier RunRecord",
    });
  const common = [
    ...(r.isolated ? ["--ignore-user-config"] : []),
    "-m",
    r.rung.model,
    // "default" leaves the effort to Codex's own config (spec §5.1)
    ...(r.rung.effort === "default" ? [] : ["-c", `model_reasoning_effort=${r.rung.effort}`]),
    "--json",
    "-o",
    r.replyPath,
    ...codexGrants(r.access, r.network, r.isolated),
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
  const home = run.request.isolated ? isolatedCodexHomePath() : userCodexHome();
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
  const v = await sh(["--version"]);
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
  const status = await sh(["login", "status"]);
  const loggedIn = status?.ok ?? false;
  // how: `Logged in using ChatGPT`, or `… using an API key - <masked key>` (read, never kept); on stdout
  // or stderr, depending on the version
  const how = `${status?.out ?? ""}\n${status?.err ?? ""}`;
  const login = !loggedIn
    ? null
    : /using ChatGPT/i.test(how)
      ? "ChatGPT"
      : /API key/i.test(how)
        ? "API key"
        : null;
  const problems: Probe["problems"] = [];
  if (!versionOk)
    problems.push({
      code: "E_BACKEND_TOO_OLD",
      message: `codex ${version ?? "?"} is older than ${CODEX_MIN_VERSION}`,
      fix: "npm i -g @openai/codex@latest",
    });
  if (!loggedIn)
    problems.push({ code: "E_BACKEND_NOT_LOGGED_IN", message: "codex is not logged in", fix: "codex login" });
  return {
    installed: true,
    version,
    versionOk,
    loggedIn,
    ...(login ? { login, billing: login === "ChatGPT" ? "chatgpt-plan" : "metered" } : {}),
    problems,
  };
}

async function listModels(): Promise<DiscoveredModel[]> {
  const r = await sh(["debug", "models"]);
  const raw = r?.ok ? r.out : ((await sh(["debug", "models", "--bundled"]))?.out ?? "");
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

/**
 * Spec §12: `codex sandbox [-c …] -- <cmd>` in the workspace-write sandbox with the grants a worker gets
 * (codexGrants), else the old `codex sandbox <os> --full-auto` form. Each form is tried with `true` first;
 * a string says why neither runs here.
 */
async function accessShell(o: { network: boolean }): Promise<AccessShell | string> {
  const grants = codexGrants("workspace-write", o.network);
  const os = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : null;
  const forms: [string, string[]][] = [
    ["codex sandbox", ["codex", "sandbox", "-c", "sandbox_mode=workspace-write", ...grants, "--"]],
    ...(os
      ? [
          [
            `codex sandbox ${os} --full-auto (the old form)`,
            ["codex", "sandbox", os, "--full-auto", ...grants, "--"],
          ],
        ]
      : []),
  ] as [string, string[]][];
  for (const [how, prefix] of forms) {
    const shell = scratchShell(how, prefix);
    if ((await shell.run("true", []))?.ok) return shell;
    shell.close();
  }
  return "no codex sandbox to test with on this machine (codex sandbox did not run `true`)";
}

/** Spec §3.7: a command Codex runs, the files it changes, or its message. */
function codexActivity(e: Record<string, any>): string | undefined {
  const it = e.item;
  if (!it || (e.type !== "item.started" && e.type !== "item.completed")) return undefined;
  if (it.type === "command_execution" && typeof it.command === "string") return `$ ${it.command}`;
  if (it.type === "file_change" && Array.isArray(it.changes))
    return `edit ${it.changes
      .map((c: { path?: unknown }) => c.path)
      .filter((p: unknown) => typeof p === "string")
      .join(", ")}`;
  if (it.type === "agent_message" && typeof it.text === "string") return it.text;
  return undefined;
}

export const codexAdapter: BackendAdapter = {
  id: "codex",
  minVersion: CODEX_MIN_VERSION,
  install: "npm i -g @openai/codex",
  probe,
  listModels,
  plan,
  parse(line) {
    const e = parseCodexLine(line);
    if (!e) return {};
    const f = foldCodexEvents([line]);
    // a tool call runs between item.started and item.completed, often printing nothing: the run is busy.
    // Not a todo_list: update_plan opens one that only completes with the turn, and would mute the watchdog
    const id = typeof e.item?.id === "string" && CODEX_TOOL_ITEMS.has(e.item.type) ? e.item.id : null;
    const open = e.type === "item.started" ? true : e.type === "item.completed" ? false : null;
    return {
      ...(f.thread ? { thread: f.thread } : {}),
      ...(id !== null && open !== null ? { item: { id, open } } : {}),
      ...(e.type === "turn.completed" ? { tokens: f.tokens } : {}),
      lastEvent: f.lastEvent ?? undefined,
      ...(codexActivity(e) ? { activity: codexActivity(e) } : {}),
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
  accessShell,
};
