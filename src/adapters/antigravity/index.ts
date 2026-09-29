import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CatherdError } from "../../domain/errors.ts";
import type { Rung } from "../../domain/ids.ts";
import type { Access, RunStatus } from "../../domain/record.ts";
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
import { jsonOf, runCli } from "../cli.ts";
import { discovered } from "../discovery.ts";
import {
  AGY_LIMIT,
  AGY_TOO_OLD,
  agyActivity,
  agyError,
  agyTokens,
  bodyOf,
  eventName,
  foldAgyEvents,
  isAuthFailure,
  isLimit,
  isTooOld,
  parseAgyLine,
} from "./events.ts";
import { agyHomeEnv, prepareAgyHome } from "./home.ts";
import { parseAgyModels } from "./models.ts";

export { isolatedAgyHome, isolatedAgyRoot } from "./home.ts";

/** Spec 1.3 §6.1: the version whose help, exit codes and changelog were read (research §4). */
export const AGY_MIN_VERSION = "1.2.13";
export const AGY_INSTALL =
  "curl -fsSL https://antigravity.google/cli/install.sh | bash (it installs ~/.local/bin/agy: put that dir on PATH), or brew install --cask antigravity-cli";
/** A conversation id: a UUID in the docs' examples; never flag-shaped. */
const THREAD = /^[A-Za-z0-9][\w-]{7,127}$/;
const DAY_MS = 24 * 60 * 60_000;
const LOGIN_FIX =
  "run agy once to sign in with Google, or export GEMINI_API_KEY=<key> and catherd profile set harness.antigravity.isolated true";
/** research §4.2: the background self-updater must not swap the binary under a lane (spec 1.3 §3.3) */
const ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: "true" };

/** How long an `agy` query (version, models, `/usage`) may take; `agy models` took ~10 s logged out (research §4.5). */
export const agyShell = { timeoutMs: 30_000 };

/**
 * Spec 1.3 §6.2: the fixed line `-p` carries. The brief stays in its file and argv holds only its path; agy reads
 * no stdin when a prompt comes by flag (research §4.3).
 */
export const agyPrompt = (briefPath: string): string =>
  `Read the brief in ${briefPath} and follow it. Your final message is your reply.`;

/**
 * Spec 1.3 §6.3. read-only has no flag: it runs only isolated, under deny rules in catherd's settings (§9 Q2).
 * workspace-write runs shell in agy's sandbox with every tool approved (headless soft-denies what it would ask).
 */
export const AGY_ACCESS: Record<Access, string[]> = {
  "read-only": [],
  "workspace-write": ["--sandbox", "--dangerously-skip-permissions"],
  full: ["--dangerously-skip-permissions"],
};

/**
 * Whether the last probe found agy's own login signed out (null: not probed, or it could not tell). A native run
 * then would open a browser and wait (research §4.8), so `prepare` refuses it; an isolated one signs in by key.
 */
let nativeLogin: boolean | null = null;

function plan(r: RunRequest): SpawnPlan {
  if (r.thread !== null && !THREAD.test(r.thread))
    throw new CatherdError("E_ADMIT_THREAD", `"${r.thread}" is not an agy conversation id`, {
      fix: "pass the thread from the earlier RunRecord",
    });
  const { model, effort } = r.rung;
  return {
    cmd: "agy",
    args: [
      "-p",
      agyPrompt(r.briefPath),
      "--output-format",
      "stream-json",
      "--model",
      model,
      ...(effort === "default" ? [] : ["--effort", effort]),
      "--disable-slash-commands",
      ...AGY_ACCESS[r.access],
      // conversations are scoped by cwd: a resume runs in the recorded repo (research §4.6)
      ...(r.thread === null ? [] : ["--conversation", r.thread]),
    ],
    env: { ...ENV, ...(r.isolated ? agyHomeEnv(r.access, r.network !== false) : {}) },
    cwd: r.repo,
    stdinPath: null,
  };
}

async function listModels(): Promise<DiscoveredModel[]> {
  const r = await runCli("agy", ["models"], { ...agyShell, env: ENV });
  return r?.ok ? parseAgyModels(r.out) : [];
}

/**
 * Spec 1.3 §6.3, §6.4, §9 Q2: read-only runs only isolated; an isolated run needs GEMINI_API_KEY and gets its
 * home and settings; a native one needs agy's own login; the rung's model and effort must be ones agy lists.
 */
async function prepare(req: {
  rung: Rung;
  access: Access;
  isolated: boolean;
  network?: boolean;
}): Promise<void> {
  if (!req.isolated && req.access === "read-only")
    throw new CatherdError("E_ADMIT_RUNG", "native agy has no read-only mode", {
      fix: "catherd profile set harness.antigravity.isolated true (it needs GEMINI_API_KEY), or put this role on another backend",
    });
  if (req.isolated) {
    if (!process.env.GEMINI_API_KEY)
      throw new CatherdError("E_BACKEND_NOT_LOGGED_IN", "an isolated antigravity run needs GEMINI_API_KEY", {
        fix: "export GEMINI_API_KEY=<key>, or catherd profile set harness.antigravity.isolated false",
      });
    prepareAgyHome(req.access, req.network !== false);
  } else if (nativeLogin !== true)
    // spec 1.3 §6.1: fail closed; agy models failing some other way (a timeout, reworded output) is no proof
    throw new CatherdError(
      "E_BACKEND_NOT_LOGGED_IN",
      nativeLogin === false
        ? "agy is not signed in: a native run would open a browser"
        : "catherd could not confirm agy is signed in (agy models failed), and a signed-out native run opens a browser",
      { fix: LOGIN_FIX },
    );
  const { model, effort } = req.rung;
  const models = await discovered("antigravity", listModels, { maxAgeMs: DAY_MS, need: model });
  if (models.length === 0) return; // agy listed nothing: let the run itself say what is wrong
  const m = models.find((x) => x.id === model);
  if (!m)
    throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", `agy does not list ${model}`, {
      fix: "run agy models; a rung names the model without its effort suffix",
    });
  if (!m.efforts.includes(effort))
    throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", `agy lists no ${model} at effort ${effort}`, {
      fix: `use one of: ${m.efforts.map((e) => `antigravity:${model}#${e}`).join(", ")}`,
    });
}

function finalize(run: FinishedRun): Outcome {
  const f = foldAgyEvents(run.eventLines);
  const res = f.result;
  const stopped = run.exit.reason;
  const err = agyError(run.stderr);
  const stderrLines = run.stderr.trim().split("\n").filter(Boolean);
  const status: RunStatus =
    stopped === "cancelled"
      ? "cancelled"
      : stopped === "idle-timeout" || stopped === "wall-timeout"
        ? "timeout"
        : res?.status === "SUCCESS"
          ? "ok"
          : res?.status === "CANCELED" || res?.status === "INTERRUPTED"
            ? "cancelled"
            : run.exit.code === 2 || isTooOld(run.stderr)
              ? "cli-too-old"
              : isLimit(`${err?.text ?? ""}\n${res?.error ?? ""}`)
                ? "limit"
                : "failed";
  const message =
    res?.error && isAuthFailure(res.error)
      ? `${res.error} (fix: ${LOGIN_FIX})`
      : (err?.message ??
        stderrLines.find(isTooOld) ??
        (res?.error ||
          (res && res.status !== "SUCCESS" ? `agy ended the run ${res.status}` : "") ||
          stderrLines.at(-1) ||
          `no result event (${stopped}, exit ${run.exit.code ?? run.exit.signal})`));
  return {
    status,
    thread: f.thread ?? run.request.thread,
    tokens: res?.tokens ?? agyTokens(undefined),
    costUsd: null,
    images: [],
    error: status === "ok" ? null : { code: status, message },
    ...(status === "ok" ? { reply: res?.response ?? "" } : {}),
  };
}

function parse(line: string): EventDelta {
  const e = parseAgyLine(line);
  if (!e) return {};
  const b = bodyOf(e);
  const d: EventDelta = { lastEvent: eventName(e) };
  const activity = agyActivity(e);
  if (activity) d.activity = activity;
  if (typeof b.conversation_id === "string" && b.conversation_id) d.thread = b.conversation_id;
  if (e.event === "step_update") {
    if (b.usage) d.requestInput = agyTokens(b.usage).input;
    // a tool step runs between ACTIVE and DONE, often printing nothing: the run is busy
    if (b.step_type === "tool" && typeof b.step_index === "number")
      d.item = { id: `step-${b.step_index}`, open: b.state === "ACTIVE" };
  }
  if (e.event === "result") {
    d.final = true;
    d.tokens = agyTokens(b.usage);
    if (b.status !== "SUCCESS") {
      d.failure = String(b.error || b.status || "error");
      if (isLimit(d.failure)) d.limit = true;
    }
  }
  return d;
}

/** The user's own agy settings (read, never written: the desktop app shares them, spec 1.3 §9 Q3). */
function userSettings(): Record<string, unknown> | null {
  const file = join(process.env.HOME || homedir(), ".gemini", "antigravity-cli", "settings.json");
  if (!existsSync(file)) return null;
  const j = jsonOf(readFileSync(file, "utf8"));
  return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
}

/**
 * Spec 1.3 §6.1, §3.3. Logged in: `agy models` answered. It fails fast when logged out, where `agy -p` would open
 * a browser and wait (research §4.5, §4.8), so the probe never runs `-p`. Logged out is a problem unless
 * GEMINI_API_KEY is set, which an isolated run signs in with; `prepare` then refuses the native runs.
 */
async function probe(): Promise<Probe> {
  const v = await runCli("agy", ["--version"], { ...agyShell, env: ENV });
  if (!v)
    return {
      installed: false,
      version: null,
      versionOk: false,
      loggedIn: null,
      problems: [{ code: "E_BACKEND_MISSING", message: "agy is not on PATH", fix: AGY_INSTALL }],
    };
  const version = extractVersion(v.out);
  const versionOk = version !== null && compareVersions(version, AGY_MIN_VERSION) >= 0;
  const m = await runCli("agy", ["models"], { ...agyShell, env: ENV });
  nativeLogin = m?.ok ? true : isAuthFailure(`${m?.out ?? ""}\n${m?.err ?? ""}`) ? false : null;
  // research §4.8: GEMINI_API_KEY signs agy in only with modelProvider "gemini" in its settings
  const byKey =
    nativeLogin === true && userSettings()?.modelProvider === "gemini" && !!process.env.GEMINI_API_KEY;
  const problems: Probe["problems"] = [];
  if (!versionOk)
    problems.push({
      code: "E_BACKEND_TOO_OLD",
      message: `agy ${version ?? "?"} is older than ${AGY_MIN_VERSION}`,
      fix: "brew upgrade --cask antigravity-cli, or run the install script again",
    });
  if (nativeLogin === false && !process.env.GEMINI_API_KEY)
    problems.push({
      code: "E_BACKEND_NOT_LOGGED_IN",
      message: "agy is not signed in (agy models says: Please sign in)",
      fix: LOGIN_FIX,
    });
  return {
    installed: true,
    version,
    versionOk,
    loggedIn: nativeLogin,
    // spec 1.3 §9 Q4: a Google login draws on the plan's quota; the key bills the Gemini API project
    ...(nativeLogin
      ? {
          login: byKey ? "API key" : "Google",
          billing: byKey ? ("metered" as const) : ("subscription" as const),
        }
      : {}),
    problems,
  };
}

/**
 * Spec 1.3 §6.6: `agy -p "/usage" --output-format json` answers without an agent turn (research §4.8; unverified
 * live). Doctor calls it only when the probe found agy logged in. The reply's lines, joined; null when it fails.
 */
async function quota(): Promise<string | null> {
  const r = await runCli("agy", ["-p", "/usage", "--output-format", "json"], { ...agyShell, env: ENV });
  if (!r?.ok) return null;
  const j = jsonOf(r.out) as Record<string, unknown> | null;
  const text = typeof j?.response === "string" ? j.response : r.out;
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" · ")
      .slice(0, 200) || null
  );
}

export const antigravityAdapter: BackendAdapter = {
  id: "antigravity",
  minVersion: AGY_MIN_VERSION,
  install: AGY_INSTALL,
  probe,
  listModels,
  prepare,
  plan,
  parse,
  finalize,
  // read-only: deny rules in catherd's settings, never a flag; workspace-write: shell in the sandbox, but the file
  // tools, every one approved, are not confined by it (research §4.7)
  enforcement: { "read-only": "advisory", "workspace-write": "advisory", full: "enforced" },
  errors: { limit: AGY_LIMIT, tooOld: AGY_TOO_OLD },
  // until the live kit shows a resume takes the new run's permissions (research §4.6)
  resume: { supported: true, sameAccessOnly: true, threadPattern: THREAD },
  isolationNote:
    "native Antigravity shares its settings and permission rules with the Antigravity desktop app",
  isolationKey: "GEMINI_API_KEY",
  isolatedOnly: ["read-only"],
  quota,
  // agy leaves daemon background tasks (dev servers) running after its result (research §4.4)
  graceAfterFinalMs: 30_000,
};
