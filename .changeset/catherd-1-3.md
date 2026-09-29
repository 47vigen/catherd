---
"catherd-cli": minor
---

catherd 1.3: three new worker backends, Cursor, Grok Build and Antigravity, each off until a profile puts a rung on it. Nothing to migrate: upgrade, run `catherd doctor`, and start a new Claude Code session (see MIGRATION.md, "From 1.2 to 1.3").

- **Cursor (`cursor:`).** `cursor-agent` 2026.09.28 or newer, briefs on stdin, the effort as the slug's suffix (`cursor:gpt-6-sol#xhigh`). `workspace-write` runs in Cursor's sandbox without `--force`; doctor runs the five access probes through its sandbox runner. Isolated runs need `CURSOR_API_KEY` and get their own `sandbox.json`.
- **Grok Build (`grok:`).** xAI's `grok` CLI on a Grok login or `XAI_API_KEY`; see the README's Grok section for its access modes and isolation.
- **Antigravity (`antigravity:`).** Google's `agy` 1.2.13 or newer, on a Google login (plan quota) or `GEMINI_API_KEY` (the Gemini API project). catherd never runs `agy -p` while agy is signed out, since it would open a browser. agy has no read-only mode: a read-only role runs on it only isolated, where catherd's own settings deny writes and commands; `profile validate` refuses it natively. Doctor shows the plan quota left (`quota:antigravity`).
- **Generic groundwork.** Admission refuses to resume a thread under another access or network grant on a backend that keeps a thread's access. A CLI the OS cannot execute is "installed but cannot run", with the reinstall command. A logged-out backend never reaches a dispatch. An isolated backend that needs an API key does not validate without it, and the dashboard's harness row says so. Doctor's access row says "not tested" where a backend has no sandbox runner.
- **Catalog.** Grok 4.7, 4.6 and 4.5, Composer 2.5, and Gemini 3.8, 3.7 and 3.6 Flash and 3.1 Pro join the families, so the public sources score them; a model a backend runs with no effort is scored at `#default`. Gemini fails over between Antigravity and Cursor (and Grok between Grok Build and Cursor) when neither the profile nor the backend names another stand-in; the new backends never stand in for the shipped ones.
