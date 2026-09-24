import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { configDir } from "../src/paths.ts";
import { agentName, saveProfileAndAgents, writeClaudeAgents } from "../src/profile/agents.ts";
import { defaultProfile, listProfiles, saveProfile, setActiveProfile } from "../src/profile/profile.ts";
import { loadCatalog } from "../src/routing/catalog.ts";
import type { Profile } from "../src/types.ts";
import { withHome } from "./helpers.ts";

let agents: string;
const fast = (): Profile => {
  const p = defaultProfile();
  return {
    ...p,
    name: "fast",
    roles: { ...p.roles, verifier: { enabled: true, models: { "claude-opus-5-5": ["medium"] } } },
  };
};

describe("agentName", () => {
  test("slugs the model and keeps role and effort", () => {
    expect(agentName("architect", "claude-opus-5-5#high")).toBe("catherd-architect-claude-opus-5-5-high");
    expect(agentName("ui-reviewer", "Anthropic/Claude Opus.5#low")).toBe(
      "catherd-ui-reviewer-anthropic-claude-opus-5-low",
    );
  });
});

describe("writeClaudeAgents", () => {
  beforeEach(() => {
    withHome();
    agents = mkdtempSync(join(tmpdir(), "catherd-agents-"));
    process.env.CATHERD_CLAUDE_AGENTS_DIR = agents;
  });

  test("writes one file per enabled Claude role, model and effort, and links it", () => {
    const r = writeClaudeAgents(defaultProfile(), loadCatalog());
    const dir = join(configDir(), "agents", "default");
    expect(r.written.sort()).toEqual([
      join(dir, "catherd-architect-claude-opus-5-5-high.md"),
      join(dir, "catherd-verifier-claude-opus-5-5-low.md"),
    ]);
    const link = join(agents, "catherd-architect-claude-opus-5-5-high.md");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(dir, "catherd-architect-claude-opus-5-5-high.md"));
    const text = readFileSync(link, "utf8");
    expect(text.startsWith("---\nname: catherd-architect-claude-opus-5-5-high\n")).toBe(true);
    expect(text).toContain("\nmodel: claude-opus-5-5\neffort: high\n");
    expect(text).toContain("\ndisallowedTools: Write, Edit, NotebookEdit, Agent\n");
    expect(text).toContain("Owns:");
    expect(text).not.toMatch(/Vigen|agora/);
  });

  test("retargets shared names and prunes the previous profile's links when the active profile changes", () => {
    const c = loadCatalog();
    writeClaudeAgents(defaultProfile(), c);
    saveProfile(fast());
    setActiveProfile("fast");
    const r = writeClaudeAgents(fast(), c);
    expect(r.pruned).toEqual([join(agents, "catherd-verifier-claude-opus-5-5-low.md")]);
    expect(existsSync(join(agents, "catherd-verifier-claude-opus-5-5-low.md"))).toBe(false);
    expect(readlinkSync(join(agents, "catherd-architect-claude-opus-5-5-high.md"))).toBe(
      join(configDir(), "agents", "fast", "catherd-architect-claude-opus-5-5-high.md"),
    );
    expect(existsSync(join(agents, "catherd-verifier-claude-opus-5-5-medium.md"))).toBe(true);
  });

  test("writes a non-active profile's files without touching the links", () => {
    const c = loadCatalog();
    writeClaudeAgents(defaultProfile(), c);
    const r = writeClaudeAgents(fast(), c);
    expect(r.written).toHaveLength(2);
    expect(r.linked).toEqual([]);
    expect(r.pruned).toEqual([]);
    expect(existsSync(join(agents, "catherd-verifier-claude-opus-5-5-low.md"))).toBe(true);
  });

  test("refuses to replace a file of the user's own, and writes nothing", () => {
    const mine = join(agents, "catherd-architect-claude-opus-5-5-high.md");
    writeFileSync(mine, "my own agent");
    expect(() => writeClaudeAgents(defaultProfile(), loadCatalog())).toThrow(/is not catherd's/);
    expect(readFileSync(mine, "utf8")).toBe("my own agent");
    expect(existsSync(join(configDir(), "agents", "default"))).toBe(false);
  });

  test("leaves a symlink of the user's own to elsewhere alone and refuses it too", () => {
    const elsewhere = join(mkdtempSync(join(tmpdir(), "catherd-other-")), "a.md");
    writeFileSync(elsewhere, "x");
    symlinkSync(elsewhere, join(agents, "catherd-verifier-claude-opus-5-5-low.md"));
    expect(() => writeClaudeAgents(defaultProfile(), loadCatalog())).toThrow(/is not catherd's/);
  });

  test("saveProfileAndAgents saves the profile JSON after the agent files", () => {
    saveProfileAndAgents(fast(), loadCatalog());
    expect(listProfiles()).toContain("fast");
    expect(
      existsSync(join(configDir(), "agents", "fast", "catherd-verifier-claude-opus-5-5-medium.md")),
    ).toBe(true);
  });
});
