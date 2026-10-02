import { z } from "zod";
import { ID_PATTERN } from "./ids.ts";

export const WORKSPACE_LIMIT = 100;

export const WorkspaceIdSchema = z
  .string()
  .regex(ID_PATTERN)
  .refine((s) => !s.includes(".."));
export const WorkspaceBudgetSchema = z.strictObject({
  minutes: z.number().finite().nonnegative().optional(),
  tokens: z.number().finite().nonnegative().optional(),
  usd: z.number().finite().nonnegative().optional(),
});
export const WorkspaceStepSchema = z.strictObject({
  id: WorkspaceIdSchema,
  repo: WorkspaceIdSchema,
  title: z.string().min(1),
  aLines: z.array(z.string()),
  dependsOn: z.array(WorkspaceIdSchema).max(WORKSPACE_LIMIT).default([]),
  milestone: WorkspaceIdSchema.default("M1"),
});
export type WorkspaceStep = z.infer<typeof WorkspaceStepSchema>;
export const WorkspaceSchema = z
  .strictObject({
    schema: z.literal(1),
    id: WorkspaceIdSchema,
    root: z.string().min(1),
    title: z.string().min(1),
    aLines: z.array(z.string()),
    createdAt: z.iso.datetime(),
    budget: WorkspaceBudgetSchema,
    repos: z
      .record(WorkspaceIdSchema, z.string().min(1))
      .refine((repos) => Object.keys(repos).length <= WORKSPACE_LIMIT),
    steps: z.array(WorkspaceStepSchema).min(1).max(WORKSPACE_LIMIT),
  })
  .superRefine((workspace, ctx) => {
    // Zod may still refine an oversized array; do not traverse invalid graphs.
    if (
      workspace.steps.length > WORKSPACE_LIMIT ||
      Object.keys(workspace.repos).length > WORKSPACE_LIMIT ||
      workspace.steps.some((step) => step.dependsOn.length > WORKSPACE_LIMIT)
    )
      return;
    const ids = new Set<string>();
    let invalidIdentity = false;
    for (const step of workspace.steps) {
      if (ids.has(step.id) || !Object.hasOwn(workspace.repos, step.repo)) {
        invalidIdentity = true;
        ctx.addIssue({
          code: "custom",
          message: "steps require unique ids and repositories present in the snapshot",
        });
      }
      ids.add(step.id);
    }
    if (invalidIdentity) return;
    const byId = new Map(workspace.steps.map((step) => [step.id, step]));
    const remaining = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    const ready: string[] = [];
    for (const step of workspace.steps) {
      if (
        new Set(step.dependsOn).size !== step.dependsOn.length ||
        step.dependsOn.some((id) => !byId.has(id))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "dependencies must form a graph without cycles or unknown steps",
        });
        return;
      }
      remaining.set(step.id, step.dependsOn.length);
      if (!step.dependsOn.length) ready.push(step.id);
      for (const id of step.dependsOn) {
        const next = dependents.get(id) ?? [];
        next.push(step.id);
        dependents.set(id, next);
      }
    }
    const ancestors = new Map<string, Set<string>>();
    const latestByRepo = new Map<string, string>();
    // Topological order makes adjacent owners sufficient: if each owner follows
    // the previous owner transitively, every pair of owners is ordered.
    for (let i = 0; i < ready.length; i++) {
      const step = byId.get(ready[i]!)!;
      const before = new Set<string>();
      for (const id of step.dependsOn) {
        before.add(id);
        for (const ancestor of ancestors.get(id)!) before.add(ancestor);
      }
      ancestors.set(step.id, before);
      const previous = latestByRepo.get(step.repo);
      if (previous && !before.has(previous))
        ctx.addIssue({
          code: "custom",
          message: "steps sharing a repository must be ordered by dependencies",
        });
      latestByRepo.set(step.repo, step.id);
      for (const id of dependents.get(step.id) ?? []) {
        const count = remaining.get(id)! - 1;
        remaining.set(id, count);
        if (!count) ready.push(id);
      }
    }
    if (ready.length !== workspace.steps.length)
      ctx.addIssue({
        code: "custom",
        message: "dependencies must form a graph without cycles or unknown steps",
      });
  });
export type Workspace = z.infer<typeof WorkspaceSchema>;
