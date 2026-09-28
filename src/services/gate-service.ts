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
  carried: boolean;
  /** a carried item: the commit its pass was recorded on */
  commit?: string;
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

/**
 * The content hash of `paths`: each one's git tree (or blob) hash at HEAD, plus the content of every
 * uncommitted change under them, so a verifier checking a tree not yet committed gets a hash of what it ran.
 */
async function contentHash(repo: string, paths: string[]): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for (const p of paths) {
    const r = await git(repo, ["rev-parse", `HEAD:${p === "." ? "" : p.replace(/\/$/, "")}`]);
    h.update(`${p}=${r.kind === "ok" ? r.out.trim() : "missing"}\n`);
  }
  const dirty = Object.keys(await statusSnapshot(repo))
    .filter((f) => paths.includes(".") || overlaps([f], paths).length > 0)
    .sort();
  for (const f of dirty) {
    const file = Bun.file(join(repo, f));
    const body = (await file.exists())
      ? new Bun.CryptoHasher("sha256").update(await file.bytes()).digest("hex")
      : "gone";
    h.update(`dirty ${f}=${body}\n`);
  }
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

/**
 * `gate_check`: carried when this repo has a pass with the same command on the same content of `paths`;
 * records "verifier step: <item>" either way.
 */
export async function gateCheck(
  deps: Deps,
  i: { run: string; item: string; command: string; paths: string[] },
): Promise<{ carried: true; passedAt: string; commit: string } | { carried: false }> {
  const run = findRun(i.run);
  const paths = cleanPaths(i.paths);
  const hash = await contentHash(run.meta.repo, paths);
  const pass = readPasses(run.meta.repo).findLast((p) => p.command === i.command && p.hash === hash);
  recordStep(run, {
    at: new Date(deps.now()).toISOString(),
    item: i.item,
    carried: pass !== undefined,
    ...(pass ? { commit: pass.commit } : {}),
  });
  return pass ? { carried: true, passedAt: pass.at, commit: pass.commit } : { carried: false };
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
