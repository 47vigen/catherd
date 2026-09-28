import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import { loadCatalog, overridePath, saveTreatLike } from "../../src/services/catalog-service.ts";
import { patchProfile } from "../../src/services/profile-service.ts";
import { validateNamed } from "../../src/services/profile-store.ts";
import {
  clearTreatLike,
  leftOnStandIns,
  resetTreatLikes,
  suggestFor,
} from "../../src/services/treat-likes.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const TERRA = "codex:gpt-5.6-terra#high";
const DEFAULT_WORKER = [
  "codex:gpt-6-luna#high",
  "codex:gpt-6-sol#medium",
  "codex:gpt-6-sol#high",
  "codex:gpt-6-sol#xhigh",
];

/** GPT-5.6 Terra, which no source scores on repo_code, terminal or honesty, on the default worker's ladder. */
async function terraOnTheLadder(): Promise<void> {
  withHome();
  patchProfile("default", { roles: { worker: { rungs: [...DEFAULT_WORKER, TERRA] } } });
  await saveTreatLike(TERRA, "gpt-6-sol#high");
}

describe("treat-like --suggest (spec 1.2 §6.4)", () => {
  it("names the three nearest stand-ins, with what they lend and the features they rest on", () => {
    withHome();
    const r = suggestFor(TERRA);
    expect(r.canonical).toBe("gpt-5.6-terra#high");
    expect(r.lacking).toEqual(["repo_code", "terminal", "honesty"]);
    expect(r.suggestions).toHaveLength(3);
    for (const s of r.suggestions) {
      expect(s.features.length).toBeGreaterThanOrEqual(3);
      expect(s.lends.length).toBeGreaterThan(0);
    }
  });
});

describe("treat-like --clear and --reset (spec 1.2 §6.4)", () => {
  it("removes the user's mapping, naming first the profile rungs it leaves on an inferred stand-in", async () => {
    await terraOnTheLadder();
    expect(leftOnStandIns(["gpt-5.6-terra#high"])).toEqual([
      { profile: "default", rung: TERRA, dims: ["repo_code", "terminal", "honesty"], unscored: false },
    ]);
    const r = await clearTreatLike(TERRA);
    expect(r).toEqual({
      rung: "gpt-5.6-terra#high",
      like: "gpt-6-sol#high",
      left: [
        { profile: "default", rung: TERRA, dims: ["repo_code", "terminal", "honesty"], unscored: false },
      ],
    });
    expect(JSON.parse(readFileSync(overridePath(), "utf8")).treatLike).toEqual({});
    expect(loadCatalog({ timings: false }).treatLike["gpt-5.6-terra#high"]).toBeUndefined();
  });

  it("refuses to clear a treat-like that is not the user's", async () => {
    withHome();
    const e = await clearTreatLike("opencode:opencode-go/kimi-k3#max").then(
      () => null,
      (x: unknown) => x,
    );
    expect(isCatherdError(e) && e.code).toBe("E_INPUT_INVALID");
    expect(isCatherdError(e) && e.message).toBe(
      "opencode-go/kimi-k3#max has no treat-like of yours to clear",
    );
    expect(loadCatalog({ timings: false }).treatLike["opencode-go/kimi-k3#max"]?.source).toBe("shipped");
  });

  it("removes every user mapping, keeping the override's scores and the shipped treat-likes", async () => {
    await terraOnTheLadder();
    await saveTreatLike("opencode:opencode-go/glm-5.3#high", "gpt-6-sol#medium");
    const cur = JSON.parse(readFileSync(overridePath(), "utf8"));
    const mine = {
      rung: "gpt-6-sol#high",
      dim: "steer",
      value: 0.2,
      benchmark: "mine",
      version: "1",
      url: "https://example.com/mine",
      date: "2026-09-27",
      confidence: "verified",
    };
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify({ ...cur, scores: [mine] }));
    const r = await resetTreatLikes();
    expect(r.removed).toEqual([
      ["gpt-5.6-terra#high", "gpt-6-sol#high"],
      ["opencode-go/glm-5.3#high", "gpt-6-sol#medium"],
    ]);
    expect(r.left).toEqual([
      { profile: "default", rung: TERRA, dims: ["repo_code", "terminal", "honesty"], unscored: false },
    ]);
    const after = JSON.parse(readFileSync(overridePath(), "utf8"));
    expect([after.treatLike, after.scores]).toEqual([{}, [mine]]);
    expect(loadCatalog({ timings: false }).treatLike["opencode-go/kimi-k3#max"]?.source).toBe("shipped");
  });

  it("leaves the profile valid, with warnings, when every user mapping is cleared (spec 1.2 §11)", async () => {
    await terraOnTheLadder();
    const mapped = validateNamed("default");
    expect(mapped.errors).toEqual([]);
    expect(mapped.warnings.some((w) => w.message.startsWith("stand-in to confirm"))).toBe(false);
    await resetTreatLikes();
    const v = validateNamed("default");
    expect(v.errors).toEqual([]);
    expect(
      v.warnings.some((w) =>
        w.message.startsWith(
          "stand-in to confirm: gpt-5.6-terra#high has no repo_code, terminal or honesty value",
        ),
      ),
    ).toBe(true);
  });

  it("names a rung the removal leaves with no value at all: routing skips it (spec 1.2 §6.4)", async () => {
    withHome();
    // a model no family knows: its only feature is its effort, too few for a stand-in
    const foo = "opencode:acme/foo-9#high";
    patchProfile("default", { roles: { worker: { rungs: [...DEFAULT_WORKER, foo] } } });
    await saveTreatLike(foo, "gpt-6-sol#high");
    const left = [{ profile: "default", rung: foo, dims: [], unscored: true }];
    expect(leftOnStandIns(["acme/foo-9#high"])).toEqual(left);
    expect((await clearTreatLike(foo)).left).toEqual(left);
    await saveTreatLike(foo, "gpt-6-sol#high");
    expect((await resetTreatLikes()).left).toEqual(left);
  });

  it("says there is nothing to remove", async () => {
    withHome();
    expect(await resetTreatLikes()).toEqual({ removed: [], left: [] });
  });
});
