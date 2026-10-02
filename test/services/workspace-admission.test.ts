import { afterEach, expect, it } from "bun:test";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { newDispatchId } from "../../src/domain/ids.ts";
import { route } from "../../src/services/lane-service.ts";
import { writeRunFile } from "../../src/services/run-service.ts";
import {
  appendAgentRun,
  appendLedger,
  appendRecord,
  createRun,
  runPaths,
} from "../../src/services/run-store.ts";
import {
  workspaceBudget,
  workspaceContract,
  workspaceSpend,
  withWorkspaceAdmission,
} from "../../src/services/workspace-admission.ts";
import { startWorkspace, startWorkspaceChild } from "../../src/services/workspace-service.ts";
import { workspaceChildren } from "../../src/services/workspace-store.ts";
import { snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps, fakeDispatch, makeRecord } from "./helpers.ts";

afterEach(snapshotEnv());

async function setup(budget = { tokens: 1000 }) {
  withHome();
  const deps = fakeDeps({ now: () => Date.parse("2026-10-02T10:00:00.000Z") });
  const { workspace } = await startWorkspace(deps, {
    root: tempDir("catherd-parent-"),
    repos: { producer: tempRepo(), consumer: tempRepo() },
    title: "General workspace",
    aLines: ["Two repositories work together"],
    budget,
    steps: [
      { id: "producer", repo: "producer", title: "Producer", aLines: ["Produces contract"] },
      { id: "consumer", repo: "consumer", title: "Consumer", aLines: ["Consumes contract"] },
    ],
  });
  await startWorkspaceChild(deps, { workspace: workspace.id, step: "producer" });
  await startWorkspaceChild(deps, { workspace: workspace.id, step: "consumer" });
  const children = workspaceChildren(workspace);
  const producer = children.find((r) => r.meta.workspace?.step === "producer")!;
  const consumer = children.find((r) => r.meta.workspace?.step === "consumer")!;
  return { deps, workspace, producer, consumer };
}

it("counts finalized, pending and native usage once across siblings with parent wall time", async () => {
  const { workspace, producer, consumer } = await setup();
  const pending = await fakeDispatch(
    producer,
    {},
    {
      events:
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 150, output_tokens: 50 } }) + "\n",
    },
  );
  await appendRecord(
    producer,
    makeRecord({
      runId: producer.id,
      dispatchId: pending.admit.dispatchId,
      tokens: { input: 150, cached: 0, output: 50 },
      costUsd: 2,
    }),
  );
  await appendRecord(
    consumer,
    makeRecord({
      runId: consumer.id,
      dispatchId: newDispatchId(),
      tokens: { input: 100, cached: 0, output: 50 },
      costUsd: 1,
    }),
  );
  await fakeDispatch(
    consumer,
    { name: "research" },
    {
      events:
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 30, output_tokens: 20 } }) + "\n",
    },
  );
  appendAgentRun(consumer, {
    at: workspace.createdAt,
    name: "native",
    role: "reviewer",
    rung: "claude:claude-opus-5-5#high",
    agent: null,
    totalTokens: 100,
    costUsd: 0.5,
    secs: 60,
    status: "ok",
    lane: null,
  });
  const now = Date.parse(workspace.createdAt) + 120_000;
  expect(await workspaceSpend(workspace, now)).toEqual({ tokens: 500, usd: 3.5, minutes: 2 });
  expect((await workspaceBudget(producer, now))?.fraction).toBe(0.5);
});

it("cost routing sees sibling spend at the shared 80 percent threshold", async () => {
  const { deps, producer, consumer } = await setup();
  await appendRecord(
    producer,
    makeRecord({
      runId: producer.id,
      tokens: { input: 800, cached: 0, output: 0 },
    }),
  );
  let fraction = -1;
  const routing = deps.routing.route;
  deps.routing.route = async (request) => {
    fraction = request.spentFraction;
    return routing(request);
  };
  await route(deps, { run: consumer.id, role: "worker" });
  expect(fraction).toBe(0.8);
});

it("serializes sibling admission and rejects the second after aggregate budget is spent", async () => {
  const { deps, producer, consumer } = await setup();
  const attempt = (run: typeof producer) =>
    withWorkspaceAdmission(run, deps.now(), async () => {
      await appendRecord(
        run,
        makeRecord({
          runId: run.id,
          dispatchId: newDispatchId(),
          tokens: { input: 1000, cached: 0, output: 0 },
        }),
      );
      return run.id;
    });
  const outcomes = await Promise.allSettled([attempt(producer), attempt(consumer)]);
  expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = outcomes.find((r) => r.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason.code).toBe("E_RUN_BUDGET");
});

it("admits a post-land fix into a completed step and preserves ordinary run admission (#43 finding 7)", async () => {
  const { deps, producer } = await setup();
  appendLedger(producer, "M1 | Finished | abcdef1 | 1 | passed");
  expect(await withWorkspaceAdmission(producer, deps.now(), async () => "admitted")).toBe("admitted");
  const ordinary = createRun({ repo: tempRepo(), title: "Ordinary", aLines: [], version: "test" });
  expect(await withWorkspaceAdmission(ordinary, deps.now(), async () => "admitted")).toBe("admitted");
});

for (const evidence of ["records", "agents", "dispatch"] as const) {
  it(`refuses workspace admission with unreadable ${evidence} cost evidence`, async () => {
    const { deps, producer } = await setup();
    if (evidence === "dispatch") {
      const dispatch = await fakeDispatch(producer);
      writeFileSync(`${dispatch.dir}/admit.json`, "{broken");
    } else {
      appendFileSync(runPaths(producer.dir)[evidence === "records" ? "runs" : "agents"], "{broken\n");
    }
    let admitted = false;
    await expect(
      withWorkspaceAdmission(producer, deps.now(), async () => {
        admitted = true;
      }),
    ).rejects.toMatchObject({ code: "E_RUN_CORRUPT" });
    expect(admitted).toBe(false);
  });
}

it("refuses direct admission after the captured Git checkout disappears", async () => {
  const { deps, producer } = await setup();
  rmSync(`${producer.meta.repo}/.git`, { recursive: true });
  await expect(withWorkspaceAdmission(producer, deps.now(), async () => "admitted")).rejects.toMatchObject({
    code: "E_IO_PATH",
  });
});

for (const evidence of ["tokens", "cost", "native-cost", "pending-tokens"] as const) {
  it(`refuses negative ${evidence} instead of reducing the shared spend`, async () => {
    const { deps, producer } = await setup();
    if (evidence === "native-cost") {
      appendAgentRun(producer, {
        at: new Date(deps.now()).toISOString(),
        name: "native",
        role: "reviewer",
        rung: "claude:claude-opus-5-5#high",
        agent: null,
        totalTokens: 0,
        costUsd: -1,
        secs: 0,
        status: "ok",
        lane: null,
      });
    } else if (evidence === "pending-tokens") {
      await fakeDispatch(
        producer,
        {},
        {
          events:
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: -100, output_tokens: 0 } }) +
            "\n",
        },
      );
    } else {
      await appendRecord(
        producer,
        makeRecord({
          runId: producer.id,
          ...(evidence === "tokens" ? { tokens: { input: -1, cached: 0, output: 0 } } : { costUsd: -1 }),
        }),
      );
    }
    await expect(withWorkspaceAdmission(producer, deps.now(), async () => true)).rejects.toMatchObject({
      code: "E_RUN_CORRUPT",
    });
  });
}

it("freezes the shared contract at the first child and copies it for later children", async () => {
  withHome();
  const deps = fakeDeps();
  const { workspace } = await startWorkspace(deps, {
    root: tempDir("catherd-contract-"),
    repos: { a: tempRepo(), b: tempRepo() },
    title: "Contract",
    aLines: ["Agreement"],
    steps: [
      { id: "a", repo: "a", title: "A", aLines: [] },
      { id: "b", repo: "b", title: "B", aLines: [] },
    ],
  });
  expect((await workspaceContract({ workspace: workspace.id })).content).toBe("");
  await workspaceContract({ workspace: workspace.id, content: "v1 contract" });
  const a = await startWorkspaceChild(deps, { workspace: workspace.id, step: "a" });
  expect(readFileSync(a.contract!, "utf8")).toBe("v1 contract");
  expect(() => writeRunFile({ run: a.run, path: "workspace-contract.md", content: "changed" })).toThrow(
    "written by catherd itself",
  );
  await expect(workspaceContract({ workspace: workspace.id, content: "v2 contract" })).rejects.toMatchObject({
    code: "E_INPUT_INVALID",
  });
  const b = await startWorkspaceChild(deps, { workspace: workspace.id, step: "b" });
  expect(readFileSync(b.contract!, "utf8")).toBe("v1 contract");
});
