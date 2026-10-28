import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ArchCheck } from "../domain/architect-state.ts";
import { CatherdError } from "../domain/errors.ts";
import { checkFailLines, newFails } from "../domain/fail-lines.ts";
import type { RunEventInput } from "../domain/run-events.ts";
import { db, ensureRunRow, insertCheck } from "../infra/db.ts";
import { git, worktreeIdentity } from "../infra/git.ts";
import { heavySlots, LOCK_HELD_ENV, type LockWait, withHeavySlot } from "../infra/heavy-lock.ts";
import { writeTextAtomic } from "../infra/store.ts";
import type { Deps } from "./ports.ts";
import { checkEnvFor, runCheck } from "./preflight.ts";
import { runProfile } from "./run-pin.ts";
import type { Run } from "./run-store.ts";

type CheckDone = Extract<RunEventInput, { type: "check.done" }>;

interface Row {
  check_id: string;
  exit: number | null;
  failures: string;
}

/** A passing result on the same tree (a base result on the same commit, any exit), reused instead of a rerun. */
function cachedRow(run: Run, c: ArchCheck, key: string | null): Row | null {
  if (key === null || c.fresh) return null;
  const sql = c.base
    ? "SELECT check_id, exit, failures FROM checks WHERE run_id = ? AND command = ? AND base = 1 AND ref = ? ORDER BY id DESC LIMIT 1"
    : "SELECT check_id, exit, failures FROM checks WHERE run_id = ? AND command = ? AND base = 0 AND tree = ? AND exit = 0 ORDER BY id DESC LIMIT 1";
  return db().query(sql).get(run.id, c.command, key) as Row | null;
}

/** The failing lines of the latest check of the same command on the base, else null. */
function baseFailures(run: Run, command: string): string[] | null {
  const r = db()
    .query(
      "SELECT failures FROM checks WHERE run_id = ? AND command = ? AND base = 1 ORDER BY id DESC LIMIT 1",
    )
    .get(run.id, command) as { failures: string } | null;
  return r ? (JSON.parse(r.failures) as string[]) : null;
}

/**
 * Plan 47, spec D6: a check the architect asked for. It runs on the run's checkout as it stands, or with `base` on a
 * detached tree at the run's start commit, under a heavy slot; a pass on an unchanged tree is reused unless `fresh`.
 * Nothing reruns on its own. The result is a `checks` row and the `check.done` event the caller appends; a failing
 * line the base's check of the same command also had is pre-existing.
 */
export async function runArchitectCheck(
  deps: Deps,
  run: Run,
  c: ArchCheck,
  o: { timeoutMs: number; onWait?: (w: LockWait | null) => void },
): Promise<CheckDone> {
  const logPath = `checks/${c.checkId}.log`;
  const sha = run.meta.startHead ?? null;
  if (c.base && !sha)
    throw new CatherdError("E_INPUT_INVALID", `run ${run.id} recorded no start commit to check the base on`, {
      fix: "check without base",
    });
  const key = c.base ? sha : await worktreeIdentity(run.meta.repo);
  const at = new Date(deps.now()).toISOString();
  const hit = cachedRow(run, c, key);
  let exit: number | null;
  let failures: string[];
  let minutes = 0;
  let before: string | null = null;
  let tree = key;
  if (hit) {
    exit = hit.exit;
    failures = JSON.parse(hit.failures) as string[];
    // the digest names this check's log: the source's, copied
    const source = join(run.dir, `checks/${hit.check_id}.log`);
    if (existsSync(source)) copyFileSync(source, join(run.dir, logPath));
    else writeTextAtomic(join(run.dir, logPath), `(from ${hit.check_id}; its log is gone)\n`);
  } else {
    // the check id keeps concurrent base checks off each other's tree
    const cwd = c.base
      ? join(run.dir, "checks", `base-${(sha as string).slice(0, 12)}-${c.checkId}`)
      : run.meta.repo;
    if (c.base) {
      rmSync(cwd, { recursive: true, force: true });
      // a registered tree whose directory is gone would fail every later add
      await git(run.meta.repo, ["worktree", "prune"]);
      const added = await git(run.meta.repo, ["worktree", "add", "--detach", cwd, sha as string]);
      if (added.kind !== "ok") throw new Error(`could not check out the base ${sha}: ${added.kind}`);
    }
    try {
      const env = await checkEnvFor(run.meta.repo);
      const started = Date.now();
      const r = await withHeavySlot(
        heavySlots(runProfile(deps, run).heavy),
        async (_slot, tmp) => {
          // the tree as the check starts, after the wait for its slot
          if (!c.base) before = await worktreeIdentity(run.meta.repo);
          return runCheck(cwd, c.command, o.timeoutMs, {
            ...env,
            TMPDIR: tmp,
            GOTMPDIR: tmp,
            [LOCK_HELD_ENV]: "1",
          });
        },
        o.onWait ? { onWait: o.onWait } : {},
      );
      minutes = (Date.now() - started) / 60_000;
      // a tree that changed while the check waited or ran is not the tree it passed on
      if (!c.base && (before === null || before !== (await worktreeIdentity(run.meta.repo)))) tree = null;
      const text = (r.lines.length ? r.lines : r.tail).join("\n");
      writeTextAtomic(join(run.dir, logPath), `${text}\n`);
      exit = r.code;
      failures = exit === 0 ? [] : checkFailLines(text);
    } finally {
      if (c.base) await git(run.meta.repo, ["worktree", "remove", "--force", cwd]);
    }
  }
  const base = c.base ? null : baseFailures(run, c.command);
  const fresh = newFails(failures, base);
  const d = db();
  d.transaction(() => {
    ensureRunRow(d, run);
    insertCheck(d, run.id, {
      checkId: c.checkId,
      scope: c.scope,
      ref: c.base ? (sha as string) : "worktree",
      tree: c.base ? null : tree,
      command: c.command,
      base: c.base,
      exit,
      failures,
      minutes,
      cached: hit !== null,
      at,
    });
  }).immediate();
  return {
    type: "check.done",
    checkId: c.checkId,
    exit,
    failures,
    preExisting: base === null ? [] : failures.filter((f) => !fresh.includes(f)),
    cached: hit !== null,
    minutes,
    logPath,
  };
}
