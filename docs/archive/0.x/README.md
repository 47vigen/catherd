# catherd 0.x design record (archived)

These files are the design and implementation plans for catherd 0.1 and 0.2 (npm `catherd-cli` 0.2.1 and
earlier). catherd 1.0 is a clean-break rewrite, so they no longer describe the code.

- `specs/2026-09-24-catherd-design.md`: the 0.x design. The 1.0 design,
  [`docs/superpowers/specs/2026-09-25-catherd-1.0-design.md`](../../superpowers/specs/2026-09-25-catherd-1.0-design.md),
  supersedes it where they disagree and still defers to it for the roles, the orchestrator sequence (§10), the climb
  rules and the reply contract.
- `plans/2026-09-24-0{1..4}-*.md`: the four 0.x implementation plans (core, routing, MCP and plugin, TUI).
- `plans/OVERRIDES.md`: the 0.x translation table from the Node toolchain the plans were written for to Bun and
  OpenTUI.
- `plans/INTERFACES.md`: names shared across the 0.x plans. None of those modules exist in 1.0.

Paths inside these files (`docs/specs/…`, `docs/plans/…`, `src/core/…`) are the ones they had before they were
archived. They are kept for history only; do not update them.

To upgrade from 0.x, read [`MIGRATION.md`](../../../MIGRATION.md).
