import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { type Budget, budgetStatus } from "../domain/budget.ts";
import { CatherdError } from "../domain/errors.ts";
import { WORKSPACE_LIMIT, WorkspaceIdSchema, WorkspaceSchema, type Workspace } from "../domain/workspace.ts";
import { withFileLock } from "../infra/filelock.ts";
import { gitToplevel } from "../infra/git.ts";
import { readVersioned, writeTextAtomic } from "../infra/store.ts";
import { listDispatches } from "./dispatches.ts";
import { landedCommits, landedMilestones } from "./milestones.ts";
import type { Deps } from "./ports.ts";
import { createRun, readRecords, type Run } from "./run-store.ts";
import { claimRun, currentSession } from "./sessions.ts";
import { refreshState } from "./state.ts";
import { summarizeRun } from "./summary.ts";
import { workspaceSpend } from "./workspace-admission.ts";
import {
  createWorkspace,
  findWorkspace,
  workspaceChildren,
  workspaceDirectory,
  workspacePaths,
} from "./workspace-store.ts";

const ManifestSchema = z.strictObject({
  schema: z.literal(1),
  repos: z
    .record(WorkspaceIdSchema, z.string().min(1))
    .refine((repos) => Object.keys(repos).length <= WORKSPACE_LIMIT),
});
const invalid = (message: string) => new CatherdError("E_INPUT_INVALID", message);

function registry(root: string, repos?: Record<string, string>): Record<string, string> {
  if (repos !== undefined) {
    const parsed = ManifestSchema.safeParse({ schema: 1, repos });
    if (!parsed.success) throw invalid("workspace repositories require safe aliases and nonempty paths");
    return parsed.data.repos;
  }
  return readVersioned(join(root, "catherd.workspace.json"), ManifestSchema, 1).repos;
}

function workspaceRoot(root: string): string {
  try {
    const real = realpathSync(root);
    if (!statSync(real).isDirectory()) throw new Error("not a directory");
    return real;
  } catch {
    throw new CatherdError("E_IO_PATH", `workspace root is not an existing directory: ${root}`);
  }
}

/** No repository discovery scan: paths are an explicit registry, relative to the workspace root. */
export async function inspectWorkspace(
  root: string,
  repos?: Record<string, string>,
): Promise<{ root: string; repos: Record<string, string> }> {
  root = workspaceRoot(root);
  const declared = registry(root, repos);
  if (!Object.keys(declared).length) throw invalid("workspace requires at least one repository");
  const canonical: Record<string, string> = {};
  for (const [alias, path] of Object.entries(declared)) {
    const top = await gitToplevel(resolve(root, path));
    if (!top)
      throw new CatherdError(
        "E_IO_PATH",
        `workspace repository ${alias} is not inside a git repository: ${path}`,
      );
    const real = realpathSync(top);
    if (Object.values(canonical).includes(real))
      throw invalid(`workspace repository ${alias} duplicates a canonical git root`);
    canonical[alias] = real;
  }
  return { root, repos: canonical };
}

export async function startWorkspace(
  deps: Deps,
  input: {
    root: string;
    title: string;
    aLines: string[];
    repos?: Record<string, string>;
    steps: Array<{
      id: string;
      repo: string;
      title: string;
      aLines: string[];
      dependsOn?: string[];
      milestone?: string;
    }>;
    budget?: Budget;
  },
): Promise<{ workspace: Workspace; dir: string }> {
  const root = workspaceRoot(input.root);
  const declared = registry(root, input.repos);
  // Only selected repositories are captured. An unused unavailable checkout cannot block this task.
  const selected: Record<string, string> = {};
  for (const step of input.steps) {
    if (!Object.hasOwn(declared, step.repo)) throw invalid(`unknown workspace repository ${step.repo}`);
    selected[step.repo] = declared[step.repo]!;
  }
  const snapshot = WorkspaceSchema.safeParse({
    schema: 1,
    id: "validation",
    root,
    title: input.title,
    aLines: input.aLines,
    createdAt: new Date(deps.now()).toISOString(),
    repos: selected,
    steps: input.steps,
    budget: input.budget ?? deps.profiles.budgetFor?.(null) ?? deps.profiles.forRepo(null).budget,
  });
  if (!snapshot.success)
    throw invalid(
      "workspace requires unique step ids, ordered repository reuse, valid budget, and an acyclic dependency graph",
    );
  const canonical = await inspectWorkspace(root, selected);
  const workspace = createWorkspace({ ...snapshot.data, repos: canonical.repos }, new Date(deps.now()));
  return { workspace, dir: workspaceDirectory(workspace.id) };
}

function pending(run: Run): boolean {
  const { records, corrupt } = readRecords(run);
  if (corrupt) throw new CatherdError("E_RUN_CORRUPT", `run ${run.id} has unreadable cost records`);
  const recorded = new Set(records.map((r) => r.dispatchId));
  return listDispatches(run, true).some((d) => !recorded.has(d.admit.dispatchId));
}

function completion(children: Run[]): Map<string, { landed: string[]; pending: boolean }> {
  return new Map(
    children.map((child) => [
      child.meta.workspace!.step,
      {
        landed: landedMilestones(child),
        pending: pending(child),
      },
    ]),
  );
}

export function workspaceStepBlockedBy(
  workspace: Workspace,
  stepId: string,
  children = workspaceChildren(workspace),
  evidence = completion(children),
): string[] {
  const step = workspace.steps.find((s) => s.id === stepId);
  if (!step) throw invalid(`unknown workspace step ${stepId}`);
  return step.dependsOn.filter((id) => {
    const predecessor = workspace.steps.find((s) => s.id === id)!;
    const child = evidence.get(id);
    return !child || !child.landed.includes(predecessor.milestone) || child.pending;
  });
}

export async function startWorkspaceChild(
  deps: Deps,
  input: { workspace: string; step: string },
): Promise<{ run: string; dir: string; contract: string | null }> {
  const workspace = findWorkspace(input.workspace);
  const paths = workspacePaths(workspaceDirectory(workspace.id));
  return withFileLock(paths.admission, async () => {
    const children = workspaceChildren(workspace);
    const step = workspace.steps.find((s) => s.id === input.step);
    if (!step) throw invalid(`unknown workspace step ${input.step}`);
    // Recovery must validate the checkout too; stored status remains readable without it.
    const repo = workspace.repos[step.repo]!;
    if ((await gitToplevel(repo)) !== repo)
      throw new CatherdError(
        "E_IO_PATH",
        `workspace repository ${step.repo} is no longer the captured git root`,
      );
    let run = children.find((r) => r.meta.workspace?.step === step.id);
    if (!run) {
      const blockedBy = workspaceStepBlockedBy(workspace, step.id, children);
      if (blockedBy.length) throw invalid(`workspace step ${step.id} waits for ${blockedBy.join(", ")}`);
      const budget = budgetStatus(await workspaceSpend(workspace, deps.now(), children), workspace.budget);
      if (budget && budget.fraction >= 1) throw new CatherdError("E_RUN_BUDGET", "workspace budget is spent");
      run = createRun({
        repo,
        title: step.title,
        aLines: step.aLines,
        version: deps.version,
        now: new Date(deps.now()),
        startedBy: currentSession(deps),
        workspace: { id: workspace.id, step: step.id },
      });
    }
    const contract = existsSync(paths.contract) ? join(run.dir, "workspace-contract.md") : null;
    if (contract && !existsSync(contract)) writeTextAtomic(contract, readFileSync(paths.contract, "utf8"));
    await claimRun(deps, run);
    await refreshState(run);
    return { run: run.id, dir: run.dir, contract };
  });
}

export async function workspaceStatus(deps: Deps, id: string) {
  const workspace = findWorkspace(id);
  const children = workspaceChildren(workspace);
  const evidence = completion(children);
  const steps = workspace.steps.map((step) => {
    const child = children.find((r) => r.meta.workspace?.step === step.id);
    const summary = child ? summarizeRun(deps, child) : null;
    const facts = evidence.get(step.id);
    const landed = facts?.landed ?? [];
    const blockedBy = workspaceStepBlockedBy(workspace, step.id, children, evidence);
    const state: "waiting" | "ready" | "active" | "landed" = child
      ? landed.includes(step.milestone) && !facts?.pending
        ? "landed"
        : "active"
      : blockedBy.length
        ? "waiting"
        : "ready";
    return {
      id: step.id,
      repo: step.repo,
      state,
      run: child?.id ?? null,
      blockedBy,
      landedMilestones: landed,
      landedCommits: child ? landedCommits(child) : [],
      failures: summary?.totals.notOk ?? [],
      questions: summary?.questions ?? [],
      live: summary?.live ?? [],
      childBudget: summary?.budget ?? null,
      warnings: summary?.warnings ?? [],
    };
  });
  const spend = await workspaceSpend(workspace, deps.now(), children);
  return {
    workspace,
    dir: workspaceDirectory(id),
    steps,
    spend,
    budget: budgetStatus(spend, workspace.budget),
  };
}
