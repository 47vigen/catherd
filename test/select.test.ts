import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultProfile, patchProfile } from "../src/profile/profile.ts";
import { entryFor, loadCatalog } from "../src/routing/catalog.ts";
import { candidates, clearsBar, defaultLadder, select } from "../src/routing/select.ts";
import { DIFFICULTIES, type Difficulty, KINDS, type Kind, type ScoreDim } from "../src/types.ts";
import { withHome } from "./helpers.ts";

const TRACK_A = {
  rung: "gpt-6-luna#high",
  ladder: ["gpt-6-luna#high", "gpt-6-sol#medium", "gpt-6-sol#high", "gpt-6-sol#xhigh"],
};
const TRACK_B = {
  rung: "gpt-6-sol#medium",
  ladder: ["gpt-6-sol#medium", "gpt-6-sol#high", "gpt-6-sol#xhigh"],
};

/** Spec §6.3, approved 2026-09-24. prose and research copy/build follow repo_code onto Track A. */
const approved = (kind: Kind, d: Difficulty) =>
  kind !== "terminal" && (d === "copy" || d === "build") ? TRACK_A : TRACK_B;

const saved = { ...process.env };
beforeEach(() => withHome());
afterEach(() => {
  process.env = { ...saved };
});

describe("the approved ladder: default profile, worker", () => {
  for (const kind of KINDS) {
    for (const d of DIFFICULTIES) {
      test(`${kind}/${d}`, () => {
        expect(select(defaultProfile(), loadCatalog(), "worker", kind, d)).toEqual(approved(kind, d));
      });
    }
  }

  test("falls back to the profile's default rung", () => {
    expect(defaultLadder(defaultProfile(), loadCatalog(), "worker")).toEqual(TRACK_B);
  });
});

describe("select", () => {
  test("runs a role with a single entry on that entry, whatever the bar", () => {
    const c = loadCatalog();
    expect(select(defaultProfile(), c, "architect", "repo_code", "copy")).toEqual({
      rung: "claude-opus-5-5#high",
      ladder: ["claude-opus-5-5#high"],
    });
    expect(clearsBar(c, "claude-opus-5-5#high", "repo_code", "copy")).toBe(false);
  });

  test("orders by speed when the objective is speed", () => {
    const p = patchProfile(defaultProfile(), { objective: "speed" });
    expect(candidates(p, loadCatalog(), "worker")).toEqual([
      "gpt-6-sol#medium",
      "gpt-6-sol#high",
      "gpt-6-sol#xhigh",
      "gpt-6-luna#high",
    ]);
  });

  test("puts an entry without secs_per_task last on speed, and by costRank on cost", () => {
    const models = { "gpt-6-sol": ["medium"], "claude-opus-5-5": ["low"], "gpt-6-luna": ["high"] };
    const speed = patchProfile(defaultProfile(), { objective: "speed", roles: { worker: { models } } });
    expect(candidates(speed, loadCatalog(), "worker")).toEqual([
      "gpt-6-sol#medium",
      "gpt-6-luna#high",
      "claude-opus-5-5#low",
    ]);
    const cost = patchProfile(defaultProfile(), { roles: { worker: { models } } });
    expect(candidates(cost, loadCatalog(), "worker")).toEqual([
      "gpt-6-luna#high",
      "gpt-6-sol#medium",
      "claude-opus-5-5#low",
    ]);
  });

  test("skips models the catalog lacks, models that cannot fill the role, and unscored efforts", () => {
    const c = loadCatalog();
    const p = patchProfile(defaultProfile(), {
      roles: {
        worker: {
          models: {
            "gone-model": ["high"],
            "gpt-6-sol": ["medium", "max"],
            "gpt-6-luna": ["high", "medium"],
          },
        },
        artist: { models: { "claude-opus-5-5": ["low"] } },
      },
    });
    expect(candidates(p, c, "worker")).toEqual(["gpt-6-luna#high", "gpt-6-sol#medium"]);
    expect(candidates(p, c, "artist")).toEqual([]);
    expect(() => select(p, c, "artist", "ui", "build")).toThrow(
      /role "artist" has no enabled, capable, scored model/,
    );
  });

  test("gives a disabled role no candidates", () => {
    const p = patchProfile(defaultProfile(), { roles: { writer: { enabled: false } } });
    expect(candidates(p, loadCatalog(), "writer")).toEqual([]);
  });

  test("falls back to the default ladder when nothing clears the bar", () => {
    const c = loadCatalog();
    c.bars.repo_code.copy = { repo_code: 99 };
    expect(select(defaultProfile(), c, "worker", "repo_code", "copy")).toEqual(TRACK_B);
  });

  test("places a treat-like rung with the scores it borrows", () => {
    const c = loadCatalog();
    c.models.push({
      id: "openrouter/acme/coder-1",
      backend: "opencode",
      efforts: ["default"],
      capabilities: { toolCall: true, imageIn: false, imageOut: false, reasoning: true, context: 262144 },
    });
    c.treatLike["openrouter/acme/coder-1#default"] = "gpt-6-sol#medium";
    const p = patchProfile(defaultProfile(), {
      roles: {
        worker: {
          models: {
            "gpt-6-luna": ["high"],
            "gpt-6-sol": ["medium", "high", "xhigh"],
            "openrouter/acme/coder-1": ["default"],
          },
        },
      },
    });
    expect(select(p, c, "worker", "terminal", "logic").ladder).toEqual([
      "gpt-6-sol#medium",
      "openrouter/acme/coder-1#default",
      "gpt-6-sol#high",
      "gpt-6-sol#xhigh",
    ]);
  });

  test("starts the default ladder at the first candidate when defaultRung is unset", () => {
    const p = patchProfile(defaultProfile(), {
      roles: { reviewer: { models: { "gpt-6-sol": ["high", "medium"] } } },
    });
    expect(defaultLadder(p, loadCatalog(), "reviewer")).toEqual({
      rung: "gpt-6-sol#medium",
      ladder: ["gpt-6-sol#medium", "gpt-6-sol#high"],
    });
  });
});

/**
 * OVERRIDES cross-plan fix 2: under objective "speed" the start rung is still the fastest
 * bar-clearing candidate, but the climb ladder above it only ever gets stronger on the kind's
 * primary dimension (terminal for terminal work, repo_code otherwise); it must never climb onto
 * a rung that scores lower than the one below it.
 */
describe("climbing under objective speed never gets weaker", () => {
  test("repo_code/copy starts fast (sol#medium) but climbs by strength, dipping back up through luna", () => {
    const p = patchProfile(defaultProfile(), { objective: "speed" });
    const c = loadCatalog();
    const d = select(p, c, "worker", "repo_code", "copy");
    expect(d).toEqual({
      rung: "gpt-6-sol#medium",
      ladder: ["gpt-6-sol#medium", "gpt-6-luna#high", "gpt-6-sol#high", "gpt-6-sol#xhigh"],
    });
  });

  test("every kind/difficulty ladder is non-decreasing on its primary dimension, under speed", () => {
    const p = patchProfile(defaultProfile(), { objective: "speed" });
    const c = loadCatalog();
    for (const kind of KINDS) {
      for (const d of DIFFICULTIES) {
        const { ladder } = select(p, c, "worker", kind, d);
        const dim: ScoreDim = kind === "terminal" ? "terminal" : "repo_code";
        const strengths = ladder.map((r) => entryFor(c, r)?.scores[dim] ?? Number.NEGATIVE_INFINITY);
        for (let i = 1; i < strengths.length; i++) {
          expect(strengths[i] as number).toBeGreaterThanOrEqual(strengths[i - 1] as number);
        }
      }
    }
  });

  test("the cost ladder is unaffected: it keeps the approved pin, dips included", () => {
    const d = select(defaultProfile(), loadCatalog(), "worker", "repo_code", "copy");
    expect(d).toEqual(TRACK_A);
  });
});
