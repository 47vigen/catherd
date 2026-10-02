import { existsSync, readFileSync } from "node:fs";
import { budgetStatus, formatBudget, type BudgetStatus, type Spend } from "../domain/budget.ts";
import { CatherdError } from "../domain/errors.ts";
import type { Workspace } from "../domain/workspace.ts";
import { withFileLock } from "../infra/filelock.ts";
import { gitToplevel } from "../infra/git.ts";
import { writeTextAtomic } from "../infra/store.ts";
import { spendOf } from "./budget.ts";
import { pendingDispatches } from "./dispatches.ts";
import { landedMilestones } from "./milestones.ts";
import { readRecords, type Run, runPaths } from "./run-store.ts";
import { findWorkspace, workspaceChildren, workspaceDirectory, workspacePaths } from "./workspace-store.ts";

/** Count each recorded or unrecorded dispatch once; elapsed minutes belong to the parent. */
export async function workspaceSpend(
  workspace: Workspace,
  now: number,
  children = workspaceChildren(workspace),
): Promise<Spend> {
  const total: Spend = {
    minutes: Math.max(0, (now - Date.parse(workspace.createdAt)) / 60_000),
    tokens: 0,
    usd: 0,
  };
  for (const child of children) {
    const spent = await withFileLock(runPaths(child.dir).runs, () => {
      const { records, corrupt } = readRecords(child);
      if (corrupt) throw new CatherdError("E_RUN_CORRUPT", `run ${child.id} has unreadable cost records`);
      return spendOf(child, records, pendingDispatches(child, now, records, true), now, true);
    });
    total.tokens += spent.tokens;
    total.usd += spent.usd;
  }
  return total;
}

export async function workspaceBudget(run: Run, now: number): Promise<BudgetStatus | null> {
  if (!run.meta.workspace) return null;
  const workspace = findWorkspace(run.meta.workspace.id);
  return budgetStatus(await workspaceSpend(workspace, now), workspace.budget);
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
  return withFileLock(workspacePaths(workspaceDirectory(workspace.id)).admission, async () => {
    const now = typeof clock === "function" ? clock() : clock;
    const children = workspaceChildren(workspace);
    const step = workspace.steps.find((s) => s.id === link.step);
    if (!step || !children.some((c) => c.id === run.id))
      throw new CatherdError("E_INPUT_INVALID", "the run is not a member of this workspace execution", {
        fix: "start the child with workspace_child_start",
      });
    if ((await gitToplevel(run.meta.repo)) !== run.meta.repo)
      throw new CatherdError(
        "E_IO_PATH",
        `workspace repository ${step.repo} is no longer the captured git root`,
      );
    if (landedMilestones(run).includes(step.milestone))
      throw new CatherdError("E_INPUT_INVALID", `${step.id} has already landed its completion milestone`, {
        fix: "start a new workspace execution for further changes",
      });
    for (const dependency of step.dependsOn) {
      const before = workspace.steps.find((s) => s.id === dependency);
      const child = children.find((c) => c.meta.workspace?.step === dependency);
      if (
        !before ||
        !child ||
        !landedMilestones(child).includes(before.milestone) ||
        pendingDispatches(child, now).length
      )
        throw new CatherdError("E_INPUT_INVALID", `${step.id} is waiting for ${dependency}`, {
          fix: "land the dependency's completion milestone and collect its finished dispatches first",
        });
    }
    const budget = budgetStatus(await workspaceSpend(workspace, now, children), workspace.budget);
    if (budget && budget.fraction >= 1)
      throw new CatherdError("E_RUN_BUDGET", `the workspace budget is spent: ${formatBudget(budget)}`, {
        fix: "finish with the work already admitted, or start a new workspace with an authorized budget",
      });
    return admit();
  });
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
  return withFileLock(paths.admission, () => {
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
  });
}
