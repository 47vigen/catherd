import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { HostSessionRef } from "../../src/domain/host.ts";
import { deliveryState, readDelivery, ROLE_THREAD_REFUSAL } from "../../src/infra/delivery.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { watchersSettled } from "../../src/services/dispatch-service.ts";
import { roleThreadOf } from "../../src/services/dispatches.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { type Notifier, startNotifier } from "../../src/services/notifier.ts";
import type { Run } from "../../src/services/run-store.ts";
import { claimRun, runOwner } from "../../src/services/sessions.ts";
import { summarizeRun } from "../../src/services/summary.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const notifiers: Notifier[] = [];
afterEach(() => {
  for (const n of notifiers.splice(0)) n.stop();
});

const COORDINATOR = "0199c011-1234-7000-8000-00000000c00d";
const VERIFIER_THREAD = "0199c011-1234-7000-8000-0000000001e5";
const ref = (sessionId: string): HostSessionRef => ({
  host: "codex",
  sessionId,
  hostSessionId: null,
  name: null,
});
const as = (sessionId: string) =>
  fakeDeps({ host: { host: "codex", session: ref(sessionId), conflict: null } });
const exit = () => ({ code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() });
const codexEvents = (thread: string) =>
  `${JSON.stringify({ type: "thread.started", thread_id: thread })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })}\n`;

/** The payment run's P1, as 1.4 left it: the verifier's `codex exec` thread owns the run. */
async function stolenRun(): Promise<{ run: Run; eventId: string; dir: string }> {
  const { run } = freshRun();
  await claimRun(as(COORDINATOR), run);
  const verifier = await fakeDispatch(
    run,
    { name: "verifier-M1", role: "verifier", lane: null, owns: [], access: "read-only" },
    {
      proc: "dead",
      exit: exit(),
      reply: "VERDICT: PASS\nSTATUS: complete — ok",
      collect: true,
      events: codexEvents(VERIFIER_THREAD),
    },
  );
  await finalizeDispatch(run, verifier);
  await claimRun(as(VERIFIER_THREAD), run);
  expect(runOwner(run)?.sessionId).toBe(VERIFIER_THREAD);
  const worker = await fakeDispatch(
    run,
    { name: "worker-M1.L2" },
    { proc: "dead", exit: exit(), reply: "STATUS: complete — ok", collect: true },
  );
  await finalizeDispatch(run, worker);
  return { run, eventId: JSON.stringify([run.id, worker.admit.dispatchId, "finished"]), dir: worker.dir };
}

describe("deliveries never target a role thread (spec 1.5 plan 21)", () => {
  it("knows a role's thread from its record, its resume, or what its supervisor wrote down", async () => {
    const { run } = freshRun();
    const live = await fakeDispatch(run, { name: "worker-M1.L1" }, { proc: "self" });
    expect(roleThreadOf(run, VERIFIER_THREAD)).toBeNull();
    writeJsonAtomic(dispatchPaths(live.dir).thread, {
      schema: 1,
      thread: VERIFIER_THREAD,
      at: new Date().toISOString(),
    });
    expect(roleThreadOf(run, VERIFIER_THREAD)).toBe("worker-M1.L1");
    await fakeDispatch(run, { name: "worker-M1.L2", thread: "0199c011-1234-7000-8000-0000000000aa" });
    expect(roleThreadOf(run, "0199c011-1234-7000-8000-0000000000aa")).toBe("worker-M1.L2");
    expect(roleThreadOf(run, COORDINATOR)).toBeNull();
  });

  it("fails a notice to a role's thread loudly, never sends it, and status warns; the orchestrator gets it once it takes the run back", async () => {
    const { run, eventId, dir } = await stolenRun();
    const sent: string[] = [];
    const role = startNotifier(as(VERIFIER_THREAD), {
      coalesceMs: 0,
      sendCodex: async (target) => {
        sent.push(target.sessionId);
        return { outcome: "accepted", msgId: "m" };
      },
    });
    notifiers.push(role);
    await role.scan();
    await role.idle();
    expect(sent).toEqual([]);
    const last = readDelivery(dir).at(-1);
    expect(last).toMatchObject({ status: "failed", target: { sessionId: VERIFIER_THREAD } });
    expect(last?.reason).toStartWith(`${ROLE_THREAD_REFUSAL} (verifier-M1, codex ${VERIFIER_THREAD})`);
    expect(deliveryState(dir, ref(VERIFIER_THREAD), eventId)).not.toBe("enqueue-accepted");
    expect(summarizeRun(fakeDeps(), run).warnings).toContain(
      `worker-M1.L2: its notice was not sent: ${last?.reason}`,
    );
    role.stop();

    // the orchestrator takes the run back (peek claims): the notice is still pending for it, and goes
    await claimRun(as(COORDINATOR), run);
    expect(deliveryState(dir, ref(COORDINATOR), eventId)).toBe("pending");
    const coordinator = startNotifier(as(COORDINATOR), {
      coalesceMs: 0,
      sendCodex: async (target) => {
        sent.push(target.sessionId);
        return { outcome: "accepted", msgId: "m2" };
      },
    });
    notifiers.push(coordinator);
    await coordinator.scan();
    await coordinator.idle();
    expect(sent).toContain(COORDINATOR);
    expect(sent).not.toContain(VERIFIER_THREAD);
    expect(deliveryState(dir, ref(COORDINATOR), eventId)).toBe("enqueue-accepted");
    expect(summarizeRun(fakeDeps(), run).warnings.filter((w) => w.includes(ROLE_THREAD_REFUSAL))).toEqual([]);
  });
});
