---
"catherd-cli": patch
---

Older model versions are hidden by default. When a newer version of a model is offered on the same backend (GPT-6.1 Sol replaces GPT-6 Sol on Codex, Claude Sonnet 5.5 replaces Sonnet 5, and so on), `catherd catalog list` leaves the older one out unless you pass `--older`, failover no longer picks it as a stand-in, Setup's model picker shows it only under "Show older versions" (a rung already on a role stays and names its newer version), and the Models page starts with its switch off. Profiles that name an older model keep working unchanged.
