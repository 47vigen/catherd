import { afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_MAX_EFFORT } from "../../src/domain/profile.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { writeRunIndex } from "../../src/services/catalog-service.ts";
import { configuredBackends, failoverRung, indexedPairs } from "../../src/services/failover-rungs.ts";
import { profileFile } from "../../src/services/profile-store.ts";
import { indexOf } from "../domain/shipped.ts";
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

describe("failoverRung and the effort ceiling and floor (plan 33)", () => {
  const SOL_MED = "codex:gpt-6-sol#medium";
  // Go serves GPT-6 Luna at every effort; the shipped catalog knows no Kimi, so the pool cannot list it
  const GO = "opencode:opencode-go/gpt-6-luna";
  const roles = (worker: string[], other: string[]) => ({
    ...testView().roles,
    worker: { enabled: true, access: "workspace-write" as const, rungs: worker },
    writer: { enabled: true, access: "workspace-write" as const, rungs: other },
  });
  // both Kimi rungs and Sol medium are configured, so both backends are failover targets
  const standIns = (over: Parameters<typeof testView>[0] = {}) => {
    const s = setup({ roles: roles([SOL_MED], [`${GO}#low`, `${GO}#xhigh`]), ...over });
    writeRunIndex(
      s.run.dir,
      indexOf({ "gpt-6-sol#medium": 36, "gpt-6-luna#low": 38, "gpt-6-luna#xhigh": 45 }),
    );
    return s;
  };

  it("never fails over above maxEffort, nor a worker below medium", () => {
    const a = standIns();
    expect(failoverRung(a.deps, a.run, "reviewer", SOL_MED, ["codex"])).toBe(`${GO}#low`);
    expect(failoverRung(a.deps, a.run, "worker", SOL_MED, ["codex"])).toBe(`${GO}#xhigh`);
    const b = standIns({ maxEffort: { [GO]: "high" } });
    expect(failoverRung(b.deps, b.run, "reviewer", SOL_MED, ["codex"])).toBe(`${GO}#low`);
    expect(failoverRung(b.deps, b.run, "worker", SOL_MED, ["codex"])).toBeNull();
  });

  it("skips an explicit stand-in above maxEffort and takes the next", () => {
    const s = standIns({ failover: { [SOL_MED]: `${GO}#xhigh` }, maxEffort: { [GO]: "low" } });
    expect(failoverRung(s.deps, s.run, "reviewer", SOL_MED, ["codex"])).toBe(`${GO}#low`);
  });

  it("never fails over above the default profile's shipped caps", () => {
    const OPUS_HIGH = "claude-code:claude-opus-5-5#high";
    const view = {
      roles: roles(["codex:gpt-6-sol#xhigh"], [OPUS_HIGH]),
      maxEffort: { ...DEFAULT_MAX_EFFORT } as Record<string, string>,
    };
    const make = (maxEffort: Record<string, string>) => {
      const s = setup({ ...view, maxEffort });
      writeRunIndex(
        s.run.dir,
        indexOf({ "gpt-6-sol#xhigh": 46, "claude-opus-5-5#high": 44, "claude-opus-5-5#max": 48 }),
      );
      return s;
    };
    const capped = make(view.maxEffort);
    // only Opus max is at least as intelligent as 46, and the default profile caps Opus at high
    expect(failoverRung(capped.deps, capped.run, "worker", "codex:gpt-6-sol#xhigh", ["codex"])).toBeNull();
    // the same run after `maxEffort.claude-code:claude-opus-5-5 null`
    const open = make({ ...view.maxEffort, "claude-code:claude-opus-5-5": "max" });
    expect(failoverRung(open.deps, open.run, "worker", "codex:gpt-6-sol#xhigh", ["codex"])).toBe(
      "claude-code:claude-opus-5-5#max",
    );
  });
});
