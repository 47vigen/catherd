import { existsSync, statSync } from "node:fs";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import type { Profile } from "../domain/profile.ts";
import { ROLES } from "../domain/roles.ts";
import { bunTooOld, MIN_BUN } from "../domain/runtime.ts";
import type { JevTransport } from "../infra/jev-client.ts";
import { linkedProfiles } from "./agent-links.ts";
import { accessChecks } from "./doctor-access.ts";
import { backendChecks, usedBackends } from "./doctor-backends.ts";
import { type PushProbe, pushCheck } from "./doctor-push.ts";
import {
  agentsCheck,
  type Check,
  errText,
  fixOf,
  guarded,
  locksCheck,
  pluginCheck,
} from "./doctor-checks.ts";
import { credentialsPath, jevKey, savedJevKey, testJevKey } from "./jev-service.ts";
import {
  activeName,
  enforcementOf,
  getProfile,
  profileExists,
  readConfig,
  readProjects,
  validateNamed,
} from "./profile-store.ts";
import { listRuns } from "./run-store.ts";

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
  /** spec §3.9: sends this Claude Code session a test message; without it (the dashboard) there is no `push` row */
  push?: () => Promise<PushProbe>;
  jev?: JevTransport;
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
  let linked: string[] = [];
  let active: Profile | null = null;
  try {
    readConfig();
    readProjects();
    active = getProfile(activeName());
    linked = linkedProfiles();
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
  // one unreadable linked profile must not hide the others' backends: its own row below reports it
  profiles = linked.flatMap((n) => {
    try {
      return [getProfile(n)];
    } catch {
      return [];
    }
  });
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
  const names = active ? [active.name, ...linked.filter((n) => n !== active?.name)] : [];
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
  const installed = new Set<string>();
  checks.push(...(await backendChecks(used, profiles, installed)));

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

  if (d.push)
    checks.push(
      pushCheck(await d.push().catch((e: unknown): PushProbe => ({ outcome: "failed", detail: errText(e) }))),
    );

  checks.push(locksCheck());
  // spec §5 and §12: which codex sandbox form runs, and the five access probes per workspace-write backend
  checks.push(...(await accessChecks(profiles, installed)));

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
    // Jev reads an unreadable file as no key (it is optional): here is where the user learns why
    const unreadable = savedJevKey().problem;
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
        : unreadable
          ? {
              id: "credentials",
              label: "credentials.json",
              state: "warn",
              word: "unreadable",
              detail: unreadable.message,
              fix: unreadable.fix ?? `fix or delete ${creds}, then catherd init`,
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
