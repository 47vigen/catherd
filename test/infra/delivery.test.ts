import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deliveryState,
  readDelivery,
  writeDeliveryAttempt,
  type DeliveryAttempt,
} from "../../src/infra/delivery.ts";
import { dispatchPaths, endCollect, markForCollect, tryCollect } from "../../src/infra/dispatch-dir.ts";
import * as store from "../../src/infra/store.ts";
import { lockHeld } from "../../src/infra/filelock.ts";

const target = {
  host: "codex" as const,
  sessionId: "0199c011-1234-7000-8000-000000000001",
  hostSessionId: null,
  name: null,
};
const attempt = (over: Partial<DeliveryAttempt> = {}): DeliveryAttempt => ({
  attemptId: "a",
  target,
  eventIds: ['["run","dispatch","finished"]'],
  at: "2026-10-01T00:00:00.000Z",
  status: "submitting",
  msgId: null,
  reason: null,
  ...over,
});
const dir = () => mkdtempSync(join(tmpdir(), "catherd-delivery-"));

describe("owner-scoped delivery metadata", () => {
  it("holds the same existing file lock for both event kinds during every durable update", () => {
    const d = dir();
    const write = store.writeJsonAtomic;
    const spy = spyOn(store, "writeJsonAtomic").mockImplementation((file, contents, options) => {
      expect(file).toBe(dispatchPaths(d).delivery);
      expect(lockHeld(file)).toBe(true);
      write(file, contents, options);
    });
    try {
      writeDeliveryAttempt(d, attempt());
      writeDeliveryAttempt(d, attempt({ attemptId: "b", eventIds: ['["run","dispatch","stalled"]'] }));
      writeDeliveryAttempt(d, attempt({ status: "accepted", msgId: "receipt" }));
    } finally {
      spy.mockRestore();
    }
    expect(readDelivery(d)).toHaveLength(2);
    expect(lockHeld(dispatchPaths(d).delivery)).toBe(false);
  });
  it("updates one attempt, keeps prior attempts, and derives collection only from the collect lease", async () => {
    const d = dir();
    markForCollect(d);
    const a = attempt();
    expect(deliveryState(d, target, a.eventIds[0]!)).toBe("pending");
    writeDeliveryAttempt(d, a);
    expect(deliveryState(d, target, a.eventIds[0]!)).toBe("ambiguous");
    writeDeliveryAttempt(d, { ...a, status: "accepted", msgId: "native-id" });
    writeDeliveryAttempt(
      d,
      attempt({ attemptId: "b", eventIds: ["stall"], status: "failed", reason: "no endpoint" }),
    );
    expect(readDelivery(d)).toHaveLength(2);
    expect(deliveryState(d, target, a.eventIds[0]!)).toBe("enqueue-accepted");
    expect(deliveryState(d, { ...target, host: "claude-code" }, a.eventIds[0]!)).toBe("pending");
    expect(await tryCollect(d)).toBe(true);
    endCollect(d);
    expect(deliveryState(d, target, a.eventIds[0]!)).toBe("collected");
    expect(deliveryState(d, target, "stall")).toBe("pending");
  });

  it("retains corrupt/newer metadata as ambiguous and never overwrites it", () => {
    for (const contents of [
      "{partial",
      '{"schema":2,"attempts":[]}',
      JSON.stringify({ schema: 1, attempts: [attempt({ status: "accepted" })] }),
    ]) {
      const d = dir();
      markForCollect(d);
      writeFileSync(join(d, "delivery.json"), contents);
      expect(deliveryState(d, target, "event")).toBe("ambiguous");
      expect(() => readDelivery(d)).toThrow();
      expect(() => writeDeliveryAttempt(d, attempt())).toThrow();
      expect(readFileSync(join(d, "delivery.json"), "utf8")).toBe(contents);
    }
  });

  it("keeps a sent target and event set immutable", () => {
    const d = dir();
    writeDeliveryAttempt(d, attempt());
    expect(() => writeDeliveryAttempt(d, attempt({ target: { ...target, sessionId: "other" } }))).toThrow();
    expect(() => writeDeliveryAttempt(d, attempt({ eventIds: ["other"] }))).toThrow();
    expect(dispatchPaths(d).delivery).toBe(join(d, "delivery.json"));
  });
});
