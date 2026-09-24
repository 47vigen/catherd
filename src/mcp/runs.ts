import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ID } from "../core/lanes.ts";
import { listRuns, readLive, type Run, writeState } from "../core/runstore.ts";
import { modelOf } from "../routing/catalog.ts";
import { type Backend, type Catalog, type RungId, splitRung, type StateSnapshot } from "../types.ts";

export function findRun(id: string): Run {
  if (!ID.test(id)) throw new Error(`catherd: bad run id "${id}"`);
  const run = listRuns().find((r) => r.id === id);
  if (!run) throw new Error(`catherd: no run "${id}"; status() lists the runs`);
  return run;
}

const SERVER_OWNED = [
  "meta.json",
  "state.md",
  "state.json",
  "ledger.md",
  "runs.jsonl",
  "jev.jsonl",
  "routes.jsonl",
  "harness.jsonl",
];

const present = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** The absolute path of `path` inside the run folder. Throws when it, or a symlink on the way, leaves the folder. */
export function runFile(run: Run, path: string, mode: "read" | "write"): string {
  const full = resolve(run.dir, path);
  const rel = relative(run.dir, full);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(run.dir, rel) !== full) {
    throw new Error(`catherd: "${path}" is outside the run folder`);
  }
  if (mode === "write" && (SERVER_OWNED.includes(rel) || rel.startsWith(`roles${sep}`))) {
    throw new Error(`catherd: ${rel} is written by catherd itself`);
  }
  let probe = full;
  while (!present(probe)) probe = dirname(probe);
  const root = realpathSync(run.dir);
  const real = realpathSync(probe);
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    throw new Error(`catherd: "${path}" resolves outside the run folder`);
  }
  return full;
}

interface StateNotes {
  next: string;
  lastCheck: string | null;
}

const notesFile = (run: Run) => join(run.dir, "state.json");

function readNotes(run: Run): StateNotes {
  if (!existsSync(notesFile(run))) return { next: "plan the milestones", lastCheck: null };
  return JSON.parse(readFileSync(notesFile(run), "utf8")) as StateNotes;
}

/** git output, or "" on any failure (no repo, git missing, non-zero exit). */
function git(cwd: string, ...args: string[]): string {
  try {
    const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return proc.success ? (proc.stdout?.toString("utf8") ?? "") : "";
  } catch {
    return "";
  }
}

export async function refreshState(
  run: Run,
  o: { starting?: StateSnapshot["running"][number]; next?: string; lastCheck?: string } = {},
): Promise<void> {
  const notes = readNotes(run);
  if (o.next !== undefined) notes.next = o.next;
  if (o.lastCheck !== undefined) notes.lastCheck = o.lastCheck;
  writeFileSync(notesFile(run), `${JSON.stringify(notes)}\n`);

  const live = readLive(run.dir);
  const running: StateSnapshot["running"] = live.map((m) => ({
    name: m.name,
    rung: m.rung,
    thread: m.thread,
    brief: `roles/${m.name}${m.thread ? ".fix" : ""}.md`,
    since: m.startedAt.slice(11, 16),
  }));
  if (o.starting && !running.some((r) => r.name === o.starting?.name)) running.push(o.starting);

  const head = git(run.meta.repo, "rev-parse", "--short", "HEAD").trim() || "none";
  const porcelain = git(run.meta.repo, "status", "--porcelain", "--untracked-files=all");
  const dirty = porcelain
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.slice(3))
    .map((path) => ({ path, owner: live.find((m) => m.ownedFiles.includes(path))?.name ?? null }));

  const waiting = running.map((r) => r.name);
  writeState(run.dir, {
    head,
    dirty,
    running,
    lastCheck: notes.lastCheck,
    next: waiting.length ? `wait for ${waiting.join(", ")}; then ${notes.next}` : notes.next,
  });
}

export function backendOf(c: Catalog, rung: RungId): Backend {
  const { model } = splitRung(rung);
  // ponytail: an opencode model the catalog does not list is recognised by its provider/ prefix
  return modelOf(c, model)?.backend ?? (model.includes("/") ? "opencode" : "codex");
}
