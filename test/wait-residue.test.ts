import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { roleMcpTools } from "../src/domain/role-tools.ts";
import { ROLES } from "../src/domain/roles.ts";
import { withHome } from "./helpers.ts";
import { mcpClient } from "./mcp-helpers.ts";

// Plan 22 (owner ruling 1, X2): `wait` is gone (#45). Nothing a coordinator or a role reads may name it as a tool
// again: no MCP tool, no `wait(` call, no `wait` in backticks outside a line that says it is gone.

const ROOT = join(import.meta.dir, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Every file the plugin ships or a coordinator or role reads: the plugin, the MCP entry, the prompts, the README. */
const READ = [
  ...files(join(ROOT, "plugin")),
  ...files(join(ROOT, "src", "entry", "mcp")),
  join(ROOT, "src", "domain", "role-prompts.ts"),
  join(ROOT, "src", "domain", "role-tools.ts"),
  join(ROOT, "README.md"),
];

const naming = /\bwait\(|`wait`|"wait"/;
const gone = /\b(gone|removed)\b/;

describe("no residue of the removed wait tool (plan 22)", () => {
  it("lists no wait tool on the coordinator's server or on any role's", async () => {
    withHome();
    const names = (await (await mcpClient()).listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("wait");
    for (const role of ROLES) expect(roleMcpTools(role)).not.toContain("wait");
  });

  it("names wait as a tool nowhere a coordinator or a role reads, except where it says it is gone", () => {
    const found = READ.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          naming.test(line) && !gone.test(line) ? [`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`] : [],
        ),
    );
    expect(found).toEqual([]);
  });
});
