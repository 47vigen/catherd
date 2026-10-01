import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDebug, tail } from "../../src/services/run-debug.ts";

describe("tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "catherd-tail-"));
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i} é🐈`);
  const file = join(dir, "stderr");
  writeFileSync(file, `${lines.join("\n")}\n\n  \n`);

  it("reads the last lines from the end, keeping a line and a character split between reads whole", () => {
    // 7-byte reads split lines and multi-byte characters over and over
    expect(tail(file, 20, 7)).toEqual(lines.slice(-20));
    expect(tail(file, 20)).toEqual(lines.slice(-20));
  });

  it("returns every line of a file shorter than asked, and nothing for a missing file", () => {
    expect(tail(file, 5000, 64)).toEqual(lines);
    expect(tail(join(dir, "missing"))).toEqual([]);
  });
});

import { writeDeliveryAttempt } from "../../src/infra/delivery.ts";
import { awaitsCollect, dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { appendRecord } from "../../src/services/run-store.ts";
import { claimRun, runOwner } from "../../src/services/sessions.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun, makeRecord } from "./helpers.ts";
afterEach(snapshotEnv());

it("full debug distinguishes accepted unread from collected without claiming ownership", async () => {
  const { run } = freshRun();
  const deps = fakeDeps({
    host: {
      host: "codex",
      session: {
        host: "codex",
        sessionId: "01a0f53b-a47d-7350-83a4-c3430e453404",
        hostSessionId: null,
        name: null,
      },
      conflict: null,
    },
  });
  await claimRun(deps, run);
  const before = runOwner(run);
  const d = await fakeDispatch(run, {}, { collect: true });
  await appendRecord(run, makeRecord({ runId: run.id, dispatchId: d.admit.dispatchId }));
  const eventId = JSON.stringify([run.id, d.admit.dispatchId, "finished"]);
  writeDeliveryAttempt(d.dir, {
    attemptId: "one",
    target: deps.host.session!,
    eventIds: [eventId],
    at: "2026-10-01T12:00:00.000Z",
    status: "accepted",
    msgId: "queue-id",
    reason: null,
    messagingToken: "never-report",
  });
  expect(runDebug(run)[0]).toMatchObject({
    eventId,
    delivery: "enqueue-accepted",
    receipt: { msgId: "queue-id" },
  });
  expect(awaitsCollect(d.dir)).toBe(true);
  expect(JSON.stringify(runDebug(run))).not.toContain("never-report");
  const { unlinkSync } = await import("node:fs");
  unlinkSync(dispatchPaths(d.dir).collect);
  expect(runDebug(run)[0]?.delivery).toBe("collected");
  expect(runOwner(run)).toEqual(before);
});

import { peek } from "../../src/services/peek.ts";
import { status } from "../../src/services/summary.ts";

it("drops a stall the role outlived before any send, but keeps one that was sent", async () => {
  const { run } = freshRun();
  const target = {
    host: "codex" as const,
    sessionId: "01a0f53b-a47d-7350-83a4-c3430e453404",
    hostSessionId: null,
    name: null,
  };
  const deps = fakeDeps({ host: { host: "codex", session: target, conflict: null } });
  await claimRun(deps, run);
  const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: "2026-10-01T12:05:00.000Z" };
  const unsent = await fakeDispatch(run, { name: "worker-M1.L1" }, { proc: "dead", exit, collect: true });
  const sent = await fakeDispatch(run, { name: "worker-M1.L2" }, { proc: "dead", exit, collect: true });
  const failed = await fakeDispatch(run, { name: "worker-M1.L3" }, { proc: "dead", exit, collect: true });
  const elsewhere = await fakeDispatch(run, { name: "worker-M1.L4" }, { proc: "dead", exit, collect: true });
  for (const d of [unsent, sent, failed, elsewhere]) writeFileSync(dispatchPaths(d.dir).stall, "{}");
  // a non-submission, and an attempt for an earlier owner: neither can ever reach this owner now
  for (const [d, to, status] of [
    [failed, target, "failed"],
    [elsewhere, { ...target, sessionId: "01a0f53b-a47d-7350-83a4-c3430e453405" }, "accepted"],
  ] as const)
    writeDeliveryAttempt(d.dir, {
      attemptId: `stall-${d.admit.name}`,
      target: to,
      eventIds: [JSON.stringify([run.id, d.admit.dispatchId, "stalled"])],
      at: "2026-10-01T12:00:00.000Z",
      status,
      msgId: status === "accepted" ? "old-owner" : null,
      reason: status === "failed" ? "socket closed" : null,
    });
  const sentId = JSON.stringify([run.id, sent.admit.dispatchId, "stalled"]);
  writeDeliveryAttempt(sent.dir, {
    attemptId: "stall-sent",
    target,
    eventIds: [sentId],
    at: "2026-10-01T12:00:00.000Z",
    status: "accepted",
    msgId: "stall-id",
    reason: null,
  });
  const kinds = (name: string) =>
    runDebug(run)
      .find((x) => x.name === name)!
      .deliveries.map((e) => JSON.parse(e.eventId)[2]);
  expect(kinds("worker-M1.L1")).toEqual([]);
  expect(kinds("worker-M1.L3")).toEqual([]);
  expect(kinds("worker-M1.L4")).toEqual([]);
  expect(kinds("worker-M1.L2")).toEqual(["stalled"]);
  expect(status(deps, run.id).runs[0]!.delivery.map((e) => e.eventId)).toEqual([sentId]);
  expect((await peek(fakeDeps(), {})).runs[0]!.delivery.map((e) => e.eventId)).toEqual([sentId]);
});

it("shows accepted stalled delivery while live without treating it as an unread result", async () => {
  const { run } = freshRun();
  const target = {
    host: "codex" as const,
    sessionId: "01a0f53b-a47d-7350-83a4-c3430e453404",
    hostSessionId: null,
    name: null,
  };
  const deps = fakeDeps({ host: { host: "codex", session: target, conflict: null } });
  await claimRun(deps, run);
  const d = await fakeDispatch(run, {}, { proc: "self", collect: true });
  writeFileSync(dispatchPaths(d.dir).stall, "{}");
  const eventId = JSON.stringify([run.id, d.admit.dispatchId, "stalled"]);
  writeDeliveryAttempt(d.dir, {
    attemptId: "stall-one",
    target,
    eventIds: [eventId],
    at: "2026-10-01T12:00:00.000Z",
    status: "accepted",
    msgId: "stall-id",
    reason: null,
  });
  const expected = { eventId, delivery: "enqueue-accepted", receipt: { msgId: "stall-id" } };
  expect(runDebug(run)[0]).toMatchObject(expected);
  expect(status(deps, run.id).runs[0]!.delivery[0]).toMatchObject(expected);
  const inspected = (await peek(fakeDeps(), {})).runs[0]!;
  expect(inspected.delivery[0]).toMatchObject(expected);
  expect(inspected.unread).toEqual([]);
  expect(awaitsCollect(d.dir)).toBe(true);
  await appendRecord(run, makeRecord({ runId: run.id, dispatchId: d.admit.dispatchId }));
  expect(runDebug(run)[0]!.deliveries.map((e) => JSON.parse(e.eventId)[2])).toEqual(["finished", "stalled"]);
  expect(runDebug(run)[0]!.deliveries[1]).toMatchObject(expected);
});
