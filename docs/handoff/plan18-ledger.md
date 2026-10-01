# Plan18 host context and profiles — execution ledger

Approved plan: `docs/plans/2026-10-01-18-host-context-profiles.md`; binding spec: `docs/specs/2026-10-01-catherd-codex-entry-design.md`. All four tasks implemented and personally reviewed on the managed catherd-codex-entry worktree. Source head50468a7 is unreleased; native delivery and installed acceptance remain Plans19/20.

| Scope | Commits | Personal verification |
| --- | --- | --- |
| Host initialization and namespaced sessions | 433a6c7, ebe0700, 8055fb8 |108pass/0fail, then33pass/0fail covering identity review fixes; typecheck exit0 |
| Host defaults and optional dependencies |9e37156,50468a7 |347pass,1platform skip,0fail,1220assertions across18files; stdio integration6pass/0fail,53assertions; typecheck/lint/format exit0 |

The controller reviewed the implemented source and personally verified unknown/conflicting host safety, compound ownership, request-local MCP profile resolution, raw status/result inspection, exact owner-approved gpt-6.1-sol high/low defaults, explicit native/headless semantics, stale reviewed reset, selected repository readiness, populated Claude-link preservation and child identity scrubbing. Review corrections require native Claude execution to have the Claude Code host, retain contradictory terminal evidence without inventing ownership, propagate host to catalog clear/reset, and report unknown TUI profile errors inside the tab. No load-bearing finding remains in this scope.

The broad local gate for Tasks3–4 had1874pass,22skip,10fail across173files. Its failures were recorded, not called green: catalog clear diagnostics3, generic stdio identity4, a legacy native failover fixture1, unknown TUI render2. After correction, all failed files and affected profile/TUI paths passed126/0; selected dependency matrix47/0 and native optional-link severity1/0 also passed. The controller covering run used the wrong stdio path initially; the actual test/integration/mcp-stdio.test.ts then passed separately. Tasks1–2's broad gate had one unchanged preflight deadline flake under load, which passed focused retry. Platform skips are not acceptance evidence. The full suite was not rerun without a new reason after corrected covering tests and static checks passed.

Rulings carried forward: use owner-required personal verification and native configured model at low/medium effort; preserve official native MCP client/thread metadata rather than a global last-thread context; require native --remote unix:// queue binding to avoid embedded-server fallback. The latter is source/help validated, but actual explicit-endpoint delivery still needs Plans19/20 acceptance. Hosts lacking that option keep peek/result recovery.

No dependencies, CI checks, push, public release or native configuration changes were introduced by this plan. The exact source/test contracts and logs remain in the ignored .superpowers/sdd/2026-10-01-18-host-context-profiles directory for ongoing execution; Git and this ledger are the durable handoff.
