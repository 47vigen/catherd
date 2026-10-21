---
description: Orchestrate a task with catherd — a background daemon plans, dispatches, reviews and verifies it, and headless roles write the code
argument-hint: "<task, or nothing to resume the latest run>"
---

Use the `catherd` skill for this, and follow it exactly.

Task: $ARGUMENTS

If the task is empty, resume: call `status()`, tell the user which run it names and what it waits on, and relay any parked question to them: their answer goes in with `answer(run, unit, answer)`. A finished run is read with `result(run)`.
