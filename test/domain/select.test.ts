import { describe, expect, it } from "bun:test";
import { DEFAULT_BILLING } from "../../src/domain/cost.ts";
import {
  candidates,
  decisionCandidates,
  effortAllowed,
  noRungCause,
  quotaUsage,
  type RoutingProfile,
  rolesWithoutRung,
  tieBreak,
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
 * Five pairs in the shipped families, so the pool is [20, 30, 40, 50, 60] and the bars are copy 28, build 38,
 * logic 44, hard 46. Speeds, tokens per second: Luna high 100, Sol high 90, Sol xhigh 70, Sol medium 50.
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
  billing: {},
  role: { enabled: true, rungs, defaultRung: MED },
  ...over,
});

describe("candidates", () => {
  it("skips bad, unoffered, unlisted, incapable and unindexed rungs", () => {
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
    // a writer keeps a low rung; a worker's floor is medium (plan 33)
    expect(candidates(c, p, "writer").map((x) => x.rung)).toEqual(["codex:gpt-6-sol#low", MED]);
    expect(candidates(c, p, "worker").map((x) => x.rung)).toEqual([MED]);
    expect(candidates(c, worker({}, ["claude-code:claude-opus-5-5#max"]), "artist")).toEqual([]);
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
    expect(decisionCandidates(c, p, "worker").map((x) => x.rung)).toEqual(
      candidates(c, p, "worker").map((x) => x.rung),
    );
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
});

describe("tieBreak (plan 44 D20)", () => {
  // Luna on Go is the same model at the same intelligence and price as Luna on Codex
  const level = [LUNA, GO_LUNA];

  it("takes the rung on the quota the run used least, and says why", () => {
    const t = tieBreak(level, { codex: 3, "opencode-go": 0 });
    expect(t.rung).toBe(GO_LUNA);
    expect(t.why).toBe(`${GO_LUNA} has the most headroom (dispatches in this run: codex 3, opencode-go 0)`);
    expect(tieBreak(level, { codex: 1, "opencode-go": 2 }).rung).toBe(LUNA);
  });

  it("breaks equal headroom on the order it was given", () => {
    expect(tieBreak([GO_LUNA, LUNA], {}).rung).toBe(GO_LUNA);
    expect(tieBreak(level, {}).rung).toBe(LUNA);
  });

  it("has nothing to say about a level of one rung", () => {
    expect(tieBreak([LUNA], { codex: 9 })).toEqual({ rung: LUNA, why: null });
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

describe("rolesWithoutRung", () => {
  const roles = (over: Record<string, { enabled: boolean; rungs: string[] }> = {}) => ({
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

  it("names why a role has no rung", () => {
    const c = cat();
    expect(
      noRungCause(c, roles({ worker: { enabled: true, rungs: ["codex:gpt-6-sol#low"] } }), "worker"),
    ).toBe("floor");
    expect(
      noRungCause(
        c,
        {
          ...roles({ worker: { enabled: true, rungs: [HIGH] } }),
          maxEffort: { "codex:gpt-6-sol": "medium" },
        },
        "worker",
      ),
    ).toBe("cap");
    const lost = shipped({ index: indexOf({ "gpt-6-luna#high": 30, "claude-opus-5-5#max": 60 }) });
    expect(noRungCause(lost, roles({ reviewer: { enabled: true, rungs: [HIGH] } }), "reviewer")).toBe(
      "index",
    );
  });

  it("counts a rung the index lost as no rung", () => {
    const lost = shipped({ index: indexOf({ "gpt-6-luna#high": 30, "claude-opus-5-5#max": 60 }) });
    expect(rolesWithoutRung(lost, roles({ reviewer: { enabled: true, rungs: [HIGH] } }))).toEqual([
      "reviewer",
    ]);
  });
});

describe("the effort ceiling and the coding floor (decision 22)", () => {
  // the pool is [30, 35, 36, 42, 46]
  const c = shipped({
    index: indexOf({
      "gpt-6-luna#high": 30,
      "gpt-6-sol#low": 35,
      "gpt-6-sol#medium": 36,
      "gpt-6-sol#high": 42,
      "gpt-6-sol#xhigh": 46,
    }),
  });
  const W = [
    "codex:gpt-6-sol#low",
    "codex:gpt-6-luna#high",
    "codex:gpt-6-sol#medium",
    "codex:gpt-6-sol#high",
    "codex:gpt-6-sol#xhigh",
  ];
  const rp = (o: Partial<RoutingProfile> = {}): RoutingProfile => ({
    billing: DEFAULT_BILLING,
    role: { enabled: true, rungs: W },
    ...o,
  });
  const rungs = (p: RoutingProfile, role: "worker" | "writer") => candidates(c, p, role).map((x) => x.rung);

  it("effortAllowed caps a model at its maxEffort and floors a coding worker at medium", () => {
    expect(effortAllowed({ "codex:gpt-6-sol": "high" }, "reviewer", "codex:gpt-6-sol#xhigh")).toBe(false);
    expect(effortAllowed({ "codex:gpt-6-sol": "high" }, "reviewer", "codex:gpt-6-sol#high")).toBe(true);
    expect(effortAllowed({ "codex:gpt-6-sol": "high" }, "reviewer", "codex:gpt-6-luna#xhigh")).toBe(true);
    expect(effortAllowed({ "codex:gpt-6-sol": "turbo" }, "reviewer", "codex:gpt-6-sol#ultra")).toBe(true);
    expect(effortAllowed({}, "worker", "codex:gpt-6-sol#low")).toBe(false);
    expect(effortAllowed({}, "worker", "codex:gpt-6-sol#minimal")).toBe(false);
    expect(effortAllowed({}, "worker", "codex:gpt-6-sol#medium")).toBe(true);
    expect(effortAllowed({}, "worker", "cursor:gemini-3.6-flash#default")).toBe(true);
    expect(effortAllowed({}, "writer", "codex:gpt-6-sol#low")).toBe(true);
    expect(effortAllowed({ "codex:gpt-6-sol": "high" }, "reviewer", "nonsense")).toBe(true);
  });

  it("a worker is never offered a rung below medium, a writer is", () => {
    expect(rungs(rp(), "worker")).not.toContain("codex:gpt-6-sol#low");
    expect(rungs(rp(), "writer")).toContain("codex:gpt-6-sol#low");
  });

  it("drops rungs above a model's maxEffort before any level", () => {
    expect(rungs(rp({ maxEffort: { "codex:gpt-6-sol": "high" } }), "worker")).not.toContain(
      "codex:gpt-6-sol#xhigh",
    );
    expect(rungs(rp({ maxEffort: { "codex:gpt-6-sol": "medium" } }), "worker")).toEqual([
      "codex:gpt-6-luna#high",
      "codex:gpt-6-sol#medium",
    ]);
  });

  it("rolesWithoutRung names a worker whose every rung is above maxEffort or below medium", () => {
    const v = {
      billing: DEFAULT_BILLING,
      maxEffort: { "codex:gpt-6-sol": "low" },
      roles: { worker: { enabled: true, rungs: ["codex:gpt-6-sol#low", "codex:gpt-6-sol#high"] } },
    };
    expect(rolesWithoutRung(c, v)).toEqual(["worker"]);
    expect(rolesWithoutRung(c, { ...v, maxEffort: {} })).toEqual([]);
  });
});
