import { afterEach, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { runsDir } from "../../src/infra/paths.ts";
import { appendRecord, createRun, listRuns, runPaths } from "../../src/services/run-store.ts";
import { withWorkspaceAdmission } from "../../src/services/workspace-admission.ts";
import {
  inspectWorkspace,
  startWorkspace,
  startWorkspaceChild,
  workspaceStatus,
} from "../../src/services/workspace-service.ts";
import { findWorkspace, workspaceChildren, workspacePaths } from "../../src/services/workspace-store.ts";
import { snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps, fakeDispatch, makeRecord, testView } from "./helpers.ts";

afterEach(snapshotEnv());

function setup() {
  withHome();
  const root = tempDir("catherd-workspace-");
  const repos = { api: tempRepo(), web: tempRepo() };
  const deps = fakeDeps();
  const input = {
    root,
    repos,
    title: "Shared feature",
    aLines: ["Both apps agree"],
    steps: [
      { id: "api", repo: "api", title: "API", aLines: ["API works"] },
      { id: "web", repo: "web", title: "Web", aLines: ["Web works"], dependsOn: ["api"] },
    ],
  };
  return { root, repos, deps, input };
}

it("resolves manifests and symlinks to git roots, rejecting duplicate roots and unsafe aliases", async () => {
  const { root, repos } = setup();
  writeFileSync(
    join(root, "catherd.workspace.json"),
    JSON.stringify({ schema: 1, repos: { api: relative(root, repos.api) } }),
  );
  expect(await inspectWorkspace(root)).toEqual({ root, repos: { api: repos.api } });
  symlinkSync(repos.api, join(root, "api-link"));
  await expect(inspectWorkspace(root, { api: repos.api, duplicate: "api-link" })).rejects.toMatchObject({
    code: "E_INPUT_INVALID",
  });
  await expect(inspectWorkspace(root, { "../bad": repos.api })).rejects.toMatchObject({
    code: "E_INPUT_INVALID",
  });
});

it("stores a private snapshot, lazily starts once, and unlocks dependencies on landed evidence", async () => {
  const { deps, input } = setup();
  const { workspace, dir } = await startWorkspace(deps, input);
  expect(findWorkspace(workspace.id)).toEqual(workspace);
  expect(workspaceChildren(workspace)).toHaveLength(0);
  expect(statSync(workspacePaths(dir).meta).mode & 0o077).toBe(0);
  writeFileSync(workspacePaths(dir).contract, "Shared API agreement");
  await expect(startWorkspaceChild(deps, { workspace: workspace.id, step: "web" })).rejects.toMatchObject({
    code: "E_INPUT_INVALID",
  });
  const starts = await Promise.all(
    [1, 2].map(() => startWorkspaceChild(deps, { workspace: workspace.id, step: "api" })),
  );
  expect(starts[0]?.run).toBe(starts[1]?.run);
  expect(readFileSync(starts[0]!.contract!, "utf8")).toBe("Shared API agreement");
  const child = workspaceChildren(workspace)[0]!;
  appendFileSync(runPaths(child.dir).ledger, "M1 | API | abcdef1 | 1 | checked\n");
  const status = await workspaceStatus(deps, workspace.id);
  expect(status.steps.map((s) => s.state)).toEqual(["landed", "ready"]);
  expect(status.steps[0]?.landedCommits).toEqual(["abcdef1"]);
  const web = await startWorkspaceChild(deps, { workspace: workspace.id, step: "web" });
  expect(web.run).not.toBe(child.id);
});

it("rejects invalid graphs and unordered steps owning the same repo", async () => {
  const { deps, input } = setup();
  for (const steps of [
    [],
    [input.steps[0]!, input.steps[0]!],
    [input.steps[0]!, { ...input.steps[0]!, dependsOn: ["missing"] }],
    [{ ...input.steps[0]!, dependsOn: ["missing"] }],
    [{ ...input.steps[0]!, dependsOn: ["web"] }, input.steps[1]!],
    [input.steps[0]!, { ...input.steps[1]!, repo: "api", dependsOn: [] }],
  ]) {
    await expect(startWorkspace(deps, { ...input, steps })).rejects.toMatchObject({
      code: "E_INPUT_INVALID",
    });
  }
});

it("snapshots only selected repositories and ignores later manifest changes", async () => {
  const { deps, input, root } = setup();
  const declared = { ...input.repos, absent: join(root, "not-cloned") };
  writeFileSync(join(root, "catherd.workspace.json"), JSON.stringify({ schema: 1, repos: declared }));
  const { workspace } = await startWorkspace(deps, { ...input, repos: undefined });
  expect(workspace.repos).toEqual(input.repos);
  writeFileSync(
    join(root, "catherd.workspace.json"),
    JSON.stringify({ schema: 1, repos: { api: input.repos.web } }),
  );
  const child = await startWorkspaceChild(deps, { workspace: workspace.id, step: "api" });
  expect(workspaceChildren(workspace).find((r) => r.id === child.run)?.meta.repo).toBe(input.repos.api);
  rmSync(input.repos.web, { recursive: true });
  expect(workspaceChildren(workspace)).toHaveLength(1);
});

it("recovers linked children and refuses duplicate or mismatched linkage", async () => {
  const { deps, input } = setup();
  const { workspace } = await startWorkspace(deps, input);
  const linked = createRun({
    repo: input.repos.api,
    title: "Recovered",
    aLines: [],
    version: "test",
    workspace: { id: workspace.id, step: "api" },
  });
  expect((await startWorkspaceChild(deps, { workspace: workspace.id, step: "api" })).run).toBe(linked.id);
  createRun({
    repo: input.repos.web,
    title: "Invalid",
    aLines: [],
    version: "test",
    workspace: { id: workspace.id, step: "api" },
  });
  expect(() => workspaceChildren(workspace)).toThrow();
});

it("shows failed work without losing prior landing evidence, with each repo's profile budget", async () => {
  const { deps, input } = setup();
  deps.profiles.forRepo = (repo) => testView({ budget: { tokens: repo === input.repos.api ? 1000 : 2000 } });
  const { workspace } = await startWorkspace(deps, input);
  await startWorkspaceChild(deps, { workspace: workspace.id, step: "api" });
  const api = workspaceChildren(workspace)[0]!;
  appendFileSync(runPaths(api.dir).ledger, "M1 | API | abcdef1 | 1 | checked\n");
  await startWorkspaceChild(deps, { workspace: workspace.id, step: "web" });
  const web = workspaceChildren(workspace).find((r) => r.meta.workspace?.step === "web")!;
  await appendRecord(web, makeRecord({ runId: web.id, status: "failed" }));
  const status = await workspaceStatus(deps, workspace.id);
  expect(status.steps[0]?.landedCommits).toEqual(["abcdef1"]);
  expect(status.steps[1]?.failures).toEqual(["worker-M1.L1 (failed)"]);
  expect(status.steps[0]?.childBudget?.tokens?.cap).toBe(1000);
  expect(status.steps[1]?.childBudget?.tokens?.cap).toBe(2000);
});

it("runs independent members together and gates a fan-in verifier on both landings and collected dispatches", async () => {
  const { deps, input } = setup();
  const verifier = tempRepo();
  const { workspace } = await startWorkspace(deps, {
    ...input,
    repos: { ...input.repos, verifier },
    steps: [
      input.steps[0]!,
      { ...input.steps[1]!, dependsOn: [] },
      {
        id: "verify",
        repo: "verifier",
        title: "Joint verification",
        aLines: ["Integration works"],
        dependsOn: ["api", "web"],
      },
    ],
  });
  await Promise.all(
    ["api", "web"].map((step) => startWorkspaceChild(deps, { workspace: workspace.id, step })),
  );
  const children = workspaceChildren(workspace);
  expect(children).toHaveLength(2);
  const api = children.find((r) => r.meta.workspace?.step === "api")!;
  const web = children.find((r) => r.meta.workspace?.step === "web")!;
  appendFileSync(runPaths(api.dir).ledger, "M1 | API | abcdef1 | 1 | checked\n");
  await expect(startWorkspaceChild(deps, { workspace: workspace.id, step: "verify" })).rejects.toMatchObject({
    code: "E_INPUT_INVALID",
  });
  appendFileSync(runPaths(web.dir).ledger, "M1 | Web | abcdef2 | 1 | checked\n");
  const uncollected = await fakeDispatch(web);
  expect((await workspaceStatus(deps, workspace.id)).steps[2]?.blockedBy).toEqual(["web"]);
  await expect(startWorkspaceChild(deps, { workspace: workspace.id, step: "verify" })).rejects.toMatchObject({
    code: "E_INPUT_INVALID",
  });
  await appendRecord(web, makeRecord({ runId: web.id, dispatchId: uncollected.admit.dispatchId }));
  expect((await workspaceStatus(deps, workspace.id)).steps[2]?.state).toBe("ready");
  const joint = await startWorkspaceChild(deps, { workspace: workspace.id, step: "verify" });
  expect(workspaceChildren(workspace).find((r) => r.id === joint.run)?.meta.repo).toBe(verifier);
});

it("refuses a checkout whose .git disappeared and reports the missing manifest path", async () => {
  const { deps, input, root } = setup();
  await expect(inspectWorkspace(root)).rejects.toMatchObject({
    code: "E_CONFIG_INVALID",
    fix: expect.stringContaining("catherd.workspace.json"),
  });
  const { workspace } = await startWorkspace(deps, input);
  rmSync(join(input.repos.api, ".git"), { recursive: true });
  await expect(startWorkspaceChild(deps, { workspace: workspace.id, step: "api" })).rejects.toMatchObject({
    code: "E_IO_PATH",
  });
  expect(workspaceChildren(workspace)).toHaveLength(0);
});

it("preserves stored status but refuses recovery after a checkout disappears", async () => {
  const { deps, input } = setup();
  const { workspace } = await startWorkspace(deps, input);
  const child = await startWorkspaceChild(deps, { workspace: workspace.id, step: "api" });
  rmSync(input.repos.api, { recursive: true });
  expect((await workspaceStatus(deps, workspace.id)).steps[0]?.run).toBe(child.run);
  await expect(startWorkspaceChild(deps, { workspace: workspace.id, step: "api" })).rejects.toMatchObject({
    code: "E_IO_PATH",
  });
});

it("scopes child discovery to selected repositories and ignores unrelated corrupt history", async () => {
  const { deps, input } = setup();
  const unrelated = createRun({ repo: tempRepo(), title: "Unrelated", aLines: [], version: "test" });
  writeFileSync(runPaths(unrelated.dir).meta, "{broken");
  const { workspace } = await startWorkspace(deps, input);
  const child = await startWorkspaceChild(deps, { workspace: workspace.id, step: "api" });
  expect(workspaceChildren(workspace).map((run) => run.id)).toEqual([child.run]);
  expect(listRuns(Object.values(workspace.repos))).toMatchObject({ corrupt: [], runs: [{ id: child.run }] });
  expect(listRuns().corrupt.map((run) => run.id)).toContain(unrelated.id);
});

it("requires a directory root and bounds supplied repository registries", async () => {
  const { root, repos } = setup();
  const file = join(root, "file");
  writeFileSync(file, "plain file");
  await expect(inspectWorkspace(file, repos)).rejects.toMatchObject({ code: "E_IO_PATH" });
  await expect(
    inspectWorkspace(
      root,
      Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`repo-${i}`, repos.api])),
    ),
  ).rejects.toMatchObject({ code: "E_INPUT_INVALID" });
});

it("status preserves stored metadata, child state and dispatch evidence", async () => {
  const { deps, input } = setup();
  const { workspace, dir } = await startWorkspace(deps, input);
  await startWorkspaceChild(deps, { workspace: workspace.id, step: "api" });
  const api = workspaceChildren(workspace)[0]!;
  const files = [
    workspacePaths(dir).meta,
    runPaths(api.dir).stateJson,
    runPaths(api.dir).state,
    runPaths(api.dir).runs,
  ];
  const before = files.map((file) => ({ text: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs }));
  await workspaceStatus(deps, workspace.id);
  expect(files.map((file) => ({ text: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs }))).toEqual(
    before,
  );
});

it("allows joint verification to reuse a repository only after both parallel builds land", async () => {
  const { deps, input } = setup();
  const { workspace } = await startWorkspace(deps, {
    ...input,
    steps: [
      input.steps[0]!,
      { ...input.steps[1]!, dependsOn: [] },
      {
        id: "verify",
        repo: "api",
        title: "Joint verification",
        aLines: ["Both apps integrate"],
        dependsOn: ["api", "web"],
      },
    ],
  });
  await Promise.all(
    ["api", "web"].map((step) => startWorkspaceChild(deps, { workspace: workspace.id, step })),
  );
  const children = workspaceChildren(workspace);
  const api = children.find((r) => r.meta.workspace?.step === "api")!;
  const web = children.find((r) => r.meta.workspace?.step === "web")!;
  await expect(startWorkspaceChild(deps, { workspace: workspace.id, step: "verify" })).rejects.toMatchObject({
    code: "E_INPUT_INVALID",
  });
  appendFileSync(runPaths(api.dir).ledger, "M1 | API | abcdef1 | 1 | checked\n");
  await expect(startWorkspaceChild(deps, { workspace: workspace.id, step: "verify" })).rejects.toMatchObject({
    code: "E_INPUT_INVALID",
  });
  appendFileSync(runPaths(web.dir).ledger, "M1 | Web | abcdef2 | 1 | checked\n");
  const verifier = await startWorkspaceChild(deps, { workspace: workspace.id, step: "verify" });
  expect(verifier.run).not.toBe(api.id);
  expect(workspaceChildren(workspace).find((r) => r.id === verifier.run)?.meta.repo).toBe(input.repos.api);
  expect(workspaceChildren(workspace)).toHaveLength(3);
  expect((await workspaceStatus(deps, workspace.id)).steps.map((s) => s.state)).toEqual([
    "landed",
    "landed",
    "active",
  ]);
});

it("accepts transitive same-repository ordering and rejects unordered reuse", async () => {
  const { deps, input } = setup();
  const steps = [
    input.steps[0]!,
    input.steps[1]!,
    { id: "verify", repo: "api", title: "Verify", aLines: [], dependsOn: ["web"] },
  ];
  expect((await startWorkspace(deps, { ...input, steps })).workspace.steps).toHaveLength(3);
  await expect(
    startWorkspace(deps, { ...input, steps: [steps[0]!, { ...steps[2]!, dependsOn: [] }] }),
  ).rejects.toMatchObject({ code: "E_INPUT_INVALID" });
});

it("skips a member run folder without meta.json and names it, instead of blocking the workspace (#43 finding 1)", async () => {
  const { deps, input } = setup();
  const { workspace } = await startWorkspace(deps, input);
  // a run_start in progress, or one a crash left: createRun writes meta.json last
  const half = join(runsDir(input.repos.api), "20261002-000000-half-made");
  mkdirSync(half, { recursive: true });
  const api = await startWorkspaceChild(deps, { workspace: workspace.id, step: "api" });
  expect(workspaceChildren(workspace).map((r) => r.id)).toEqual([api.run]);
  const status = await workspaceStatus(deps, workspace.id);
  expect(status.steps[0]?.run).toBe(api.run);
  expect(status.warnings).toEqual([expect.stringContaining(half)]);
});

it("keeps siblings and status working when one child has a torn records line (#43 finding 2)", async () => {
  const { deps, input } = setup();
  const { workspace } = await startWorkspace(deps, {
    ...input,
    steps: [input.steps[0]!, { ...input.steps[1]!, dependsOn: [] }],
  });
  await startWorkspaceChild(deps, { workspace: workspace.id, step: "api" });
  const api = workspaceChildren(workspace)[0]!;
  appendFileSync(runPaths(api.dir).runs, "{torn\n");
  const web = await startWorkspaceChild(deps, { workspace: workspace.id, step: "web" });
  expect(web.run).not.toBe(api.id);
  const sibling = workspaceChildren(workspace).find((r) => r.id === web.run)!;
  expect(await withWorkspaceAdmission(sibling, deps.now(), async () => "admitted")).toBe("admitted");
  const status = await workspaceStatus(deps, workspace.id);
  expect(status.steps.map((s) => s.state)).toEqual(["active", "active"]);
  expect(status.warnings).toContainEqual(`api: run ${api.id} has unreadable dispatch records`);
});

it("releases a merge step's dependents only once its landed commit is in the base ref", async () => {
  const { deps, input } = setup();
  const { workspace } = await startWorkspace(deps, {
    ...input,
    steps: [{ ...input.steps[0]!, release: "merge", base: "staging" }, input.steps[1]!],
  });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: input.repos.api,
      encoding: "utf8",
    }).trim();
  git("branch", "staging");
  git("checkout", "-q", "-b", "feature");
  git("commit", "-q", "--allow-empty", "-m", "api work");
  const commit = git("rev-parse", "HEAD");
  await startWorkspaceChild(deps, { workspace: workspace.id, step: "api" });
  const api = workspaceChildren(workspace)[0]!;
  appendFileSync(runPaths(api.dir).ledger, `M1 | API | ${commit} | 1 | checked\n`);
  await expect(startWorkspaceChild(deps, { workspace: workspace.id, step: "web" })).rejects.toThrow(
    `api's M1 (${commit.slice(0, 7)}) is not merged into staging yet`,
  );
  expect((await workspaceStatus(deps, workspace.id)).steps[1]?.state).toBe("waiting");
  git("checkout", "-q", "staging");
  git("merge", "-q", "--ff-only", "feature");
  const web = await startWorkspaceChild(deps, { workspace: workspace.id, step: "web" });
  expect(web.run).not.toBe(api.id);
});

it("refuses a merge release without a base ref, and a base that looks like an option", async () => {
  const { deps, input } = setup();
  for (const step of [
    { ...input.steps[0]!, release: "merge" as const },
    { ...input.steps[0]!, release: "merge" as const, base: "--upload-pack=x" },
  ])
    await expect(startWorkspace(deps, { ...input, steps: [step, input.steps[1]!] })).rejects.toMatchObject({
      code: "E_INPUT_INVALID",
    });
});

it("admission and child start wait on a dependency for the same reasons (#43 finding 8)", async () => {
  const { deps, input } = setup();
  const { workspace } = await startWorkspace(deps, input);
  await startWorkspaceChild(deps, { workspace: workspace.id, step: "api" });
  const api = workspaceChildren(workspace)[0]!;
  appendFileSync(runPaths(api.dir).ledger, "M1 | API | abcdef1 | 1 | checked\n");
  await fakeDispatch(api, { name: "late-fix" }, { proc: "dead" });
  const recovered = createRun({
    repo: input.repos.web,
    title: "Recovered web",
    aLines: [],
    version: "test",
    workspace: { id: workspace.id, step: "web" },
  });
  const why = "api has 1 dispatch(es) not collected (late-fix)";
  await expect(withWorkspaceAdmission(recovered, deps.now(), async () => "admitted")).rejects.toThrow(why);
  rmSync(recovered.dir, { recursive: true });
  await expect(startWorkspaceChild(deps, { workspace: workspace.id, step: "web" })).rejects.toThrow(why);
  expect((await workspaceStatus(deps, workspace.id)).steps[1]?.waitingFor).toEqual([why]);
});
