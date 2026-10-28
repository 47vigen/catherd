import { describe, expect, it } from "bun:test";
import {
  BaseBranchSchema,
  landSubject,
  mrCommand,
  runBranch,
  planSetup,
  runSlug,
  unitMilestone,
} from "../../src/domain/branch.ts";

describe("branch names", () => {
  it("names a run's branch after its title, lower case (plan 50, spec D11)", () => {
    expect(runBranch("Wallet split")).toBe("wallet-split");
    expect(runBranch("!!!")).toBe("run");
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
  it("landSubject is a conventional subject of at most 100 characters (plan 50)", () => {
    expect(landSubject("Panel  Models Page")).toBe("chore: panel models page");
    expect(landSubject("x".repeat(200))).toHaveLength(100);
  });
  it("names a unit's milestone", () =>
    expect(["run", "M1", "M1.L2"].map(unitMilestone)).toEqual([null, "M1", "M1"]));
  it("names the MR command for the origin's host", () => {
    expect(
      mrCommand({ originUrl: "git@github.com:o/r.git", base: "main", branch: "t-m1", body: "/d.md" }),
    ).toBe("gh pr create --base main --head t-m1 --body-file /d.md");
    expect(
      mrCommand({ originUrl: "git@git.example.com:o/r.git", base: "main", branch: "t-m1", body: "/d.md" }),
    ).toBe('glab mr create --source-branch t-m1 --target-branch main --description "$(cat /d.md)"');
  });
});
