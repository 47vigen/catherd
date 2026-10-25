import { afterEach, describe, expect, it } from "bun:test";
import { configDir, dataDir } from "../src/infra/paths.ts";
import { snapshotEnv, spawnEnv, withHome } from "./helpers.ts";

afterEach(snapshotEnv());

describe("withHome", () => {
  // an isolated worker inherits CATHERD_DATA_DIR/CATHERD_CONFIG_DIR (movedHomeEnv), and they win over CATHERD_HOME
  it("keeps a test's data and config under its temp home, whatever dirs the parent process named", () => {
    process.env.CATHERD_DATA_DIR = "/nonexistent/real-data";
    process.env.CATHERD_CONFIG_DIR = "/nonexistent/real-config";
    const home = withHome();
    expect(dataDir().startsWith(home)).toBe(true);
    expect(configDir().startsWith(home)).toBe(true);
  });
});

describe("spawnEnv", () => {
  it("keeps the end push, the sync and the Anthropic key off over any env", () => {
    expect(
      spawnEnv({
        PATH: "/bin",
        CATHERD_NO_END_PUSH: "0",
        CATHERD_NO_SYNC: "0",
        ANTHROPIC_API_KEY: "sk-test",
      }),
    ).toEqual({
      PATH: "/bin",
      CATHERD_NO_END_PUSH: "1",
      CATHERD_NO_SYNC: "1",
      ANTHROPIC_API_KEY: "",
    });
  });
});

describe("the test preload", () => {
  it("a suite started in a role's shell runs as no role", () => {
    const p = Bun.spawnSync(["bun", "test", "test/fixtures/role-probe.test.ts"], {
      env: {
        ...(process.env as Record<string, string>),
        CATHERD_ROLE: "r/worker-M1.L1",
        CATHERD_DISPATCH_ID: "d1",
        ANTHROPIC_API_KEY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect([p.exitCode, p.stderr.toString()]).toEqual([0, expect.stringContaining("1 pass")]);
  });
});
