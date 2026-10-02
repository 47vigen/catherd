import { lstatSync, readdirSync, readlinkSync, realpathSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CatherdError, isCatherdError } from "../domain/errors.ts";
import { normalizeOwned, overlaps } from "../domain/lane.ts";
import { git, gitHead, statusSnapshot } from "../infra/git.ts";
import { repoDir } from "../infra/paths.ts";
import { appendJsonl, ensureJsonlHeader, readJsonl } from "../infra/store.ts";
import type { Deps } from "./ports.ts";
import { findRun, type Run } from "./run-store.ts";

// Spec 1.1 §7: the verifier's gate ledger. A gate item that passed on the same content, with the same
// command, is carried over instead of run again; every check is a verifier step `peek` and `status` show.

const GatePassSchema = z.looseObject({
  at: z.string(),
  run: z.string(),
  item: z.string(),
  command: z.string(),
  paths: z.array(z.string()),
  hash: z.string(),
  commit: z.string(),
  evidence: z.string(),
});
type GatePass = z.infer<typeof GatePassSchema>;

export interface VerifierStep {
  at: string;
  item: string;
  /** the item's command; steps written before 1.5 lack it */
  command?: string;
  carried: boolean;
  /** a carried item: the commit its pass was recorded on */
  commit?: string;
  /** the milestone the verifier checks, when gate_check named it: the digest lists only that milestone's items */
  milestone?: string;
}

/** `<data>/repos/<repo key>/gates.jsonl`, beside the repo's knowledge.md. */
export const gatesFile = (toplevel: string): string => join(repoDir(toplevel), "gates.jsonl");
const stepsFile = (run: Run): string => join(run.dir, "verifier.jsonl");

/** Repo-relative paths, `.` for the whole repo; anything that leaves the repo is refused. */
function cleanPaths(paths: string[]): string[] {
  try {
    return [...new Set(paths.map((p) => (p.trim() === "." ? "." : normalizeOwned(p))))].sort();
  } catch (e) {
    if (isCatherdError(e))
      throw new CatherdError("E_INPUT_INVALID", e.message.replace("owned path", "gate path"), {
        fix: "pass repo-relative paths, like src/ or package.json, or . for the whole repo",
      });
    throw e;
  }
}

const sha = (b: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

const tooMany = (p: string) =>
  new CatherdError("E_INPUT_INVALID", `gate path ${p} holds more than ${GATE_WALK_MAX} files to hash`, {
    fix: "name narrower paths: the files or directories under it that the gate item reads",
  });

/** How many files one gate path's hash has read so far, against GATE_WALK_MAX, and the realpaths it walked. */
interface Budget {
  path: string;
  files: number;
  seen: Set<string>;
}

const count = (b: Budget): void => {
  if (++b.files > GATE_WALK_MAX) throw tooMany(b.path);
};

/**
 * What a symlink points at, by content only (never its path, which may be outside the repo): a file by its
 * type, exec bit and bytes; a directory walked, names relative to it; "dangling" when nothing is there; and
 * "cycle" for a realpath this hash already walked.
 */
async function targetEntry(link: string, b: Budget): Promise<string> {
  let real: string;
  try {
    real = realpathSync(link);
  } catch {
    return "dangling";
  }
  if (b.seen.has(real)) return "cycle";
  b.seen.add(real);
  const s = statSync(real);
  if (s.isFile()) return `${s.mode & 0o111 ? "exec" : "file"} ${sha(await Bun.file(real).bytes())}`;
  if (!s.isDirectory()) return "other";
  const h = new Bun.CryptoHasher("sha256");
  const visit = async (rel: string): Promise<void> => {
    for (const name of readdirSync(join(real, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      let e: Stats;
      try {
        e = lstatSync(join(real, r));
      } catch {
        continue;
      }
      if (e.isDirectory()) {
        await visit(r);
        continue;
      }
      count(b);
      h.update(`${r}=${await diskEntry(join(real, r), b)}\n`);
    }
  };
  await visit("");
  return `dir ${h.digest("hex")}`;
}

/**
 * One path on disk as git would store it: its type and exec bit as well as its bytes, so a lost exec bit or a
 * file turned symlink is new content; a symlink by its link text and by what it points at (targetEntry), so
 * editing a link's target is new content too.
 */
async function diskEntry(file: string, b: Budget): Promise<string> {
  let s: Stats;
  try {
    s = lstatSync(file);
  } catch {
    return "gone";
  }
  if (s.isSymbolicLink()) return `link ${sha(readlinkSync(file))} -> ${await targetEntry(file, b)}`;
  if (!s.isFile()) return s.isDirectory() ? "dir" : "other";
  return `${s.mode & 0o111 ? "exec" : "file"} ${sha(await Bun.file(file).bytes())}`;
}

/** One dirty path's entry, with its own budget and cycle guard. */
const dirtyEntry = (file: string, path: string): Promise<string> =>
  diskEntry(file, { path, files: 0, seen: new Set() });

/** Whether `file` is a symlink on disk. */
const isLink = (file: string): boolean => {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Whether git ignores `p` (a tracked file never is). */
async function ignored(repo: string, p: string): Promise<boolean> {
  const bare = p.replace(/\/$/, "");
  const asked = async (q: string) => (await git(repo, ["check-ignore", "-q", "--", q])).kind === "ok";
  // a directory pattern (`dist/`) matches a path that is not on disk yet only through a child of it
  return (await asked(bare)) || (!onDisk(join(repo, bare)) && (await asked(`${bare}/.catherd`)));
}

/** The most files a gate path's on-disk walk hashes. */
export const GATE_WALK_MAX = 10_000;

/**
 * The files under `p` on disk (itself when it is not a directory), repo-relative and sorted; a symlink is
 * an entry, not followed. More than GATE_WALK_MAX is refused, not hashed in part.
 */
function walk(repo: string, p: string): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    let s: Stats;
    try {
      s = lstatSync(join(repo, rel));
    } catch {
      return;
    }
    if (!s.isDirectory()) {
      out.push(rel);
      if (out.length > GATE_WALK_MAX) throw tooMany(p);
      return;
    }
    for (const name of readdirSync(join(repo, rel))) visit(`${rel}/${name}`);
  };
  visit(p.replace(/\/$/, ""));
  return out.sort();
}

/**
 * The lockfiles a gate item's dependencies come from, wherever the repo tracks them: they stand in for
 * `node_modules` and the toolchain caches, which a gate path never needs to name (plan 23).
 */
export const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "go.sum",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
];

/** `git ls-files -s -z` for `pathspecs`: each tracked file's mode, object id, stage and path, as the index holds them. */
async function tracked(repo: string, pathspecs: string[]): Promise<string> {
  const r = await git(repo, ["ls-files", "-s", "-z", "--", ...pathspecs]);
  if (r.kind !== "ok")
    throw new CatherdError(
      "E_IO_UNEXPECTED",
      `git ls-files ${r.kind === "timed-out" ? "timed out" : "failed"} in ${repo}`,
      { fix: `check that git works in ${repo}` },
    );
  return r.out;
}

/** Whether anything is at `file` on disk, a dangling symlink included. */
const onDisk = (file: string): boolean => {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/**
 * The content hash of `paths` (plan 23, a monorepo gate): the tracked files under each one, from `git ls-files -s`
 * (mode, object id and path, so a committed chmod -x is new content), the repo's tracked lockfiles, and the
 * content of every uncommitted change under them, so a verifier checking a tree not yet committed gets a hash of
 * what it ran. An ignored path named explicitly (a `.env`, a build output, a `node_modules` folder) is hashed
 * from disk, file by file within GATE_WALK_MAX, and as "absent" while it is not there; ignored files under `.`
 * or under a tracked directory are never walked. A named symlink is hashed by what it points at too.
 */
async function contentHash(repo: string, paths: string[]): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  // a dependency bump reaches every gate item through its lockfile
  h.update(
    `locks=${sha(
      await tracked(
        repo,
        LOCKFILES.map((l) => `:(glob)**/${l}`),
      ),
    )}\n`,
  );
  for (const p of paths) {
    const bare = p.replace(/\/$/, "");
    const listed = await tracked(repo, [p === "." ? "." : bare]);
    const there = p === "." || onDisk(join(repo, bare));
    const isIgnored = p !== "." && listed === "" && (await ignored(repo, p));
    // a mistyped path (or a glob) would hash as a constant and carry a pass forever; an ignored output that
    // is not built yet is part of the content, as "absent"
    if (listed === "" && !there && !isIgnored)
      throw new CatherdError(
        "E_INPUT_INVALID",
        `gate path ${p} exists neither at HEAD nor in the working tree`,
        {
          fix: "check the spelling: pass repo-relative files or directories that exist, like src/ or package.json (no globs); a git-ignored output not built yet is fine",
        },
      );
    h.update(`${p}=${listed ? sha(listed) : there ? "untracked" : "absent"}\n`);
    // git status leaves ignored files out, so an ignored path named here is hashed by what is on disk; "."
    // keeps to the index and the not-ignored status. A tracked symlink's index entry is only its link text,
    // so a named symlink is hashed from disk too, by what it points at
    if (p !== "." && there && (isIgnored || isLink(join(repo, bare)))) {
      // one budget per gate path: its walk and every symlink target it follows count against GATE_WALK_MAX
      const budget: Budget = { path: p, files: 0, seen: new Set() };
      for (const f of walk(repo, p)) h.update(`disk ${f}=${await diskEntry(join(repo, f), budget)}\n`);
    }
  }
  const dirty = Object.keys(await statusSnapshot(repo))
    .filter((f) => paths.includes(".") || overlaps([f], paths).length > 0)
    .sort();
  for (const f of dirty) h.update(`dirty ${f}=${await dirtyEntry(join(repo, f), f)}\n`);
  return h.digest("hex");
}

const readPasses = (repo: string): GatePass[] =>
  readJsonl<unknown>(gatesFile(repo)).rows.flatMap((row) => {
    const r = GatePassSchema.safeParse(row);
    return r.success ? [r.data] : [];
  });

function recordStep(run: Run, step: VerifierStep): void {
  const file = stepsFile(run);
  ensureJsonlHeader(file, "verifier");
  appendJsonl(file, step);
}

/** The verifier's latest step in this run, for `status` and `peek`; null before its first gate_check. */
export function latestVerifierStep(run: Run): VerifierStep | null {
  return (readJsonl<VerifierStep>(stepsFile(run))
    .rows.filter((r) => typeof r?.item === "string")
    .at(-1) ?? null) as VerifierStep | null;
}

/** One item the verifier checked for a milestone in this run: its name, its command, and whether it passed. */
export interface RecordedItem {
  item: string;
  command: string | null;
  /** carried over at its last check, or a gate_pass of this run recorded since that check */
  passed: boolean;
}

/**
 * The items checked for milestone `m` in this run, in the order they were first checked (plan 23): a new
 * verifier reuses their names, so the ledger carries what passed, and a re-check starts from the failed ones.
 */
export function recordedItems(run: Run, m: string): RecordedItem[] {
  const steps = readJsonl<VerifierStep>(stepsFile(run)).rows.filter(
    (s) => typeof s?.item === "string" && s.milestone === m,
  );
  const passes = readPasses(run.meta.repo).filter((p) => p.run === run.id);
  return [...new Set(steps.map((s) => s.item))].map((item) => {
    const last = steps.findLast((s) => s.item === item) as VerifierStep;
    const passed =
      last.carried || passes.some((p) => p.item === item && Date.parse(p.at) >= Date.parse(last.at));
    return { item, command: last.command ?? null, passed };
  });
}

/** A re-check's cap on each command, in minutes: a hung command fails its item instead of the verifier (plan 23). */
export const RECHECK_COMMAND_MIN = 10;

/** The milestone's checked items that have not passed since their last check: what a re-check runs first. */
export const failedItems = (run: Run, m: string): string[] =>
  recordedItems(run, m)
    .filter((r) => !r.passed)
    .map((r) => r.item);

/**
 * `gate_check`: carried when this repo has a pass with the same command on the same content of `paths`;
 * records "verifier step: <item>" either way. With `milestone` it also lists the milestone's recorded items
 * (plan 23), so a verifier reuses the names an earlier one checked.
 */
export async function gateCheck(
  deps: Deps,
  i: { run: string; item: string; command: string; paths: string[]; milestone?: string },
): Promise<
  ({ carried: true; passedAt: string; commit: string } | { carried: false }) & { recorded?: RecordedItem[] }
> {
  const run = findRun(i.run);
  const paths = cleanPaths(i.paths);
  const hash = await contentHash(run.meta.repo, paths);
  const pass = readPasses(run.meta.repo).findLast((p) => p.command === i.command && p.hash === hash);
  recordStep(run, {
    at: new Date(deps.now()).toISOString(),
    item: i.item,
    command: i.command,
    carried: pass !== undefined,
    ...(pass ? { commit: pass.commit } : {}),
    ...(i.milestone ? { milestone: i.milestone } : {}),
  });
  const carried = pass
    ? { carried: true as const, passedAt: pass.at, commit: pass.commit }
    : { carried: false as const };
  return i.milestone ? { ...carried, recorded: recordedItems(run, i.milestone) } : carried;
}

/** `gate_check` with a milestone and no item: the milestone's recorded items, recording no step. */
export function gateList(i: { run: string; milestone: string }): { recorded: RecordedItem[] } {
  return { recorded: recordedItems(findRun(i.run), i.milestone) };
}

/** `gate_check` as both MCP servers expose it: item, command and paths together check an item; none of them,
 * with a milestone, lists the milestone's recorded items. */
export async function gateCheckOrList(
  deps: Deps,
  a: { run: string; item?: string; command?: string; paths?: string[]; milestone?: string },
): Promise<unknown> {
  if (a.item === undefined && a.command === undefined && a.paths === undefined) {
    if (!a.milestone)
      throw new CatherdError("E_INPUT_INVALID", "gate_check needs an item, or a milestone to list", {
        fix: "pass item, command and paths to check an item, or only run and milestone to list the recorded items",
      });
    return gateList({ run: a.run, milestone: a.milestone });
  }
  if (a.item === undefined || a.command === undefined || a.paths === undefined)
    throw new CatherdError("E_INPUT_INVALID", "gate_check needs item, command and paths together", {
      fix: "pass all three to check an item, or none of them (with milestone) to list the recorded items",
    });
  return gateCheck(deps, { ...a, item: a.item, command: a.command, paths: a.paths });
}

/** `gate_pass`: records that `command` passed on the current content of `paths`, with its evidence. */
export async function gatePass(
  deps: Deps,
  i: { run: string; item: string; command: string; paths: string[]; evidence: string },
): Promise<{ recorded: true; hash: string; commit: string }> {
  const run = findRun(i.run);
  const paths = cleanPaths(i.paths);
  const hash = await contentHash(run.meta.repo, paths);
  const commit = (await gitHead(run.meta.repo)) ?? "none";
  const file = gatesFile(run.meta.repo);
  ensureJsonlHeader(file, "gates");
  appendJsonl(file, {
    at: new Date(deps.now()).toISOString(),
    run: run.id,
    item: i.item,
    command: i.command,
    paths,
    hash,
    commit,
    evidence: i.evidence,
  } satisfies GatePass);
  return { recorded: true, hash, commit };
}
