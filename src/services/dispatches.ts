import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ACCESS } from "../domain/record.ts";
import { ROLES } from "../domain/roles.ts";
import { dispatchPaths, readExit } from "../infra/dispatch-dir.ts";
import { isAlive } from "../infra/proc.ts";
import { readVersioned, writeTextAtomic } from "../infra/store.ts";
import { readRecords, type Run, runPaths } from "./run-store.ts";

/** admit.json: what admission decided. Written last, so a dispatch exists once it does. */
export const AdmitSchema = z.looseObject({
  schema: z.literal(1),
  runId: z.string(),
  dispatchId: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
  lane: z.string().nullable(),
  owns: z.array(z.string()),
  rung: z.string(),
  backend: z.string(),
  thread: z.string().nullable(),
  attempt: z.number().int().min(1),
  failoverFrom: z.string().nullable(),
  access: z.enum(ACCESS),
  isolated: z.boolean(),
  cliVersion: z.string().nullable(),
  admittedAt: z.string(),
  repo: z.string(),
  /** `git status` fingerprints when admitted, for changedOwned and violations */
  before: z.record(z.string(), z.string()),
});
export type Admit = z.infer<typeof AdmitSchema>;

export interface Dispatch {
  dir: string;
  admit: Admit;
}
export type DispatchState = "starting" | "running" | "finished";

/** How long an admitted dispatch may go without a launch.json before it counts as never started. */
export const STARTING_GRACE_MS = 30_000;

export const admitPath = (dir: string): string => join(dir, "admit.json");
export const launchPath = (dir: string): string => join(dir, "launch.json");
export const roleDir = (run: Run, name: string): string => join(runPaths(run.dir).roles, name);

/** Every admitted dispatch of the run, oldest first; a folder whose admit.json cannot be read is skipped. */
export function listDispatches(run: Run): Dispatch[] {
  const roles = runPaths(run.dir).roles;
  const out: Dispatch[] = [];
  if (!existsSync(roles)) return out;
  for (const name of readdirSync(roles, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    for (const id of readdirSync(join(roles, name.name), { withFileTypes: true })) {
      if (!id.isDirectory()) continue;
      const dir = join(roles, name.name, id.name);
      try {
        out.push({ dir, admit: readVersioned(admitPath(dir), AdmitSchema, 1) });
      } catch {
        // admission never finished writing this folder
      }
    }
  }
  return out.sort((a, b) => a.admit.dispatchId.localeCompare(b.admit.dispatchId));
}

interface ProcFile {
  pid: number;
  /** the worker's process group; the detached worker leads it */
  pgid?: number;
  startTime: string | null;
  supervisorPid: number;
  supervisorStartTime: string | null;
  startedAt: string;
}
interface LaunchFile {
  supervisorPid: number;
  supervisorStartTime: string | null;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const readProc = (dir: string): ProcFile | null => readJson<ProcFile>(dispatchPaths(dir).proc);

/**
 * Spec §3.3: finished once exit.json exists, or once neither the supervisor nor its worker is alive,
 * each identified by pid and start time, so a reused pid never keeps a dispatch alive (audit C3).
 */
export function dispatchState(d: Dispatch, now = Date.now()): DispatchState {
  if (readExit(d.dir)) return "finished";
  const proc = readProc(d.dir);
  if (proc)
    return isAlive(proc.supervisorPid, proc.supervisorStartTime) || isAlive(proc.pid, proc.startTime)
      ? "running"
      : "finished";
  const launch = readJson<LaunchFile>(launchPath(d.dir));
  if (launch) return isAlive(launch.supervisorPid, launch.supervisorStartTime) ? "starting" : "finished";
  return now - Date.parse(d.admit.admittedAt) < STARTING_GRACE_MS ? "starting" : "finished";
}

export type LiveDispatch = Dispatch & { state: DispatchState };

/** Dispatches that have no record yet, with their state; `live` keeps only the unfinished ones. */
export function pendingDispatches(run: Run, now = Date.now()): LiveDispatch[] {
  const recorded = new Set(readRecords(run).records.map((r) => r.dispatchId));
  return listDispatches(run)
    .filter((d) => !recorded.has(d.admit.dispatchId))
    .map((d) => ({ ...d, state: dispatchState(d, now) }));
}

export const liveDispatches = (run: Run, now = Date.now()): LiveDispatch[] =>
  pendingDispatches(run, now).filter((d) => d.state !== "finished");

/** Spec §4.1: `roles/<name>/latest` names the newest dispatch of a role. */
export function setLatest(run: Run, name: string, dispatchId: string): void {
  writeTextAtomic(join(roleDir(run, name), "latest"), dispatchId);
}

export function latestDispatch(run: Run, name: string): Dispatch | null {
  const all = listDispatches(run).filter((d) => d.admit.name === name);
  let id: string | null = null;
  try {
    id = readFileSync(join(roleDir(run, name), "latest"), "utf8").trim();
  } catch {
    // no pointer yet
  }
  return all.find((d) => d.admit.dispatchId === id) ?? all.at(-1) ?? null;
}
