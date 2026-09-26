import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  configFile,
  getProfile,
  patchProfile,
  profilesDir,
  projectsFile,
} from "../../src/services/profile-service.ts";
import { initSetup, moveLegacy } from "../../src/services/setup.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

function legacyFiles(): void {
  mkdirSync(profilesDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify({ activeProfile: "fast" }));
  writeFileSync(projectsFile(), JSON.stringify({ "/r/app": "fast" }));
  writeFileSync(
    join(profilesDir(), "fast.json"),
    JSON.stringify({ name: "fast", objective: "speed", roles: {} }),
  );
}

describe("moveLegacy", () => {
  it("moves every 0.x file to a dated backup and leaves 1.0 files alone", () => {
    withHome();
    legacyFiles();
    writeFileSync(join(profilesDir(), "team.json"), JSON.stringify({ schema: 1, name: "team" }));
    const moved = moveLegacy(new Date("2026-09-25T12:00:00Z"));
    expect(moved.map((f) => f.slice(dirname(configFile()).length + 1)).sort()).toEqual([
      "0.x-backup-2026-09-25T12-00-00-000Z/config.json",
      "0.x-backup-2026-09-25T12-00-00-000Z/profiles/fast.json",
      "0.x-backup-2026-09-25T12-00-00-000Z/projects.json",
    ]);
    expect([existsSync(configFile()), existsSync(join(profilesDir(), "team.json"))]).toEqual([false, true]);
    expect(moveLegacy()).toEqual([]);
  });
});

describe("initSetup", () => {
  it("writes the default profile, makes it active and links its agents, after moving 0.x files", async () => {
    withHome();
    process.env.PATH = "/nonexistent";
    // with a key the claude-code listing is an HTTP call, and a test never reaches the network
    delete process.env.ANTHROPIC_API_KEY;
    legacyFiles();
    const r = await initSetup();
    expect([r.profile, r.created, r.moved.length]).toEqual(["default", true, 3]);
    expect(r.synced.linked).toEqual([
      "catherd-default-architect-claude-opus-5-5-high",
      "catherd-default-verifier-claude-opus-5-5-low",
    ]);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ schema: 1, activeProfile: "default" });
    expect(r.refreshed.map((x) => x.backend)).toContain("codex");
  });

  it("keeps a 1.0 profile unless asked to replace it", async () => {
    withHome();
    process.env.PATH = "/nonexistent";
    delete process.env.ANTHROPIC_API_KEY;
    patchProfile("team", { budget: { usd: 3 } });
    expect((await initSetup({ profile: "team" })).created).toBe(false);
    expect(getProfile("team").budget).toEqual({ usd: 3 });
    expect((await initSetup({ profile: "team", overwrite: true })).created).toBe(true);
    expect(getProfile("team").budget).toEqual({});
    expect(basename(join(profilesDir(), "team.json"))).toBe("team.json");
  });
});
