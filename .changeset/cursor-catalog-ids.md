---
"catherd-cli": patch
---

The catalog's Cursor ids and efforts now match Cursor's live model listing, so `cursor:` rungs read differently (for
example `cursor:cursor-grok-4.6#high` and `cursor:claude-opus-5-5#high`), and Grok and Gemini fail over to Cursor at
the same effort where both list it.
