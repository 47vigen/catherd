import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const root = join(import.meta.dir, "..");
const readJson = (base: string, p: string) => JSON.parse(readFileSync(join(base, p), "utf8"));

describe("plugin", () => {
  it("the marketplace lists the plugin folder", () => {
    const m = readJson(root, ".claude-plugin/marketplace.json");
    expect(m.name).toBe("catherd");
    expect(m.owner.name).toBeTruthy();
    const entry = m.plugins.find((p: { name: string }) => p.name === "catherd");
    expect(entry.source).toBe("./plugin");
    expect(entry.version).toBeUndefined();
    expect(existsSync(join(root, entry.source, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("pins the package version in the manifest and in the MCP command", () => {
    const { version } = readJson(root, "package.json");
    expect(readJson(root, "plugin/.claude-plugin/plugin.json")).toMatchObject({ name: "catherd", version });
    expect(readJson(root, "plugin/.mcp.json")).toEqual({
      mcpServers: { catherd: { command: "bunx", args: [`catherd-cli@${version}`, "mcp"] } },
    });
  });

  it("the stamp script writes a new version into both files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "catherd-stamp-"));
    for (const p of ["package.json", "plugin", "scripts"]) {
      cpSync(join(root, p), join(tmp, p), { recursive: true });
    }
    const pkg = readJson(tmp, "package.json");
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ ...pkg, version: "9.9.9" }));
    const proc = Bun.spawnSync(["bun", join(tmp, "scripts", "stamp-plugin-version.mjs")]);
    expect(proc.success).toBe(true);
    expect(readJson(tmp, "plugin/.claude-plugin/plugin.json").version).toBe("9.9.9");
    expect(readJson(tmp, "plugin/.mcp.json").mcpServers.catherd.args).toEqual(["catherd-cli@9.9.9", "mcp"]);
  });

  it("each command hands its arguments to its skill", () => {
    for (const [cmd, skill] of [
      ["catherd", "catherd"],
      ["catherd-setup", "catherd-setup"],
    ] as const) {
      const md = readFileSync(join(root, "plugin", "commands", `${cmd}.md`), "utf8");
      expect(md).toMatch(/^---\ndescription: .+\nargument-hint: .+\n---\n/);
      expect(md).toContain(`\`${skill}\` skill`);
      expect(md).toContain("$ARGUMENTS");
    }
  });
});
