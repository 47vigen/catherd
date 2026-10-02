import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activityDir, activityReporter, lastLockOutput } from "../../src/infra/lock-activity.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

describe("a catherd lock's output report (plan 23)", () => {
  it("records the latest output of a live lock, throttled, and nothing once it is done", () => {
    withHome();
    let t = Date.parse("2026-10-02T10:00:00Z");
    const r = activityReporter("01DISPATCH", () => t);
    expect(lastLockOutput("01DISPATCH")).toBe(t);
    const first = t;
    t += 500;
    r?.tick();
    // within ACTIVITY_EVERY_MS of the last write: not written again
    expect(lastLockOutput("01DISPATCH")).toBe(first);
    t += 600;
    r?.tick();
    expect(lastLockOutput("01DISPATCH")).toBe(t);
    r?.done();
    expect(lastLockOutput("01DISPATCH")).toBeNull();
  });

  it("ignores a lock whose process is gone, and refuses an id that names a path", () => {
    withHome();
    const dir = activityDir("01GONE");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "999999.json"),
      JSON.stringify({ schema: 1, pid: 999_999_999, startTime: null, at: new Date().toISOString() }),
    );
    expect(lastLockOutput("01GONE")).toBeNull();
    expect(activityReporter("../x")).toBeNull();
    expect(activityReporter(undefined)).toBeNull();
  });
});
