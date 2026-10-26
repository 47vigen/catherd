# catherd — agent instructions

catherd is a Bun/TypeScript CLI, MCP server and Claude Code plugin that herds coding agents: Claude plans and
verifies, Codex, opencode or headless Claude Code workers write the code, and a decision model picks each
dispatch's model and effort ("rungs", written `backend:model#effort`). npm package `catherd-cli`, command `catherd`, plugin
`catherd@catherd` from this repo's marketplace.

`CLAUDE.md` is the single source for this repo's rules: layout, layers, the gate, test conventions and release
steps. It is written for Claude Code but applies to every agent that works here, Codex included. Read it before you
change anything.
