import type { OrchestrationHost } from "../domain/host.ts";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, isCatherdError } from "../domain/errors.ts";
import type { Profile } from "../domain/profile.ts";
import { claudeHome, locksDir } from "../infra/paths.ts";
import { ensurePrivateDir, PRIVATE_FILE } from "../infra/store.ts";
import { agentLinkState } from "./agent-links.ts";
import type { Handshake } from "./doctor.ts";
import { activeName } from "./profile-store.ts";

// The rows of `catherd doctor` and the checks that stand alone; doctor.ts assembles the report.

/** `info`: worth knowing, nothing to fix (spec 1.1 §13: the shipped defaults' access) */
type CheckState = "ok" | "warn" | "fail" | "skip" | "info";

/** One row of `catherd doctor` (spec §10.3): its state, one word, the detail and the full fix. */
export interface Check {
  id: string;
  label: string;
  state: CheckState;
  word: string;
  detail: string;
  fix?: string;
}

export const PLUGIN_INSTALL =
  "claude plugin marketplace add 47vigen/catherd && claude plugin install catherd@catherd";
const PLUGIN_UPDATE = "claude plugin marketplace update catherd && claude plugin update catherd@catherd";

export const errText = (e: unknown): string => errorMessage(e).split("\n")[0] as string;
export const fixOf = (e: unknown) => (isCatherdError(e) ? e.fix : undefined);

/** A check whose reads can throw (a corrupt or newer-schema file): the throw becomes its `fail` row. */
export function guarded(id: string, label: string, fallbackFix: string, check: () => Check): Check {
  try {
    return check();
  } catch (e) {
    return { id, label, state: "fail", word: "unreadable", detail: errText(e), fix: fixOf(e) ?? fallbackFix };
  }
}

export function pluginCheck(version: string): Check {
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

/** What makes the plugin's launcher run this catherd without a resolve: a global install at this version. */
export const reinstallCommand = (version: string): string => `bun add -g catherd-cli@${version}`;

const MISSING_MODULE = /Cannot find (?:module|package) ['"]?([^'"\s]+)/;
const NO_BUNX = /bunx: (?:command )?not found/;

/**
 * Spec 1.1 §12: the `mcp` row. The handshake starts the server the way the plugin does; a module it cannot
 * load (a half-cleaned bunx cache, a broken global install) and a launcher that finds neither catherd nor
 * bunx both say "reinstall: <command>".
 */
export function mcpCheck(h: Handshake, version: string): Check {
  const base = { id: "mcp", label: "MCP server" };
  if (h.ok && h.tools.includes("status"))
    return { ...base, state: "ok", word: "ready", detail: `answers tools/list with ${h.tools.length} tools` };
  const said = `${h.error ?? ""}\n${h.stderr ?? ""}`;
  const reinstall = reinstallCommand(version);
  const missing = MISSING_MODULE.exec(said)?.[1];
  if (missing)
    return {
      ...base,
      state: "fail",
      word: "broken install",
      detail: `cannot load ${missing}; reinstall: ${reinstall}`,
      fix: reinstall,
    };
  if (NO_BUNX.test(said))
    return {
      ...base,
      state: "fail",
      word: "missing",
      detail: `no catherd ${version} on PATH and no bunx to fetch it; reinstall: ${reinstall}`,
      fix: reinstall,
    };
  return {
    ...base,
    state: "fail",
    word: "no answer",
    detail: h.error ?? "tools/list has no status tool",
    fix: "run catherd mcp to see why it does not start",
  };
}

export function locksCheck(): Check {
  const base = { id: "locks", label: "heavy-lock dir" };
  try {
    ensurePrivateDir(locksDir());
    const probe = join(locksDir(), `.doctor-${process.pid}`);
    writeFileSync(probe, "", { mode: PRIVATE_FILE });
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

export function agentsCheck(
  host: OrchestrationHost,
  selected?: string[],
  relink = `catherd profile use ${activeName()}`,
): Check {
  const base = { id: "agents", label: "Claude agents" };
  const links = agentLinkState(host, selected);
  const broken = [...links.missing, ...links.stale];
  if (broken.length)
    return {
      ...base,
      state: "fail",
      word: links.missing.length ? "missing" : "stale",
      detail: broken.join(", "),
      fix: relink,
    };
  return links.ok.length
    ? { ...base, state: "ok", word: "ready", detail: `${links.ok.length} linked` }
    : { ...base, state: "skip", word: "none", detail: "no profile uses a native Claude rung" };
}

/**
 * ` --host <host>` for a fix doctor prints, when it judged on a known host: run from a plain terminal, the fix
 * must judge the profile the same way (omitted architect/verifier rungs resolve per host).
 */
export const hostFlag = (host: OrchestrationHost): string => (host === "unknown" ? "" : ` --host ${host}`);

/** The browser CLI the ui-reviewer's prompt takes its screenshots with. */
const UI_BROWSER = "agent-browser";

/**
 * The ui-reviewer takes screenshots with agent-browser: a profile that turns it on, on a machine without it,
 * dispatches a role that cannot do its job. Nothing to say when it is on PATH or no profile turns the role on.
 */
export function uiBrowserCheck(
  profiles: Profile[],
  onPath: (bin: string) => string | null,
  host: OrchestrationHost = "unknown",
): Check | null {
  const on = profiles.filter((p) => p.roles["ui-reviewer"].enabled).map((p) => p.name);
  if (!on.length || onPath(UI_BROWSER)) return null;
  return {
    id: "ui-browser",
    label: UI_BROWSER,
    state: "warn",
    word: "missing",
    detail: `${UI_BROWSER} is not on PATH, so ui-reviewer (${on.join(", ")}) cannot take screenshots`,
    fix: [
      `npm i -g ${UI_BROWSER}`,
      "or turn the role off:",
      ...on.map((n) => `catherd profile set roles.ui-reviewer.enabled false --profile ${n}${hostFlag(host)}`),
    ].join("\n"),
  };
}
