import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configDir } from "../src/paths.ts";
import {
  activeProfileName,
  defaultProfile,
  listProfiles,
  loadProfile,
  patchProfile,
  saveProfile,
  setActiveProfile,
} from "../src/profile/profile.ts";
import { withHome } from "./helpers.ts";

const saved = { ...process.env };
beforeEach(() => withHome());
afterEach(() => {
  process.env = { ...saved };
});

function writeProfileFile(name: string, body: unknown): void {
  mkdirSync(join(configDir(), "profiles"), { recursive: true });
  writeFileSync(join(configDir(), "profiles", `${name}.json`), JSON.stringify(body));
}

describe("profiles", () => {
  test("matches spec §8.2, with both harnesses native", () => {
    const p = defaultProfile();
    expect(p.name).toBe("default");
    expect(p.objective).toBe("cost");
    expect(p.roles.worker).toEqual({
      enabled: true,
      defaultRung: "gpt-6-sol#medium",
      models: { "gpt-6-luna": ["high"], "gpt-6-sol": ["medium", "high", "xhigh"] },
    });
    expect(p.roles.architect).toEqual({ enabled: true, models: { "claude-opus-5-5": ["high"] } });
    expect(p.roles.verifier).toEqual({ enabled: true, models: { "claude-opus-5-5": ["low"] } });
    expect(p.harness).toEqual({ codex: { isolated: false }, opencode: { isolated: false } });
    expect(p.lock).toEqual({ heavy: "cpus/2" });
    expect(p.notify).toEqual(["milestone", "finish", "blocked"]);
  });

  test("returns the default profile when none is on disk, and writes nothing", () => {
    expect(loadProfile()).toEqual(defaultProfile());
    expect(loadProfile("default")).toEqual(defaultProfile());
    expect(existsSync(configDir())).toBe(false);
  });

  test("saves, lists and loads a named profile", () => {
    const p = { ...defaultProfile(), name: "fast", objective: "speed" as const };
    saveProfile(p);
    expect(loadProfile("fast")).toEqual(p);
    expect(listProfiles()).toEqual(["default", "fast"]);
  });

  test("switches the active profile globally and per repository", () => {
    saveProfile({ ...defaultProfile(), name: "work" });
    saveProfile({ ...defaultProfile(), name: "oss" });
    setActiveProfile("work");
    setActiveProfile("oss", "/r/app");
    expect(activeProfileName()).toBe("work");
    expect(activeProfileName("/r/app")).toBe("oss");
    expect(activeProfileName("/r/other")).toBe("work");
    expect(loadProfile().name).toBe("work");
    expect(JSON.parse(readFileSync(join(configDir(), "projects.json"), "utf8"))).toEqual({ "/r/app": "oss" });
  });

  test("refuses an unknown profile and a name that is not a plain file name", () => {
    expect(() => setActiveProfile("nope")).toThrow(/no profile named "nope"/);
    expect(() => loadProfile("nope")).toThrow(/no profile named "nope"/);
    expect(() => saveProfile({ ...defaultProfile(), name: "../evil" })).toThrow(/bad profile name/);
    expect(() => loadProfile("../evil")).toThrow(/bad profile name/);
  });

  test("loads a profile written before the harness toggle as native", () => {
    const old: Record<string, unknown> = { ...defaultProfile(), name: "old" };
    delete old.harness;
    writeProfileFile("old", old);
    expect(loadProfile("old").harness).toEqual({ codex: { isolated: false }, opencode: { isolated: false } });
    writeProfileFile("half", { ...defaultProfile(), name: "half", harness: { codex: { isolated: true } } });
    expect(loadProfile("half").harness).toEqual({ codex: { isolated: true }, opencode: { isolated: false } });
  });

  test("names the file and the field when a profile on disk is invalid", () => {
    writeProfileFile("bad", { ...defaultProfile(), name: "bad", objective: "vibes" });
    expect(() => loadProfile("bad")).toThrow(/bad\.json is invalid[\s\S]*objective/);
  });

  test("patches only what the patch names, without mutating the input", () => {
    const p = defaultProfile();
    const q = patchProfile(p, {
      objective: "speed",
      roles: { reviewer: { models: { "gpt-6-sol": ["xhigh"] } }, writer: { enabled: false } },
      harness: { codex: { isolated: true } },
      lock: { heavy: 2 },
    });
    expect(q.objective).toBe("speed");
    expect(q.roles.reviewer).toEqual({ enabled: true, models: { "gpt-6-sol": ["xhigh"] } });
    expect(q.roles.writer).toEqual({ enabled: false, models: { "gpt-6-luna": ["high"] } });
    expect(q.roles.worker).toEqual(p.roles.worker);
    expect(q.harness).toEqual({ codex: { isolated: true }, opencode: { isolated: false } });
    expect(q.lock).toEqual({ heavy: 2 });
    expect(q.notify).toEqual(p.notify);
    expect(p).toEqual(defaultProfile());
  });

  test("keeps failover and budget through a save/load round trip", () => {
    const p = {
      ...defaultProfile(),
      name: "budgeted",
      failover: { "gpt-6-sol#medium": "openrouter/acme/coder-1#default" },
      budget: { minutes: 60, usd: 5 },
    };
    saveProfile(p);
    expect(loadProfile("budgeted")).toEqual(p);
  });
});
