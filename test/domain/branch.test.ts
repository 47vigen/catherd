import { describe, expect, it } from "bun:test";
import {
  BaseBranchSchema,
  isPushAnswer,
  milestoneBranch,
  mergeSubject,
  mrCommand,
  planSetup,
  runSlug,
  unitMilestone,
} from "../../src/domain/branch.ts";

describe("branch names", () => {
  it("names a milestone's branch after the run title, lower case", () => {
    expect(milestoneBranch("Wallet split", "M1")).toBe("wallet-split-m1");
    expect(milestoneBranch("!!!", "M2")).toBe("run-m2");
    expect(runSlug("x".repeat(60))).toHaveLength(40);
  });
  it("takes a base branch name, never a remote ref or a range", () => {
    expect(BaseBranchSchema.safeParse("staging").success).toBe(true);
    for (const bad of ["origin/main", "refs/heads/main", "main..x", "--upload-pack=x", "a b"])
      expect(BaseBranchSchema.safeParse(bad).success).toBe(false);
  });
  it("reads Setup: from plan.md's header block only", () => {
    expect(planSetup("# Plan\nSetup: `pnpm install`\n\n## M1\nSetup: no")).toBe("pnpm install");
    expect(planSetup("# Plan\n\nSetup: body prose")).toBeNull();
  });
  it("mergeSubject is a conventional subject of at most 100 characters", () => {
    expect(mergeSubject("20261024-225710-plans-41-42-cheap-tier", "M33", "Panel Models Page")).toBe(
      "chore: merge plans-41-42-cheap-tier m33 panel models page",
    );
    const long = mergeSubject("20261024-225710-plans-41-42-cheap-tier", "M33", "x".repeat(200));
    expect(long).toHaveLength(100);
    expect(long.startsWith("chore: merge ")).toBe(true);
  });
  it("names a unit's milestone", () =>
    expect(["run", "M1", "M1.L2"].map(unitMilestone)).toEqual([null, "M1", "M1"]));
  it("reads a push answer, and names the MR command for the origin's host", () => {
    expect(["push", " Push "].every(isPushAnswer)).toBe(true);
    expect(["pushed", "push it", "merged"].some(isPushAnswer)).toBe(false);
    expect(
      mrCommand({ originUrl: "git@github.com:o/r.git", base: "main", branch: "t-m1", body: "/d.md" }),
    ).toBe("gh pr create --base main --head t-m1 --body-file /d.md");
    expect(
      mrCommand({ originUrl: "git@git.example.com:o/r.git", base: "main", branch: "t-m1", body: "/d.md" }),
    ).toBe("glab mr create --source-branch t-m1 --target-branch main --description-file /d.md");
  });
});
