# General workspace runs — research and decision

## Context and constraints

Researched against `main` at `804682f` (catherd 1.4). The request is general-purpose:
independent Git repositories, arbitrary languages and locations, Claude Code and Codex hosts.
The user chose separate workers per repository with shared coordination and visibility.
Contribution scope is a feature branch and upstream pull request. Merging, publication and changes
to other repositories remain outside this work.

The implementation style is Bun/TypeScript, versioned Zod schemas, explicit dependency ports,
structured errors with actionable fixes, and thin CLI/MCP/TUI entries. Layers are enforced by
`test/architecture.test.ts`. Detached supervisors and atomic, private, locked stores support restart recovery.
The 1.0 spec remains binding, extended by the 1.3 adapters and 1.4 host-context specs.
Verification: frozen install, typecheck, lint, format check, Bun tests. No new runtime dependency is needed.

## Single-repository assumptions, grouped by consequence

Source search finds 39 `meta.repo` occurrences across ten service modules, rather than relying on the
older brief's approximate count. Every occurrence keeps its existing single-repository meaning.

| Subsystem | Current assumption | Consequence of making one run span trees |
| --- | --- | --- |
| Run/store/paths | `run-service`, `run-store`, `infra/paths`: one Git toplevel and repo-keyed folder | Non-Git root cannot start; IDs, recovery, listings need a new identity |
| Routing/profiles/admission | `lane-service`, `admission`, `dispatch-service`, `preflight`: one profile, cwd and ownership namespace | Every dispatch needs a selected repo; failover must retain it |
| Gates/milestones/landing | `gate-service`, `milestones`, `lane-service`: hashes and commits from one tree | A commit/hash without repo identity becomes ambiguous |
| State/visibility | `state`, `summary`, `runs-page`: one HEAD, dirty tree and budget | Aggregate view requires a separate parent, not a fake Git HEAD |
| Knowledge | `readKnowledge`, `appendKnowledge`: repo-keyed learning | Keep repo knowledge local; share task contracts in the parent |
| Adapters/access | each adapter plans from `RunRequest.repo`; auxiliary writable roots are locks/temp/caches | A workspace registry must not silently grant sibling writes |

`land` validates and records an existing commit; it does not commit or merge. Heavy locks constrain
expensive commands, not the number of agent processes. Native Claude usage is reported after execution.
These distinctions matter for claims about ordering and budget enforcement.

## External comparison

- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference): `--add-dir` grants extra file access;
  it does not make each directory a full configuration root. Installed CLI help also confirms the flag.
- [Codex CLI](https://developers.openai.com/codex/cli/reference/): `--cd` selects cwd and `--add-dir`
  adds writable roots; installed help confirms both. Neither is a cross-repo completion protocol.
- [VS Code multi-root](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces)
  models an explicit collection of folders, preserving folder-scoped configuration.
- [Cursor multi-root](https://cursor.com/changelog/04-24-26) supports reusable multi-folder agent
  workspaces. Desktop/cloud capability does not establish equivalent `cursor-agent` CLI sandbox behavior.
- [Google repo manifests](https://gerrit.googlesource.com/git-repo/+/HEAD/docs/manifest-format.md)
  separate project identity/path/revision. Useful registry precedent; cloning/syncing all members is unnecessary here.
- [Sourcegraph Batch Changes](https://sourcegraph.com/docs/batch-changes) tracks one change across
  separate repository changesets. This supports a parent view without pretending Git transactions are atomic.
- [mani](https://github.com/alajmo/mani), [meta](https://github.com/mateodelnorte/meta), and
  [gita](https://github.com/nosarthur/gita) demonstrate explicit repo collections and grouped commands;
  they do not replace catherd's role routing, review gates, evidence or model accounting.
- [Nx](https://nx.dev/docs/kb/monorepo-vs-polyrepo) is a useful project-graph comparison, but build-task
  graphs and monorepo package workspaces differ from independent Git histories. Turborepo's current
  structuring page could not be retrieved in this pass; no capability claim relies on it.
- [Copilot cloud-agent limitations](https://docs.github.com/en/enterprise-cloud%40latest/copilot/concepts/about-assigning-tasks-to-copilot)
  document one repository per task. This is the cloud-agent surface, not a claim about every Copilot product.

No inspected catherd spec/backlog/CHANGELOG establishes an existing workspace implementation or
approved multi-repo roadmap. Recommendation is an upstream-quality feature in catherd's shared core;
an external wrapper would duplicate admission, accounting and crash recovery. No upstream issue/PR is created.

## A–E against the seven scenarios

Legend: yes = fits architecturally; manual = host/human coordination needed; partial = extra mechanism needed.
This is a design comparison, not measured performance.

| Scenario | A conventions | B repo-set run | C registry only | D parent graph | E worktree umbrella |
| --- | --- | --- | --- | --- | --- |
| 1. Producer before consumer | manual | partial: ordering | manual | yes | manual |
| 2. Independent parallel repos | yes, separate runs | yes | manual | yes | yes, higher setup cost |
| 3. Parallel members + joint check | manual | yes | manual | yes, final dependent integration step | partial |
| 4. Open a non-Git root | no | partial: resolver | yes | yes, with C | partial: registry |
| 5. Different repo profiles/knowledge | yes | partial: per-repo selection | yes | yes | yes |
| 6. Second fails after first lands | separate status | partial: landing policy | manual | explicit partial completion | partial: integration policy |
| 7. Claude Code and Codex hosts | existing runs | adapter changes | discovery only | shared core, existing children | host/isolation work |

Decision: **D + explicit C**. B is unnecessary because the user confirmed one worker need not edit
multiple repos. E remains an optional future isolation strategy; A is the fallback and test baseline.

## First vertical slice and benchmark

Workspace manifest: `catherd.workspace.json`, schema 1, named repo paths relative to its root or
explicit absolute paths. No hardcoded tracker, language, layout or personal path. Selected repositories
are snapshotted into the execution. Duplicate canonical Git roots and invalid/cyclic graphs are refused.
Steps sharing a repository must be ordered transitively by dependencies. Unordered same-repo steps
are refused, while a final verifier may reuse a member after both parallel producers finish.

The parent lives outside repositories. Each selected step lazily starts an ordinary child run;
its required landed milestone opens dependent steps. Linkage is written atomically with child metadata,
so a retry after a crash recovers the child. Parent status derives child facts rather than duplicating them.
Shared contracts freeze at the first child start and are copied into each child's run folder.
Profiles/knowledge remain per repo; joint verification is a final step with dependencies on all producers.

Parent budget totals tokens/USD once per record or pending dispatch, including reported native usage.
Minutes are parent elapsed time, not summed child time. Actual dispatch admission checks the parent
under an outer lock; routing uses the greater parent/child budget fraction. Existing caps stop new
admissions at observed usage, not already running workers. Native subagents are post-hoc accounting;
no strict token cap or native concurrency guarantee is claimed. No automatic cross-repo rollback.

Acceptance benchmark uses temporary Git fixtures, not the user's live projects: producer/consumer
ordering, independent members, dependency fan-in, non-Git roots, distinct profiles, partial completion,
portable MCP entry, selected-member laziness, duplicate/cycle rejection, restart/idempotency, frozen
contracts, aggregate spending, simultaneous admissions, and routing at the shared 80% threshold.
Record fixture setup/inspection timing only if measured; do not claim better speed or token savings.

Polish review reproduced admission/landing races, corrupt cost evidence, negative usage, and recovery
after a deleted checkout. Landing now shares the parent admission lock and refuses live or uncollected
dispatches. Workspace accounting fails closed on corrupt or negative cost/token evidence; ordinary
run readers retain their existing tolerant behavior. Stored status remains readable after checkout
loss; admission and recovery validate the captured Git root. Child discovery reads only selected
repository histories, and status reuses dependency evidence once per child.

Workspace schemas, manifests and MCP accept at most 100 repositories/steps/dependencies. Validation
uses indexed iterative topological traversal and ancestor sets, replacing recursive repeated walks.
An isolated Bun in-memory benchmark of the identical valid reverse-listed 100-step same-repository
chain (3 warmups, 9 samples) measured median schema validation 6.449 ms before, 0.511 ms after.
This is one local microbenchmark, not end-to-end latency or a guarantee for arbitrary filesystem load.

Module changes: new domain/store/service workspace modules; small run linkage extension; parent-aware
admission and routing; dedicated MCP/CLI entries; portable skill and README instructions. Existing
single-repo gate, land, adapter cwd and knowledge semantics are preserved. Full release/PR work is excluded.

## Verification evidence

- Baseline on updated main: full gate, 1955 pass / 27 skip / 0 fail across 176 files.
- Implemented slice: full suite, 1974 pass / 27 skip / 0 fail across 179 files; 90 snapshots.
- Final validation correction: 31 focused tests / 138 assertions passed, then typecheck, lint and
  format checks passed. Duplicate IDs plus an unknown dependency were reproduced as a TypeError,
  then corrected to `E_INPUT_INVALID`. The shared-cost route and protected contract also have
  observed assertion-failure → pass regression evidence.
- Final tarball installs into an empty project; installed CLI and MCP initialize/tools-list handshake
  passed under the Codex host without creating Claude configuration. No package was published.
- Read-only independent review found the validation defect above; it was corrected with a regression.
  Controller reviewed interfaces, integration, lock order and final diffs; direct `admit()` tests prove
  parent budget and dependency checks cannot be bypassed through the child tool surface.
- Final polish: fresh full suite 1998 pass / 27 skip / 0 fail across 181 files, 90 snapshots and
  14390 assertions; frozen install, typecheck, lint and format checks passed. Final packed install,
  CLI, doctor and MCP handshake passed. Actual RED → GREEN regressions cover landing/admission
  concurrency, corrupt records/admissions/native verdicts, negative recorded/native/pending usage,
  checkout recovery, directory-root validation and bounded graph validation.
- Remaining live limit: no paid worker turns or actual multi-repo task in a live Claude/Codex
  conversation were run. Portable MCP behavior, CLI, recovery and accounting were tested with
  temporary repositories and simulators. Performance/token-saving claims are intentionally absent.
