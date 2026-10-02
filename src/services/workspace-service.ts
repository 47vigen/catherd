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
import { assertNotPaused, pausesOver } from "./pause.ts";
import { writePin } from "./run-pin.ts";
import type { Deps } from "./ports.ts";
import { createRun, readRecords, type Run } from "./run-store.ts";
import { claimRun, currentSession } from "./sessions.ts";
import { refreshState } from "./state.ts";
import { summarizeRun } from "./summary.ts";
import { assertWorkspaceBudget, dependencyBlockers, workspaceSpend } from "./workspace-admission.ts";
import {
  createWorkspace,
  findWorkspace,
  unreadableWarning,
  WORKSPACE_LOCK_WAIT_MS,
  workspaceChildren,
  workspaceDirectory,
  workspaceListing,
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
      release?: "land" | "merge";
      base?: string;
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
    // #43 finding 4: no cap unless the owner sets one; each child keeps its own profile budget
    budget: input.budget ?? {},
  });
  if (!snapshot.success)
    throw invalid(
      `workspace requires unique step ids, ordered repository reuse, valid budget, and an acyclic dependency graph: ${snapshot.error.issues[0]?.message ?? "invalid"}`,
    );
  const canonical = await inspectWorkspace(root, selected);
  const workspace = createWorkspace({ ...snapshot.data, repos: canonical.repos }, new Date(deps.now()));
  return { workspace, dir: workspaceDirectory(workspace.id) };
}

/** Whether a child still has dispatches nobody collected; null when its records cannot be read. */
function ownPending(run: Run): boolean | null {
  const { records, corrupt } = readRecords(run);
  if (corrupt) return null;
  const recorded = new Set(records.map((r) => r.dispatchId));
  try {
    return listDispatches(run, true).some((d) => !recorded.has(d.admit.dispatchId));
  } catch {
    return null;
  }
}

export async function startWorkspaceChild(
  deps: Deps,
  input: { workspace: string; step: string },
): Promise<{ run: string; dir: string; contract: string | null }> {
  const workspace = findWorkspace(input.workspace);
  const paths = workspacePaths(workspaceDirectory(workspace.id));
  const step = workspace.steps.find((s) => s.id === input.step);
  if (!step) throw invalid(`unknown workspace step ${input.step}`);
  // Recovery must validate the checkout too; stored status remains readable without it. The git work runs
  // outside the workspace lock (#43 finding 5).
  const repo = workspace.repos[step.repo]!;
  if ((await gitToplevel(repo)) !== repo)
    throw new CatherdError(
      "E_IO_PATH",
      `workspace repository ${step.repo} is no longer the captured git root`,
    );
  const run = await withFileLock(
    paths.admission,
    () => childFor(deps, workspace, step, repo, paths.contract),
    { timeoutMs: WORKSPACE_LOCK_WAIT_MS },
  );
  const contract = existsSync(paths.contract) ? join(run.dir, "workspace-contract.md") : null;
  await claimRun(deps, run);
  await refreshState(run);
  return { run: run.id, dir: run.dir, contract };
}

/** Under the workspace lock: the step's child, created once its dependencies release it. */
async function childFor(
  deps: Deps,
  workspace: Workspace,
  step: Workspace["steps"][number],
  repo: string,
  contractFile: string,
): Promise<Run> {
  const children = workspaceChildren(workspace);
  let run = children.find((r) => r.meta.workspace?.step === step.id);
  if (!run) {
    assertNotPaused({ meta: { workspace: { id: workspace.id, step: step.id } } });
    const blockers = await dependencyBlockers(workspace, step, children, deps.now(), { merge: true });
    if (blockers.length)
      throw invalid(`workspace step ${step.id} waits: ${blockers.map((b) => b.why).join("; ")}`);
    await assertWorkspaceBudget(workspace, deps.now(), children);
    run = createRun({
      repo,
      title: step.title,
      aLines: step.aLines,
      version: deps.version,
      now: new Date(deps.now()),
      startedBy: currentSession(deps),
      workspace: { id: workspace.id, step: step.id },
    });
    writePin(deps, run);
  }
  const contract = existsSync(contractFile) ? join(run.dir, "workspace-contract.md") : null;
  if (contract && !existsSync(contract)) writeTextAtomic(contract, readFileSync(contractFile, "utf8"));
  return run;
}

export async function workspaceStatus(deps: Deps, id: string) {
  const workspace = findWorkspace(id);
  const { children, unreadable } = workspaceListing(workspace);
  // #43 finding 2: a corrupt child is a warning here, never a failed status
  const warnings = unreadable.map(unreadableWarning);
  const steps = [];
  for (const step of workspace.steps) {
    const child = children.find((r) => r.meta.workspace?.step === step.id);
    const summary = child ? summarizeRun(deps, child) : null;
    const landed = child ? landedMilestones(child) : [];
    const pending = child ? ownPending(child) : false;
    if (child && pending === null)
      warnings.push(`${step.id}: run ${child.id} has unreadable dispatch records`);
    // #43 finding 7: a milestone that differs only by case never releases the dependents
    const twin = landed.find((m) => m !== step.milestone && m.toLowerCase() === step.milestone.toLowerCase());
    if (twin && !landed.includes(step.milestone))
      warnings.push(`${step.id} completes on ${step.milestone}, but its run landed ${twin}`);
    const blockers = await dependencyBlockers(workspace, step, children, deps.now(), { merge: true });
    const state: "waiting" | "ready" | "active" | "landed" = child
      ? landed.includes(step.milestone) && pending === false
        ? "landed"
        : "active"
      : blockers.length
        ? "waiting"
        : "ready";
    steps.push({
      id: step.id,
      repo: step.repo,
      state,
      run: child?.id ?? null,
      blockedBy: blockers.map((b) => b.step),
      waitingFor: blockers.map((b) => b.why),
      landedMilestones: landed,
      landedCommits: child ? landedCommits(child) : [],
      failures: summary?.totals.notOk ?? [],
      questions: summary?.questions ?? [],
      live: summary?.live ?? [],
      childBudget: summary?.budget ?? null,
      warnings: summary?.warnings ?? [],
    });
  }
  const spend = await workspaceSpend(workspace, deps.now(), children, warnings);
  return {
    // spec 1.5 "Group pause": a pause over the workspace comes first
    paused: pausesOver([{ meta: { workspace: { id, step: workspace.steps[0]!.id } } }]),
    workspace,
    dir: workspaceDirectory(id),
    steps,
    spend,
    budget: budgetStatus(spend, workspace.budget),
    warnings,
  };
}
