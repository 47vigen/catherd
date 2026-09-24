import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { configDir, dataDir, repoSlug, runsRoot } from "../src/paths.ts";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("paths", () => {
  test("uses CATHERD_HOME for both roots when set", () => {
    process.env.CATHERD_HOME = "/tmp/ch";
    expect(configDir()).toBe("/tmp/ch/config");
    expect(dataDir()).toBe("/tmp/ch/data");
  });

  test("uses XDG_CONFIG_HOME and XDG_DATA_HOME when CATHERD_HOME is unset", () => {
    delete process.env.CATHERD_HOME;
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
    process.env.XDG_DATA_HOME = "/tmp/xdg-data";
    expect(configDir()).toBe("/tmp/xdg-config/catherd");
    expect(dataDir()).toBe("/tmp/xdg-data/catherd");
  });

  test("falls back to ~/.config and ~/.local/share", () => {
    delete process.env.CATHERD_HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    expect(configDir()).toBe(join(homedir(), ".config", "catherd"));
    expect(dataDir()).toBe(join(homedir(), ".local", "share", "catherd"));
  });

  test("slugs a repo root without a leading dash", () => {
    expect(repoSlug("/Users/a/lab/catherd")).toBe("Users-a-lab-catherd");
  });

  test("puts runs under the data root by repo slug", () => {
    process.env.CATHERD_HOME = "/tmp/ch";
    expect(runsRoot("/r/x")).toBe("/tmp/ch/data/r-x");
  });
});
