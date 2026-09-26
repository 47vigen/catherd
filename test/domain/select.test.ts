import { describe, expect, it } from "bun:test";
import { DIFFICULTIES, type Difficulty, KINDS, type Kind } from "../../src/domain/lane.ts";
import { candidates, defaultLadder, type RoutingProfile, select } from "../../src/domain/select.ts";
import { shipped } from "./shipped.ts";

const LADDER = [
  "codex:gpt-6-luna#high",
  "codex:gpt-6-sol#medium",
  "codex:gpt-6-sol#high",
  "codex:gpt-6-sol#xhigh",
];
const TRACK_A = { rung: LADDER[0] as string, ladder: LADDER };
const TRACK_B = { rung: LADDER[1] as string, ladder: LADDER.slice(1) };

/** Spec §7.2's default worker: the four Codex rungs, default sol#medium, the owner's billing. */
const worker = (over: Partial<RoutingProfile> = {}, rungs = LADDER): RoutingProfile => ({
  objective: "cost",
  billing: {},
  role: { enabled: true, rungs, defaultRung: "codex:gpt-6-sol#medium" },
  ...over,
});

/** Spec §5.2: the approved ladder, re-derived on the 2026-09-25 benchmarks. */
const approved = (kind: Kind, d: Difficulty) =>
  kind !== "terminal" && (d === "copy" || d === "build") ? TRACK_A : TRACK_B;

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
    expect(select(shipped(), worker({}, [...LADDER].reverse()), "worker", "repo_code", "build")).toEqual(
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

  it("starts fast but never climbs onto a weaker rung", () => {
    const secs = { "gpt-6-sol#medium|repo_code": 200, "gpt-6-luna#high|repo_code": 500 };
    const d = select(shipped({ secs }), worker({ objective: "speed" }), "worker", "repo_code", "copy");
    expect(d).toEqual({
      rung: "codex:gpt-6-sol#medium",
      ladder: [
        "codex:gpt-6-sol#medium",
        "codex:gpt-6-luna#high",
        "codex:gpt-6-sol#high",
        "codex:gpt-6-sol#xhigh",
      ],
    });
  });

  it("keeps the approved pin under cost whatever the timings", () => {
    const secs = { "gpt-6-sol#medium|*": 1, "gpt-6-luna#high|*": 9999 };
    expect(select(shipped({ secs }), worker(), "worker", "repo_code", "copy")).toEqual(TRACK_A);
  });
});
