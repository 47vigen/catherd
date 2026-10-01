import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { adapterFor } from "../../src/adapters/registry.ts";
import { writeDiscovery } from "../../src/adapters/discovery.ts";
import { claudeAgentsDir } from "../../src/infra/paths.ts";
import { credentialsPath, jevKey } from "../../src/services/jev-service.ts";
import { patchProfile } from "../../src/services/profile-service.ts";
import {
  agentsRoot,
  configFile,
  getProfile,
  profilesDir,
  projectsFile,
} from "../../src/services/profile-store.ts";
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
    const r = await initSetup({ host: { host: "claude-code", session: null, conflict: null } });
    expect([r.profile, r.created, r.moved.length]).toEqual(["default", true, 3]);
    expect(r.synced?.linked).toEqual([
      "catherd-default-architect-claude-opus-5-5-high",
      "catherd-default-verifier-claude-opus-5-5-low",
    ]);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ schema: 1, activeProfile: "default" });
    expect(r.refreshed.map((x) => x.backend)).toContain("codex");
  });

  it("replaces the 0.x agent links with 1.0 ones, never a file of the user's, and keeps the Jev key", async () => {
    withHome();
    process.env.PATH = "/nonexistent";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    legacyFiles();
    // 0.x linked catherd-<role>-<model>-<effort> into the agents dir, from catherd's own config folder
    const old = join(agentsRoot(), "fast", "catherd-architect-claude-opus-5-5-high.md");
    mkdirSync(dirname(old), { recursive: true });
    writeFileSync(old, "a 0.x agent");
    mkdirSync(claudeAgentsDir(), { recursive: true });
    symlinkSync(old, join(claudeAgentsDir(), "catherd-architect-claude-opus-5-5-high.md"));
    writeFileSync(join(claudeAgentsDir(), "mine.md"), "the user's own agent");
    writeFileSync(credentialsPath(), JSON.stringify({ typesafeApiKey: "tsk-0x-key" }));
    await initSetup({ host: { host: "claude-code", session: null, conflict: null } });
    expect(readdirSync(claudeAgentsDir()).sort()).toEqual([
      "catherd-default-architect-claude-opus-5-5-high.md",
      "catherd-default-verifier-claude-opus-5-5-low.md",
      "mine.md",
    ]);
    expect(jevKey()).toBe("tsk-0x-key");
  });

  it("writes and activates nothing when the defaults do not validate here, and says why", async () => {
    withHome();
    process.env.PATH = "/nonexistent";
    delete process.env.ANTHROPIC_API_KEY;
    // codex's last listing offers gpt-6-sol at low only: the default rungs' efforts are not there
    writeDiscovery("codex", [{ id: "gpt-6-sol", efforts: ["low"], context: null, imageIn: true }]);
    const r = await initSetup({
      host: { host: "claude-code", session: null, conflict: null },
      profile: "team",
    });
    expect([r.created, r.active, r.synced]).toEqual([false, false, null]);
    expect(r.errors.map((e) => e.message)).toContain(
      'gpt-6-sol has no effort "medium" on codex (it has low)',
    );
    expect([existsSync(join(profilesDir(), "team.json")), existsSync(configFile())]).toEqual([false, false]);
  });

  it("keeps a 1.0 profile unless asked to replace it", async () => {
    withHome();
    process.env.PATH = "/nonexistent";
    delete process.env.ANTHROPIC_API_KEY;
    patchProfile("team", { budget: { usd: 3 } }, { host: "claude-code" });
    expect(
      (await initSetup({ host: { host: "claude-code", session: null, conflict: null }, profile: "team" }))
        .created,
    ).toBe(false);
    expect(getProfile("team", "claude-code").budget).toEqual({ usd: 3 });
    expect(
      (
        await initSetup({
          host: { host: "claude-code", session: null, conflict: null },
          profile: "team",
          overwrite: true,
        })
      ).created,
    ).toBe(true);
    expect(getProfile("team", "claude-code").budget).toEqual({});
    expect(basename(join(profilesDir(), "team.json"))).toBe("team.json");
  });
});

it("initializes Codex omitted defaults without creating Claude files", async () => {
  withHome();
  process.env.PATH = "/nonexistent";
  delete process.env.ANTHROPIC_API_KEY;
  const r = await initSetup({ host: { host: "codex", session: null, conflict: null } });
  expect(r.created).toBe(true);
  expect(r.synced?.linked).toEqual([]);
  expect(getProfile("default", "codex").roles.verifier.rungs).toEqual(["codex:gpt-6.1-sol#low"]);
  expect(existsSync(claudeAgentsDir())).toBe(false);
});

it("Codex-only setup skips unused Claude discovery, while selected headless and Claude host setup retain it", async () => {
  withHome();
  delete process.env.ANTHROPIC_API_KEY;
  // An empty listing exercises discovery's probe fallback; it must remain unreachable for unused Claude.
  const adapter = adapterFor("claude-code")!;
  const listModels = adapter.listModels;
  adapter.listModels = async () => [];
  try {
    const bin = join(process.env.CATHERD_HOME!, "sentinel-bin");
    mkdirSync(bin);
    const calls = join(process.env.CATHERD_HOME!, "claude-discovery-calls");
    writeFileSync(
      join(bin, "claude"),
      '#!/bin/sh\nmkdir -p "$CLAUDE_CONFIG_DIR"\nprintf "%s\\n" "$*" >> "$CATHERD_HOME/claude-discovery-calls"\nprintf x > "$CLAUDE_CONFIG_DIR/discovery-sentinel"\nif [ "$1" = --version ]; then echo 2.1.0; else printf \'{"loggedIn":false}\\n\'; fi\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    const host = { host: "codex" as const, session: null, conflict: null };
    const unused = await initSetup({ host });
    expect(unused.created).toBe(true);
    expect(unused.refreshed.some((r) => r.backend === "claude-code")).toBe(false);
    expect(existsSync(calls)).toBe(false);
    expect(existsSync(join(process.env.CLAUDE_CONFIG_DIR!, "discovery-sentinel"))).toBe(false);
    expect(
      patchProfile(
        "default",
        { roles: { architect: { rungs: ["claude-code:claude-opus-5-5#high"] } } },
        { host: "codex" },
      ).saved,
    ).toBe(true);
    expect((await initSetup({ host })).refreshed.some((r) => r.backend === "claude-code")).toBe(true);
    expect(readFileSync(calls, "utf8")).toContain("auth status --json");
    expect(
      (await initSetup({ host: { host: "claude-code", session: null, conflict: null } })).refreshed.some(
        (r) => r.backend === "claude-code",
      ),
    ).toBe(true);
    const before = readFileSync(calls, "utf8");
    writeDiscovery("codex", [{ id: "gpt-6-sol", efforts: ["low"], context: null, imageIn: true }]);
    const invalid = await initSetup({ host, profile: "invalid" });
    expect(invalid.active).toBe(false);
    expect(invalid.refreshed.some((r) => r.backend === "claude-code")).toBe(false);
    expect(readFileSync(calls, "utf8")).toBe(before);
  } finally {
    adapter.listModels = listModels;
  }
}, 20_000);
