import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTER_IDS, type Probe } from "../adapters/backend.ts";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import { isCatherdError } from "../domain/errors.ts";
import { parseRung } from "../domain/ids.ts";
import type { Profile } from "../domain/profile.ts";
import { ROLES } from "../domain/roles.ts";
import { bunTooOld, MIN_BUN } from "../domain/runtime.ts";
import type { JevTransport } from "../infra/jev-client.ts";
import { claudeHome, locksDir } from "../infra/paths.ts";
import { refreshDiscovery } from "./catalog-service.ts";
import { credentialsPath, jevKey, testJevKey } from "./jev-service.ts";
import {
  activeName,
  agentLinkState,
  enforcementOf,
  getProfile,
  linkedProfiles,
  profileExists,
  readConfig,
  readProjects,
  validateNamed,
} from "./profile-service.ts";
import { listRuns } from "./run-store.ts";

export type CheckState = "ok" | "warn" | "fail" | "skip";

/** One row of `catherd doctor` (spec §10.3): its state, one word, the detail and the full fix. */
export interface Check {
  id: string;
  label: string;
  state: CheckState;
  word: string;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  /** false when any check failed: `catherd doctor` exits 3 */
  ready: boolean;
  version: string;
  checks: Check[];
}

export interface Handshake {
  ok: boolean;
  tools: string[];
  error?: string;
}

export interface DoctorDeps {
  bunVersion: string;
  /** the package version, which the Claude Code plugin must pin */
  version: string;
  /** starts `catherd mcp` over stdio and asks it for tools/list */
  handshake: () => Promise<Handshake>;
  jev?: JevTransport;
}

export const PLUGIN_INSTALL =
  "claude plugin marketplace add 47vigen/catherd && claude plugin install catherd@catherd";
export const PLUGIN_UPDATE =
  "claude plugin marketplace update catherd && claude plugin update catherd@catherd";

const errText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e)) as string;
const fixOf = (e: unknown) => (isCatherdError(e) ? e.fix : undefined);

/** A check whose reads can throw (a corrupt or newer-schema file): the throw becomes its `fail` row. */
function guarded(id: string, label: string, fallbackFix: string, check: () => Check): Check {
  try {
    return check();
  } catch (e) {
    return { id, label, state: "fail", word: "unreadable", detail: errText(e), fix: fixOf(e) ?? fallbackFix };
  }
}

/** Every backend a linked profile runs a role on ("role"), or only fails over to ("failover"). */
function usedBackends(profiles: Profile[]): Map<string, "role" | "failover"> {
  const used = new Map<string, "role" | "failover">();
  const note = (rung: string, how: "role" | "failover") => {
    try {
      const b = parseRung(rung).backend;
      if (used.get(b) !== "role") used.set(b, how);
    } catch {
      // validate reports a bad rung
    }
  };
  for (const p of profiles) {
    for (const role of ROLES) if (p.roles[role].enabled) for (const r of p.roles[role].rungs) note(r, "role");
    for (const to of Object.values(p.failover)) note(to, "failover");
  }
  return used;
}

/**
 * Spec §10.3: the backends that run an enabled workspace-write role, or stand in for one of its rungs,
 * whose sandbox must let such a worker take the heavy lock.
 */
function workspaceWriteBackends(profiles: Profile[]): Set<string> {
  const out = new Set<string>();
  for (const p of profiles)
    for (const role of ROLES) {
      const rc = p.roles[role];
      if (!rc.enabled || rc.access !== "workspace-write") continue;
      for (const r of [...rc.rungs, ...rc.rungs.flatMap((x) => p.failover[x] ?? [])])
        try {
          out.add(parseRung(r).backend);
        } catch {
          // validate reports a bad rung
        }
    }
  return out;
}

const PROBLEM_WORD: Record<string, string> = {
  E_BACKEND_MISSING: "missing",
  E_BACKEND_TOO_OLD: "too old",
  E_BACKEND_NOT_LOGGED_IN: "not logged in",
};

async function backendChecks(used: Map<string, "role" | "failover">): Promise<Check[]> {
  const checks: Check[] = [];
  const ready: string[] = [];
  for (const id of ADAPTER_IDS) {
    const a = adapterFor(id);
    if (!a) continue;
    const probe: Probe = await a.probe().catch((e: unknown) => ({
      installed: false,
      version: null,
      versionOk: false,
      loggedIn: null,
      problems: [
        { code: "E_IO_UNEXPECTED" as const, message: errText(e), fix: `run ${id} --version to see why` },
      ],
    }));
    const problem = probe.problems[0];
    const use = used.get(id);
    if (!problem) {
      ready.push(id);
      checks.push({
        id: `backend:${id}`,
        label: id,
        state: "ok",
        word: "ready",
        detail: probe.version ?? "",
      });
      continue;
    }
    checks.push({
      id: `backend:${id}`,
      label: id,
      state: use === "role" ? "fail" : use === "failover" ? "warn" : "skip",
      word: PROBLEM_WORD[problem.code] ?? "not ready",
      detail: `${problem.message}${use === "failover" ? " (a failover stand-in uses it)" : use ? "" : " (no profile uses it)"}`,
      fix: problem.fix,
    });
  }
  // spec §5.2: doctor refreshes discovery; a listing that fails keeps the last one
  let refreshed: Awaited<ReturnType<typeof refreshDiscovery>> = [];
  try {
    refreshed = await refreshDiscovery({ backends: ready });
  } catch (e) {
    checks.push({
      id: "discovery",
      label: "model discovery",
      state: "fail",
      word: "unreadable",
      detail: errText(e),
      fix: fixOf(e) ?? "catherd catalog refresh --verbose",
    });
  }
  for (const r of refreshed) {
    const c = checks.find((x) => x.id === `backend:${r.backend}`);
    if (!c) continue;
    if (r.error)
      Object.assign(c, {
        state: "warn",
        word: "no listing",
        detail: `${c.detail} · ${r.error}`,
        fix: "catherd catalog refresh",
      });
    else c.detail = `${c.detail} · ${r.models} models`;
  }
  return checks;
}

function pluginCheck(version: string): Check {
  const base = { id: "plugin", label: "Claude Code plugin" };
  const file = join(claudeHome(), "plugins", "installed_plugins.json");
  let installed: string | null = null;
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { plugins?: Record<string, { version?: string }[]> };
    const entry = Object.entries(j.plugins ?? {}).find(([k]) => k.startsWith("catherd@"))?.[1]?.[0];
    installed = entry ? (entry.version ?? "unknown") : null;
  } catch {
    installed = null;
  }
  if (installed === null)
    return {
      ...base,
      state: "fail",
      word: "missing",
      detail: "not installed in Claude Code",
      fix: PLUGIN_INSTALL,
    };
  if (installed !== version)
    return {
      ...base,
      state: "fail",
      word: "stale",
      detail: `plugin ${installed}, catherd ${version}`,
      fix: PLUGIN_UPDATE,
    };
  return { ...base, state: "ok", word: "ready", detail: installed };
}

function locksCheck(): Check {
  const base = { id: "locks", label: "heavy-lock dir" };
  try {
    mkdirSync(locksDir(), { recursive: true });
    const probe = join(locksDir(), `.doctor-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return { ...base, state: "ok", word: "ready", detail: locksDir() };
  } catch (e) {
    return {
      ...base,
      state: "fail",
      word: "not writable",
      detail: `${locksDir()}: ${errText(e)}`,
      fix: `chmod -R u+w ${locksDir()}`,
    };
  }
}

function agentsCheck(): Check {
  const base = { id: "agents", label: "Claude agents" };
  const links = agentLinkState();
  const broken = [...links.missing, ...links.stale];
  if (broken.length)
    return {
      ...base,
      state: "fail",
      word: links.missing.length ? "missing" : "stale",
      detail: broken.join(", "),
      fix: `catherd profile use ${activeName()}`,
    };
  return links.ok.length
    ? { ...base, state: "ok", word: "ready", detail: `${links.ok.length} linked` }
    : { ...base, state: "skip", word: "none", detail: "no profile uses a native Claude rung" };
}

/**
 * Spec §10.3: the readiness report. Reads and probes; it writes discovery and a lock probe itself, and the
 * handshake starts `catherd mcp`, which reconciles runs as it starts. A check that throws becomes a `fail` row.
 */
export async function doctor(d: DoctorDeps): Promise<DoctorReport> {
  const checks: Check[] = [];
  checks.push(
    bunTooOld(d.bunVersion)
      ? {
          id: "bun",
          label: "Bun",
          state: "fail",
          word: "too old",
          detail: `${d.bunVersion}, needs ${MIN_BUN}`,
          fix: "bun upgrade",
        }
      : { id: "bun", label: "Bun", state: "ok", word: "ready", detail: d.bunVersion },
  );

  let profiles: Profile[] = [];
  let active: Profile | null = null;
  try {
    readConfig();
    readProjects();
    active = getProfile(activeName());
    profiles = linkedProfiles().map(getProfile);
    checks.push({
      id: "config",
      label: "config",
      state: "ok",
      word: "ready",
      detail: `active profile ${active.name}`,
    });
  } catch (e) {
    checks.push({
      id: "config",
      label: "config",
      state: "fail",
      word: "invalid",
      detail: errText(e),
      fix: fixOf(e) ?? "catherd init",
    });
  }
  // a repo bound to a profile whose file is gone: every command run in that repo fails to load it
  try {
    for (const [repo, name] of Object.entries(readProjects().bindings))
      if (!profileExists(name))
        checks.push({
          id: `binding:${repo}`,
          label: `binding ${repo}`,
          state: "fail",
          word: "missing",
          detail: `bound to profile ${name}, which does not exist`,
          fix: `cd ${repo} && catherd profile use --repo --clear`,
        });
  } catch {
    // the config row above already reports an unreadable projects.json
  }
  // every linked profile: the active one (row `profile`) and each repo-bound one (row `profile:<name>`).
  // Each fix names its profile: without one, the CLI acts on the profile of the repo doctor runs in.
  const names = active ? [active.name, ...profiles.map((p) => p.name).filter((n) => n !== active?.name)] : [];
  for (const name of names) {
    const id = name === active?.name ? "profile" : `profile:${name}`;
    const validate = `catherd profile validate ${name}`;
    const named = (fix: string) =>
      fix.replaceAll("catherd profile set ", `catherd profile set --profile ${name} `);
    checks.push(
      guarded(id, `profile ${name}`, validate, () => {
        const v = validateNamed(name);
        const first = v.errors[0] ?? v.warnings[0];
        return {
          id,
          label: `profile ${name}`,
          state: v.errors.length ? "fail" : v.warnings.length ? "warn" : "ok",
          word: v.errors.length ? "invalid" : v.warnings.length ? "warning" : "ready",
          detail: first
            ? `${first.path}: ${first.message}${v.errors.length + v.warnings.length > 1 ? " (and more)" : ""}`
            : "valid",
          ...(first ? { fix: first.fix ? named(first.fix) : validate } : {}),
        };
      }),
    );
  }

  const used = usedBackends(profiles);
  checks.push(...(await backendChecks(used)));

  if (active && [active, ...profiles].every((p) => p.jev.use === "off"))
    checks.push({
      id: "jev",
      label: "Jev",
      state: "skip",
      word: "off",
      detail: profiles.length > 1 ? "off in every linked profile" : "off in the profile",
    });
  else {
    const key = jevKey();
    if (!key)
      checks.push({
        id: "jev",
        label: "Jev",
        state: "warn",
        word: "no key",
        detail: "optional: routing uses each lane's Kind and Difficulty instead",
        fix: "catherd init, or export TYPESAFE_API_KEY=<key>",
      });
    else {
      const ok = await testJevKey(key, d.jev).catch(() => false);
      checks.push(
        ok
          ? { id: "jev", label: "Jev", state: "ok", word: "ready", detail: "the key answers" }
          : {
              id: "jev",
              label: "Jev",
              state: "warn",
              word: "no answer",
              detail: "the key did not answer; routing falls back to the lanes",
              fix: "catherd init to enter a new key",
            },
      );
    }
  }

  checks.push(pluginCheck(d.version));

  checks.push(
    active
      ? guarded("agents", "Claude agents", `catherd profile use ${activeName()}`, agentsCheck)
      : {
          id: "agents",
          label: "Claude agents",
          state: "skip",
          word: "not checked",
          detail: "the config cannot be read",
        },
  );

  const h = await d
    .handshake()
    .catch((e: unknown): Handshake => ({ ok: false, tools: [], error: errText(e) }));
  checks.push(
    h.ok && h.tools.includes("status")
      ? {
          id: "mcp",
          label: "MCP server",
          state: "ok",
          word: "ready",
          detail: `answers tools/list with ${h.tools.length} tools`,
        }
      : {
          id: "mcp",
          label: "MCP server",
          state: "fail",
          word: "no answer",
          detail: h.error ?? "tools/list has no status tool",
          fix: "run catherd mcp to see why it does not start",
        },
  );

  checks.push(locksCheck());
  for (const id of workspaceWriteBackends(profiles)) {
    const a = adapterFor(id);
    if (!a?.canWrite) continue;
    const r = await a.canWrite(locksDir()).catch(() => null);
    const base = { id: `sandbox:${id}`, label: `heavy-lock dir from ${id}'s sandbox` };
    checks.push(
      r === null
        ? {
            ...base,
            state: "skip",
            word: "not tested",
            detail: `no ${id} sandbox to test with on this machine`,
          }
        : r.ok
          ? {
              ...base,
              state: "ok",
              word: "ready",
              detail: "a workspace-write worker can take the heavy lock",
            }
          : {
              ...base,
              state: "warn",
              word: "not writable",
              detail: `a workspace-write ${id} worker cannot write ${locksDir()}, so catherd lock fails inside it`,
              ...(r.fix ? { fix: r.fix } : {}),
            },
    );
  }

  const full: string[] = [];
  const advisory: string[] = [];
  for (const p of profiles)
    for (const role of ROLES) {
      const rc = p.roles[role];
      if (!rc.enabled) continue;
      if (rc.access === "full") full.push(`${role} (${p.name})`);
      const soft = [
        ...new Set(
          rc.rungs
            .filter((r) => enforcementOf(r, rc.access) === "advisory")
            .map((r) => r.slice(0, r.indexOf(":"))),
        ),
      ];
      if (soft.length) advisory.push(`${role} on ${soft.join(", ")} (${p.name})`);
    }
  if (full.length)
    checks.push({
      id: "access:full",
      label: "full access",
      state: "warn",
      word: "warning",
      detail: `no sandbox for: ${full.join(", ")}`,
    });
  if (advisory.length)
    checks.push({
      id: "access:advisory",
      label: "advisory access",
      state: "warn",
      word: "warning",
      detail: `the backend asks but cannot force: ${advisory.join(", ")}`,
    });
  for (const id of used.keys()) {
    const note = adapterFor(id)?.isolationNote;
    if (note)
      checks.push({
        id: `isolation:${id}`,
        label: `${id} isolation`,
        state: "warn",
        word: "weak",
        detail: note,
      });
  }

  const creds = credentialsPath();
  if (existsSync(creds)) {
    const mode = statSync(creds).mode & 0o777;
    checks.push(
      mode & 0o077
        ? {
            id: "credentials",
            label: "credentials.json",
            state: "fail",
            word: "readable by others",
            detail: `mode ${mode.toString(8)}`,
            fix: `chmod 600 ${creds}`,
          }
        : { id: "credentials", label: "credentials.json", state: "ok", word: "ready", detail: "mode 600" },
    );
  }

  if (!Bun.which("bunx", { PATH: process.env.PATH ?? "" }))
    checks.push({
      id: "bunx",
      label: "bunx",
      state: "warn",
      word: "missing",
      detail: "the plugin starts the MCP server with bunx",
      fix: "put Bun's bin folder (~/.bun/bin) on PATH",
    });
  let corrupt: ReturnType<typeof listRuns>["corrupt"] = [];
  try {
    corrupt = listRuns().corrupt;
  } catch (e) {
    checks.push({
      id: "runs",
      label: "run data",
      state: "fail",
      word: "unreadable",
      detail: errText(e),
      fix: fixOf(e) ?? "catherd runs list --verbose",
    });
  }
  if (corrupt.length)
    checks.push({
      id: "runs",
      label: "run data",
      state: "warn",
      word: "unreadable",
      detail: corrupt.map((c) => `${c.id}: ${c.reason}`).join("; "),
      fix: `fix or delete ${corrupt[0]?.dir}`,
    });

  return { ready: !checks.some((c) => c.state === "fail"), version: d.version, checks };
}
