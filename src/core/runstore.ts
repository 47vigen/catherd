import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dataDir, runsRoot } from "../paths.ts";
import type { RunMeta, RunRecord, StateSnapshot } from "../types.ts";

export interface Run {
  dir: string;
  id: string;
  meta: RunMeta;
}

/** Dirs under the data root that are catherd's own, not a repo's runs. */
const NOT_REPOS = new Set(["locks", "codex-home", "opencode-home"]);

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "run";

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export function createRun(repo: string, title: string, aLines: string[]): Run {
  const now = new Date();
  const id = `${stamp(now)}-${slug(title)}`;
  const dir = join(runsRoot(repo), id);
  mkdirSync(join(dir, "lanes"), { recursive: true });
  mkdirSync(join(dir, "roles"), { recursive: true });
  mkdirSync(join(dir, "shots"), { recursive: true });
  const meta: RunMeta = { id, repo, title, aLines, createdAt: now.toISOString() };
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(join(dir, "ledger.md"), "milestone | what | commit | minutes | evidence\n");
  writeFileSync(join(dir, "state.md"), `# ${title}\n\n${aLines.join("\n")}\n\nNext: plan the milestones\n`);
  return { dir, id, meta };
}

export function openRun(repo: string, id: string): Run {
  const dir = join(runsRoot(repo), id);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as RunMeta;
  return { dir, id, meta };
}

export function listRuns(): Run[] {
  const root = dataDir();
  if (!existsSync(root)) return [];
  const runs: Run[] = [];
  for (const repo of readdirSync(root, { withFileTypes: true })) {
    if (!repo.isDirectory() || NOT_REPOS.has(repo.name)) continue;
    for (const run of readdirSync(join(root, repo.name), { withFileTypes: true })) {
      const dir = join(root, repo.name, run.name);
      if (!run.isDirectory() || !existsSync(join(dir, "meta.json"))) continue;
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as RunMeta;
      runs.push({ dir, id: meta.id, meta });
    }
  }
  return runs.sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
}

export function rolePaths(dir: string, name: string) {
  const base = join(dir, "roles", name);
  return {
    brief: `${base}.md`,
    fix: `${base}.fix.md`,
    out: `${base}.out`,
    jsonl: `${base}.jsonl`,
    err: `${base}.err`,
  };
}

/** Moves the latest round's out/jsonl/err to <name>.r<k>.* so the new round starts clean. */
export function rotateRound(dir: string, name: string): void {
  const p = rolePaths(dir, name);
  const current = [p.out, p.jsonl, p.err].filter((f) => existsSync(f));
  if (current.length === 0) return;
  let k = 1;
  while (["out", "jsonl", "err"].some((x) => existsSync(join(dir, "roles", `${name}.r${k}.${x}`)))) k++;
  for (const x of ["out", "jsonl", "err"] as const) {
    if (existsSync(p[x])) renameSync(p[x], join(dir, "roles", `${name}.r${k}.${x}`));
  }
}

export function appendJsonl(file: string, value: unknown): void {
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export const appendRunRecord = (dir: string, r: RunRecord) => appendJsonl(join(dir, "runs.jsonl"), r);
export const readRunRecords = (dir: string) => readJsonl<RunRecord>(join(dir, "runs.jsonl"));

export function writeState(dir: string, s: StateSnapshot): void {
  const lines = [
    `HEAD ${s.head}`,
    "",
    "Dirty:",
    ...(s.dirty.length ? s.dirty.map((d) => `- ${d.path}${d.owner ? ` (${d.owner})` : ""}`) : ["- none"]),
    "",
    "Running:",
    ...(s.running.length
      ? s.running.map(
          (r) => `- ${r.name} · ${r.rung} · thread ${r.thread ?? "new"} · since ${r.since} · ${r.brief}`,
        )
      : ["- none"]),
    "",
    `Last check: ${s.lastCheck ?? "none"}`,
    "",
    `Next: ${s.next}`,
  ];
  const title = readFileSync(join(dir, "state.md"), "utf8").split("\n")[0] ?? "# run";
  writeFileSync(join(dir, "state.md"), `${title}\n\n${lines.join("\n")}\n`);
}

export function appendLedger(dir: string, row: string): void {
  appendFileSync(join(dir, "ledger.md"), `${row}\n`);
}
