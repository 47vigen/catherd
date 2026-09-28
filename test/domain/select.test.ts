import { describe, expect, it } from "bun:test";
import { DIFFICULTIES, type Difficulty, KINDS, type Kind } from "../../src/domain/lane.ts";
import {
  candidates,
  defaultDifficulty,
  defaultLadder,
  type RoutingProfile,
  select,
} from "../../src/domain/select.ts";
import { shipped } from "./shipped.ts";

const LADDER = [
  "codex:gpt-6-luna#high",
  "codex:gpt-6-sol#medium",
  "codex:gpt-6-sol#high",
  "codex:gpt-6-sol#xhigh",
];
const [LUNA_HIGH, SOL_MEDIUM, SOL_HIGH, SOL_XHIGH] = LADDER as [string, string, string, string];
/** Track A: Luna high (repo_code 66.6, carried from max) clears the 60.95 copy bar; Sol medium (56.6) does not */
const TRACK_A = { rung: LUNA_HIGH, ladder: [LUNA_HIGH, SOL_HIGH, SOL_XHIGH] };
/** the build bar is the median, 66.6: Luna high and Sol xhigh reach it */
const BUILD = { rung: LUNA_HIGH, ladder: [LUNA_HIGH, SOL_XHIGH] };
/** nothing clears: the default rung and every rung above it */
const TRACK_B = { rung: SOL_MEDIUM, ladder: LADDER.slice(1) };

/** Spec §7.2's default worker: the four Codex rungs, default sol#medium, the owner's billing. */
const worker = (over: Partial<RoutingProfile> = {}, rungs = LADDER): RoutingProfile => ({
  objective: "cost",
  billing: {},
  role: { enabled: true, rungs, defaultRung: "codex:gpt-6-sol#medium" },
  ...over,
});

/**
 * Spec 1.2 §5: the default worker on the shipped bars of 2026-09-28. Sol reaches no Track B bar (agentic
 * 0.0818 is below 0.08606, repo_code 66.6 below 67), so logic and hard lanes start at the default rung;
 * terminal copy needs Terminal-Bench 40.15, which Sol clears (43, carried from max) and Luna (13) does not;
 * ui build needs frontend 1617 and repo_code 66.6, which only Sol xhigh clears.
 */
const approved = (kind: Kind, d: Difficulty) => {
  if (d === "logic" || d === "hard" || kind === "terminal") return TRACK_B;
  if (kind === "ui" && d === "build") return { rung: SOL_XHIGH, ladder: [SOL_XHIGH] };
  return d === "copy" ? TRACK_A : BUILD;
};

describe("the approved ladder: default worker on the shipped catalog", () => {
  for (const kind of KINDS)
    for (const d of DIFFICULTIES)
      it(`${kind}/${d}`, () => {
        expect(select(shipped(), worker(), "worker", kind, d)).toEqual(approved(kind, d));
      });

  it("falls back to Track B from the default rung", () => {
    expect(defaultLadder(shipped(), worker(), "worker")).toEqual(TRACK_B);
  });

  it("holds with the rungs enabled in any order", () => {
    expect(select(shipped(), worker({}, [...LADDER].reverse()), "worker", "repo_code", "copy")).toEqual(
      TRACK_A,
    );
  });
});

describe("select", () => {
  it("runs a single-rung role on that rung, whatever the bar", () => {
    const p = worker({}, ["claude:claude-opus-5-5#high"]);
    expect(select(shipped(), p, "architect", "repo_code", "copy")).toEqual({
      rung: "claude:claude-opus-5-5#high",
      ladder: ["claude:claude-opus-5-5#high"],
    });
  });

  it("skips bad, unoffered, unlisted, incapable and unscored rungs, and refuses an empty role", () => {
    const listed = {
      codex: {
        fetchedAt: "2026-09-25T00:00:00.000Z",
        models: [
          {
            id: "gpt-6-sol",
            efforts: ["low", "medium", "high", "xhigh", "max"],
            context: 272000,
            imageIn: true,
          },
        ],
      },
    };
    const p = worker({}, [
      "nonsense",
      "codex:gpt-6-sol#ultra",
      "codex:gpt-6-luna#high",
      "codex:gpt-6-sol#low",
      "opencode:opencode-go/kimi-k3#default",
      "codex:gpt-6-sol#medium",
    ]);
    expect(candidates(shipped({ listed }), p, "worker").map((x) => x.rung)).toEqual([
      "codex:gpt-6-sol#low",
      "codex:gpt-6-sol#medium",
    ]);
    expect(() =>
      select(shipped(), worker({}, ["claude-code:claude-opus-5-5#high"]), "artist", "ui", "build"),
    ).toThrow(/role "artist" has no enabled, capable, scored rung/);
    expect(candidates(shipped(), { ...worker(), role: { enabled: false, rungs: LADDER } }, "worker")).toEqual(
      [],
    );
  });

  it("places a treat-like rung with the scores it borrows", () => {
    const c = shipped({
      override: {
        schema: 1,
        treatLike: { "opencode-go/kimi-k3#default": "gpt-6-sol#medium" },
        scores: [],
        bars: {},
      },
    });
    const p = worker({}, [...LADDER, "opencode:opencode-go/kimi-k3#default"]);
    expect(select(c, p, "worker", "repo_code", "logic").ladder).toEqual([
      "codex:gpt-6-sol#medium",
      "codex:gpt-6-sol#high",
      "codex:gpt-6-sol#xhigh",
      "opencode:opencode-go/kimi-k3#default",
    ]);
  });

  it("ranks subscription rungs before metered ones, then by cost", () => {
    const p = worker({}, [
      "opencode:opencode/gpt-6-luna#high",
      "codex:gpt-6-sol#xhigh",
      "opencode:opencode-go/gpt-6-luna#high",
    ]);
    expect(candidates(shipped(), p, "worker").map((x) => x.rung)).toEqual([
      "opencode:opencode-go/gpt-6-luna#high",
      "codex:gpt-6-sol#xhigh",
      "opencode:opencode/gpt-6-luna#high",
    ]);
  });
});

describe("objective speed", () => {
  it("orders by effort within a model until a rung has 5 own runs, then by its median seconds", () => {
    const speed = worker({ objective: "speed" });
    expect(candidates(shipped(), speed, "worker").map((x) => x.rung)).toEqual(LADDER);
    const secs = { "gpt-6-sol#medium|*": 264, "gpt-6-sol#high|*": 391 };
    expect(candidates(shipped({ secs }), speed, "worker").map((x) => x.rung)).toEqual([
      "codex:gpt-6-sol#medium",
      "codex:gpt-6-sol#high",
      "codex:gpt-6-luna#high",
      "codex:gpt-6-sol#xhigh",
    ]);
  });

  it("uses the kind's own timings before the all-kinds median", () => {
    const secs = { "gpt-6-sol#high|terminal": 100, "gpt-6-sol#high|*": 900, "gpt-6-sol#medium|*": 300 };
    const order = candidates(shipped({ secs }), worker({ objective: "speed" }), "worker", "terminal");
    expect(order.map((x) => x.rung).slice(0, 2)).toEqual(["codex:gpt-6-sol#high", "codex:gpt-6-sol#medium"]);
  });

  it("falls back from the default rung up the cost order, not onto a slower rung", () => {
    const secs = { "gpt-6-sol#medium|*": 100, "gpt-6-luna#high|*": 300 };
    expect(defaultLadder(shipped({ secs }), worker({ objective: "speed" }), "worker")).toEqual(TRACK_B);
  });

  it("starts fast but never climbs onto a weaker rung", () => {
    const secs = { "gpt-6-sol#high|repo_code": 200, "gpt-6-luna#high|repo_code": 500 };
    const d = select(shipped({ secs }), worker({ objective: "speed" }), "worker", "repo_code", "copy");
    // Sol high (65.3) starts; Luna high and Sol xhigh (66.6 each) are at least as strong, cheapest first
    expect(d).toEqual({ rung: SOL_HIGH, ladder: [SOL_HIGH, LUNA_HIGH, SOL_XHIGH] });
  });

  it("keeps the approved pin under cost whatever the timings", () => {
    const secs = { "gpt-6-sol#high|*": 1, "gpt-6-luna#high|*": 9999 };
    expect(select(shipped({ secs }), worker(), "worker", "repo_code", "copy")).toEqual(TRACK_A);
  });
});

describe("defaultDifficulty", () => {
  it("never falls to copy, the cheapest start, when the default rung clears no bar (M-3)", () => {
    const c = shipped();
    for (const d of DIFFICULTIES) c.bars.repo_code[d] = { repo_code: 1e9 };
    expect(defaultDifficulty(c, worker(), "worker", "repo_code")).toBe("build");
  });
});
