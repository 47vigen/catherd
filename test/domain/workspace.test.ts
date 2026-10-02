import { expect, it } from "bun:test";
import { WorkspaceSchema, type WorkspaceStep } from "../../src/domain/workspace.ts";

function snapshot(steps: Partial<WorkspaceStep>[]) {
  return {
    schema: 1,
    id: "workspace-test",
    root: "/workspace",
    title: "Shared work",
    aLines: [],
    createdAt: "2026-10-02T00:00:00.000Z",
    budget: {},
    repos: { repo: "/workspace/repo", other: "/workspace/other" },
    steps: steps.map((step, i) => ({ id: `s${i}`, repo: "repo", title: "Step", aLines: [], ...step })),
  };
}

it("accepts a reverse-listed chain at the supported workspace size", () => {
  const steps = Array.from({ length: 100 }, (_, i) => ({
    id: `s${i}`,
    dependsOn: i ? [`s${i - 1}`] : [],
  })).reverse();
  expect(WorkspaceSchema.safeParse(snapshot(steps)).success).toBe(true);
});

it("accepts dense shared fan-in dependencies at the supported workspace size", () => {
  const steps = Array.from({ length: 100 }, (_, i) => ({
    id: `s${i}`,
    dependsOn: Array.from({ length: i }, (_, j) => `s${j}`),
  }));
  expect(WorkspaceSchema.safeParse(snapshot(steps)).success).toBe(true);
});

it("rejects oversized workspace steps, repository registries and dependency lists", () => {
  expect(
    WorkspaceSchema.safeParse(
      snapshot(Array.from({ length: 101 }, (_, i) => ({ dependsOn: i ? [`s${i - 1}`] : [] }))),
    ).success,
  ).toBe(false);
  const input = snapshot([{}]);
  expect(
    WorkspaceSchema.safeParse({
      ...input,
      repos: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`r${i}`, `/workspace/r${i}`])),
      steps: [{ ...input.steps[0], repo: "r0" }],
    }).success,
  ).toBe(false);
  expect(WorkspaceSchema.safeParse(snapshot([{ dependsOn: Array(101).fill("s0") }])).success).toBe(false);
});

it("rejects duplicate identities, unknown dependencies, repeated dependencies and cycles", () => {
  for (const steps of [
    [{ id: "same" }, { id: "same" }],
    [{ dependsOn: ["missing"] }],
    [{}, { dependsOn: ["s0", "s0"] }],
    [{ dependsOn: ["s0"] }],
    [{ dependsOn: ["s1"] }, { dependsOn: ["s0"] }],
    [{ repo: "missing" }],
  ])
    expect(WorkspaceSchema.safeParse(snapshot(steps)).success).toBe(false);
});

it("requires transitive ordering only for steps sharing a repository", () => {
  expect(WorkspaceSchema.safeParse(snapshot([{}, { repo: "other" }])).success).toBe(true);
  expect(WorkspaceSchema.safeParse(snapshot([{}, {}])).success).toBe(false);
  expect(
    WorkspaceSchema.safeParse(snapshot([{}, { repo: "other", dependsOn: ["s0"] }, { dependsOn: ["s1"] }]))
      .success,
  ).toBe(true);
  expect(
    WorkspaceSchema.safeParse(snapshot([{}, { dependsOn: ["s0"] }, { dependsOn: ["s0"] }])).success,
  ).toBe(false);
});
