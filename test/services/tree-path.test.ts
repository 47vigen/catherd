import { describe, expect, it } from "bun:test";
import { composeProjectOf } from "../../src/services/tree-path.ts";
import type { Run } from "../../src/services/run-store.ts";

const run = (base: string | null) => ({ id: "20261024-225710-x", meta: { base } }) as unknown as Run;

describe("composeProjectOf", () => {
  it("a base run's tree has its own compose project (plan 50: one tree per run)", () => {
    expect(composeProjectOf(run("main"))).toBe("catherd-20261024225710");
    expect(composeProjectOf(run("main"), true)).toBe("catherd-20261024225710-base");
    expect(composeProjectOf(run(null))).toBeNull();
  });
});
