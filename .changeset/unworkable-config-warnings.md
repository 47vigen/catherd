---
"catherd-cli": patch
---

Warn about settings that cannot work on this machine: `profile validate` and `catherd doctor` flag a `budget.usd` cap
when a role or its failover stand-in runs on a backend that reports no dollar cost (Codex, Cursor, Antigravity), and
`catherd doctor` flags a profile that turns the ui-reviewer on while `agent-browser`, which takes its screenshots, is
not on PATH. Each warning names the fix.
