import { describe, expect, it } from "bun:test";
import { barOf } from "../../src/domain/bars.ts";
import { pairOf } from "../../src/domain/catalog.ts";
import { ladderDrop } from "../../src/domain/failover.ts";
import { DIFFICULTIES } from "../../src/domain/lane.ts";
import { defaultProfileDoc, resolveProfile } from "../../src/domain/profile.ts";
import { routingProfileOf } from "../../src/domain/profile-rules.ts";
import {
  candidates,
  defaultDifficulty,
  defaultLadder,
  quotaUsage,
  type RoutingProfile,
  rolesWithoutRung,
  select,
} from "../../src/domain/select.ts";
import { indexOf, shipped } from "./shipped.ts";

const LUNA = "codex:gpt-6-luna#high";
const GO_LUNA = "opencode:opencode-go/gpt-6-luna#high";
const MED = "codex:gpt-6-sol#medium";
const HIGH = "codex:gpt-6-sol#high";
const XHIGH = "codex:gpt-6-sol#xhigh";
const LADDER = [LUNA, MED, HIGH, XHIGH];

const price = { inputPrice: 2, outputPrice: 10 };
/**
 * Five pairs in the shipped families, so the pool is [20, 30, 40, 50, 60] and the bars are copy 30, build 40,
 * logic 44, hard 50. Speeds, tokens per second: Luna high 100, Sol high 90, Sol xhigh 70, Sol medium 50.
 */
const PAIRS = {
  "gpt-6-luna#high": { intelligence: 30, speed: 100, inputPrice: 0.1, outputPrice: 0.5 },
  "gpt-6-sol#medium": { intelligence: 20, speed: 50, ...price },
  "gpt-6-sol#high": { intelligence: 40, speed: 90, ...price },
  "gpt-6-sol#xhigh": { intelligence: 50, speed: 70, ...price },
  "claude-opus-5-5#max": 60,
};
const cat = (over: Parameters<typeof indexOf>[0] = {}) => shipped({ index: indexOf({ ...PAIRS, ...over }) });

/** Spec §7.2's default worker, the default rung Sol medium, the owner's billing. */
const worker = (over: Partial<RoutingProfile> = {}, rungs = LADDER): RoutingProfile => ({
  objective: "cost",
  billing: {},
  role: { enabled: true, rungs, defaultRung: MED },
  ...over,
});

describe("select", () => {
  it("starts on the cheapest rung that clears the difficulty's bar, one bar for every kind", () => {
    const c = cat();
    expect(DIFFICULTIES.map((d) => barOf(c, d))).toEqual([30, 40, 44, 50]);
    // copy 30: Luna high is the cheapest and clears; Sol medium (20) is below it and never climbed onto
    expect(select(c, worker(), "worker", "copy")).toEqual({ rung: LUNA, ladder: [LUNA, HIGH, XHIGH] });
    expect(select(c, worker(), "worker", "build")).toEqual({ rung: HIGH, ladder: [HIGH, XHIGH] });
    expect(select(c, worker(), "worker", "logic")).toEqual({ rung: XHIGH, ladder: [XHIGH] });
    expect(select(c, worker(), "worker", "hard")).toEqual({ rung: XHIGH, ladder: [XHIGH] });
  });

  it("runs a single-rung role on that rung, whatever the bar, and says when it misses", () => {
    const only = worker({}, [MED]);
    expect(select(cat(), only, "architect", "copy")).toEqual({
      rung: MED,
      ladder: [MED],
      noClear: "no rung clears copy (bar 30.0); best is codex:gpt-6-sol#medium (20.0)",
    });
    expect(select(cat(), worker({}, [XHIGH]), "architect", "copy")).toEqual({ rung: XHIGH, ladder: [XHIGH] });
  });

  it("skips bad, unoffered, unlisted, incapable and unindexed rungs, and refuses an empty role", () => {
    const listed = {
      codex: {
        fetchedAt: "2026-09-25T00:00:00.000Z",
        models: [{ id: "gpt-6-sol", efforts: ["low", "medium", "high", "xhigh"], context: 1, imageIn: true }],
      },
    };
    const c = shipped({ listed, index: indexOf({ ...PAIRS, "gpt-6-sol#low": 15, "gpt-6-sol#max": 55 }) });
    const p = worker({}, [
      "nonsense",
      "codex:gpt-6-sol#ultra", // no pair at all
      "codex:gpt-6-sol#max", // indexed, but the listing does not offer it
      LUNA, // the listing lacks gpt-6-luna
      "codex:gpt-6-sol#low",
      "opencode:opencode-go/kimi-k3#default", // no pair
      MED,
    ]);
    expect(candidates(c, p, "worker").map((x) => x.rung)).toEqual(["codex:gpt-6-sol#low", MED]);
    expect(() => select(c, worker({}, ["claude-code:claude-opus-5-5#max"]), "artist", "build")).toThrow(
      'role "artist" has no enabled, capable, indexed rung',
    );
    expect(candidates(c, { ...worker(), role: { enabled: false, rungs: LADDER } }, "worker")).toEqual([]);
  });

  it("ranks subscription rungs before metered ones, then by cost", () => {
    const c = cat({ "claude-opus-5-5#max": 60 });
    const p = worker({}, ["opencode:opencode/gpt-6-luna#high", XHIGH, GO_LUNA]);
    expect(candidates(c, p, "worker").map((x) => x.rung)).toEqual([
      GO_LUNA,
      XHIGH,
      "opencode:opencode/gpt-6-luna#high",
    ]);
  });

  it("breaks a cost tie on the profile's ladder order (spec 1.5 plan 24)", () => {
    const c = cat({ "kimi-k3#max": { intelligence: 45 }, "glm-5#high": { intelligence: 45 } });
    const kimi = "opencode:opencode-go/kimi-k3#max";
    const glm = "opencode:opencode-go/glm-5#high";
    const order = (rungs: string[]) => candidates(c, worker({}, rungs), "worker").map((x) => x.rung);
    // both unpriced on Go: cost 0 each
    expect(order([glm, kimi, MED])).toEqual([glm, kimi, MED]);
    expect(order([kimi, glm, MED])).toEqual([kimi, glm, MED]);
  });

  it("climbs only onto rungs at least as intelligent as the last one kept", () => {
    // Opus low is cheaper than Opus medium on the Claude plan, and a stronger rung is kept wherever cost puts it
    const c = shipped({
      index: indexOf({
        "claude-sonnet-5-5#medium": { intelligence: 30, ...price },
        "claude-opus-5-5#low": { intelligence: 42, inputPrice: 1, outputPrice: 5 },
        "claude-opus-5-5#medium": { intelligence: 51, ...price },
        "claude-sonnet-5-5#high": { intelligence: 46, ...price },
      }),
    });
    const rungs = [
      "claude-code:claude-sonnet-5-5#medium",
      "claude-code:claude-opus-5-5#low",
      "claude-code:claude-sonnet-5-5#high",
      "claude-code:claude-opus-5-5#medium",
    ];
    const p = worker({}, rungs);
    p.role.defaultRung = rungs[0];
    for (const d of DIFFICULTIES) {
      const { ladder } = select(c, p, "worker", d);
      ladder.slice(1).forEach((upper, i) => expect(ladderDrop(c, ladder[i] as string, upper)).toBe(false));
    }
    // Sonnet high (46) comes after Opus medium (51) in cost order and is below it: never on the ladder
    expect(defaultLadder(c, p, "worker").ladder).toEqual([
      rungs[0] as string,
      rungs[1] as string,
      rungs[3] as string,
    ]);
  });

  it("starts on the default rung, raised to an easier difficulty's start, when nothing clears, and says so", () => {
    // no Sol xhigh: logic (44) and hard (50) clear nothing; Sol medium is the default (20), but build's start,
    // Sol high (40), is more intelligent, so a logic or hard lane starts there
    const rungs = [LUNA, MED, HIGH];
    const c = cat();
    const logic = select(c, worker({}, rungs), "worker", "logic");
    expect(logic).toEqual({
      rung: HIGH,
      ladder: [HIGH],
      noClear:
        "no rung clears logic (bar 44.0); best is codex:gpt-6-sol#high (40.0); started at build's start",
    });
    expect(select(c, worker({}, rungs), "worker", "hard").noClear).toMatch(
      /^no rung clears hard \(bar 50\.0\); best is codex:gpt-6-sol#high \(40\.0\); started at build's start$/,
    );
  });

  it("starts on the default rung, with no raise, when no easier start is more intelligent", () => {
    // every bar above every candidate: the default rung starts, and the ladder goes up from it
    const c = shipped({
      index: indexOf({ ...PAIRS, "claude-opus-5-5#max": 90, "claude-opus-5-5#xhigh": 90 }),
    });
    const pick = select(c, worker({}, [LUNA, MED]), "worker", "hard");
    expect(pick.noClear).toMatch(
      /^no rung clears hard \(bar \d+\.\d\); best is codex:gpt-6-luna#high \(30\.0\)$/,
    );
    expect(pick.rung).toBe(MED);
    expect(pick.ladder).toEqual([MED, LUNA]);
  });
});

describe("objective speed", () => {
  const speed = (over: Partial<RoutingProfile> = {}, rungs = LADDER) =>
    worker({ objective: "speed", ...over }, rungs);

  it("orders by speed, fastest first, a pair with none last, then cost", () => {
    const c = cat({ "gpt-6-sol#xhigh": { intelligence: 50, speed: null, ...price } });
    expect(candidates(c, speed(), "worker").map((x) => x.rung)).toEqual([LUNA, HIGH, MED, XHIGH]);
  });

  it("under speed, starts on the fastest clearing pair that has a speed; one with none starts only when no pair with one clears", () => {
    const c = cat({ "gpt-6-sol#xhigh": { intelligence: 50, speed: null, ...price } });
    // build (40): Sol high (90) and Sol xhigh (no speed) clear: the one with a speed starts
    expect(select(c, speed(), "worker", "build")).toEqual({ rung: HIGH, ladder: [HIGH, XHIGH] });
    // hard (50): only Sol xhigh clears, and it has no speed: it starts all the same
    expect(select(c, speed(), "worker", "hard")).toEqual({ rung: XHIGH, ladder: [XHIGH] });
    // copy (30): Luna high is the fastest that clears
    expect(select(cat(), speed(), "worker", "copy").rung).toBe(LUNA);
  });

  it("never climbs onto a weaker rung under speed", () => {
    // build (40) starts on Sol high; Luna high (30) and Sol medium (20) are fast but weaker: off the ladder
    expect(select(cat(), speed(), "worker", "build")).toEqual({ rung: HIGH, ladder: [HIGH, XHIGH] });
    expect(select(cat(), speed(), "worker", "copy")).toEqual({ rung: LUNA, ladder: [LUNA, HIGH, XHIGH] });
  });

  it("falls back from the default rung up the cost order, not onto a faster, weaker rung", () => {
    const rungs = [LUNA, MED, HIGH];
    const pick = select(cat(), speed({}, rungs), "worker", "hard");
    expect(pick.rung).toBe(HIGH);
    expect(pick.noClear).toMatch(/^no rung clears hard/);
  });

  it("keeps the cost ladder as the default ladder under either objective", () => {
    expect(defaultLadder(cat(), speed(), "worker")).toEqual(defaultLadder(cat(), worker(), "worker"));
    expect(defaultLadder(cat(), worker(), "worker")).toEqual({ rung: MED, ladder: [MED, LUNA, HIGH, XHIGH] });
  });
});

describe("defaultDifficulty", () => {
  it("is the hardest bar the default rung clears, build when it clears none", () => {
    // default Sol medium (20) clears nothing: build
    expect(defaultDifficulty(cat(), worker(), "worker")).toBe("build");
    // default Sol high (40) clears copy and build
    const high = worker();
    high.role.defaultRung = HIGH;
    expect(defaultDifficulty(cat(), high, "worker")).toBe("build");
    // default Sol xhigh (50) clears every bar
    const xhigh = worker();
    xhigh.role.defaultRung = XHIGH;
    expect(defaultDifficulty(cat(), xhigh, "worker")).toBe("hard");
    const luna = worker();
    luna.role.defaultRung = LUNA;
    expect(defaultDifficulty(cat(), luna, "worker")).toBe("copy");
  });
});

describe("equal intelligence goes to the quota with more headroom (spec 1.5 plan 24)", () => {
  // Luna on Go is the same model at the same intelligence and price as Luna on Codex: a tie on every bar
  const rungs = [LUNA, GO_LUNA, MED, HIGH, XHIGH];

  it("starts on the less used quota and says the tie decided", () => {
    const pick = select(cat(), worker({ usage: { codex: 3, "opencode-go": 0 } }, rungs), "worker", "copy");
    expect(pick.rung).toBe(GO_LUNA);
    expect(pick.ladder).toEqual([GO_LUNA, LUNA, HIGH, XHIGH]);
    expect(pick.tie).toBe(
      `tie on intelligence with ${LUNA}: started on ${GO_LUNA}; opencode-go has the most headroom (dispatches in this run: codex 3, opencode-go 0)`,
    );
    const back = select(cat(), worker({ usage: { codex: 1, "opencode-go": 2 } }, rungs), "worker", "copy");
    expect(back.rung).toBe(LUNA);
  });

  it("breaks a tie with equal headroom on the profile's ladder order, and says so", () => {
    const first = select(cat(), worker({}, [GO_LUNA, LUNA, MED, HIGH]), "worker", "copy");
    expect(first.rung).toBe(GO_LUNA);
    expect(first.tie).toMatch(
      /equal headroom \(0 dispatches each\); the profile's ladder order and cost decided$/,
    );
    expect(select(cat(), worker({}, [LUNA, GO_LUNA, MED, HIGH]), "worker", "copy").rung).toBe(LUNA);
  });

  it("never gives a tie to a metered rung over one paid from a plan", () => {
    const p = worker({ billing: { "opencode-go": "metered" }, usage: { codex: 9 } }, rungs);
    const pick = select(cat(), p, "worker", "copy");
    expect(pick.rung).toBe(LUNA);
    expect(pick.tie).toBeUndefined();
  });

  it("leaves a start with no equal alone", () => {
    expect(select(cat(), worker(), "worker", "copy").tie).toBeUndefined();
  });
});

describe("quotaUsage", () => {
  it("counts a run's dispatched rungs per quota, Claude's two paths as one", () => {
    expect(
      quotaUsage([
        "codex:gpt-6-luna#high",
        "codex:gpt-6-sol#high",
        "claude:claude-opus-5-5#low",
        "claude-code:claude-opus-5-5#low",
        "opencode:opencode-go/gpt-6-luna#high",
        "not a rung",
      ]),
    ).toEqual({ codex: 2, "claude-code": 2, "opencode-go": 1 });
  });
});

describe("the default profile's worker on the recorded index", () => {
  it("keeps the default worker's ladders rising", () => {
    const c = shipped();
    const p = routingProfileOf(resolveProfile(defaultProfileDoc(), "default", "claude-code"), "worker");
    for (const d of DIFFICULTIES) {
      const pick = select(c, p, "worker", d);
      const xs = pick.ladder.map((r) => pairOf(c, r)?.intelligence as number);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
      expect(
        pick.noClear !== undefined || (pairOf(c, pick.rung)?.intelligence as number) >= barOf(c, d),
      ).toBe(true);
    }
  });
});

describe("rolesWithoutRung", () => {
  const roles = (over: Record<string, { enabled: boolean; rungs: string[] }> = {}) => ({
    objective: "cost" as const,
    billing: {},
    roles: { worker: { enabled: true, rungs: LADDER }, ...over },
  });

  it("names each enabled role with no candidate, in role order, never a disabled one", () => {
    const c = cat();
    expect(rolesWithoutRung(c, roles())).toEqual([]);
    const v = roles({
      writer: { enabled: true, rungs: ["codex:gpt-6-sol#turbo"] },
      reviewer: { enabled: true, rungs: [] },
      artist: { enabled: false, rungs: ["codex:gpt-6-sol#turbo"] },
    });
    // ROLES order, not the profile's key order
    expect(rolesWithoutRung(c, v)).toEqual(["reviewer", "writer"]);
  });

  it("counts a rung the index lost as no rung", () => {
    const lost = shipped({ index: indexOf({ "gpt-6-luna#high": 30, "claude-opus-5-5#max": 60 }) });
    expect(rolesWithoutRung(lost, roles({ reviewer: { enabled: true, rungs: [HIGH] } }))).toEqual([
      "reviewer",
    ]);
  });
});
