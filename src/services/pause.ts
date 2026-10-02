import { join } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import { dataDir } from "../infra/paths.ts";
import { appendJsonl, ensureJsonlHeader, readJsonl } from "../infra/store.ts";
/** What a pause is checked against: a run, or a workspace step about to start one. */
type Covered = { meta: { workspace?: { id: string; step: string } } };
import { findWorkspace, workspaceDirectory } from "./workspace-store.ts";

// Spec 1.5 plan 25, "Group pause": one environment blocker (a VPN, Docker down) pauses every run on the
// machine, or every child of a workspace, at once: admission refuses with the reason until it is resumed.

/** One row per pause or resume, oldest first; `reason` null is a resume. */
interface PauseRow {
  at: string;
  reason: string | null;
}

/** A pause in force: whose (the machine, or one workspace), why and since when. */
export interface Pause {
  scope: "machine" | "workspace";
  /** the workspace id, for a workspace pause */
  workspace?: string;
  reason: string;
  since: string;
}

/** A stretch of time something was paused; `to` null while it still is. */
export interface PauseInterval {
  from: string;
  to: string | null;
}

export const machinePauseFile = (): string => join(dataDir(), "pauses.jsonl");
export const workspacePauseFile = (id: string): string => join(workspaceDirectory(id), "pauses.jsonl");

const rows = (file: string): PauseRow[] =>
  readJsonl<PauseRow>(file).rows.filter(
    (r) => typeof r?.at === "string" && (r.reason === null || typeof r.reason === "string"),
  );

/** The pause in force in `file`, or null: its last row, when that row pauses. */
function current(file: string): { reason: string; since: string } | null {
  const last = rows(file).at(-1);
  return last && last.reason !== null ? { reason: last.reason, since: last.at } : null;
}

/** Every paused stretch `file` records, oldest first. */
export function pauseIntervals(file: string): PauseInterval[] {
  const out: PauseInterval[] = [];
  for (const r of rows(file)) {
    const open = out.at(-1);
    if (r.reason !== null && (!open || open.to !== null)) out.push({ from: r.at, to: null });
    else if (r.reason === null && open && open.to === null) open.to = r.at;
  }
  return out;
}

function append(file: string, row: PauseRow): void {
  ensureJsonlHeader(file, "pauses");
  appendJsonl(file, row);
}

const PAUSE_HINT = "push the reason to the owner once (PushNotification); every run it covers waits on it";

/** `catherd pause --machine <reason>`: every dispatch on this machine is refused until resumed. */
export function pauseMachine(now: number, reason: string): { pause: Pause; hints: string[] } {
  if (!reason.trim())
    throw new CatherdError("E_INPUT_INVALID", "a pause needs a reason", {
      fix: 'catherd pause --machine "the VPN takes the default route"',
    });
  const at = new Date(now).toISOString();
  append(machinePauseFile(), { at, reason });
  return { pause: { scope: "machine", reason, since: at }, hints: [PAUSE_HINT] };
}

/** `catherd resume --machine`: lifts the machine pause; the previous one, or null when none was in force. */
export function resumeMachine(now: number): { resumed: Pause | null } {
  const was = current(machinePauseFile());
  if (was) append(machinePauseFile(), { at: new Date(now).toISOString(), reason: null });
  return { resumed: was ? { scope: "machine", ...was } : null };
}

/** `workspace_pause(workspace, reason)`: every child of the workspace is refused admission until resumed. */
export function pauseWorkspace(
  now: number,
  i: { workspace: string; reason: string },
): { pause: Pause; hints: string[] } {
  const workspace = findWorkspace(i.workspace);
  if (!i.reason.trim())
    throw new CatherdError("E_INPUT_INVALID", "a pause needs a reason", {
      fix: 'workspace_pause(workspace, "the VPN takes the default route")',
    });
  const at = new Date(now).toISOString();
  append(workspacePauseFile(workspace.id), { at, reason: i.reason });
  return {
    pause: { scope: "workspace", workspace: workspace.id, reason: i.reason, since: at },
    hints: [PAUSE_HINT],
  };
}

/** `workspace_resume(workspace)`: lifts the workspace's pause; the previous one, or null. */
export function resumeWorkspace(now: number, i: { workspace: string }): { resumed: Pause | null } {
  const workspace = findWorkspace(i.workspace);
  const file = workspacePauseFile(workspace.id);
  const was = current(file);
  if (was) append(file, { at: new Date(now).toISOString(), reason: null });
  return { resumed: was ? { scope: "workspace", workspace: workspace.id, ...was } : null };
}

/** The pauses in force over `run`: the machine's, then its workspace's. */
export function pausesFor(run: Covered | null): Pause[] {
  const out: Pause[] = [];
  const machine = current(machinePauseFile());
  if (machine) out.push({ scope: "machine", ...machine });
  const id = run?.meta.workspace?.id;
  const ws = id ? current(workspacePauseFile(id)) : null;
  if (id && ws) out.push({ scope: "workspace", workspace: id, ...ws });
  return out;
}

/** The pauses in force over any of `runs`, each once, the machine's first. */
export function pausesOver(runs: Covered[]): Pause[] {
  const seen = new Set<string>();
  const out: Pause[] = [];
  for (const p of [pausesFor(null), ...runs.map(pausesFor)].flat()) {
    const key = `${p.scope} ${p.workspace ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

const describe = (p: Pause): string =>
  `${p.scope === "machine" ? "the machine" : `workspace ${p.workspace}`} is paused since ${p.since}: ${p.reason}`;

/** One line per pause, for status and the admission refusal. */
export const pauseLine = describe;

/** Admission refuses while a pause covers the run, naming its reason and how to lift it. */
export function assertNotPaused(run: Covered): void {
  const [p] = pausesFor(run);
  if (!p) return;
  throw new CatherdError("E_ADMIT_PAUSED", describe(p), {
    fix:
      p.scope === "machine"
        ? "when the blocker is gone, the owner runs: catherd resume --machine"
        : `when the blocker is gone, call workspace_resume(${p.workspace})`,
  });
}
