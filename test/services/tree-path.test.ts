import { describe, expect, it } from "bun:test";
import { composeProjectOf } from "../../src/services/tree-path.ts";
import type { Run } from "../../src/services/run-store.ts";

const run = (base: string | null) => ({ id: "20261024-225710-x", meta: { base } }) as unknown as Run;

describe("composeProjectOf", () => {
  it("a base run's milestone has its own compose project", () => {
    expect(composeProjectOf(run("main"), "M20")).toBe("catherd-20261024225710-m20");
    expect(composeProjectOf(run("main"), "M20", true)).toBe("catherd-20261024225710-m20-base");
    expect(composeProjectOf(run(null), "M20")).toBeNull();
    expect(composeProjectOf(run("main"), null)).toBeNull();
  });
});
