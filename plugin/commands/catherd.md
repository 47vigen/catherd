---
description: Orchestrate a task with catherd — Claude plans and verifies, Codex and opencode workers write the code
argument-hint: "<task, or nothing to resume the latest run>"
---

Use the `catherd` skill for this, and follow it exactly.

Task: $ARGUMENTS

If the task is empty, resume: call `status()`, tell the user which run it names, and continue that run from its state.md.
