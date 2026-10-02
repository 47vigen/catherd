# catherd 1.5, plan 26: the minors sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** close every small item `docs/dev/ideas.md` still holds under "1.1 follow-ups", "1.2 follow-ups" (those plan 24 does not own) and "1.3 follow-ups", the 1.0.0 fresh-install polish, the README's silent-first-`bunx` note and the three-MCP-servers investigation (closed by plan 22): one commit per area, each with a test where it changes behaviour, and a last task that removes from `ideas.md` exactly what this plan fixes or verifies.

**Architecture:** no new module. Each area edits the files that hold its items: the Runs page (`src/entry/tui/`, `src/services/runs-page.ts`), the protocol and land gate (`protocol.ts`, `peek.ts`, `reentry.ts`, `lane-service.ts`, `milestones.ts`, `run-store.ts`, `run-service.ts`), dispatch routing and the gate ledger (`dispatch-service.ts`, `gate-service.ts`), doctor and `profile show` (`doctor*.ts`, the claude-code adapter, `profile-command.ts`), validation (`profile-rules.ts`, `failover.ts`), the global install (`global-install.ts`), the 1.3 adapters (cursor, grok, antigravity, their simulators) and the docs (README, MIGRATION, live-verification). Layers stay `domain → infra → adapters → services → entry`.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, citty, `@modelcontextprotocol/sdk`, `@opentui/react`. No new dependency.

**Spec:** `docs/specs/2026-10-02-catherd-1.5-design.md`, "Plan 26: the minors sweep"; the entries it names are in `docs/dev/ideas.md` (their evidence and suggested fixes; the spec is binding where they differ).

**Pre-validated on scratch `6f2f8c7..0ab697c` (branch `plan26-scratch`; code head `0ab697c`, the plan file commit on top): 2035 pass / 19 skip / 0 fail (2054 tests, 183 files, about 6 minutes); typecheck, lint and format:check green.** The code below is that scratch build, commit by commit, built on `main` at `6f2f8c7` (cross-plan ruling X1: plans 21–25 merge first, so the executor re-finds every hunk by its context; see "Risks for the executor").

## Global Constraints

- The spec section, verbatim: "Every remaining bullet under "1.1 follow-ups", "1.2 follow-ups" (those not in plan 24) and "1.3 follow-ups", one commit per area, each with a test where it changes behavior. Also: the 1.0 fresh-install polish still open, the `init` silent first `bunx` note in the README, and the three MCP servers investigation (closed by plan 22's single-flight)."
- Owned elsewhere, never touched here: plan 22's "1.1 push minors" (the 1.1 follow-ups bullet "Push and sessions (plan 10)"); plan 24's "1.2 routing and catalog minors" (every 1.2 follow-up its last bullet lists) and its "Sparse rungs" (the 1.3 follow-up "A sparse rung borrows its nearest stand-in's honesty"); the spec's "Not in 1.5" (the logic and hard bars, Haiku 4.5's terminal value, the synthetic Artificial Analysis fixtures) stays in `ideas.md`.
- Cross-plan rulings: X1 (built on `main` 6f2f8c7; the executor adapts to plans 21–25), X5 (the three-MCP-servers investigation is closed by plan 22's single-flight boot sync; this plan only removes it), X6 (no workflow changes; isolation stays the profile's per-backend toggle), X7 (decisions the spec leaves open are Rulings below, conservative).
- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`).
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`, with `FORCE_COLOR` unset. Tests that could reach the network delete `ANTHROPIC_API_KEY` (in-process) or pass `ANTHROPIC_API_KEY: ""` (spawned); spawned processes get an explicit `env`; no wall-clock sleep decides correctness (the one real-fs watch test waits for quiet windows, as it waited for events before).
- Commits: conventional, subject ≤ 100 characters, lower-case first word after the scope, body lines ≤ 100; check `git log` after each commit (a failed hook leaves the changes uncommitted).
- No changeset (plan 27 writes the one 1.5.0 changeset).

## Review Focus

1. **A dispatch admission would refuse anyway** (the role off, its lane file missing or without `Owns:`, its name or lane already running). Expected: refused with the admission error, no Jev call and no `routes.jsonl` row. Pinned in Task 3, "refuses what admission would refuse before routing: no Jev call, no route row (1.1 follow-ups)".
2. **Two dispatches of one unrouted lane at once.** Expected: Jev is asked once and one route row is written; the second dispatch takes that route and is refused for the running lane, as before. Pinned in Task 3, "routes a lane once when two dispatches of it start together".
3. **The first milestone lands with `skip: "docs-only"` while an earlier commit since `run_start` changed source.** Expected: refused naming that source file (the range starts at the HEAD the run started on); a run from before 1.5 keeps the old range. Pinned in Task 2, "judges the first milestone's skip from the HEAD the run started on, not its last commit only".
4. **A user's `sandbox.toml` with a bare key after catherd's block, and two catherd homes on one machine.** Expected: the key keeps its table, both homes' roots end up in one block, and neither home rewrites it again. Pinned in Task 8, "keeps a bare key after the block in the table it was in, and two catherd homes' roots in one block".
5. **An isolated grok or agy rung the API key's account does not serve.** Expected: `prepare` refuses it against the key's listing (cached apart), while the native login's listing is untouched. Pinned in Task 7, "checks an isolated rung against the key's own listing, cached apart from the login's" (grok and agy).
6. **`init` with this version installed globally but an older `catherd` first on PATH.** Expected: "shadowed" with the PATH fix, and no install. Pinned in Task 6, "says shadowed, installing nothing, when it is current but an older catherd comes first on PATH".

## Rulings

`Ruling: <what> — <why> — <cost if wrong>`

1. Ruling: an open milestone's description is the first plan.md line that opens with its id and a separator (`## M1 — …`, `- **M2:** …`, `3. auth: …`); the id stops at the separator, so `M1.L1 — …` is a lane's — plan.md has no fixed milestone line (role-prompts.ts asks for "Milestones M1…Mn" in free form), and the row lost the description plan 12 dropped (plan 12 final review, Minor 6) — a plan written another way shows no description, as today.
2. Ruling: open milestones come from every lane file `<milestone>.<lane>.md`, the milestone being the part before the first dot, as `protocol.ts` reads it; sorted with numeric collation — the Runs page and the protocol must agree on what a milestone is — none.
3. Ruling: a session's screen starts on the run it was opened for (from the Status tab), else on its first live role, else on its first row; esc still lands on the row it came from — "live roles can sit below the fold" (1.1 follow-ups; plan 12 batch 4 m1) — users who expected the first milestone press `g`.
4. Ruling: where esc lands (`back`) moves from a render-time ref into the TUI state, set by the `session`, `role` and `milestone` actions; `useLiveRead` moves its ref in an effect — the follow-up names the render-time ref write — none.
5. Ruling: a role's screen stops polling once its record exists; `r` reads it again — a record is final — a record rewritten later (none today) shows stale until `r`.
6. Ruling: the `watchDirs` real-fs test waits for three quiet 300 ms windows before counting nested events — a late probe event could pass the test with no nested change; the watch's own timing is the thing under test — about one second more for that test.
7. Ruling: `run_start` records `startHead` (the full HEAD, absent in a repo with no commit) in meta.json; `milestoneFiles` uses it as the first milestone's base when that commit still exists; workspace child runs (`workspace-service.ts`, plan 25's) and runs from before 1.5 keep the commit's own parent — "store the start HEAD in meta.json" (1.1 follow-ups); plan 25 owns workspace-service — a workspace child's first skip still judges its last commit only.
8. Ruling: a headless verdict wrapped in markdown stays no verdict (fails safe); only `E_LAND_GATE`'s fix changes, naming the bare `VERDICT: PASS` and what the reply said — the follow-up asks exactly that — none.
9. Ruling: ownership evidence on a `blocked` climb is "outside (the) lane('s) ownership", "owned by (another|a different|the other) lane" or "owned by <id>.L<n>" — "owned by root" and "owned by another user" are the environment's — an ownership finding worded otherwise ("owned by the worker") is no longer refused without Jev; Jev's `design` answer still refuses it when Jev is on.
10. Ruling: before routing an unrouted lane, `dispatch` refuses the role off (`E_ADMIT_RUNG`), a missing lane file or one with no `Owns:` (`E_LANE_INVALID`), the name already running (`E_ADMIT_DUPLICATE`) and the lane already running (`E_ADMIT_OVERLAP`); admission still checks everything under its lock. The budget is not pre-checked (route already reads the spend and starts cheap) — the cheap refusals are the ones the evidence names — a budget-spent dispatch still routes before `E_RUN_BUDGET`.
11. Ruling: routing on dispatch runs under a per-lane lock (`<run>/route-<lane>.lock`, 120 s, since Jev can take tens of seconds) and re-reads `routes.jsonl` inside it, taking a route another dispatch wrote — "two concurrent dispatches of one lane both route it" — a hung Jev holds a second dispatch of that lane up to 120 s.
12. Ruling: `gate_pass` names its commit `<HEAD>+uncommitted` when an uncommitted change lies under its paths; `gate_check` and the hash are unchanged — the pass did not run on HEAD alone — a script reading `commit` as a bare sha sees the suffix.
13. Ruling: a gate path `./` means the whole repo, as `.` does — the follow-up — none.
14. Ruling: "a staged rename out of a gate's paths is not seen" is already fixed on main: `parsePorcelainZ` reports a rename's source path too; a test now pins it — verified by the new gate-service test (`git mv src/a.ts lib-a.ts` un-carries a `src/` pass) — none.
15. Ruling: doctor's claude-code access row reads the sandbox setting of doctor's own repo and every bound repo (`projects.json`), naming the ones where it is on; when any is on, the row is the note (no probe), as it was for doctor's own directory — "not each bound repo" — a machine with the sandbox on in one repo only gets no unsandboxed probe row.
16. Ruling: `profile show` sizes the access column to its longest entry (at least 27, as before) — "(no network)" made one row longer than the pad — none.
17. Ruling: `network: false` on a read-only or full role is a validation warning with the fix `catherd profile set roles.<role>.network null`, never an error — the grants it takes exist only for workspace-write (codexGrants, claudeAccessArgs) — none.
18. Ruling: a downgrade's suggested stand-in comes only from backends the profile already names in a ladder or a failover entry, a native `claude:` rung naming `claude-code` too (the same CLI) — 1.3 follow-ups ("limit the pool to backends the profile already names") — a better stand-in on a backend the profile never names is not suggested.
19. Ruling: an unscored failover stand-in gets its "unscored" warning and no "downgrade" warning — plan 12 batch 1 m1 — none.
20. Ruling: every doctor test that runs doctor more than once gets 30 s (nine tests; the follow-up counted three) — the same load times them all out — none.
21. Ruling: the "one full run in five failed once with no name" and "heavy load times out git- and notifier-based tests at 5 s" half of the Tests bullet is closed without code: there is no name to act on, and CLAUDE.md's rule (rerun only a known load flake's file) stands — a recurrence gets recorded with its name.
22. Ruling: `bun add -g` in `init` is killed after 120 s (`installLimits.timeoutMs`) and reported failed with the retry command; its output is not awaited after the kill — plan 12 final review, Minor 2 — a registry slower than two minutes fails an install that would have finished.
23. Ruling: `init` says "shadowed" (no install) when the global catherd is current but the catherd PATH finds first is another version or none — the launcher (`plugin/bin/catherd-mcp`) runs the one PATH finds, else bunx — a user with no catherd on PATH sees the warning on every `init`, which is true.
24. Ruling: the spawned init test gets `BUN_INSTALL` in a scratch folder and `BUN_CONFIG_REGISTRY=http://127.0.0.1:9`; `bun pm bin -g` fails there (no package.json) so `BUN_INSTALL_BIN` still decides — plan 12 final review, Minor 3 — none.
25. Ruling: Cursor's `listModels` asks an `agent` (the fallback name) for `--version` first and lists nothing unless it prints Cursor's date-hash version — 1.3 follow-ups, first fix — one extra call when only `agent` is on PATH.
26. Ruling: an isolated grok or agy rung is checked against the listing made under catherd's isolated home (where only the API key signs in), cached as `grok-isolated` / `antigravity-isolated` in `<data>/discovery/`; the catalog's `listed` models (routing, `profile show`) stay the native listing — 1.3 follow-ups (Codex P2s, PRs #31 and #32) — routing may still rank a rung the key's account lacks; `prepare` refuses it before anything runs.
27. Ruling: doctor's `sandbox:grok` check runs with `grokHomeEnv(<scratch root>)` (a scratch HOME and GROK_HOME, memory and the ten compat toggles off) and an empty `XAI_API_KEY` — plan 16 final review, Minor 2 — none.
28. Ruling: catherd rewrites its `sandbox.toml` block where it stands (appends only a first one), and keeps the block's existing roots that still exist on disk, in order, then appends its own — a bare key after the block keeps its table; two catherd homes converge on one block instead of rewriting each other's — a worker of one catherd home may write the other home's lock dir.
29. Ruling: a `sandbox.toml` link catherd cannot follow, read or write is `E_CONFIG_INVALID` with the isolate fix, naming the errno — plan 16 re-review — none.
30. Ruling: grok's `sessionFor` hashes the dispatch id (the dispatch dir's last part) — plan 16 re-review — a grok run in flight across the upgrade finalizes with another session id, so that one thread cannot be resumed.
31. Ruling: agy's 10-minute readiness window is documented (README) rather than re-probed per dispatch — ideas.md offers both; the probe costs ~10 s a dispatch — a sign-out inside the window still reaches a native `-p`.
32. Ruling: the silent first `bunx` stays; TypeScript comes from `bun-ffi-structs` (a dependency of `@opentui/core`) declaring it a non-optional peer, which Bun installs, so catherd cannot drop it; the README says so and suggests `bun add -g catherd-cli` first; "installing catherd…" already prints before `init`'s own resolve — the spec's "the `init` silent first `bunx` note in the README" — none.
33. Ruling: the bunx live check ("does `bunx catherd-cli@latest init` see bunx's own `.bin` on PATH") moves to `docs/dev/live-verification.md` §15 with a blackholed-registry check for Ruling 22 (X8: a live behaviour gets a live-verification step) — the code already reads bun's global bin, never PATH, for the installed version — none.
34. Ruling: the whole "From the 1.0.0 fresh install" section leaves `ideas.md`: each entry is fixed on main (see the coverage table) or by Task 9 — the spec's "the 1.0 fresh-install polish still open" — none.
35. Ruling: the 1.2 note "piped `init` reads a new line order" is already in the 1.2 CHANGELOG entry and MIGRATION.md ("Piped `init` now reads four lines …"); "the text `catalog list` format changed" gets its MIGRATION line in Task 9 — both are docs promises — none.
36. Ruling: the sections the spec gives no plan here ("Fix bundle", "Top priority", "From the 1.0.0 headless test", "From the 1.0.0 platform run") are not touched, though some of their lines point at the removed fresh-install section — outside plan 26's section; plan 27 leaves `ideas.md` holding only "Not in 1.5" — plan 27 must sweep them.

Owner questions: none.

## Coverage: `ideas.md` entry → task

| `ideas.md` entry (section) | Where |
| --- | --- |
| 1.1 · Push and sessions (plan 10): `watch()` ownership, Codex activity once, `edit` with no paths, Claude tool's first argument | owned by plan 22 ("The 1.1 push minors") |
| 1.1 · Runs page: a ref written during render | Task 1 |
| 1.1 · Runs page: the role screen keeps polling a finished role | Task 1 |
| 1.1 · Runs page: a recent run from Status lands on the session's first role | Task 1 |
| 1.1 · Runs page: a session opens on its first milestone, live roles below the fold | Task 1 |
| 1.1 · Runs page: `milestoneAt` rebuilds its list on every key | Task 1 |
| 1.1 · Runs page: a milestone whose id is not `M<n>` gets a row only once landed | Task 1 |
| 1.1 · Runs page: the `watchDirs` real-fs test can pass on a late probe event | Task 1 |
| 1.1 · Runs page: doctor's `failed` push row tested only with a hand-made outcome | Task 4 |
| 1.1 · Protocol and gate: `laneDone` reads the records file once per lane | Task 2 |
| 1.1 · Protocol and gate: `peek.ts` shadows `r` and reads the notes twice | Task 2 |
| 1.1 · Protocol and gate: `**VERDICT: PASS**` in markdown: say so in the `E_LAND_GATE` fix | Task 2 |
| 1.1 · Protocol and gate: the first milestone's commit range (store the start HEAD) | Task 2 |
| 1.1 · Protocol and gate: `dispatch` routes before admission can refuse | Task 3 |
| 1.1 · Protocol and gate: two concurrent dispatches of one lane both route it | Task 3 |
| 1.1 · Protocol and gate: the ownership regex catches environment errors | Task 2 |
| 1.1 · Protocol and gate: `gate_pass` names HEAD for a pass on an uncommitted tree | Task 3 |
| 1.1 · Protocol and gate: a staged rename out of a gate's paths is not seen | already fixed on main (Ruling 14), pinned by Task 3's test |
| 1.1 · Protocol and gate: `./` refused where `.` is meant | Task 3 |
| 1.1 · Access and doctor: the claude-code access row reads doctor's directory only | Task 4 |
| 1.1 · Access and doctor: `profile show` pads the "(no network)" row wrong | Task 4 |
| 1.1 · Access and doctor: nothing warns about `network: false` on a read-only or full role | Task 5 |
| 1.1 · Access and doctor: live check, `bunx … init` and bunx's own `.bin` on PATH | Task 9 (live-verification §15, Ruling 33) |
| 1.1 · Failover and validation: an unscored stand-in gets "unscored" and "downgrade" | Task 5 |
| 1.1 · Failover and validation: `ladderDropDims` has no direct unit test | Task 5 |
| 1.1 · Failover and validation: `rankStandIns` recomputes the bar check per pool member | Task 5 |
| 1.1 · Docs: live-verification §9.2 misses a headless verifier's minutes | Task 9 |
| 1.1 · Docs: the "back to published" block reuses `$version` | already fixed on main: §9 re-derives it ("read again: this may be a new shell"), verified by reading `docs/dev/live-verification.md` |
| 1.1 · Install: `bun add -g` in `init` has no time limit | Task 6 |
| 1.1 · Install: the spawned init test passes `BUN_INSTALL` through | Task 6 |
| 1.1 · Install: no "shadowed" when the global install is current but an older `catherd` comes first | Task 6 |
| 1.1 · Install: an open milestone row lost its description | Task 1 |
| 1.1 · Install: §9 check 5 should say "at least three" worker folders | Task 9 |
| 1.1 · Tests: three doctor tests near the 5 s default | Task 4 (every multi-run doctor test, Ruling 20) |
| 1.1 · Tests: an unnamed failure, git- and notifier-based tests at 5 s under load | closed without code (Ruling 21) |
| 1.2 · doctor's handshake boot sync, fetchers on empty, `writeDerived`, `catalog_sync` busy, `testAaKey` retries, rate-limit timestamp, per-field direction, `saveCredential` lock, "your override", inferred-from marks, `route` evidence guarded, TUI save preview, silent `defaultRung`, `speedLadder` ui, ruling 7, ATTRIBUTION, `catalog-refresh.yml`, `valueWords`, `adjacent`, `catalog list` "like X", `treat-like --clear` partial gap | owned by plan 24 ("The 1.2 routing and catalog minors") |
| 1.2 · Piped `init` reads a new line order | already fixed on main: CHANGELOG 1.2 entry and MIGRATION.md ("Piped `init` now reads four lines"), verified by grep; removed in Task 10 |
| 1.2 · The text `catalog list` format changed in 1.2 | Task 9 (MIGRATION line) |
| 1.2 · The logic and hard bars sit above every Sol rung | Not in 1.5 (spec); stays |
| 1.2 · Haiku 4.5's terminal value returns | Not in 1.5 (spec); stays |
| 1.2 · The Artificial Analysis fixtures are synthetic | Not in 1.5 (spec); stays |
| 1.3 · Discovery runs a non-Cursor `agent` | Task 7 |
| 1.3 · Downgrade fixes can suggest a Cursor stand-in | Task 5 |
| 1.3 · Isolated grok discovery lists under the native identity | Task 7 |
| 1.3 · Doctor ignores implicit paired stand-ins | already fixed on main: `usedBackends` goes through `standInFor`, which falls back to `PAIRED_FAILOVER` (plan 17); pinned by Task 5's new `doctor-backends.test.ts` |
| 1.3 · Doctor's `sandbox:grok` keeps the real HOME and the compat features on | Task 7 |
| 1.3 · sandbox.toml: bare keys after the block; two catherd homes | Task 8 |
| 1.3 · sandbox.toml link catherd cannot follow or write; `sessionFor` hashes the full path | Task 8 |
| 1.3 · Isolated agy lists models as the native account | Task 7 |
| 1.3 · agy's 10-minute readiness cache | Task 9 (README, Ruling 31) |
| 1.3 · A sparse rung borrows its nearest stand-in's honesty | owned by plan 24 ("Sparse rungs"); stays |
| 1.0.0 fresh install · Plugin install fails without GitHub SSH | already fixed on main: `.claude-plugin/marketplace.json` `url` is `https://github.com/47vigen/catherd.git` |
| 1.0.0 fresh install · `doctor`'s sandbox probe is dead on current Codex | already fixed on main: `codexAdapter.accessShell` tries `codex sandbox -c … --` first, then the old form (`src/adapters/codex/index.ts`) |
| 1.0.0 fresh install · the worker sandbox cannot run checks | already fixed on main (1.1): `codexGrants` (network, lock and temp dirs, toolchain caches) and doctor's five probes |
| 1.0.0 fresh install · Failover downgrades high rungs | already fixed on main (1.1): `rankStandIns` refuses a downgrade; validate warns "downgrade:" |
| 1.0.0 fresh install · Warnings on the defaults | already fixed on main (1.1 §13): doctor shows the shipped defaults' access rows as info (`src/services/doctor.ts`) |
| 1.0.0 fresh install · Silent first `bunx` | Task 9 (README, Ruling 32); "installing catherd…" already on main |
| 1.0.0 fresh install · TUI first frame | already fixed on main: the Status tab shows "…" until the first read (`src/entry/tui/views/status.tsx`) |
| Investigate: three MCP servers for one Codex session | closed by plan 22 (X5); removed in Task 10 |

## Risks for the executor (plans 21–25 merge first)

Re-find every hunk by its context. The files most likely to have moved:

- `src/services/dispatch-service.ts` (Task 3): plan 21 (`CATHERD_ROLE`, deliveries), plan 22 (thread check, `thread: "latest"`, resume kill) and plan 24 (**`dispatch` with `lane` takes `rung` optionally**: the routing block Task 3 wraps in a lock is the one plan 24 changes; keep plan 24's optional-rung logic inside the locked block).
- `src/services/admission.ts` (Task 3 only exports `laneOwns`): plans 21 (isolated refusal removed), 23 and 25 (`After:` header).
- `src/services/gate-service.ts` (Task 3): plan 23 rewrites `contentHash` (tracked content from `git ls-files -s`). Re-apply Task 3 on top: `contentHash` returns `{ hash, dirty }` where `dirty` says an uncommitted change lies under the paths, `gatePass` names `<HEAD>+uncommitted`, `cleanPaths` takes `./`. Re-run the new test; the staged-rename half must still pass under plan 23's hashing.
- `src/services/protocol.ts`, `peek.ts`, `reentry.ts` (Task 2): plan 22 (`state.md` Next, `actionable: false`) and plan 25 (`After:` lanes in `protocol.next`). Keep `laneEvidence` read once whatever plan 25 adds.
- `src/services/lane-service.ts`, `milestones.ts`, `run-store.ts` (Task 2): plan 23 (the review step, `BLOCKED: environment`), plan 25 (exact verifier names, parked minutes, pinned profile and `from:` in meta.json). `startHead` is one more optional meta field.
- `src/services/doctor.ts`, `doctor-access.ts` (Task 4): plans 21 (role-MCP row), 22 (`--test-push --thread`) and 23 (Docker, caches).
- `src/domain/profile-rules.ts`, `src/domain/failover.ts` (Task 5): plan 24 (rungs that can never start, unreachable kinds, sparse stand-ins).
- `src/entry/tui/views/runs.tsx`, `status.tsx` (Task 1): plan 22 (the TUI memo, one `stalled` computation).

---

### Task 1: The Runs page minors (1.1 follow-ups: Runs page; Install: the open milestone row)

The back row moves into the TUI state (Ruling 4); a session opened for a run starts on that run, else on its first live role (Ruling 3); the Status tab passes the run; open milestones of any id get a row with plan.md's description (Rulings 1, 2); a finished role's screen stops polling (Ruling 5); rows are looked up from one memoized map; the `watchDirs` real-fs test waits out late probe events (Ruling 6).

**Files:**
- Modify: `src/entry/tui/state.ts`
- Modify: `src/entry/tui/views/runs.tsx`
- Modify: `src/entry/tui/views/status.tsx`
- Modify: `src/services/runs-page.ts`
- Modify: `test/entry/tui/effects.test.ts`
- Modify: `test/entry/tui/runs.test.tsx`
- Modify: `test/entry/tui/state.test.ts`
- Modify: `test/services/runs-page.test.ts`

**Interfaces:**
- Produces: `AppState.back: { session; role; milestone } | null`; `AppState.session.run?: string`; the `session` action's optional `run`; `Milestone.what` filled for open milestones. Consumes: nothing new.

**Commit:** `fix(tui): the runs page minors: start rows, open milestones, finished roles, no render-time refs` (scratch `2a99cd9`)

- [ ] **Step 1: Write the failing tests**

Apply this diff (re-find each hunk by its context; line numbers may have moved):

````diff
diff --git a/test/entry/tui/effects.test.ts b/test/entry/tui/effects.test.ts
index 13a0ced..1f240a3 100644
--- a/test/entry/tui/effects.test.ts
+++ b/test/entry/tui/effects.test.ts
@@ -105,6 +105,13 @@ describe("the live effects", () => {
         writeFileSync(probe, String(i));
         await waitFor(() => calls > 0, 500).catch(() => null);
       }
+      // a probe write the watch reports late would pass the check below with no nested change: wait until
+      // the probe's events stop (no call for one burst window, three times over) before counting from zero
+      for (let quiet = 0, seen = calls; quiet < 3;) {
+        await waitFor(() => calls !== seen, 300).catch(() => null);
+        if (calls === seen) quiet++;
+        else [quiet, seen] = [0, calls];
+      }
       calls = 0;
       // only changes below the run folder, in a folder made after the watch started
       const nested = join(run.dir, "roles", "w", "2");
diff --git a/test/entry/tui/runs.test.tsx b/test/entry/tui/runs.test.tsx
index 6e161ea..d652a64 100644
--- a/test/entry/tui/runs.test.tsx
+++ b/test/entry/tui/runs.test.tsx
@@ -181,7 +181,7 @@ describe("the Runs tab (spec §4)", () => {
 
   it("cancels a live role only on a second ctrl+d within 5 s", async () => {
     const fx = await runs();
-    await h!.s.press("return");
+    await h!.s.press("return", "g");
     // a milestone row has nothing to cancel
     await h!.s.press("ctrl+d", "ctrl+d");
     expect(h!.s.frame()).not.toContain("press ctrl+d again to cancel");
@@ -253,12 +253,79 @@ describe("the Runs tab (spec §4)", () => {
     expect(h!.s.frame()).toContain("worker-M1.L1 worker · gpt-6-luna#high · ok · Jobs screen");
     await h!.s.press("escape", "return");
     expect(h!.s.frame()).toContain("worker-M1.L1 worker · gpt-6-luna#high · ok · Jobs screen");
-    // another session starts on its first row (its first milestone), not on a role the last one had open
+    // another session starts on its start row (its first live role), not on a role the last one had open
     await h!.s.press("escape", "escape", "j", "j", "return", "escape", "k", "k", "return", "return");
-    expect(h!.s.frame()).toContain("M0 scaffold the jobs screen · landed · Jobs screen");
+    expect(h!.s.frame()).toContain("worker-M1.L2 worker · gpt-6-sol#medium · running · Jobs screen");
     expect(h!.s.frame()).not.toContain("worker-M1.L1 worker");
   });
 
+  it("opens a session on its first live role, below its milestones (1.1 follow-ups)", async () => {
+    await runs();
+    await h!.s.press("return");
+    expect(selectedLine(h!)).toContain("worker-M1.L2");
+    // a session with no live role starts on its first row
+    await h!.s.press("escape", "j", "return");
+    expect(selectedLine(h!)).toContain("M1");
+  });
+
+  it("opens a session for one of its runs on that run's first row (a recent run from Status)", async () => {
+    await runs();
+    const key = sessionKey({ host: "claude-code", sessionId: "s-auth" });
+    await h!.run(() => h!.app().dispatch({ type: "session", key, run: "20260924-080000-auth-plan-4" }));
+    await h!.advance(0);
+    // the session's second run: its first milestone, not the first run's first row
+    expect(selectedLine(h!)).toContain("M1");
+    await h!.s.press("return");
+    expect(h!.s.frame()).toContain("Auth plan 4");
+    expect(h!.s.frame()).not.toContain("Auth refactor");
+  });
+
+  it("shows an open milestone's description from the plan beside not landed (1.1 follow-ups)", async () => {
+    const fx = fixtureEffects();
+    const read = fx.session;
+    fx.session = (key) => {
+      const d = read(key);
+      return {
+        ...d,
+        runs: d.runs.map((r) => ({
+          ...r,
+          milestones: r.milestones.map((m) => (m.landed ? m : { ...m, what: "the jobs list" })),
+        })),
+      };
+    };
+    await runs(fx);
+    await h!.s.press("return");
+    expect(h!.s.frame()).toContain("◌ M1  not landed · the jobs list");
+  });
+
+  it("stops reading a finished role's screen, and reads it again on r (1.1 follow-ups)", async () => {
+    const fx = fixtureEffects();
+    let roleReads = 0;
+    const role = fx.role;
+    fx.role = (run, id) => {
+      roleReads++;
+      return role(run, id);
+    };
+    await runs(fx);
+    await h!.s.press("return");
+    await select(h!, "worker-M1.L1");
+    await h!.s.press("return");
+    await h!.advance(0);
+    const r0 = roleReads;
+    await h!.advance(RUN_EVERY_MS * 5);
+    expect(roleReads).toBe(r0);
+    await h!.s.press("r");
+    expect(roleReads).toBe(r0 + 1);
+    // a live role keeps being read
+    await h!.s.press("escape", "g");
+    await select(h!, "worker-M1.L2");
+    await h!.s.press("return");
+    await h!.advance(0);
+    const l0 = roleReads;
+    await h!.advance(RUN_EVERY_MS * 3);
+    expect(roleReads).toBe(l0 + 3);
+  });
+
   it("reads an opened session once, and again on r; pausing reads nothing", async () => {
     const fx = fixtureEffects();
     let reads = 0;
@@ -287,8 +354,8 @@ describe("the Runs tab (spec §4)", () => {
       milestoneReads++;
       return milestone(run, name);
     };
-    // the session opens on its first milestone: r there reads the milestone
-    await h!.s.press("p", "return");
+    // on the session's first milestone, r reads the milestone
+    await h!.s.press("p", "g", "return");
     const m0 = milestoneReads;
     await h!.s.press("r");
     expect(milestoneReads).toBe(m0 + 1);
@@ -308,7 +375,7 @@ describe("the Runs tab (spec §4)", () => {
 
   it("opens a milestone on its digest; esc goes back to its row, then to the list", async () => {
     await runs();
-    await h!.s.press("return", "j", "k");
+    await h!.s.press("return", "g", "j", "k");
     expect(selectedLine(h!)).toContain("✓ M0  scaffold the jobs screen");
     await h!.s.press("return");
     const f = h!.s.frame();
@@ -325,7 +392,7 @@ describe("the Runs tab (spec §4)", () => {
 
   it("says no digest yet for a milestone that has not landed", async () => {
     await runs();
-    await h!.s.press("return");
+    await h!.s.press("return", "g");
     await select(h!, "M1  not landed");
     await h!.s.press("return");
     const f = h!.s.frame();
diff --git a/test/entry/tui/state.test.ts b/test/entry/tui/state.test.ts
index 34ae311..e29b5dd 100644
--- a/test/entry/tui/state.test.ts
+++ b/test/entry/tui/state.test.ts
@@ -265,6 +265,28 @@ describe("dialogs and armed keys", () => {
     expect(run(s, { type: "session", key: "s2" }).milestone).toBeNull();
     expect(initialState("runs", "claude-code").milestone).toBeNull();
   });
+
+  it("keeps where esc lands in the state: the session, and the last role or milestone opened in it", () => {
+    const s = run(
+      initialState("runs", "claude-code"),
+      { type: "session", key: "s1" },
+      { type: "role", run: "r1", dispatchId: "d1" },
+      { type: "up" },
+      { type: "milestone", run: "r1", name: "M0" },
+      { type: "up" },
+      { type: "up" },
+    );
+    expect(s.back).toEqual({ session: "s1", role: null, milestone: { run: "r1", name: "M0" } });
+    // the same session again keeps that row; another one, or one opened for a run, starts afresh
+    expect(run(s, { type: "session", key: "s1" }).back?.milestone).toEqual({ run: "r1", name: "M0" });
+    expect(run(s, { type: "session", key: "s2" }).back).toEqual({
+      session: "s2",
+      role: null,
+      milestone: null,
+    });
+    const forRun = run(s, { type: "session", key: "s1", run: "r2" });
+    expect([forRun.session, forRun.back?.milestone]).toEqual([{ key: "s1", run: "r2" }, null]);
+  });
 });
 
 it("tui_host_preview_save counts draft changes under one pinned host with no unknown fallback", () => {
diff --git a/test/services/runs-page.test.ts b/test/services/runs-page.test.ts
index bf2d081..168c8e8 100644
--- a/test/services/runs-page.test.ts
+++ b/test/services/runs-page.test.ts
@@ -207,6 +207,32 @@ describe("the runs page (spec §4)", () => {
     expect(() => milestoneDetail(jobs.id, "a..b")).toThrow(/no milestone "a\.\.b"/);
   });
 
+  it("lists an open milestone whatever its id, with plan.md's line for it (1.1 follow-ups)", async () => {
+    const { jobs } = await twoRuns();
+    writeLane(jobs, "auth.L1", ["src/auth.ts"]);
+    writeLane(jobs, "M10.L1", ["src/ten.ts"]);
+    writeFileSync(
+      runPaths(jobs.dir).plan,
+      [
+        "# Plan",
+        "2. Milestones M1…Mn: each one is shippable",
+        "## M1 — the jobs list",
+        "M1.L1 — the list component",
+        "- **M2:** export to CSV",
+        "### auth: sign-in flow",
+      ].join("\n"),
+    );
+    const s = sessionDetail(fakeDeps(), sessionKey({ host: "claude-code", sessionId: "s-auth" }));
+    expect(s.runs[0]?.milestones).toEqual([
+      { name: "M0", landed: true, what: "scaffold the jobs screen" },
+      { name: "auth", landed: false, what: "sign-in flow" },
+      { name: "M1", landed: false, what: "the jobs list" },
+      { name: "M2", landed: false, what: "export to CSV" },
+      { name: "M10", landed: false, what: "" },
+    ]);
+    expect(milestoneDetail(jobs.id, "auth")).toMatchObject({ landed: false, what: "sign-in flow" });
+  });
+
   it("puts 1.0 runs under earlier runs, last", async () => {
     await twoRuns();
     const repo = tempRepo();
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/entry/tui/ test/services/runs-page.test.ts`
Expected: the new runs-page test (an `auth` milestone and plan.md descriptions), the new Runs-tab tests (start on the first live role, open for a run, `not landed · <what>`, a finished role read once) and the state test (`back`) fail; the four older Runs-tab tests that assumed the first milestone now press `g` first.

- [ ] **Step 3: Implement**

````diff
diff --git a/src/entry/tui/state.ts b/src/entry/tui/state.ts
index 99507bb..7916807 100644
--- a/src/entry/tui/state.ts
+++ b/src/entry/tui/state.ts
@@ -127,12 +127,21 @@ export interface AppState {
   drafts: Record<string, Draft>;
   /** the open dialogs; only the top one is drawn and takes keys */
   dialogs: Dialog[];
-  /** spec §4: the session the Runs tab has open (`key` null: "earlier runs"); null shows the sessions */
-  session: { key: string | null } | null;
+  /**
+   * spec §4: the session the Runs tab has open (`key` null: "earlier runs"); null shows the sessions. `run`: the
+   * run it was opened for (a recent run on the Status tab), whose first row the cursor starts on
+   */
+  session: { key: string | null; run?: string } | null;
   /** the role the open session shows, by its dispatch */
   role: { run: string; dispatchId: string } | null;
   /** spec 1.1 §10: the milestone the open session shows, its digest */
   milestone: { run: string; name: string } | null;
+  /** where esc lands: the last session opened, and the last role or milestone opened in it */
+  back: {
+    session: string | null;
+    role: { run: string; dispatchId: string } | null;
+    milestone: { run: string; name: string } | null;
+  } | null;
   paused: boolean;
   armed: Armed | null;
 }
@@ -156,8 +165,8 @@ export type Action =
   | { type: "saving"; name: string; on: boolean }
   | { type: "input"; value: string }
   | { type: "invalid"; error: string | null }
-  /** opens a session of the Runs tab (`key` null: "earlier runs") */
-  | { type: "session"; key: string | null }
+  /** opens a session of the Runs tab (`key` null: "earlier runs"), on `run`'s first row when given */
+  | { type: "session"; key: string | null; run?: string }
   /** opens one role of the open session */
   | { type: "role"; run: string; dispatchId: string }
   /** opens one milestone of the open session, on its digest */
@@ -177,6 +186,7 @@ export const initialState = (tab: Tab = "status", host: OrchestrationHost = "unk
   session: null,
   role: null,
   milestone: null,
+  back: null,
   paused: false,
   armed: null,
 });
@@ -354,12 +364,29 @@ export function reduce(s: AppState, a: Action): AppState {
       else if (top.kind === "save" && a.type === "invalid") next = { ...top, error: a.error };
       return next === top ? s : { ...s, dialogs: [...s.dialogs.slice(0, -1), next] };
     }
-    case "session":
-      return { ...s, session: { key: a.key }, role: null, milestone: null, armed: null };
-    case "role":
-      return { ...s, role: { run: a.run, dispatchId: a.dispatchId }, milestone: null, armed: null };
-    case "milestone":
-      return { ...s, milestone: { run: a.run, name: a.name }, role: null, armed: null };
+    case "session": {
+      // a run asked for starts the cursor on that run; reopening the same session keeps the row esc lands on
+      const back =
+        !a.run && s.back?.session === a.key ? s.back : { session: a.key, role: null, milestone: null };
+      return {
+        ...s,
+        session: { key: a.key, ...(a.run ? { run: a.run } : {}) },
+        role: null,
+        milestone: null,
+        back,
+        armed: null,
+      };
+    }
+    case "role": {
+      const role = { run: a.run, dispatchId: a.dispatchId };
+      const back = { session: s.session?.key ?? null, role, milestone: null };
+      return { ...s, role, milestone: null, back, armed: null };
+    }
+    case "milestone": {
+      const milestone = { run: a.run, name: a.name };
+      const back = { session: s.session?.key ?? null, role: null, milestone };
+      return { ...s, milestone, role: null, back, armed: null };
+    }
     case "up":
       if (s.milestone) return { ...s, milestone: null, armed: null };
       return s.role ? { ...s, role: null, armed: null } : { ...s, session: null, armed: null };
diff --git a/src/entry/tui/views/runs.tsx b/src/entry/tui/views/runs.tsx
index 952be75..89eb3b2 100644
--- a/src/entry/tui/views/runs.tsx
+++ b/src/entry/tui/views/runs.tsx
@@ -1,4 +1,4 @@
-import { type MutableRefObject, useEffect, useRef, useState } from "react";
+import { type MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
 import { useApp, useBack, useNow } from "../providers/app.tsx";
 import { useData, usePoll } from "../providers/data.tsx";
 import { useCommandLayer } from "../providers/keymap.tsx";
@@ -7,7 +7,7 @@ import { useUi } from "../providers/theme.tsx";
 import { isArmed } from "../state.ts";
 import { ago, clock, plural, shortRung, wrap, wrapHanging } from "../text.ts";
 import { glyph, mascot, type Token } from "../theme.ts";
-import type { RoleRow, SessionRow, SessionRun } from "../effects.ts";
+import type { RoleRow, SessionDetail, SessionRow, SessionRun } from "../effects.ts";
 import { Line, type Part } from "../widgets/line.tsx";
 import { List, type ListItem, useSelected } from "../widgets/list.tsx";
 
@@ -185,8 +185,11 @@ function useLiveRead<T extends { dirs: string[] }>(read: () => T, key: string) {
   const app = useApp();
   const [watching, setWatching] = useState(false);
   const polled = usePoll(read, watching ? WATCHED_EVERY_MS : RUN_EVERY_MS, { paused: app.state.paused, key });
+  // the watch calls the latest refresh; the ref moves after each commit, never during a render
   const refresh = useRef(polled.refresh);
-  refresh.current = polled.refresh;
+  useEffect(() => {
+    refresh.current = polled.refresh;
+  });
   const dirs = polled.value?.dirs.join("\n") ?? "";
   useEffect(() => {
     if (app.state.paused || dirs === "") {
@@ -200,8 +203,26 @@ function useLiveRead<T extends { dirs: string[] }>(read: () => T, key: string) {
   return { ...polled, watching };
 }
 
+/**
+ * The row a session's screen starts on before the cursor moves: the first row of the run it was opened for,
+ * else its first live role (live roles can sit below many landed milestones), else its first row.
+ */
+function startRow(d: SessionDetail, run: string | undefined): string | null {
+  const rows = (r: SessionDetail["runs"][number]) => [
+    ...r.milestones.map((m) => milestoneKey(r.id, m.name)),
+    ...r.roles.map((x) => roleKey(x.run, x.dispatchId)),
+  ];
+  const asked = run === undefined ? undefined : d.runs.find((r) => r.id === run);
+  const first = asked ? rows(asked)[0] : undefined;
+  if (first) return first;
+  const live = d.runs.flatMap((r) => r.roles).find((x) => x.live);
+  if (live) return roleKey(live.run, live.dispatchId);
+  return d.runs.flatMap(rows)[0] ?? null;
+}
+
 function SessionView(props: {
   sessionKey: string | null;
+  run: string | undefined;
   width: number;
   height: number;
   initial: string | null;
@@ -210,17 +231,26 @@ function SessionView(props: {
   const app = useApp();
   const ui = useUi();
   const now = useNow(1_000);
-  const [selected, setSelected, selectedNow] = useSelection(props.initial);
+  const [chosen, setSelected, chosenNow] = useSelection(props.initial);
   const polled = useLiveRead(() => app.effects.session(props.sessionKey), String(props.sessionKey));
   useRefresher(props.refresher, polled.refresh);
   useBack(true, "view", () => app.dispatch({ type: "up" }));
   const d = polled.value;
-  const roleAt = (key: string | null) =>
-    d?.runs.flatMap((r) => r.roles).find((x) => key === roleKey(x.run, x.dispatchId)) ?? null;
-  const milestoneAt = (key: string | null) =>
-    d?.runs
-      .flatMap((r) => r.milestones.map((m) => ({ run: r.id, name: m.name })))
-      .find((x) => key === milestoneKey(x.run, x.name)) ?? null;
+  // each row's role or milestone by its key, built once per read rather than on every key
+  const byKey = useMemo(() => {
+    const roles = new Map<string, RoleRow>();
+    const milestones = new Map<string, { run: string; name: string }>();
+    for (const r of d?.runs ?? []) {
+      for (const m of r.milestones) milestones.set(milestoneKey(r.id, m.name), { run: r.id, name: m.name });
+      for (const x of r.roles) roles.set(roleKey(x.run, x.dispatchId), x);
+    }
+    return { roles, milestones, start: d ? startRow(d, props.run) : null };
+  }, [d, props.run]);
+  // until the cursor moves, it stands on the start row
+  const selected = chosen ?? byKey.start;
+  const selectedNow = () => chosenNow() ?? byKey.start;
+  const roleAt = (key: string | null) => (key === null ? null : (byKey.roles.get(key) ?? null));
+  const milestoneAt = (key: string | null) => (key === null ? null : (byKey.milestones.get(key) ?? null));
   useCommandLayer("row.runs", {
     "runs.open": () => {
       const k = selectedNow();
@@ -279,7 +309,7 @@ function SessionView(props: {
                 : { text: `${glyph("waiting", ui.plain)} ${m.name}`, tone: "muted" },
               m.landed
                 ? { text: m.what ? `  ${m.what}` : "", tone: "muted" }
-                : { text: "  not landed", tone: "muted" },
+                : { text: `  not landed${m.what ? ` · ${m.what}` : ""}`, tone: "muted" },
             ]}
           />
         ),
@@ -353,10 +383,17 @@ function RoleView(props: {
   const app = useApp();
   const ui = useUi();
   const [selected, setSelected] = useSelection();
+  // a role with its record is finished for good: nothing on its screen changes, so it is read no more
+  // (r still reads it again)
+  const [done, setDone] = useState(false);
   const polled = usePoll(() => app.effects.role(props.run, props.dispatchId), RUN_EVERY_MS, {
-    paused: app.state.paused,
+    paused: app.state.paused || done,
     key: `${props.run}/${props.dispatchId}`,
   });
+  const recorded = polled.value?.record != null;
+  useEffect(() => {
+    if (recorded) setDone(true);
+  }, [recorded]);
   useRefresher(props.refresher, polled.refresh);
   useBack(true, "view", () => app.dispatch({ type: "up" }));
   const d = polled.value;
@@ -536,13 +573,16 @@ export function RunsView(props: { width: number; height: number }) {
       app.toast({ variant: "info", message: app.getState().paused ? "Updates paused" : "Updates resumed" });
     },
   });
-  const { milestone, role, session } = app.state;
+  const { milestone, role, session, back } = app.state;
   // esc lands on the row it came from: the last session opened, and the last milestone or role opened in it
-  const back = useRef<{ session: string | null; row: string | null }>({ session: null, row: null });
-  if (session && back.current.session !== keyOf(session.key))
-    back.current = { session: keyOf(session.key), row: null };
-  if (milestone) back.current.row = milestoneKey(milestone.run, milestone.name);
-  if (role) back.current.row = roleKey(role.run, role.dispatchId);
+  const backRow =
+    back && session && back.session === session.key
+      ? back.milestone
+        ? milestoneKey(back.milestone.run, back.milestone.name)
+        : back.role
+          ? roleKey(back.role.run, back.role.dispatchId)
+          : null
+      : null;
   if (milestone)
     return (
       <MilestoneView
@@ -567,11 +607,14 @@ export function RunsView(props: { width: number; height: number }) {
     return (
       <SessionView
         sessionKey={session.key}
+        run={session.run}
         width={props.width}
         height={props.height}
-        initial={back.current.row}
+        initial={backRow}
         refresher={refresher}
       />
     );
-  return <SessionList width={props.width} height={props.height} initial={back.current.session} />;
+  return (
+    <SessionList width={props.width} height={props.height} initial={back ? keyOf(back.session) : null} />
+  );
 }
diff --git a/src/entry/tui/views/status.tsx b/src/entry/tui/views/status.tsx
index c4395be..63b07a4 100644
--- a/src/entry/tui/views/status.tsx
+++ b/src/entry/tui/views/status.tsx
@@ -194,10 +194,11 @@ export function StatusView(props: { width: number; height: number }) {
       if (name !== null) {
         showProfile(app, name);
       } else if (selected?.startsWith("run:")) {
-        // spec §4: a run opens in its session's screen, which shows it with the session's other runs
+        // spec §4: a run opens in its session's screen, which shows it with the session's other runs; the
+        // cursor starts on that run
         const row = runs.find((r) => `run:${r.id}` === selected);
         app.dispatch({ type: "tab", tab: "runs" });
-        if (row) app.dispatch({ type: "session", key: row.session });
+        if (row) app.dispatch({ type: "session", key: row.session, run: row.id });
       }
     },
   });
diff --git a/src/services/runs-page.ts b/src/services/runs-page.ts
index 2d58c45..b5a696e 100644
--- a/src/services/runs-page.ts
+++ b/src/services/runs-page.ts
@@ -52,7 +52,7 @@ export interface RoleRow {
 export interface Milestone {
   name: string;
   landed: boolean;
-  /** the ledger's "what" once landed */
+  /** the ledger's "what" once landed; before that, plan.md's line for the milestone ("" when it has none) */
   what: string;
 }
 
@@ -128,18 +128,50 @@ export function sessionRows(deps: Deps): { rows: SessionRow[]; warnings: string[
   };
 }
 
-/** The ledger's landed milestones, then each milestone a lane file names that has not landed. */
+/**
+ * A milestone's line in plan.md: a heading, list item or plain line that opens with its id and a separator
+ * (`## M1 — the jobs list`, `- **M2:** export`). The id stops at the separator, so `M1.L1 — …` is a lane's.
+ */
+const PLAN_LINE =
+  /^\s*(?:#{1,6}\s+|[-*]\s+|\d+[.)]\s+)?(?:\*\*)?([A-Za-z0-9_-]+)(?::\*\*|(?:\*\*)?\s*(?:—|–|:|-))\s*(.+?)\s*$/;
+
+/** The description plan.md gives each of `names`, from the first line that opens with it; none for the rest. */
+function planWhat(run: Run, names: string[]): Map<string, string> {
+  const out = new Map<string, string>();
+  const file = runPaths(run.dir).plan;
+  if (names.length === 0 || !existsSync(file)) return out;
+  for (const line of readFileSync(file, "utf8").split("\n")) {
+    const m = PLAN_LINE.exec(line);
+    const name = m?.[1];
+    if (m && name && names.includes(name) && !out.has(name)) out.set(name, (m[2] ?? "").trim());
+  }
+  return out;
+}
+
+const byNumber = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
+
+/**
+ * The ledger's landed milestones, then each milestone a lane file names that has not landed, whatever its id:
+ * lane `<milestone>.<lane>` belongs to the milestone before its first dot, as protocol.ts reads it. An open
+ * milestone's description is plan.md's line for it, when there is one.
+ */
 function milestonesOf(run: Run): Milestone[] {
   const landed = nonBlankLines(runPaths(run.dir).ledger)
     .slice(1)
     .map((l) => l.split(" | "))
     .map(([name, what]) => ({ name: (name ?? "").trim(), landed: true, what: (what ?? "").trim() }));
   const lanes = existsSync(runPaths(run.dir).lanes) ? readdirSync(runPaths(run.dir).lanes) : [];
-  const open = [...new Set(lanes.map((f) => /^(M\d+)\./.exec(f)?.[1]).filter((m): m is string => !!m))]
-    .filter((m) => !landed.some((l) => l.name === m))
-    .map((name) => ({ name, landed: false, what: "" }));
-  const n = (m: string) => Number(/\d+/.exec(m)?.[0] ?? 0);
-  return [...landed, ...open.sort((a, b) => n(a.name) - n(b.name))];
+  const names = [
+    ...new Set(
+      lanes
+        .filter((f) => f.endsWith(".md") && f.slice(0, -".md".length).includes("."))
+        .map((f) => f.split(".")[0] as string),
+    ),
+  ]
+    .filter((m) => m !== "" && !landed.some((l) => l.name === m))
+    .sort(byNumber);
+  const what = planWhat(run, names);
+  return [...landed, ...names.map((name) => ({ name, landed: false, what: what.get(name) ?? "" }))];
 }
 
 /** Each role's latest dispatch, live ones first, then the newest finished first. */
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/entry/tui/ test/services/runs-page.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add src/entry/tui/state.ts src/entry/tui/views/runs.tsx src/entry/tui/views/status.tsx src/services/runs-page.ts test/entry/tui/effects.test.ts test/entry/tui/runs.test.tsx test/entry/tui/state.test.ts test/services/runs-page.test.ts
git commit -F - <<'EOF'
fix(tui): the runs page minors: start rows, open milestones, finished roles, no render-time refs

1.1 follow-ups, Runs page. The back row lives in the TUI state; a session opened for a run
starts on that run, else on its first live role; an open milestone of any id gets its row with
plan.md's line; a finished role is no longer polled; rows are looked up from one map; the
watchDirs real-fs test waits out late probe events.

<the session's attribution lines>
EOF
```

Scratch commit: `2a99cd9`. Body lines stay ≤ 100 characters (commitlint). Check `git log` afterwards.

---

### Task 2: The protocol and land minors (1.1 follow-ups: Protocol and gate, first half)

`run_start` records `startHead` and the first milestone's range starts there (Ruling 7); a markdown verdict's `E_LAND_GATE` fix says why (Ruling 8); "owned by" counts only for a lane (Ruling 9); `protocolNext` reads records, dispatches and agent runs once for all lanes; `peek` reads state.json once and stops shadowing `r` (`reentry` takes the notes it already read).

**Files:**
- Modify: `src/services/lane-service.ts`
- Modify: `src/services/milestones.ts`
- Modify: `src/services/peek.ts`
- Modify: `src/services/protocol.ts`
- Modify: `src/services/reentry.ts`
- Modify: `src/services/run-service.ts`
- Modify: `src/services/run-store.ts`
- Modify: `test/services/climb-design.test.ts`
- Modify: `test/services/land-gate.test.ts`

**Interfaces:**
- Produces: meta.json `startHead?: string` (RunMetaSchema, `createRun({ startHead })`); `reentry(run, now?, notes?)`. Consumes: `commitExists` (infra/git.ts).

**Commit:** `fix(protocol): the land and protocol minors: start head, markdown verdict, ownership evidence` (scratch `ab087ad`)

- [ ] **Step 1: Write the failing tests**

Apply this diff (re-find each hunk by its context; line numbers may have moved):

````diff
diff --git a/test/services/climb-design.test.ts b/test/services/climb-design.test.ts
index 933cb76..7859f42 100644
--- a/test/services/climb-design.test.ts
+++ b/test/services/climb-design.test.ts
@@ -63,10 +63,19 @@ describe("climb only for capability (spec 1.1 §9)", () => {
 
   it("refuses ownership evidence on a blocked climb without Jev, and never asks Jev when it is off", async () => {
     const { run, deps, asked } = await routed("off");
-    for (const evidence of ["needs src/b.ts, outside lane ownership", "src/b.ts is owned by M1.L2"])
+    for (const evidence of [
+      "needs src/b.ts, outside lane ownership",
+      "src/b.ts is owned by M1.L2",
+      "src/b.ts is owned by another lane",
+    ])
       expect(await code(climb(deps, { run: run.id, lane: "M1.L1", reason: "blocked", evidence }))).toBe(
         REFUSED,
       );
+    // an environment error that says "owned by" is no ownership finding, even without env: true (1.1 follow-ups)
+    for (const evidence of ["/var/run/docker.sock is owned by root", "lock dir owned by another user"])
+      expect(await code(climb(deps, { run: run.id, lane: "M1.L1", reason: "blocked", evidence }))).toBe(
+        "climbed",
+      );
     expect(
       await code(
         climb(deps, { run: run.id, lane: "M1.L1", reason: "blocked", evidence: "the plan says so" }),
diff --git a/test/services/land-gate.test.ts b/test/services/land-gate.test.ts
index 2a5c9c4..a9ce1e1 100644
--- a/test/services/land-gate.test.ts
+++ b/test/services/land-gate.test.ts
@@ -12,9 +12,9 @@ import {
   reviewerPassed,
   reviewsMilestone,
 } from "../../src/services/milestones.ts";
-import { appendAgentRun, appendRecord, readAgentRuns } from "../../src/services/run-store.ts";
+import { appendAgentRun, appendRecord, findRun, readAgentRuns } from "../../src/services/run-store.ts";
 import { writeDeliveryAttempt } from "../../src/infra/delivery.ts";
-import { result, recordAgentRun } from "../../src/services/run-service.ts";
+import { result, recordAgentRun, startRun } from "../../src/services/run-service.ts";
 import { snapshotEnv } from "../helpers.ts";
 import { fakeDeps, fakeDispatch, freshRun, makeRecord, passGate, writeLane } from "./helpers.ts";
 
@@ -216,6 +216,14 @@ describe("the land gate (spec 1.1 §6)", () => {
     await verifier("All good, I think.\nVERDICT: PASS\n");
     const e = await refusal(land(fakeDeps(), landing(run.id, c)));
     expect(e.message).toContain("a verifier verdict");
+    expect(e.fix).not.toContain("bare VERDICT: PASS");
+    // a verdict in markdown fails safe, and the fix says why (1.1 follow-ups)
+    await verifier("**VERDICT: PASS**\nA1 PASS bun test\n");
+    const md = await refusal(land(fakeDeps(), landing(run.id, c)));
+    expect(md.message).toContain("is **VERDICT: PASS**");
+    expect(md.fix).toStartWith(
+      `the reply's first line must be the bare VERDICT: PASS, and verifier-M1's is "**VERDICT: PASS**", which counts as no verdict`,
+    );
     await verifier("\nVERDICT: PASS\nA1 PASS bun test\nSTATUS: complete — all pass\n");
     expect((await land(fakeDeps(), landing(run.id, c))).ledger).toStartWith("M1 |");
     // the digest names the verdict the gate took, not "none" for want of a record_agent_run row
@@ -342,6 +350,21 @@ describe("the land gate (spec 1.1 §6)", () => {
     );
   });
 
+  it("judges the first milestone's skip from the HEAD the run started on, not its last commit only", async () => {
+    const { repo } = freshRun();
+    const { run: id } = await startRun(fakeDeps(), { repo, title: "t", aLines: ["A1"] });
+    expect(findRun(id).meta.startHead).toMatch(/^[0-9a-f]{40}$/);
+    commitFiles(repo, ["src/a.ts"]);
+    const docs = commitFiles(repo, ["docs/a.md"]);
+    const e = await refusal(land(fakeDeps(), landing(id, docs, { skip: "docs-only" })));
+    expect(e.message).toBe('land M1: skip "docs-only" refused: files outside the docs changed: src/a.ts');
+    // a run from before 1.5 (no startHead) keeps the commit's own parent
+    const { run: old } = freshRun();
+    commitFiles(old.meta.repo, ["src/a.ts"]);
+    const only = commitFiles(old.meta.repo, ["docs/a.md"]);
+    expect((await land(fakeDeps(), landing(old.id, only, { skip: "docs-only" }))).ledger).toStartWith("M1 |");
+  });
+
   it("refuses a skip over an empty commit range: nothing to land", async () => {
     const { repo, run } = freshRun();
     const first = commitFiles(repo, ["docs/a.md"]);
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/land-gate.test.ts test/services/climb-design.test.ts test/services/protocol.test.ts test/services/peek.test.ts test/services/reentry.test.ts`
Expected: the markdown-verdict assertions, the start-HEAD test and the environment "owned by" climbs fail; the protocol, peek and reentry refactors keep their existing tests green.

- [ ] **Step 3: Implement**

````diff
diff --git a/src/services/lane-service.ts b/src/services/lane-service.ts
index d259658..1633ed6 100644
--- a/src/services/lane-service.ts
+++ b/src/services/lane-service.ts
@@ -130,8 +130,13 @@ export async function route(
   };
 }
 
-/** Evidence that the lane's own ownership is the problem: a design question, never a capability one. */
-const OWNERSHIP = /outside (the )?lane('s)? ownership|owned by/i;
+/**
+ * Evidence that the lane's own ownership is the problem: a design question, never a capability one. "owned by"
+ * counts only for a lane (another lane, lane X, Mx.Ly), never for a user or a process: a socket "owned by root"
+ * is the environment's.
+ */
+const OWNERSHIP =
+  /outside (the )?lane('s)? ownership|owned by (?:another |a different |the other )?lane\b|owned by [A-Za-z0-9_-]+\.L\d+\b/i;
 
 const CLIMB_DESIGN_FIX = "send it to the architect (ask/architect delta), not up the ladder";
 
@@ -286,12 +291,17 @@ async function gate(run: Run, m: string, commit: string, skip: LandSkip | undefi
           `a verifier verdict (record_agent_run with role verifier and a name holding ${m}, status ok; a headless verifier's reply opening VERDICT: PASS)${verdict ? `: the latest, ${verdict.name}${verdict.headless ? " (headless)" : ""}, is ${verdict.verdict}` : ""}`,
         ]),
   ];
+  // a headless verifier that wrapped its verdict in markdown (**VERDICT: PASS**) gave no verdict: fail safe, and say why
+  const marked =
+    verdict?.headless === true && !verdict.passed && /VERDICT:\s*PASS\b/.test(verdict.verdict)
+      ? `the reply's first line must be the bare VERDICT: PASS, and ${verdict.name}'s is "${verdict.verdict}", which counts as no verdict (markdown around it, or text before it): dispatch the verifier again; otherwise `
+      : "";
   if (missing.length)
     throw new CatherdError(
       "E_LAND_GATE",
       `land ${m}: missing ${missing.join(" and ")}, since its lanes started`,
       {
-        fix: `run reviewer-${m} (a dispatch, or a Claude subagent recorded with record_agent_run(name: "reviewer-${m}")) and the verifier on ${m}, recording it with record_agent_run(name: "verifier-${m}") (a FAIL with status "failed"), then land again; a docs-only milestone passes skip: "docs-only"`,
+        fix: `${marked}run reviewer-${m} (a dispatch, or a Claude subagent recorded with record_agent_run(name: "reviewer-${m}")) and the verifier on ${m}, recording it with record_agent_run(name: "verifier-${m}") (a FAIL with status "failed"), then land again; a docs-only milestone passes skip: "docs-only"`,
       },
     );
 }
diff --git a/src/services/milestones.ts b/src/services/milestones.ts
index 404e94b..789012e 100644
--- a/src/services/milestones.ts
+++ b/src/services/milestones.ts
@@ -2,7 +2,7 @@ import { existsSync, readFileSync } from "node:fs";
 import { join } from "node:path";
 import { CatherdError } from "../domain/errors.ts";
 import type { RunRecord } from "../domain/record.ts";
-import { git } from "../infra/git.ts";
+import { commitExists, git } from "../infra/git.ts";
 import { nonBlankLines } from "../infra/store.ts";
 import { listDispatches } from "./dispatches.ts";
 import { readAgentRuns, readRecords, readRoutes, type Run, runPaths } from "./run-store.ts";
@@ -170,12 +170,16 @@ export function landedMilestones(run: Run): string[] {
 }
 
 /**
- * The files the milestone's commit range changed: from the previous landed commit (else the commit's own
- * parent) to `commit`. Throws E_IO_UNEXPECTED when git cannot say.
+ * The files the milestone's commit range changed: from the previous landed commit, else the HEAD the run
+ * started on (meta.json `startHead`, when that commit is still there), else the commit's own parent, to
+ * `commit`. Throws E_IO_UNEXPECTED when git cannot say.
  */
 export async function milestoneFiles(run: Run, commit: string): Promise<string[]> {
-  const base = landedCommits(run).at(-1);
   const repo = run.meta.repo;
+  const start = run.meta.startHead;
+  const base =
+    landedCommits(run).at(-1) ??
+    (start && (await commitExists(repo, start).catch(() => false)) ? start : undefined);
   const r = base
     ? await git(repo, ["diff", "--name-only", base, commit])
     : await git(repo, ["show", "--name-only", "--format=", "--first-parent", commit]);
diff --git a/src/services/peek.ts b/src/services/peek.ts
index 2f1ec5c..6920c85 100644
--- a/src/services/peek.ts
+++ b/src/services/peek.ts
@@ -57,9 +57,10 @@ function peekRun(deps: Deps, run: Run, name: string | undefined): PeekRun {
   const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
   const agents = readAgentRuns(run).filter((a) => name === undefined || a.name === name);
   const native = agents.at(-1);
-  const r = reentry(run, now);
+  const notes = readNotes(run);
+  const re = reentry(run, now, notes);
   return {
-    questions: r.questions,
+    questions: re.questions,
     run: run.id,
     title: run.meta.title,
     owner: runOwner(run)?.sessionId ?? null,
@@ -103,9 +104,9 @@ function peekRun(deps: Deps, run: Run, name: string | undefined): PeekRun {
     native: native
       ? { name: native.name, role: native.role, rung: native.rung, status: native.status, at: native.at }
       : null,
-    next: readNotes(run).next,
-    protocol: r.protocol,
-    verifier: r.verifier,
+    next: notes.next,
+    protocol: re.protocol,
+    verifier: re.verifier,
   };
 }
 
diff --git a/src/services/protocol.ts b/src/services/protocol.ts
index bd5fb78..5599e0f 100644
--- a/src/services/protocol.ts
+++ b/src/services/protocol.ts
@@ -44,30 +44,48 @@ function laneIds(run: Run): string[] {
     .sort(byNumber);
 }
 
+/** What laneDone reads of the run, read once for every lane of the milestone. */
+interface LaneEvidence {
+  routes: RouteRow[];
+  live: Dispatch[];
+  records: Map<string, RunRecord>;
+  dispatches: Dispatch[];
+  agents: ReturnType<typeof readAgentRuns>;
+}
+
+function laneEvidence(run: Run, routes: RouteRow[], live: Dispatch[]): LaneEvidence {
+  return {
+    routes,
+    live,
+    records: new Map(readRecords(run).records.map((r) => [r.dispatchId, r])),
+    dispatches: listDispatches(run),
+    agents: readAgentRuns(run),
+  };
+}
+
 /**
  * Whether `lane` needs no dispatch now: its latest dispatch or native agent run since its latest climb is
  * still running, or ended ok with no blocked or refused reply. A lane whose last try failed, hit a limit,
  * was blocked, or was climbed since goes back to dispatch; a plain re-route leaves an ok try standing.
  */
-function laneDone(run: Run, lane: string, routes: RouteRow[], live: Dispatch[]): boolean {
+function laneDone(lane: string, e: LaneEvidence): boolean {
   const from = Math.max(
-    ...routes.filter((r) => r.lane === lane && r.source === "climb").map((r) => Date.parse(r.at)),
+    ...e.routes.filter((r) => r.lane === lane && r.source === "climb").map((r) => Date.parse(r.at)),
   );
   // a dispatch routes its lane first, so a try at the route's own time counts as after it
   const after = (t: string) => !(Date.parse(t) < from);
-  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
-  const running = new Set(live.map((d) => d.admit.dispatchId));
+  const running = new Set(e.live.map((d) => d.admit.dispatchId));
   const tries = [
-    ...listDispatches(run)
+    ...e.dispatches
       .filter((d) => d.admit.lane === lane && after(d.admit.admittedAt))
       .map((d) => {
-        const r = records.get(d.admit.dispatchId);
+        const r = e.records.get(d.admit.dispatchId);
         const ok = r
           ? r.status === "ok" && r.replyStatus !== "blocked" && r.replyStatus !== "refused"
           : running.has(d.admit.dispatchId);
         return { at: Date.parse(d.admit.admittedAt), ok };
       }),
-    ...readAgentRuns(run)
+    ...e.agents
       .filter((a) => a.lane === lane && after(a.at))
       .map((a) => ({ at: Date.parse(a.at), ok: a.status === "ok" })),
   ];
@@ -98,7 +116,8 @@ export function protocolNext(run: Run, parked: string[], now = Date.now()): stri
   const routed = new Set(routes.map((r) => r.lane));
   if (mine.some((l) => !routed.has(l))) return `route and preflight ${m}'s lanes`;
   const live = liveDispatches(run, now);
-  const notDone = mine.filter((l) => !laneDone(run, l, routes, live));
+  const evidence = laneEvidence(run, routes, live);
+  const notDone = mine.filter((l) => !laneDone(l, evidence));
   // spec 1.1 §9: a climb past the top rung (from === rung) leaves nothing to climb to; that is a decision
   const spent = notDone.filter((l) => {
     const last = routes.findLast((r) => r.lane === l);
diff --git a/src/services/reentry.ts b/src/services/reentry.ts
index 1d96469..400fba9 100644
--- a/src/services/reentry.ts
+++ b/src/services/reentry.ts
@@ -2,7 +2,7 @@ import { latestVerifierStep, type VerifierStep } from "./gate-service.ts";
 import { protocolView } from "./protocol.ts";
 import { type OpenQuestion, openQuestions } from "./questions.ts";
 import type { Run } from "./run-store.ts";
-import { readNotes } from "./state.ts";
+import { type Notes, readNotes } from "./state.ts";
 
 // Spec 1.1 §8, §7 and §10: what a session re-entering a run needs first, as peek returns it: the owner questions still open, the protocol's next step with its checklist,
 // and the verifier's latest step.
@@ -13,10 +13,11 @@ export interface Reentry {
   verifier: VerifierStep | null;
 }
 
-export function reentry(run: Run, now?: number): Reentry {
+/** `notes`: state.json as the caller already read it (peek), so it is read once. */
+export function reentry(run: Run, now?: number, notes: Notes = readNotes(run)): Reentry {
   return {
     questions: openQuestions(run),
-    protocol: protocolView(run, readNotes(run).parked ?? [], now),
+    protocol: protocolView(run, notes.parked ?? [], now),
     verifier: latestVerifierStep(run),
   };
 }
diff --git a/src/services/run-service.ts b/src/services/run-service.ts
index c73cabc..406bbd9 100644
--- a/src/services/run-service.ts
+++ b/src/services/run-service.ts
@@ -5,7 +5,7 @@ import { assertId, parseRung } from "../domain/ids.ts";
 import type { RunRecord } from "../domain/record.ts";
 import type { Role } from "../domain/roles.ts";
 import { awaitsCollect, dispatchPaths, endCollect, tryCollect } from "../infra/dispatch-dir.ts";
-import { gitToplevel } from "../infra/git.ts";
+import { git, gitToplevel } from "../infra/git.ts";
 import { writeTextAtomic } from "../infra/store.ts";
 import {
   dispatchState,
@@ -44,11 +44,14 @@ export async function startRun(
     throw new CatherdError("E_IO_PATH", `${i.repo} is not inside a git repository`, {
       fix: "pass the path of the repository to work in",
     });
+  // where the first milestone's commit range starts; a repo with no commit yet has none
+  const head = await git(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
   const run = createRun({
     repo: top,
     title: i.title,
     aLines: i.aLines,
     version: deps.version,
+    startHead: head.kind === "ok" ? head.out.trim() || null : null,
     now: new Date(deps.now()),
     startedBy: currentSession(deps),
   });
diff --git a/src/services/run-store.ts b/src/services/run-store.ts
index 630ac01..10ebfee 100644
--- a/src/services/run-store.ts
+++ b/src/services/run-store.ts
@@ -39,6 +39,8 @@ const RunMetaSchema = z.looseObject({
   catherdVersion: z.string(),
   startedBy: StartedBySchema.nullable().optional(),
   workspace: z.strictObject({ id: z.string(), step: z.string() }).optional(),
+  /** the repo's HEAD when run_start ran: where the first milestone's commit range starts (absent before 1.5) */
+  startHead: z.string().optional(),
 });
 type RunMeta = z.infer<typeof RunMetaSchema>;
 
@@ -85,6 +87,8 @@ export function createRun(o: {
   version: string;
   now?: Date;
   workspace?: { id: string; step: string };
+  /** the repo's full HEAD at the start, when it has a commit */
+  startHead?: string | null;
   startedBy?: {
     host?: StartedBy["host"];
     sessionId: string;
@@ -136,6 +140,7 @@ export function createRun(o: {
     catherdVersion: o.version,
     ...(o.startedBy ? { startedBy: StartedBySchema.parse(o.startedBy) } : {}),
     ...(workspace ? { workspace } : {}),
+    ...(o.startHead ? { startHead: o.startHead } : {}),
   };
   writeJsonAtomic(p.meta, meta);
   return { id, dir, meta };
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/services/land-gate.test.ts test/services/climb-design.test.ts test/services/protocol.test.ts test/services/peek.test.ts test/services/reentry.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add src/services/lane-service.ts src/services/milestones.ts src/services/peek.ts src/services/protocol.ts src/services/reentry.ts src/services/run-service.ts src/services/run-store.ts test/services/climb-design.test.ts test/services/land-gate.test.ts
git commit -F - <<'EOF'
fix(protocol): the land and protocol minors: start head, markdown verdict, ownership evidence

1.1 follow-ups, Protocol and gate. run_start records the repo's HEAD in meta.json and the first
milestone's commit range starts there; a headless verdict in markdown fails safe with a fix that
says why; "owned by" is ownership evidence only for a lane; protocolNext reads the records, the
dispatches and the agent runs once for all lanes; peek reads state.json once and stops shadowing.

<the session's attribution lines>
EOF
```

Scratch commit: `ab087ad`. Body lines stay ≤ 100 characters (commitlint). Check `git log` afterwards.

---

### Task 3: Route a lane once, only when admission would take it; the gate ledger minors (1.1 follow-ups: Protocol and gate, second half)

`dispatch` refuses what admission would refuse before it routes (Ruling 10) and routes a lane under a per-lane lock (Ruling 11); `gate_pass` names `<HEAD>+uncommitted` (Ruling 12); `./` is the whole repo (Ruling 13); a test pins that a staged rename out of a gate's paths is seen (Ruling 14).

**Files:**
- Modify: `src/services/admission.ts`
- Modify: `src/services/dispatch-service.ts`
- Modify: `src/services/gate-service.ts`
- Modify: `test/services/dispatch-protocol.test.ts`
- Modify: `test/services/gate-service.test.ts`

**Interfaces:**
- Produces: `laneOwns` exported from admission.ts; `contentHash` returns `{ hash, dirty }` (module-private). Consumes: `withFileLock`, `pendingDispatches`.

**Commit:** `fix(dispatch): route a lane once and only when admission would take it; gate pass names dirt` (scratch `f5903b7`)

- [ ] **Step 1: Write the failing tests**

Apply this diff (re-find each hunk by its context; line numbers may have moved):

````diff
diff --git a/test/services/dispatch-protocol.test.ts b/test/services/dispatch-protocol.test.ts
index 33f671e..cc57820 100644
--- a/test/services/dispatch-protocol.test.ts
+++ b/test/services/dispatch-protocol.test.ts
@@ -143,4 +143,56 @@ describe("dispatch routes an unrouted lane first (spec 1.1 §6)", () => {
     });
     expect(readRoutes(run)).toHaveLength(1);
   });
+
+  it("refuses what admission would refuse before routing: no Jev call, no route row (1.1 follow-ups)", async () => {
+    const { run, deps } = setup();
+    let asked = 0;
+    const routeOf = deps.routing.route;
+    deps.routing.route = (q) => {
+      asked++;
+      return routeOf(q);
+    };
+    const go = (over: Record<string, unknown>) =>
+      dispatch(deps, {
+        run: run.id,
+        role: "worker",
+        name: "w",
+        brief: "b",
+        rung: L0,
+        lane: "M1.L1",
+        ...over,
+      }).then(
+        () => "ok",
+        (e: { code?: string }) => e.code ?? String(e),
+      );
+    expect(await go({ lane: "M1.L9" })).toBe("E_LANE_INVALID");
+    deps.profiles.forRepo = () => ({
+      ...fakeDeps().profiles.forRepo(run.meta.repo),
+      roles: { ...fakeDeps().profiles.forRepo(run.meta.repo).roles, artist: { enabled: false } as never },
+    });
+    expect(await go({ role: "artist" })).toBe("E_ADMIT_RUNG");
+    expect([asked, readRoutes(run)]).toEqual([0, []]);
+  });
+
+  it("routes a lane once when two dispatches of it start together", async () => {
+    const { run, deps } = setup();
+    writeLane(run, "M1.L2", ["src/b.ts"]);
+    let asked = 0;
+    const routeOf = deps.routing.route;
+    deps.routing.route = async (q) => {
+      asked++;
+      await Bun.sleep(0);
+      return routeOf(q);
+    };
+    const one = (name: string) =>
+      dispatch(deps, { run: run.id, role: "worker", name, brief: "b", rung: L0, lane: "M1.L2" }).then(
+        () => "ok",
+        (e: { code?: string }) => e.code ?? String(e),
+      );
+    const outcomes = await Promise.all([one("worker-M1.L2"), one("worker-M1.L2-again")]);
+    expect(asked).toBe(1);
+    expect(readRoutes(run).filter((r) => r.lane === "M1.L2")).toHaveLength(1);
+    // the second is then refused for the lane the first runs, as before
+    expect(outcomes.sort()).toEqual(["E_ADMIT_OVERLAP", "ok"]);
+  });
 });
diff --git a/test/services/gate-service.test.ts b/test/services/gate-service.test.ts
index 952b770..3b0ba19 100644
--- a/test/services/gate-service.test.ts
+++ b/test/services/gate-service.test.ts
@@ -112,6 +112,29 @@ describe("the gate ledger (spec 1.1 §7)", () => {
     expect((await gateCheck(deps, item(run.id, { paths: ["."] }))).carried).toBe(false);
   });
 
+  it("names a pass on uncommitted changes HEAD+uncommitted, takes ./ as ., and sees a staged rename out", async () => {
+    const { repo, run } = freshRun();
+    write(repo, "src/a.ts", "a");
+    const c1 = commit(repo);
+    const deps = fakeDeps();
+    expect((await gatePass(deps, { ...item(run.id), evidence: "ok" })).commit).toBe(c1);
+    write(repo, "src/a.ts", "dirty");
+    expect((await gatePass(deps, { ...item(run.id), evidence: "ok" })).commit).toBe(`${c1}+uncommitted`);
+    // a dirty file outside the paths leaves the pass on HEAD
+    write(repo, "src/a.ts", "a");
+    write(repo, "docs/x.md", "x");
+    expect((await gatePass(deps, { ...item(run.id), evidence: "ok" })).commit).toBe(c1);
+    // ./ is the whole repo, as . is
+    const whole = await gatePass(deps, { ...item(run.id, { paths: ["./"] }), evidence: "ok" });
+    expect((await gateCheck(deps, item(run.id, { paths: ["."] }))).carried).toBe(true);
+    expect(whole.commit).toBe(`${c1}+uncommitted`);
+    // a staged rename out of the paths changes their content (git status reports the rename's source too)
+    rmSync(join(repo, "docs"), { recursive: true });
+    expect((await gateCheck(deps, item(run.id))).carried).toBe(true);
+    execFileSync("git", ["mv", "src/a.ts", "lib-a.ts"], { cwd: repo });
+    expect((await gateCheck(deps, item(run.id))).carried).toBe(false);
+  });
+
   it("keeps the ledger per repo, beside knowledge.md, and a pass is found from another run of the repo", async () => {
     const { repo, run } = freshRun();
     write(repo, "src/a.ts", "a");
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/dispatch-protocol.test.ts test/services/gate-service.test.ts test/services/dispatch.test.ts test/services/admission.test.ts`
Expected: the pre-route refusal test (a route row is written today), the concurrent-dispatch test (Jev asked twice) and the gate test (`+uncommitted`, `./`) fail; the staged-rename half passes on main already.

- [ ] **Step 3: Implement**

````diff
diff --git a/src/services/admission.ts b/src/services/admission.ts
index cc8242f..74a94df 100644
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -56,7 +56,7 @@ export const KILL_GRACE_MS = 10_000;
 
 export const laneFile = (run: Run, lane: string): string => join(runPaths(run.dir).lanes, `${lane}.md`);
 
-function laneOwns(run: Run, lane: string): string[] {
+export function laneOwns(run: Run, lane: string): string[] {
   const file = laneFile(run, lane);
   if (!existsSync(file))
     throw new CatherdError("E_LANE_INVALID", `no lane file lanes/${lane}.md`, {
diff --git a/src/services/dispatch-service.ts b/src/services/dispatch-service.ts
index d30aec0..16a68ea 100644
--- a/src/services/dispatch-service.ts
+++ b/src/services/dispatch-service.ts
@@ -1,5 +1,6 @@
 import { assertNativeHost } from "./backends.ts";
 import { existsSync, readFileSync } from "node:fs";
+import { join } from "node:path";
 import { CatherdError, errorMessage, isCatherdError } from "../domain/errors.ts";
 import { assertId, parseRung } from "../domain/ids.ts";
 import type { RunRecord } from "../domain/record.ts";
@@ -17,7 +18,7 @@ import { lockHeld, withFileLock } from "../infra/filelock.ts";
 import { log } from "../infra/log.ts";
 import { isAlive, isSurelyAlive, killGroup } from "../infra/proc.ts";
 import { writeJsonAtomic } from "../infra/store.ts";
-import { admit, KILL_GRACE_MS, laneFile, launch } from "./admission.ts";
+import { admit, KILL_GRACE_MS, laneFile, laneOwns, launch } from "./admission.ts";
 import { standInFor } from "./backends.ts";
 import {
   type Dispatch,
@@ -281,6 +282,34 @@ function unannounced(run: Run): { d: Dispatch; record: RunRecord }[] {
   });
 }
 
+/** How long a dispatch waits for another dispatch's route of the same lane (Jev may take tens of seconds). */
+const ROUTE_LOCK_MS = 120_000;
+
+/**
+ * What admission would refuse anyway, refused before a lane is routed, so a refused dispatch asks Jev nothing
+ * and writes no route row: the role off, the lane file missing or with no Owns:, the name or the lane already
+ * running. Admission checks them again under its lock.
+ */
+function refuseBeforeRouting(deps: Deps, run: Run, i: DispatchInput & { lane: string }): void {
+  const profile = deps.profiles.forRepo(run.meta.repo);
+  if (!profile.roles[i.role]?.enabled)
+    throw new CatherdError("E_ADMIT_RUNG", `the ${i.role} role is off in profile ${profile.name}`, {
+      fix: "skip the role, or turn it on with profile_set",
+    });
+  laneOwns(run, i.lane);
+  const pending = pendingDispatches(run, deps.now());
+  const same = pending.find((d) => d.admit.name === i.name);
+  if (same)
+    throw new CatherdError("E_ADMIT_DUPLICATE", `${i.name} is already running on ${same.admit.rung}`, {
+      fix: `its record is announced when it finishes; or cancel(run, "${i.name}")`,
+    });
+  const lane = pending.find((d) => d.admit.lane === i.lane);
+  if (lane)
+    throw new CatherdError("E_ADMIT_OVERLAP", `lane ${i.lane} is already running as ${lane.admit.name}`, {
+      fix: `dispatch it after ${lane.admit.name} finishes`,
+    });
+}
+
 /**
  * Spec §4.4, plan 9 ruling 1: admit and launch one role, start its watcher, then refresh state.md with
  * `next` (after the launch, so nothing delays it). Returns at once; catherd announces the record (spec §3).
@@ -291,12 +320,21 @@ export async function dispatch(deps: Deps, i: DispatchInput): Promise<DispatchSt
   const hints: string[] = [];
   let rung = i.rung;
   // spec 1.1 §6: a lane is routed before its first dispatch; a rung off the routed ladder starts at the routed one
-  if (i.lane !== undefined && !readRoutes(run).some((r) => r.lane === i.lane)) {
-    assertId("lane", i.lane);
-    const routed = await route(deps, { run: i.run, laneFile: `lanes/${i.lane}.md`, role: i.role });
+  const lane = i.lane;
+  if (lane !== undefined && !readRoutes(run).some((r) => r.lane === lane)) {
+    assertId("lane", lane);
+    refuseBeforeRouting(deps, run, { ...i, lane });
+    // one route per lane: a second dispatch of the lane waits for the first's route and takes it
+    const routed = await withFileLock(
+      join(run.dir, `route-${lane}`),
+      async () =>
+        readRoutes(run).findLast((r) => r.lane === lane) ??
+        (await route(deps, { run: i.run, laneFile: `lanes/${lane}.md`, role: i.role })),
+      { timeoutMs: ROUTE_LOCK_MS },
+    );
     if (!routed.ladder.includes(i.rung)) {
       rung = routed.rung;
-      hints.push(`${i.rung} is not on ${i.lane}'s routed ladder: dispatched at ${routed.rung}`);
+      hints.push(`${i.rung} is not on ${lane}'s routed ladder: dispatched at ${routed.rung}`);
     }
   }
   // the rung that runs, after routing: an off-ladder native rung routing replaced is never launched
diff --git a/src/services/gate-service.ts b/src/services/gate-service.ts
index a6982cd..1a8dc9a 100644
--- a/src/services/gate-service.ts
+++ b/src/services/gate-service.ts
@@ -46,10 +46,11 @@ export interface VerifierStep {
 export const gatesFile = (toplevel: string): string => join(repoDir(toplevel), "gates.jsonl");
 const stepsFile = (run: Run): string => join(run.dir, "verifier.jsonl");
 
-/** Repo-relative paths, `.` for the whole repo; anything that leaves the repo is refused. */
+/** Repo-relative paths, `.` (or `./`) for the whole repo; anything that leaves the repo is refused. */
 function cleanPaths(paths: string[]): string[] {
+  const whole = (p: string) => p.trim() === "." || p.trim() === "./";
   try {
-    return [...new Set(paths.map((p) => (p.trim() === "." ? "." : normalizeOwned(p))))].sort();
+    return [...new Set(paths.map((p) => (whole(p) ? "." : normalizeOwned(p))))].sort();
   } catch (e) {
     if (isCatherdError(e))
       throw new CatherdError("E_INPUT_INVALID", e.message.replace("owned path", "gate path"), {
@@ -184,7 +185,7 @@ function walk(repo: string, p: string): string[] {
  * A path git ignores, or one not at HEAD, is also hashed file by file from disk; ignored files under `.` or
  * under a tracked directory are not, so an ignored input is covered only when it is named.
  */
-async function contentHash(repo: string, paths: string[]): Promise<string> {
+async function contentHash(repo: string, paths: string[]): Promise<{ hash: string; dirty: boolean }> {
   const h = new Bun.CryptoHasher("sha256");
   for (const p of paths) {
     // the tree entry, mode and type with the object id (`100755 blob <sha>`), so a committed chmod -x is new
@@ -219,7 +220,7 @@ async function contentHash(repo: string, paths: string[]): Promise<string> {
     .filter((f) => paths.includes(".") || overlaps([f], paths).length > 0)
     .sort();
   for (const f of dirty) h.update(`dirty ${f}=${await dirtyEntry(join(repo, f), f)}\n`);
-  return h.digest("hex");
+  return { hash: h.digest("hex"), dirty: dirty.length > 0 };
 }
 
 const readPasses = (repo: string): GatePass[] =>
@@ -251,7 +252,7 @@ export async function gateCheck(
 ): Promise<{ carried: true; passedAt: string; commit: string } | { carried: false }> {
   const run = findRun(i.run);
   const paths = cleanPaths(i.paths);
-  const hash = await contentHash(run.meta.repo, paths);
+  const { hash } = await contentHash(run.meta.repo, paths);
   const pass = readPasses(run.meta.repo).findLast((p) => p.command === i.command && p.hash === hash);
   recordStep(run, {
     at: new Date(deps.now()).toISOString(),
@@ -263,15 +264,19 @@ export async function gateCheck(
   return pass ? { carried: true, passedAt: pass.at, commit: pass.commit } : { carried: false };
 }
 
-/** `gate_pass`: records that `command` passed on the current content of `paths`, with its evidence. */
+/**
+ * `gate_pass`: records that `command` passed on the current content of `paths`, with its evidence. A pass on
+ * uncommitted changes under `paths` names its commit `<HEAD>+uncommitted`: HEAD alone is not what it ran on.
+ */
 export async function gatePass(
   deps: Deps,
   i: { run: string; item: string; command: string; paths: string[]; evidence: string },
 ): Promise<{ recorded: true; hash: string; commit: string }> {
   const run = findRun(i.run);
   const paths = cleanPaths(i.paths);
-  const hash = await contentHash(run.meta.repo, paths);
-  const commit = (await gitHead(run.meta.repo)) ?? "none";
+  const { hash, dirty } = await contentHash(run.meta.repo, paths);
+  const head = (await gitHead(run.meta.repo)) ?? "none";
+  const commit = dirty ? `${head}+uncommitted` : head;
   const file = gatesFile(run.meta.repo);
   ensureJsonlHeader(file, "gates");
   appendJsonl(file, {
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/services/dispatch-protocol.test.ts test/services/gate-service.test.ts test/services/dispatch.test.ts test/services/admission.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add src/services/admission.ts src/services/dispatch-service.ts src/services/gate-service.ts test/services/dispatch-protocol.test.ts test/services/gate-service.test.ts
git commit -F - <<'EOF'
fix(dispatch): route a lane once and only when admission would take it; gate pass names dirt

1.1 follow-ups, Protocol and gate. dispatch refuses a role that is off, a lane file missing or
without Owns:, and a name or lane already running before it routes, and routes a lane under a
per-lane lock so two dispatches of it route once. gate_pass names a pass on uncommitted changes
<HEAD>+uncommitted, and ./ is the whole repo as . is. A staged rename out of a gate's paths was
already seen (both paths of the rename are dirty): a test now pins it.

<the session's attribution lines>
EOF
```

Scratch commit: `f5903b7`. Body lines stay ≤ 100 characters (commitlint). Check `git log` afterwards.

---

### Task 4: The access and doctor minors (1.1 follow-ups: Access and doctor; Runs page: the push row; Tests)

The claude-code access row reads every bound repo's sandbox setting (Ruling 15); `profile show` keeps the ladders in one column (Ruling 16); doctor's failed push row is tested from a real refused send; every doctor test that runs doctor more than once gets 30 s (Ruling 20).

**Files:**
- Modify: `src/adapters/backend.ts`
- Modify: `src/adapters/claude-code/index.ts`
- Modify: `src/entry/profile-command.ts`
- Modify: `src/services/doctor-access.ts`
- Modify: `src/services/doctor.ts`
- Modify: `test/adapters/access.test.ts`
- Modify: `test/entry/profile-command.test.ts`
- Modify: `test/services/doctor-push.test.ts`
- Modify: `test/services/doctor.test.ts`

**Interfaces:**
- Produces: `BackendAdapter.accessShell(o: { network; repos? })`; `accessChecks(profiles, installed, repos = [])`. Consumes: `readProjects().bindings`.

**Commit:** `fix(doctor): the access and doctor minors: per-repo Claude sandbox, aligned ladders, push row` (scratch `4b863b2`)

- [ ] **Step 1: Write the failing tests**

Apply this diff (re-find each hunk by its context; line numbers may have moved):

````diff
diff --git a/test/adapters/access.test.ts b/test/adapters/access.test.ts
index 0e8b764..608cca9 100644
--- a/test/adapters/access.test.ts
+++ b/test/adapters/access.test.ts
@@ -245,6 +245,21 @@ describe("worker access grants (spec §5)", () => {
     );
   });
 
+  it("reads the sandbox setting of each repo workers run in, not only doctor's own directory", async () => {
+    const home = withHome();
+    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
+    const plain = tempDir("catherd-plain-");
+    const boxed = tempDir("catherd-boxed-");
+    mkdirSync(join(boxed, ".claude"), { recursive: true });
+    writeFileSync(join(boxed, ".claude", "settings.json"), JSON.stringify({ sandbox: { enabled: true } }));
+    const off = await claudeCodeAdapter.accessShell?.({ network: true, repos: [plain] });
+    if (typeof off !== "object") throw new Error("expected a shell");
+    off.close();
+    expect(await claudeCodeAdapter.accessShell?.({ network: true, repos: [plain, boxed] })).toStartWith(
+      `Claude Code's own sandbox is on (sandbox.enabled) in ${boxed}: `,
+    );
+  });
+
   it("reads and patches roles.<role>.network", () => {
     const doc = applyPatch(defaultProfileDoc(), patchAt("roles.worker.network", "false"));
     const p = resolveProfile(doc, "default", "claude-code");
diff --git a/test/entry/profile-command.test.ts b/test/entry/profile-command.test.ts
index ce9535f..100fc90 100644
--- a/test/entry/profile-command.test.ts
+++ b/test/entry/profile-command.test.ts
@@ -50,6 +50,13 @@ describe("catherd profile show", () => {
       .out.split("\n")
       .find((l) => l.startsWith("  writer"));
     expect(writer).toContain("workspace-write (no network), enforced");
+    // every ladder still starts in one column (1.1 follow-ups)
+    const ladderAt = (l: string) => l.length - l.replace(/^ {2}\S+ +\S.*?, (enforced|advisory) +/, "").length;
+    const roles = catherd(["show"])
+      .out.split("\n")
+      .filter((l) => /, (enforced|advisory) /.test(l));
+    expect(roles.length).toBeGreaterThan(3);
+    expect(new Set(roles.map(ladderAt)).size).toBe(1);
   });
 
   it("prints JSON with every default filled in", () => {
diff --git a/test/services/doctor-push.test.ts b/test/services/doctor-push.test.ts
index 41ccb0d..ee3021c 100644
--- a/test/services/doctor-push.test.ts
+++ b/test/services/doctor-push.test.ts
@@ -52,6 +52,20 @@ describe("explicit push smoke", () => {
     expect(pushCheck(probe).word).toBe("enqueue accepted");
   });
 
+  it("reports a queue that refuses the smoke as a failed row, from a real send (1.1 follow-ups)", async () => {
+    withHome();
+    process.env.PATH = simPath();
+    const s = withScenario({ queue: "unsupported" });
+    const probe = await probePush(codex, s.env);
+    expect(probe).toMatchObject({ outcome: "failed", enqueue: "not-submitted", msgId: null });
+    expect(pushCheck(probe)).toMatchObject({
+      id: "push",
+      state: "fail",
+      word: "not submitted",
+      fix: "Check native host transport; peek/result keeps the unread record available.",
+    });
+  });
+
   it("terminal_has_no_session and conflicts invoke no sender", async () => {
     withHome();
     process.env.PATH = simPath();
diff --git a/test/services/doctor.test.ts b/test/services/doctor.test.ts
index fdac481..d606446 100644
--- a/test/services/doctor.test.ts
+++ b/test/services/doctor.test.ts
@@ -229,6 +229,7 @@ describe("doctor", () => {
     expect(check(r, "isolation:grok")).toMatchObject({ state: "warn", word: "weak" });
   });
 
+  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
   it("fails a logged-out grok a role runs on, and says a grok this OS cannot run is one", async () => {
     machine({ bins: ["codex", "claude", "opencode", "grok"], grok: { loggedIn: false } });
     installPlugin(VERSION);
@@ -253,7 +254,7 @@ describe("doctor", () => {
       detail: `grok is installed but cannot run on this OS: ${join(bin, "grok")}`,
       fix: "curl -fsSL https://x.ai/cli/install.sh | bash",
     });
-  });
+  }, 30_000);
 
   it("shows agy's version, Google login, listing and quota, its isolation note and its untested access", async () => {
     machine({ bins: ["codex", "claude", "opencode", "agy"] });
@@ -342,6 +343,7 @@ describe("doctor", () => {
     ]);
   });
 
+  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
   it("prints move commands a shell runs as they are, after which no role needs the missing Codex", async () => {
     machine({ bins: ["claude"] });
     installPlugin(VERSION);
@@ -368,8 +370,9 @@ describe("doctor", () => {
     expect(check(after, "profile")?.state).not.toBe("fail");
     expect(check(after, "backend:codex")?.state).not.toBe("fail");
     expect(after.ready).toBe(true);
-  });
+  }, 30_000);
 
+  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
   it("resets a customised default rung the moved ladder would not hold, so every printed command runs", async () => {
     machine({ bins: ["claude"] });
     installPlugin(VERSION);
@@ -406,7 +409,7 @@ describe("doctor", () => {
       expect({ c, exit: p.exitCode, err: p.stderr.toString() }).toEqual({ c, exit: 0, err: "" });
     }
     expect((await run()).ready).toBe(true);
-  });
+  }, 30_000);
 
   it("offers opencode when it is the backend that is ready", async () => {
     machine({ bins: ["opencode"] });
@@ -437,6 +440,7 @@ describe("doctor", () => {
     });
   });
 
+  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
   it("says how Codex is logged in, and warns when a profile bills that login as something else", async () => {
     machine({ codex: { login: "api-key" } });
     installPlugin(VERSION);
@@ -453,7 +457,7 @@ describe("doctor", () => {
     expect(JSON.stringify(r)).not.toContain("sk-proj");
     patchProfile("default", { billing: { codex: "metered" } }, { host: "claude-code" });
     expect(check(await run(), "backend:codex")).toMatchObject({ state: "ok", word: "ready" });
-  });
+  }, 30_000);
 
   it("does not warn about the Codex login's billing when no profile routes anything to Codex", async () => {
     machine({ codex: { login: "api-key" } });
@@ -479,6 +483,7 @@ describe("doctor", () => {
     expect(check(r, "backend:codex")?.detail).toMatch(/^0\.157\.0 · API key login/);
   });
 
+  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
   it("fails without the plugin, or with a plugin of another version", async () => {
     machine();
     patchProfile("default", {}, { host: "claude-code" });
@@ -493,7 +498,7 @@ describe("doctor", () => {
       word: "stale",
       detail: `plugin 0.9.0, catherd ${VERSION}`,
     });
-  });
+  }, 30_000);
 
   it("fails on missing agent links, with the command that relinks them", async () => {
     machine();
@@ -688,6 +693,7 @@ describe("doctor", () => {
     ]);
   });
 
+  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
   it("falls back to the old codex sandbox form, and skips when neither form runs", async () => {
     machine({ codex: { sandboxForm: "old" } });
     installPlugin(VERSION);
@@ -701,7 +707,7 @@ describe("doctor", () => {
     const none = await run();
     expect(check(none, "sandbox:codex")).toMatchObject({ state: "skip", word: "not tested" });
     expect(check(none, "access:codex")).toMatchObject({ state: "skip", word: "not tested" });
-  });
+  }, 30_000);
 
   it("probes no network for roles whose network is off, and says opencode cannot enforce it", async () => {
     const argsTo = join(binDir(), "sandbox-args.jsonl");
@@ -780,6 +786,7 @@ describe("doctor", () => {
     expect(c?.detail).toContain("lock-dir write (cannot create");
   });
 
+  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
   it("skips the access probes of a backend that is not installed, and runs none of them", async () => {
     machine({ bins: ["codex", "claude"] });
     const marker = join(binDir(), "docker-ran");
@@ -806,7 +813,7 @@ describe("doctor", () => {
     expect(check(none, "access:codex")?.word).toBe("not installed");
     expect(check(none, "sandbox:codex")).toBeUndefined();
     expect(existsSync(marker)).toBe(false);
-  });
+  }, 30_000);
 
   it("names a failed probe by its last stderr line, not stdout's or Bun's version trailer", async () => {
     machine();
@@ -861,6 +868,7 @@ describe("doctor", () => {
     expect(r.find((p) => p.id === "temp")?.why).toBe("the probe shell did not start");
   });
 
+  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
   it("tests a Jev key, and skips Jev when the profile turns it off", async () => {
     ready();
     saveJevKey("tsk-test-key-0123456789");
@@ -876,7 +884,7 @@ describe("doctor", () => {
     });
     patchProfile("default", { jev: { use: "off" } }, { host: "claude-code" });
     expect(check(await run(), "jev")).toMatchObject({ state: "skip", word: "off" });
-  });
+  }, 30_000);
 
   it("validates linked profiles diagnostically and uses only selected profile for Jev", async () => {
     ready();
@@ -1013,6 +1021,7 @@ describe("doctor", () => {
     expect(check(r, "profile")).toMatchObject({ state: "fail", fix: `fix or delete ${overridePath()}` });
   });
 
+  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
   it("fails on an old Bun, an invalid profile, and a 0.x config", async () => {
     ready();
     expect(check(await run({ bunVersion: "1.3.11" }), "bun")).toMatchObject({
@@ -1031,7 +1040,7 @@ describe("doctor", () => {
       state: "fail",
       fix: "run catherd init, which moves 0.x files aside and writes 1.0 ones",
     });
-  });
+  }, 30_000);
 });
 
 it("codex_ready_other_profile_broken keeps readiness selected and does no Claude writes", async () => {
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/adapters/access.test.ts test/entry/profile-command.test.ts test/services/doctor-push.test.ts test/services/doctor.test.ts`
Expected: the per-repo sandbox test and the ladder-column assertion fail; the push-row test passes on main (it adds coverage the follow-up asked for).

- [ ] **Step 3: Implement**

````diff
diff --git a/src/adapters/backend.ts b/src/adapters/backend.ts
index 27fbadc..ef825e1 100644
--- a/src/adapters/backend.ts
+++ b/src/adapters/backend.ts
@@ -155,9 +155,10 @@ export interface BackendAdapter {
   /**
    * Spec §5 and §12: a shell that runs a command the way this backend's workspace-write worker runs one,
    * with the grants the worker gets, for doctor's access probes; a string says why it cannot be tested here.
-   * Absent: the CLI has no way to run a shell in its sandbox without a model turn (spec 1.3 §3.4).
+   * Absent: the CLI has no way to run a shell in its sandbox without a model turn (spec 1.3 §3.4). `repos`: the
+   * repositories workers run in (doctor's own and every bound one), for a backend whose sandbox is set per repo.
    */
-  accessShell?(o: { network: boolean }): Promise<AccessShell | string>;
+  accessShell?(o: { network: boolean; repos?: string[] }): Promise<AccessShell | string>;
   /** Spec §10.3: why this backend's isolation is weak; doctor warns when a profile uses it. */
   isolationNote?: string;
   /**
diff --git a/src/adapters/claude-code/index.ts b/src/adapters/claude-code/index.ts
index 8e9da36..6de8522 100644
--- a/src/adapters/claude-code/index.ts
+++ b/src/adapters/claude-code/index.ts
@@ -130,9 +130,13 @@ export function claudeSandboxOn(repo: string = process.cwd()): boolean {
  * shell, which doctor probes as is. With it on, only a model turn runs inside it, so doctor says what to
  * check instead of spending one.
  */
-async function accessShell(): Promise<AccessShell | string> {
-  if (claudeSandboxOn())
-    return "Claude Code's own sandbox is on (sandbox.enabled): catherd passes the lock, temp, loopback and Docker grants in --settings; outbound HTTPS reaches only sandbox.network.allowedDomains, so add registry.npmjs.org and the hosts your checks need there";
+async function accessShell(o: { repos?: string[] } = {}): Promise<AccessShell | string> {
+  // the setting is per repo (its .claude/settings*.json over the user's): each repo a worker runs in counts,
+  // not only the directory doctor runs in
+  const repos = o.repos?.length ? o.repos : [process.cwd()];
+  const on = repos.filter((r) => claudeSandboxOn(r));
+  if (on.length)
+    return `Claude Code's own sandbox is on (sandbox.enabled)${o.repos?.length ? ` in ${on.join(", ")}` : ""}: catherd passes the lock, temp, loopback and Docker grants in --settings; outbound HTTPS reaches only sandbox.network.allowedDomains, so add registry.npmjs.org and the hosts your checks need there`;
   return scratchShell("an unsandboxed shell (Claude Code's sandbox is off)", []);
 }
 
diff --git a/src/entry/profile-command.ts b/src/entry/profile-command.ts
index ce3709d..e4da64e 100644
--- a/src/entry/profile-command.ts
+++ b/src/entry/profile-command.ts
@@ -82,6 +82,10 @@ export function formatProfile(
     `objective ${p.objective} · jev ${p.jev.use} · heavy slots ${p.lock.heavy} · notify ${p.notify.join(", ") || "none"}`,
     "roles",
   ];
+  const accessOf = (role: Role) =>
+    `${p.roles[role].access}${p.roles[role].network === false ? " (no network)" : ""}, ${o.enforcement[role]}`;
+  // the ladders start in one column, however long the longest access text ("(no network)" included)
+  const accessWidth = Math.max(27, ...ROLES.filter((r) => p.roles[r].enabled).map((r) => accessOf(r).length));
   for (const role of ROLES) {
     const rc = p.roles[role];
     if (!rc.enabled) {
@@ -89,9 +93,7 @@ export function formatProfile(
       continue;
     }
     const ladder = rc.rungs.map((r) => (r === rc.defaultRung ? `${r} (default)` : r)).join(" → ");
-    lines.push(
-      `  ${role.padEnd(width)}  ${`${rc.access}${rc.network === false ? " (no network)" : ""}, ${o.enforcement[role]}`.padEnd(27)}  ${ladder || "no rungs"}`,
-    );
+    lines.push(`  ${role.padEnd(width)}  ${accessOf(role).padEnd(accessWidth)}  ${ladder || "no rungs"}`);
   }
   // only what catherd can run today: a backend without an adapter has nothing to bill or isolate
   const runs = ([key]: [string, unknown]) => keyRunnable(key, o.backends);
diff --git a/src/services/doctor-access.ts b/src/services/doctor-access.ts
index 66b5dfc..5ce7244 100644
--- a/src/services/doctor-access.ts
+++ b/src/services/doctor-access.ts
@@ -172,9 +172,14 @@ export function workspaceWriteNetwork(profiles: Profile[]): Map<string, boolean>
 
 /**
  * The `sandbox:codex` row (which `codex sandbox` form runs) and one `access:<backend>` row per backend; a
- * backend not in `installed` (its CLI is not on PATH) is skipped without running a probe.
+ * backend not in `installed` (its CLI is not on PATH) is skipped without running a probe. `repos`: where
+ * workers run (doctor's repo and every bound one), for a sandbox set per repo.
  */
-export async function accessChecks(profiles: Profile[], installed: ReadonlySet<string>): Promise<Check[]> {
+export async function accessChecks(
+  profiles: Profile[],
+  installed: ReadonlySet<string>,
+  repos: string[] = [],
+): Promise<Check[]> {
   const checks: Check[] = [];
   for (const [id, network] of workspaceWriteNetwork(profiles)) {
     const a = adapterFor(id);
@@ -190,7 +195,7 @@ export async function accessChecks(profiles: Profile[], installed: ReadonlySet<s
       continue;
     }
     const shell = a.accessShell
-      ? await a.accessShell({ network }).catch((e: unknown) => String(e))
+      ? await a.accessShell({ network, repos }).catch((e: unknown) => String(e))
       : `no way to run a shell in ${id}'s sandbox without a model turn; the live kit (docs/dev/live-verification.md) runs the five probes as one worker turn`;
     if (id === "codex")
       checks.push(
diff --git a/src/services/doctor.ts b/src/services/doctor.ts
index 5b9910e..e050a2d 100644
--- a/src/services/doctor.ts
+++ b/src/services/doctor.ts
@@ -294,7 +294,13 @@ export async function doctor(d: DoctorDeps): Promise<DoctorReport> {
 
   checks.push(locksCheck());
   // spec §5 and §12: which codex sandbox form runs, and the five access probes per workspace-write backend
-  checks.push(...(await accessChecks(profiles, installed)));
+  let repos: string[] = d.repo ? [d.repo] : [];
+  try {
+    repos = [...new Set([...repos, ...Object.keys(readProjects().bindings)])];
+  } catch {
+    // the config row above already reports an unreadable projects.json
+  }
+  checks.push(...(await accessChecks(profiles, installed, repos)));
 
   // spec 1.1 §13: what the shipped defaults do is info; a warning only for what a profile changed
   const full = { changed: [] as string[], shipped: [] as string[] };
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/adapters/access.test.ts test/entry/profile-command.test.ts test/services/doctor-push.test.ts test/services/doctor.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add src/adapters/backend.ts src/adapters/claude-code/index.ts src/entry/profile-command.ts src/services/doctor-access.ts src/services/doctor.ts test/adapters/access.test.ts test/entry/profile-command.test.ts test/services/doctor-push.test.ts test/services/doctor.test.ts
git commit -F - <<'EOF'
fix(doctor): the access and doctor minors: per-repo Claude sandbox, aligned ladders, push row

1.1 follow-ups, Access and doctor, and Tests. Doctor's claude-code access row reads the sandbox
setting of its own repo and every bound repo; profile show keeps the ladders in one column when a
role says "(no network)"; doctor's failed push row is tested from a real refused send; every doctor
test that runs doctor more than once gets 30 s.

<the session's attribution lines>
EOF
```

Scratch commit: `4b863b2`. Body lines stay ≤ 100 characters (commitlint). Check `git log` afterwards.

---

### Task 5: The failover and validation minors (1.1 follow-ups: Failover and validation, `network: false`; 1.3 follow-ups: the stand-in pool, paired stand-ins)

An unscored stand-in gets one warning (Ruling 19); a downgrade's fix suggests only backends the profile names (Ruling 18); `network: false` on a read-only or full role warns (Ruling 17); `rankStandIns` computes the rung's values and bar dims once; `ladderDropDims` gets a unit test; a new test pins that doctor counts implicit paired stand-ins (already so on main).

**Files:**
- Modify: `src/domain/failover.ts`
- Modify: `src/domain/profile-rules.ts`
- Modify: `test/domain/failover.test.ts`
- Modify: `test/domain/profile-rules.test.ts`
- Create: `test/services/doctor-backends.test.ts`

**Interfaces:**
- Produces: nothing exported beyond today (`downgradeAgainst` is module-private). Consumes: nothing new.

**Commit:** `fix(profile): the failover and validation minors: one unscored warning, named pools, network` (scratch `ea57745`)

- [ ] **Step 1: Write the failing tests**

Apply this diff (re-find each hunk by its context; line numbers may have moved):

````diff
diff --git a/test/domain/failover.test.ts b/test/domain/failover.test.ts
index 6ae8244..860a0c1 100644
--- a/test/domain/failover.test.ts
+++ b/test/domain/failover.test.ts
@@ -5,6 +5,7 @@ import {
   catalogRungs,
   claudeBilled,
   downgradeDims,
+  ladderDropDims,
   rankStandIns,
 } from "../../src/domain/failover.ts";
 import { BUILTIN_ROLES, DEFAULT_FAILOVER, PAIRED_FAILOVER } from "../../src/domain/profile.ts";
@@ -44,6 +45,26 @@ describe("downgradeDims", () => {
   });
 });
 
+describe("ladderDropDims (spec 1.1 §11)", () => {
+  it("names the shared dims an upper rung scores below on, only when it scores above on none", () => {
+    const c = shipped();
+    // Luna high after Sol xhigh: below it on every shared dim but repo_code, where they tie or Luna leads
+    expect(ladderDropDims(c, SOL("xhigh"), LUNA)).toEqual([
+      "terminal",
+      "honesty",
+      "agentic",
+      "steer",
+      "frontend",
+    ]);
+    // Sol medium after Luna high: lower on repo_code, higher on honesty: not down
+    expect(ladderDropDims(c, LUNA, SOL("medium"))).toEqual([]);
+    // the same rung twice, and a rung with no scores, never go down
+    expect(ladderDropDims(c, LUNA, LUNA)).toEqual([]);
+    expect(ladderDropDims(c, LUNA, "codex:not-a-model#high")).toEqual([]);
+    expect(ladderDropDims(c, "codex:not-a-model#high", LUNA)).toEqual([]);
+  });
+});
+
 describe("rankStandIns", () => {
   it("keeps stand-ins on another quota, scored, paid from a plan and no downgrade; Claude-billed last", () => {
     const c = shipped();
diff --git a/test/domain/profile-rules.test.ts b/test/domain/profile-rules.test.ts
index 9bfa61d..e48898c 100644
--- a/test/domain/profile-rules.test.ts
+++ b/test/domain/profile-rules.test.ts
@@ -266,6 +266,52 @@ describe("validateProfile: failover and ladder warnings (spec 1.1 §11)", () =>
     expect(messages(metered).some((m) => m.includes("spends Claude quota"))).toBe(false);
   });
 
+  it("says an unscored stand-in is unscored once, with no downgrade on every bar dim beside it", () => {
+    const MYSTERY = "opencode:opencode-go/mystery-1#high";
+    const v = check({ failover: { [XHIGH]: MYSTERY } });
+    expect(v.warnings.filter((w) => w.path === `failover.${XHIGH}`).map((w) => w.message)).toEqual([
+      `stand-in ${MYSTERY} is unscored and no rung is near enough to stand in for it`,
+    ]);
+  });
+
+  it("suggests a stand-in only on a backend the profile already names (1.3 follow-ups)", () => {
+    const c = catalog();
+    const validate = (patch: ProfilePatch) =>
+      validateProfile(
+        resolveProfile(applyPatch(defaultProfileDoc(), patch), "p", "claude-code"),
+        c,
+        [...BACKENDS, "cursor", "grok", "antigravity"],
+        undefined,
+        "claude-code",
+      );
+    // Sol 5.6 high's best stand-in anywhere is Cursor's Opus once Cursor bills a subscription; this profile
+    // names no Cursor rung, so the fix never sends the user there
+    const SOL56 = "codex:gpt-5.6-sol#high";
+    const billing = { cursor: "subscription" } as const;
+    const fixes = validate({ billing, failover: { [SOL56]: KIMI } })
+      .warnings.filter((w) => w.message.startsWith("downgrade:"))
+      .map((w) => w.fix);
+    expect(fixes).toHaveLength(1);
+    expect(fixes[0]).not.toContain("cursor:");
+    // named once (here as a failover stand-in elsewhere), Cursor's rungs may be suggested
+    const named = validate({ billing, failover: { [SOL56]: KIMI, [LUNA]: "cursor:claude-opus-5-5#high" } });
+    expect(named.warnings.find((w) => w.path === `failover.${SOL56}`)?.fix).toBe(
+      `catherd profile set failover.${SOL56} cursor:claude-opus-5-5#high`,
+    );
+  });
+
+  it("warns that network: false does nothing on a read-only or full role (1.1 follow-ups)", () => {
+    const v = check({ roles: { reviewer: { network: false }, worker: { network: false } } });
+    expect(v.warnings).toContainEqual({
+      path: "roles.reviewer.network",
+      message:
+        "network: false does nothing here: it applies to workspace-write roles, and reviewer runs read-only",
+      fix: "catherd profile set roles.reviewer.network null",
+    });
+    // a workspace-write role's network: false takes its grants: no warning
+    expect(v.warnings.some((w) => w.path === "roles.worker.network")).toBe(false);
+  });
+
   it("warns where a ladder goes down: a rung scoring below the one before it and above it nowhere", () => {
     const worker = ["codex:gpt-6-sol#medium", XHIGH, LUNA];
     const v = check({ roles: { worker: { rungs: worker, defaultRung: null } } });
diff --git a/test/services/doctor-backends.test.ts b/test/services/doctor-backends.test.ts
new file mode 100644
index 0000000..c1f8224
--- /dev/null
+++ b/test/services/doctor-backends.test.ts
@@ -0,0 +1,18 @@
+import { describe, expect, it } from "bun:test";
+import { tryParseRung } from "../../src/domain/ids.ts";
+import { applyPatch, defaultProfileDoc, PAIRED_FAILOVER, resolveProfile } from "../../src/domain/profile.ts";
+import { usedBackends } from "../../src/services/doctor-backends.ts";
+
+describe("usedBackends (spec 1.3 §7.3)", () => {
+  it("counts an implicit paired stand-in as failover use, so a missing pair is not an unused skip", () => {
+    const GROK = "grok:grok-4.6#high";
+    const pair = PAIRED_FAILOVER[GROK];
+    if (!pair) throw new Error("expected a paired stand-in for grok-4.6#high");
+    const doc = applyPatch(defaultProfileDoc(), {
+      roles: { worker: { rungs: [GROK], defaultRung: null } },
+    });
+    const used = usedBackends([resolveProfile(doc, "p", "claude-code")]);
+    expect(used.get("grok")).toBe("role");
+    expect(used.get(tryParseRung(pair)?.backend ?? "")).toBe("failover");
+  });
+});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/domain test/services/doctor-backends.test.ts test/services/profile-service.test.ts test/entry/profile-command.test.ts`
Expected: the unscored-stand-in, named-pool and `network: false` tests fail; the `ladderDropDims` and `usedBackends` tests pass on main (coverage the follow-ups asked for).

- [ ] **Step 3: Implement**

````diff
diff --git a/src/domain/failover.ts b/src/domain/failover.ts
index 54c64c8..1261f6c 100644
--- a/src/domain/failover.ts
+++ b/src/domain/failover.ts
@@ -45,10 +45,18 @@ export function barDims(c: Catalog, rung: string): Dim[] {
  * well: no downgrade.
  */
 export function downgradeDims(c: Catalog, rung: string, standIn: string): Dim[] {
-  const a = valuesOf(c, rung);
+  return downgradeAgainst(valuesOf(c, rung), barDims(c, rung), valuesOf(c, standIn));
+}
+
+/** downgradeDims with the rung's values and bar dims computed once, for a pool of stand-ins. */
+function downgradeAgainst(
+  a: Partial<Record<Dim, number>> | null,
+  dims: Dim[],
+  standIn: Partial<Record<Dim, number>> | null,
+): Dim[] {
   if (!a) return [];
-  const b = valuesOf(c, standIn) ?? {};
-  return barDims(c, rung).filter((d) => (b[d] ?? Number.NEGATIVE_INFINITY) < (a[d] as number));
+  const b = standIn ?? {};
+  return dims.filter((d) => (b[d] ?? Number.NEGATIVE_INFINITY) < (a[d] as number));
 }
 
 /**
@@ -85,11 +93,15 @@ export function rankStandIns(
 ): string[] {
   const from = tryParseRung(rung);
   if (!from) return [];
+  // the rung's own values and bar dims, once for the whole pool
+  const own = valuesOf(c, rung);
+  const dims = barDims(c, rung);
   const fits = [...new Set(pool)].filter((x) => {
     const r = tryParseRung(x);
-    if (!r || r.backend === "claude" || quotaOf(r) === quotaOf(from) || !valuesOf(c, x)) return false;
+    const values = r ? valuesOf(c, x) : null;
+    if (!r || r.backend === "claude" || quotaOf(r) === quotaOf(from) || !values) return false;
     if (costFor(c, billing, x).tier === 1) return false;
-    return downgradeDims(c, rung, x).length === 0;
+    return downgradeAgainst(own, dims, values).length === 0;
   });
   const gap = (x: string) => effortGap(from.effort, tryParseRung(x)?.effort ?? "");
   return fits.sort(
diff --git a/src/domain/profile-rules.ts b/src/domain/profile-rules.ts
index 7ce862f..ec52c4c 100644
--- a/src/domain/profile-rules.ts
+++ b/src/domain/profile-rules.ts
@@ -172,6 +172,13 @@ export function validateProfile(
         message: `${role} runs ${rc.access}; catherd's default for it is ${DEFAULT_ACCESS[role]}`,
       });
     if (!rc.enabled) continue;
+    // spec §5: network: false takes a workspace-write role's network grants; read-only and full have none to take
+    if (rc.network === false && rc.access !== "workspace-write")
+      warnings.push({
+        path: `${at}.network`,
+        message: `network: false does nothing here: it applies to workspace-write roles, and ${role} runs ${rc.access}`,
+        fix: `catherd profile set ${at}.network null`,
+      });
     for (const rung of rc.rungs) {
       const native = nativeClaudeIssue(rung, host, `${at}.rungs`);
       if (native) errors.push(native);
@@ -271,10 +278,18 @@ export function validateProfile(
   }
 
   const ladders = new Set(ROLES.filter((r) => p.roles[r].enabled).flatMap((r) => p.roles[r].rungs));
-  // the stand-ins catherd could run here, for the fixes below
+  // the stand-ins the fixes below may suggest: on a backend catherd runs and the profile already names (a
+  // ladder or a failover entry), never one this machine may not have (Cursor on a machine without it); a
+  // native claude: rung names claude-code too, the same Claude Code CLI
+  const named = new Set(
+    [...ladders, ...Object.keys(p.failover), ...Object.values(p.failover)].flatMap((x) => {
+      const b = tryParseRung(x)?.backend;
+      return b === undefined ? [] : b === "claude" ? [b, "claude-code"] : [b];
+    }),
+  );
   const pool = catalogRungs(c).filter((x) => {
     const r = tryParseRung(x);
-    return r !== null && backends.includes(r.backend);
+    return r !== null && backends.includes(r.backend) && named.has(r.backend);
   });
   for (const [from, to] of Object.entries(p.failover)) {
     const at = `failover.${from}`;
@@ -294,7 +309,8 @@ export function validateProfile(
       errors.push({ path: at, message: `stand-in ${to}: catherd cannot run ${b.backend} yet` });
       continue;
     }
-    if (!scoresOf(c, rungInfo(c, to).canonical))
+    const unscored = !scoresOf(c, rungInfo(c, to).canonical);
+    if (unscored)
       warnings.push({
         path: at,
         message: `stand-in ${to} is unscored and no rung is near enough to stand in for it`,
@@ -307,7 +323,8 @@ export function validateProfile(
         fix: "name a stand-in on another backend or plan",
       });
     const ranked = rankStandIns(c, p.billing, from, pool);
-    const down = downgradeDims(c, from, to);
+    // an unscored stand-in has its own warning above: no "downgrade" on every bar dim besides
+    const down = unscored ? [] : downgradeDims(c, from, to);
     if (down.length)
       warnings.push({
         path: at,
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/domain test/services/doctor-backends.test.ts test/services/profile-service.test.ts test/entry/profile-command.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add src/domain/failover.ts src/domain/profile-rules.ts test/domain/failover.test.ts test/domain/profile-rules.test.ts test/services/doctor-backends.test.ts
git commit -F - <<'EOF'
fix(profile): the failover and validation minors: one unscored warning, named pools, network

1.1 follow-ups, Failover and validation, and 1.3 follow-ups. An unscored stand-in gets its own
warning and no downgrade beside it; a downgrade's fix suggests only backends the profile already
names; validate warns that network: false does nothing on a read-only or full role; rankStandIns
reads the rung's values and bar dims once per pool. ladderDropDims gets its own unit test, and a
test pins that doctor counts an implicit paired stand-in as failover use (already so on main).

<the session's attribution lines>
EOF
```

Scratch commit: `ea57745`. Body lines stay ≤ 100 characters (commitlint). Check `git log` afterwards.

---

### Task 6: The install minors (1.1 follow-ups: Install)

`bun add -g` is killed after 120 s (Ruling 22); a current global install shadowed on PATH says so (Ruling 23); the spawned init test cannot install for real (Ruling 24).

**Files:**
- Modify: `src/services/global-install.ts`
- Modify: `test/entry/init-command.test.ts`
- Modify: `test/services/global-install.test.ts`

**Interfaces:**
- Produces: `installLimits = { timeoutMs: 120_000 }`, `run(cmd, timeoutMs?)` exported from global-install.ts. Consumes: nothing new.

**Commit:** `fix(init): bound bun add -g, and say shadowed when a current install is not first on PATH` (scratch `e661307`)

- [ ] **Step 1: Write the failing tests**

Apply this diff (re-find each hunk by its context; line numbers may have moved):

````diff
diff --git a/test/entry/init-command.test.ts b/test/entry/init-command.test.ts
index 076e935..49522f8 100644
--- a/test/entry/init-command.test.ts
+++ b/test/entry/init-command.test.ts
@@ -19,11 +19,14 @@ import { activate, patchProfile } from "../../src/services/profile-service.ts";
 import { BUILTIN_ROLES } from "../../src/domain/profile.ts";
 import { claudeAgentsDir } from "../../src/infra/paths.ts";
 import { activeName, getProfile } from "../../src/services/profile-store.ts";
-import { noPosixModes, openModes, snapshotEnv, tempRepo, withHome } from "../helpers.ts";
+import { noPosixModes, openModes, snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";
 import { SRC } from "../import-graph.ts";
 
 afterEach(snapshotEnv());
 
+/** The spawned init's BUN_INSTALL: never the user's own global folder (1.1 follow-ups). */
+const INIT_BUN_INSTALL = tempDir("catherd-bun-install-");
+
 function init(args: string[], stdin = "", cwd?: string) {
   const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), "init", ...args], {
     // no backend CLI, no Jev key and no Anthropic key: nothing reaches the network or the user's own CLIs
@@ -34,6 +37,9 @@ function init(args: string[], stdin = "", cwd?: string) {
       PATH: `/nonexistent:${join(import.meta.dir, "..", "bin")}:${join(process.execPath, "..")}:/usr/bin:/bin`,
       // bun's global bin is test/bin too, so init finds "this version installed globally" and never runs bun add -g
       BUN_INSTALL_BIN: join(import.meta.dir, "..", "bin"),
+      // and should that ever miss, bun add -g lands in a scratch folder and its registry refuses at once
+      BUN_INSTALL: INIT_BUN_INSTALL,
+      BUN_CONFIG_REGISTRY: "http://127.0.0.1:9",
       TYPESAFE_API_KEY: "",
       ARTIFICIAL_ANALYSIS_API_KEY: "",
       ANTHROPIC_API_KEY: "",
diff --git a/test/services/global-install.test.ts b/test/services/global-install.test.ts
index 995f491..72887e9 100644
--- a/test/services/global-install.test.ts
+++ b/test/services/global-install.test.ts
@@ -5,7 +5,9 @@ import { join } from "node:path";
 import {
   ensureGlobal,
   type GlobalInstallDeps,
+  installLimits,
   realGlobalInstall,
+  run,
 } from "../../src/services/global-install.ts";
 import { snapshotEnv } from "../helpers.ts";
 
@@ -46,10 +48,20 @@ describe("ensureGlobal (spec 1.1 §12)", () => {
     const { d, calls } = deps("1.1.0");
     const said: string[] = [];
     expect(await ensureGlobal("1.1.0", d, () => said.push("installing"))).toEqual({ state: "current" });
-    expect(calls).toEqual(["global"]);
+    expect(calls).toEqual(["global", "path"]);
     expect(said).toEqual([]);
   });
 
+  it("says shadowed, installing nothing, when it is current but an older catherd comes first on PATH", async () => {
+    const { d, calls } = deps("1.1.0", undefined, undefined, "1.0.0");
+    const said: string[] = [];
+    expect(await ensureGlobal("1.1.0", d, () => said.push("installing"))).toEqual({
+      state: "shadowed",
+      onPath: "1.0.0",
+    });
+    expect([calls, said]).toEqual([["global", "path"], []]);
+  });
+
   it("says it is installing before it resolves anything, installs this version, then checks PATH again", async () => {
     const { d, calls } = deps("1.0.0");
     const order: string[] = [];
@@ -132,7 +144,7 @@ describe("realGlobalInstall.globalVersion (Codex P1: under bunx, PATH finds bunx
 
   it("is current when the catherd in the global bin is this version", async () => {
     process.env.BUN_INSTALL_BIN = fakeCatherdDir("echo 1.1.0");
-    process.env.PATH = `${join(process.execPath, "..")}:/usr/bin:/bin`;
+    process.env.PATH = `${process.env.BUN_INSTALL_BIN}:${join(process.execPath, "..")}:/usr/bin:/bin`;
     expect(await realGlobalInstall.globalVersion()).toBe("1.1.0");
     const d: GlobalInstallDeps = {
       ...realGlobalInstall,
@@ -166,3 +178,12 @@ describe("realGlobalInstall.pathVersion", () => {
     expect(await realGlobalInstall.pathVersion()).toBeNull();
   });
 });
+
+describe("the install's time limit (1.1 follow-ups)", () => {
+  it("kills a command past its limit and reports it failed, without waiting on its output", async () => {
+    const r = await run(["sh", "-c", "sleep 30"], 50);
+    expect(r).toEqual({ ok: false, stdout: "", output: "-c sleep 30 timed out after 0 s" });
+    expect(await run(["sh", "-c", "echo hi"], 5_000)).toEqual({ ok: true, stdout: "hi\n", output: "hi\n" });
+    expect(installLimits.timeoutMs).toBe(120_000);
+  });
+});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/global-install.test.ts test/entry/init-command.test.ts`
Expected: the shadowed-when-current test, the call order `["global", "path"]` and the time-limit test fail.

- [ ] **Step 3: Implement**

````diff
diff --git a/src/services/global-install.ts b/src/services/global-install.ts
index d4585fe..0e63a57 100644
--- a/src/services/global-install.ts
+++ b/src/services/global-install.ts
@@ -23,19 +23,41 @@ export type GlobalInstall =
   | { state: "shadowed"; onPath: string | null }
   | { state: "failed"; reason: string };
 
-async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string; output: string }> {
+/** How long `bun add -g` may take: a blackholed or proxied registry would otherwise hold `init` for as long as Bun retries. */
+export const installLimits = { timeoutMs: 120_000 };
+
+/**
+ * `cmd` with its output. Past `timeoutMs` it is killed and reported as failed with the reason; its output is
+ * not awaited then, since a child it started may still hold the pipes open.
+ */
+export async function run(
+  cmd: string[],
+  timeoutMs?: number,
+): Promise<{ ok: boolean; stdout: string; output: string }> {
   const p = Bun.spawn(cmd, {
     env: scrubSecrets(process.env),
     stdin: "ignore",
     stdout: "pipe",
     stderr: "pipe",
   });
-  const [out, err, code] = await Promise.all([
-    new Response(p.stdout).text(),
-    new Response(p.stderr).text(),
-    p.exited,
-  ]);
-  return { ok: code === 0, stdout: out, output: `${err}${out}` };
+  const out = new Response(p.stdout).text().catch(() => "");
+  const err = new Response(p.stderr).text().catch(() => "");
+  let timer: ReturnType<typeof setTimeout> | undefined;
+  const late = new Promise<"late">((resolve) => {
+    if (timeoutMs !== undefined) timer = setTimeout(() => resolve("late"), timeoutMs);
+  });
+  const code = await Promise.race([p.exited, late]).finally(() => clearTimeout(timer));
+  if (code === "late") {
+    p.kill("SIGKILL");
+    const what = cmd.slice(1).join(" ");
+    return {
+      ok: false,
+      stdout: "",
+      output: `${what} timed out after ${Math.round((timeoutMs ?? 0) / 1000)} s`,
+    };
+  }
+  const [stdout, stderr] = await Promise.all([out, err]);
+  return { ok: code === 0, stdout, output: `${stderr}${stdout}` };
 }
 
 /** what `bin --version` prints on stdout (a warning on stderr must not make it look like another version) */
@@ -71,10 +93,12 @@ export const realGlobalInstall: GlobalInstallDeps = {
     return versionOf(Bun.which("catherd", { PATH }));
   },
   install: (version) =>
-    run([process.execPath, "add", "-g", `catherd-cli@${version}`]).catch((e: unknown) => ({
-      ok: false,
-      output: errorMessage(e),
-    })),
+    run([process.execPath, "add", "-g", `catherd-cli@${version}`], installLimits.timeoutMs).catch(
+      (e: unknown) => ({
+        ok: false,
+        output: errorMessage(e),
+      }),
+    ),
 };
 
 /**
@@ -86,7 +110,12 @@ export async function ensureGlobal(
   deps: GlobalInstallDeps,
   installing: () => void,
 ): Promise<GlobalInstall> {
-  if ((await deps.globalVersion()) === version) return { state: "current" };
+  if ((await deps.globalVersion()) === version) {
+    // current, but the launcher runs the catherd PATH finds first: another version there (or none) still
+    // makes it fall back to bunx, so say so as after an install
+    const onPath = await deps.pathVersion().catch(() => null);
+    return onPath === version ? { state: "current" } : { state: "shadowed", onPath };
+  }
   installing();
   // never rejects: a failed install is reported, and init goes on
   const r = await deps.install(version).catch((e: unknown) => ({ ok: false, output: errorMessage(e) }));
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/services/global-install.test.ts test/entry/init-command.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add src/services/global-install.ts test/entry/init-command.test.ts test/services/global-install.test.ts
git commit -F - <<'EOF'
fix(init): bound bun add -g, and say shadowed when a current install is not first on PATH

1.1 follow-ups, Install. bun add -g in init is killed after 120 s and reported failed with the
retry command; init says "shadowed" when the global catherd is current but another one comes
first on PATH (the launcher then falls back to bunx); the spawned init test gives bun a scratch
BUN_INSTALL and a registry that refuses, so a missed shim never installs for real.

<the session's attribution lines>
EOF
```

Scratch commit: `e661307`. Body lines stay ≤ 100 characters (commitlint). Check `git log` afterwards.

---

### Task 7: List models under the identity a run uses (1.3 follow-ups: discovery, grok and agy identities, doctor's grok check)

Cursor's listing never runs an `agent` that is not Cursor's (Ruling 25); an isolated grok or agy rung is checked against the key's listing, cached apart (Ruling 26); doctor's `sandbox:grok` check runs in a scratch HOME with memory and the compat toggles off (Ruling 27). The grok and agy simulators learn `keyModels`/`keyModelsFile` and grok's `callsTo`.

**Files:**
- Modify: `src/adapters/antigravity/index.ts`
- Modify: `src/adapters/cursor/index.ts`
- Modify: `src/adapters/grok/home.ts`
- Modify: `src/adapters/grok/index.ts`
- Modify: `test/adapters/antigravity.test.ts`
- Modify: `test/adapters/cursor.test.ts`
- Modify: `test/adapters/grok.test.ts`
- Modify: `test/sim/agy`
- Modify: `test/sim/grok`
- Modify: `test/sim/sim-scenarios.ts`

**Interfaces:**
- Produces: `ISOLATED_LISTING` from `src/adapters/grok/index.ts` (`"grok-isolated"`) and `src/adapters/antigravity/index.ts` (`"antigravity-isolated"`); `grokHomeEnv(home = isolatedGrokRoot())`; GrokScenario `keyModels?`, `callsTo?`; AgyScenario `keyModelsFile?`. Consumes: `discovered`.

**Commit:** `fix(adapters): list models under the identity a run uses, and only from Cursor's own agent` (scratch `88a448d`)

- [ ] **Step 1: Write the failing tests**

Apply this diff (re-find each hunk by its context; line numbers may have moved):

````diff
diff --git a/test/adapters/antigravity.test.ts b/test/adapters/antigravity.test.ts
index 9ae1af0..504c0b9 100644
--- a/test/adapters/antigravity.test.ts
+++ b/test/adapters/antigravity.test.ts
@@ -7,6 +7,7 @@ import {
   agyPrompt,
   agyShell,
   antigravityAdapter,
+  ISOLATED_LISTING,
   isolatedAgyHome,
   isolatedAgyRoot,
 } from "../../src/adapters/antigravity/index.ts";
@@ -355,6 +356,22 @@ describe("agy models, prepare and quota (spec 1.3 §6.3, §6.4, §6.6)", () => {
     expect(await prep("antigravity:gemini-3.8-flash#high", "workspace-write", true)).toBe("ok");
   });
 
+  it("checks an isolated rung against the key's own listing, cached apart from the login's (1.3 follow-ups)", async () => {
+    withHome();
+    const keyModelsFile = join(tempDir("catherd-agy-key-"), "models.txt");
+    writeFileSync(keyModelsFile, "\nAvailable models:\n  * gemini-3.7-flash (default)\n");
+    sim({ keyModelsFile });
+    process.env.GEMINI_API_KEY = "key-for-test";
+    await antigravityAdapter.probe();
+    expect(await prep("antigravity:gemini-3.8-flash#high")).toBe("ok");
+    expect(await prep("antigravity:gemini-3.8-flash#high", "workspace-write", true)).toBe(
+      "E_BACKEND_MODEL_UNKNOWN",
+    );
+    expect(await prep("antigravity:gemini-3.7-flash#max", "workspace-write", true)).toBe("ok");
+    expect(readDiscovery("antigravity")?.models.length).toBe(6);
+    expect(readDiscovery(ISOLATED_LISTING)?.models.map((m) => m.id)).toEqual(["gemini-3.7-flash"]);
+  });
+
   it("needs GEMINI_API_KEY to isolate, and writes each isolated home's settings: the provider and the access rules", async () => {
     withHome();
     sim();
diff --git a/test/adapters/cursor.test.ts b/test/adapters/cursor.test.ts
index 80e8280..92d6de9 100644
--- a/test/adapters/cursor.test.ts
+++ b/test/adapters/cursor.test.ts
@@ -309,6 +309,21 @@ describe("cursor probe (spec 1.3 §4.1, §3.3)", () => {
 });
 
 describe("cursor models and prepare (spec 1.3 §4.6, §4.4)", () => {
+  it("never asks an agent that is not Cursor's for models: it lists none (1.3 follow-ups)", async () => {
+    const calls = join(mkdtempSync(join(tmpdir(), "catherd-agent-")), "calls");
+    process.env.PATH = pathWith(
+      "agent",
+      null,
+      `#!/bin/sh\necho "$*" >> ${calls}\necho 'agent 1.0.44 (grok)'\n`,
+    );
+    expect(await cursorAdapter.listModels()).toEqual([]);
+    expect(readFileSync(calls, "utf8")).toBe("--version\n");
+    // Cursor's own CLI under the name agent still lists
+    process.env.PATH = pathWith("agent", SIM);
+    Object.assign(process.env, withCursorScenario({ modelsFile: join(FX, "models.txt") }).env);
+    expect((await cursorAdapter.listModels()).length).toBeGreaterThan(0);
+  });
+
   it("lists models from `models`, efforts folded", async () => {
     process.env.PATH = SIMS;
     Object.assign(process.env, withCursorScenario({ modelsFile: join(FX, "models.txt") }).env);
diff --git a/test/adapters/grok.test.ts b/test/adapters/grok.test.ts
index 686e29a..6460df4 100644
--- a/test/adapters/grok.test.ts
+++ b/test/adapters/grok.test.ts
@@ -4,7 +4,13 @@ import { dirname, join } from "node:path";
 import type { FinishedRun, RunRequest } from "../../src/adapters/backend.ts";
 import { readDiscovery } from "../../src/adapters/discovery.ts";
 import { grokHost, READ_TOOLS } from "../../src/adapters/grok/home.ts";
-import { GROK_INSTALL, grokAdapter, grokShell, isolatedGrokRoot } from "../../src/adapters/grok/index.ts";
+import {
+  GROK_INSTALL,
+  grokAdapter,
+  grokShell,
+  ISOLATED_LISTING,
+  isolatedGrokRoot,
+} from "../../src/adapters/grok/index.ts";
 import { isCatherdError } from "../../src/domain/errors.ts";
 import { parseRung } from "../../src/domain/ids.ts";
 import { snapshotEnv, tempDir, withHome } from "../helpers.ts";
@@ -317,6 +323,50 @@ describe("grok probe (spec 1.3 §5.1, §5.6, §3.3)", () => {
   });
 });
 
+describe("grok identities (1.3 follow-ups)", () => {
+  it("runs doctor's sandbox check in a scratch HOME, memory and the compat features off, with no key", async () => {
+    withHome();
+    process.env.PATH = SIMS;
+    onHost("linux");
+    process.env.XAI_API_KEY = "key-for-test";
+    const callsTo = join(tempDir("catherd-grok-calls-"), "calls.jsonl");
+    Object.assign(process.env, withGrokScenario({ callsTo }).env);
+    await grokAdapter.probe();
+    const calls = readFileSync(callsTo, "utf8")
+      .trim()
+      .split("\n")
+      .map((l) => JSON.parse(l) as { args: string[]; home: string; vars: Record<string, string> });
+    const check = calls.find((c) => c.args.includes("--sandbox"));
+    if (!check) throw new Error("no sandbox check ran");
+    expect(check.home).not.toBe(process.env.HOME);
+    expect(check.vars.GROK_HOME).toBe(join(check.home, ".grok"));
+    expect(check.vars).toMatchObject({
+      GROK_MEMORY: "0",
+      GROK_CLAUDE_HOOKS_ENABLED: "0",
+      GROK_CURSOR_RULES_ENABLED: "0",
+      XAI_API_KEY: "",
+    });
+  });
+
+  it("checks an isolated rung against the key's own listing, cached apart from the login's", async () => {
+    withHome();
+    process.env.PATH = SIMS;
+    process.env.GROK_HOME = tempDir("catherd-grokhome-"); // the user's, signed in with a Grok login
+    process.env.XAI_API_KEY = "key-for-test";
+    Object.assign(
+      process.env,
+      withGrokScenario({ models: ["grok-4.6", "grok-4.5"], keyModels: ["grok-4.5"] }).env,
+    );
+    const prep = (isolated: boolean, rung = "grok:grok-4.6#high") =>
+      code(grokAdapter.prepare?.({ rung: parseRung(rung), access: "read-only", isolated, repo: "/r" }));
+    expect(await prep(false)).toBe("ok");
+    expect(await prep(true)).toBe("E_BACKEND_MODEL_UNKNOWN");
+    expect(await prep(true, "grok:grok-4.5#high")).toBe("ok");
+    expect(readDiscovery("grok")?.models.map((m) => m.id)).toEqual(["grok-4.6", "grok-4.5"]);
+    expect(readDiscovery(ISOLATED_LISTING)?.models.map((m) => m.id)).toEqual(["grok-4.5"]);
+  });
+});
+
 describe("grok models and prepare (spec 1.3 §5.2, §5.3, §5.6)", () => {
   it("lists grok's models with the catalog's efforts and context", async () => {
     process.env.PATH = SIMS;
diff --git a/test/sim/agy b/test/sim/agy
index 916b288..b700b7c 100755
--- a/test/sim/agy
+++ b/test/sim/agy
@@ -28,7 +28,10 @@ if (args[0] === "models") {
   say("Fetching available models...");
   if (!loggedIn)
     fail("Error: Please sign in to view available models. Launch the CLI without arguments to sign in.");
-  if (s.modelsFile) process.stdout.write(readFileSync(s.modelsFile, "utf8"));
+  // signed in by GEMINI_API_KEY (its HOME's settings say gemini), the key's project may list other models
+  const byKey = !!process.env.GEMINI_API_KEY && settings?.modelProvider === "gemini";
+  const file = (byKey ? s.keyModelsFile : undefined) ?? s.modelsFile;
+  if (file) process.stdout.write(readFileSync(file, "utf8"));
   process.exit(s.modelsExit ?? 0);
 }
 
diff --git a/test/sim/grok b/test/sim/grok
index 0605522..19b36fe 100755
--- a/test/sim/grok
+++ b/test/sim/grok
@@ -1,7 +1,7 @@
 #!/usr/bin/env bun
 // Grok Build simulator for catherd's tests (research 2026-09-29 §3): behaviour comes from the JSON scenario in
 // CATHERD_SIM_GROK.
-import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
+import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
 import { dirname, join } from "node:path";
 
 const s = JSON.parse(readFileSync(process.env.CATHERD_SIM_GROK ?? "", "utf8")) as Record<string, any>;
@@ -20,6 +20,14 @@ const apiKey = !!process.env.XAI_API_KEY;
 // research §3.9: a Grok login is the auth.json in GROK_HOME; a GROK_HOME without one has none
 const home = process.env.GROK_HOME;
 const login = s.loggedIn !== false && (!home || existsSync(join(home, "auth.json")));
+// every call, before anything else: its arguments and the env that sets its identity and home
+if (s.callsTo) {
+  const picked = Object.keys(process.env).filter((k) => k.startsWith("GROK_") || k === "XAI_API_KEY");
+  appendFileSync(
+    s.callsTo,
+    `${JSON.stringify({ args, home: process.env.HOME ?? null, vars: Object.fromEntries(picked.map((k) => [k, process.env[k]])) })}\n`,
+  );
+}
 
 if (args[0] === "--version" || args[0] === "version") {
   say(`grok ${s.version ?? "1.0.44"} (5b807183dd79)`);
@@ -34,7 +42,8 @@ if (args[0] === "models") {
         ? "You are using XAI_API_KEY."
         : "You are not authenticated.",
   );
-  const models: string[] = s.models ?? ["grok-4.6", "grok-4.5"];
+  // an API key's account may serve other models than the login's
+  const models: string[] = (!login && apiKey ? s.keyModels : undefined) ?? s.models ?? ["grok-4.6", "grok-4.5"];
   say(`\nDefault model: ${models[0]}\n\nAvailable models:`);
   models.forEach((m, i) => say(i === 0 ? `  * ${m} (default)` : `  - ${m}`));
   process.exit(0);
diff --git a/test/sim/sim-scenarios.ts b/test/sim/sim-scenarios.ts
index 852c0a1..4c091bd 100644
--- a/test/sim/sim-scenarios.ts
+++ b/test/sim/sim-scenarios.ts
@@ -118,6 +118,10 @@ export interface GrokScenario extends Common {
   loggedIn?: boolean;
   /** the ids `grok models` lists, the first as the default (default: grok-4.6, grok-4.5) */
   models?: string[];
+  /** what `grok models` lists when only XAI_API_KEY signs it in (default: `models`) */
+  keyModels?: string[];
+  /** every call appends `{ args, home, vars }` here first, vars being GROK_* and XAI_API_KEY */
+  callsTo?: string;
   /** this "Mac"'s /var/run/docker.sock is a symlink: read-only and strict refuse to start (research §3.6) */
   socketSymlink?: boolean;
   /** the sandbox a resumed session started with; another `--sandbox` on `-r` is refused */
@@ -133,6 +137,8 @@ export interface AgyScenario extends Common {
   loggedIn?: boolean;
   /** what `agy models` prints after its first line: this file's text */
   modelsFile?: string;
+  /** what it prints instead when GEMINI_API_KEY signs it in (its HOME's settings say gemini) */
+  keyModelsFile?: string;
   /** the exit code of a logged-in `agy models` (default 0) */
   modelsExit?: number;
   /** flags this "older" agy does not know (`--disable-slash-commands`) */
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/adapters/cursor.test.ts test/adapters/grok.test.ts test/adapters/antigravity.test.ts test/sim`
Expected: the non-Cursor `agent` test (it runs `agent models` today), both isolated-listing tests and the scratch-HOME test fail.

- [ ] **Step 3: Implement**

````diff
diff --git a/src/adapters/antigravity/index.ts b/src/adapters/antigravity/index.ts
index 055b65b..df259a7 100644
--- a/src/adapters/antigravity/index.ts
+++ b/src/adapters/antigravity/index.ts
@@ -102,11 +102,20 @@ function plan(r: RunRequest): SpawnPlan {
   };
 }
 
-async function listModels(): Promise<DiscoveredModel[]> {
-  const r = await runCli("agy", ["models"], { ...agyShell, env: ENV });
+/** `agy models` under `env`: the user's HOME (its Google login) by default, an isolated one with the key. */
+async function listAs(env: Record<string, string> = {}): Promise<DiscoveredModel[]> {
+  const r = await runCli("agy", ["models"], { ...agyShell, env: { ...ENV, ...env } });
   return r?.ok ? parseAgyModels(r.out) : [];
 }
 
+const listModels = (): Promise<DiscoveredModel[]> => listAs();
+
+/**
+ * The discovery cache an isolated run is judged by: the listing under catherd's isolated HOME, where
+ * GEMINI_API_KEY signs agy in, apart from the native login's (1.3 follow-ups: the two may serve differently).
+ */
+export const ISOLATED_LISTING = "antigravity-isolated";
+
 /**
  * Spec 1.3 §6.3, §6.4, §9 Q2: read-only runs only isolated; an isolated run needs GEMINI_API_KEY and gets its
  * home and settings; a native one needs agy's own login; the rung's model and effort must be ones agy lists.
@@ -137,7 +146,13 @@ async function prepare(req: {
       { fix: LOGIN_FIX },
     );
   const { model, effort } = req.rung;
-  const models = await discovered("antigravity", listModels, { maxAgeMs: DAY_MS, need: model });
+  // an isolated run signs in with the key, so its model is checked against the key's own listing
+  const models = req.isolated
+    ? await discovered(ISOLATED_LISTING, () => listAs(agyHomeEnv(req.access, req.network !== false)), {
+        maxAgeMs: DAY_MS,
+        need: model,
+      })
+    : await discovered("antigravity", listModels, { maxAgeMs: DAY_MS, need: model });
   if (models.length === 0) return; // agy listed nothing: let the run itself say what is wrong
   const m = models.find((x) => x.id === model);
   if (!m)
diff --git a/src/adapters/cursor/index.ts b/src/adapters/cursor/index.ts
index c80fed1..141b939 100644
--- a/src/adapters/cursor/index.ts
+++ b/src/adapters/cursor/index.ts
@@ -100,7 +100,13 @@ function plan(r: RunRequest): SpawnPlan {
 }
 
 async function listModels(): Promise<DiscoveredModel[]> {
-  const r = await runCli(cursorBin(), ["models"], { ...cursorShell, env: { NO_OPEN_BROWSER: "1" } });
+  const bin = cursorBin();
+  // an `agent` that is not Cursor's (grok's, say) is never asked for models: nothing to list, as when absent
+  if (bin === "agent") {
+    const v = await runCli(bin, ["--version"], cursorShell).catch(() => null);
+    if (!v || !CURSOR_VERSION.test(v.out)) return [];
+  }
+  const r = await runCli(bin, ["models"], { ...cursorShell, env: { NO_OPEN_BROWSER: "1" } });
   return r?.ok ? parseCursorModels(r.out) : [];
 }
 
diff --git a/src/adapters/grok/home.ts b/src/adapters/grok/home.ts
index b90f5ed..80b967e 100644
--- a/src/adapters/grok/home.ts
+++ b/src/adapters/grok/home.ts
@@ -21,9 +21,9 @@ const COMPAT = ["CLAUDE", "CURSOR"].flatMap((tool) =>
 /**
  * Spec 1.3 §5.4: an isolated run's env. GROK_HOME and the toggles alone still load the user's Claude Code
  * plugins, agents and permission rules (research §3.8 [run]), so HOME moves too, and GROK_HOME lives in it.
+ * `home`: another root than the isolated runs' (doctor's sandbox check runs in a scratch one).
  */
-export function grokHomeEnv(): Record<string, string> {
-  const home = isolatedGrokRoot();
+export function grokHomeEnv(home = isolatedGrokRoot()): Record<string, string> {
   return {
     ...movedHomeEnv(home),
     GROK_HOME: join(home, ".grok"),
diff --git a/src/adapters/grok/index.ts b/src/adapters/grok/index.ts
index 2696df5..73df770 100644
--- a/src/adapters/grok/index.ts
+++ b/src/adapters/grok/index.ts
@@ -125,11 +125,20 @@ function shippedOnGrok(): ShippedGrok {
   return shipped;
 }
 
-async function listModels(): Promise<DiscoveredModel[]> {
-  const r = await runCli("grok", ["models"], { ...grokShell, env: NO_UPDATE });
+/** `grok models` under `env`: the user's GROK_HOME (its login) by default, catherd's isolated one with the key. */
+async function listAs(env: Record<string, string>): Promise<DiscoveredModel[]> {
+  const r = await runCli("grok", ["models"], { ...grokShell, env });
   return r?.ok ? parseGrokModels(r.out, shippedOnGrok()).models : [];
 }
 
+const listModels = (): Promise<DiscoveredModel[]> => listAs(NO_UPDATE);
+
+/**
+ * The discovery cache an isolated run is judged by: the listing under catherd's own GROK_HOME, where only
+ * XAI_API_KEY signs grok in, apart from the native login's (1.3 follow-ups: the two accounts may differ).
+ */
+export const ISOLATED_LISTING = "grok-isolated";
+
 /**
  * Spec 1.3 §5.3–§5.4: an isolated run needs XAI_API_KEY (its home holds no login, and the user's auth.json is
  * never copied: its refresh token rotates, research §3.9); a workspace-write run needs catherd-ws in the
@@ -150,7 +159,13 @@ async function prepare(req: {
   if (req.isolated) ensurePrivateDir(home);
   if (req.access === "workspace-write") writeGrokProfiles(home);
   const { model, effort } = req.rung;
-  const models = await discovered("grok", listModels, { maxAgeMs: DAY_MS, need: model });
+  // an isolated run signs in with the key, so its model is checked against the key's own listing
+  const models = req.isolated
+    ? await discovered(ISOLATED_LISTING, () => listAs({ ...NO_UPDATE, ...grokHomeEnv() }), {
+        maxAgeMs: DAY_MS,
+        need: model,
+      })
+    : await discovered("grok", listModels, { maxAgeMs: DAY_MS, need: model });
   if (models.length === 0) return; // grok listed nothing: let the run itself say what is wrong
   const m = models.find((x) => x.id === model);
   if (!m)
@@ -241,7 +256,9 @@ async function sandboxInfo(): Promise<{ id: string; label: string; detail: strin
     const r = await runCli(
       "grok",
       ["-p", "hi", "--output-format", "streaming-json", "--sandbox", "read-only", "--no-auto-update"],
-      { ...grokShell, env: { ...NO_UPDATE, GROK_HOME: home, XAI_API_KEY: "" } },
+      // a scratch HOME as well as GROK_HOME, with memory and the compat features off: nothing of the user's
+      // own Claude Code or Cursor setup loads into the check (1.3 follow-ups)
+      { ...grokShell, env: { ...NO_UPDATE, ...grokHomeEnv(home), XAI_API_KEY: "" } },
     );
     if (!r) return null;
     const refused = /could not apply the '?read-only'? sandbox profile/.test(r.err);
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/adapters/cursor.test.ts test/adapters/grok.test.ts test/adapters/antigravity.test.ts test/sim && bun run typecheck && bun run lint && bun run format:check`
Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add src/adapters/antigravity/index.ts src/adapters/cursor/index.ts src/adapters/grok/home.ts src/adapters/grok/index.ts test/adapters/antigravity.test.ts test/adapters/cursor.test.ts test/adapters/grok.test.ts test/sim/agy test/sim/grok test/sim/sim-scenarios.ts
git commit -F - <<'EOF'
fix(adapters): list models under the identity a run uses, and only from Cursor's own agent

1.3 follow-ups. Cursor's listing never runs an `agent` whose --version is not Cursor's; an isolated
grok or agy run is checked against the listing its API key gets (cached apart, as grok-isolated
and antigravity-isolated), not the native login's; doctor's sandbox:grok check runs in a scratch
HOME with memory and the Claude Code and Cursor compat features off.

<the session's attribution lines>
EOF
```

Scratch commit: `88a448d`. Body lines stay ≤ 100 characters (commitlint). Check `git log` afterwards.

---

### Task 8: catherd's sandbox.toml block and grok's session id (1.3 follow-ups: sandbox.toml, links, `sessionFor`)

The block is rewritten where it stands and keeps its existing roots that still exist (Ruling 28); a link catherd cannot follow, read or write is `E_CONFIG_INVALID` (Ruling 29); `sessionFor` hashes the dispatch id (Ruling 30). Runs after Task 7 (same grok files).

**Files:**
- Modify: `src/adapters/grok/home.ts`
- Modify: `src/adapters/grok/index.ts`
- Modify: `test/adapters/grok-home.test.ts`
- Modify: `test/adapters/grok.test.ts`

**Interfaces:**
- Produces: nothing new exported. Consumes: nothing new.

**Commit:** `fix(grok): rewrite catherd's sandbox.toml block in place, merge roots, refuse odd links cleanly` (scratch `b4f1a29`)

- [ ] **Step 1: Write the failing tests**

Apply this diff (re-find each hunk by its context; line numbers may have moved):

````diff
diff --git a/test/adapters/grok-home.test.ts b/test/adapters/grok-home.test.ts
index 1d8c001..703ec2f 100644
--- a/test/adapters/grok-home.test.ts
+++ b/test/adapters/grok-home.test.ts
@@ -106,8 +106,9 @@ describe("catherd's tables in a sandbox.toml (spec 1.3 §5.3, §9 Q3)", () => {
     const text = "text" in once ? once.text : "";
     const after = `${text}[profiles.late]\nextends = "strict"\n`;
     const twice = withCatherdProfiles(after, { "catherd-ws": { extends: "workspace", read_write: ["/b"] } });
+    // rewritten where it stands (1.3 follow-ups); /a no longer exists, so it does not stay
     expect("text" in twice && twice.text).toBe(
-      `${mine}[profiles.late]\nextends = "strict"\n\n# >>> catherd's sandbox profiles for its grok workers: catherd rewrites this block, so edit outside it\n[profiles.catherd-ws]\nextends = "workspace"\nread_write = ["/b"]\n# <<< catherd\n`,
+      `${mine}\n# >>> catherd's sandbox profiles for its grok workers: catherd rewrites this block, so edit outside it\n[profiles.catherd-ws]\nextends = "workspace"\nread_write = ["/b"]\n# <<< catherd\n[profiles.late]\nextends = "strict"\n`,
     );
     expect(Bun.TOML.parse("text" in twice ? twice.text : "")).toMatchObject({
       profiles: {
@@ -118,6 +119,23 @@ describe("catherd's tables in a sandbox.toml (spec 1.3 §5.3, §9 Q3)", () => {
     });
   });
 
+  it("keeps a bare key after the block in the table it was in, and two catherd homes' roots in one block", () => {
+    const a = tempDir("catherd-root-a-");
+    const b = tempDir("catherd-root-b-");
+    const ws = (roots: string[]) => ({ "catherd-ws": { extends: "workspace", read_write: roots } });
+    const first = withCatherdProfiles('[profiles.dev]\nextends = "devbox"\n', ws([a]));
+    const text = `${"text" in first ? first.text : ""}note = "mine"\n`;
+    const before = Bun.TOML.parse(text) as { profiles: Record<string, Record<string, unknown>> };
+    // another catherd home rewrites the block: its roots join ours, and the user's key stays where it was
+    const second = withCatherdProfiles(text, ws([b]));
+    const out = "text" in second ? second.text : "";
+    const parsed = Bun.TOML.parse(out) as { profiles: Record<string, Record<string, unknown>> };
+    expect(parsed.profiles["catherd-ws"]).toEqual({ ...before.profiles["catherd-ws"], read_write: [a, b] });
+    expect(parsed.profiles.dev).toEqual(before.profiles.dev);
+    // and the first home finds nothing to change: no back-and-forth
+    expect(withCatherdProfiles(out, ws([a]))).toEqual({ text: out });
+  });
+
   it("refuses a file that is not TOML, a catherd- profile of the user's own, and a lost block marker", () => {
     expect(withCatherdProfiles("[profiles\n")).toMatchObject({
       why: expect.stringContaining("not valid TOML"),
@@ -175,4 +193,44 @@ describe("a sandbox.toml that is a link (plan 16 final review, Important 1)", ()
     expect(text).toContain("[profiles.mine]");
     expect(text).toContain("catherd-ws");
   });
+
+  it("refuses a link it cannot follow or a file it cannot write with E_CONFIG_INVALID and the isolate fix", () => {
+    withHome();
+    const refusal = (home: string) => {
+      try {
+        writeGrokProfiles(home);
+      } catch (e) {
+        return isCatherdError(e) ? [e.code, e.message, e.fix] : [String(e)];
+      }
+      return ["wrote"];
+    };
+    const dangling = tempDir("catherd-grok-dangling-");
+    symlinkSync(join(dangling, "gone", "sandbox.toml"), join(dangling, "sandbox.toml"));
+    expect(refusal(dangling)).toEqual([
+      "E_CONFIG_INVALID",
+      `catherd will not edit ${join(dangling, "sandbox.toml")}: it is a link catherd cannot follow (ENOENT)`,
+      `fix ${join(dangling, "sandbox.toml")}, or isolate grok (catherd profile set harness.grok.isolated true)`,
+    ]);
+    // a link to something that is not a file
+    const odd = tempDir("catherd-grok-odd-");
+    symlinkSync(tempDir("catherd-grok-dir-"), join(odd, "sandbox.toml"));
+    expect(refusal(odd)[0]).toBe("E_CONFIG_INVALID");
+    expect(refusal(odd)[1]).toEndWith(": catherd cannot read it (EISDIR)");
+    // a link into a read-only store: catherd's atomic write cannot replace the file there
+    const store = tempDir("catherd-grok-store-");
+    writeFileSync(join(store, "sandbox.toml"), "");
+    chmodSync(store, 0o555);
+    const home = tempDir("catherd-grok-ro-");
+    symlinkSync(join(store, "sandbox.toml"), join(home, "sandbox.toml"));
+    try {
+      const [code, message] = refusal(home);
+      // root writes anywhere: then the write goes through, as it would for that user
+      if (code !== "wrote") {
+        expect(code).toBe("E_CONFIG_INVALID");
+        expect(message).toMatch(/: catherd cannot write it \(E[A-Z]+\)$/);
+      }
+    } finally {
+      chmodSync(store, 0o755);
+    }
+  });
 });
diff --git a/test/adapters/grok.test.ts b/test/adapters/grok.test.ts
index 6460df4..0dc8c0f 100644
--- a/test/adapters/grok.test.ts
+++ b/test/adapters/grok.test.ts
@@ -10,6 +10,7 @@ import {
   grokShell,
   ISOLATED_LISTING,
   isolatedGrokRoot,
+  sessionFor,
 } from "../../src/adapters/grok/index.ts";
 import { isCatherdError } from "../../src/domain/errors.ts";
 import { parseRung } from "../../src/domain/ids.ts";
@@ -324,6 +325,14 @@ describe("grok probe (spec 1.3 §5.1, §5.6, §3.3)", () => {
 });
 
 describe("grok identities (1.3 follow-ups)", () => {
+  it("derives a run's session from its dispatch id alone, wherever the data dir resolves", () => {
+    const id = "20261002-101500-ab12cd";
+    const a = sessionFor({ dispatchDir: `/var/data/runs/r/roles/worker-M1.L1/${id}` });
+    expect(sessionFor({ dispatchDir: `/private/var/data/runs/r/roles/worker-M1.L1/${id}` })).toBe(a);
+    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
+    expect(sessionFor({ dispatchDir: "/var/data/runs/r/roles/worker-M1.L1/other" })).not.toBe(a);
+  });
+
   it("runs doctor's sandbox check in a scratch HOME, memory and the compat features off, with no key", async () => {
     withHome();
     process.env.PATH = SIMS;
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/adapters/grok-home.test.ts test/adapters/grok.test.ts test/adapters/grok.contract.test.ts test/services/grok-dispatch.test.ts`
Expected: the in-place rewrite (the old test's expectation changes with it), the two-homes test, the link refusals and the `sessionFor` test fail.

- [ ] **Step 3: Implement**

````diff
diff --git a/src/adapters/grok/home.ts b/src/adapters/grok/home.ts
index 80b967e..f7e7466 100644
--- a/src/adapters/grok/home.ts
+++ b/src/adapters/grok/home.ts
@@ -82,10 +82,47 @@ const tomlError = (text: string): string | null => {
   }
 };
 
+/** The `read_write` roots of each profile in catherd's block as it stands, by profile name. */
+function blockRoots(block: string): Record<string, string[]> {
+  try {
+    const p =
+      (Bun.TOML.parse(block) as { profiles?: Record<string, { read_write?: unknown }> }).profiles ?? {};
+    return Object.fromEntries(
+      Object.entries(p).map(([k, v]) => [
+        k,
+        Array.isArray(v.read_write) ? v.read_write.filter((r): r is string => typeof r === "string") : [],
+      ]),
+    );
+  } catch {
+    return {};
+  }
+}
+
+/**
+ * `profiles` with each one's `read_write` merged into the block's current roots: those that still exist, in
+ * their order, then the new ones. Two catherd homes on one machine (another CATHERD_HOME, other lock dirs) then
+ * converge on one block instead of rewriting each other's.
+ */
+function mergedProfiles(
+  profiles: Record<string, Record<string, unknown>>,
+  was: Record<string, string[]>,
+): Record<string, Record<string, unknown>> {
+  return Object.fromEntries(
+    Object.entries(profiles).map(([name, p]) => {
+      const mine = Array.isArray(p.read_write) ? (p.read_write as string[]) : [];
+      const kept = (was[name] ?? []).filter((r) => existsSync(r));
+      const roots = [...new Set([...kept, ...mine])];
+      return [name, { ...p, read_write: roots }];
+    }),
+  );
+}
+
 /**
- * `text` (a sandbox.toml) with catherd's marked block set to `profiles`: the old block cut out, the new one
- * appended. Outside the block only trailing blank lines change. `why` when catherd must not write: the file
- * is not TOML, defines a `catherd-*` profile of its own, or has lost the block's end marker.
+ * `text` (a sandbox.toml) with catherd's marked block set to `profiles`: rewritten where it stands, or appended
+ * when there is none. A rewrite in place keeps every line outside the block, and what each line belongs to: a
+ * bare key the user put after the block stays in the table it was in. The block's existing roots that still
+ * exist stay (mergedProfiles). `why` when catherd must not write: the file is not TOML, defines a `catherd-*`
+ * profile of its own, or has lost the block's end marker.
  */
 export function withCatherdProfiles(
   text: string,
@@ -95,21 +132,22 @@ export function withCatherdProfiles(
   const end = start === -1 ? -1 : text.indexOf(END, start);
   if (start !== -1 && end === -1)
     return { why: `catherd's block has lost its end marker (${END}): delete the block` };
-  // the block goes with the blank line catherd put before it
-  const rest =
-    start === -1
-      ? text
-      : text.slice(0, start).replace(/\n\n$/, "\n") + text.slice(end + END.length).replace(/^\r?\n/, "");
+  const after = start === -1 ? "" : text.slice(end + END.length).replace(/^\r?\n/, "");
+  // the file without the block, for the checks: the block goes with the blank line catherd put before it
+  const rest = start === -1 ? text : text.slice(0, start).replace(/\n\n$/, "\n") + after;
   const bad = tomlError(rest);
   if (bad) return { why: `it is not valid TOML (${bad})` };
   const own = Object.keys((Bun.TOML.parse(rest) as { profiles?: object }).profiles ?? {}).find((k) =>
     k.startsWith("catherd-"),
   );
   if (own) return { why: `it has a [profiles.${own}] of its own: rename it, catherd's tables are catherd-*` };
+  const was = start === -1 ? {} : blockRoots(text.slice(start, end));
+  const block = `${HEADER}\n${Bun.TOML.stringify({ profiles: mergedProfiles(profiles, was) })}${END}\n`;
   const head = rest.trimEnd();
-  const out = `${head ? `${head}\n\n` : ""}${HEADER}\n${Bun.TOML.stringify({ profiles })}${END}\n`;
-  const after = tomlError(out);
-  return after ? { why: `it is not valid TOML with catherd's tables added (${after})` } : { text: out };
+  const out =
+    start === -1 ? `${head ? `${head}\n\n` : ""}${block}` : `${text.slice(0, start)}${block}${after}`;
+  const broken = tomlError(out);
+  return broken ? { why: `it is not valid TOML with catherd's tables added (${broken})` } : { text: out };
 }
 
 /**
@@ -119,14 +157,31 @@ export function withCatherdProfiles(
  */
 export function writeGrokProfiles(home: string): void {
   const path = join(home, "sandbox.toml");
-  // a link (a dotfiles repo) stays a link: the atomic rename goes to the file it points at
-  const file = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathSync(path) : path;
-  const was = existsSync(file) ? readFileSync(file, "utf8") : "";
-  const next = withCatherdProfiles(was);
-  if ("why" in next)
-    throw new CatherdError("E_CONFIG_INVALID", `catherd will not edit ${file}: ${next.why}`, {
+  const refuse = (file: string, why: string) =>
+    new CatherdError("E_CONFIG_INVALID", `catherd will not edit ${file}: ${why}`, {
       fix: `fix ${file}, or isolate grok (catherd profile set harness.grok.isolated true)`,
     });
+  // a link (a dotfiles repo) stays a link: the atomic rename goes to the file it points at
+  let file = path;
+  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
+    try {
+      file = realpathSync(path);
+    } catch (e) {
+      throw refuse(path, `it is a link catherd cannot follow (${(e as NodeJS.ErrnoException).code ?? e})`);
+    }
+  let was = "";
+  try {
+    was = existsSync(file) ? readFileSync(file, "utf8") : "";
+  } catch (e) {
+    throw refuse(file, `catherd cannot read it (${(e as NodeJS.ErrnoException).code ?? e})`);
+  }
+  const next = withCatherdProfiles(was);
+  if ("why" in next) throw refuse(file, next.why);
   if (next.text === was) return;
-  writeTextAtomic(file, next.text, { mode: existsSync(file) ? statSync(file).mode & 0o777 : 0o600 });
+  try {
+    writeTextAtomic(file, next.text, { mode: existsSync(file) ? statSync(file).mode & 0o777 : 0o600 });
+  } catch (e) {
+    // a read-only store (a Nix home, say) or a folder catherd may not write
+    throw refuse(file, `catherd cannot write it (${(e as NodeJS.ErrnoException).code ?? e})`);
+  }
 }
diff --git a/src/adapters/grok/index.ts b/src/adapters/grok/index.ts
index 73df770..5995972 100644
--- a/src/adapters/grok/index.ts
+++ b/src/adapters/grok/index.ts
@@ -1,5 +1,5 @@
 import { mkdtempSync, readFileSync, rmSync } from "node:fs";
-import { join } from "node:path";
+import { basename, join } from "node:path";
 import { CatherdError } from "../../domain/errors.ts";
 import type { Rung } from "../../domain/ids.ts";
 import type { Access, RunStatus } from "../../domain/record.ts";
@@ -57,11 +57,13 @@ const NO_UPDATE = { GROK_DISABLE_AUTOUPDATER: "1" };
 export const grokShell = { timeoutMs: 15_000 };
 
 /**
- * A fresh run's session id (`-s`), derived from its dispatch dir so finalize knows it without the stream: a run
- * killed before grok's `end` (a timeout, a cancel) still records the session grok saved (plan 16 final review).
+ * A fresh run's session id (`-s`), derived from its dispatch id (the dispatch dir's last part) so finalize knows
+ * it without the stream: a run killed before grok's `end` (a timeout, a cancel) still records the session grok
+ * saved (plan 16 final review). The id alone, not the full path: a data dir reached by another path (a link,
+ * `/private/var` for `/var`) gives the same session.
  */
 export function sessionFor(r: Pick<RunRequest, "dispatchDir">): string {
-  const h = new Bun.CryptoHasher("sha256").update(r.dispatchDir).digest("hex");
+  const h = new Bun.CryptoHasher("sha256").update(basename(r.dispatchDir)).digest("hex");
   const variant = ((Number.parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16);
   return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
 }
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/adapters/grok-home.test.ts test/adapters/grok.test.ts test/adapters/grok.contract.test.ts test/services/grok-dispatch.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add src/adapters/grok/home.ts src/adapters/grok/index.ts test/adapters/grok-home.test.ts test/adapters/grok.test.ts
git commit -F - <<'EOF'
fix(grok): rewrite catherd's sandbox.toml block in place, merge roots, refuse odd links cleanly

1.3 follow-ups. The block is rewritten where it stands, so a bare key after it keeps its table;
the block's roots that still exist stay, so two catherd homes on one machine converge instead of
rewriting each other; a link catherd cannot follow, read or write is E_CONFIG_INVALID with the
isolate fix; a run's grok session id hashes its dispatch id alone.

<the session's attribution lines>
EOF
```

Scratch commit: `b4f1a29`. Body lines stay ≤ 100 characters (commitlint). Check `git log` afterwards.

---

### Task 9: The docs (1.0.0 fresh install: silent first bunx; 1.1 follow-ups: Docs, §9 check 5, the live bunx check; 1.2: catalog list's text; 1.3: agy's readiness window)

README: why the first `bunx` is silent and `bun add -g` first (Ruling 32), agy's 10-minute sign-in window (Ruling 31). MIGRATION: `catalog list`'s 1.2 text shape and `--json` (Ruling 35). live-verification: a headless verifier's minutes from `runs.jsonl`, "at least three" worker folders, and §15 with the bunx and blackholed-registry install checks (Ruling 33). Docs only: no test.

**Files:**
- Modify: `MIGRATION.md`
- Modify: `README.md`
- Modify: `docs/dev/live-verification.md`

**Interfaces:**
- None.

**Commit:** `docs: the install, agy and live-kit notes from the minors sweep` (scratch `781e02e`)

- [ ] **Step 1: Edit**

````diff
diff --git a/MIGRATION.md b/MIGRATION.md
index 7621d35..d2a6d45 100644
--- a/MIGRATION.md
+++ b/MIGRATION.md
@@ -86,7 +86,8 @@ and steer from GPT-5.6 Luna at the same effort until Arena scores it.
 
 - `route` returns `provenance`: each threshold, the value used, its confidence, source and date, the rung's speed
   and cost facts and its run evidence. `catalog_query` and `catherd catalog list` show values' sources and each
-  rung's run evidence.
+  rung's run evidence. The text `catherd catalog list` prints changed shape (a values line, then `runs:`): a script
+  that scraped it should read `catherd catalog list --json` instead.
 - In the dashboard's Profiles tab, `r` syncs the sources (and lists the backends' models) and shows each source's
   age and last error, `i` shows a rung's values and runs, and `t` opens the treat-like picker with the three
   nearest stand-ins first.
diff --git a/README.md b/README.md
index 7498a85..7ecef82 100644
--- a/README.md
+++ b/README.md
@@ -92,7 +92,9 @@ grok keeps a session on the access it started with, so catherd refuses to resume
 An Antigravity rung names the model `agy models` lists, without an effort suffix; the effort is agy's `--effort`
 (`low`, `medium`, `high` or `max`), and `#default` passes none: `antigravity:gemini-3.8-flash#low`. No profile uses
 Antigravity until you put a rung on it. catherd never runs `agy -p` while agy is signed out, since agy would open a
-browser and wait; `catherd doctor` says so, with the fix. A Google login draws on your plan's quota (doctor shows
+browser and wait; `catherd doctor` says so, with the fix. A sign-in check that passed is kept for 10 minutes, so
+after you sign agy out, restart the catherd MCP server (or wait those minutes) before the next Antigravity dispatch.
+A Google login draws on your plan's quota (doctor shows
 what is left); `GEMINI_API_KEY` bills the Gemini API project. Gemini rungs fail over between Antigravity and Cursor
 when either runs out, unless your profile names another stand-in.
 
@@ -122,7 +124,9 @@ catherd init --host claude-code
 The npm package is `catherd-cli`; the command it installs is `catherd`. `bunx catherd-cli init --host claude-code`
 works too (a terminal with no host evidence cannot pick the architect/verifier defaults, so name the host): `init`
 installs the global command at its own version (`--no-global` skips it) and says `installing catherd…` before
-it does, though the first `bunx` resolve itself prints nothing for up to half a minute. `init` asks for the
+it does, though the first `bunx` resolve itself prints nothing for up to half a minute: bunx fetches about a
+hundred packages before catherd's first line, TypeScript among them (a peer dependency of OpenTUI's native
+layer, which Bun installs), so `bun add -g catherd-cli` first is the quicker start. `init` asks for the
 optional Jev key and the optional Artificial Analysis key, syncs the public model sources, writes the default
 profile and links its Claude agents, lists your backends' models, and ends with a readiness report (`--no-input`
 asks nothing and keeps what exists; `--profile <name>` sets up and activates that profile instead of `default`;
diff --git a/docs/dev/live-verification.md b/docs/dev/live-verification.md
index ede789a..6c4f9ad 100644
--- a/docs/dev/live-verification.md
+++ b/docs/dev/live-verification.md
@@ -363,8 +363,9 @@ Look for, one at a time:
    `jq -r 'select(.role) | "\(.role) \(.name) \(.status)"' "$run/agents.jsonl"` a verifier row naming each
    milestone.
 5. A worker ran `bun install` and its tests itself:
-   `grep -l 'bun test' "$run"/roles/*/*/events.jsonl` names three dispatch folders
-   (`roles/<name>/<dispatch>/events.jsonl`: the folder above each is a worker's name), and no `bun test` appears
+   `grep -l 'bun test' "$run"/roles/*/*/events.jsonl` names at least three dispatch folders, one per worker lane
+   (a reviewer or verifier that runs `bun test` adds its own; `roles/<name>/<dispatch>/events.jsonl`: the folder
+   above each is the role's name), and no `bun test` appears
    in the orchestrator's own tool calls in `run.jsonl`.
 6. Replies carry STATUS: `catherd runs show "$(basename "$run")" --json | jq -r '.records[].replyStatus'` prints
    no `null`.
@@ -385,8 +386,10 @@ then, since `totals.wallMinutes` counts from the run's start to the moment you a
 ```sh
 run="$(catherd runs list --json | jq -r '.runs[0].id')"
 catherd status "$run" --json | jq '.runs[0] | {wallMinutes: .totals.wallMinutes, notOk: .totals.notOk, milestones}'
+dir="$(ls -dt ~/.local/share/catherd/repos/*/runs/"$run"/ | head -1)"
+# a native verifier (a Claude subagent) is in agents.jsonl, a headless one (claude-code:, codex:) in runs.jsonl
 jq -r 'select(.role == "verifier") | "\(.name) \(.status) \((.secs // 0) / 60 | floor) min"' \
-  "$(ls -dt ~/.local/share/catherd/repos/*/runs/"$run"/ | head -1)agents.jsonl"
+  "${dir}agents.jsonl" "${dir}runs.jsonl"
 ```
 
 Write down: the total minutes, the verifier's minutes and how many gate items it carried over (`carried over
@@ -924,3 +927,18 @@ catherd runs retry-push <run> <name> --event '<exact event ID>' --acknowledge-po
 Preserve all event IDs through retry/coalescing; duplicate input remains an idempotent record read. The actual catherd record and reviewer/verifier gate, not a forged or echoed envelope, determine what can land. Record accepted, ambiguous, failed and collected states separately, and retain unread work on failures.
 
 The controller records exact commands, hashes, actual host observations, deviations and unverified cases in the acceptance report. Release stays held until the real packaged flow passes in both Codex surfaces and Claude Code, including busy ordering and the unchanged gate. No daemon research, fixture, skipped test, source-only skill read or isolated handshake marks an installed skill flow passed. Keep the existing Changesets/stamp/release tooling; this section authorizes neither CI nor publication.
+
+## 15. Install checks from the minors sweep (1.5, plan 26)
+
+Two behaviours only a real install shows. On a machine with a published catherd:
+
+1. **`bunx` and the global install.** With an older global catherd first on PATH (or none), run
+   `bunx catherd-cli@latest init --no-input`. `init` must check the catherd in bun's global bin
+   (`bun pm bin -g`), not the one bunx puts first on PATH from its own `node_modules/.bin`: it installs or
+   reports the global one as current, and says `installed globally, but the catherd first on PATH is <older>`
+   (shadowed) while the older one comes first. Then `which catherd && catherd --version` shows what the plugin's
+   launcher will start.
+2. **A blackholed registry.** In the release candidate checkout (§9), with `bun remove -g catherd-cli` first:
+   `BUN_CONFIG_REGISTRY=http://10.255.255.1 bun src/cli.ts init --no-input`. `init` says `installing catherd…`,
+   then within about two minutes `could not install catherd globally: add -g catherd-cli@<version> timed out after
+   120 s` with the retry command, and goes on. Reinstall the candidate afterwards as §9 does.
````

- [ ] **Step 2: Check**

Run: `bun run format:check`

- [ ] **Step 3: Commit**

```sh
git add MIGRATION.md README.md docs/dev/live-verification.md
git commit -F - <<'EOF'
docs: the install, agy and live-kit notes from the minors sweep

1.0 fresh install, 1.1 and 1.2 follow-ups, 1.3 follow-ups. README: why the first bunx is silent
(TypeScript, a peer of OpenTUI's native layer) and bun add -g first; agy's 10-minute sign-in
window. MIGRATION: catalog list's 1.2 text shape, and --json for scripts. live-verification: a
headless verifier's minutes from runs.jsonl, at least three worker folders, and a section for the
bunx and blackholed-registry install checks.

<the session's attribution lines>
EOF
```

Scratch commit: `781e02e`. Body lines stay ≤ 100 characters (commitlint). Check `git log` afterwards.

---

### Task 10: Remove what this plan fixed or verified from ideas.md

Removes the 1.1 follow-ups but plan 22's push bullet, the two 1.2 notes now in MIGRATION (piped `init`, `catalog list` text), the 1.3 follow-ups but plan 24's sparse-rung entry, the whole "From the 1.0.0 fresh install" section (Ruling 34) and the three-MCP-servers investigation (X5). Nothing else changes (Ruling 36). If plans 22 or 24 already trimmed their own entries, remove only what is left of these.

**Files:**
- Modify: `docs/dev/ideas.md`

**Interfaces:**
- None.

**Commit:** `docs(ideas): drop what the minors sweep fixed or verified` (scratch `0ab697c`)

- [ ] **Step 1: Edit**

````diff
diff --git a/docs/dev/ideas.md b/docs/dev/ideas.md
index 0e2ddaf..d4f7652 100644
--- a/docs/dev/ideas.md
+++ b/docs/dev/ideas.md
@@ -80,8 +80,6 @@ Owner rule: review Minors and non-correctness bot P2s land here, not in code. Fr
 - **doctor's handshake starts a boot sync** (`src/entry/mcp/handshake.ts`): each `doctor` with a stale cache spends
   fetches (AA included) in a server it kills a moment later, and records nothing. Set `CATHERD_NO_SYNC=1` in
   `handshakeEnv`.
-- **Piped `init` reads a new line order** (Jev, AA, profile, replace): an old script piping `KEY\nwork\ny` now sends
-  `work` as the AA key. Say so in the 1.2 changeset and MIGRATION (plan 14).
 - **Fetchers store an answer of the wrong shape as a success** (AA `pages: []`, an Arena answer without `rows`),
   replacing the last good one. Throw when a parser yields no rows or page 1 is empty.
 - **`writeDerived` does not validate what it writes**, while `readDerived` does: one score with a bad date makes the
@@ -126,8 +124,6 @@ From the plan 14 final review (`cff7d19..04a48e2`) and its plan writer:
   tell a user's mapping apart ("like X").
 - **`treat-like --clear` does not name a rung that keeps some values but loses a bar dimension** to no stand-in
   (neither unscored nor inferred). Spec §6.4 arguably covers the partial gap.
-- **The text `catalog list` format changed in 1.2** (values line, then `runs:`); any script scraping it should use
-  `--json`.
 
 ## 1.1 follow-ups (minors from the 1.1 reviews, 2026-09-28)
 
@@ -137,33 +133,6 @@ Owner rule for the end of 1.1: review Minors and non-correctness bot P2s land he
   that this session still owns the run (failover-once keeps it to one stand-in, but the old owner can start it).
   Codex activity is computed twice per line; a file change with no paths shows `edit `; Claude tool activity shows
   only the tool name (opencode shows its first argument).
-- **Runs page (TUI).** A ref is written during render in `runs.tsx`; the role screen keeps polling a finished role;
-  a recent run opened from the Status tab lands on the session's first role, not that run; a session opens on its
-  first milestone row and live roles can sit below the fold; `milestoneAt` rebuilds its list on every key; a
-  milestone whose id is not `M<n>` gets a row only once it has landed. The `watchDirs` real-fs test can pass on a
-  late probe event; doctor's `failed` push row is tested only with a hand-made outcome.
-- **Protocol and gate (plan 11).** `laneDone` reads the records file once per lane; `peek.ts` shadows `r` and reads
-  the notes twice. A verifier that writes `**VERDICT: PASS**` in markdown counts as no verdict (fails safe): say so in
-  the `E_LAND_GATE` fix. The first milestone's commit range is its landed commit only (store the start HEAD in
-  meta.json). `dispatch` routes (asks Jev, writes a route row) before admission can refuse, and two concurrent
-  dispatches of one lane both route it. The ownership regex for climbs also catches environment errors that say
-  "owned by". `gate_pass` names HEAD for a pass on an uncommitted tree; a staged rename out of a gate's paths is not
-  seen; `./` is refused where `.` is meant.
-- **Access and doctor.** Doctor's claude-code access row reads the sandbox setting of the directory doctor runs in,
-  not each bound repo. `profile show` pads the "(no network)" row wrong; nothing warns about `network: false` on a
-  read-only or full role. Live check: whether `bunx catherd-cli@latest init` sees bunx's own `.bin` on PATH and
-  reports the global install as present.
-- **Failover and validation (plan 12).** An unscored stand-in gets both its "unscored" error and a "downgrade"
-  warning; `ladderDropDims` has no direct unit test; `rankStandIns` recomputes the bar check per pool member.
-- **Docs.** live-verification §9.2 reads verifier minutes from `agents.jsonl`, so a headless (`claude-code:`)
-  verifier prints nothing; the "back to published" block reuses `$version`, empty in a new shell.
-- **Install (plan 12 final review).** `bun add -g` in `init` has no time limit; the spawned init test passes
-  `BUN_INSTALL` through; `init` no longer warns "shadowed" when the global install is current but an older `catherd`
-  comes first on PATH (the launcher then falls back to bunx); an open milestone row lost its description; §9 check 5
-  should say "at least three" worker folders.
-- **Tests.** Three doctor tests run close to the 5 s default under load (plan 11's probes make a doctor run ~2.3 s):
-  give them 30 s like their neighbour. One full `bun test` run in five failed once on plan 12's head with no name recorded; heavy parallel
-  load in a shared sandbox times out git- and notifier-based tests at 5 s.
 
 ## Picked up
 
@@ -245,39 +214,6 @@ lint in the fast check, the `status` harness line, Jev keeping a sure kind.
 - **One owner question stops everything.** A blocked milestone should park with a push while independent milestones
   and runs continue; one question held the auth build for 4.5 h. _Evidence:_ the same report, finding 4.
 
-## From the 1.0.0 fresh install (2026-09-27)
-
-A clean 1.0.0 setup on macOS after removing every 0.x file: `bunx catherd-cli init`, the plugin commands, `doctor`, the
-TUI.
-
-- **Plugin install fails without GitHub SSH (blocker).** `marketplace.json` gives the plugin a `git-subdir` source
-  with `"url": "47vigen/catherd"`. The marketplace itself clones over HTTPS, but Claude Code clones that shorthand over
-  SSH, so `claude plugin install catherd@catherd` dies with `ssh: connect to host github.com port 22` on any machine
-  without GitHub SSH. 0.x used `"source": "./plugin"` and installed fine. Fix: `"url": "https://github.com/47vigen/catherd.git"`,
-  keeping `path` and `ref`. Workaround used: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf
-  GIT_CONFIG_VALUE_0=git@github.com: claude plugin install catherd@catherd`.
-- **`doctor`'s sandbox probe is dead on current Codex.** `canWrite` runs `codex sandbox macos --full-auto`; Codex
-  0.157 has no `macos` subcommand (`codex sandbox [COMMAND]`, seatbelt implied) and no `--full-auto` there, so the row
-  reads "not tested: no codex sandbox to test with" on every current install. It is the one check meant to catch the
-  auth build's top finding. Fix: probe `codex sandbox -- sh -c ...` first, fall back to the old form.
-- **The worker sandbox still cannot run checks (auth-build finding 1, confirmed on 1.0).** Under `codex sandbox`, a
-  write to the locks dir, the Docker socket (`docker ps`), a loopback `bind()` and a write to `/tmp` are all denied.
-  The default worker is `workspace-write`, so a Go monorepo with testcontainers repeats the auth build. Fix options: a
-  worker access level between `workspace-write` and `full` (network, loopback, the lock dir, `DOCKER_HOST`), or a
-  `check(run, lane)` tool that runs the fast check outside the sandbox behind the lock; `doctor` should say which one
-  this machine needs.
-- **Failover downgrades high rungs.** The inferred failover maps `codex:gpt-6-sol#high` and `#xhigh` to
-  `opencode-go/kimi-k3#max` "treated like gpt-6-sol#medium". A usage limit on a climbed lane silently drops it back
-  to the medium tier it just climbed from. Prefer a stand-in that clears the rung's own bar, or mark the row as a
-  downgrade in `profile show` and `doctor`.
-- **Warnings on the defaults.** A fresh `doctor` shows two `!` rows (full access for verifier and ui-reviewer, advisory
-  access for the Claude roles) about the shipped defaults, which the user did not choose and cannot act on. Show them
-  as info, or only when the profile departs from the defaults.
-- **Silent first `bunx`.** The first `bunx catherd-cli init` resolves about 108 packages (TypeScript among them,
-  pulled in transitively) for about 30 s before any output. Check what pulls TypeScript into the runtime tree, and
-  say "installing catherd…" before the resolve where possible (README: suggest `bun add -g catherd-cli` first).
-- **TUI first frame.** The Status tab shows "active · 0 profiles" before the profile list loads, then "1 profile".
-
 ## From the 1.0.0 headless test (2026-09-27)
 
 `claude -p "/catherd:catherd ..."` on a scratch Bun + TypeScript repo, three independent utils plus an index, profile
@@ -734,10 +670,6 @@ owner turned isolation off (the host is itself a sandbox).
   provider retries (say 3) or about 3 minutes of retry-only events, it fails the attempt as `provider-unavailable`,
   and `climb`/failover treats that like a usage limit: the next rung on another backend. A retry-only stretch
   does not count as activity for `idleMin`.
-- **Investigate: three MCP servers for one Codex session.** At 09:36 one Codex TUI started `catherd mcp` three times
-  (pids 633954 and 634083 as host codex, and 634148 as host `unknown`). Each reconciled the runs. Check whether
-  Codex spawns the plugin server per tool context. If so, make boot sync and reconcile single-flight across
-  processes.
 - **Scores of a new same-family release start absurd.** With no public numbers, GPT-6.1 Sol was inferred at
   repo_code 37.2 (low) and 56.6 (medium), below GPT-6 Luna, so the router would have avoided it. It was fixed
   locally with `treat-like` from the Artificial Analysis Intelligence Index per effort (slopalytics.com): Sol 6.1
@@ -764,38 +696,6 @@ owner turned isolation off (the host is itself a sandbox).
 
 ## 1.3 follow-ups (plan reviews, 2026-09-29)
 
-- **Discovery runs a non-Cursor `agent`.** `refreshDiscovery` calls `listModels()` without a probe, so with only
-  grok's `agent` on PATH catherd runs `agent models`. Its lines do not parse, so nothing is written, but the row shows a
-  raw spawn error. Fix: `listModels` returns `[]` unless the `agent` found prints Cursor's date-hash version, or
-  `refreshDiscovery` skips a backend `probeBackend` calls not installed. (Plan 15 final review, Minor 2.)
-- **Downgrade fixes can suggest a Cursor stand-in** on a machine without Cursor. `profile-rules` builds its stand-in
-  pool from every registered adapter. Fix: limit the pool to backends the profile already names. (Plan 15 final
-  review, Minor 4.)
-
-- **Isolated grok discovery lists under the native identity.** With both a grok login and `XAI_API_KEY`, `listModels`
-  runs under the user's `GROK_HOME` (the login wins) while an isolated worker uses the key, so `prepare` can judge a
-  model by the wrong account's listing. Fix: list and cache per identity when isolated. (Codex, PR #31.)
-- **Doctor ignores implicit paired stand-ins.** `usedBackends` scans role rungs and `profile.failover`, not
-  `PAIRED_FAILOVER`, so a missing Cursor reads as an unused `skip` although a Grok rung would fail over to it. Fix:
-  count paired targets as failover use. (Codex, PR #31.)
-- **Doctor's `sandbox:grok` check keeps the real HOME and the compat features on** (it moves only `GROK_HOME`). Fix:
-  add the ten compat toggles and `GROK_MEMORY=0`, or a scratch HOME. (Plan 16 final review, Minor 2.)
-- **sandbox.toml: bare keys after catherd's block change tables** when the block moves to the end; and two catherd
-  homes on one machine rewrite each other's block. Both rare. (Plan 16 final review, Minors 3 and 5.)
-
-- **A sandbox.toml link catherd cannot follow or write** (dangling, or into a read-only store such as Nix) fails
-  closed with a raw ENOENT/EACCES instead of `E_CONFIG_INVALID` and the isolate fix. And `sessionFor` could hash
-  the dispatch id alone rather than the full dispatch path, so a differently resolved data dir cannot change it.
-  (Plan 16 re-review, Minors.)
-
-- **Isolated agy lists models as the native account.** `prepare` checks an isolated rung against `agy models` run
-  under the user's HOME and its shared discovery cache, so a Google-plan listing can reject (or admit) a rung the
-  `GEMINI_API_KEY` project serves differently. List under the isolated HOME, with the cache keyed by auth route.
-  (Codex P2, PR #32; the grok twin is above.)
-- **agy's 10-minute readiness cache.** A probe that saw agy signed in is kept 10 minutes, so a sign-out inside that
-  window still reaches a native `-p` (which opens a browser). Document it, or re-run `agy models` in native
-  `prepare` (~10 s a dispatch). (Plan 17 final review, Minor 3.)
-
 - **A sparse rung borrows its nearest stand-in's honesty.** Shipping GPT-6.1 Sol's one honesty value (97.92, a
   Broken Search Tool figure) would have become the honesty stand-in for 18 unrelated rungs, e.g.
   `opencode/claude-haiku-4-5#high` 22.5 → 97.92: the similarity ranking seems to favour rungs with few values of their
````

- [ ] **Step 2: Check**

Run: `git diff --stat (docs only)`

- [ ] **Step 3: Commit**

```sh
git add docs/dev/ideas.md
git commit -F - <<'EOF'
docs(ideas): drop what the minors sweep fixed or verified

The 1.1 follow-ups but plan 22's push minors, the two 1.2 notes now in MIGRATION, the 1.3
follow-ups but plan 24's sparse-rung entry, the 1.0.0 fresh-install section (every entry fixed on
main or by this plan) and the three-MCP-servers investigation (closed by plan 22's single-flight
boot sync).

<the session's attribution lines>
EOF
```

Scratch commit: `0ab697c`. Body lines stay ≤ 100 characters (commitlint). Check `git log` afterwards.

---


## Parallelism

| Wave | Batches (parallel worktrees) | Depends on | Files (disjoint within a wave) |
| --- | --- | --- | --- |
| A | {1}, {2}, {3}, {4}, {5}, {6}, {7}, {9} | — | 1: `src/entry/tui/{state.ts,views/runs.tsx,views/status.tsx}`, `src/services/runs-page.ts`, `test/entry/tui/{effects.test.ts,runs.test.tsx,state.test.ts}`, `test/services/runs-page.test.ts` · 2: `src/services/{lane-service,milestones,peek,protocol,reentry,run-service,run-store}.ts`, `test/services/{climb-design,land-gate}.test.ts` · 3: `src/services/{admission,dispatch-service,gate-service}.ts`, `test/services/{dispatch-protocol,gate-service}.test.ts` · 4: `src/adapters/{backend.ts,claude-code/index.ts}`, `src/entry/profile-command.ts`, `src/services/{doctor-access,doctor}.ts`, `test/adapters/access.test.ts`, `test/entry/profile-command.test.ts`, `test/services/{doctor-push,doctor}.test.ts` · 5: `src/domain/{failover,profile-rules}.ts`, `test/domain/{failover,profile-rules}.test.ts`, `test/services/doctor-backends.test.ts` (new) · 6: `src/services/global-install.ts`, `test/entry/init-command.test.ts`, `test/services/global-install.test.ts` · 7: `src/adapters/{antigravity/index.ts,cursor/index.ts,grok/home.ts,grok/index.ts}`, `test/adapters/{antigravity,cursor,grok}.test.ts`, `test/sim/{agy,grok,sim-scenarios.ts}` · 9: `README.md`, `MIGRATION.md`, `docs/dev/live-verification.md` |
| B | {8} | 7 | `src/adapters/grok/{home,index}.ts`, `test/adapters/{grok-home,grok}.test.ts` (Task 7 edits the same grok files) |
| C | {10} | all | `docs/dev/ideas.md` |

Batching for fewer agents: {1}, {2, 3}, {4, 5, 6}, {7, 8}, {9, 10}. Tasks 2 and 3 share no file but both touch the dispatch/land path: run their combined focused tests after the wave. Run the full gate once on the combined head after each wave.
