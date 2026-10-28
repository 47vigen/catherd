import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { briefOwns, DOCS_OWNS, ownsPath, splitChanges } from "../../src/domain/changes.ts";
import { type AdmitInput, admit } from "../../src/services/admission.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { endedEvent } from "../../src/services/run-effects.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, fakeDispatch, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

describe("a writer's implicit docs lane (spec 1.5 plan 21)", () => {
  it("reads an Owns: line from the brief, and matches dir/** and *.ext entries", () => {
    expect(briefOwns("Update the docs.\nOwns: CHANGELOG.md, `docs/api/`\n")).toEqual([
      "CHANGELOG.md",
      "docs/api/",
    ]);
    expect(briefOwns("Update the docs.")).toBeNull();
    expect(briefOwns("Owns:   \n")).toBeNull();
    expect(ownsPath("docs/guide/intro.md", "docs/**")).toBe(true);
    expect(ownsPath("docs", "docs/**")).toBe(true);
    expect(ownsPath("services/payment/README.md", "*.md")).toBe(true);
    expect(ownsPath("README.mdx", "*.md")).toBe(false);
    expect(ownsPath("src/docs.ts", "docs/**")).toBe(false);
    expect(ownsPath("src/a.ts", "src")).toBe(true);
    expect(splitChanges(["README.md", "src/x.ts"], ["src/a.ts"], DOCS_OWNS, true)).toEqual({
      changedOwned: [],
      violations: ["src/x.ts"],
    });
  });

  it("gives a laneless writer its brief's Owns, else docs/** and *.md; nobody else gets one", async () => {
    const { run } = freshRun();
    process.env.PATH = simPath();
    Object.assign(process.env, withScenario({}).env);
    const deps = fakeDeps();
    const writer = (brief: string, name: string): AdmitInput => ({
      role: "writer",
      name,
      brief,
      rung: "codex:gpt-6-luna#high",
      thread: null,
      lane: null,
      failoverFrom: null,
    });
    expect(
      (await admit(deps, run, writer("Write the changelog.\nOwns: CHANGELOG.md", "writer-a"))).d.admit
        .ownsImplicit,
    ).toEqual(["CHANGELOG.md"]);
    expect((await admit(deps, run, writer("Write the docs.", "writer-b"))).d.admit).toMatchObject({
      owns: [],
      ownsImplicit: DOCS_OWNS,
    });
    const reviewer = await admit(deps, run, {
      ...writer("Review M1.", "reviewer-M1"),
      role: "reviewer",
      rung: "codex:gpt-6-sol#high",
    });
    expect(reviewer.d.admit.ownsImplicit).toBeUndefined();
  });

  it("attributes a concurrent writer's doc edits to the writer: never a lane's violation, and its own changed files", async () => {
    const { repo, run } = freshRun();
    const ended = {
      code: 0,
      signal: null,
      reason: "exited" as const,
      endedAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const lane = await fakeDispatch(
      run,
      { name: "worker-M1.L4", lane: "M1.L4", owns: ["src/a.ts"] },
      { proc: "dead", exit: ended },
    );
    const writer = await fakeDispatch(
      run,
      { name: "writer", role: "writer", lane: null, owns: [], ownsImplicit: DOCS_OWNS },
      { proc: "dead", exit: ended },
    );
    // the payment run: the writer edited docs while the L4 fix ran
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "fixed\n");
    writeFileSync(join(repo, "docs", "guide.md"), "# Guide\n");
    writeFileSync(join(repo, "README.md"), "# App\n");
    const l4 = await finalizeDispatch(run, lane);
    expect(l4.changedOwned).toEqual(["src/a.ts"]);
    expect(l4.violations).toEqual([]);
    const w = await finalizeDispatch(run, writer);
    // its record says what it wrote, where 1.4 said "0 owned files changed"
    expect(w.changedOwned).toEqual(["README.md", "docs/guide.md"]);
    expect(w.violations).toEqual([]);
  });

  it("never blames a lane for a test file a running sibling lane owns: the shared tree cannot say who changed it", async () => {
    const { repo, run } = freshRun();
    const ended = {
      code: 0,
      signal: null,
      reason: "exited" as const,
      endedAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const l1 = await fakeDispatch(
      run,
      { name: "worker-M1.L1", lane: "M1.L1", owns: ["src/a.ts"] },
      { proc: "dead", exit: ended },
    );
    await fakeDispatch(
      run,
      { name: "worker-M1.L2", lane: "M1.L2", owns: ["test/x.test.ts"] },
      { proc: "dead", exit: ended },
    );
    mkdirSync(join(repo, "test"), { recursive: true });
    writeFileSync(join(repo, "test", "x.test.ts"), "changed\n");
    const record = await finalizeDispatch(run, l1);
    expect(record.violations).toEqual([]);
    expect(endedEvent(run, record, "M1.L1")).not.toHaveProperty("testEdits");
  });

  it("marks a lost dispatch, which no stronger rung would fix (plan 49)", async () => {
    const { run } = freshRun();
    const ended = {
      code: 0,
      signal: null,
      reason: "exited" as const,
      endedAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const d = await fakeDispatch(run, { name: "worker-M1.L1", lane: "M1.L1" }, { proc: "dead", exit: ended });
    const record = await finalizeDispatch(run, d);
    const lost = { ...record, status: "failed" as const, error: { code: "E_LOST", message: "lost" } };
    expect(endedEvent(run, lost, "M1.L1")).toMatchObject({ lost: true });
    expect(endedEvent(run, { ...lost, error: { code: "E_X", message: "x" } }, "M1.L1")).not.toHaveProperty(
      "lost",
    );
  });
});
