---
"catherd-cli": patch
---

A model the account cannot use (Codex's `model_not_found`, Claude's "may not have access") no longer reads as a CLI too old: the dispatch ends `limit` with the error code `model-unavailable` ("model not available to this account"), its quota is held, and the next turn or task starts on the next rung whose quota is free instead of repeating the same rung.
