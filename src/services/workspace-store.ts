import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import { assertId } from "../domain/ids.ts";
import { type Workspace, WorkspaceSchema } from "../domain/workspace.ts";
import { dataDir, runsDir } from "../infra/paths.ts";
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

/** Linkage is in the child's atomic meta write: a crash cannot orphan a completed child creation. */
export function workspaceChildren(workspace: Workspace): Run[] {
  const listing = listRuns(Object.values(workspace.repos));
  // An unreadable child cannot be proven unrelated. Refuse admission instead of silently recreating it.
  const roots = Object.values(workspace.repos).map(runsDir);
  if (listing.corrupt.some((bad) => roots.includes(dirname(bad.dir))))
    throw new CatherdError(
      "E_RUN_CORRUPT",
      "a workspace repository has an unreadable run; repair its metadata before continuing",
    );
  const children = listing.runs.filter((r) => r.meta.workspace?.id === workspace.id);
  const seen = new Set<string>();
  for (const run of children) {
    const step = workspace.steps.find((s) => s.id === run.meta.workspace?.step);
    if (!step || workspace.repos[step.repo] !== run.meta.repo || seen.has(step.id))
      throw new CatherdError(
        "E_RUN_CORRUPT",
        `workspace ${workspace.id} has duplicate or mismatched child ${run.id}`,
      );
    seen.add(step.id);
  }
  return children;
}
