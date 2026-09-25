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
import { discovered, readDiscovery } from "../discovery.ts";
import { installAgents, isolatedConfigRoot, OPENCODE_AGENT, userConfigRoot } from "./agents.ts";
import {
  eventName,
  foldOpencodeEvents,
  isV1Error,
  OPENCODE_LIMIT,
  OPENCODE_LIMIT_TYPES,
  OPENCODE_TOO_OLD,
  opencodeTokens,
  parseOpencodeLine,
} from "./events.ts";

/** Spec §6.3: v2 only (`@opencode/cli` 2.0.16 or newer). */
export const OPENCODE_MIN_VERSION = "2.0.16";
export const OPENCODE_INSTALL = "curl -fsSL https://opencode.ai/v2/install | bash";
/** Spec §6.3: discovery is limited to OpenCode Zen and Go. */
export const OPENCODE_PROVIDERS = ["opencode", "opencode-go"];
const THREAD = /^ses_[A-Za-z0-9]{20,40}$/;
const DAY_MS = 24 * 60 * 60_000;

/** Limits for `opencode` queries; tests shorten them. */
export const opencodeShell = { timeoutMs: 15_000, retryDelayMs: 1_500 };

/** `opencode api <method> <path>`: the JSON the service answered, or null when it failed or said nothing. */
export async function opencodeApi(method: "GET" | "POST", path: string): Promise<Record<string, any> | null> {
  const r = await runCli("opencode", ["api", method, path], opencodeShell);
  const j = r?.ok ? jsonOf(r.out) : null;
  return j && typeof j === "object" ? (j as Record<string, any>) : null;
}

function plan(r: RunRequest): SpawnPlan {
  if (r.thread !== null && !THREAD.test(r.thread))
    throw new CatherdError("E_ADMIT_THREAD", `"${r.thread}" is not an opencode session id`, {
      fix: "pass the thread from the earlier RunRecord",
    });
  return {
    cmd: "opencode",
    args: [
      "run",
      "--format",
      "json",
      "--auto",
      "--agent",
      OPENCODE_AGENT[r.access],
      "-m",
      // "default" means the model's own default variant: no `#` (spec §5.1)
      r.rung.effort === "default" ? r.rung.model : `${r.rung.model}#${r.rung.effort}`,
      // v2's background service ignores the client's config env; a standalone server reads it
      ...(r.isolated ? ["--standalone"] : []),
      ...(r.thread === null ? [] : ["-s", r.thread]),
    ],
    env: r.isolated ? { XDG_CONFIG_HOME: isolatedConfigRoot() } : {},
    cwd: r.repo,
    stdinPath: r.briefPath,
  };
}

async function listModels(): Promise<DiscoveredModel[]> {
  let data: Record<string, any>[] = [];
  for (let attempt = 0; attempt < 2 && data.length === 0; attempt++) {
    // the first listing after the service (re)starts can be empty (research §1.4)
    if (attempt > 0) await Bun.sleep(opencodeShell.retryDelayMs);
    const r = await opencodeApi("GET", "/api/model");
    data = Array.isArray(r?.data) ? r.data : [];
  }
  return data
    .filter(
      (m) => OPENCODE_PROVIDERS.includes(m.providerID) && m.enabled !== false && typeof m.id === "string",
    )
    .map((m) => ({
      id: `${m.providerID}/${m.id}`,
      efforts: ((m.variants ?? []) as { id?: unknown }[])
        .map((v) => v.id)
        .filter((v): v is string => typeof v === "string"),
      context: typeof m.limit?.context === "number" ? m.limit.context : null,
      imageIn: Array.isArray(m.capabilities?.input) && m.capabilities.input.includes("image"),
    }));
}

/** Spec §6.3: install the catherd agents, and refuse a Zen or Go model or variant opencode does not list. */
async function prepare(req: { rung: Rung; access: Access; isolated: boolean }): Promise<void> {
  const root = req.isolated ? isolatedConfigRoot() : userConfigRoot();
  // the background service only sees a new agent file after a reload (verified on 2.0.16)
  if (installAgents(root) && !req.isolated) await runCli("opencode", ["reload"], opencodeShell);
  const { model, effort } = req.rung;
  if (!OPENCODE_PROVIDERS.includes(model.split("/")[0] ?? "")) return;
  const models = await discovered("opencode", listModels, { maxAgeMs: DAY_MS, need: model });
  if (models.length === 0) return; // opencode listed nothing: let the run itself say what is wrong
  const m = models.find((x) => x.id === model);
  if (!m)
    throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", `opencode does not list ${model}`, {
      fix: model.startsWith("opencode-go/")
        ? "subscribe to OpenCode Go and run: opencode auth login opencode-go --method key"
        : "run: opencode auth login opencode --method key, or pick a model catalog_query lists",
    });
  if (effort !== "default" && !m.efforts.includes(effort))
    throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", `${model} has no variant "${effort}"`, {
      fix: `use one of: ${["default", ...m.efforts].join(", ")}`,
    });
}

function finalize(run: FinishedRun): Outcome {
  const f = foldOpencodeEvents(run.eventLines);
  const stopped = run.exit.reason;
  const tooOld = f.tooOld || OPENCODE_TOO_OLD.some((r) => r.test(run.stderr));
  const status: RunStatus =
    stopped === "cancelled"
      ? "cancelled"
      : stopped === "idle-timeout" || stopped === "wall-timeout"
        ? "timeout"
        : tooOld
          ? "cli-too-old"
          : f.limit
            ? "limit"
            : f.error !== null || run.exit.code !== 0
              ? "failed"
              : "ok";
  const lastErr = run.stderr.trim().split("\n").at(-1) ?? "";
  const message = f.declined
    ? `permission rejected: ${f.declined}`
    : (f.error?.message ?? (lastErr || `${stopped}, exit ${run.exit.code ?? run.exit.signal}`));
  return {
    status,
    thread: f.thread ?? run.request.thread,
    tokens: f.tokens,
    costUsd: f.costUsd,
    images: [],
    error: status === "ok" ? null : { code: status, message },
    reply: f.reply,
  };
}

function parse(line: string): EventDelta {
  const e = parseOpencodeLine(line);
  if (!e) return {};
  const d: EventDelta = { lastEvent: eventName(e) };
  if (typeof e.sessionID === "string") d.thread = e.sessionID;
  if (e.type === "step_finish") {
    d.tokens = opencodeTokens(e.part?.tokens);
    if (typeof e.part?.cost === "number") d.costUsd = e.part.cost;
  }
  if (e.type === "error") {
    if (isV1Error(e)) d.tooOld = true;
    else if (OPENCODE_LIMIT_TYPES.includes(e.error?.type)) d.limit = true;
    d.failure = String(e.error?.message ?? e.error?.data?.message ?? "error");
  }
  return d;
}

/** Spec §4.5: Go `X` → Zen `X` when Zen lists `X` with the same variant. */
function failoverFor(rung: Rung): Rung | null {
  if (!rung.model.startsWith("opencode-go/")) return null;
  const zen = `opencode/${rung.model.slice("opencode-go/".length)}`;
  const m = readDiscovery("opencode")?.models.find((x) => x.id === zen);
  if (!m || (rung.effort !== "default" && !m.efforts.includes(rung.effort))) return null;
  return { backend: "opencode", model: zen, effort: rung.effort };
}

async function probe(): Promise<Probe> {
  const v = await runCli("opencode", ["--version"], opencodeShell);
  if (!v)
    return {
      installed: false,
      version: null,
      versionOk: false,
      loggedIn: null,
      problems: [{ code: "E_BACKEND_MISSING", message: "opencode is not on PATH", fix: OPENCODE_INSTALL }],
    };
  const version = extractVersion(v.out);
  const versionOk = version !== null && compareVersions(version, OPENCODE_MIN_VERSION) >= 0;
  const auth = jsonOf((await runCli("opencode", ["auth", "list", "--format", "json"], opencodeShell))?.out);
  // Not logged in is no problem: the free Zen models run without a key.
  const loggedIn = Array.isArray(auth)
    ? auth.some((p) => OPENCODE_PROVIDERS.includes(p?.id) && (p?.connections?.length ?? 0) > 0)
    : null;
  const problems: Probe["problems"] = [];
  if (!versionOk)
    problems.push({
      code: "E_BACKEND_TOO_OLD",
      message: version?.startsWith("1.")
        ? `opencode ${version} is v1; catherd needs opencode v2 (${OPENCODE_MIN_VERSION} or newer)`
        : `opencode ${version ?? "?"} is older than ${OPENCODE_MIN_VERSION}`,
      fix: OPENCODE_INSTALL,
    });
  return { installed: true, version, versionOk, loggedIn, problems };
}

export const opencodeAdapter: BackendAdapter = {
  id: "opencode",
  minVersion: OPENCODE_MIN_VERSION,
  probe,
  listModels,
  prepare,
  plan,
  parse,
  finalize,
  enforcement: { "read-only": "advisory", "workspace-write": "advisory", full: "advisory" },
  errors: { limit: OPENCODE_LIMIT, tooOld: OPENCODE_TOO_OLD },
  resume: { supported: true, sameAccessOnly: false, threadPattern: THREAD },
  failoverFor,
  graceAfterFinalMs: null,
};
