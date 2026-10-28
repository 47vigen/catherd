import { afterEach, describe, expect, it } from "bun:test";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { names, result, setNext } from "../../src/services/run-service.ts";
import { readNotes } from "../../src/services/state.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const exit = (endedAt = new Date().toISOString()) => ({
  code: 0,
  signal: null,
  reason: "exited" as const,
  endedAt,
});

describe("state.md's Next never outlives the step it names (plan 22)", () => {
  it("names a role or lane only as a whole word", () => {
    expect(names("dispatch M3.L1 at codex:gpt-6-sol#medium on a fresh thread", "M3.L1")).toBe(true);
    expect(names("then land; worker-M3.L1.", "worker-M3.L1")).toBe(true);
    expect(names("dispatch M3.L10", "M3.L1")).toBe(false);
    expect(names("dispatch worker-M3.L1-fix", "worker-M3.L1")).toBe(false);
    expect(names("dispatch M3.L1.b", "M3.L1")).toBe(false);
  });

  it("result() of the dispatch Next names moves Next past it; another leaves it", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const deps = fakeDeps();
    await setNext({ run: run.id, next: "dispatch M1.L1 at codex:gpt-6-sol#medium on a fresh thread" });
    const other = await fakeDispatch(
      run,
      { name: "researcher-1", role: "researcher", lane: null },
      { proc: "dead", exit: exit(), reply: "Map.\nSTATUS: complete — ok", collect: true },
    );
    await finalizeDispatch(run, other);
    await result(deps, { run: run.id, name: "researcher-1" });
    expect(readNotes(run).next).toBe("dispatch M1.L1 at codex:gpt-6-sol#medium on a fresh thread");
    const d = await fakeDispatch(
      run,
      {},
      { proc: "dead", exit: exit(), reply: "Done.\nSTATUS: complete — ok", collect: true },
    );
    const record = await finalizeDispatch(run, d);
    await result(deps, { run: run.id, name: "worker-M1.L1" });
    expect(readNotes(run).next).toBe(`after worker-M1.L1 (${record.status})`);
    await setNext({ run: run.id, next: "dispatch worker-M1.L1 again with the reviewer's findings" });
    await result(deps, { run: run.id, name: "worker-M1.L1" });
    expect(readNotes(run).next).toBe("dispatch worker-M1.L1 again with the reviewer's findings");
  });
});
