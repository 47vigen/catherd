import { afterEach, describe, expect, it } from "bun:test";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { configuredBackends, failoverRung, indexedPairs } from "../../src/services/failover-rungs.ts";
import { profileFile } from "../../src/services/profile-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, testView } from "./helpers.ts";

afterEach(snapshotEnv());

const LUNA = "codex:gpt-6-luna#high"; // 32.9
const SOL_HIGH = "codex:gpt-6-sol#high"; // 42.4
const GO_LUNA = "opencode:opencode-go/gpt-6-luna#high"; // 32.9
const GO_LUNA_XHIGH = "opencode:opencode-go/gpt-6-luna#xhigh"; // 34.6
const GO_LUNA_LOW = "opencode:opencode-go/gpt-6-luna#low"; // 21.5
const CURSOR_SOL = "cursor:gpt-6-sol#high"; // 42.4
const OPUS = "claude-code:claude-opus-5-5#high"; // 53.6

const setup = (over: Parameters<typeof testView>[0] = {}) => {
  const { run } = freshRun();
  return { run, deps: fakeDeps({ view: testView(over) }) };
};

describe("failoverRung", () => {
  it("prefers the profile's stand-in when its quota is free and it is not weaker", () => {
    const { run, deps } = setup({ failover: { [LUNA]: GO_LUNA_XHIGH } });
    expect(failoverRung(deps, run, "worker", LUNA, ["codex"])).toBe(GO_LUNA_XHIGH);
    // a stand-in the index puts below the rung is a step down: the ranking takes over
    deps.view.failover = { [LUNA]: GO_LUNA_LOW };
    expect(failoverRung(deps, run, "worker", LUNA, ["codex"])).not.toBe(GO_LUNA_LOW);
  });

  it("reaches a backend only another profile uses", () => {
    const { run, deps } = setup({ billing: { cursor: "subscription" }, failover: {} });
    expect(configuredBackends()).not.toContain("cursor");
    expect(failoverRung(deps, run, "worker", SOL_HIGH, ["codex", "claude-code"])).toBeNull();
    writeJsonAtomic(profileFile("other"), {
      schema: 1,
      roles: { worker: { rungs: [CURSOR_SOL] } },
    });
    expect(configuredBackends()).toContain("cursor");
    expect(failoverRung(deps, run, "worker", SOL_HIGH, ["codex", "claude-code"])).toBe(CURSOR_SOL);
  });

  it("never steps down, and waits when every candidate is held or lower", () => {
    const { run, deps } = setup({ failover: { [SOL_HIGH]: GO_LUNA } });
    // the only free pairs on another quota are weaker than gpt-6-sol#high
    expect(failoverRung(deps, run, "worker", SOL_HIGH, ["codex", "claude-code"])).toBeNull();
    // a rung every other quota of which is held waits too
    expect(
      failoverRung(deps, run, "worker", LUNA, ["codex", "opencode-go", "claude-code", "cursor"]),
    ).toBeNull();
  });

  it("puts Claude rungs last, and picks the nearest index", () => {
    const { run, deps } = setup({ failover: {} });
    // free: opencode-go luna (equal), claude opus (far above): the non-Claude one wins
    expect(failoverRung(deps, run, "worker", LUNA, ["codex"])).toBe(GO_LUNA);
    // only Claude is free
    expect(failoverRung(deps, run, "worker", LUNA, ["codex", "opencode-go", "cursor"])).toBe(
      "claude-code:claude-sonnet-5#xhigh",
    );
  });

  it("fails a rung with no index over only to its explicit stand-in", () => {
    const { run, deps } = setup({ failover: { "codex:gpt-6-sol#medium": OPUS } });
    const unindexed = "codex:no-such-model#high";
    expect(failoverRung(deps, run, "worker", unindexed, ["codex"])).toBeNull();
    deps.view.failover = { [unindexed]: OPUS };
    expect(failoverRung(deps, run, "worker", unindexed, ["codex"])).toBe(OPUS);
    expect(failoverRung(deps, run, "worker", unindexed, ["codex", "claude-code"])).toBeNull();
  });
});

describe("indexedPairs", () => {
  it("lists every indexed rung with its intelligence", () => {
    const { deps } = setup();
    freshRun();
    const pairs = indexedPairs(deps);
    expect(pairs.find((p) => p.rung === LUNA)?.intelligence).toBeGreaterThan(30);
    expect(pairs.every((p) => typeof p.intelligence === "number")).toBe(true);
  });
});
