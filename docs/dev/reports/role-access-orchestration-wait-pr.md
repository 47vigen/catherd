# Role access and orchestration wait review

Title: fix: provide role MCP access and bounded orchestration waits

## Problem and behavior

Headless architects can be denied catherd's run-file tools despite having read-only project access. Native
Codex orchestration can also stop between phases after a completion notice is accepted by the queue; acceptance
does not establish that a new turn started or the result was collected.

Native headless Codex and Claude Code roles receive a dedicated `catherd_role` MCP server and explicit access
to catherd's role tools. Project access restrictions remain in place; user configuration and profiles are not
rewritten. Required MCP roles with isolated harnesses fail before launch. Native Claude subagents keep their
plugin tool namespace.

Codex orchestration dispatches independent roles first, then uses bounded `wait` calls and collects completed
records with `result` before advancing. Status exposes unread results awaiting the orchestrator. Claude Code
retains its push flow, and duplicate queued notices retain their existing idempotent handling.

## Validation and limits

- Final source review covered role tool permissions, run/repository binding, dependency layers,
  failover publication, cancellation and unread-result cache recovery. `git diff --check` passed.
- After the owner authorized a lightweight local gate, typecheck, lint and format checking passed.
  Focused tests cover the affected services, adapters, MCP surface, CLI and TUI; the two doctor
  expectations affected by the new diagnostic were updated and passed on recheck.
  Nine new regressions passed for bounded waiting, cancellation, linked failover, no collection or
  ownership mutation, role tool sets and run/repository/path restrictions.
  TUI frames were regenerated per CONTRIBUTING.md and remained unchanged.
- Native host wake behavior, packaged acceptance and performance gains have not been demonstrated.
- The full test suite and packaged native Codex/Claude acceptance remain outstanding. CONTRIBUTING.md holds this
  feature's release and forbids triggering or re-enabling CI for this work.
- Per-host custom ladders, plan-width guardrails, cheaper fix-round models and multi-repo support are outside this PR.
