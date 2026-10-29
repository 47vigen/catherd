import { copyFileSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchCheck } from "../domain/architect-state.ts";
import { CatherdError } from "../domain/errors.ts";
import { checkFailLines, checkVerdict, markParts, newFails } from "../domain/fail-lines.ts";
import type { RunEventInput } from "../domain/run-events.ts";
import { db, ensureRunRow, insertCheck } from "../infra/db.ts";
import { git, worktreeIdentity } from "../infra/git.ts";
import { heavySlots, LOCK_HELD_ENV, type LockWait, withHeavySlot } from "../infra/heavy-lock.ts";
import { writeTextAtomic } from "../infra/store.ts";
import type { Deps } from "./ports.ts";
import { checkEnvFor, runCheck } from "./check-command.ts";
import { runProfile } from "./run-pin.ts";
import type { Run } from "./run-store.ts";
import { setUp } from "./run-tree.ts";
import { runTree } from "./tree-path.ts";

type CheckDone = Extract<RunEventInput, { type: "check.done" }>;

interface Row {
  check_id: string;
  exit: number | null;
  failures: string;
  verdict: string | null;
}

/** A base row's verdict column: `unknown` marks a failure set that cannot be compared (cut, or a part before the last failed). */
const NOT_COMPARABLE = "unknown";

/**
 * A passing result on the same tree (a base result on the same commit, any exit but a timeout), reused instead of
 * a rerun.
 */
function cachedRow(run: Run, c: ArchCheck, key: string | null): Row | null {
  if (key === null || c.fresh) return null;
  const sql = c.base
    ? "SELECT check_id, exit, failures, verdict FROM checks WHERE run_id = ? AND command = ? AND base = 1 AND ref = ? AND exit IS NOT NULL ORDER BY id DESC LIMIT 1"
    : "SELECT check_id, exit, failures, verdict FROM checks WHERE run_id = ? AND command = ? AND base = 0 AND tree = ? AND exit = 0 ORDER BY id DESC LIMIT 1";
  return db().query(sql).get(run.id, c.command, key) as Row | null;
}

type BaseResult = { exit: number | null; failures: string[]; comparable: boolean };

/** The latest check of the same command on the base, else null. */
function baseResult(run: Run, command: string): BaseResult | null {
  const r = db()
    .query(
      "SELECT exit, failures, verdict FROM checks WHERE run_id = ? AND command = ? AND base = 1 ORDER BY id DESC LIMIT 1",
    )
    .get(run.id, command) as { exit: number | null; failures: string; verdict: string | null } | null;
  return r
    ? { exit: r.exit, failures: JSON.parse(r.failures) as string[], comparable: r.verdict !== NOT_COMPARABLE }
    : null;
}

/** The env var naming the file the `&&` parts of a check mark when they pass. */
const PARTS_ENV = "CATHERD_PARTS_FILE";

/** The commit a base check runs on: a base run's merge base with origin's base (plan 50), else its start commit. */
export async function baseSha(run: Run, tree: string): Promise<string | null> {
  if (!run.meta.base) return run.meta.startHead ?? null;
  const r = await git(tree, ["merge-base", "HEAD", `origin/${run.meta.base}`]);
  return r.kind === "ok" ? r.out.trim() || null : null;
}

/** HEAD's full sha when the tree has nothing uncommitted, else null: a check result then names it (spec D11). */
async function committedHead(tree: string): Promise<string | null> {
  const status = await git(tree, ["status", "--porcelain"]);
  if (status.kind !== "ok" || status.out.trim() !== "") return null;
  const head = await git(tree, ["rev-parse", "HEAD"]);
  return head.kind === "ok" ? head.out.trim() || null : null;
}

/**
 * The tree's content identity and its committed HEAD, taken together: the head counts only when it is the same
 * before and after the identity, so a result never names a commit the identity does not describe.
 */
async function treeState(tree: string): Promise<{ id: string | null; head: string | null }> {
  const first = await committedHead(tree);
  const id = await worktreeIdentity(tree);
  return { id, head: first !== null && first === (await committedHead(tree)) ? first : null };
}

/**
 * Plan 47, spec D6: a check the architect asked for. It runs on the run's checkout as it stands, or with `base` on a
 * detached tree at the run's start commit, under a heavy slot; a pass on an unchanged tree is reused unless `fresh`.
 * Nothing reruns on its own. The result is a `checks` row and the `check.done` event the caller appends; a failing
 * line the base's check of the same command also had is pre-existing. Plan 52: a failing full check runs the same
 * command on the base itself (`<id>-base`, reused per base commit), and its verdict says whether every failure is
 * inherited.
 */
export async function runArchitectCheck(
  deps: Deps,
  run: Run,
  c: ArchCheck,
  o: { timeoutMs: number; onWait?: (w: LockWait | null) => void; signal?: AbortSignal },
): Promise<CheckDone> {
  return (await execute(deps, run, c, o)).done;
}

/** The trees a check's output may name by absolute path, also under their real paths. */
const rootsOf = (...dirs: string[]): string[] => [
  ...new Set(
    dirs.flatMap((d) => {
      try {
        return [d, realpathSync(d)];
      } catch {
        return [d];
      }
    }),
  ),
];

async function execute(
  deps: Deps,
  run: Run,
  c: ArchCheck,
  o: { timeoutMs: number; onWait?: (w: LockWait | null) => void; signal?: AbortSignal },
): Promise<{ done: CheckDone; comparable: boolean }> {
  const logPath = `checks/${c.checkId}.log`;
  const repo = runTree(run);
  const sha = c.base ? await baseSha(run, repo) : null;
  if (c.base && !sha)
    throw new CatherdError("E_INPUT_INVALID", `run ${run.id} recorded no start commit to check the base on`, {
      fix: "check without base",
    });
  const state = c.base ? null : await treeState(repo);
  const key = c.base ? sha : (state?.id ?? null);
  const at = new Date(deps.now()).toISOString();
  const hit = cachedRow(run, c, key);
  let exit: number | null;
  let failures: string[];
  let comparable = true;
  let minutes = 0;
  let before: { id: string | null; head: string | null } | null = null;
  let tree = key;
  let head = state?.head ?? null;
  if (hit) {
    exit = hit.exit;
    failures = JSON.parse(hit.failures) as string[];
    comparable = hit.verdict !== NOT_COMPARABLE;
    // the digest names this check's log: the source's, copied
    const source = join(run.dir, `checks/${hit.check_id}.log`);
    if (existsSync(source)) copyFileSync(source, join(run.dir, logPath));
    else writeTextAtomic(join(run.dir, logPath), `(from ${hit.check_id}; its log is gone)\n`);
  } else {
    // the check id keeps concurrent base checks off each other's tree
    const cwd = c.base ? join(run.dir, "checks", `base-${(sha as string).slice(0, 12)}-${c.checkId}`) : repo;
    if (c.base) {
      rmSync(cwd, { recursive: true, force: true });
      // a registered tree whose directory is gone would fail every later add
      await git(run.meta.repo, ["worktree", "prune"]);
      const added = await git(run.meta.repo, ["worktree", "add", "--detach", cwd, sha as string]);
      if (added.kind !== "ok") throw new Error(`could not check out the base ${sha}: ${added.kind}`);
    }
    try {
      // the base tree is set up as the run's own tree is (submodules, the plan's Setup:), or it fails on missing deps
      if (c.base) await setUp(deps, run, cwd);
      const env = await checkEnvFor(run.meta.repo);
      const started = Date.now();
      const { script, parts, tracked } = markParts(c.command, `printf . >>"$${PARTS_ENV}"`);
      let marks = 0;
      const r = await withHeavySlot(
        heavySlots(runProfile(deps, run).heavy),
        async (_slot, tmp) => {
          // the tree as the check starts, after the wait for its slot
          if (!c.base) before = await treeState(repo);
          const partsFile = join(tmp, "catherd-parts");
          writeFileSync(partsFile, "");
          const done = await runCheck(
            cwd,
            script,
            o.timeoutMs,
            { ...env, TMPDIR: tmp, GOTMPDIR: tmp, [LOCK_HELD_ENV]: "1", [PARTS_ENV]: partsFile },
            o.signal,
          );
          marks = readFileSync(partsFile).length;
          return done;
        },
        { ...(o.onWait ? { onWait: o.onWait } : {}), ...(o.signal ? { signal: o.signal } : {}) },
      );
      // a stopped check leaves no row: the run is over
      o.signal?.throwIfAborted();
      minutes = (Date.now() - started) / 60_000;
      // a tree that changed while the check waited or ran is not the tree it passed on; the head is the one the
      // identity was taken with, never a later read
      if (!c.base) {
        const b = before as { id: string | null; head: string | null } | null;
        tree = b?.id && b.id === (await worktreeIdentity(repo)) ? b.id : null;
        head = tree !== null ? (b?.head ?? null) : null;
      }
      writeTextAtomic(join(run.dir, logPath), `${r.text}\n`);
      exit = r.code;
      failures = exit === 0 ? [] : checkFailLines(r.text, rootsOf(cwd, repo, run.meta.repo));
      // a chain stopped at its last part only when every earlier part passed
      comparable = !r.cut && tracked && (parts <= 1 || marks === parts - 1);
    } finally {
      if (c.base) await git(run.meta.repo, ["worktree", "remove", "--force", cwd]);
    }
  }
  let base: BaseResult | null = null;
  // a timeout proves nothing about the base, and a fast check compares with a base row that exists, as before
  if (!c.base && c.scope === "full" && exit !== 0 && exit !== null) {
    const own = { ...c, checkId: `${c.checkId}-base`, base: true, fresh: false };
    // a base that cannot be checked (no start commit, a failed checkout or setup) leaves the verdict unknown
    base = await execute(deps, run, own, o).then(
      (b) => ({ exit: b.done.exit, failures: b.done.failures, comparable: b.comparable }),
      () => null,
    );
  } else if (!c.base) base = baseResult(run, c.command);
  const verdict = c.base || c.scope !== "full" ? null : checkVerdict(exit, failures, base, { comparable });
  // a check on a committed tree names its commit, which land reads (spec D11); else "worktree"
  const fresh = newFails(failures, base?.failures ?? null);
  const d = db();
  d.transaction(() => {
    ensureRunRow(d, run);
    insertCheck(d, run.id, {
      checkId: c.checkId,
      scope: c.scope,
      ref: c.base ? (sha as string) : tree !== null && head ? head : "worktree",
      tree: c.base ? null : tree,
      command: c.command,
      base: c.base,
      exit,
      failures,
      minutes,
      cached: hit !== null,
      at,
      verdict: c.base && !comparable ? NOT_COMPARABLE : verdict,
    });
  }).immediate();
  return {
    comparable,
    done: {
      type: "check.done",
      checkId: c.checkId,
      exit,
      failures,
      preExisting: base === null ? [] : failures.filter((f) => !fresh.includes(f)),
      cached: hit !== null,
      ...(verdict === null ? {} : { verdict }),
      minutes,
      logPath,
    },
  };
}
