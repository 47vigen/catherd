import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CatherdError } from "../../domain/errors.ts";
import type { Rung } from "../../domain/ids.ts";
import type { Access, RunStatus } from "../../domain/record.ts";
import { assetPath } from "../../infra/assets.ts";
import { ensurePrivateDir } from "../../infra/store.ts";
import { realTmpdir } from "../access.ts";
import {
  type BackendAdapter,
  compareVersions,
  type DiscoveredModel,
  type EventDelta,
  extractVersion,
  type FinishedRun,
  type Outcome,
  type Probe,
  type RunRequest,
  type SpawnPlan,
} from "../backend.ts";
import { runCli } from "../cli.ts";
import { discovered } from "../discovery.ts";
import {
  eventName,
  foldGrokEvents,
  GROK_LIMIT,
  GROK_TOO_OLD,
  grokActivity,
  grokTokens,
  isAuthFailure,
  isLimit,
  isTooOld,
  parseGrokLine,
} from "./events.ts";
import {
  grokAccess,
  grokHomeEnv,
  isolatedGrokRoot,
  readOnlyRefused,
  userGrokHome,
  writeGrokProfiles,
} from "./home.ts";
import { parseGrokModels, type ShippedGrok } from "./models.ts";

export { isolatedGrokRoot } from "./home.ts";

/** Spec 1.3 §5.1: the version whose help, docs and argument checks were read (research §3). */
export const GROK_MIN_VERSION = "1.0.44";
export const GROK_INSTALL = "curl -fsSL https://x.ai/cli/install.sh | bash";
const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60_000;
const LOGIN_FIX = "grok login, or grok login --device-code without a browser, or export XAI_API_KEY=<key>";
/** research §3.1 [doc 14]: grok never updates itself under a worker or a probe */
const NO_UPDATE = { GROK_DISABLE_AUTOUPDATER: "1" };

/** How long a `grok` query (version, models, the sandbox check) may take before it counts as failed. */
export const grokShell = { timeoutMs: 15_000 };

function plan(r: RunRequest): SpawnPlan {
  if (r.thread !== null && !THREAD.test(r.thread))
    throw new CatherdError("E_ADMIT_THREAD", `"${r.thread}" is not a grok session id`, {
      fix: "pass the thread from the earlier RunRecord",
    });
  const access = grokAccess(r.access, r.network !== false);
  return {
    cmd: "grok",
    args: [
      // headless grok never reads stdin (research §3.2 [doc 14]): the brief goes by file
      "--prompt-file",
      r.briefPath,
      "--output-format",
      "streaming-json",
      "--cwd",
      r.repo,
      "-m",
      r.rung.model,
      ...(r.rung.effort === "default" ? [] : ["--effort", r.rung.effort]),
      // hidden (research §3.2 [run]): trust for this session, no self-update, no memory (spec 1.3 §9 Q8)
      "--always-approve",
      "--trust",
      "--no-auto-update",
      "--no-memory",
      // a fresh session takes catherd's id; a resumed one keeps the profile it started with and refuses
      // another (research §3.5), while a tool filter is no profile: a read-only role keeps its read tools
      ...(r.thread === null
        ? [...access, "-s", crypto.randomUUID()]
        : [...(access.includes("--tools") ? access.slice(-2) : []), "-r", r.thread]),
    ],
    env: { ...NO_UPDATE, ...(r.isolated ? grokHomeEnv() : {}) },
    cwd: r.repo,
    stdinPath: null,
  };
}

/** The catalog's grok models (`on.grok`): grok lists no efforts (research §3.4), the catalog does. */
let shipped: ShippedGrok | null = null;
function shippedOnGrok(): ShippedGrok {
  if (shipped) return shipped;
  const doc = JSON.parse(readFileSync(assetPath("catalog/models.json"), "utf8")) as {
    families: { on: Record<string, { id: string; efforts: string[]; context?: number } | undefined> }[];
  };
  shipped = {};
  for (const f of doc.families)
    if (f.on.grok) shipped[f.on.grok.id] = { efforts: f.on.grok.efforts, context: f.on.grok.context ?? null };
  return shipped;
}

async function listModels(): Promise<DiscoveredModel[]> {
  const r = await runCli("grok", ["models"], { ...grokShell, env: NO_UPDATE });
  return r?.ok ? parseGrokModels(r.out, shippedOnGrok()).models : [];
}

/**
 * Spec 1.3 §5.3–§5.4: an isolated run needs XAI_API_KEY (its home holds no login, and the user's auth.json is
 * never copied: its refresh token rotates, research §3.9); a workspace-write run needs catherd-ws in the
 * sandbox.toml of the GROK_HOME it runs with; the model must be one grok lists, at an effort the catalog offers.
 */
async function prepare(req: {
  rung: Rung;
  access: Access;
  isolated: boolean;
  repo: string;
  network?: boolean;
}): Promise<void> {
  if (req.isolated && !process.env.XAI_API_KEY)
    throw new CatherdError("E_BACKEND_NOT_LOGGED_IN", "an isolated grok run needs XAI_API_KEY", {
      fix: "export XAI_API_KEY=<key>, or catherd profile set harness.grok.isolated false",
    });
  const home = req.isolated ? join(isolatedGrokRoot(), ".grok") : userGrokHome();
  if (req.isolated) ensurePrivateDir(home);
  if (req.access === "workspace-write") writeGrokProfiles(home);
  const { model, effort } = req.rung;
  const models = await discovered("grok", listModels, { maxAgeMs: DAY_MS, need: model });
  if (models.length === 0) return; // grok listed nothing: let the run itself say what is wrong
  const m = models.find((x) => x.id === model);
  if (!m)
    throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", `grok does not list ${model}`, {
      fix: "run grok models, and use a model it lists",
    });
  if (effort !== "default" && m.efforts.length > 0 && !m.efforts.includes(effort))
    throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", `${model} has no effort "${effort}" on grok`, {
      fix: `use one of: ${["default", ...m.efforts].map((e) => `grok:${model}#${e}`).join(", ")}`,
    });
}

function finalize(run: FinishedRun): Outcome {
  const f = foldGrokEvents(run.eventLines);
  const stopped = run.exit.reason;
  const said = f.error ?? run.stderr;
  const status: RunStatus =
    stopped === "cancelled"
      ? "cancelled"
      : stopped === "idle-timeout" || stopped === "wall-timeout"
        ? "timeout"
        : f.end?.stopReason === "end_turn"
          ? "ok"
          : f.end
            ? "failed"
            : run.exit.code === 2 || isTooOld(run.stderr)
              ? "cli-too-old"
              : isLimit(said)
                ? "limit"
                : "failed";
  const errLines = run.stderr.trim().split("\n");
  // clap's usage lines follow its error: the error line says what went wrong
  const lastErr = errLines.find((l) => isTooOld(l)) ?? errLines.at(-1) ?? "";
  const message = f.end
    ? `stopped: ${f.end.stopReason}`
    : isAuthFailure(said)
      ? `grok is not signed in (fix: ${LOGIN_FIX})`
      : f.error || lastErr || `no end event (${stopped}, exit ${run.exit.code ?? run.exit.signal})`;
  return {
    status,
    thread: f.end?.thread ?? run.request.thread,
    tokens: f.end?.tokens ?? f.used,
    costUsd: f.end?.costUsd ?? null,
    images: [],
    error: status === "ok" ? null : { code: status, message },
    ...(status === "ok" ? { reply: f.reply } : {}),
  };
}

function parse(line: string): EventDelta {
  const e = parseGrokLine(line);
  if (!e) return {};
  const d: EventDelta = { lastEvent: eventName(e) };
  const activity = grokActivity(e);
  if (activity) d.activity = activity;
  // a tool call runs from its tool_call until an update leaves in_progress, often printing nothing: busy
  if ((e.type === "tool_call" || e.type === "tool_call_update") && typeof e.toolCallId === "string")
    d.item = { id: e.toolCallId, open: e.type === "tool_call" || e.status === "in_progress" };
  // one usage event per model response (research §3.3): the input that response read
  if (e.type === "usage") d.requestInput = grokTokens(e.usage).input;
  if (e.type === "end") {
    d.final = true;
    d.tokens = grokTokens(e.usage);
    if (typeof e.sessionId === "string" && e.sessionId) d.thread = e.sessionId;
    if (typeof e.total_cost_usd === "number") d.costUsd = e.total_cost_usd;
    if (e.stopReason !== "end_turn") d.failure = `stopped: ${e.stopReason}`;
  }
  // research §3.3 [run]: a run that cannot go on prints an error and no end
  if (e.type === "error") {
    d.final = true;
    d.failure = String(e.message ?? "error");
    if (isLimit(d.failure)) d.limit = true;
  }
  return d;
}

/**
 * Spec 1.3 §5.6: doctor's `sandbox:grok` row, from a run that spends no turn: grok applies its sandbox before it
 * checks the login (research §3.6 [run]), so from an empty GROK_HOME with no API key the run stops at the
 * refusal when read-only cannot apply here, else at "Not signed in".
 */
async function sandboxInfo(): Promise<{ id: string; label: string; detail: string } | null> {
  const home = mkdtempSync(join(realTmpdir(), "catherd-grok-check-"));
  try {
    const r = await runCli(
      "grok",
      ["-p", "hi", "--output-format", "streaming-json", "--sandbox", "read-only", "--no-auto-update"],
      { ...grokShell, env: { ...NO_UPDATE, GROK_HOME: home, XAI_API_KEY: "" } },
    );
    if (!r) return null;
    const refused = /could not apply the '?read-only'? sandbox profile/.test(r.err);
    const why = r.err
      .split("\n")
      .find((l) => l.startsWith("warning: "))
      ?.slice("warning: ".length);
    const detail = !refused
      ? "grok's read-only profile applies here; catherd runs a read-only role in it (enforced)"
      : `grok refuses its read-only profile here${why ? ` (${why})` : ""}; ${
          readOnlyRefused()
            ? "catherd runs a read-only role in the workspace profile with the read tools only (advisory)"
            : "a read-only grok role fails here: give it another backend or full access"
        }`;
    return { id: "sandbox:grok", label: "grok sandbox", detail };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Spec 1.3 §5.1, §5.6. Logged in: the first line of `grok models`, which answers fast, with no browser, when
 * logged out (research §3.4 [run]); a Grok login bills the subscription, an API key per token. A grok the OS
 * cannot execute (a Linux build on macOS, research §3.1) throws here, and probeBackend reports it.
 */
async function probe(): Promise<Probe> {
  const v = await runCli("grok", ["--version"], { ...grokShell, env: NO_UPDATE });
  if (!v)
    return {
      installed: false,
      version: null,
      versionOk: false,
      loggedIn: null,
      problems: [{ code: "E_BACKEND_MISSING", message: "grok is not on PATH", fix: GROK_INSTALL }],
    };
  const version = extractVersion(v.out);
  const versionOk = version !== null && compareVersions(version, GROK_MIN_VERSION) >= 0;
  const m = await runCli("grok", ["models"], { ...grokShell, env: NO_UPDATE });
  const { loggedIn, login } = parseGrokModels(`${m?.out ?? ""}\n${m?.err ?? ""}`);
  const problems: Probe["problems"] = [];
  if (!versionOk)
    problems.push({
      code: "E_BACKEND_TOO_OLD",
      message: `grok ${version ?? "?"} is older than ${GROK_MIN_VERSION}`,
      fix: "grok update --stable",
    });
  if (loggedIn === false)
    problems.push({
      code: "E_BACKEND_NOT_LOGGED_IN",
      message: "grok is not logged in (grok models says: You are not authenticated.)",
      fix: LOGIN_FIX,
    });
  const info = await sandboxInfo();
  return {
    installed: true,
    version,
    versionOk,
    loggedIn,
    ...(login
      ? { login, billing: login === "API key" ? ("metered" as const) : ("subscription" as const) }
      : {}),
    problems,
    ...(info ? { info: [info] } : {}),
  };
}

export const grokAdapter: BackendAdapter = {
  id: "grok",
  minVersion: GROK_MIN_VERSION,
  install: GROK_INSTALL,
  probe,
  listModels,
  prepare,
  plan,
  parse,
  finalize,
  // spec 1.3 §5.3: the kernel holds each profile, except read-only where only a tool allowlist can (a Mac with a
  // symlinked docker socket); on macOS no profile controls the network
  enforcement: {
    get "read-only"() {
      return readOnlyRefused() ? "advisory" : "enforced";
    },
    "workspace-write": "enforced",
    full: "enforced",
  },
  errors: { limit: GROK_LIMIT, tooOld: GROK_TOO_OLD },
  // a session keeps the sandbox profile it started with and refuses another (research §3.5)
  resume: { supported: true, sameAccessOnly: true, threadPattern: THREAD },
  isolationNote:
    "native grok loads your Claude Code plugins, agents, skills, hooks and permission rules, and your Cursor rules and MCP",
  isolationKey: "XAI_API_KEY",
  // a one-shot run may drain uploads for ~150 s after end (research §3.3); the record is complete at end
  graceAfterFinalMs: 30_000,
};
