import { afterEach, describe, expect, it } from "bun:test";
import { configDir, dataDir } from "../src/infra/paths.ts";
import { snapshotEnv, withHome } from "./helpers.ts";

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
