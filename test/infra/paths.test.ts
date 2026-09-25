import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { configDir, dataDir, repoKey, runsDir } from "../../src/infra/paths.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

describe("paths", () => {
  it("roots config and data under CATHERD_HOME", () => {
    const home = withHome();
    expect(configDir()).toBe(join(home, "config"));
    expect(dataDir()).toBe(join(home, "data"));
  });

  it("keys a repo by a readable slug plus a hash, so similar paths never collide", () => {
    expect(repoKey("/a-b/c")).not.toBe(repoKey("/a/b-c"));
    expect(repoKey("/Users/me/lab/catherd")).toMatch(/^Users-me-lab-catherd-[0-9a-f]{8}$/);
    withHome();
    expect(runsDir("/x/y")).toBe(join(dataDir(), "repos", repoKey("/x/y"), "runs"));
  });
});
