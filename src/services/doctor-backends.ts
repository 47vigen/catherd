import type { OrchestrationHost } from "../domain/host.ts";
import type { Probe } from "../adapters/backend.ts";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import { ADAPTER_IDS, tryParseRung } from "../domain/ids.ts";
import type { Profile } from "../domain/profile.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { standInFor, probeBackend } from "./backends.ts";
import { refreshDiscovery } from "./catalog-service.ts";
import { type Check, errText, fixOf } from "./doctor-checks.ts";

// The backend rows of `catherd doctor` (spec §10.3) and the backends the linked profiles use.

/** A rung's backend; null for a malformed rung, which validate reports. */
const backendOf = (rung: string): string | null => tryParseRung(rung)?.backend ?? null;

/** Every backend a linked profile runs a role on ("role"), or only fails over to ("failover"). */
export function usedBackends(profiles: Profile[]): Map<string, "role" | "failover"> {
  const used = new Map<string, "role" | "failover">();
  const note = (rung: string, how: "role" | "failover") => {
    const b = backendOf(rung);
    if (b && used.get(b) !== "role") used.set(b, how);
  };
  for (const p of profiles) {
    for (const role of ROLES) if (p.roles[role].enabled) for (const r of p.roles[role].rungs) note(r, "role");
    for (const role of ROLES)
      if (p.roles[role].enabled)
        for (const r of p.roles[role].rungs) {
          const to = standInFor(p.failover, r);
          if (to) note(to, "failover");
        }
  }
  return used;
}

const PROBLEM_WORD: Record<string, string> = {
  E_BACKEND_MISSING: "missing",
  E_BACKEND_TOO_OLD: "too old",
  E_BACKEND_NOT_LOGGED_IN: "not logged in",
  E_BACKEND_CANNOT_RUN: "cannot run",
};

/**
 * Spec §7.2 keeps the default profile Codex-first. When a backend a role runs on is missing and another is
 * ready, its fix also offers to move those roles there, onto a rung the shipped catalog scores.
 */
const MOVE_TO: Record<string, string> = {
  "claude-code": "claude-code:claude-opus-5-5#medium",
  opencode: "opencode:opencode-go/gpt-6-luna#high",
  codex: "codex:gpt-6-sol#medium",
};

/** `w` as one shell word: bare when plainly safe, else single-quoted (zsh can glob a bare `#`). */
const shellWord = (w: string): string => (/^[\w./:=@,+-]+$/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`);

/**
 * Install `id`, or move the roles that run on it to `to`: one runnable `catherd profile set` per line, for
 * each linked profile, any default rung the new ladder would not hold reset first. The artist draws, which only Codex does, so
 * off Codex it is turned off instead.
 */
export function moveRolesFix(install: string, id: string, to: string, profiles: Profile[]): string {
  const onIt = (r: string | undefined) => r !== undefined && backendOf(r) === id;
  const set = (p: Profile, path: string, v: string) =>
    `catherd profile set ${path} ${shellWord(v)} --profile ${shellWord(p.name)}`;
  const stuck = new Set<Role>();
  const commands: string[] = [];
  for (const p of profiles)
    for (const role of ROLES) {
      const rc = p.roles[role];
      if (!rc.enabled || !rc.rungs.some(onIt)) continue;
      if (role === "artist" && to !== "codex") {
        stuck.add(role);
        commands.push(set(p, `roles.${role}.enabled`, "false"));
        continue;
      }
      const target = MOVE_TO[to] as string;
      // the new ladder holds only `target`, so any other default would fail validation: reset it first
      if (rc.defaultRung !== undefined && rc.defaultRung !== null && rc.defaultRung !== target)
        commands.push(set(p, `roles.${role}.defaultRung`, "null"));
      commands.push(set(p, `roles.${role}.rungs`, target));
    }
  if (!commands.length) return install;
  const off = stuck.size ? ` (${[...stuck].join(", ")} needs ${id}, so it is turned off)` : "";
  return [
    install,
    `or move its roles to ${to}: /catherd-setup in Claude Code, or run${off}`,
    ...commands,
  ].join("\n");
}

/** One row per backend; `installed`, when given, collects the backends whose CLI is on PATH. */
export async function backendChecks(
  used: Map<string, "role" | "failover">,
  profiles: Profile[],
  installed?: Set<string>,
  host: OrchestrationHost = "unknown",
): Promise<Check[]> {
  const checks: Check[] = [];
  const ready: string[] = [];
  for (const id of ADAPTER_IDS) {
    if (host === "codex" && id === "claude-code" && !used.has(id)) {
      checks.push({
        id: `backend:${id}`,
        label: id,
        state: "skip",
        word: "not required",
        detail: "not probed: the selected profile has no headless Claude role or reachable failover",
      });
      continue;
    }
    const a = adapterFor(id);
    if (!a) continue;
    const probe: Probe = await probeBackend(a).catch((e: unknown) => ({
      installed: false,
      version: null,
      versionOk: false,
      loggedIn: null,
      problems: [
        { code: "E_IO_UNEXPECTED" as const, message: errText(e), fix: `run ${id} --version to see why` },
      ],
    }));
    if (probe.installed) installed?.add(id);
    // spec 1.3 §4.7: what the probe found worth knowing, nothing to fix (an `agent` on PATH that is not Cursor)
    for (const i of probe.info ?? [])
      checks.push({ id: i.id, label: i.label, state: "info", word: "info", detail: i.detail });
    const problem = probe.problems[0];
    const use = used.get(id);
    if (!problem) {
      ready.push(id);
      const detail = [probe.version, probe.login && `${probe.login} login`].filter(Boolean).join(" · ");
      // a login billed apart from what a profile says (a plan, or per token) ranks that backend's cost wrongly;
      // only a profile that routes something to this backend is ranked by it
      const billed =
        probe.billing &&
        profiles.find((p) => p.billing[id] && p.billing[id] !== probe.billing && usedBackends([p]).has(id));
      checks.push(
        billed
          ? {
              id: `backend:${id}`,
              label: id,
              state: "warn",
              word: "billing",
              detail: `${detail} · profile ${billed.name} bills ${id} as ${billed.billing[id]}, but this login is ${probe.billing}`,
              fix: `catherd profile set billing.${id} ${probe.billing} --profile ${billed.name}`,
            }
          : { id: `backend:${id}`, label: id, state: "ok", word: "ready", detail },
      );
      // spec 1.3 §6.6: asked only of a logged-in CLI (a logged-out agy -p would open a browser)
      const quota = probe.loggedIn && a.quota ? await a.quota().catch(() => null) : null;
      if (quota)
        checks.push({ id: `quota:${id}`, label: `${id} quota`, state: "info", word: "quota", detail: quota });
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
  const to = Object.keys(MOVE_TO).find((b) => ready.includes(b));
  for (const c of checks) {
    const id = c.id.slice("backend:".length);
    if (to && c.state === "fail" && c.word === PROBLEM_WORD.E_BACKEND_MISSING && c.fix && id !== to)
      c.fix = moveRolesFix(c.fix, id, to, profiles);
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
