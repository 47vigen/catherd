import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { appendRecord, readRecords, runPaths } from "../../src/services/run-store.ts";
import { runOwner } from "../../src/services/sessions.ts";
import { wait, WAIT_TIMEOUT_MS } from "../../src/services/wait-service.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun, makeRecord } from "./helpers.ts";

afterEach(snapshotEnv());

describe("bounded orchestrator wait", () => {
  it("observes the first completed target without collecting, claiming or dispatching", async () => {
    const { run } = freshRun();
    const ready = await fakeDispatch(run, { name: "ready" }, { collect: true });
    const pending = await fakeDispatch(run, { name: "pending" }, { collect: true });
    const waiting = wait(fakeDeps(), { run: run.id, names: ["ready", "pending"] });
    await appendRecord(run, makeRecord({ runId: run.id, dispatchId: ready.admit.dispatchId, name: "ready" }));
    expect(await waiting).toEqual({
      run: run.id,
      status: "ready",
      completed: [{ name: "ready", dispatchId: ready.admit.dispatchId }],
      pending: [{ name: "pending", dispatchId: pending.admit.dispatchId }],
    });
    expect(existsSync(dispatchPaths(ready.dir).collect)).toBe(true);
    expect(existsSync(dispatchPaths(ready.dir).lease)).toBe(false);
    expect(readRecords(run).records).toHaveLength(1);
    expect(existsSync(runPaths(run.dir).state)).toBe(false);
    expect(existsSync(runPaths(run.dir).stateJson)).toBe(false);
    expect(runOwner(run)).toBeNull();
  });

  it("times out without consuming a pending target", async () => {
    const { run } = freshRun();
    const d = await fakeDispatch(run, {}, { collect: true });
    expect(await wait(fakeDeps(), { run: run.id, names: [d.admit.name], timeout_ms: 0 })).toMatchObject({
      status: "timeout",
      completed: [],
      pending: [{ name: d.admit.name, dispatchId: d.admit.dispatchId }],
    });
    expect(readRecords(run).records).toEqual([]);
    expect(existsSync(dispatchPaths(d.dir).collect)).toBe(true);
  });

  it("cancels an active wait and leaves its unread target available", async () => {
    const { run } = freshRun();
    const d = await fakeDispatch(run, {}, { collect: true });
    const controller = new AbortController();
    const waiting = wait(fakeDeps(), { run: run.id, names: [d.admit.name] }, controller.signal);
    controller.abort();
    expect(await waiting).toMatchObject({
      status: "cancelled",
      completed: [],
      pending: [{ name: d.admit.name, dispatchId: d.admit.dispatchId }],
    });
    expect(existsSync(dispatchPaths(d.dir).collect)).toBe(true);
  });

  it("does not replay a record already collected", async () => {
    const { run } = freshRun();
    const d = await fakeDispatch(run);
    await appendRecord(run, makeRecord({ runId: run.id, dispatchId: d.admit.dispatchId }));
    expect(await wait(fakeDeps(), { run: run.id, names: [d.admit.name] })).toMatchObject({
      status: "timeout",
      completed: [],
      pending: [],
    });
  });

  it("rejects unknown names and timeouts beyond the bound", async () => {
    const { run } = freshRun();
    await expect(wait(fakeDeps(), { run: run.id, names: ["missing"] })).rejects.toMatchObject({
      code: "E_INPUT_INVALID",
    });
    await expect(
      wait(fakeDeps(), { run: run.id, names: ["missing"], timeout_ms: WAIT_TIMEOUT_MS + 1 }),
    ).rejects.toMatchObject({ code: "E_INPUT_INVALID" });
  });

  it("follows only a persisted linked failover and returns its stand-in record", async () => {
    const { run } = freshRun();
    const limited = await fakeDispatch(run, {}, { collect: true });
    const waiting = wait(fakeDeps(), { run: run.id, names: [limited.admit.name] });
    await appendRecord(
      run,
      makeRecord({ runId: run.id, dispatchId: limited.admit.dispatchId, status: "limit" }),
    );
    const standIn = await fakeDispatch(
      run,
      { name: limited.admit.name, failoverOf: limited.admit.dispatchId },
      { collect: true },
    );
    await appendRecord(run, makeRecord({ runId: run.id, dispatchId: standIn.admit.dispatchId }));
    writeJsonAtomic(dispatchPaths(limited.dir).failover, {
      schema: 1,
      at: new Date().toISOString(),
      standIn: { dispatchId: standIn.admit.dispatchId, rung: standIn.admit.rung },
      hints: [],
      pause: null,
    });
    expect(await waiting).toMatchObject({
      status: "ready",
      completed: [{ name: standIn.admit.name, dispatchId: standIn.admit.dispatchId }],
      pending: [],
    });
    expect(existsSync(dispatchPaths(limited.dir).collect)).toBe(true);
    expect(existsSync(dispatchPaths(standIn.dir).collect)).toBe(true);
  });
});
