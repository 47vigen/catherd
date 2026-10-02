import { existsSync, readFileSync } from "node:fs";
import { budgetStatus, formatBudget, type BudgetStatus, type Spend } from "../domain/budget.ts";
import { CatherdError, errorMessage, isCatherdError } from "../domain/errors.ts";
import type { Workspace, WorkspaceStep } from "../domain/workspace.ts";
import { withFileLock } from "../infra/filelock.ts";
import { git, gitToplevel } from "../infra/git.ts";
import { writeTextAtomic } from "../infra/store.ts";
import { spendOf } from "./budget.ts";
import { pendingDispatches } from "./dispatches.ts";
import { landedCommits, landedMilestones } from "./milestones.ts";
import { readRecords, type Run, runPaths } from "./run-store.ts";
import {
  findWorkspace,
  saveWorkspace,
  WORKSPACE_LOCK_WAIT_MS,
  workspaceChildren,
  workspaceDirectory,
  workspacePaths,
} from "./workspace-store.ts";

/**
 * Count each recorded or unrecorded dispatch once; elapsed minutes belong to the parent and start at its first
 * child (#43 finding 4), none before one. With `warnings`, a child whose cost evidence cannot be read is
 * skipped and named there (status); without, it throws E_RUN_CORRUPT (admission against a cap, which cannot
 * prove the cap holds without it).
 */
export async function workspaceSpend(
  workspace: Workspace,
  now: number,
  children = workspaceChildren(workspace),
  warnings?: string[],
): Promise<Spend> {
  const first = Math.min(...children.map((c) => Date.parse(c.meta.createdAt)).filter(Number.isFinite));
  const total: Spend = {
    minutes: Number.isFinite(first) ? Math.max(0, (now - first) / 60_000) : 0,
    tokens: 0,
    usd: 0,
  };
  for (const child of children) {
    try {
      const spent = await withFileLock(runPaths(child.dir).runs, () => {
        const { records, corrupt } = readRecords(child);
        if (corrupt) throw new CatherdError("E_RUN_CORRUPT", `run ${child.id} has unreadable cost records`);
        return spendOf(child, records, pendingDispatches(child, now, records, true), now, true);
      });
      total.tokens += spent.tokens;
      total.usd += spent.usd;
    } catch (e) {
      if (!warnings || !isCatherdError(e) || e.code !== "E_RUN_CORRUPT") throw e;
      warnings.push(`spend leaves out ${child.id}: ${errorMessage(e)}`);
    }
  }
  return total;
}

/** The workspace budget a child run's routing sees; a child whose evidence is unreadable counts nothing. */
export async function workspaceBudget(run: Run, now: number): Promise<BudgetStatus | null> {
  if (!run.meta.workspace) return null;
  const workspace = findWorkspace(run.meta.workspace.id);
  return budgetStatus(await workspaceSpend(workspace, now, undefined, []), workspace.budget);
}

/** Why a dependency keeps a step waiting: the dependency's step id and the reason, in words. */
export interface Blocker {
  step: string;
  why: string;
}

/** The dependency's uncollected dispatches, read under its records lock: a reason, or null when none. */
async function uncollected(child: Run, now: number): Promise<string | null> {
  const step = child.meta.workspace?.step ?? child.id;
  try {
    const pending = await withFileLock(runPaths(child.dir).runs, () => {
      const { records, corrupt } = readRecords(child);
      if (corrupt) throw new CatherdError("E_RUN_CORRUPT", `run ${child.id} has unreadable dispatch records`);
      return pendingDispatches(child, now, records, true);
    });
    return pending.length
      ? `${step} has ${pending.length} dispatch(es) not collected (${pending.map((d) => d.admit.name).join(", ")})`
      : null;
  } catch (e) {
    if (isCatherdError(e) && e.code === "E_RUN_CORRUPT") return `${step} cannot be read: ${e.message}`;
    throw e;
  }
}

/** A landed milestone that differs from the step's only by case: `m1` for `M1` (#43 finding 7). */
const caseTwin = (landed: string[], milestone: string): string | undefined =>
  landed.find((m) => m !== milestone && m.toLowerCase() === milestone.toLowerCase());

/**
 * #43 finding 8: the one dependency rule admission, child start and status share. A dependency releases its
 * dependents once its child has landed the dependency's milestone and every dispatch it admitted is
 * collected. Reads only the dependencies' own evidence (#43 finding 2); an unreadable one blocks, named.
 */
export async function dependencyBlockers(
  workspace: Workspace,
  step: WorkspaceStep,
  children: Run[],
  now: number,
  o: { merge?: boolean } = {},
): Promise<Blocker[]> {
  const out: Blocker[] = [];
  for (const id of step.dependsOn) {
    const before = workspace.steps.find((s) => s.id === id);
    const child = children.find((c) => c.meta.workspace?.step === id);
    if (!before || !child) {
      out.push({ step: id, why: `${id} has not started` });
      continue;
    }
    const landed = landedMilestones(child);
    if (!landed.includes(before.milestone)) {
      const twin = caseTwin(landed, before.milestone);
      out.push({
        step: id,
        why: `${id} has not landed ${before.milestone}${twin ? ` (it landed ${twin}: the step completes on ${before.milestone})` : ""}`,
      });
      continue;
    }
    const why = (await uncollected(child, now)) ?? (o.merge ? await unmerged(before, child) : null);
    if (why) out.push({ step: id, why });
  }
  return out;
}

/** The commit the ledger holds for `milestone`, its latest landing; null when it never landed. */
function landedCommitOf(run: Run, milestone: string): string | null {
  const commits = landedCommits(run);
  const milestones = landedMilestones(run);
  const at = milestones.lastIndexOf(milestone);
  return at < 0 ? null : (commits[at] ?? null);
}

/**
 * A `release: "merge"` step releases its dependents once its landed commit is an ancestor of its base ref
 * (`git merge-base --is-ancestor`), in the repository as it stands: catherd never fetches or polls.
 */
async function unmerged(step: WorkspaceStep, child: Run): Promise<string | null> {
  if (step.release !== "merge" || !step.base) return null;
  const commit = landedCommitOf(child, step.milestone);
  if (!commit) return `${step.id} has no landed commit for ${step.milestone} in its ledger`;
  const r = await git(child.meta.repo, ["merge-base", "--is-ancestor", commit, step.base]);
  if (r.kind === "ok") return null;
  if (r.kind === "failed" && r.exit === 1)
    return `${step.id}'s ${step.milestone} (${commit.slice(0, 7)}) is not merged into ${step.base} yet: merge it, git fetch, then ask again`;
  return `${step.id}: git cannot tell whether ${commit.slice(0, 7)} is in ${step.base} (does the ref exist in ${child.meta.repo}?)`;
}

export function withRunAdmission<T>(run: Run, now: () => number, admit: () => Promise<T>): Promise<T> {
  return withWorkspaceAdmission(run, now, () => withFileLock(runPaths(run.dir).admission, admit));
}

/** Parent → child admission → child records; siblings share the actual admission boundary. */
export async function withWorkspaceAdmission<T>(
  run: Run,
  clock: number | (() => number),
  admit: () => Promise<T>,
): Promise<T> {
  const link = run.meta.workspace;
  if (!link) return admit();
  const workspace = findWorkspace(link.id);
  // git outside the workspace lock (#43 finding 5): the checkout check needs no sibling to wait
  if ((await gitToplevel(run.meta.repo)) !== run.meta.repo)
    throw new CatherdError(
      "E_IO_PATH",
      `workspace repository of ${link.step} is no longer the captured git root`,
    );
  return withFileLock(
    workspacePaths(workspaceDirectory(workspace.id)).admission,
    async () => {
      const now = typeof clock === "function" ? clock() : clock;
      const children = workspaceChildren(workspace);
      const step = workspace.steps.find((s) => s.id === link.step);
      if (!step || !children.some((c) => c.id === run.id))
        throw new CatherdError("E_INPUT_INVALID", "the run is not a member of this workspace execution", {
          fix: "start the child with workspace_child_start",
        });
      // #43 finding 7: a landed step's child admits again (a post-land fix); its dependents wait for it
      const blockers = await dependencyBlockers(workspace, step, children, now);
      if (blockers.length)
        throw new CatherdError(
          "E_INPUT_INVALID",
          `${step.id} is waiting: ${blockers.map((b) => b.why).join("; ")}`,
          {
            fix: "land the dependency's completion milestone and collect its finished dispatches first",
          },
        );
      await assertWorkspaceBudget(workspace, now, children);
      return admit();
    },
    { timeoutMs: WORKSPACE_LOCK_WAIT_MS },
  );
}

/** Whether the budget caps anything: without a cap, no sibling's evidence is read (#43 finding 2). */
const capped = (workspace: Workspace): boolean =>
  Object.values(workspace.budget).some((v) => typeof v === "number");

/** Refuses E_RUN_BUDGET once a capped workspace budget is spent; reads every child only when capped. */
export async function assertWorkspaceBudget(
  workspace: Workspace,
  now: number,
  children: Run[],
): Promise<void> {
  if (!capped(workspace)) return;
  const budget = budgetStatus(await workspaceSpend(workspace, now, children), workspace.budget);
  if (budget && budget.fraction >= 1)
    throw new CatherdError("E_RUN_BUDGET", `the workspace budget is spent: ${formatBudget(budget)}`, {
      fix: `finish with the work already admitted, or raise it: workspace_budget(${workspace.id}, …)`,
    });
}

/**
 * `workspace_budget`: sets the caps given (a number) or removes them (null), keeping the others; the owner's
 * way to raise a spent budget without a new workspace (#43 finding 4). Returns the budget and its status.
 */
export async function setWorkspaceBudget(
  deps: { now: () => number },
  i: { workspace: string; minutes?: number | null; tokens?: number | null; usd?: number | null },
): Promise<{ budget: Workspace["budget"]; spend: Spend; status: BudgetStatus | null }> {
  const workspace = findWorkspace(i.workspace);
  return withFileLock(
    workspacePaths(workspaceDirectory(workspace.id)).admission,
    async () => {
      const budget: Workspace["budget"] = { ...findWorkspace(workspace.id).budget };
      for (const key of ["minutes", "tokens", "usd"] as const) {
        const v = i[key];
        if (v === null) delete budget[key];
        else if (v !== undefined) budget[key] = v;
      }
      const saved = saveWorkspace({ ...findWorkspace(workspace.id), budget });
      const spend = await workspaceSpend(saved, deps.now(), undefined, []);
      return { budget: saved.budget, spend, status: budgetStatus(spend, saved.budget) };
    },
    { timeoutMs: WORKSPACE_LOCK_WAIT_MS },
  );
}

/** The shared contract is frozen when the first child starts, then copied into child dossiers. */
export async function workspaceContract(i: {
  workspace: string;
  content?: string;
}): Promise<{ path: string; content: string }> {
  const workspace = findWorkspace(i.workspace);
  const paths = workspacePaths(workspaceDirectory(workspace.id));
  if (i.content === undefined)
    return {
      path: paths.contract,
      content: existsSync(paths.contract) ? readFileSync(paths.contract, "utf8") : "",
    };
  return withFileLock(
    paths.admission,
    () => {
      if (workspaceChildren(workspace).length)
        throw new CatherdError(
          "E_INPUT_INVALID",
          "the workspace contract is frozen because a child has started",
          {
            fix: "start a new workspace execution to change the shared contract",
          },
        );
      writeTextAtomic(paths.contract, i.content as string);
      return { path: paths.contract, content: i.content as string };
    },
    { timeoutMs: WORKSPACE_LOCK_WAIT_MS },
  );
}
