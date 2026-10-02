import { describe, expect, it } from "bun:test";
import type { Dim } from "../../src/domain/catalog.ts";
import { ladderDropDims } from "../../src/domain/failover.ts";
import { DIFFICULTIES, type Difficulty, KINDS, type Kind } from "../../src/domain/lane.ts";
import {
  candidates,
  defaultDifficulty,
  defaultLadder,
  quotaUsage,
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
/**
 * Track A: Luna high (repo_code 66.6, carried from max) clears the 60.95 copy bar; Sol medium (56.6) does not.
 * Spec 1.5 plan 24: the ladder only goes up, so Sol high (65.3) is off it; Sol xhigh (66.6) stays.
 */
const TRACK_A = { rung: LUNA_HIGH, ladder: [LUNA_HIGH, SOL_XHIGH] };
/** the build bar is the median, 66.6: Luna high and Sol xhigh reach it */
const BUILD = { rung: LUNA_HIGH, ladder: [LUNA_HIGH, SOL_XHIGH] };
/** nothing clears: the default rung and every rung at least as strong on the bar */
const TRACK_B = { rung: SOL_MEDIUM, ladder: LADDER.slice(1) };
const noClear = (kind: Kind, d: Difficulty) =>
  expect.stringMatching(new RegExp(`^no rung clears ${kind}/${d}; best is `));

/** Spec §7.2's default worker: the four Codex rungs, default sol#medium, the owner's billing. */
const worker = (over: Partial<RoutingProfile> = {}, rungs = LADDER): RoutingProfile => ({
  objective: "cost",
  billing: {},
  role: { enabled: true, rungs, defaultRung: "codex:gpt-6-sol#medium" },
  ...over,
});

/**
 * Spec 1.2 §5: the default worker on the shipped bars of 2026-09-28. Sol reaches no Track B bar (agentic
 * 0.0818 is below 0.08606, repo_code 66.6 below 67), so logic and hard lanes start at the default rung, and
 * `noClear` says so (spec 1.5 plan 24); terminal copy needs Terminal-Bench 40.15, which Sol clears (43,
 * carried from max) and Luna (13) does not, and nothing reaches terminal build's 55.8; ui build needs frontend
 * 1617 and repo_code 66.6, which only Sol xhigh clears, so ui logic and hard start there too: no lower than
 * build, since Sol xhigh scores at least the default rung on their bars.
 */
const approved = (kind: Kind, d: Difficulty) => {
  if (kind === "terminal") return d === "copy" ? TRACK_B : { ...TRACK_B, noClear: noClear(kind, d) };
  if (kind === "ui" && d !== "copy") {
    const xhigh = { rung: SOL_XHIGH, ladder: [SOL_XHIGH] };
    return d === "build" ? xhigh : { ...xhigh, noClear: noClear(kind, d) };
  }
  if (d === "logic" || d === "hard") return { ...TRACK_B, noClear: noClear(kind, d) };
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

  it("places a treat-like rung with the scores it borrows; unpriced on Go, it costs 0 and starts first", () => {
    const c = shipped({
      override: {
        schema: 1,
        treatLike: { "opencode-go/kimi-k3#default": "gpt-6-sol#medium" },
        scores: [],
        bars: {},
      },
    });
    const kimi = "opencode:opencode-go/kimi-k3#default";
    const p = worker({}, [...LADDER, kimi]);
    expect(candidates(c, p, "worker")[0]?.rung).toBe(kimi);
    // terminal copy: Sol's borrowed Terminal-Bench 43 clears 40.15, and the unpriced Go rung is the cheapest
    expect(select(c, p, "worker", "terminal", "copy")).toEqual({
      rung: kimi,
      ladder: [kimi, SOL_MEDIUM, SOL_HIGH, SOL_XHIGH],
      tie: expect.stringMatching(/^tie on terminal with codex:gpt-6-sol#medium, /),
    });
  });

  it("breaks a cost tie on the profile's ladder order (spec 1.5 plan 24)", () => {
    const c = shipped({
      override: {
        schema: 1,
        treatLike: {
          "opencode-go/kimi-k3#default": "gpt-6-sol#medium",
          "opencode-go/glm-5#default": "gpt-6-sol#medium",
        },
        scores: [],
        bars: {},
      },
    });
    const kimi = "opencode:opencode-go/kimi-k3#default";
    const glm = "opencode:opencode-go/glm-5#default";
    const first = (rungs: string[]) => candidates(c, worker({}, rungs), "worker").map((x) => x.rung);
    expect(first([glm, kimi, SOL_MEDIUM])).toEqual([glm, kimi, SOL_MEDIUM]);
    expect(first([kimi, glm, SOL_MEDIUM])).toEqual([kimi, glm, SOL_MEDIUM]);
    expect(first([kimi, glm, SOL_MEDIUM]).slice(0, 2)).toEqual(
      candidates(c, worker({ objective: "speed" }, [kimi, glm, SOL_MEDIUM]), "worker")
        .map((x) => x.rung)
        .slice(0, 2),
    );
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

  it("sorts a ui speed ladder on frontend, the dimension ui gates on", () => {
    const secs = { "gpt-6-sol#xhigh|ui": 50 };
    const d = select(shipped({ secs }), worker({ objective: "speed" }), "worker", "ui", "build");
    expect(d.rung).toBe(SOL_XHIGH);
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

describe("climb ladders only go up (spec 1.5 plan 24)", () => {
  /** the identity run's M1.L2: a Sol start with two weaker Go rungs above it in cost order */
  const goWeak = () =>
    shipped({
      override: {
        schema: 1,
        treatLike: {
          "opencode-go/deepseek-v4.1-flash#default": "gpt-6-luna#medium",
          "opencode-go/glm-5.3-flash#default": "gpt-6-luna#low",
        },
        scores: [],
        bars: {},
      },
    });
  const DEEPSEEK = "opencode:opencode-go/deepseek-v4.1-flash#default";
  const GLM = "opencode:opencode-go/glm-5.3-flash#default";

  it("keeps a weaker rung off the ladder when nothing clears the bar, and says which rung comes closest", () => {
    const p = worker({ billing: { "opencode-go": "metered" } }, [SOL_MEDIUM, DEEPSEEK, GLM]);
    const pick = select(goWeak(), p, "worker", "repo_code", "hard");
    expect(pick.rung).toBe(SOL_MEDIUM);
    expect(pick.ladder).toEqual([SOL_MEDIUM]);
    expect(pick.noClear).toBe(
      "no rung clears repo_code/hard; best is codex:gpt-6-sol#medium (repo_code 56.6 < 70.9, agentic 0.0818 < 0.1077)",
    );
  });

  it("puts a stronger rung on the ladder even when cost orders it below the start", () => {
    const c = shipped();
    // Opus low (74.2, every dimension above Sonnet medium's) costs less than Sonnet medium on the Claude plan
    const p = worker({}, ["claude-code:claude-sonnet-5#medium", "claude-code:claude-opus-5-5#low"]);
    p.role.defaultRung = "claude-code:claude-sonnet-5#medium";
    expect(defaultLadder(c, p, "worker")).toEqual({
      rung: "claude-code:claude-sonnet-5#medium",
      ladder: ["claude-code:claude-sonnet-5#medium", "claude-code:claude-opus-5-5#low"],
    });
  });

  it("never steps down between two rungs above the start, on a mixed Codex and Claude ladder", () => {
    // final review Important 1: each rung was checked only against the start, so Sol xhigh (cheapest by cost
    // after the Claude plan's Opus) followed Opus medium, scoring below it on every dimension
    const c = shipped();
    const rungs = [
      ...LADDER,
      "claude-code:claude-opus-5-5#low",
      "claude-code:claude-opus-5-5#medium",
      "claude-code:claude-sonnet-5-5#high",
      "codex:gpt-6-luna#xhigh",
      "codex:gpt-6-luna#max",
    ];
    const p = worker({}, rungs);
    const scores = new Map(candidates(c, p, "worker").map((x) => [x.rung, x.scores]));
    for (const kind of KINDS)
      for (const d of DIFFICULTIES) {
        const { ladder } = select(c, p, "worker", kind, d);
        const dims = Object.keys(c.bars[kind][d]) as Dim[];
        for (const [i, upper] of ladder.slice(1).entries()) {
          const lower = ladder[i] as string;
          expect({ kind, d, lower, upper, down: ladderDropDims(c, lower, upper) }).toEqual({
            kind,
            d,
            lower,
            upper,
            down: [],
          });
          const below = dims.filter(
            (dim) => (scores.get(upper)?.[dim] ?? -Infinity) < (scores.get(lower)?.[dim] ?? -Infinity),
          );
          expect({ kind, d, lower, upper, below }).toEqual({ kind, d, lower, upper, below: [] });
        }
      }
    // the shape of the repro: Sol xhigh is no longer above Opus medium on repo_code copy
    expect(select(c, p, "worker", "repo_code", "copy").ladder.slice(-2)).toEqual([
      "claude-code:claude-opus-5-5#low",
      "claude-code:claude-opus-5-5#medium",
    ]);
  });

  it("starts a lane no lower than an easier difficulty's start that scores at least the default on its bar", () => {
    const c = shipped();
    for (const d of DIFFICULTIES) c.bars.repo_code[d] = { repo_code: d === "copy" ? 60 : 1e9 };
    // build, logic and hard clear nothing; copy's start (Luna high, 66.6) beats the default (Sol medium, 56.6)
    // on the only dimension those bars have, so they start at Luna high, not the default rung
    const pick = select(c, worker(), "worker", "repo_code", "logic");
    expect(pick.rung).toBe(LUNA_HIGH);
    expect(pick.ladder).toEqual([LUNA_HIGH, SOL_XHIGH]);
  });
});

describe("equal scores go to the quota with more headroom (spec 1.5 plan 24)", () => {
  // the identity run: DeepSeek on OpenCode Go is treated like Luna high, so the two tie on every dimension
  const c = () =>
    shipped({
      override: {
        schema: 1,
        treatLike: { "opencode-go/deepseek-v4.1-flash#default": "gpt-6-luna#high" },
        scores: [],
        bars: {},
      },
    });
  const DEEPSEEK = "opencode:opencode-go/deepseek-v4.1-flash#default";
  const rungs = [LUNA_HIGH, DEEPSEEK, SOL_MEDIUM, SOL_HIGH, SOL_XHIGH];

  it("starts on the less used quota and says the tie decided", () => {
    const p = worker({ usage: { codex: 3, "opencode-go": 0 } }, rungs);
    const pick = select(c(), p, "worker", "repo_code", "copy");
    expect(pick.rung).toBe(DEEPSEEK);
    expect(pick.ladder).toEqual([DEEPSEEK, LUNA_HIGH, SOL_XHIGH]);
    expect(pick.tie).toBe(
      `tie on repo_code with ${LUNA_HIGH}, ${SOL_XHIGH}: started on ${DEEPSEEK}; opencode-go has the most headroom (dispatches in this run: opencode-go 0, codex 3)`,
    );
    const back = select(
      c(),
      worker({ usage: { codex: 1, "opencode-go": 2 } }, rungs),
      "worker",
      "repo_code",
      "copy",
    );
    expect(back.rung).toBe(LUNA_HIGH);
  });

  it("breaks a tie with equal headroom on the profile's ladder order, and says so", () => {
    const first = select(c(), worker({}, [DEEPSEEK, LUNA_HIGH, SOL_XHIGH]), "worker", "repo_code", "build");
    expect(first.rung).toBe(DEEPSEEK);
    expect(first.tie).toMatch(
      /equal headroom \(0 dispatches each\); the profile's ladder order and cost decided$/,
    );
    // the unpriced Go rung costs 0, so cost puts it first whatever the written order
    expect(
      select(c(), worker({}, [LUNA_HIGH, DEEPSEEK, SOL_XHIGH]), "worker", "repo_code", "build").rung,
    ).toBe(DEEPSEEK);
  });

  it("never gives a tie to a metered rung over one paid from a plan", () => {
    const p = worker({ billing: { "opencode-go": "metered" }, usage: { codex: 9 } }, rungs);
    const pick = select(c(), p, "worker", "repo_code", "copy");
    expect(pick.rung).toBe(LUNA_HIGH);
    expect(pick.tie).toBeUndefined();
  });

  it("leaves a start with no equal alone", () => {
    expect(select(shipped(), worker(), "worker", "repo_code", "copy").tie).toBeUndefined();
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

describe("the just-claude ladders (spec 1.5 plan 24, the payment run)", () => {
  // Sonnet 5.5 with no published value: the payment run's Claude rungs scored only by Sol's values
  const score = (effort: string, dim: "repo_code" | "honesty" | "agentic", value: number) => ({
    rung: `claude-sonnet-5-5#${effort}`,
    dim,
    value,
    benchmark: "b",
    version: "1",
    url: "https://example.com/b",
    date: "2026-09-28",
    confidence: "inferred" as const,
  });
  const values: [string, number][] = [
    ["low", 50],
    ["medium", 56.6],
    ["high", 66.6],
    ["xhigh", 68.8],
  ];
  const c = () =>
    shipped({
      override: {
        schema: 1,
        treatLike: {},
        scores: values.flatMap(([e, repo]) => [
          score(e, "repo_code", repo),
          score(e, "honesty", 95.1),
          score(e, "agentic", 0.0818),
        ]),
        bars: {},
      },
    });
  const rung = (e: string) => `claude-code:claude-sonnet-5-5#${e}`;
  const rungs = values.map(([e]) => rung(e));
  const p = (): RoutingProfile => ({
    objective: "cost",
    billing: {},
    role: { enabled: true, rungs, defaultRung: rung("medium") },
  });

  it("gives a build lane, the difficulty a sure kind defaults to, every stronger rung to climb onto", () => {
    // jev-kind with no Difficulty line: the default rung clears no bar, so the lane routes as build
    expect(defaultDifficulty(c(), p(), "worker", "repo_code")).toBe("build");
    expect(select(c(), p(), "worker", "repo_code", "build")).toEqual({
      rung: rung("high"),
      ladder: [rung("high"), rung("xhigh")],
    });
  });

  it("starts a logic lane no lower than build's start, not at the default rung below it", () => {
    const pick = select(c(), p(), "worker", "repo_code", "logic");
    expect(pick.rung).toBe(rung("high"));
    expect(pick.ladder).toEqual([rung("high"), rung("xhigh")]);
    expect(pick.noClear).toMatch(/^no rung clears repo_code\/logic; best is /);
  });
});
