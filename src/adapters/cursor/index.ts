import { realpathSync } from "node:fs";
import { CatherdError } from "../../domain/errors.ts";
import type { Rung } from "../../domain/ids.ts";
import type { Access, RunStatus } from "../../domain/record.ts";
import { scratchShell } from "../access.ts";
import {
  type AccessShell,
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
  CURSOR_LIMIT,
  CURSOR_TOO_OLD,
  cursorActivity,
  cursorTokens,
  eventName,
  foldCursorEvents,
  isAuthFailure,
  isLimit,
  isTooOld,
  parseCursorLine,
} from "./events.ts";
import { cursorHomeEnv, prepareCursorHome } from "./home.ts";
import { cursorSlug, parseCursorModels } from "./models.ts";

export { isolatedCursorHome, isolatedCursorRoot } from "./home.ts";

/** Spec 1.3 §4.1: the version whose help and bundle were read; 2026.06.04 lacks `--add-dir` and more. */
export const CURSOR_MIN_VERSION = "2026.09.28";
export const CURSOR_INSTALL = "curl https://cursor.com/install -fsS | bash";
const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Cursor's versions are a date and a hash (`2026.09.28-64d2043`); grok's `agent` prints `grok 1.0.44 (…)`. */
const CURSOR_VERSION = /^\s*\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]+\b/;
const DAY_MS = 24 * 60 * 60_000;
const LOGIN_FIX = "cursor-agent login, or export CURSOR_API_KEY=<key>";

/** How long a `cursor-agent` query (version, models, a sandbox probe's `true`) may take before it counts as failed. */
export const cursorShell = { timeoutMs: 15_000 };

const which = (bin: string): string | null => Bun.which(bin, { PATH: process.env.PATH ?? "" });

/**
 * Spec 1.3 §4.1: `cursor-agent` first. The installers of Cursor and grok both link `agent` (research §2.1,
 * §3.1), so `agent` is taken only when `cursor-agent` is missing, and the probe checks what it is.
 */
export function cursorBin(): "cursor-agent" | "agent" {
  return which("cursor-agent") ? "cursor-agent" : "agent";
}

/**
 * Spec 1.3 §4.3. Headless without `--force` rejects every approval, and `--sandbox enabled` runs sandboxable
 * commands without one (research §2.6); `--force` turns the sandbox off, so only `full` passes it.
 */
export const CURSOR_ACCESS: Record<Access, string[]> = {
  "read-only": ["--mode", "ask", "--sandbox", "enabled"],
  "workspace-write": ["--sandbox", "enabled"],
  full: ["--force", "--sandbox", "disabled", "--approve-mcps"],
};

function plan(r: RunRequest): SpawnPlan {
  if (r.thread !== null && !THREAD.test(r.thread))
    throw new CatherdError("E_ADMIT_THREAD", `"${r.thread}" is not a Cursor chat id`, {
      fix: "pass the thread from the earlier RunRecord",
    });
  return {
    cmd: cursorBin(),
    args: [
      "-p",
      "--output-format",
      "stream-json",
      "--trust",
      "--workspace",
      r.repo,
      "--model",
      cursorSlug(r.rung.model, r.rung.effort),
      // hidden (research §2.1): no env var turns the self-update off, and it must not swap the binary mid-run
      "--disable-auto-update",
      ...CURSOR_ACCESS[r.access],
      // a resume runs in the recorded repo: Cursor looks a chat up by its cwd (research §2.5)
      ...(r.thread === null ? [] : ["--resume", r.thread]),
    ],
    env: {
      NO_OPEN_BROWSER: "1",
      ...(r.isolated ? cursorHomeEnv(r.access, r.network !== false) : {}),
    },
    cwd: r.repo,
    // research §2.2: stdin is read to EOF when no positional prompt is given
    stdinPath: r.briefPath,
  };
}

async function listModels(): Promise<DiscoveredModel[]> {
  const r = await runCli(cursorBin(), ["models"], { ...cursorShell, env: { NO_OPEN_BROWSER: "1" } });
  return r?.ok ? parseCursorModels(r.out) : [];
}

/**
 * Spec 1.3 §4.4, §4.6: an isolated run needs CURSOR_API_KEY (its HOME holds no login) and gets its home and
 * `sandbox.json`; the rung's slug must be one Cursor lists: the model with that effort suffix, or the bare slug
 * for `#default`.
 */
async function prepare(req: {
  rung: Rung;
  access: Access;
  isolated: boolean;
  network?: boolean;
}): Promise<void> {
  if (req.isolated) {
    if (!process.env.CURSOR_API_KEY)
      throw new CatherdError("E_BACKEND_NOT_LOGGED_IN", "an isolated cursor run needs CURSOR_API_KEY", {
        fix: "export CURSOR_API_KEY=<key>, or catherd profile set harness.cursor.isolated false",
      });
    prepareCursorHome(req.access, req.network !== false);
  }
  const { model, effort } = req.rung;
  const models = await discovered("cursor", listModels, { maxAgeMs: DAY_MS, need: model });
  if (models.length === 0) return; // Cursor listed nothing: let the run itself say what is wrong
  const m = models.find((x) => x.id === model);
  if (!m)
    throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", `Cursor does not list ${model}`, {
      fix: `run ${cursorBin()} models; a rung names the slug without its effort suffix`,
    });
  if (!m.efforts.includes(effort))
    throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", `Cursor lists no ${cursorSlug(model, effort)}`, {
      fix: `use one of: ${m.efforts.map((e) => `cursor:${model}#${e}`).join(", ")}`,
    });
}

function finalize(run: FinishedRun): Outcome {
  const f = foldCursorEvents(run.eventLines);
  const res = f.result;
  const stopped = run.exit.reason;
  const said = [run.stderr, res?.isError ? res.text : ""].join("\n");
  const status: RunStatus =
    stopped === "cancelled"
      ? "cancelled"
      : stopped === "idle-timeout" || stopped === "wall-timeout"
        ? "timeout"
        : res !== null && !res.isError
          ? "ok"
          : isTooOld(said)
            ? "cli-too-old"
            : isLimit(said)
              ? "limit"
              : "failed";
  const lastErr = run.stderr.trim().split("\n").at(-1) ?? "";
  const message =
    res?.isError && res.text
      ? res.text
      : isAuthFailure(lastErr)
        ? `${lastErr} (fix: ${LOGIN_FIX})`
        : lastErr || `no result event (${stopped}, exit ${run.exit.code ?? run.exit.signal})`;
  return {
    status,
    thread: f.thread ?? run.request.thread,
    tokens: res?.tokens ?? cursorTokens(undefined),
    costUsd: null,
    images: [],
    error: status === "ok" ? null : { code: status, message },
    ...(status === "ok" ? { reply: f.reply ?? res?.text ?? "" } : {}),
  };
}

function parse(line: string): EventDelta {
  const e = parseCursorLine(line);
  if (!e) return {};
  const d: EventDelta = { lastEvent: eventName(e) };
  const activity = cursorActivity(e);
  if (activity) d.activity = activity;
  if (typeof e.session_id === "string" && e.session_id) d.thread = e.session_id;
  if (e.type === "retry" && e.subtype === "starting") d.retrying = true;
  // a tool call runs between its started and completed events, often printing nothing: the run is busy
  if (e.type === "tool_call" && typeof e.call_id === "string")
    d.item = { id: e.call_id, open: e.subtype === "started" };
  if (e.type === "result") {
    d.final = true;
    d.tokens = cursorTokens(e.usage);
    if (e.is_error === true) {
      d.failure = String(e.result ?? "error");
      if (isLimit(d.failure)) d.limit = true;
    }
  }
  return d;
}

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Spec 1.3 §4.1, §4.7. Installed: a `--version` in Cursor's date-hash form (an `agent` that prints another is
 * someone else's). Logged in: `models` answered; `status` reports token presence, not a working login
 * (research §2.9), and `models` fails fast, with no browser, when logged out. An `agent` that is another
 * program than `cursor-agent` is noted, never run.
 */
async function probe(): Promise<Probe> {
  const bin = cursorBin();
  let v: Awaited<ReturnType<typeof runCli>>;
  try {
    v = await runCli(bin, ["--version"], cursorShell);
  } catch (e) {
    // an `agent` that is not Cursor's may not even run here (the owner's is a Linux grok, research §3.1)
    if (bin === "agent") v = { ok: false, out: "", err: String(e) };
    else throw e;
  }
  if (!v || !CURSOR_VERSION.test(v.out)) {
    const says = (v?.out || v?.err || "").trim().split("\n")[0];
    return {
      installed: false,
      version: null,
      versionOk: false,
      loggedIn: null,
      problems: [
        {
          code: "E_BACKEND_MISSING",
          message: v
            ? `the ${bin} on PATH is not Cursor's CLI (it says: ${says})`
            : "cursor-agent is not on PATH",
          fix: CURSOR_INSTALL,
        },
      ],
    };
  }
  const version = extractVersion(v.out);
  const versionOk = version !== null && compareVersions(version, CURSOR_MIN_VERSION) >= 0;
  const m = await runCli(bin, ["models"], { ...cursorShell, env: { NO_OPEN_BROWSER: "1" } });
  const loggedIn = m?.ok ? true : isAuthFailure(`${m?.out ?? ""}\n${m?.err ?? ""}`) ? false : null;
  const apiKey = !!process.env.CURSOR_API_KEY;
  const problems: Probe["problems"] = [];
  if (!versionOk)
    problems.push({
      code: "E_BACKEND_TOO_OLD",
      message: `${bin} ${version ?? "?"} is older than ${CURSOR_MIN_VERSION}`,
      fix: `${bin} update`,
    });
  if (loggedIn === false)
    problems.push({
      code: "E_BACKEND_NOT_LOGGED_IN",
      message: `${bin} is not logged in (a server call says: Authentication required)`,
      fix: LOGIN_FIX,
    });
  const agent = bin === "cursor-agent" ? which("agent") : null;
  const other = agent && realOr(agent) !== realOr(which("cursor-agent") as string) ? realOr(agent) : null;
  return {
    installed: true,
    version,
    versionOk,
    loggedIn,
    ...(loggedIn ? { login: apiKey ? "API key" : "Cursor" } : {}),
    // an API key bills at API rates; a Cursor login's billing is the profile's (spec 1.3 §9 Q4)
    ...(loggedIn && apiKey ? { billing: "metered" as const } : {}),
    problems,
    ...(other
      ? {
          info: [
            {
              id: "name:agent",
              label: "agent",
              detail: `the agent on PATH (${other}) is another program than cursor-agent; catherd runs cursor-agent`,
            },
          ],
        }
      : {}),
  };
}

/** How a native worker gets what Cursor's sandbox refused: its own sandbox.json, or catherd's when isolated. */
const SANDBOX_FIXES: AccessShell["fixes"] = {
  lock: "a native Cursor worker writes only where ~/.cursor/sandbox.json or the repo's .cursor/sandbox.json lets it: add the directory to additionalReadwritePaths there, or isolate cursor (harness.cursor.isolated), whose sandbox.json catherd writes",
  temp: "add the temp dir to additionalReadwritePaths in ~/.cursor/sandbox.json, or isolate cursor",
  loopback:
    "Cursor's sandbox blocks this bind: allow it in ~/.cursor/sandbox.json's networkPolicy, or isolate cursor",
  https:
    "Cursor's sandbox reaches only the domains networkPolicy allows: add the registry to networkPolicy.allow in ~/.cursor/sandbox.json, or isolate cursor",
  docker:
    "Cursor's sandbox cannot reach the Docker socket: run the Docker checks in the verifier (full access), or give the role full access",
};

/**
 * Spec 1.3 §4.7: doctor's probes run through the hidden `cursor-agent sandbox run`, which runs a command in
 * Cursor's sandbox with no model turn (research §2.6), under the user's own sandbox policy, as a native worker
 * runs.
 */
async function accessShell(): Promise<AccessShell | string> {
  const bin = cursorBin();
  // `sandbox run` joins its args with spaces and runs the result in a shell
  const shell = scratchShell(`Cursor's sandbox (${bin} sandbox run)`, [bin, "sandbox", "run", "--"], {
    oneLine: true,
  });
  if ((await shell.run("true", []))?.ok) return { ...shell, fixes: SANDBOX_FIXES };
  shell.close();
  return `no Cursor sandbox runner here: ${bin} sandbox run (hidden) did not run \`true\``;
}

export const cursorAdapter: BackendAdapter = {
  id: "cursor",
  minVersion: CURSOR_MIN_VERSION,
  install: CURSOR_INSTALL,
  probe,
  listModels,
  prepare,
  plan,
  parse,
  finalize,
  // read-only is enforced by the kernel only in an isolated home's sandbox.json; native it is `--mode ask`
  enforcement: { "read-only": "advisory", "workspace-write": "enforced", full: "enforced" },
  errors: { limit: CURSOR_LIMIT, tooOld: CURSOR_TOO_OLD },
  // each run applies its own flags; "Resuming a conversation recomputes Run Everything" (research §2.5)
  resume: { supported: true, sameAccessOnly: false, threadPattern: THREAD },
  accessShell,
  isolationNote:
    "native Cursor loads your Claude Code hooks, skills, plugins and permission rules, and your Cursor User Rules; isolation cannot remove the User Rules",
  isolationKey: "CURSOR_API_KEY",
  // Cursor waits for background shells after its last turn, with no limit (research §2.10)
  graceAfterFinalMs: 30_000,
};
