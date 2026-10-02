import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import { assertId } from "../domain/ids.ts";
import { type Workspace, WorkspaceSchema } from "../domain/workspace.ts";
import { dataDir } from "../infra/paths.ts";
import { ensurePrivateDir, readVersioned, writeJsonAtomic } from "../infra/store.ts";
import { listRuns, type Run } from "./run-store.ts";

export function workspaceDirectory(id: string): string {
  assertId("workspace", id);
  return join(dataDir(), "workspaces", id);
}

export function workspacePaths(dir: string) {
  return {
    meta: join(dir, "meta.json"),
    admission: join(dir, "admission"),
    contract: join(dir, "contract.md"),
  };
}

/**
 * How long a workspace-lock waiter waits (#43 finding 5): longer than the slowest holder, an admission
 * whose git status snapshot may take up to 15 s, so a dispatch in another repository never fails E_IO_LOCK.
 */
export const WORKSPACE_LOCK_WAIT_MS = 120_000;

export function createWorkspace(
  input: Omit<Workspace, "schema" | "id" | "createdAt">,
  now = new Date(),
): Workspace {
  const workspace = WorkspaceSchema.parse({
    ...input,
    schema: 1,
    id: `workspace-${randomUUID()}`,
    createdAt: now.toISOString(),
  });
  const dir = workspaceDirectory(workspace.id);
  ensurePrivateDir(dir);
  writeJsonAtomic(workspacePaths(dir).meta, workspace);
  return workspace;
}

export function findWorkspace(id: string): Workspace {
  const file = workspacePaths(workspaceDirectory(id)).meta;
  if (!existsSync(file)) throw new CatherdError("E_RUN_NOT_FOUND", `no workspace "${id}"`);
  const workspace = readVersioned(file, WorkspaceSchema, 1);
  if (workspace.id !== id) throw new CatherdError("E_RUN_CORRUPT", `workspace ${id} has mismatched identity`);
  return workspace;
}

export interface WorkspaceListing {
  /** the runs linked to this workspace, each with a readable meta.json */
  children: Run[];
  /** run folders in a member repository whose meta.json cannot be read (#43 finding 1): skipped, named */
  unreadable: { id: string; dir: string; reason: string }[];
}

/**
 * Linkage is in the child's atomic meta write, so a folder without a readable meta.json is never a child:
 * `createRun` writes meta last, and a run being created, or left by a crash, is skipped and named, never
 * fatal (#43 finding 1). Two children of one step, or a child in the wrong repository, still throw.
 */
export function workspaceListing(workspace: Workspace): WorkspaceListing {
  const listing = listRuns(Object.values(workspace.repos));
  const children = listing.runs.filter((r) => r.meta.workspace?.id === workspace.id);
  const seen = new Set<string>();
  for (const run of children) {
    const step = workspace.steps.find((s) => s.id === run.meta.workspace?.step);
    if (!step || workspace.repos[step.repo] !== run.meta.repo || seen.has(step.id))
      throw new CatherdError(
        "E_RUN_CORRUPT",
        `workspace ${workspace.id} has duplicate or mismatched child ${run.id}`,
        { fix: `fix or delete ${run.dir}` },
      );
    seen.add(step.id);
  }
  return { children, unreadable: listing.corrupt };
}

/** The workspace's children (see workspaceListing); folders without a readable meta.json are skipped. */
export const workspaceChildren = (workspace: Workspace): Run[] => workspaceListing(workspace).children;

/** What `workspace_status` says about a skipped folder: its path and why. */
export const unreadableWarning = (u: { dir: string; reason: string }): string =>
  `skipped run folder ${u.dir}: ${u.reason}`;
