---
"catherd-cli": patch
---

Three fixes from the first 2.0 beta run. A run started from Claude Code or Codex now dispatches its architect and verifier on that host's default rungs, where it used to stop with "roles.architect.rungs needs an orchestration host" when the profile named none. `catherd init` remembers the host it ran on, so the panel's Setup page lists the roles instead of failing; with no remembered host it shows the architect and verifier as set by the session's host. `catherd init` no longer ends with plugin install commands when its own report shows the plugin ready, and on a pre-release it names the next channel's marketplace.
