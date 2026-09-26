import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { CatherdError } from "../domain/errors.ts";
import { assertId } from "../domain/ids.ts";
import { type RunRecord, RunRecordSchema } from "../domain/record.ts";
import type { OutcomeRow, RouteRow } from "../domain/route.ts";
import { withFileLock } from "../infra/filelock.ts";
import { dataDir, repoDir, runsDir } from "../infra/paths.ts";
import {
  appendJsonl,
  ensureJsonlHeader,
  readJsonl,
  readVersioned,
  writeJsonAtomic,
  writeTextAtomic,
} from "../infra/store.ts";

export const RunMetaSchema = z.looseObject({
  schema: z.literal(1),
  id: z.string(),
  repo: z.string(),
  title: z.string(),
  aLines: z.array(z.string()),
  createdAt: z.string(),
  catherdVersion: z.string(),
});
export type RunMeta = z.infer<typeof RunMetaSchema>;

export interface Run {
  id: string;
  dir: string;
  meta: RunMeta;
}

/** Spec §4.1. */
export function runPaths(dir: string) {
  return {
    meta: join(dir, "meta.json"),
    plan: join(dir, "plan.md"),
    lanes: join(dir, "lanes"),
    ledger: join(dir, "ledger.md"),
    state: join(dir, "state.md"),
    stateJson: join(dir, "state.json"),
    runs: join(dir, "runs.jsonl"),
    routes: join(dir, "routes.jsonl"),
    jev: join(dir, "jev.jsonl"),
    outcomes: join(dir, "outcomes.jsonl"),
    agents: join(dir, "agents.jsonl"),
    harness: join(dir, "harness.jsonl"),
    roles: join(dir, "roles"),
    shots: join(dir, "shots"),
    /** the admission lock's target: `admission.lock` guards dispatch admission */
    admission: join(dir, "admission"),
  };
}

export const LEDGER_HEADER = "milestone | what | commit | minutes | evidence";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "run";
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** Creates a run folder under the repo's runs dir. `repo` is a git toplevel; meta.json is written last. */
export function createRun(o: {
  repo: string;
  title: string;
  aLines: string[];
  version: string;
  now?: Date;
}): Run {
  const now = o.now ?? new Date();
  const root = runsDir(o.repo);
  mkdirSync(root, { recursive: true });
  const base = `${stamp(now)}-${slug(o.title)}`;
  let id = base;
  for (let n = 2; ; n++) {
    try {
      mkdirSync(join(root, id));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      id = `${base}-${n}`;
    }
  }
  const dir = join(root, id);
  const p = runPaths(dir);
  for (const d of [p.lanes, p.roles, p.shots]) mkdirSync(d, { recursive: true });
  writeTextAtomic(p.ledger, `${LEDGER_HEADER}\n`);
  ensureJsonlHeader(p.runs, "runs");
  ensureJsonlHeader(p.routes, "routes");
  ensureJsonlHeader(p.agents, "agents");
  const meta: RunMeta = {
    schema: 1,
    id,
    repo: o.repo,
    title: o.title,
    aLines: o.aLines,
    createdAt: now.toISOString(),
    catherdVersion: o.version,
  };
  writeJsonAtomic(p.meta, meta);
  return { id, dir, meta };
}

export interface RunListing {
  runs: Run[];
  /** run folders whose meta.json cannot be read: listed as warnings, never fatal (audit C10) */
  corrupt: { id: string; dir: string; reason: string }[];
}

/** Every run of every repo, newest first. */
export function listRuns(): RunListing {
  const root = join(dataDir(), "repos");
  const out: RunListing = { runs: [], corrupt: [] };
  if (!existsSync(root)) return out;
  for (const repo of readdirSync(root, { withFileTypes: true })) {
    const runs = join(root, repo.name, "runs");
    if (!repo.isDirectory() || !existsSync(runs)) continue;
    for (const e of readdirSync(runs, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = join(runs, e.name);
      try {
        out.runs.push({ id: e.name, dir, meta: readVersioned(runPaths(dir).meta, RunMetaSchema, 1) });
      } catch (err) {
        out.corrupt.push({ id: e.name, dir, reason: (err as Error).message.split("\n")[0] ?? "unreadable" });
      }
    }
  }
  out.runs.sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
  return out;
}

export function findRun(id: string): Run {
  assertId("run", id);
  const { runs, corrupt } = listRuns();
  const run = runs.find((r) => r.id === id);
  if (run) return run;
  const bad = corrupt.find((r) => r.id === id);
  if (bad)
    throw new CatherdError("E_RUN_CORRUPT", `run ${id} cannot be read: ${bad.reason}`, {
      fix: `fix or delete ${bad.dir}`,
    });
  throw new CatherdError("E_RUN_NOT_FOUND", `no run "${id}"`, { fix: "status() lists the runs" });
}

/** The run's records, one per dispatch; rows that are torn, invalid or repeated are skipped and counted. */
export function readRecords(run: Run): { records: RunRecord[]; corrupt: number } {
  const { rows, corrupt } = readJsonl<unknown>(runPaths(run.dir).runs);
  const seen = new Set<string>();
  const records: RunRecord[] = [];
  let bad = corrupt;
  for (const row of rows) {
    const r = RunRecordSchema.safeParse(row);
    if (!r.success) bad++;
    else if (!seen.has(r.data.dispatchId)) {
      seen.add(r.data.dispatchId);
      records.push(r.data);
    }
  }
  return { records, corrupt: bad };
}

/** Appends `r` unless its dispatch already has a record, and returns the record that stands (audit C2). */
export function appendRecord(run: Run, r: RunRecord): Promise<RunRecord> {
  const file = runPaths(run.dir).runs;
  return withFileLock(file, () => {
    const existing = readRecords(run).records.find((x) => x.dispatchId === r.dispatchId);
    if (existing) return existing;
    ensureJsonlHeader(file, "runs");
    appendJsonl(file, RunRecordSchema.parse(r));
    return r;
  });
}

export function readRoutes(run: Run): RouteRow[] {
  return readJsonl<RouteRow>(runPaths(run.dir).routes).rows.filter(
    (r) => typeof r?.lane === "string" && Array.isArray(r.ladder) && typeof r.rung === "string",
  );
}

export function appendRoute(run: Run, row: RouteRow): void {
  const file = runPaths(run.dir).routes;
  ensureJsonlHeader(file, "routes");
  appendJsonl(file, row);
}

/** Appends; a lane may be written more than once and its last row wins (see `latestOutcomes`). */
export function appendOutcome(run: Run, row: OutcomeRow): void {
  const file = runPaths(run.dir).outcomes;
  ensureJsonlHeader(file, "outcomes");
  appendJsonl(file, row);
}

export function readOutcomes(run: Run): OutcomeRow[] {
  return readJsonl<OutcomeRow>(runPaths(run.dir).outcomes).rows.filter((r) => typeof r?.lane === "string");
}

export const AgentRunSchema = z.looseObject({
  at: z.string(),
  name: z.string(),
  role: z.string(),
  rung: z.string(),
  agent: z.string().nullable(),
  totalTokens: z.number().nonnegative(),
  costUsd: z.number().nullable(),
  secs: z.number().nullable(),
  status: z.enum(["ok", "failed", "cancelled"]),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

/** Native Claude subagent runs, as the orchestrator reported them through record_agent_run. */
export function readAgentRuns(run: Run): AgentRun[] {
  return readJsonl<unknown>(runPaths(run.dir).agents).rows.flatMap((row) => {
    const r = AgentRunSchema.safeParse(row);
    return r.success ? [r.data] : [];
  });
}

export function appendAgentRun(run: Run, a: AgentRun): void {
  const file = runPaths(run.dir).agents;
  ensureJsonlHeader(file, "agents");
  appendJsonl(file, AgentRunSchema.parse(a));
}

export function appendLedger(run: Run, row: string): void {
  appendFileSync(runPaths(run.dir).ledger, `${row}\n`);
}

/** Spec §4.7: what past runs of a repo learned, keyed by its git toplevel. */
export const knowledgeFile = (toplevel: string): string => join(repoDir(toplevel), "knowledge.md");

const SERVER_OWNED = new Set([
  "meta.json",
  "state.md",
  "state.json",
  "ledger.md",
  "runs.jsonl",
  "routes.jsonl",
  "jev.jsonl",
  "agents.jsonl",
  "harness.jsonl",
  "outcomes.jsonl",
]);

const present = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * The absolute path of `path` inside the run folder. Refuses a path, or a symlink on its way, that
 * leaves the folder; for writes, also catherd's own files, compared case-folded (audit S7).
 */
export function runFile(run: Run, path: string, mode: "read" | "write"): string {
  const full = resolve(run.dir, path);
  const rel = relative(run.dir, full);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(run.dir, rel) !== full)
    throw new CatherdError("E_IO_PATH", `"${path}" is outside the run folder`, {
      fix: "pass a path relative to the run folder, like lanes/M1.L1.md",
    });
  const folded = rel.toLowerCase();
  if (
    mode === "write" &&
    (SERVER_OWNED.has(folded) ||
      folded === "roles" ||
      folded.startsWith(`roles${sep}`) ||
      folded.endsWith(".lock"))
  )
    throw new CatherdError("E_IO_PATH", `${rel} is written by catherd itself`, {
      fix: "write plan.md, lanes/<id>.md, a dossier or notes instead",
    });
  let probe = full;
  while (!present(probe)) probe = dirname(probe);
  const root = realpathSync(run.dir);
  const real = realpathSync(probe);
  if (real !== root && !real.startsWith(`${root}${sep}`))
    throw new CatherdError("E_IO_PATH", `"${path}" resolves outside the run folder`, {
      fix: "remove the symlink that leaves the run folder",
    });
  return full;
}
