import { readFileSync, writeFileSync } from "node:fs";

// Regex substitution, not JSON.stringify: keeps the files' existing (oxfmt) formatting intact.
const root = new URL("..", import.meta.url);
const path = (p) => new URL(p, root);
const read = (p) => readFileSync(path(p), "utf8");

const { version } = JSON.parse(read("package.json"));

// the MCP launcher starts this version (a global catherd at it, else bunx catherd-cli@<it>)
writeFileSync(
  path("plugin/bin/catherd-mcp"),
  read("plugin/bin/catherd-mcp").replace(/^VERSION="[^"]*"$/m, `VERSION="${version}"`),
);
writeFileSync(
  path("plugin/skills/catherd/SKILL.md"),
  read("plugin/skills/catherd/SKILL.md").replace(/catherd-cli@\d[^\s`)"]*/g, `catherd-cli@${version}`),
);
writeFileSync(
  path("plugin/.claude-plugin/plugin.json"),
  read("plugin/.claude-plugin/plugin.json").replace(/"version": "[^"]+"/, `"version": "${version}"`),
);

// the marketplace serves the plugin from its release tag, so `main` never ships skills ahead of the server
writeFileSync(
  path(".claude-plugin/marketplace.json"),
  read(".claude-plugin/marketplace.json").replace(/"ref": "v[^"]+"/, `"ref": "v${version}"`),
);

console.log(`plugin stamped with catherd@${version}`);
