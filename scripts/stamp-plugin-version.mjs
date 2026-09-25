import { readFileSync, writeFileSync } from "node:fs";

// Regex substitution, not JSON.stringify: keeps the files' existing (oxfmt) formatting intact.
const root = new URL("..", import.meta.url);
const path = (p) => new URL(p, root);
const read = (p) => readFileSync(path(p), "utf8");

const { version } = JSON.parse(read("package.json"));

writeFileSync(
  path("plugin/.mcp.json"),
  read("plugin/.mcp.json").replace(/catherd-cli@[^"]+/, `catherd-cli@${version}`),
);
writeFileSync(
  path("plugin/skills/catherd/SKILL.md"),
  read("plugin/skills/catherd/SKILL.md").replace(/catherd-cli@\d[^\s`)"]*/g, `catherd-cli@${version}`),
);
writeFileSync(
  path("plugin/.claude-plugin/plugin.json"),
  read("plugin/.claude-plugin/plugin.json").replace(/"version": "[^"]+"/, `"version": "${version}"`),
);

console.log(`plugin stamped with catherd@${version}`);
