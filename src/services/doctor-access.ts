import { realTmpdir } from "../adapters/access.ts";
import type { AccessShell } from "../adapters/backend.ts";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import { tryParseRung } from "../domain/ids.ts";
import type { Profile } from "../domain/profile.ts";
import { ROLES } from "../domain/roles.ts";
import { locksDir } from "../infra/paths.ts";
import { ensurePrivateDir } from "../infra/store.ts";
import type { Check } from "./doctor-checks.ts";

// Spec §5 and §12: the five access probes doctor runs per backend that serves a workspace-write role, each
// in that backend's worker shell with the grants a worker gets, and the rows that report them.

export type ProbeId = "lock" | "temp" | "loopback" | "https" | "docker";

/**
 * What the probes reach: npm's ping, through HTTPS_PROXY when it is set (Bun's fetch honours it), and
 * `docker`. CATHERD_PROBE_URL and CATHERD_PROBE_DOCKER replace them (tests: a local server, no docker).
 */
export const probeTargets = {
  get url(): string {
    return process.env.CATHERD_PROBE_URL || "https://registry.npmjs.org/-/ping";
  },
  get docker(): string {
    return process.env.CATHERD_PROBE_DOCKER || "docker";
  },
};

interface ProbeDef {
  id: ProbeId;
  label: string;
  /** off when the role's network is off */
  network: boolean;
  script: string;
  args: () => string[];
}

// every path and URL goes in as an argument, never into the script text
const WRITE = 'f="$1/.catherd-doctor-$$" && touch "$f" && rm -f "$f"';
const BUN_EVAL = '"$1" -e "$2"';
const BIND = 'Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }).stop(true)';
// npm's ping answers 200; any 4xx or 5xx fails, so a proxy's 407 or 403 for a denied host is not a false green
const FETCH =
  "const r = await fetch(process.argv[1], { method: 'HEAD' }); if (r.status >= 400) { console.error(`HTTP ${r.status}${r.status === 407 ? ' (proxy authentication required)' : r.status === 403 ? ' (refused: a proxy denying the host?)' : ''}`); process.exit(1) }";

const PROBES: ProbeDef[] = [
  { id: "lock", label: "lock-dir write", network: false, script: WRITE, args: () => [locksDir()] },
  { id: "temp", label: "temp write", network: false, script: WRITE, args: () => [realTmpdir()] },
  {
    id: "loopback",
    label: "loopback bind",
    network: true,
    script: BUN_EVAL,
    args: () => [process.execPath, BIND],
  },
  {
    id: "https",
    label: "outbound HTTPS",
    network: true,
    script: `${BUN_EVAL} "$3"`,
    args: () => [process.execPath, FETCH, probeTargets.url],
  },
  {
    id: "docker",
    label: "docker version",
    network: false,
    script: '"$1" version',
    args: () => [probeTargets.docker],
  },
];

export interface ProbeResult {
  id: ProbeId;
  label: string;
  /** "off": the role's network is off; "skip": docker is not installed */
  state: "ok" | "failed" | "off" | "skip";
  /** the last line the probe printed on failure */
  why?: string;
}

/** Runs the five probes in `shell`; docker only when it is installed, the network two only when granted. */
export async function runProbes(shell: AccessShell, network: boolean): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  let noLocks: string | null = null;
  try {
    ensurePrivateDir(locksDir());
  } catch (e) {
    noLocks = `cannot create ${locksDir()}: ${e instanceof Error ? e.message : String(e)}`;
  }
  for (const p of PROBES) {
    if (p.id === "lock" && noLocks) {
      out.push({ id: p.id, label: p.label, state: "failed", why: noLocks });
      continue;
    }
    if (p.network && !network) {
      out.push({ id: p.id, label: p.label, state: "off" });
      continue;
    }
    if (p.id === "docker" && !Bun.which(probeTargets.docker, { PATH: process.env.PATH ?? "" })) {
      out.push({ id: p.id, label: p.label, state: "skip" });
      continue;
    }
    const r = await shell.run(p.script, p.args());
    const last = `${r?.err ?? ""}\n${r?.out ?? ""}`.trim().split("\n").at(-1);
    const late = last && / timed out after (\d+) ms$/.exec(last);
    const why =
      r === null
        ? "the probe shell did not start"
        : late
          ? `timed out after ${Number(late[1]) / 1000} s`
          : last;
    out.push({
      id: p.id,
      label: p.label,
      state: r?.ok ? "ok" : "failed",
      ...(r?.ok ? {} : { why: why || "no output" }),
    });
  }
  return out;
}

/** The fix for a failed probe, per backend: Codex's sandbox holds catherd's grants; the others run unsandboxed. */
function fixFor(backend: string, id: ProbeId): string {
  if (backend === "codex") {
    const override =
      "catherd passes this grant to Codex itself: check that no [sandbox_workspace_write] in ~/.codex/config.toml, a --profile or a managed requirements.toml overrides it";
    if (id === "docker")
      return "the Codex sandbox cannot reach the Docker socket here: run the Docker checks in the verifier (full access), or give the role full access";
    return override;
  }
  const FIX: Record<ProbeId, string> = {
    lock: `chmod -R u+w ${locksDir()}`,
    temp: `check that ${realTmpdir()} is writable`,
    loopback: "something on this machine refuses a bind to 127.0.0.1: check the firewall",
    https: "check the network, or set HTTPS_PROXY for this shell",
    docker: `start Docker: ${probeTargets.docker} version fails`,
  };
  return FIX[id];
}

/** Every backend an enabled workspace-write role runs on or fails over to, with whether any of those roles has network. */
export function workspaceWriteNetwork(profiles: Profile[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const p of profiles)
    for (const role of ROLES) {
      const rc = p.roles[role];
      if (!rc.enabled || rc.access !== "workspace-write") continue;
      for (const r of [...rc.rungs, ...rc.rungs.flatMap((x) => p.failover[x] ?? [])]) {
        const b = tryParseRung(r)?.backend;
        if (b && b !== "claude") out.set(b, (out.get(b) ?? false) || rc.network !== false);
      }
    }
  return out;
}

/** The `sandbox:codex` row (which `codex sandbox` form runs) and one `access:<backend>` row per backend. */
export async function accessChecks(profiles: Profile[]): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [id, network] of workspaceWriteNetwork(profiles)) {
    const a = adapterFor(id);
    if (!a?.accessShell) continue;
    const shell = await a.accessShell({ network }).catch((e: unknown) => String(e));
    if (id === "codex")
      checks.push(
        typeof shell === "string"
          ? { id: "sandbox:codex", label: "codex sandbox", state: "skip", word: "not tested", detail: shell }
          : { id: "sandbox:codex", label: "codex sandbox", state: "ok", word: "ready", detail: shell.how },
      );
    const base = { id: `access:${id}`, label: `${id} worker access` };
    if (typeof shell === "string") {
      checks.push({ ...base, state: "skip", word: "not tested", detail: shell });
      continue;
    }
    let results: ProbeResult[];
    try {
      results = await runProbes(shell, network);
    } finally {
      shell.close();
    }
    const failed = results.filter((r) => r.state === "failed");
    const passed = results.filter((r) => r.state === "ok").map((r) => r.label);
    const notes = [
      ...(results.some((r) => r.state === "off") ? ["network off by profile"] : []),
      ...(results.some((r) => r.state === "skip") ? ["no docker"] : []),
      // only Codex's sandbox can take the network away; the others' shells keep it
      ...(id !== "codex" && !network ? [`network: false is not enforced by ${id}'s shell`] : []),
    ];
    checks.push(
      failed.length
        ? {
            ...base,
            state: "warn",
            word: "blocked",
            detail: `in ${shell.how}, a worker cannot: ${failed.map((r) => `${r.label} (${r.why})`).join("; ")}`,
            fix: failed.map((r) => `${r.label}: ${fixFor(id, r.id)}`).join("\n"),
          }
        : {
            ...base,
            state: "ok",
            word: "ready",
            detail: [`${passed.join(", ")} in ${shell.how}`, ...notes].join(" · "),
          },
    );
  }
  return checks;
}
