# catherd 1.5, plan 25: runs, programs and lanes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the review findings of #43 (workspace runs) and the program-level gaps the payment, platform and identity runs found: a workspace that survives one broken run folder or one torn line, lands only its completion milestone behind its lock and keeps git outside it, has no budget cap by default and can raise one, and can release a step on merge; one pause for the whole machine or workspace; a machine-wide verifier lock; `runs supersede`; lane editing (`lane_set`, `owns_add`, `After:`, `Allow:`, header validation on write); the profile, access and isolation pinned per run; an exact verifier name and pause-free ledger minutes; knowledge keyed by the git origin; and a fuller milestone digest.

**Architecture:** The workspace keeps its files (`workspace-store.ts`, `workspace-admission.ts`, `workspace-service.ts`); one `dependencyBlockers` function is the dependency rule of admission, child start and status. New services: `pause.ts` (machine and workspace `pauses.jsonl`), `lane-edit.ts` (`lane_set`, `owns_add`), `run-pin.ts` (`pin.json`, `runProfile`, `pinChanges`, `repin`). The verifier lock is `withRoleLock` in `infra/heavy-lock.ts`, taken by `catherd lock --role verifier`. A superseded run carries `superseded.json`. Knowledge lives in `<data>/repos/origin-<key>/knowledge.md` when the repo has an `origin`. New MCP tools: `workspace_budget`, `workspace_pause`, `workspace_resume`, `lane_set`, `owns_add`, `run_pin` (37 tools on `main` 6f2f8c7); new CLI: `catherd pause|resume`, `catherd runs supersede|pin`, `catherd lock --role verifier [--run]`; new error codes `E_ADMIT_PAUSED`, `E_ADMIT_ORDER`.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, citty, `@modelcontextprotocol/sdk`. No new dependency.

**Spec:** `docs/specs/2026-10-02-catherd-1.5-design.md`, "Plan 25: runs, programs and lanes"; evidence in `docs/dev/ideas.md` ("From the reviews of #42 and #43" #43 findings 1–9, "From the 1.1.0 platform run", "From the payment run", "From the agentic-machine identity run", "Orchestration").

**Pre-validated on scratch `6f2f8c7..17c4e03` (branch `plan25-scratch`, code head `17c4e03`): 2056 pass / 19 skip / 0 fail (2075 tests, 189 files, about 6 minutes); typecheck, lint and format:check green.** The code below is that scratch build, commit by commit, on `main` 6f2f8c7 (catherd 1.4.0 with #42, #43 and #45). Every diff is the scratch commit's own `git show`, tests first, then the source; the executor applies it on top of plans 21–24 and re-finds each hunk by its context (cross-ruling X1).

## Global Constraints

- Spec, verbatim: "**#43 findings 1–8**, as listed in `ideas.md`, with the fixes named there; the workspace budget defaults to no cap and its minutes clock starts at the first child; `workspace_budget(workspace, …)` raises it."
- "**Release on merge.** A workspace step may declare `release: "merge"`; `workspace_child_start` then also requires the predecessor's landed commit to be an ancestor of a named base ref (`git merge-base --is-ancestor`), checked when asked, never polled."
- "**Group pause.** `workspace_pause(workspace, reason)` and `catherd pause --machine <reason>`: admission refuses with the reason until resumed; `status` shows it first."
- "**Cross-run verifier contention.** The lock's heavy slots are machine-wide already; the verifier role takes a heavy slot for its whole gate (`catherd lock --role verifier`), so two verifiers never overlap."
- "**`runs supersede <run> --by <run>`** (and a `from:` field on `run_start`) closes a run with a pointer; `status` hides it."
- "**Lane editing:** `lane_set(run, lane, field, value)` for one header line, validated; `owns_add(run, lane, paths, why)` re-checks overlap; `write_run_file` validates a lane's header values when it writes a lane; an `After: <lane>` header that `protocol.next` and admission respect; an `Allow:` line under a check."
- "**Pinned per run.** `run_start` records the profile name and each backend's access and isolation; a change later is logged in `state.md` and `status`, and dispatch keeps the pinned values unless the owner re-pins."
- "**The ledger:** `land` matches the verifier name exactly and subtracts parked time from minutes."
- "**Knowledge keyed by git origin**, falling back to the toplevel; existing keyed folders are migrated on read."
- "**A per-milestone digest** written by `land` into the run folder (A-lines met, commits, climbs, open findings, time, tokens); the push links it."
- "**Thread check.**" is plan 22's (cross-ruling X3): this plan does not implement it.
- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`). The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test` (FORCE_COLOR unset). Spawned test processes get an explicit `env` with `ANTHROPIC_API_KEY: ""`; no wall-clock sleep decides an outcome (the two negative waits, in Tasks 2 and 6, only give a wrong implementation the chance to show).
- Commits: conventional, subject ≤ 100 characters, **lower-case first word after the scope** (`feat(lanes): order lanes by After:…`, never `…: After: orders…`); check `git log` after each commit. No changeset (plan 27 writes the one 1.5.0 changeset). No workflow changes (X6).
- Owner rulings that stand (X6): isolation stays the profile's per-backend toggle; a role is never refused for being isolated.

## Review Focus

1. **A `run_start` in a member repository at the moment a sibling dispatches** (or a crash that left a run folder without `meta.json`). Expected: the workspace skips the folder, names it in `workspace_status`, and every child keeps working. Pinned in Task 1, "skips a member run folder without meta.json and names it, instead of blocking the workspace".
2. **A night parked on an owner question, then the landing.** Expected: the ledger minutes leave the parked night and any machine pause out; the workspace's minutes start at its first child, and a spent budget is raised without a new workspace. Pinned in Task 11, "leaves the parked night and a machine pause out of the ledger minutes", and Task 3, "has no cap by default, and counts minutes from the first child" and "raises a spent workspace budget so the next sibling is admitted".
3. **Two runs' verifiers on one machine** (plan 2's vitest next to plan 4's `task check`). Expected: the second run's verifier commands wait until the first run's last command ends; one run's own commands still run side by side. Pinned in Task 6, "keeps another run's verifier out until the last command of the holding run ends".
4. **The owner switches the active profile, or turns isolation on, while a run is paused.** Expected: a re-dispatched lane keeps the run's pinned profile, access and isolation; `status` and `state.md` name each change; `run_pin` follows the repo only on the owner's word. Pinned in Task 10, "keeps the pinned values when the repo's profile changes, and says what changed".
5. **A lane's Owns grows while its worker runs** (a `_test.go` the plan's grep missed). Expected: `owns_add` refuses a path another running lane owns; the running worker's edit to the added path is owned, not a violation. Pinned in Task 9, "owns_add grows Owns with its why, refusing a path a running lane owns" and "holds a dispatch still running when its Owns grew to the new list".
6. **One VPN blocks every run.** Expected: one `catherd pause --machine` refuses every dispatch with the reason (`E_ADMIT_PAUSED`), `status` shows it before any run, and `catherd resume --machine` lifts it. Pinned in Task 5, "refuses every dispatch on the machine with the reason until resumed, and status shows it first".

## Rulings

Controller rulings carried in: X1 (build on `main` as it is; the executor adapts to plans 21–24), X3 (the `dispatch` thread check is plan 22's), X4 (`CATHERD_ROLE=<run>/<role-name>` is plan 21's; Task 6 reads it), X6, X7.

Rulings of this plan (`what — why — cost if wrong`):

1. Ruling: a run folder in a member repository whose `meta.json` cannot be read is skipped and named (`workspace_status` warnings), never fatal; two children of one step, or a child in the wrong repository, still throw `E_RUN_CORRUPT` with the folder in the fix — #43 finding 1: `createRun` writes meta last, so an unreadable folder is never a linked child; a linkage conflict is real corruption — cost if wrong: a crash between `createRun`'s folder and its meta could make a step look unstarted and start a second child (the half-made folder is never linked, so nothing is lost).
2. Ruling: admission reads every sibling's cost evidence only when the workspace budget has a cap, and strictly then (`E_RUN_CORRUPT`); `workspace_status` and routing's 80 % threshold read leniently and name what they left out — #43 finding 2, "read only the evidence the operation needs"; a cap cannot be proven without every child — cost if wrong: under a cap, one torn line still stops admission until repaired (the old behavior, now only with a cap).
3. Ruling: one dependency rule (`dependencyBlockers`) for admission, child start and status: the dependency's child has landed the dependency's milestone and every dispatch it admitted is recorded, read under that child's records lock; an unreadable dependency blocks with its reason — #43 finding 8 — cost if wrong: status takes the dependency's records lock for milliseconds.
4. Ruling: the workspace lock's waiters wait 120 s (`WORKSPACE_LOCK_WAIT_MS`); admission keeps its git status snapshot inside the lock (siblings' budget checks stay serialized), while `land` and `workspace_child_start` do their git work (the gate, diffs, `state.md`) outside it — #43 finding 5: the failure was waiters giving up at 10 s behind a 15 s git call — cost if wrong: a dispatch may wait up to 15 s behind a sibling's admission instead of failing.
5. Ruling: in a workspace child only the step's completion milestone lands behind the workspace lock and the "no uncollected dispatch" rule; a milestone that differs from the step's only by case lands with a hint, and `workspace_status` warns — #43 findings 3 and 7 — cost if wrong: none known.
6. Ruling: a landed step's child admits again (a post-land fix); its dependents' admissions wait while that fix's dispatches are uncollected (the shared rule) — #43 finding 7 — cost if wrong: a fix in a producer briefly holds its consumers' dispatches.
7. Ruling: a workspace budget defaults to `{}` (no cap); its minutes count from the earliest child's `createdAt` (0 before one); `workspace_budget` replaces each cap given as a number, removes one given as `null`, keeps the rest, and is an MCP tool only — spec; the owner raises a budget through the coordinator — cost if wrong: a terminal user edits it through the coordinator, or plan 26 adds a CLI.
8. Ruling: `release: "merge"` is declared on the step that releases its dependents, with a required `base` ref (`BaseRefSchema`: no option, no `..`); `workspace_child_start` and `workspace_status` check `git merge-base --is-ancestor <landed commit> <base>` in that step's repository as it stands (no fetch); dispatch admission does not re-check it — "checked when asked, never polled" — cost if wrong: a squash-merged MR never releases (its landed commit is not an ancestor); the error says to fetch, and the owner can drop the `release` by starting a new workspace.
9. Ruling: a pause is a row in `pauses.jsonl` (`<data>/pauses.jsonl` for the machine, `<workspace dir>/pauses.jsonl` for a workspace); a new error code `E_ADMIT_PAUSED` refuses `dispatch` and `workspace_child_start`; running roles finish; `catherd pause|resume` take exactly one of `--machine` and `--workspace <id>`; the MCP tools are `workspace_pause` and `workspace_resume` (no machine pause from MCP: the owner's call from a terminal) — spec — cost if wrong: one more tool if the coordinator must pause the machine.
10. Ruling: `catherd lock --role verifier` holds a machine-wide role lock owned by a run (`--run`, else the run in `CATHERD_ROLE`, else this process alone) plus a heavy slot; one run's commands share it, another run's wait for its last command; a locked command gets `CATHERD_LOCK_HELD=1`, and a `catherd lock` inside it runs at once — the verifier runs many commands, not one process, so "its whole gate" is every command it wraps; the nested rule prevents a deadlock with one slot — cost if wrong: between two of its commands another run's verifier may take its turn.
11. Ruling: `runs supersede` writes `superseded.json` (server-owned); it refuses a run by itself, a cycle, and a run with live roles; `dispatch` into a superseded run is `E_RUN_NOT_LIVE` naming the new run; `status()` without a run hides it, `status(run)` and `runs list` show the pointer; `run_start` with `from` checks the old run before creating the new one — spec; an old run's roles would otherwise report into a closed run — cost if wrong: a supersede waits for live roles to end.
12. Ruling: `write_run_file` refuses a lane whose header values are present but wrong (a Kind or Difficulty the catalog does not know, an Owns path outside the repo, a malformed `After:` or `Allow:`); a missing line is left to `route` and `preflight` as before — the evidence is `Difficulty: medium`; a lane written in pieces must stay writable — cost if wrong: a missing Kind is still caught only at routing.
13. Ruling: `After:` names lane ids (`Mx.Ly`); a named lane is finished when its milestone landed or its latest try since its latest climb is recorded ok (a running try is not finished); admission refuses with a new code `E_ADMIT_ORDER`; `protocol.next` says `dispatch <ready>; then <lane> after <lanes>` — the evidence (L3 and L4 needed L1's kit to compile) — cost if wrong: a lane after a failed lane waits until that lane is fixed.
14. Ruling: `Allow:` entries are `path` (a trailing `/` covers a folder) or `path:line`; `preflight` passes a failing check whose every output line is an allowed `path:line` hit (at most 1000 lines), with the note `every hit is an Allow: exception (n)`; the worker reads it in its lane file (plan 21 inlines the lane file) — catherd runs a lane's check only in preflight — cost if wrong: a worker's own run of the check still fails on the allowed hit; the brief says why.
15. Ruling: `lane_set` fields are `owns`, `fast_check`, `kind`, `difficulty`, `after`, `allow`; it replaces the first such line or adds it under the title, validates the whole header (Ruling 12's rule), and an Owns change re-checks overlap with running lanes (`E_ADMIT_OVERLAP`); another lane file's overlap is a hint — spec — cost if wrong: none known.
16. Ruling: `owns_add` needs a `why`, appends `Owns added <time>: <paths> — <why>` to the lane file, and a finishing dispatch of the lane is held to its admitted Owns plus the lane file's Owns at that moment — "a running dispatch of the lane" is the evidence (L3 ended partial outside its Owns) — cost if wrong: an Owns widened by hand mid-dispatch also stops counting as a violation.
17. Ruling: the pin (`pin.json`) records the profile name, each role's access (the profile sets access per role, not per backend) and each backend's isolation; `run_start` and a workspace child's creation write it; admission, `route` and failover read `runProfile` (the pinned profile, with the pinned access and isolation over it); a pinned profile that no longer reads falls back to the repo's, named; `dispatch` writes the changes to `state.md` (`Pinned: …`) and a hint, `status` lists them as warnings; `run_pin` (MCP) and `catherd runs pin` re-pin; the native Claude agent name (`agentFor`) still follows the repo's profile — spec — cost if wrong: after a profile switch, a native Claude subagent of a pinned run runs as the new profile's agent (its file is the only one linked).
18. Ruling: `land` counts only a verifier attempt named exactly `verifier-<M>` (native or headless); `namesMilestone` stays for the digest's token count — spec — cost if wrong: a verifier dispatched as `verifier-M1-recheck` must be renamed (the skill and the brief already say `verifier-<M>`).
19. Ruling: the minutes `land` leaves out are the milestone's parked spans (question to answer) and every machine and workspace pause, overlaps counted once (`coveredMs`); the digest says how many — "subtracts parked time"; a group pause is the same kind of wait — cost if wrong: none known.
20. Ruling: knowledge is keyed by `git config --get remote.origin.url`, normalized to `host/path` (`normalizeOrigin`: scheme, user, `.git`, trailing `/` and port dropped, host lower-cased), in `<data>/repos/origin-<key>/knowledge.md`; with no origin, the toplevel key as before; a toplevel-keyed file is merged into it line by line (no duplicates) and renamed `knowledge.md.migrated` on the first read or append from that worktree; `gates.jsonl` stays keyed by toplevel (its hashes are of one checkout's content) — spec — cost if wrong: two unrelated repositories with the same origin URL share knowledge.
21. Ruling: the digest gains `Commits:` (`git log` from the previous landed commit, oldest first, at most 20), `Findings:` (the counted reviewer's BLOCKER and BUG lines), `Open:` (the run's open owner questions) and the paused minutes; `land` returns `digestPath`, the digest's full path, for the push — the 1.1 digest had the rest (A-lines, lanes and climbs, verdict, tokens) — cost if wrong: none known.
22. Ruling: the MCP tool count on `main` 6f2f8c7 goes from 31 to 37 (`workspace_budget` 32, `workspace_pause`/`workspace_resume` 34, `lane_set`/`owns_add` 36, `run_pin` 37); with plan 22's `test_push` it is one more — the executor updates `test/entry/mcp.test.ts`'s list and count — cost if wrong: one test line.
23. Ruling: the new tools are coordinator tools; plan 21's role-scope list (`E_ROLE_SCOPE`) gains `workspace_budget`, `workspace_pause`, `workspace_resume`, `lane_set`, `owns_add` and `run_pin` when this plan runs after it — X4; a role must never steer the run — cost if wrong: a role could pause a workspace.

## Assumes

- Plans 21–24 merged before this one (X1). The executor re-finds every hunk by its context. Files those plans also change: `src/services/admission.ts` (21: isolation and role MCP, TMPDIR; 22: thread check), `src/services/dispatch-service.ts` (22), `src/services/finalize.ts` (21: edits attributed per dispatch snapshot), `src/services/preflight.ts` (23: login env, classes, lock slots), `src/domain/role-prompts.ts` (21, 23: the verifier brief), `src/services/lane-service.ts` (24: `route`, the route record), `src/services/summary.ts` (22: `status()` selection), `src/entry/mcp/run-tools.ts` and `src/entry/mcp/lane-tools.ts` (21, 22, 24), `src/entry/lock-command.ts` (23: a `catherd lock` child's wall time), `plugin/skills/catherd/SKILL.md`, `README.md` and `test/entry/mcp.test.ts` (every plan).
- Plan 23 keeps a per-repo `gateEnv` "in the repo's knowledge folder": after Task 12 that folder is `dirname(await knowledgeFor(top))`; the executor points `gateEnv` there.

## Spec coverage

| Spec bullet (plan 25) | Task |
| --- | --- |
| #43 finding 1 (one broken run folder) | 1 |
| #43 finding 2 (strict reads of every child) | 1, 3 |
| #43 finding 3 (land only the completion milestone behind the rule) | 2 |
| #43 finding 4; budget no cap, clock at first child, `workspace_budget` | 3 |
| #43 finding 5 (the lock across slow git) | 2 |
| #43 finding 6 (`z.strictObject`) | 3 |
| #43 finding 7 (post-land admit; `m1` vs `M1`) | 1 (status warning), 2 |
| #43 finding 8 (one dependency rule) | 1 |
| Release on merge | 4 |
| Group pause | 5 |
| Cross-run verifier contention | 6 |
| `runs supersede` and `run_start` `from` | 7 |
| Lane editing: `write_run_file` validation, `After:`, `Allow:` | 8 |
| Lane editing: `lane_set`, `owns_add` | 9 |
| Pinned per run | 10 |
| The ledger: exact verifier name, parked time | 11 |
| Knowledge keyed by git origin, migrated on read | 12 |
| A per-milestone digest; the push links it | 13 |
| Thread check | plan 22 (X3) |
| Docs: skill, architect brief, README | 14 |
| `ideas.md` entries fixed | 15 |

## File Structure

| File | Task | Responsibility |
| --- | --- | --- |
| `src/services/workspace-store.ts` | 1, 2, 3 | `workspaceListing` (children and skipped folders), `WORKSPACE_LOCK_WAIT_MS`, `saveWorkspace` |
| `src/services/workspace-admission.ts` | 1–4 | `dependencyBlockers` (the one rule, merge release), lenient `workspaceSpend`, `assertWorkspaceBudget`, `setWorkspaceBudget` |
| `src/services/workspace-service.ts` | 1–5, 10 | child start (git outside the lock, pause, pin), status (warnings, `waitingFor`, `paused`) |
| `src/domain/workspace.ts` | 4 | `release`, `base`, `BaseRefSchema` |
| `src/entry/mcp/workspace-tools.ts` | 3, 4, 5 | strict step objects, `release`/`base`, `workspace_budget`, `workspace_pause`, `workspace_resume` |
| `src/services/lane-service.ts` | 2, 10, 11, 12, 13 | `land` (completion lock, `patchNotes`, minutes, commits, `digestPath`), `route` on the pinned profile |
| `src/services/state.ts`, `src/domain/state.ts` | 2, 10 | `patchNotes`; the `Pinned:` line |
| `src/services/pause.ts` (new), `src/entry/pause-command.ts` (new), `src/cli.ts` | 5, 11 | pauses, `assertNotPaused`, `pausesOver`, `pauseSpans`; `catherd pause|resume` |
| `src/infra/heavy-lock.ts`, `src/entry/lock-command.ts` | 6 | `withRoleLock`, `--role`, `--run`, `CATHERD_LOCK_HELD` |
| `src/services/run-store.ts`, `src/services/run-service.ts` | 7, 8, 10, 12 | `superseded.json`, `supersedeRun`, `run_start` `from` and pin, lane check on write, `knowledgeFor` |
| `src/domain/lane.ts`, `src/services/protocol.ts`, `src/services/preflight.ts` | 8, 13 | `After:`, `Allow:`, `assertLaneValues`, `onlyAllowedHits`, `unfinishedAfter`; digest lines |
| `src/services/lane-edit.ts` (new), `src/services/finalize.ts`, `src/entry/mcp/lane-tools.ts` | 9, 11, 13 | `lane_set`, `owns_add`, `currentOwns`; tool texts |
| `src/services/run-pin.ts` (new), `src/services/admission.ts`, `src/services/dispatch-service.ts`, `src/services/summary.ts`, `src/entry/mcp/run-tools.ts`, `src/entry/runs-command.ts` | 5, 7, 8, 10 | pin, pause, supersede and order checks; status fields; `run_pin`, `runs supersede|pin` |
| `src/services/milestones.ts`, `src/services/questions.ts`, `src/domain/util.ts` | 11, 13 | `verifierName`, `milestoneCommits`, `parkedSpans`, `coveredMs` |
| `src/infra/git.ts`, `src/infra/paths.ts` | 12 | `gitOrigin`, `normalizeOrigin`, `originDir` |
| `src/domain/errors.ts` | 5, 8 | `E_ADMIT_PAUSED`, `E_ADMIT_ORDER` |
| `src/domain/role-prompts.ts` | 6, 14 | the verifier's `catherd lock --role verifier`; the architect's `After:`/`Allow:` lines |
| `plugin/skills/catherd/SKILL.md`, `README.md` | 14 | the new tools, errors, commands and workspace rules |
| `docs/dev/ideas.md` | 15 | the entries this plan fixes, removed |

## Parallelism

Every task changes `test/entry/mcp.test.ts`'s tool list or a file another task changes, so the waves below keep the conflicts inside one batch; a batch runs its tasks in order in one worktree.

- **Wave 1:** batch A = Tasks 1, 2, 3, 4 (the workspace files, `lane-service.ts` `land`, `state.ts`, `workspace-tools.ts`, `mcp.test.ts`); batch B = Task 6 (`heavy-lock.ts`, `lock-command.ts`, `role-prompts.ts` verifier line, their tests). Disjoint.
- **Wave 2:** batch C = Tasks 5, 7, 8 (`pause.ts`, `admission.ts`, `summary.ts`, `runs-command.ts`, `run-store.ts` supersede part, `run-service.ts` start and write, `domain/lane.ts`, `protocol.ts` next, `preflight.ts`, `errors.ts`, `cli.ts`, `workspace-service.ts`, `workspace-tools.ts`, `run-tools.ts`, `mcp.test.ts`); batch D = Task 12 (`git.ts`, `paths.ts`, `run-store.ts` knowledge part, `run-service.ts` knowledge functions, one line of `lane-service.ts`). C and D share `run-store.ts` and `run-service.ts` in different functions: cherry-pick D after C.
- **Wave 3:** batch E = Tasks 9, 10, 11, 13 (`lane-edit.ts`, `finalize.ts`, `run-pin.ts`, `lane-service.ts`, `dispatch-service.ts`, `milestones.ts`, `questions.ts`, `protocol.ts` digest, the tools). In order: 13 edits what 11 wrote in `land`.
- **Wave 4:** batch F = Tasks 14, 15 (docs only).

Worker models: `opus-low` for every task (the plan holds the code); `opus-medium` for the merge onto plans 21–24 if a hunk does not apply.

---

### Task 1: The workspace skips unreadable run folders and shares one dependency rule (#43 findings 1, 2, 8)

**Files:** `src/services/workspace-store.ts`, `src/services/workspace-admission.ts`, `src/services/workspace-service.ts`, `test/services/workspace.test.ts`.

**Produces:** `workspaceListing(workspace): { children, unreadable }`, `unreadableWarning`, `dependencyBlockers(workspace, step, children, now): Promise<Blocker[]>` (`Blocker = { step, why }`), `assertWorkspaceBudget(workspace, now, children)`, `workspaceSpend(workspace, now, children?, warnings?)` (lenient with `warnings`); `workspaceStatus` gains `warnings` and each step's `waitingFor`. Removes `workspaceStepBlockedBy`. **Consumes:** `listRuns`, `pendingDispatches`, `landedMilestones`.

- [ ] **Step 1: the failing tests.** Apply the test diff below. Run `bun test test/services/workspace.test.ts`: the three new tests fail (`E_RUN_CORRUPT` on the half-made folder; `workspaceStatus` throws on the torn line; admission and child start word the dependency differently).
- [ ] **Step 2: the code.** Apply the source diff. Run `bun test test/services/workspace` (40 pass).
- [ ] **Step 3: commit** `fix(workspace): skip unreadable member runs and share one dependency rule` (scratch `85c0f87`).

**Tests (scratch `85c0f87`):**

````diff
diff --git a/test/services/workspace.test.ts b/test/services/workspace.test.ts
index 6559a9f..873fea2 100644
--- a/test/services/workspace.test.ts
+++ b/test/services/workspace.test.ts
@@ -1,7 +1,17 @@
 import { afterEach, expect, it } from "bun:test";
-import { appendFileSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
+import {
+  appendFileSync,
+  mkdirSync,
+  readFileSync,
+  rmSync,
+  statSync,
+  symlinkSync,
+  writeFileSync,
+} from "node:fs";
 import { join, relative } from "node:path";
+import { runsDir } from "../../src/infra/paths.ts";
 import { appendRecord, createRun, listRuns, runPaths } from "../../src/services/run-store.ts";
+import { withWorkspaceAdmission } from "../../src/services/workspace-admission.ts";
 import {
   inspectWorkspace,
   startWorkspace,
@@ -303,3 +313,55 @@ it("accepts transitive same-repository ordering and rejects unordered reuse", as
     startWorkspace(deps, { ...input, steps: [steps[0]!, { ...steps[2]!, dependsOn: [] }] }),
   ).rejects.toMatchObject({ code: "E_INPUT_INVALID" });
 });
+
+it("skips a member run folder without meta.json and names it, instead of blocking the workspace (#43 finding 1)", async () => {
+  const { deps, input } = setup();
+  const { workspace } = await startWorkspace(deps, input);
+  // a run_start in progress, or one a crash left: createRun writes meta.json last
+  const half = join(runsDir(input.repos.api), "20261002-000000-half-made");
+  mkdirSync(half, { recursive: true });
+  const api = await startWorkspaceChild(deps, { workspace: workspace.id, step: "api" });
+  expect(workspaceChildren(workspace).map((r) => r.id)).toEqual([api.run]);
+  const status = await workspaceStatus(deps, workspace.id);
+  expect(status.steps[0]?.run).toBe(api.run);
+  expect(status.warnings).toEqual([expect.stringContaining(half)]);
+});
+
+it("keeps siblings and status working when one child has a torn records line (#43 finding 2)", async () => {
+  const { deps, input } = setup();
+  const { workspace } = await startWorkspace(deps, {
+    ...input,
+    steps: [input.steps[0]!, { ...input.steps[1]!, dependsOn: [] }],
+  });
+  await startWorkspaceChild(deps, { workspace: workspace.id, step: "api" });
+  const api = workspaceChildren(workspace)[0]!;
+  appendFileSync(runPaths(api.dir).runs, "{torn\n");
+  const web = await startWorkspaceChild(deps, { workspace: workspace.id, step: "web" });
+  expect(web.run).not.toBe(api.id);
+  const sibling = workspaceChildren(workspace).find((r) => r.id === web.run)!;
+  expect(await withWorkspaceAdmission(sibling, deps.now(), async () => "admitted")).toBe("admitted");
+  const status = await workspaceStatus(deps, workspace.id);
+  expect(status.steps.map((s) => s.state)).toEqual(["active", "active"]);
+  expect(status.warnings).toContainEqual(`api: run ${api.id} has unreadable dispatch records`);
+});
+
+it("admission and child start wait on a dependency for the same reasons (#43 finding 8)", async () => {
+  const { deps, input } = setup();
+  const { workspace } = await startWorkspace(deps, input);
+  await startWorkspaceChild(deps, { workspace: workspace.id, step: "api" });
+  const api = workspaceChildren(workspace)[0]!;
+  appendFileSync(runPaths(api.dir).ledger, "M1 | API | abcdef1 | 1 | checked\n");
+  await fakeDispatch(api, { name: "late-fix" }, { proc: "dead" });
+  const recovered = createRun({
+    repo: input.repos.web,
+    title: "Recovered web",
+    aLines: [],
+    version: "test",
+    workspace: { id: workspace.id, step: "web" },
+  });
+  const why = "api has 1 dispatch(es) not collected (late-fix)";
+  await expect(withWorkspaceAdmission(recovered, deps.now(), async () => "admitted")).rejects.toThrow(why);
+  rmSync(recovered.dir, { recursive: true });
+  await expect(startWorkspaceChild(deps, { workspace: workspace.id, step: "web" })).rejects.toThrow(why);
+  expect((await workspaceStatus(deps, workspace.id)).steps[1]?.waitingFor).toEqual([why]);
+});
````

**Code (scratch `85c0f87`):**

````diff
diff --git a/src/services/workspace-admission.ts b/src/services/workspace-admission.ts
index afe0040..bbc5fa4 100644
--- a/src/services/workspace-admission.ts
+++ b/src/services/workspace-admission.ts
@@ -1,7 +1,7 @@
 import { existsSync, readFileSync } from "node:fs";
 import { budgetStatus, formatBudget, type BudgetStatus, type Spend } from "../domain/budget.ts";
-import { CatherdError } from "../domain/errors.ts";
-import type { Workspace } from "../domain/workspace.ts";
+import { CatherdError, errorMessage, isCatherdError } from "../domain/errors.ts";
+import type { Workspace, WorkspaceStep } from "../domain/workspace.ts";
 import { withFileLock } from "../infra/filelock.ts";
 import { gitToplevel } from "../infra/git.ts";
 import { writeTextAtomic } from "../infra/store.ts";
@@ -11,11 +11,16 @@ import { landedMilestones } from "./milestones.ts";
 import { readRecords, type Run, runPaths } from "./run-store.ts";
 import { findWorkspace, workspaceChildren, workspaceDirectory, workspacePaths } from "./workspace-store.ts";
 
-/** Count each recorded or unrecorded dispatch once; elapsed minutes belong to the parent. */
+/**
+ * Count each recorded or unrecorded dispatch once; elapsed minutes belong to the parent. With `warnings`,
+ * a child whose cost evidence cannot be read is skipped and named there (status); without, it throws
+ * E_RUN_CORRUPT (admission against a cap, which cannot prove the cap holds without it).
+ */
 export async function workspaceSpend(
   workspace: Workspace,
   now: number,
   children = workspaceChildren(workspace),
+  warnings?: string[],
 ): Promise<Spend> {
   const total: Spend = {
     minutes: Math.max(0, (now - Date.parse(workspace.createdAt)) / 60_000),
@@ -23,21 +28,89 @@ export async function workspaceSpend(
     usd: 0,
   };
   for (const child of children) {
-    const spent = await withFileLock(runPaths(child.dir).runs, () => {
-      const { records, corrupt } = readRecords(child);
-      if (corrupt) throw new CatherdError("E_RUN_CORRUPT", `run ${child.id} has unreadable cost records`);
-      return spendOf(child, records, pendingDispatches(child, now, records, true), now, true);
-    });
-    total.tokens += spent.tokens;
-    total.usd += spent.usd;
+    try {
+      const spent = await withFileLock(runPaths(child.dir).runs, () => {
+        const { records, corrupt } = readRecords(child);
+        if (corrupt) throw new CatherdError("E_RUN_CORRUPT", `run ${child.id} has unreadable cost records`);
+        return spendOf(child, records, pendingDispatches(child, now, records, true), now, true);
+      });
+      total.tokens += spent.tokens;
+      total.usd += spent.usd;
+    } catch (e) {
+      if (!warnings || !isCatherdError(e) || e.code !== "E_RUN_CORRUPT") throw e;
+      warnings.push(`spend leaves out ${child.id}: ${errorMessage(e)}`);
+    }
   }
   return total;
 }
 
+/** The workspace budget a child run's routing sees; a child whose evidence is unreadable counts nothing. */
 export async function workspaceBudget(run: Run, now: number): Promise<BudgetStatus | null> {
   if (!run.meta.workspace) return null;
   const workspace = findWorkspace(run.meta.workspace.id);
-  return budgetStatus(await workspaceSpend(workspace, now), workspace.budget);
+  return budgetStatus(await workspaceSpend(workspace, now, undefined, []), workspace.budget);
+}
+
+/** Why a dependency keeps a step waiting: the dependency's step id and the reason, in words. */
+export interface Blocker {
+  step: string;
+  why: string;
+}
+
+/** The dependency's uncollected dispatches, read under its records lock: a reason, or null when none. */
+async function uncollected(child: Run, now: number): Promise<string | null> {
+  const step = child.meta.workspace?.step ?? child.id;
+  try {
+    const pending = await withFileLock(runPaths(child.dir).runs, () => {
+      const { records, corrupt } = readRecords(child);
+      if (corrupt) throw new CatherdError("E_RUN_CORRUPT", `run ${child.id} has unreadable dispatch records`);
+      return pendingDispatches(child, now, records, true);
+    });
+    return pending.length
+      ? `${step} has ${pending.length} dispatch(es) not collected (${pending.map((d) => d.admit.name).join(", ")})`
+      : null;
+  } catch (e) {
+    if (isCatherdError(e) && e.code === "E_RUN_CORRUPT") return `${step} cannot be read: ${e.message}`;
+    throw e;
+  }
+}
+
+/** A landed milestone that differs from the step's only by case: `m1` for `M1` (#43 finding 7). */
+const caseTwin = (landed: string[], milestone: string): string | undefined =>
+  landed.find((m) => m !== milestone && m.toLowerCase() === milestone.toLowerCase());
+
+/**
+ * #43 finding 8: the one dependency rule admission, child start and status share. A dependency releases its
+ * dependents once its child has landed the dependency's milestone and every dispatch it admitted is
+ * collected. Reads only the dependencies' own evidence (#43 finding 2); an unreadable one blocks, named.
+ */
+export async function dependencyBlockers(
+  workspace: Workspace,
+  step: WorkspaceStep,
+  children: Run[],
+  now: number,
+): Promise<Blocker[]> {
+  const out: Blocker[] = [];
+  for (const id of step.dependsOn) {
+    const before = workspace.steps.find((s) => s.id === id);
+    const child = children.find((c) => c.meta.workspace?.step === id);
+    if (!before || !child) {
+      out.push({ step: id, why: `${id} has not started` });
+      continue;
+    }
+    const landed = landedMilestones(child);
+    if (!landed.includes(before.milestone)) {
+      const twin = caseTwin(landed, before.milestone);
+      out.push({
+        step: id,
+        why: `${id} has not landed ${before.milestone}${twin ? ` (it landed ${twin}: the step completes on ${before.milestone})` : ""}`,
+      });
+      continue;
+    }
+    const why = await uncollected(child, now);
+    if (why) out.push({ step: id, why });
+  }
+  return out;
 }
 
 export function withRunAdmission<T>(run: Run, now: () => number, admit: () => Promise<T>): Promise<T> {
@@ -70,28 +143,38 @@ export async function withWorkspaceAdmission<T>(
       throw new CatherdError("E_INPUT_INVALID", `${step.id} has already landed its completion milestone`, {
         fix: "start a new workspace execution for further changes",
       });
-    for (const dependency of step.dependsOn) {
-      const before = workspace.steps.find((s) => s.id === dependency);
-      const child = children.find((c) => c.meta.workspace?.step === dependency);
-      if (
-        !before ||
-        !child ||
-        !landedMilestones(child).includes(before.milestone) ||
-        pendingDispatches(child, now).length
-      )
-        throw new CatherdError("E_INPUT_INVALID", `${step.id} is waiting for ${dependency}`, {
+    const blockers = await dependencyBlockers(workspace, step, children, now);
+    if (blockers.length)
+      throw new CatherdError(
+        "E_INPUT_INVALID",
+        `${step.id} is waiting: ${blockers.map((b) => b.why).join("; ")}`,
+        {
           fix: "land the dependency's completion milestone and collect its finished dispatches first",
-        });
-    }
-    const budget = budgetStatus(await workspaceSpend(workspace, now, children), workspace.budget);
-    if (budget && budget.fraction >= 1)
-      throw new CatherdError("E_RUN_BUDGET", `the workspace budget is spent: ${formatBudget(budget)}`, {
-        fix: "finish with the work already admitted, or start a new workspace with an authorized budget",
-      });
+        },
+      );
+    await assertWorkspaceBudget(workspace, now, children);
     return admit();
   });
 }
 
+/** Whether the budget caps anything: without a cap, no sibling's evidence is read (#43 finding 2). */
+const capped = (workspace: Workspace): boolean =>
+  Object.values(workspace.budget).some((v) => typeof v === "number");
+
+/** Refuses E_RUN_BUDGET once a capped workspace budget is spent; reads every child only when capped. */
+export async function assertWorkspaceBudget(
+  workspace: Workspace,
+  now: number,
+  children: Run[],
+): Promise<void> {
+  if (!capped(workspace)) return;
+  const budget = budgetStatus(await workspaceSpend(workspace, now, children), workspace.budget);
+  if (budget && budget.fraction >= 1)
+    throw new CatherdError("E_RUN_BUDGET", `the workspace budget is spent: ${formatBudget(budget)}`, {
+      fix: "finish with the work already admitted, or start a new workspace with an authorized budget",
+    });
+}
+
 /** The shared contract is frozen when the first child starts, then copied into child dossiers. */
 export async function workspaceContract(i: {
   workspace: string;
diff --git a/src/services/workspace-service.ts b/src/services/workspace-service.ts
index 3898416..8774063 100644
--- a/src/services/workspace-service.ts
+++ b/src/services/workspace-service.ts
@@ -14,12 +14,14 @@ import { createRun, readRecords, type Run } from "./run-store.ts";
 import { claimRun, currentSession } from "./sessions.ts";
 import { refreshState } from "./state.ts";
 import { summarizeRun } from "./summary.ts";
-import { workspaceSpend } from "./workspace-admission.ts";
+import { assertWorkspaceBudget, dependencyBlockers, workspaceSpend } from "./workspace-admission.ts";
 import {
   createWorkspace,
   findWorkspace,
+  unreadableWarning,
   workspaceChildren,
   workspaceDirectory,
+  workspaceListing,
   workspacePaths,
 } from "./workspace-store.ts";
 
@@ -120,38 +122,16 @@ export async function startWorkspace(
   return { workspace, dir: workspaceDirectory(workspace.id) };
 }
 
-function pending(run: Run): boolean {
+/** Whether a child still has dispatches nobody collected; null when its records cannot be read. */
+function ownPending(run: Run): boolean | null {
   const { records, corrupt } = readRecords(run);
-  if (corrupt) throw new CatherdError("E_RUN_CORRUPT", `run ${run.id} has unreadable cost records`);
+  if (corrupt) return null;
   const recorded = new Set(records.map((r) => r.dispatchId));
-  return listDispatches(run, true).some((d) => !recorded.has(d.admit.dispatchId));
-}
-
-function completion(children: Run[]): Map<string, { landed: string[]; pending: boolean }> {
-  return new Map(
-    children.map((child) => [
-      child.meta.workspace!.step,
-      {
-        landed: landedMilestones(child),
-        pending: pending(child),
-      },
-    ]),
-  );
-}
-
-export function workspaceStepBlockedBy(
-  workspace: Workspace,
-  stepId: string,
-  children = workspaceChildren(workspace),
-  evidence = completion(children),
-): string[] {
-  const step = workspace.steps.find((s) => s.id === stepId);
-  if (!step) throw invalid(`unknown workspace step ${stepId}`);
-  return step.dependsOn.filter((id) => {
-    const predecessor = workspace.steps.find((s) => s.id === id)!;
-    const child = evidence.get(id);
-    return !child || !child.landed.includes(predecessor.milestone) || child.pending;
-  });
+  try {
+    return listDispatches(run, true).some((d) => !recorded.has(d.admit.dispatchId));
+  } catch {
+    return null;
+  }
 }
 
 export async function startWorkspaceChild(
@@ -173,10 +153,10 @@ export async function startWorkspaceChild(
       );
     let run = children.find((r) => r.meta.workspace?.step === step.id);
     if (!run) {
-      const blockedBy = workspaceStepBlockedBy(workspace, step.id, children);
-      if (blockedBy.length) throw invalid(`workspace step ${step.id} waits for ${blockedBy.join(", ")}`);
-      const budget = budgetStatus(await workspaceSpend(workspace, deps.now(), children), workspace.budget);
-      if (budget && budget.fraction >= 1) throw new CatherdError("E_RUN_BUDGET", "workspace budget is spent");
+      const blockers = await dependencyBlockers(workspace, step, children, deps.now());
+      if (blockers.length)
+        throw invalid(`workspace step ${step.id} waits: ${blockers.map((b) => b.why).join("; ")}`);
+      await assertWorkspaceBudget(workspace, deps.now(), children);
       run = createRun({
         repo,
         title: step.title,
@@ -197,27 +177,36 @@ export async function startWorkspaceChild(
 
 export async function workspaceStatus(deps: Deps, id: string) {
   const workspace = findWorkspace(id);
-  const children = workspaceChildren(workspace);
-  const evidence = completion(children);
-  const steps = workspace.steps.map((step) => {
+  const { children, unreadable } = workspaceListing(workspace);
+  // #43 finding 2: a corrupt child is a warning here, never a failed status
+  const warnings = unreadable.map(unreadableWarning);
+  const steps = [];
+  for (const step of workspace.steps) {
     const child = children.find((r) => r.meta.workspace?.step === step.id);
     const summary = child ? summarizeRun(deps, child) : null;
-    const facts = evidence.get(step.id);
-    const landed = facts?.landed ?? [];
-    const blockedBy = workspaceStepBlockedBy(workspace, step.id, children, evidence);
+    const landed = child ? landedMilestones(child) : [];
+    const pending = child ? ownPending(child) : false;
+    if (child && pending === null)
+      warnings.push(`${step.id}: run ${child.id} has unreadable dispatch records`);
+    // #43 finding 7: a milestone that differs only by case never releases the dependents
+    const twin = landed.find((m) => m !== step.milestone && m.toLowerCase() === step.milestone.toLowerCase());
+    if (twin && !landed.includes(step.milestone))
+      warnings.push(`${step.id} completes on ${step.milestone}, but its run landed ${twin}`);
+    const blockers = await dependencyBlockers(workspace, step, children, deps.now());
     const state: "waiting" | "ready" | "active" | "landed" = child
-      ? landed.includes(step.milestone) && !facts?.pending
+      ? landed.includes(step.milestone) && pending === false
         ? "landed"
         : "active"
-      : blockedBy.length
+      : blockers.length
         ? "waiting"
         : "ready";
-    return {
+    steps.push({
       id: step.id,
       repo: step.repo,
       state,
       run: child?.id ?? null,
-      blockedBy,
+      blockedBy: blockers.map((b) => b.step),
+      waitingFor: blockers.map((b) => b.why),
       landedMilestones: landed,
       landedCommits: child ? landedCommits(child) : [],
       failures: summary?.totals.notOk ?? [],
@@ -225,14 +214,15 @@ export async function workspaceStatus(deps: Deps, id: string) {
       live: summary?.live ?? [],
       childBudget: summary?.budget ?? null,
       warnings: summary?.warnings ?? [],
-    };
-  });
-  const spend = await workspaceSpend(workspace, deps.now(), children);
+    });
+  }
+  const spend = await workspaceSpend(workspace, deps.now(), children, warnings);
   return {
     workspace,
     dir: workspaceDirectory(id),
     steps,
     spend,
     budget: budgetStatus(spend, workspace.budget),
+    warnings,
   };
 }
diff --git a/src/services/workspace-store.ts b/src/services/workspace-store.ts
index ff4a992..72778a6 100644
--- a/src/services/workspace-store.ts
+++ b/src/services/workspace-store.ts
@@ -1,10 +1,10 @@
 import { randomUUID } from "node:crypto";
 import { existsSync } from "node:fs";
-import { dirname, join } from "node:path";
+import { join } from "node:path";
 import { CatherdError } from "../domain/errors.ts";
 import { assertId } from "../domain/ids.ts";
 import { type Workspace, WorkspaceSchema } from "../domain/workspace.ts";
-import { dataDir, runsDir } from "../infra/paths.ts";
+import { dataDir } from "../infra/paths.ts";
 import { ensurePrivateDir, readVersioned, writeJsonAtomic } from "../infra/store.ts";
 import { listRuns, type Run } from "./run-store.ts";
 
@@ -45,16 +45,20 @@ export function findWorkspace(id: string): Workspace {
   return workspace;
 }
 
-/** Linkage is in the child's atomic meta write: a crash cannot orphan a completed child creation. */
-export function workspaceChildren(workspace: Workspace): Run[] {
+export interface WorkspaceListing {
+  /** the runs linked to this workspace, each with a readable meta.json */
+  children: Run[];
+  /** run folders in a member repository whose meta.json cannot be read (#43 finding 1): skipped, named */
+  unreadable: { id: string; dir: string; reason: string }[];
+}
+
+/**
+ * Linkage is in the child's atomic meta write, so a folder without a readable meta.json is never a child:
+ * `createRun` writes meta last, and a run being created, or left by a crash, is skipped and named, never
+ * fatal (#43 finding 1). Two children of one step, or a child in the wrong repository, still throw.
+ */
+export function workspaceListing(workspace: Workspace): WorkspaceListing {
   const listing = listRuns(Object.values(workspace.repos));
-  // An unreadable child cannot be proven unrelated. Refuse admission instead of silently recreating it.
-  const roots = Object.values(workspace.repos).map(runsDir);
-  if (listing.corrupt.some((bad) => roots.includes(dirname(bad.dir))))
-    throw new CatherdError(
-      "E_RUN_CORRUPT",
-      "a workspace repository has an unreadable run; repair its metadata before continuing",
-    );
   const children = listing.runs.filter((r) => r.meta.workspace?.id === workspace.id);
   const seen = new Set<string>();
   for (const run of children) {
@@ -63,8 +67,16 @@ export function workspaceChildren(workspace: Workspace): Run[] {
       throw new CatherdError(
         "E_RUN_CORRUPT",
         `workspace ${workspace.id} has duplicate or mismatched child ${run.id}`,
+        { fix: `fix or delete ${run.dir}` },
       );
     seen.add(step.id);
   }
-  return children;
+  return { children, unreadable: listing.corrupt };
 }
+
+/** The workspace's children (see workspaceListing); folders without a readable meta.json are skipped. */
+export const workspaceChildren = (workspace: Workspace): Run[] => workspaceListing(workspace).children;
+
+/** What `workspace_status` says about a skipped folder: its path and why. */
+export const unreadableWarning = (u: { dir: string; reason: string }): string =>
+  `skipped run folder ${u.dir}: ${u.reason}`;
````

### Task 2: Land only the completion milestone behind the workspace lock, git outside it (#43 findings 3, 5, 7)

**Files:** `src/services/lane-service.ts`, `src/services/state.ts`, `src/services/workspace-admission.ts`, `src/services/workspace-service.ts`, `src/services/workspace-store.ts`, `test/services/workspace-admission.test.ts`, `test/services/workspace-land.test.ts`.

**Produces:** `WORKSPACE_LOCK_WAIT_MS` (120 000), `patchNotes(run, change)` (state.json only, no git), `land` returning `LandResult`; `withWorkspaceAdmission` without the landed refusal, with its git check before the lock; `startWorkspaceChild` with `claimRun` and `refreshState` after the lock (`childFor` under it). **Consumes:** Task 1's `dependencyBlockers`.

- [ ] **Step 1: the failing tests.** Apply the test diff. Run `bun test test/services/workspace-land.test.ts test/services/workspace-admission.test.ts`: the post-land admission, the non-completion landing, the case hint and the gate-before-lock tests fail.
- [ ] **Step 2: the code.** Apply the source diff. Run `bun test test/services/workspace test/services/land-gate.test.ts test/services/lanes-run.test.ts test/services/protocol.test.ts test/entry/mcp.test.ts`.
- [ ] **Step 3: commit** `fix(workspace): land only the completion milestone behind the lock, git outside it` (scratch `d2c610e`).

**Tests (scratch `d2c610e`):**

````diff
diff --git a/test/services/workspace-admission.test.ts b/test/services/workspace-admission.test.ts
index 68b10bf..dc1aac7 100644
--- a/test/services/workspace-admission.test.ts
+++ b/test/services/workspace-admission.test.ts
@@ -137,12 +137,10 @@ it("serializes sibling admission and rejects the second after aggregate budget i
   expect(rejected?.status === "rejected" && rejected.reason.code).toBe("E_RUN_BUDGET");
 });
 
-it("refuses more dispatches into a completed step and preserves ordinary run admission", async () => {
+it("admits a post-land fix into a completed step and preserves ordinary run admission (#43 finding 7)", async () => {
   const { deps, producer } = await setup();
   appendLedger(producer, "M1 | Finished | abcdef1 | 1 | passed");
-  await expect(withWorkspaceAdmission(producer, deps.now(), async () => "admitted")).rejects.toMatchObject({
-    code: "E_INPUT_INVALID",
-  });
+  expect(await withWorkspaceAdmission(producer, deps.now(), async () => "admitted")).toBe("admitted");
   const ordinary = createRun({ repo: tempRepo(), title: "Ordinary", aLines: [], version: "test" });
   expect(await withWorkspaceAdmission(ordinary, deps.now(), async () => "admitted")).toBe("admitted");
 });
diff --git a/test/services/workspace-land.test.ts b/test/services/workspace-land.test.ts
index 39e7414..a2d87e2 100644
--- a/test/services/workspace-land.test.ts
+++ b/test/services/workspace-land.test.ts
@@ -13,7 +13,7 @@ import { fakeDeps, fakeDispatch, makeRecord } from "./helpers.ts";
 
 afterEach(snapshotEnv());
 
-async function setup() {
+async function setup(milestone = "M1") {
   withHome();
   const deps = fakeDeps();
   const repo = tempRepo();
@@ -23,7 +23,7 @@ async function setup() {
     title: "Completion admission",
     aLines: [],
     budget: { tokens: 1 },
-    steps: [{ id: "app", repo: "app", title: "App", aLines: [] }],
+    steps: [{ id: "app", repo: "app", title: "App", aLines: [], milestone }],
   });
   await startWorkspaceChild(deps, { workspace: workspace.id, step: "app" });
   const run = workspaceChildren(workspace)[0]!;
@@ -98,11 +98,46 @@ it("allows landing after a finished dispatch has been collected", async () => {
   const dispatch = await fakeDispatch(run, { lane: null }, { proc: "dead" });
   await appendRecord(run, makeRecord({ runId: run.id, dispatchId: dispatch.admit.dispatchId, lane: null }));
   await expect(land(deps, input)).resolves.toHaveProperty("ledger");
+  // #43 finding 7: a landed step is no longer refused as landed; only this workspace's spent budget stops it
   await expect(withWorkspaceAdmission(run, deps.now, async () => true)).rejects.toMatchObject({
-    code: "E_INPUT_INVALID",
+    code: "E_RUN_BUDGET",
   });
 });
 
+it("lands a milestone other than the step's completion while a dispatch runs (#43 finding 3)", async () => {
+  const { deps, run, input } = await setup("M2");
+  await fakeDispatch(run, { lane: null }, { proc: "self" });
+  await expect(land(deps, input)).resolves.toHaveProperty("ledger");
+  expect(landedMilestones(run)).toEqual(["M1"]);
+});
+
+it("says when a landed milestone differs from the step's only by case (#43 finding 7)", async () => {
+  const { deps, input } = await setup("m1");
+  const landed = await land(deps, input);
+  expect(landed.hints).toContainEqual(expect.stringContaining("M1 is not m1"));
+});
+
+it("runs the gate's git work before taking the workspace lock (#43 finding 5)", async () => {
+  const { deps, run, input } = await setup();
+  writeFileSync(runPaths(run.dir).agents, "");
+  let release!: () => void;
+  const held = new Promise<void>((resolve) => (release = resolve));
+  let entered!: () => void;
+  const inside = new Promise<void>((resolve) => (entered = resolve));
+  const holder = withWorkspaceAdmission(run, deps.now, async () => {
+    entered();
+    await held;
+  });
+  await inside;
+  try {
+    // the gate refuses (no reviewer, no verifier) while the lock is still held: it never waited for it
+    await expect(land(deps, input)).rejects.toMatchObject({ code: "E_LAND_GATE" });
+  } finally {
+    release();
+    await holder;
+  }
+});
+
 it("refuses landing with corrupted dispatch records", async () => {
   const { deps, run, input } = await setup();
   appendFileSync(runPaths(run.dir).runs, "{broken-record\n");
````

**Code (scratch `d2c610e`):**

````diff
diff --git a/src/services/lane-service.ts b/src/services/lane-service.ts
index d259658..6ab41bb 100644
--- a/src/services/lane-service.ts
+++ b/src/services/lane-service.ts
@@ -19,7 +19,13 @@ import { laneFile } from "./admission.ts";
 import { budgetOf } from "./budget.ts";
 import { pendingDispatches } from "./dispatches.ts";
 import { workspaceBudget } from "./workspace-admission.ts";
-import { findWorkspace, workspaceChildren, workspaceDirectory, workspacePaths } from "./workspace-store.ts";
+import {
+  findWorkspace,
+  WORKSPACE_LOCK_WAIT_MS,
+  workspaceChildren,
+  workspaceDirectory,
+  workspacePaths,
+} from "./workspace-store.ts";
 import {
   isDocPath,
   isSourcePath,
@@ -46,7 +52,7 @@ import {
 } from "./run-store.ts";
 import { writeDigest } from "./protocol.ts";
 import { openQuestions } from "./questions.ts";
-import { type Notes, type NotesPatch, refreshState } from "./state.ts";
+import { type Notes, type NotesPatch, patchNotes, refreshState } from "./state.ts";
 
 const withHints = (hints: string[]) => (hints.length ? { hints } : {});
 
@@ -311,37 +317,61 @@ type LandInput = {
   skip?: LandSkip;
 };
 
-export async function land(deps: Deps, i: LandInput) {
+type LandResult = { ledger: string; minutes: number; digest: string; hints?: string[] };
+
+export async function land(deps: Deps, i: LandInput): Promise<LandResult> {
   const run = findRun(i.run);
-  if (!run.meta.workspace) return landRun(deps, i, run);
-  const workspace = findWorkspace(run.meta.workspace.id);
-  // Completion and dispatch admission share a boundary. Landing remains available at a spent budget.
-  return withFileLock(workspacePaths(workspaceDirectory(workspace.id)).admission, async () => {
-    if (!workspaceChildren(workspace).some((child) => child.dir === run.dir))
-      throw new CatherdError("E_RUN_CORRUPT", "the run is not a member of its workspace execution");
-    const pending = await withFileLock(runPaths(run.dir).runs, () => {
-      const { records, corrupt } = readRecords(run);
-      if (corrupt)
-        throw new CatherdError("E_RUN_CORRUPT", "workspace completion has unreadable dispatch records", {
-          fix: "repair the child's dispatch records before landing its milestone",
+  const link = run.meta.workspace;
+  if (!link) return landRun(deps, i, run);
+  const workspace = findWorkspace(link.id);
+  const step = workspace.steps.find((s) => s.id === link.step);
+  if (!step || !workspaceChildren(workspace).some((child) => child.dir === run.dir))
+    throw new CatherdError("E_RUN_CORRUPT", "the run is not a member of its workspace execution");
+  // #43 finding 3: only the step's completion milestone waits for the child's dispatches
+  if (i.milestone !== step.milestone) {
+    const landed = await landRun(deps, i, run);
+    if (i.milestone.toLowerCase() !== step.milestone.toLowerCase()) return landed;
+    // #43 finding 7: m1 is not M1; the dependents wait on the step's own milestone
+    const hint = `${i.milestone} is not ${step.milestone}, the milestone workspace step ${step.id} completes on: its dependents still wait`;
+    return { ...landed, hints: [...(landed.hints ?? []), hint] };
+  }
+  // An unreadable newer native verdict must not leave an older PASS standing.
+  readAgentRuns(run, true);
+  // Completion and dispatch admission share a boundary, held only for the check and the ledger row: the git
+  // work runs outside it (#43 finding 5). Landing remains available at a spent budget.
+  return landRun(deps, i, run, (write) =>
+    withFileLock(
+      workspacePaths(workspaceDirectory(workspace.id)).admission,
+      async () => {
+        const pending = await withFileLock(runPaths(run.dir).runs, () => {
+          const { records, corrupt } = readRecords(run);
+          if (corrupt)
+            throw new CatherdError("E_RUN_CORRUPT", "workspace completion has unreadable dispatch records", {
+              fix: "repair the child's dispatch records before landing its milestone",
+            });
+          return pendingDispatches(run, deps.now(), records, true);
         });
-      return pendingDispatches(run, deps.now(), records, true);
-    });
-    if (pending.length)
-      throw new CatherdError("E_LAND_GATE", "workspace completion waits for all admitted dispatches", {
-        fix: "finish and collect the child's dispatches before landing its milestone",
-      });
-    // An unreadable newer native verdict must not leave an older PASS standing.
-    readAgentRuns(run, true);
-    return landRun(deps, i, run);
-  });
+        if (pending.length)
+          throw new CatherdError("E_LAND_GATE", "workspace completion waits for all admitted dispatches", {
+            fix: "finish and collect the child's dispatches before landing its milestone",
+          });
+        return write();
+      },
+      { timeoutMs: WORKSPACE_LOCK_WAIT_MS },
+    ),
+  );
 }
 
+/**
+ * The checks (commit, gate) first, then the ledger row and the notes, inside `critical` (a workspace
+ * completion's lock), with no git; then state.md, the lane outcomes, knowledge and the digest.
+ */
 async function landRun(
   deps: Deps,
   i: LandInput,
   run: Run,
-): Promise<{ ledger: string; minutes: number; digest: string; hints?: string[] }> {
+  critical: (write: () => Promise<Notes>) => Promise<Notes> = (write) => write(),
+): Promise<LandResult> {
   // the digest is named after the milestone: an id, checked before anything is written
   assertId("milestone", i.milestone);
   // commitExists throws E_IO_UNEXPECTED on a timeout, which reaches the caller as is
@@ -362,8 +392,9 @@ async function landRun(
     appendLedger(run, row);
     return { lastCheck: cell(i.evidence), next: i.next, lastLandedAt: now.toISOString() };
   };
-  // on a failed refresh the notes still reach state.json, so the next landing counts its minutes from this one
-  const { hints } = await refreshState(run, landRow);
+  // the notes reach state.json first, with no git: the next landing counts its minutes from this one
+  await critical(() => patchNotes(run, landRow));
+  const { hints } = await refreshState(run);
   // spec §5.6: every routed lane of the milestone lands with it
   // under the routes lock, so a racing climb cannot slip between the read and the rows
   let routed: string[] = [];
diff --git a/src/services/state.ts b/src/services/state.ts
index 1317b20..a340d70 100644
--- a/src/services/state.ts
+++ b/src/services/state.ts
@@ -76,6 +76,24 @@ export function updateState(run: Run, change: NotesPatch | ((n: Notes) => NotesP
   });
 }
 
+/**
+ * Writes state.json's notes only, with no git, under the state lock; for a writer that must not wait on git
+ * while it holds another lock (`land` in a workspace, #43 finding 5). It waits out a refresh's git (15 s).
+ */
+export function patchNotes(run: Run, change: (n: Notes) => NotesPatch): Promise<Notes> {
+  const stateJson = runPaths(run.dir).stateJson;
+  return withFileLock(
+    stateJson,
+    () => {
+      const notes = readNotes(run);
+      const next = parkedNext({ ...notes, ...change(notes) });
+      writeJsonAtomic(stateJson, next);
+      return next;
+    },
+    { timeoutMs: 30_000 },
+  );
+}
+
 /**
  * Ruling (b): a failed state.md refresh (git broken) never fails the call. The notes still go to state.json
  * under the state lock (state.md stays as it was), and the message comes back as a hint.
diff --git a/src/services/workspace-admission.ts b/src/services/workspace-admission.ts
index bbc5fa4..6f48e83 100644
--- a/src/services/workspace-admission.ts
+++ b/src/services/workspace-admission.ts
@@ -9,7 +9,13 @@ import { spendOf } from "./budget.ts";
 import { pendingDispatches } from "./dispatches.ts";
 import { landedMilestones } from "./milestones.ts";
 import { readRecords, type Run, runPaths } from "./run-store.ts";
-import { findWorkspace, workspaceChildren, workspaceDirectory, workspacePaths } from "./workspace-store.ts";
+import {
+  findWorkspace,
+  WORKSPACE_LOCK_WAIT_MS,
+  workspaceChildren,
+  workspaceDirectory,
+  workspacePaths,
+} from "./workspace-store.ts";
 
 /**
  * Count each recorded or unrecorded dispatch once; elapsed minutes belong to the parent. With `warnings`,
@@ -126,35 +132,37 @@ export async function withWorkspaceAdmission<T>(
   const link = run.meta.workspace;
   if (!link) return admit();
   const workspace = findWorkspace(link.id);
-  return withFileLock(workspacePaths(workspaceDirectory(workspace.id)).admission, async () => {
-    const now = typeof clock === "function" ? clock() : clock;
-    const children = workspaceChildren(workspace);
-    const step = workspace.steps.find((s) => s.id === link.step);
-    if (!step || !children.some((c) => c.id === run.id))
-      throw new CatherdError("E_INPUT_INVALID", "the run is not a member of this workspace execution", {
-        fix: "start the child with workspace_child_start",
-      });
-    if ((await gitToplevel(run.meta.repo)) !== run.meta.repo)
-      throw new CatherdError(
-        "E_IO_PATH",
-        `workspace repository ${step.repo} is no longer the captured git root`,
-      );
-    if (landedMilestones(run).includes(step.milestone))
-      throw new CatherdError("E_INPUT_INVALID", `${step.id} has already landed its completion milestone`, {
-        fix: "start a new workspace execution for further changes",
-      });
-    const blockers = await dependencyBlockers(workspace, step, children, now);
-    if (blockers.length)
-      throw new CatherdError(
-        "E_INPUT_INVALID",
-        `${step.id} is waiting: ${blockers.map((b) => b.why).join("; ")}`,
-        {
-          fix: "land the dependency's completion milestone and collect its finished dispatches first",
-        },
-      );
-    await assertWorkspaceBudget(workspace, now, children);
-    return admit();
-  });
+  // git outside the workspace lock (#43 finding 5): the checkout check needs no sibling to wait
+  if ((await gitToplevel(run.meta.repo)) !== run.meta.repo)
+    throw new CatherdError(
+      "E_IO_PATH",
+      `workspace repository of ${link.step} is no longer the captured git root`,
+    );
+  return withFileLock(
+    workspacePaths(workspaceDirectory(workspace.id)).admission,
+    async () => {
+      const now = typeof clock === "function" ? clock() : clock;
+      const children = workspaceChildren(workspace);
+      const step = workspace.steps.find((s) => s.id === link.step);
+      if (!step || !children.some((c) => c.id === run.id))
+        throw new CatherdError("E_INPUT_INVALID", "the run is not a member of this workspace execution", {
+          fix: "start the child with workspace_child_start",
+        });
+      // #43 finding 7: a landed step's child admits again (a post-land fix); its dependents wait for it
+      const blockers = await dependencyBlockers(workspace, step, children, now);
+      if (blockers.length)
+        throw new CatherdError(
+          "E_INPUT_INVALID",
+          `${step.id} is waiting: ${blockers.map((b) => b.why).join("; ")}`,
+          {
+            fix: "land the dependency's completion milestone and collect its finished dispatches first",
+          },
+        );
+      await assertWorkspaceBudget(workspace, now, children);
+      return admit();
+    },
+    { timeoutMs: WORKSPACE_LOCK_WAIT_MS },
+  );
 }
 
 /** Whether the budget caps anything: without a cap, no sibling's evidence is read (#43 finding 2). */
@@ -187,16 +195,20 @@ export async function workspaceContract(i: {
       path: paths.contract,
       content: existsSync(paths.contract) ? readFileSync(paths.contract, "utf8") : "",
     };
-  return withFileLock(paths.admission, () => {
-    if (workspaceChildren(workspace).length)
-      throw new CatherdError(
-        "E_INPUT_INVALID",
-        "the workspace contract is frozen because a child has started",
-        {
-          fix: "start a new workspace execution to change the shared contract",
-        },
-      );
-    writeTextAtomic(paths.contract, i.content as string);
-    return { path: paths.contract, content: i.content as string };
-  });
+  return withFileLock(
+    paths.admission,
+    () => {
+      if (workspaceChildren(workspace).length)
+        throw new CatherdError(
+          "E_INPUT_INVALID",
+          "the workspace contract is frozen because a child has started",
+          {
+            fix: "start a new workspace execution to change the shared contract",
+          },
+        );
+      writeTextAtomic(paths.contract, i.content as string);
+      return { path: paths.contract, content: i.content as string };
+    },
+    { timeoutMs: WORKSPACE_LOCK_WAIT_MS },
+  );
 }
diff --git a/src/services/workspace-service.ts b/src/services/workspace-service.ts
index 8774063..ea6f8a0 100644
--- a/src/services/workspace-service.ts
+++ b/src/services/workspace-service.ts
@@ -19,6 +19,7 @@ import {
   createWorkspace,
   findWorkspace,
   unreadableWarning,
+  WORKSPACE_LOCK_WAIT_MS,
   workspaceChildren,
   workspaceDirectory,
   workspaceListing,
@@ -140,39 +141,55 @@ export async function startWorkspaceChild(
 ): Promise<{ run: string; dir: string; contract: string | null }> {
   const workspace = findWorkspace(input.workspace);
   const paths = workspacePaths(workspaceDirectory(workspace.id));
-  return withFileLock(paths.admission, async () => {
-    const children = workspaceChildren(workspace);
-    const step = workspace.steps.find((s) => s.id === input.step);
-    if (!step) throw invalid(`unknown workspace step ${input.step}`);
-    // Recovery must validate the checkout too; stored status remains readable without it.
-    const repo = workspace.repos[step.repo]!;
-    if ((await gitToplevel(repo)) !== repo)
-      throw new CatherdError(
-        "E_IO_PATH",
-        `workspace repository ${step.repo} is no longer the captured git root`,
-      );
-    let run = children.find((r) => r.meta.workspace?.step === step.id);
-    if (!run) {
-      const blockers = await dependencyBlockers(workspace, step, children, deps.now());
-      if (blockers.length)
-        throw invalid(`workspace step ${step.id} waits: ${blockers.map((b) => b.why).join("; ")}`);
-      await assertWorkspaceBudget(workspace, deps.now(), children);
-      run = createRun({
-        repo,
-        title: step.title,
-        aLines: step.aLines,
-        version: deps.version,
-        now: new Date(deps.now()),
-        startedBy: currentSession(deps),
-        workspace: { id: workspace.id, step: step.id },
-      });
-    }
-    const contract = existsSync(paths.contract) ? join(run.dir, "workspace-contract.md") : null;
-    if (contract && !existsSync(contract)) writeTextAtomic(contract, readFileSync(paths.contract, "utf8"));
-    await claimRun(deps, run);
-    await refreshState(run);
-    return { run: run.id, dir: run.dir, contract };
-  });
+  const step = workspace.steps.find((s) => s.id === input.step);
+  if (!step) throw invalid(`unknown workspace step ${input.step}`);
+  // Recovery must validate the checkout too; stored status remains readable without it. The git work runs
+  // outside the workspace lock (#43 finding 5).
+  const repo = workspace.repos[step.repo]!;
+  if ((await gitToplevel(repo)) !== repo)
+    throw new CatherdError(
+      "E_IO_PATH",
+      `workspace repository ${step.repo} is no longer the captured git root`,
+    );
+  const run = await withFileLock(
+    paths.admission,
+    () => childFor(deps, workspace, step, repo, paths.contract),
+    { timeoutMs: WORKSPACE_LOCK_WAIT_MS },
+  );
+  const contract = existsSync(paths.contract) ? join(run.dir, "workspace-contract.md") : null;
+  await claimRun(deps, run);
+  await refreshState(run);
+  return { run: run.id, dir: run.dir, contract };
+}
+
+/** Under the workspace lock: the step's child, created once its dependencies release it. */
+async function childFor(
+  deps: Deps,
+  workspace: Workspace,
+  step: Workspace["steps"][number],
+  repo: string,
+  contractFile: string,
+): Promise<Run> {
+  const children = workspaceChildren(workspace);
+  let run = children.find((r) => r.meta.workspace?.step === step.id);
+  if (!run) {
+    const blockers = await dependencyBlockers(workspace, step, children, deps.now());
+    if (blockers.length)
+      throw invalid(`workspace step ${step.id} waits: ${blockers.map((b) => b.why).join("; ")}`);
+    await assertWorkspaceBudget(workspace, deps.now(), children);
+    run = createRun({
+      repo,
+      title: step.title,
+      aLines: step.aLines,
+      version: deps.version,
+      now: new Date(deps.now()),
+      startedBy: currentSession(deps),
+      workspace: { id: workspace.id, step: step.id },
+    });
+  }
+  const contract = existsSync(contractFile) ? join(run.dir, "workspace-contract.md") : null;
+  if (contract && !existsSync(contract)) writeTextAtomic(contract, readFileSync(contractFile, "utf8"));
+  return run;
 }
 
 export async function workspaceStatus(deps: Deps, id: string) {
diff --git a/src/services/workspace-store.ts b/src/services/workspace-store.ts
index 72778a6..17842d9 100644
--- a/src/services/workspace-store.ts
+++ b/src/services/workspace-store.ts
@@ -21,6 +21,12 @@ export function workspacePaths(dir: string) {
   };
 }
 
+/**
+ * How long a workspace-lock waiter waits (#43 finding 5): longer than the slowest holder, an admission
+ * whose git status snapshot may take up to 15 s, so a dispatch in another repository never fails E_IO_LOCK.
+ */
+export const WORKSPACE_LOCK_WAIT_MS = 120_000;
+
 export function createWorkspace(
   input: Omit<Workspace, "schema" | "id" | "createdAt">,
   now = new Date(),
````

### Task 3: No workspace budget cap by default, minutes from the first child, `workspace_budget` (#43 findings 4, 6)

**Files:** `src/services/workspace-admission.ts`, `src/services/workspace-store.ts`, `src/services/workspace-service.ts`, `src/entry/mcp/workspace-tools.ts`, `test/services/workspace-admission.test.ts`, `test/entry/mcp.test.ts`.

**Produces:** `setWorkspaceBudget(deps, { workspace, minutes?, tokens?, usd? })` (number sets, `null` removes), `saveWorkspace(workspace)`, the MCP tool `workspace_budget` (32 tools), `z.strictObject` step objects. **Consumes:** Task 2's `WORKSPACE_LOCK_WAIT_MS`.

- [ ] **Step 1: the failing tests.** Apply the test diff. Run `bun test test/services/workspace-admission.test.ts test/entry/mcp.test.ts`: the default-budget, first-child-minutes, raise, strict-object and tool-list tests fail.
- [ ] **Step 2: the code.** Apply the source diff; run the same command.
- [ ] **Step 3: commit** `feat(workspace): no budget cap by default, minutes from the first child, workspace_budget` (scratch `4787ebb`).

**Tests (scratch `4787ebb`):**

````diff
diff --git a/test/entry/mcp.test.ts b/test/entry/mcp.test.ts
index a35e462..da4ef60 100644
--- a/test/entry/mcp.test.ts
+++ b/test/entry/mcp.test.ts
@@ -45,13 +45,14 @@ const TOOLS = [
   "workspace_contract",
   "workspace_child_start",
   "workspace_status",
+  "workspace_budget",
 ];
 
 describe("MCP server", () => {
-  it("lists exactly the run and workspace tools, 31 of them", async () => {
+  it("lists exactly the run and workspace tools, 32 of them", async () => {
     freshRun();
     const c = await mcpClient();
-    expect(TOOLS).toHaveLength(31);
+    expect(TOOLS).toHaveLength(32);
     expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
     const described = (name: string) =>
       c.listTools().then((l) => l.tools.find((t) => t.name === name)?.description ?? "");
@@ -110,6 +111,11 @@ describe("MCP server", () => {
     const active = await call(c, "workspace_status", { workspace });
     expect(active.data.steps[0]).toMatchObject({ state: "active", run: child.data.run });
     expect(active.data.budget.tokens.cap).toBe(10000);
+    const raised = await call(c, "workspace_budget", { workspace, tokens: 20000, usd: 5 });
+    expect(raised.data.budget).toEqual({ tokens: 20000, usd: 5 });
+    expect((await call(c, "workspace_budget", { workspace, usd: null })).data.budget).toEqual({
+      tokens: 20000,
+    });
     const status = cli("workspace", "status", workspace, "--json");
     expect(status.exitCode).toBe(0);
     expect(JSON.parse(status.stdout.toString()).steps[0]).toMatchObject({
@@ -118,6 +124,24 @@ describe("MCP server", () => {
     });
   });
 
+  it("refuses a workspace step with an unknown key instead of dropping it (#43 finding 6)", async () => {
+    freshRun();
+    const root = tempDir("catherd-workspace-");
+    const c = await mcpClient(fakeDeps());
+    const r = await call(c, "workspace_start", {
+      root,
+      repos: { api: tempRepo(), web: tempRepo() },
+      title: "camel case",
+      a_lines: ["A1 web waits for api"],
+      steps: [
+        { id: "api", repo: "api", title: "API", a_lines: ["A1 API"] },
+        { id: "web", repo: "web", title: "Web", a_lines: ["A1 Web"], dependsOn: ["api"] },
+      ],
+    });
+    expect(r.isError).toBe(true);
+    expect(r.raw).toContain("dependsOn");
+  });
+
   it("reports its version in status", async () => {
     freshRun();
     const r = await call(await mcpClient(), "status");
diff --git a/test/services/workspace-admission.test.ts b/test/services/workspace-admission.test.ts
index dc1aac7..3981435 100644
--- a/test/services/workspace-admission.test.ts
+++ b/test/services/workspace-admission.test.ts
@@ -11,6 +11,7 @@ import {
   runPaths,
 } from "../../src/services/run-store.ts";
 import {
+  setWorkspaceBudget,
   workspaceBudget,
   workspaceContract,
   workspaceSpend,
@@ -19,7 +20,7 @@ import {
 import { startWorkspace, startWorkspaceChild } from "../../src/services/workspace-service.ts";
 import { workspaceChildren } from "../../src/services/workspace-store.ts";
 import { snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";
-import { fakeDeps, fakeDispatch, makeRecord } from "./helpers.ts";
+import { fakeDeps, fakeDispatch, makeRecord, testView } from "./helpers.ts";
 
 afterEach(snapshotEnv());
 
@@ -98,6 +99,41 @@ it("counts finalized, pending and native usage once across siblings with parent
   expect((await workspaceBudget(producer, now))?.fraction).toBe(0.5);
 });
 
+it("has no cap by default, and counts minutes from the first child, not the workspace (#43 finding 4)", async () => {
+  withHome();
+  let now = Date.parse("2026-10-02T10:00:00.000Z");
+  const deps = fakeDeps({ now: () => now, view: testView({ budget: { minutes: 1 } }) });
+  const { workspace } = await startWorkspace(deps, {
+    root: tempDir("catherd-parent-"),
+    repos: { app: tempRepo() },
+    title: "Overnight",
+    aLines: [],
+    steps: [{ id: "app", repo: "app", title: "App", aLines: [] }],
+  });
+  // the profile's per-run budget is no longer the workspace's
+  expect(workspace.budget).toEqual({});
+  now += 10 * 60 * 60_000; // a night before the first child
+  expect((await workspaceSpend(workspace, now)).minutes).toBe(0);
+  await startWorkspaceChild(deps, { workspace: workspace.id, step: "app" });
+  now += 30 * 60_000;
+  expect((await workspaceSpend(workspace, now)).minutes).toBe(30);
+});
+
+it("raises a spent workspace budget so the next sibling is admitted (#43 finding 4)", async () => {
+  const { deps, workspace, producer, consumer } = await setup({ tokens: 1000 });
+  await appendRecord(
+    producer,
+    makeRecord({ runId: producer.id, tokens: { input: 1000, cached: 0, output: 0 } }),
+  );
+  await expect(withWorkspaceAdmission(consumer, deps.now(), async () => "admitted")).rejects.toMatchObject({
+    code: "E_RUN_BUDGET",
+    fix: expect.stringContaining("workspace_budget"),
+  });
+  const raised = await setWorkspaceBudget(deps, { workspace: workspace.id, tokens: 5000 });
+  expect(raised.budget).toEqual({ tokens: 5000 });
+  expect(await withWorkspaceAdmission(consumer, deps.now(), async () => "admitted")).toBe("admitted");
+});
+
 it("cost routing sees sibling spend at the shared 80 percent threshold", async () => {
   const { deps, producer, consumer } = await setup();
   await appendRecord(
````

**Code (scratch `4787ebb`):**

````diff
diff --git a/src/entry/mcp/workspace-tools.ts b/src/entry/mcp/workspace-tools.ts
index 26b38a3..360ac8b 100644
--- a/src/entry/mcp/workspace-tools.ts
+++ b/src/entry/mcp/workspace-tools.ts
@@ -2,7 +2,7 @@ import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 import { z } from "zod";
 import { WORKSPACE_LIMIT, WorkspaceBudgetSchema, WorkspaceIdSchema } from "../../domain/workspace.ts";
 import type { Deps } from "../../services/ports.ts";
-import { workspaceContract } from "../../services/workspace-admission.ts";
+import { setWorkspaceBudget, workspaceContract } from "../../services/workspace-admission.ts";
 import {
   inspectWorkspace,
   startWorkspace,
@@ -32,7 +32,7 @@ export function registerWorkspaceTools(server: McpServer, deps: Deps): void {
     "workspace_start",
     {
       description:
-        "Snapshot a workspace's selected repositories, step dependency graph and optional shared budget. Returns workspace.id and dir. Child single-repo runs are created later with workspace_child_start; no commits or pushes are performed.",
+        "Snapshot a workspace's selected repositories, step dependency graph and optional shared budget (no cap unless given; raise it later with workspace_budget). Returns workspace.id and dir. Child single-repo runs are created later with workspace_child_start; no commits or pushes are performed.",
       inputSchema: {
         root: z.string().min(1),
         title: z.string().min(1),
@@ -40,7 +40,8 @@ export function registerWorkspaceTools(server: McpServer, deps: Deps): void {
         repos,
         steps: z
           .array(
-            z.object({
+            // #43 finding 6: an unknown key (dependsOn for depends_on) is refused, never dropped
+            z.strictObject({
               id,
               repo: id,
               title: z.string().min(1),
@@ -91,6 +92,16 @@ export function registerWorkspaceTools(server: McpServer, deps: Deps): void {
     },
     (a) => handle(() => startWorkspaceChild(deps, a)),
   );
+  const cap = z.number().finite().nonnegative().nullable().optional();
+  server.registerTool(
+    "workspace_budget",
+    {
+      description:
+        "Set or raise a workspace's shared budget: each of minutes, tokens and usd given as a number replaces that cap, null removes it, and one left out stays. A workspace has no cap unless one is set; its minutes count from its first child. Returns the budget, the spend and its status.",
+      inputSchema: { workspace: z.string().min(1), minutes: cap, tokens: cap, usd: cap },
+    },
+    (a) => handle(() => setWorkspaceBudget(deps, a)),
+  );
   server.registerTool(
     "workspace_status",
     {
diff --git a/src/services/workspace-admission.ts b/src/services/workspace-admission.ts
index 6f48e83..132b71e 100644
--- a/src/services/workspace-admission.ts
+++ b/src/services/workspace-admission.ts
@@ -11,6 +11,7 @@ import { landedMilestones } from "./milestones.ts";
 import { readRecords, type Run, runPaths } from "./run-store.ts";
 import {
   findWorkspace,
+  saveWorkspace,
   WORKSPACE_LOCK_WAIT_MS,
   workspaceChildren,
   workspaceDirectory,
@@ -18,9 +19,10 @@ import {
 } from "./workspace-store.ts";
 
 /**
- * Count each recorded or unrecorded dispatch once; elapsed minutes belong to the parent. With `warnings`,
- * a child whose cost evidence cannot be read is skipped and named there (status); without, it throws
- * E_RUN_CORRUPT (admission against a cap, which cannot prove the cap holds without it).
+ * Count each recorded or unrecorded dispatch once; elapsed minutes belong to the parent and start at its first
+ * child (#43 finding 4), none before one. With `warnings`, a child whose cost evidence cannot be read is
+ * skipped and named there (status); without, it throws E_RUN_CORRUPT (admission against a cap, which cannot
+ * prove the cap holds without it).
  */
 export async function workspaceSpend(
   workspace: Workspace,
@@ -28,8 +30,9 @@ export async function workspaceSpend(
   children = workspaceChildren(workspace),
   warnings?: string[],
 ): Promise<Spend> {
+  const first = Math.min(...children.map((c) => Date.parse(c.meta.createdAt)).filter(Number.isFinite));
   const total: Spend = {
-    minutes: Math.max(0, (now - Date.parse(workspace.createdAt)) / 60_000),
+    minutes: Number.isFinite(first) ? Math.max(0, (now - first) / 60_000) : 0,
     tokens: 0,
     usd: 0,
   };
@@ -179,10 +182,36 @@ export async function assertWorkspaceBudget(
   const budget = budgetStatus(await workspaceSpend(workspace, now, children), workspace.budget);
   if (budget && budget.fraction >= 1)
     throw new CatherdError("E_RUN_BUDGET", `the workspace budget is spent: ${formatBudget(budget)}`, {
-      fix: "finish with the work already admitted, or start a new workspace with an authorized budget",
+      fix: `finish with the work already admitted, or raise it: workspace_budget(${workspace.id}, …)`,
     });
 }
 
+/**
+ * `workspace_budget`: sets the caps given (a number) or removes them (null), keeping the others; the owner's
+ * way to raise a spent budget without a new workspace (#43 finding 4). Returns the budget and its status.
+ */
+export async function setWorkspaceBudget(
+  deps: { now: () => number },
+  i: { workspace: string; minutes?: number | null; tokens?: number | null; usd?: number | null },
+): Promise<{ budget: Workspace["budget"]; spend: Spend; status: BudgetStatus | null }> {
+  const workspace = findWorkspace(i.workspace);
+  return withFileLock(
+    workspacePaths(workspaceDirectory(workspace.id)).admission,
+    async () => {
+      const budget: Workspace["budget"] = { ...findWorkspace(workspace.id).budget };
+      for (const key of ["minutes", "tokens", "usd"] as const) {
+        const v = i[key];
+        if (v === null) delete budget[key];
+        else if (v !== undefined) budget[key] = v;
+      }
+      const saved = saveWorkspace({ ...findWorkspace(workspace.id), budget });
+      const spend = await workspaceSpend(saved, deps.now(), undefined, []);
+      return { budget: saved.budget, spend, status: budgetStatus(spend, saved.budget) };
+    },
+    { timeoutMs: WORKSPACE_LOCK_WAIT_MS },
+  );
+}
+
 /** The shared contract is frozen when the first child starts, then copied into child dossiers. */
 export async function workspaceContract(i: {
   workspace: string;
diff --git a/src/services/workspace-service.ts b/src/services/workspace-service.ts
index ea6f8a0..0f0fd4e 100644
--- a/src/services/workspace-service.ts
+++ b/src/services/workspace-service.ts
@@ -112,7 +112,8 @@ export async function startWorkspace(
     createdAt: new Date(deps.now()).toISOString(),
     repos: selected,
     steps: input.steps,
-    budget: input.budget ?? deps.profiles.budgetFor?.(null) ?? deps.profiles.forRepo(null).budget,
+    // #43 finding 4: no cap unless the owner sets one; each child keeps its own profile budget
+    budget: input.budget ?? {},
   });
   if (!snapshot.success)
     throw invalid(
diff --git a/src/services/workspace-store.ts b/src/services/workspace-store.ts
index 17842d9..2777655 100644
--- a/src/services/workspace-store.ts
+++ b/src/services/workspace-store.ts
@@ -43,6 +43,13 @@ export function createWorkspace(
   return workspace;
 }
 
+/** Rewrites the workspace's meta.json, validated; callers hold the workspace's admission lock. */
+export function saveWorkspace(workspace: Workspace): Workspace {
+  const parsed = WorkspaceSchema.parse(workspace);
+  writeJsonAtomic(workspacePaths(workspaceDirectory(parsed.id)).meta, parsed);
+  return parsed;
+}
+
 export function findWorkspace(id: string): Workspace {
   const file = workspacePaths(workspaceDirectory(id)).meta;
   if (!existsSync(file)) throw new CatherdError("E_RUN_NOT_FOUND", `no workspace "${id}"`);
````

### Task 4: Release a step's dependents on merge into a base ref

**Files:** `src/domain/workspace.ts`, `src/services/workspace-admission.ts`, `src/services/workspace-service.ts`, `src/entry/mcp/workspace-tools.ts`, `test/services/workspace.test.ts`.

**Produces:** step fields `release: "land" | "merge"` (default `land`) and `base`, `BaseRefSchema`, `RELEASES`; `dependencyBlockers(…, { merge: true })` in child start and status. **Consumes:** Task 1's rule, `git` from `src/infra/git.ts`.

- [ ] **Step 1: the failing tests.** Apply the test diff. Run `bun test test/services/workspace.test.ts`: the merge-release and base-ref tests fail.
- [ ] **Step 2: the code.** Apply the source diff. Run `bun test test/services/workspace test/domain/workspace.test.ts test/entry/mcp.test.ts`.
- [ ] **Step 3: commit** `feat(workspace): release a step's dependents on merge into a base ref` (scratch `8f61b29`).

**Tests (scratch `8f61b29`):**

````diff
diff --git a/test/services/workspace.test.ts b/test/services/workspace.test.ts
index 873fea2..d26b01a 100644
--- a/test/services/workspace.test.ts
+++ b/test/services/workspace.test.ts
@@ -1,4 +1,5 @@
 import { afterEach, expect, it } from "bun:test";
+import { execFileSync } from "node:child_process";
 import {
   appendFileSync,
   mkdirSync,
@@ -345,6 +346,45 @@ it("keeps siblings and status working when one child has a torn records line (#4
   expect(status.warnings).toContainEqual(`api: run ${api.id} has unreadable dispatch records`);
 });
 
+it("releases a merge step's dependents only once its landed commit is in the base ref", async () => {
+  const { deps, input } = setup();
+  const { workspace } = await startWorkspace(deps, {
+    ...input,
+    steps: [{ ...input.steps[0]!, release: "merge", base: "staging" }, input.steps[1]!],
+  });
+  const git = (...args: string[]) =>
+    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
+      cwd: input.repos.api,
+      encoding: "utf8",
+    }).trim();
+  git("branch", "staging");
+  git("checkout", "-q", "-b", "feature");
+  git("commit", "-q", "--allow-empty", "-m", "api work");
+  const commit = git("rev-parse", "HEAD");
+  await startWorkspaceChild(deps, { workspace: workspace.id, step: "api" });
+  const api = workspaceChildren(workspace)[0]!;
+  appendFileSync(runPaths(api.dir).ledger, `M1 | API | ${commit} | 1 | checked\n`);
+  await expect(startWorkspaceChild(deps, { workspace: workspace.id, step: "web" })).rejects.toThrow(
+    `api's M1 (${commit.slice(0, 7)}) is not merged into staging yet`,
+  );
+  expect((await workspaceStatus(deps, workspace.id)).steps[1]?.state).toBe("waiting");
+  git("checkout", "-q", "staging");
+  git("merge", "-q", "--ff-only", "feature");
+  const web = await startWorkspaceChild(deps, { workspace: workspace.id, step: "web" });
+  expect(web.run).not.toBe(api.id);
+});
+
+it("refuses a merge release without a base ref, and a base that looks like an option", async () => {
+  const { deps, input } = setup();
+  for (const step of [
+    { ...input.steps[0]!, release: "merge" as const },
+    { ...input.steps[0]!, release: "merge" as const, base: "--upload-pack=x" },
+  ])
+    await expect(startWorkspace(deps, { ...input, steps: [step, input.steps[1]!] })).rejects.toMatchObject({
+      code: "E_INPUT_INVALID",
+    });
+});
+
 it("admission and child start wait on a dependency for the same reasons (#43 finding 8)", async () => {
   const { deps, input } = setup();
   const { workspace } = await startWorkspace(deps, input);
````

**Code (scratch `8f61b29`):**

````diff
diff --git a/src/domain/workspace.ts b/src/domain/workspace.ts
index 8ca5c13..846b709 100644
--- a/src/domain/workspace.ts
+++ b/src/domain/workspace.ts
@@ -12,14 +12,31 @@ export const WorkspaceBudgetSchema = z.strictObject({
   tokens: z.number().finite().nonnegative().optional(),
   usd: z.number().finite().nonnegative().optional(),
 });
-export const WorkspaceStepSchema = z.strictObject({
-  id: WorkspaceIdSchema,
-  repo: WorkspaceIdSchema,
-  title: z.string().min(1),
-  aLines: z.array(z.string()),
-  dependsOn: z.array(WorkspaceIdSchema).max(WORKSPACE_LIMIT).default([]),
-  milestone: WorkspaceIdSchema.default("M1"),
-});
+/** A git ref a release waits on (`origin/main`): no option, no range, no whitespace. */
+export const BaseRefSchema = z
+  .string()
+  .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/)
+  .refine((s) => !s.includes("..") && !s.endsWith("/") && !s.endsWith(".lock"));
+export const RELEASES = ["land", "merge"] as const;
+export const WorkspaceStepSchema = z
+  .strictObject({
+    id: WorkspaceIdSchema,
+    repo: WorkspaceIdSchema,
+    title: z.string().min(1),
+    aLines: z.array(z.string()),
+    dependsOn: z.array(WorkspaceIdSchema).max(WORKSPACE_LIMIT).default([]),
+    milestone: WorkspaceIdSchema.default("M1"),
+    /**
+     * When the step releases its dependents: once its milestone lands (the default), or once the landed
+     * commit is an ancestor of `base` in its repository (`git merge-base --is-ancestor`), checked when a
+     * dependent asks, never polled.
+     */
+    release: z.enum(RELEASES).default("land"),
+    base: BaseRefSchema.optional(),
+  })
+  .refine((s) => (s.release === "merge") === (s.base !== undefined), {
+    message: 'release "merge" needs a base ref (e.g. origin/main), and only it takes one',
+  });
 export type WorkspaceStep = z.infer<typeof WorkspaceStepSchema>;
 export const WorkspaceSchema = z
   .strictObject({
diff --git a/src/entry/mcp/workspace-tools.ts b/src/entry/mcp/workspace-tools.ts
index 360ac8b..2d91eed 100644
--- a/src/entry/mcp/workspace-tools.ts
+++ b/src/entry/mcp/workspace-tools.ts
@@ -1,6 +1,12 @@
 import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 import { z } from "zod";
-import { WORKSPACE_LIMIT, WorkspaceBudgetSchema, WorkspaceIdSchema } from "../../domain/workspace.ts";
+import {
+  BaseRefSchema,
+  RELEASES,
+  WORKSPACE_LIMIT,
+  WorkspaceBudgetSchema,
+  WorkspaceIdSchema,
+} from "../../domain/workspace.ts";
 import type { Deps } from "../../services/ports.ts";
 import { setWorkspaceBudget, workspaceContract } from "../../services/workspace-admission.ts";
 import {
@@ -32,7 +38,7 @@ export function registerWorkspaceTools(server: McpServer, deps: Deps): void {
     "workspace_start",
     {
       description:
-        "Snapshot a workspace's selected repositories, step dependency graph and optional shared budget (no cap unless given; raise it later with workspace_budget). Returns workspace.id and dir. Child single-repo runs are created later with workspace_child_start; no commits or pushes are performed.",
+        "Snapshot a workspace's selected repositories, step dependency graph and optional shared budget (no cap unless given; raise it later with workspace_budget). A step releases its dependents when its milestone lands, or with release: 'merge' and base (e.g. origin/main) once its landed commit is an ancestor of that ref, checked when a dependent asks. Returns workspace.id and dir. Child single-repo runs are created later with workspace_child_start; no commits or pushes are performed.",
       inputSchema: {
         root: z.string().min(1),
         title: z.string().min(1),
@@ -48,6 +54,8 @@ export function registerWorkspaceTools(server: McpServer, deps: Deps): void {
               a_lines: aLines,
               depends_on: z.array(id).max(WORKSPACE_LIMIT).optional(),
               milestone: id.optional(),
+              release: z.enum(RELEASES).optional(),
+              base: BaseRefSchema.optional(),
             }),
           )
           .min(1)
@@ -70,6 +78,8 @@ export function registerWorkspaceTools(server: McpServer, deps: Deps): void {
             aLines: s.a_lines,
             dependsOn: s.depends_on,
             milestone: s.milestone,
+            release: s.release,
+            base: s.base,
           })),
         }),
       ),
@@ -87,7 +97,7 @@ export function registerWorkspaceTools(server: McpServer, deps: Deps): void {
     "workspace_child_start",
     {
       description:
-        "Create or return a step's single-repo run once its dependencies have landed their declared milestone. Returns run, dir and the frozen contract path. Use the existing route, dispatch, verification and land tools on this child run.",
+        "Create or return a step's single-repo run once its dependencies have landed their declared milestone, every dispatch of theirs is collected, and each 'merge' release's commit is in its base ref (fetch first; nothing is polled). Returns run, dir and the frozen contract path. Use the existing route, dispatch, verification and land tools on this child run.",
       inputSchema: { workspace: z.string().min(1), step: id },
     },
     (a) => handle(() => startWorkspaceChild(deps, a)),
diff --git a/src/services/workspace-admission.ts b/src/services/workspace-admission.ts
index 132b71e..638f018 100644
--- a/src/services/workspace-admission.ts
+++ b/src/services/workspace-admission.ts
@@ -3,11 +3,11 @@ import { budgetStatus, formatBudget, type BudgetStatus, type Spend } from "../do
 import { CatherdError, errorMessage, isCatherdError } from "../domain/errors.ts";
 import type { Workspace, WorkspaceStep } from "../domain/workspace.ts";
 import { withFileLock } from "../infra/filelock.ts";
-import { gitToplevel } from "../infra/git.ts";
+import { git, gitToplevel } from "../infra/git.ts";
 import { writeTextAtomic } from "../infra/store.ts";
 import { spendOf } from "./budget.ts";
 import { pendingDispatches } from "./dispatches.ts";
-import { landedMilestones } from "./milestones.ts";
+import { landedCommits, landedMilestones } from "./milestones.ts";
 import { readRecords, type Run, runPaths } from "./run-store.ts";
 import {
   findWorkspace,
@@ -98,6 +98,7 @@ export async function dependencyBlockers(
   step: WorkspaceStep,
   children: Run[],
   now: number,
+  o: { merge?: boolean } = {},
 ): Promise<Blocker[]> {
   const out: Blocker[] = [];
   for (const id of step.dependsOn) {
@@ -116,12 +117,35 @@ export async function dependencyBlockers(
       });
       continue;
     }
-    const why = await uncollected(child, now);
+    const why = (await uncollected(child, now)) ?? (o.merge ? await unmerged(before, child) : null);
     if (why) out.push({ step: id, why });
   }
   return out;
 }
 
+/** The commit the ledger holds for `milestone`, its latest landing; null when it never landed. */
+function landedCommitOf(run: Run, milestone: string): string | null {
+  const commits = landedCommits(run);
+  const milestones = landedMilestones(run);
+  const at = milestones.lastIndexOf(milestone);
+  return at < 0 ? null : (commits[at] ?? null);
+}
+
+/**
+ * A `release: "merge"` step releases its dependents once its landed commit is an ancestor of its base ref
+ * (`git merge-base --is-ancestor`), in the repository as it stands: catherd never fetches or polls.
+ */
+async function unmerged(step: WorkspaceStep, child: Run): Promise<string | null> {
+  if (step.release !== "merge" || !step.base) return null;
+  const commit = landedCommitOf(child, step.milestone);
+  if (!commit) return `${step.id} has no landed commit for ${step.milestone} in its ledger`;
+  const r = await git(child.meta.repo, ["merge-base", "--is-ancestor", commit, step.base]);
+  if (r.kind === "ok") return null;
+  if (r.kind === "failed" && r.exit === 1)
+    return `${step.id}'s ${step.milestone} (${commit.slice(0, 7)}) is not merged into ${step.base} yet: merge it, git fetch, then ask again`;
+  return `${step.id}: git cannot tell whether ${commit.slice(0, 7)} is in ${step.base} (does the ref exist in ${child.meta.repo}?)`;
+}
+
 export function withRunAdmission<T>(run: Run, now: () => number, admit: () => Promise<T>): Promise<T> {
   return withWorkspaceAdmission(run, now, () => withFileLock(runPaths(run.dir).admission, admit));
 }
diff --git a/src/services/workspace-service.ts b/src/services/workspace-service.ts
index 0f0fd4e..fdfd989 100644
--- a/src/services/workspace-service.ts
+++ b/src/services/workspace-service.ts
@@ -91,6 +91,8 @@ export async function startWorkspace(
       aLines: string[];
       dependsOn?: string[];
       milestone?: string;
+      release?: "land" | "merge";
+      base?: string;
     }>;
     budget?: Budget;
   },
@@ -117,7 +119,7 @@ export async function startWorkspace(
   });
   if (!snapshot.success)
     throw invalid(
-      "workspace requires unique step ids, ordered repository reuse, valid budget, and an acyclic dependency graph",
+      `workspace requires unique step ids, ordered repository reuse, valid budget, and an acyclic dependency graph: ${snapshot.error.issues[0]?.message ?? "invalid"}`,
     );
   const canonical = await inspectWorkspace(root, selected);
   const workspace = createWorkspace({ ...snapshot.data, repos: canonical.repos }, new Date(deps.now()));
@@ -174,7 +176,7 @@ async function childFor(
   const children = workspaceChildren(workspace);
   let run = children.find((r) => r.meta.workspace?.step === step.id);
   if (!run) {
-    const blockers = await dependencyBlockers(workspace, step, children, deps.now());
+    const blockers = await dependencyBlockers(workspace, step, children, deps.now(), { merge: true });
     if (blockers.length)
       throw invalid(`workspace step ${step.id} waits: ${blockers.map((b) => b.why).join("; ")}`);
     await assertWorkspaceBudget(workspace, deps.now(), children);
@@ -210,7 +212,7 @@ export async function workspaceStatus(deps: Deps, id: string) {
     const twin = landed.find((m) => m !== step.milestone && m.toLowerCase() === step.milestone.toLowerCase());
     if (twin && !landed.includes(step.milestone))
       warnings.push(`${step.id} completes on ${step.milestone}, but its run landed ${twin}`);
-    const blockers = await dependencyBlockers(workspace, step, children, deps.now());
+    const blockers = await dependencyBlockers(workspace, step, children, deps.now(), { merge: true });
     const state: "waiting" | "ready" | "active" | "landed" = child
       ? landed.includes(step.milestone) && pending === false
         ? "landed"
````

### Task 5: Pause the machine or a workspace with one reason until resumed

**Files:** `src/services/pause.ts` (new), `src/entry/pause-command.ts` (new), `src/cli.ts`, `src/domain/errors.ts`, `src/services/admission.ts`, `src/services/workspace-service.ts`, `src/services/summary.ts`, `src/entry/runs-command.ts`, `src/entry/mcp/workspace-tools.ts`, `test/services/pause.test.ts` (new), `test/entry/pause-command.test.ts` (new), `test/entry/mcp.test.ts`.

**Produces:** `pauseMachine`, `resumeMachine`, `pauseWorkspace`, `resumeWorkspace`, `pausesFor`, `pausesOver`, `pauseIntervals`, `pauseLine`, `assertNotPaused`, `machinePauseFile`, `workspacePauseFile`; `E_ADMIT_PAUSED`; `status()` and `workspaceStatus` lead with `paused`; MCP `workspace_pause`, `workspace_resume` (34 tools); CLI `catherd pause|resume --machine|--workspace <id>`.

- [ ] **Step 1: the failing tests.** Apply the test diff. Run `bun test test/services/pause.test.ts test/entry/pause-command.test.ts test/entry/mcp.test.ts`: every new test fails (no `pause.ts`, no command, 32 tools).
- [ ] **Step 2: the code.** Apply the source diff; run the same command, then `bun test test/entry/cli.test.ts test/entry/help-text.test.ts test/architecture.test.ts test/services/admission.test.ts`.
- [ ] **Step 3: commit** `feat(pause): pause the machine or a workspace with one reason until resumed` (scratch `c1d5a50`).

**Tests (scratch `c1d5a50`):**

````diff
diff --git a/test/entry/mcp.test.ts b/test/entry/mcp.test.ts
index da4ef60..f923bef 100644
--- a/test/entry/mcp.test.ts
+++ b/test/entry/mcp.test.ts
@@ -46,13 +46,15 @@ const TOOLS = [
   "workspace_child_start",
   "workspace_status",
   "workspace_budget",
+  "workspace_pause",
+  "workspace_resume",
 ];
 
 describe("MCP server", () => {
-  it("lists exactly the run and workspace tools, 32 of them", async () => {
+  it("lists exactly the run and workspace tools, 34 of them", async () => {
     freshRun();
     const c = await mcpClient();
-    expect(TOOLS).toHaveLength(32);
+    expect(TOOLS).toHaveLength(34);
     expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
     const described = (name: string) =>
       c.listTools().then((l) => l.tools.find((t) => t.name === name)?.description ?? "");
diff --git a/test/entry/pause-command.test.ts b/test/entry/pause-command.test.ts
new file mode 100644
index 0000000..074a65b
--- /dev/null
+++ b/test/entry/pause-command.test.ts
@@ -0,0 +1,35 @@
+import { afterEach, expect, it } from "bun:test";
+import { join } from "node:path";
+import { snapshotEnv, withHome } from "../helpers.ts";
+import { SRC } from "../import-graph.ts";
+
+afterEach(snapshotEnv());
+
+function catherd(args: string[]) {
+  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), ...args], {
+    env: { ...process.env, NO_COLOR: "1", ANTHROPIC_API_KEY: "" },
+    stdout: "pipe",
+    stderr: "pipe",
+  });
+  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
+}
+
+it("pauses the machine with a reason, shows it first in status, and resumes it", () => {
+  withHome();
+  const paused = catherd(["pause", "--machine", "the VPN takes the default route"]);
+  expect(paused.code).toBe(0);
+  expect(paused.out).toContain("the machine is paused since");
+  const shown = catherd(["status"]);
+  expect(shown.out.split("\n")[0]).toContain("the VPN takes the default route");
+  expect(JSON.parse(catherd(["status", "--json"]).out).paused).toMatchObject([{ scope: "machine" }]);
+  expect(catherd(["resume", "--machine"]).out).toContain("resumed: the machine");
+  expect(catherd(["resume", "--machine"]).out).toBe("nothing was paused\n");
+});
+
+it("refuses a pause that names neither or both of --machine and --workspace", () => {
+  withHome();
+  const neither = catherd(["pause", "why"]);
+  expect(neither.code).not.toBe(0);
+  expect(neither.err).toContain("--machine or --workspace");
+  expect(catherd(["pause", "--machine", "--workspace", "w", "why"]).code).not.toBe(0);
+});
diff --git a/test/services/pause.test.ts b/test/services/pause.test.ts
new file mode 100644
index 0000000..9e288ec
--- /dev/null
+++ b/test/services/pause.test.ts
@@ -0,0 +1,92 @@
+import { afterEach, expect, it } from "bun:test";
+import { admit, type AdmitInput } from "../../src/services/admission.ts";
+import {
+  machinePauseFile,
+  pauseIntervals,
+  pauseMachine,
+  pauseWorkspace,
+  resumeMachine,
+  resumeWorkspace,
+} from "../../src/services/pause.ts";
+import { status } from "../../src/services/summary.ts";
+import {
+  startWorkspace,
+  startWorkspaceChild,
+  workspaceStatus,
+} from "../../src/services/workspace-service.ts";
+import { workspaceChildren } from "../../src/services/workspace-store.ts";
+import { snapshotEnv, tempDir, tempRepo } from "../helpers.ts";
+import { fakeDeps, freshRun } from "./helpers.ts";
+
+afterEach(snapshotEnv());
+
+const input: AdmitInput = {
+  role: "worker",
+  name: "worker-M1.L1",
+  brief: "the lane",
+  rung: "codex:gpt-6-luna#high",
+  thread: null,
+  lane: null,
+  failoverFrom: null,
+};
+
+/** A rung off every test ladder: admission refuses it right after the pause check, before any backend. */
+const offLadder: AdmitInput = { ...input, rung: "codex:gpt-6-sol#ultra" };
+
+const T0 = Date.parse("2026-10-02T10:00:00.000Z");
+
+it("refuses every dispatch on the machine with the reason until resumed, and status shows it first", async () => {
+  const { run } = freshRun();
+  const deps = fakeDeps({ now: () => T0 });
+  pauseMachine(T0, "the VPN takes the default route");
+  await expect(admit(deps, run, input)).rejects.toMatchObject({
+    code: "E_ADMIT_PAUSED",
+    message: expect.stringContaining("the VPN takes the default route"),
+    fix: expect.stringContaining("catherd resume --machine"),
+  });
+  const s = status(deps, run.id);
+  expect(Object.keys(s)[0]).toBe("paused");
+  expect(s.paused).toEqual([
+    { scope: "machine", reason: "the VPN takes the default route", since: new Date(T0).toISOString() },
+  ]);
+  expect(resumeMachine(T0 + 60_000).resumed?.reason).toBe("the VPN takes the default route");
+  expect(status(deps, run.id).paused).toEqual([]);
+  // admission goes on past the pause, to the next check (this rung is not on the ladder)
+  await expect(admit(deps, run, offLadder)).rejects.toMatchObject({ code: "E_ADMIT_RUNG" });
+  expect(pauseIntervals(machinePauseFile())).toEqual([
+    { from: new Date(T0).toISOString(), to: new Date(T0 + 60_000).toISOString() },
+  ]);
+});
+
+it("refuses a pause without a reason", () => {
+  freshRun();
+  expect(() => pauseMachine(T0, "  ")).toThrow("a pause needs a reason");
+});
+
+it("pauses a workspace's children only, child starts included, until workspace_resume", async () => {
+  const { run: outside } = freshRun();
+  const deps = fakeDeps({ now: () => T0 });
+  const { workspace } = await startWorkspace(deps, {
+    root: tempDir("catherd-pause-"),
+    repos: { a: tempRepo(), b: tempRepo() },
+    title: "Paused together",
+    aLines: [],
+    steps: [
+      { id: "a", repo: "a", title: "A", aLines: [] },
+      { id: "b", repo: "b", title: "B", aLines: [] },
+    ],
+  });
+  await startWorkspaceChild(deps, { workspace: workspace.id, step: "a" });
+  const a = workspaceChildren(workspace)[0]!;
+  pauseWorkspace(T0, { workspace: workspace.id, reason: "Docker is down" });
+  await expect(admit(deps, a, input)).rejects.toMatchObject({ code: "E_ADMIT_PAUSED" });
+  await expect(startWorkspaceChild(deps, { workspace: workspace.id, step: "b" })).rejects.toMatchObject({
+    code: "E_ADMIT_PAUSED",
+    fix: expect.stringContaining(`workspace_resume(${workspace.id})`),
+  });
+  await expect(admit(deps, outside, offLadder)).rejects.toMatchObject({ code: "E_ADMIT_RUNG" });
+  expect((await workspaceStatus(deps, workspace.id)).paused).toMatchObject([{ reason: "Docker is down" }]);
+  expect(status(deps, a.id).paused).toMatchObject([{ scope: "workspace", workspace: workspace.id }]);
+  resumeWorkspace(T0, { workspace: workspace.id });
+  expect((await startWorkspaceChild(deps, { workspace: workspace.id, step: "b" })).run).toBeTruthy();
+});
````

**Code (scratch `c1d5a50`):**

````diff
diff --git a/src/cli.ts b/src/cli.ts
index b1a30f4..f0e37e6 100755
--- a/src/cli.ts
+++ b/src/cli.ts
@@ -52,6 +52,8 @@ export const main: Command = defineCommand({
     knowledge: () => import("./entry/knowledge-command.ts").then((m) => m.knowledgeCommand),
     workspace: () => import("./entry/workspace-command.ts").then((m) => m.workspaceCommand),
     lock: () => import("./entry/lock-command.ts").then((m) => m.lockCommand),
+    pause: () => import("./entry/pause-command.ts").then((m) => m.pauseCommand),
+    resume: () => import("./entry/pause-command.ts").then((m) => m.resumeCommand),
     "capture-fixtures": () =>
       import("./entry/capture-fixtures-command.ts").then((m) => m.captureFixturesCommand),
     mcp: () => import("./entry/mcp/command.ts").then((m) => m.mcpCommand),
diff --git a/src/domain/errors.ts b/src/domain/errors.ts
index 0a08c58..59fde2f 100644
--- a/src/domain/errors.ts
+++ b/src/domain/errors.ts
@@ -17,6 +17,7 @@ export type ErrorCode =
   | "E_ADMIT_OVERLAP"
   | "E_ADMIT_ID"
   | "E_ADMIT_THREAD"
+  | "E_ADMIT_PAUSED"
   | "E_LANE_INVALID"
   | "E_LAND_GATE"
   | "E_CLIMB_DESIGN"
diff --git a/src/entry/mcp/workspace-tools.ts b/src/entry/mcp/workspace-tools.ts
index 2d91eed..a8bb801 100644
--- a/src/entry/mcp/workspace-tools.ts
+++ b/src/entry/mcp/workspace-tools.ts
@@ -7,6 +7,7 @@ import {
   WorkspaceBudgetSchema,
   WorkspaceIdSchema,
 } from "../../domain/workspace.ts";
+import { pauseWorkspace, resumeWorkspace } from "../../services/pause.ts";
 import type { Deps } from "../../services/ports.ts";
 import { setWorkspaceBudget, workspaceContract } from "../../services/workspace-admission.ts";
 import {
@@ -102,6 +103,23 @@ export function registerWorkspaceTools(server: McpServer, deps: Deps): void {
     },
     (a) => handle(() => startWorkspaceChild(deps, a)),
   );
+  server.registerTool(
+    "workspace_pause",
+    {
+      description:
+        "Pause every child of a workspace on one blocker (a VPN, Docker down): admission refuses each dispatch and child start with E_ADMIT_PAUSED and the reason until workspace_resume. Running roles finish. status shows the pause first. Push the reason to the owner once.",
+      inputSchema: { workspace: z.string().min(1), reason: z.string().min(1) },
+    },
+    (a) => handle(() => pauseWorkspace(deps.now(), a)),
+  );
+  server.registerTool(
+    "workspace_resume",
+    {
+      description: "Lift a workspace's pause. Returns the pause it lifted, or null when none was in force.",
+      inputSchema: { workspace: z.string().min(1) },
+    },
+    (a) => handle(() => resumeWorkspace(deps.now(), a)),
+  );
   const cap = z.number().finite().nonnegative().nullable().optional();
   server.registerTool(
     "workspace_budget",
diff --git a/src/entry/pause-command.ts b/src/entry/pause-command.ts
new file mode 100644
index 0000000..8633a2f
--- /dev/null
+++ b/src/entry/pause-command.ts
@@ -0,0 +1,65 @@
+import { defineCommand } from "citty";
+import { CatherdError } from "../domain/errors.ts";
+import {
+  pauseLine,
+  pauseMachine,
+  pauseWorkspace,
+  resumeMachine,
+  resumeWorkspace,
+} from "../services/pause.ts";
+import { JSON_ARG, printJson } from "./cli-kit.ts";
+
+/** Exactly one of --machine and --workspace: what a pause or resume covers. */
+function scope(args: { machine?: boolean; workspace?: string }, usage: string): "machine" | string {
+  if (args.machine === true && args.workspace === undefined) return "machine";
+  if (args.machine !== true && args.workspace) return args.workspace;
+  throw new CatherdError(
+    "E_INPUT_INVALID",
+    "name what to pause: --machine or --workspace <id>, one of them",
+    {
+      fix: usage,
+    },
+  );
+}
+
+const SCOPE_ARGS = {
+  machine: { type: "boolean", description: "every run on this machine" },
+  workspace: { type: "string", description: "every child of this workspace" },
+} as const;
+
+const PAUSE_USAGE = 'catherd pause --machine "the VPN takes the default route"';
+const RESUME_USAGE = "catherd resume --machine";
+
+/** Spec 1.5 "Group pause": one blocker, one pause, instead of a park per run and milestone. */
+export const pauseCommand = defineCommand({
+  meta: {
+    name: "pause",
+    description:
+      "Pause every run on this machine (--machine) or in a workspace: dispatches are refused until resume",
+  },
+  args: {
+    reason: { type: "positional", required: true, description: "why: what blocks the runs" },
+    ...SCOPE_ARGS,
+    ...JSON_ARG,
+  },
+  run({ args }) {
+    const at = scope(args, PAUSE_USAGE);
+    const r =
+      at === "machine"
+        ? pauseMachine(Date.now(), args.reason)
+        : pauseWorkspace(Date.now(), { workspace: at, reason: args.reason });
+    if (args.json) return printJson(r);
+    console.log(pauseLine(r.pause));
+  },
+});
+
+export const resumeCommand = defineCommand({
+  meta: { name: "resume", description: "Lift a pause on this machine (--machine) or on a workspace" },
+  args: { ...SCOPE_ARGS, ...JSON_ARG },
+  run({ args }) {
+    const at = scope(args, RESUME_USAGE);
+    const r = at === "machine" ? resumeMachine(Date.now()) : resumeWorkspace(Date.now(), { workspace: at });
+    if (args.json) return printJson(r);
+    console.log(r.resumed ? `resumed: ${pauseLine(r.resumed)}` : "nothing was paused");
+  },
+});
diff --git a/src/entry/runs-command.ts b/src/entry/runs-command.ts
index 3741760..5519649 100644
--- a/src/entry/runs-command.ts
+++ b/src/entry/runs-command.ts
@@ -4,6 +4,7 @@ import { assertId } from "../domain/ids.ts";
 import { knownQueueCapability, UNCHECKED_QUEUE } from "../infra/codex-queue.ts";
 import { listDispatches } from "../services/dispatches.ts";
 import { retryDelivery } from "../services/notifier.ts";
+import { pauseLine } from "../services/pause.ts";
 import { inspectDelivery } from "../services/run-debug.ts";
 import { terminalHost } from "./host-arg.ts";
 import { formatBudget } from "../domain/budget.ts";
@@ -87,6 +88,8 @@ async function printStatus(runId: string | undefined, asJson: boolean, live = fa
       : null;
   const r = redact(status(defaultDeps(host), runId, queue));
   if (asJson) return printJson(r);
+  // spec 1.5 "Group pause": a pause comes first, before any run
+  for (const p of r.paused) console.log(`${mark("warn")} ${pauseLine(p)}`);
   if (r.runs.length === 0) console.log("no runs yet");
   // grouped by session, as the runs page is (spec §4); a run shows once, under the session that started it
   const byId = new Map(r.runs.map((s) => [s.id, s]));
diff --git a/src/services/admission.ts b/src/services/admission.ts
index cc8242f..1d99a90 100644
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -31,6 +31,7 @@ import {
   setLatest,
 } from "./dispatches.ts";
 import { finalizeDispatch } from "./finalize.ts";
+import { assertNotPaused } from "./pause.ts";
 import type { Deps } from "./ports.ts";
 import { readRecords, recordsOnThread, type Run, runPaths } from "./run-store.ts";
 import { currentSession } from "./sessions.ts";
@@ -138,6 +139,8 @@ export async function admit(
 ): Promise<{ d: Dispatch; specPath: string }> {
   assertId("role name", i.name);
   if (i.lane !== null) assertId("lane", i.lane);
+  // a machine or workspace pause refuses every dispatch it covers, with its reason (spec 1.5 "Group pause")
+  assertNotPaused(run);
   const rung = parseRung(i.rung);
   const profile = deps.profiles.forRepo(run.meta.repo);
   const rc = profile.roles[i.role];
diff --git a/src/services/pause.ts b/src/services/pause.ts
new file mode 100644
index 0000000..a6d63e2
--- /dev/null
+++ b/src/services/pause.ts
@@ -0,0 +1,151 @@
+import { join } from "node:path";
+import { CatherdError } from "../domain/errors.ts";
+import { dataDir } from "../infra/paths.ts";
+import { appendJsonl, ensureJsonlHeader, readJsonl } from "../infra/store.ts";
+/** What a pause is checked against: a run, or a workspace step about to start one. */
+type Covered = { meta: { workspace?: { id: string; step: string } } };
+import { findWorkspace, workspaceDirectory } from "./workspace-store.ts";
+
+// Spec 1.5 plan 25, "Group pause": one environment blocker (a VPN, Docker down) pauses every run on the
+// machine, or every child of a workspace, at once: admission refuses with the reason until it is resumed.
+
+/** One row per pause or resume, oldest first; `reason` null is a resume. */
+interface PauseRow {
+  at: string;
+  reason: string | null;
+}
+
+/** A pause in force: whose (the machine, or one workspace), why and since when. */
+export interface Pause {
+  scope: "machine" | "workspace";
+  /** the workspace id, for a workspace pause */
+  workspace?: string;
+  reason: string;
+  since: string;
+}
+
+/** A stretch of time something was paused; `to` null while it still is. */
+export interface PauseInterval {
+  from: string;
+  to: string | null;
+}
+
+export const machinePauseFile = (): string => join(dataDir(), "pauses.jsonl");
+export const workspacePauseFile = (id: string): string => join(workspaceDirectory(id), "pauses.jsonl");
+
+const rows = (file: string): PauseRow[] =>
+  readJsonl<PauseRow>(file).rows.filter(
+    (r) => typeof r?.at === "string" && (r.reason === null || typeof r.reason === "string"),
+  );
+
+/** The pause in force in `file`, or null: its last row, when that row pauses. */
+function current(file: string): { reason: string; since: string } | null {
+  const last = rows(file).at(-1);
+  return last && last.reason !== null ? { reason: last.reason, since: last.at } : null;
+}
+
+/** Every paused stretch `file` records, oldest first. */
+export function pauseIntervals(file: string): PauseInterval[] {
+  const out: PauseInterval[] = [];
+  for (const r of rows(file)) {
+    const open = out.at(-1);
+    if (r.reason !== null && (!open || open.to !== null)) out.push({ from: r.at, to: null });
+    else if (r.reason === null && open && open.to === null) open.to = r.at;
+  }
+  return out;
+}
+
+function append(file: string, row: PauseRow): void {
+  ensureJsonlHeader(file, "pauses");
+  appendJsonl(file, row);
+}
+
+const PAUSE_HINT = "push the reason to the owner once (PushNotification); every run it covers waits on it";
+
+/** `catherd pause --machine <reason>`: every dispatch on this machine is refused until resumed. */
+export function pauseMachine(now: number, reason: string): { pause: Pause; hints: string[] } {
+  if (!reason.trim())
+    throw new CatherdError("E_INPUT_INVALID", "a pause needs a reason", {
+      fix: 'catherd pause --machine "the VPN takes the default route"',
+    });
+  const at = new Date(now).toISOString();
+  append(machinePauseFile(), { at, reason });
+  return { pause: { scope: "machine", reason, since: at }, hints: [PAUSE_HINT] };
+}
+
+/** `catherd resume --machine`: lifts the machine pause; the previous one, or null when none was in force. */
+export function resumeMachine(now: number): { resumed: Pause | null } {
+  const was = current(machinePauseFile());
+  if (was) append(machinePauseFile(), { at: new Date(now).toISOString(), reason: null });
+  return { resumed: was ? { scope: "machine", ...was } : null };
+}
+
+/** `workspace_pause(workspace, reason)`: every child of the workspace is refused admission until resumed. */
+export function pauseWorkspace(
+  now: number,
+  i: { workspace: string; reason: string },
+): { pause: Pause; hints: string[] } {
+  const workspace = findWorkspace(i.workspace);
+  if (!i.reason.trim())
+    throw new CatherdError("E_INPUT_INVALID", "a pause needs a reason", {
+      fix: 'workspace_pause(workspace, "the VPN takes the default route")',
+    });
+  const at = new Date(now).toISOString();
+  append(workspacePauseFile(workspace.id), { at, reason: i.reason });
+  return {
+    pause: { scope: "workspace", workspace: workspace.id, reason: i.reason, since: at },
+    hints: [PAUSE_HINT],
+  };
+}
+
+/** `workspace_resume(workspace)`: lifts the workspace's pause; the previous one, or null. */
+export function resumeWorkspace(now: number, i: { workspace: string }): { resumed: Pause | null } {
+  const workspace = findWorkspace(i.workspace);
+  const file = workspacePauseFile(workspace.id);
+  const was = current(file);
+  if (was) append(file, { at: new Date(now).toISOString(), reason: null });
+  return { resumed: was ? { scope: "workspace", workspace: workspace.id, ...was } : null };
+}
+
+/** The pauses in force over `run`: the machine's, then its workspace's. */
+export function pausesFor(run: Covered | null): Pause[] {
+  const out: Pause[] = [];
+  const machine = current(machinePauseFile());
+  if (machine) out.push({ scope: "machine", ...machine });
+  const id = run?.meta.workspace?.id;
+  const ws = id ? current(workspacePauseFile(id)) : null;
+  if (id && ws) out.push({ scope: "workspace", workspace: id, ...ws });
+  return out;
+}
+
+/** The pauses in force over any of `runs`, each once, the machine's first. */
+export function pausesOver(runs: Covered[]): Pause[] {
+  const seen = new Set<string>();
+  const out: Pause[] = [];
+  for (const p of [pausesFor(null), ...runs.map(pausesFor)].flat()) {
+    const key = `${p.scope} ${p.workspace ?? ""}`;
+    if (!seen.has(key)) {
+      seen.add(key);
+      out.push(p);
+    }
+  }
+  return out;
+}
+
+const describe = (p: Pause): string =>
+  `${p.scope === "machine" ? "the machine" : `workspace ${p.workspace}`} is paused since ${p.since}: ${p.reason}`;
+
+/** One line per pause, for status and the admission refusal. */
+export const pauseLine = describe;
+
+/** Admission refuses while a pause covers the run, naming its reason and how to lift it. */
+export function assertNotPaused(run: Covered): void {
+  const [p] = pausesFor(run);
+  if (!p) return;
+  throw new CatherdError("E_ADMIT_PAUSED", describe(p), {
+    fix:
+      p.scope === "machine"
+        ? "when the blocker is gone, the owner runs: catherd resume --machine"
+        : `when the blocker is gone, call workspace_resume(${p.workspace})`,
+  });
+}
diff --git a/src/services/summary.ts b/src/services/summary.ts
index 6bd1b6d..31b3c57 100644
--- a/src/services/summary.ts
+++ b/src/services/summary.ts
@@ -9,6 +9,7 @@ import { median } from "../domain/util.ts";
 import { nonBlankLines, readJsonl } from "../infra/store.ts";
 import { spendOf } from "./budget.ts";
 import { latestVerifierStep, type VerifierStep } from "./gate-service.ts";
+import { type Pause, pausesOver } from "./pause.ts";
 import { type OpenQuestion, openQuestions } from "./questions.ts";
 import { type DispatchState, listDispatches, liveDispatches } from "./dispatches.ts";
 import { type RunSession, sessionFacts } from "./session-view.ts";
@@ -131,29 +132,36 @@ export function status(
   runId?: string,
   queue: QueueCapability | null = null,
 ): {
+  /** spec 1.5 "Group pause": the machine's pause and the listed runs' workspace pauses, shown first */
+  paused: Pause[];
   version: string;
   runs: RunSummary[];
   warnings: string[];
   host: HostContext;
   queue: QueueCapability | null;
 } {
-  if (runId)
+  if (runId) {
+    const run = findRun(runId);
     return {
+      paused: pausesOver([run]),
       host: inspectionHost(deps.host),
       queue,
       version: deps.version,
-      runs: [summarizeRun(deps, findRun(runId))],
+      runs: [summarizeRun(deps, run)],
       warnings: [],
     };
+  }
   const { runs, corrupt } = listRuns();
   const warnings = corrupt.map((c) => `skipped run ${c.id}: ${c.reason}`);
   const all = runs.map((r) => summarizeRun(deps, r));
   const active = all.filter((s) => s.live.length > 0 || s.waiting);
+  const shown = active.length ? active : all.slice(0, 1);
   return {
+    paused: pausesOver(runs.filter((r) => shown.some((s) => s.id === r.id))),
     host: inspectionHost(deps.host),
     queue,
     version: deps.version,
-    runs: active.length ? active : all.slice(0, 1),
+    runs: shown,
     warnings,
   };
 }
diff --git a/src/services/workspace-service.ts b/src/services/workspace-service.ts
index fdfd989..c61f511 100644
--- a/src/services/workspace-service.ts
+++ b/src/services/workspace-service.ts
@@ -9,6 +9,7 @@ import { gitToplevel } from "../infra/git.ts";
 import { readVersioned, writeTextAtomic } from "../infra/store.ts";
 import { listDispatches } from "./dispatches.ts";
 import { landedCommits, landedMilestones } from "./milestones.ts";
+import { assertNotPaused, pausesOver } from "./pause.ts";
 import type { Deps } from "./ports.ts";
 import { createRun, readRecords, type Run } from "./run-store.ts";
 import { claimRun, currentSession } from "./sessions.ts";
@@ -176,6 +177,7 @@ async function childFor(
   const children = workspaceChildren(workspace);
   let run = children.find((r) => r.meta.workspace?.step === step.id);
   if (!run) {
+    assertNotPaused({ meta: { workspace: { id: workspace.id, step: step.id } } });
     const blockers = await dependencyBlockers(workspace, step, children, deps.now(), { merge: true });
     if (blockers.length)
       throw invalid(`workspace step ${step.id} waits: ${blockers.map((b) => b.why).join("; ")}`);
@@ -238,6 +240,8 @@ export async function workspaceStatus(deps: Deps, id: string) {
   }
   const spend = await workspaceSpend(workspace, deps.now(), children, warnings);
   return {
+    // spec 1.5 "Group pause": a pause over the workspace comes first
+    paused: pausesOver([{ meta: { workspace: { id, step: workspace.steps[0]!.id } } }]),
     workspace,
     dir: workspaceDirectory(id),
     steps,
````

### Task 6: A machine-wide verifier lock so two runs' verifiers never overlap

**Files:** `src/infra/heavy-lock.ts`, `src/entry/lock-command.ts`, `src/domain/role-prompts.ts`, `test/infra/heavy-lock.test.ts`, `test/entry/lock-command.test.ts`, `test/entry/help-text.test.ts`, `test/domain/verifier-prompt.test.ts`.

**Produces:** `withRoleLock(role, owner, fn, { pollMs })`, `roleLockOwner(role)`; `catherd lock --role verifier [--run <run>]`, `ROLE_LOCKS`, `roleLockOwnerOf(run, env)` (reads plan 21's `CATHERD_ROLE`), `LOCK_HELD_ENV`; `runForwarding(argv, extraEnv)`; the verifier brief's `catherd lock --role verifier -- <command>`.

- [ ] **Step 1: the failing tests.** Apply the test diff. Run `bun test test/infra/heavy-lock.test.ts test/entry/lock-command.test.ts test/entry/help-text.test.ts test/domain/verifier-prompt.test.ts`.
- [ ] **Step 2: the code.** Apply the source diff; run the same command.
- [ ] **Step 3: commit** `feat(lock): a machine-wide verifier lock so two runs' verifiers never overlap` (scratch `bbc0432`).

**Tests (scratch `bbc0432`):**

````diff
diff --git a/test/domain/verifier-prompt.test.ts b/test/domain/verifier-prompt.test.ts
index c38593c..6fecda7 100644
--- a/test/domain/verifier-prompt.test.ts
+++ b/test/domain/verifier-prompt.test.ts
@@ -9,6 +9,7 @@ describe("the verifier's prompt (spec 1.1 §7)", () => {
       "mcp__plugin_catherd_catherd__gate_pass",
       "report it as carried over from its commit",
       "Run independent items side by side, each heavy one wrapped in catherd lock",
+      "catherd lock --role verifier -- <command>",
       "Build each commit's images once, and reuse them for the boot check and the acceptance suite.",
       "- One line per gate item: PASS|FAIL, or carried over from <commit>.",
     ])
diff --git a/test/entry/help-text.test.ts b/test/entry/help-text.test.ts
index a3f7b5f..27aca2a 100644
--- a/test/entry/help-text.test.ts
+++ b/test/entry/help-text.test.ts
@@ -49,7 +49,9 @@ describe("--help matches the CLI (audit S5, S6, N3)", () => {
   });
 
   it("shows lock's command after --", () => {
-    expect(help("lock")).toContain("USAGE catherd lock [--slots N] -- <command> [args...]");
+    expect(help("lock")).toContain(
+      "USAGE catherd lock [--slots N] [--role verifier [--run <run>]] -- <command> [args...]",
+    );
   });
 
   it("documents init's --no-input, not an --input that defaults to true", () => {
diff --git a/test/entry/lock-command.test.ts b/test/entry/lock-command.test.ts
index 0b04938..9bc0320 100644
--- a/test/entry/lock-command.test.ts
+++ b/test/entry/lock-command.test.ts
@@ -1,9 +1,11 @@
 import { afterEach, describe, expect, it } from "bun:test";
-import { existsSync, mkdtempSync, readFileSync } from "node:fs";
+import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
-import { resolveSlots } from "../../src/entry/lock-command.ts";
+import { resolveSlots, roleLockOwnerOf } from "../../src/entry/lock-command.ts";
+import { tryLock } from "../../src/infra/filelock.ts";
 import { heavySlots } from "../../src/infra/heavy-lock.ts";
+import { locksDir } from "../../src/infra/paths.ts";
 import { killGroup } from "../../src/infra/proc.ts";
 import { exited, snapshotEnv, withHome } from "../helpers.ts";
 import { waitFor } from "../services/helpers.ts";
@@ -28,6 +30,53 @@ describe("catherd lock", () => {
     expect(() => resolveSlots("zero", () => 1)).toThrow(/slots/);
   });
 
+  it("shares a verifier lock by run: --run, else the run in CATHERD_ROLE, else this process alone", () => {
+    expect(roleLockOwnerOf("r1", { CATHERD_ROLE: "r2/verifier-M1" })).toBe("run:r1");
+    expect(roleLockOwnerOf(undefined, { CATHERD_ROLE: "r2/verifier-M1" })).toBe("run:r2");
+    expect(roleLockOwnerOf(undefined, {})).toBe(`process:${process.pid}`);
+  });
+
+  it("runs a --role verifier command holding the verifier lock, and refuses an unknown role", () => {
+    const home = withHome();
+    const run = (args: string[], env: Record<string, string> = {}) =>
+      Bun.spawnSync([process.execPath, CLI, "lock", "--slots", "1", ...args], {
+        env: { ...process.env, CATHERD_HOME: home, ANTHROPIC_API_KEY: "", ...env },
+        stdout: "pipe",
+        stderr: "pipe",
+      });
+    const held = run([
+      "--role",
+      "verifier",
+      "--run",
+      "r1",
+      "--",
+      "sh",
+      "-c",
+      'echo "held=$CATHERD_LOCK_HELD"',
+    ]);
+    expect(held.exitCode).toBe(0);
+    expect(held.stdout.toString()).toBe("held=1\n");
+    const unknown = run(["--role", "reviewer", "--", "true"]);
+    expect(unknown.exitCode).toBe(2);
+    expect(unknown.stderr.toString()).toContain('no role lock "reviewer"');
+  });
+
+  it("runs a lock nested in a locked command at once, even with every slot taken", () => {
+    const home = withHome();
+    mkdirSync(locksDir(), { recursive: true });
+    const release = tryLock(join(locksDir(), "slot-0"));
+    try {
+      const p = Bun.spawnSync([process.execPath, CLI, "lock", "--slots", "1", "--", "echo", "nested"], {
+        env: { ...process.env, CATHERD_HOME: home, ANTHROPIC_API_KEY: "", CATHERD_LOCK_HELD: "1" },
+        stdout: "pipe",
+        stderr: "pipe",
+      });
+      expect(p.stdout.toString()).toBe("nested\n");
+    } finally {
+      release?.();
+    }
+  });
+
   it("keeps catherd's own secret out of the command's environment (SECURITY.md)", () => {
     const home = withHome();
     const p = Bun.spawnSync([process.execPath, CLI, "lock", "--slots", "1", "--", "env"], {
diff --git a/test/infra/heavy-lock.test.ts b/test/infra/heavy-lock.test.ts
index 1574a13..5c3ab37 100644
--- a/test/infra/heavy-lock.test.ts
+++ b/test/infra/heavy-lock.test.ts
@@ -2,7 +2,7 @@ import { afterEach, describe, expect, it } from "bun:test";
 import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
 import { join } from "node:path";
 import { tryLock } from "../../src/infra/filelock.ts";
-import { heavySlots, withHeavySlot } from "../../src/infra/heavy-lock.ts";
+import { heavySlots, roleLockOwner, withHeavySlot, withRoleLock } from "../../src/infra/heavy-lock.ts";
 import { locksDir } from "../../src/infra/paths.ts";
 import { snapshotEnv, withHome } from "../helpers.ts";
 
@@ -66,6 +66,49 @@ describe("heavy lock", () => {
     expect(await withHeavySlot(1, (slot) => slot, { pollMs: 5 })).toBe(0);
   });
 
+  it("keeps another run's verifier out until the last command of the holding run ends", async () => {
+    withHome();
+    const log: string[] = [];
+    let releaseA!: () => void;
+    const heldA = new Promise<void>((resolve) => (releaseA = resolve));
+    let enteredA!: () => void;
+    const insideA = new Promise<void>((resolve) => (enteredA = resolve));
+    const a = withRoleLock(
+      "verifier",
+      "run:A",
+      async () => {
+        log.push("A+");
+        enteredA();
+        await heldA;
+        log.push("A-");
+      },
+      { pollMs: 5 },
+    );
+    await insideA;
+    expect(roleLockOwner("verifier")).toBe("run:A");
+    // the same run shares it: its second command runs side by side
+    await withRoleLock("verifier", "run:A", () => log.push("A2"), { pollMs: 5 });
+    const b = withRoleLock("verifier", "run:B", () => log.push("B"), { pollMs: 5 });
+    await Bun.sleep(50);
+    expect(log).toEqual(["A+", "A2"]);
+    releaseA();
+    await Promise.all([a, b]);
+    expect(log).toEqual(["A+", "A2", "A-", "B"]);
+    expect(roleLockOwner("verifier")).toBeNull();
+  });
+
+  it("drops a role-lock holder that died", async () => {
+    withHome();
+    mkdirSync(locksDir(), { recursive: true });
+    const dead = Bun.spawn(["true"]);
+    await dead.exited;
+    writeFileSync(
+      join(locksDir(), "role-verifier.json"),
+      JSON.stringify({ owner: "run:A", holders: [{ pid: dead.pid, startTime: "gone", token: "t" }] }),
+    );
+    expect(await withRoleLock("verifier", "run:B", () => "in", { pollMs: 5 })).toBe("in");
+  });
+
   it("tryLock refuses a lock this live process already holds, and releases only its own", () => {
     withHome();
     const target = join(locksDir(), "x");
````

**Code (scratch `bbc0432`):**

````diff
diff --git a/src/domain/role-prompts.ts b/src/domain/role-prompts.ts
index 6689f08..309cdc0 100644
--- a/src/domain/role-prompts.ts
+++ b/src/domain/role-prompts.ts
@@ -56,7 +56,7 @@ const verifier = [
   "1. Run the check command once. Report its exit code and the failing lines. When the check has several gate items (suites, lint, builds, a boot check):",
   "   - Before each item, call the catherd MCP tool gate_check (mcp__catherd_role__gate_check for native headless Codex/Claude Code roles; mcp__plugin_catherd_catherd__gate_check for native Claude subagents) with the run id, the milestone you verify (M1, as your brief names it), the item, its command and the repo paths it depends on. When it answers carried: true, do not run the item: report it as carried over from its commit. It also tells the orchestrator which step you are on.",
   "   - After an item passes, call gate_pass (mcp__catherd_role__gate_pass, or mcp__plugin_catherd_catherd__gate_pass for native Claude subagents) with the same item, command and paths, and the evidence.",
-  "   - Run independent items side by side, each heavy one wrapped in catherd lock, which queues them within the machine's slots.",
+  "   - Run independent items side by side, each heavy one wrapped in catherd lock --role verifier -- <command>, which queues them within the machine's slots and keeps another run's verifier from running at the same time.",
   "   - Build each commit's images once, and reuse them for the boot check and the acceptance suite.",
   "2. Exercise every acceptance line through the real entry point: the CLI, the HTTP route, the page. Read source only to find that entry point. When a line needs data or files, build them in a temporary directory outside the project.",
   "3. Read the diff (git diff plus untracked files) for bugs the acceptance lines miss: wrong edge behavior, dead code, leftovers.",
diff --git a/src/entry/lock-command.ts b/src/entry/lock-command.ts
index 2da63d1..587f7c7 100644
--- a/src/entry/lock-command.ts
+++ b/src/entry/lock-command.ts
@@ -3,7 +3,7 @@ import { defineCommand } from "citty";
 import { CatherdError } from "../domain/errors.ts";
 import { scrubSecrets } from "../infra/env.ts";
 import { gitToplevel } from "../infra/git.ts";
-import { heavySlots, withHeavySlot } from "../infra/heavy-lock.ts";
+import { heavySlots, withHeavySlot, withRoleLock } from "../infra/heavy-lock.ts";
 import { killGroup } from "../infra/proc.ts";
 import { activeName, readProfileDoc } from "../services/profile-store.ts";
 import { printError } from "./cli-kit.ts";
@@ -44,12 +44,12 @@ export const DOUBLE_INTERRUPT_MS = 2_000;
  * a terminal's Ctrl-C reaches catherd only, so the command sees it exactly once, and so does every
  * process it started. A second Ctrl-C within 2 s kills the group. Resolves to the command's exit code.
  */
-export async function runForwarding(argv: string[]): Promise<number> {
+export async function runForwarding(argv: string[], extraEnv: Record<string, string> = {}): Promise<number> {
   const child = Bun.spawn(argv, {
     stdin: "inherit",
     stdout: "inherit",
     stderr: "inherit",
-    env: scrubSecrets(process.env),
+    env: { ...scrubSecrets(process.env), ...extraEnv },
     detached: true,
   });
   let lastInt = 0;
@@ -88,7 +88,23 @@ export async function runForwarding(argv: string[]): Promise<number> {
 }
 
 /** Spec §8: what `--help` and the usage error show; the command runs after `--`. */
-export const LOCK_USAGE = "catherd lock [--slots N] -- <command> [args...]";
+export const LOCK_USAGE = "catherd lock [--slots N] [--role verifier [--run <run>]] -- <command> [args...]";
+
+/** The roles that take a machine-wide role lock besides their slot (spec 1.5 "Cross-run verifier contention"). */
+export const ROLE_LOCKS = ["verifier"] as const;
+
+/**
+ * Whose a role lock is: `--run`, else the run in `CATHERD_ROLE` (`<run>/<role-name>`, which the supervisor
+ * sets in every role's env), else this process alone. Commands of one run share the lock.
+ */
+export function roleLockOwnerOf(run: string | undefined, env: NodeJS.ProcessEnv): string {
+  if (run) return `run:${run}`;
+  const fromRole = env.CATHERD_ROLE?.split("/")[0];
+  return fromRole ? `run:${fromRole}` : `process:${process.pid}`;
+}
+
+/** Set in a locked command's env: a `catherd lock` inside it runs at once, holding nothing more. */
+export const LOCK_HELD_ENV = "CATHERD_LOCK_HELD";
 
 export const lockCommand = defineCommand({
   meta: {
@@ -102,6 +118,15 @@ export const lockCommand = defineCommand({
       type: "string",
       description: "Slots (default: CATHERD_LOCK_SLOTS, else the profile's lock.heavy, else half the cores)",
     },
+    role: {
+      type: "string",
+      description:
+        "verifier: also hold the machine-wide verifier lock, shared by one run's commands, so two runs' verifiers never overlap",
+    },
+    run: {
+      type: "string",
+      description: "with --role: the run whose commands share it (default: CATHERD_ROLE's)",
+    },
   },
   async run({ args, rawArgs }) {
     const sep = rawArgs.indexOf("--");
@@ -115,6 +140,22 @@ export const lockCommand = defineCommand({
       process.exitCode = 2;
       return;
     }
+    if (args.role !== undefined && !(ROLE_LOCKS as readonly string[]).includes(args.role)) {
+      printError(
+        new CatherdError("E_INPUT_INVALID", `no role lock "${args.role}"`, {
+          fix: "catherd lock --role verifier -- <command>",
+        }),
+      );
+      process.exitCode = 2;
+      return;
+    }
+    // already inside a locked command: run at once, so a nested lock never waits on its own parent's slot
+    if (process.env[LOCK_HELD_ENV] === "1") {
+      process.exitCode = await runForwarding(argv);
+      return;
+    }
+    const run = () => runForwarding(argv, { [LOCK_HELD_ENV]: "1" });
+    const role = args.role;
     const repo = await gitToplevel(process.cwd());
     const slots = resolveSlots(
       args.slots,
@@ -123,6 +164,8 @@ export const lockCommand = defineCommand({
       () => readProfileDoc(activeName(repo)).lock?.heavy ?? "cpus/2",
       (m) => console.error(m),
     );
-    process.exitCode = await withHeavySlot(slots, () => runForwarding(argv));
+    process.exitCode = role
+      ? await withRoleLock(role, roleLockOwnerOf(args.run, process.env), () => withHeavySlot(slots, run))
+      : await withHeavySlot(slots, run);
   },
 });
diff --git a/src/infra/heavy-lock.ts b/src/infra/heavy-lock.ts
index 923122d..7b3bb79 100644
--- a/src/infra/heavy-lock.ts
+++ b/src/infra/heavy-lock.ts
@@ -1,8 +1,11 @@
+import { randomUUID } from "node:crypto";
+import { existsSync, readFileSync } from "node:fs";
 import { availableParallelism } from "node:os";
 import { join } from "node:path";
-import { tryLock } from "./filelock.ts";
+import { tryLock, withFileLock } from "./filelock.ts";
 import { locksDir } from "./paths.ts";
-import { ensurePrivateDir } from "./store.ts";
+import { isAlive, selfIdentity } from "./proc.ts";
+import { ensurePrivateDir, writeJsonAtomic } from "./store.ts";
 
 /** A profile's `lock.heavy` as a slot count: a number, or half the cores. */
 export function heavySlots(setting: number | "cpus/2" | undefined): number {
@@ -34,3 +37,67 @@ export async function withHeavySlot<T>(
     await Bun.sleep(o.pollMs ?? 500);
   }
 }
+
+/** A process inside a role lock: who, so a dead one is dropped, and a token, so one process can hold twice. */
+interface RoleHolder {
+  pid: number;
+  startTime: string | null;
+  token: string;
+}
+
+interface RoleLockState {
+  /** whose the lock is: a run id (holders of one run share it), or a lone process's own key */
+  owner: string;
+  holders: RoleHolder[];
+}
+
+function readRoleState(file: string): RoleLockState | null {
+  if (!existsSync(file)) return null;
+  try {
+    const v = JSON.parse(readFileSync(file, "utf8")) as RoleLockState;
+    return typeof v?.owner === "string" && Array.isArray(v.holders) ? v : null;
+  } catch {
+    return null;
+  }
+}
+
+/**
+ * Spec 1.5 "Cross-run verifier contention": one owner at a time machine-wide holds the lock of `role`.
+ * Commands of the same owner (one run's verifier, side by side within its slots) share it; another owner's
+ * wait until the last of them ends, so two runs' verifiers never overlap. A dead holder is dropped.
+ */
+export async function withRoleLock<T>(
+  role: string,
+  owner: string,
+  fn: () => T | Promise<T>,
+  o: { pollMs?: number } = {},
+): Promise<T> {
+  const dir = locksDir();
+  ensurePrivateDir(dir);
+  const file = join(dir, `role-${role}.json`);
+  const me: RoleHolder = { ...selfIdentity(), token: randomUUID() };
+  const enter = () =>
+    withFileLock(file, () => {
+      const state = readRoleState(file);
+      const live = (state?.holders ?? []).filter((h) => isAlive(h.pid, h.startTime));
+      if (live.length && state?.owner !== owner) return false;
+      writeJsonAtomic(file, { owner, holders: [...live, me] } satisfies RoleLockState);
+      return true;
+    });
+  while (!(await enter())) await Bun.sleep(o.pollMs ?? 500);
+  try {
+    return await fn();
+  } finally {
+    await withFileLock(file, () => {
+      const state = readRoleState(file);
+      if (state)
+        writeJsonAtomic(file, { ...state, holders: state.holders.filter((h) => h.token !== me.token) });
+    });
+  }
+}
+
+/** Who holds the role lock now, or null. */
+export function roleLockOwner(role: string): string | null {
+  const state = readRoleState(join(locksDir(), `role-${role}.json`));
+  return state && state.holders.some((h) => isAlive(h.pid, h.startTime)) ? state.owner : null;
+}
````

### Task 7: Supersede a run with a pointer; `run_start` `from` closes the old one

**Files:** `src/services/run-store.ts`, `src/services/run-service.ts`, `src/services/admission.ts`, `src/services/summary.ts`, `src/entry/mcp/run-tools.ts`, `src/entry/runs-command.ts`, `test/services/supersede.test.ts` (new).

**Produces:** `supersededFile`, `supersededBy(run)`, `supersedeRun(deps, { run, by })`, `startRun(…, { from })`, `RunSummary.supersededBy`; `run_start` `from`; `catherd runs supersede <id> --by <id>`; `runs list` shows `superseded by <id>`.

- [ ] **Step 1: the failing tests.** Apply the test diff. Run `bun test test/services/supersede.test.ts`.
- [ ] **Step 2: the code.** Apply the source diff; run it and `bun test test/entry/runs-command.test.ts test/services/summary-reconcile.test.ts test/entry/mcp.test.ts test/services/run-store.test.ts`.
- [ ] **Step 3: commit** `feat(runs): supersede a run with a pointer, and run_start from closes the old one` (scratch `19a3c70`).

**Tests (scratch `19a3c70`):**

````diff
diff --git a/test/services/supersede.test.ts b/test/services/supersede.test.ts
new file mode 100644
index 0000000..ab76af9
--- /dev/null
+++ b/test/services/supersede.test.ts
@@ -0,0 +1,77 @@
+import { afterEach, expect, it } from "bun:test";
+import { join } from "node:path";
+import { admit } from "../../src/services/admission.ts";
+import { startRun, supersedeRun } from "../../src/services/run-service.ts";
+import { createRun, supersededBy } from "../../src/services/run-store.ts";
+import { status } from "../../src/services/summary.ts";
+import { snapshotEnv } from "../helpers.ts";
+import { SRC } from "../import-graph.ts";
+import { fakeDeps, fakeDispatch, freshRun } from "./helpers.ts";
+
+afterEach(snapshotEnv());
+
+it("run_start with from closes the run it takes over, and status hides it", async () => {
+  const { repo, run: planning } = freshRun("planning");
+  const deps = fakeDeps();
+  const started = await startRun(deps, {
+    repo,
+    title: "execution",
+    aLines: ["A1 it ships"],
+    from: planning.id,
+  });
+  expect(supersededBy(planning)).toMatchObject({ by: started.run });
+  // the closed run is newer here, so only the hiding keeps it out of the default view
+  const later = createRun({
+    repo,
+    title: "later planning",
+    aLines: [],
+    version: "t",
+    now: new Date(Date.now() + 60_000),
+  });
+  await supersedeRun(deps, { run: later.id, by: started.run });
+  expect(status(deps).runs.map((r) => r.id)).toEqual([started.run]);
+  expect(status(deps, later.id).runs[0]?.supersededBy).toBe(started.run);
+});
+
+it("refuses to supersede a run by itself, or one with live roles", async () => {
+  const { repo, run } = freshRun();
+  const deps = fakeDeps();
+  const other = createRun({ repo, title: "other", aLines: [], version: "t" });
+  await expect(supersedeRun(deps, { run: run.id, by: run.id })).rejects.toThrow("cannot supersede itself");
+  await fakeDispatch(run, { name: "worker-M1.L1" }, { proc: "self" });
+  await expect(supersedeRun(deps, { run: run.id, by: other.id })).rejects.toThrow("still has live roles");
+  expect(supersededBy(run)).toBeNull();
+});
+
+it("refuses a dispatch into a superseded run, naming the run that took over", async () => {
+  const { repo, run } = freshRun();
+  const deps = fakeDeps();
+  const other = createRun({ repo, title: "other", aLines: [], version: "t" });
+  await supersedeRun(deps, { run: run.id, by: other.id });
+  await expect(
+    admit(deps, run, {
+      role: "worker",
+      name: "worker-M1.L1",
+      brief: "b",
+      rung: "codex:gpt-6-luna#high",
+      thread: null,
+      lane: null,
+      failoverFrom: null,
+    }),
+  ).rejects.toMatchObject({ code: "E_RUN_NOT_LIVE", fix: `dispatch in run ${other.id}` });
+});
+
+it("catherd runs supersede closes a run, and runs list says by which", () => {
+  const { repo, run } = freshRun();
+  const other = createRun({ repo, title: "other", aLines: [], version: "t" });
+  const cli = (...args: string[]) =>
+    Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), ...args], {
+      env: { ...process.env, NO_COLOR: "1", ANTHROPIC_API_KEY: "" },
+      stdout: "pipe",
+      stderr: "pipe",
+    });
+  const r = cli("runs", "supersede", run.id, "--by", other.id);
+  expect(r.exitCode).toBe(0);
+  expect(r.stdout.toString()).toContain(`${run.id} superseded by ${other.id}`);
+  expect(cli("runs", "list").stdout.toString()).toContain(`${run.id}  superseded by ${other.id}`);
+});
````

**Code (scratch `19a3c70`):**

````diff
diff --git a/src/entry/mcp/run-tools.ts b/src/entry/mcp/run-tools.ts
index e3461db..521eef7 100644
--- a/src/entry/mcp/run-tools.ts
+++ b/src/entry/mcp/run-tools.ts
@@ -23,14 +23,15 @@ export function registerRunTools(server: McpServer, deps: Deps): void {
     "run_start",
     {
       description:
-        "Start a catherd run for a git repository: creates its run folder (outside the repo) and state.md. Returns the run id, the folder, protocol (the next step of the milestone loop and its six-line checklist), and hints when state.md could not be written yet.",
+        "Start a catherd run for a git repository: creates its run folder (outside the repo) and state.md. Returns the run id, the folder, protocol (the next step of the milestone loop and its six-line checklist), and hints when state.md could not be written yet. from: the run this one takes over (a planning run handed to the execution run in a worktree): it is closed with a pointer here, and status hides it.",
       inputSchema: {
         repo: z.string().min(1),
         title: z.string().min(1),
         a_lines: z.array(z.string().min(1)).min(1),
+        from: z.string().regex(ID_PATTERN).optional(),
       },
     },
-    (a) => handle(() => startRun(deps, { repo: a.repo, title: a.title, aLines: a.a_lines })),
+    (a) => handle(() => startRun(deps, { repo: a.repo, title: a.title, aLines: a.a_lines, from: a.from })),
   );
 
   server.registerTool(
diff --git a/src/entry/runs-command.ts b/src/entry/runs-command.ts
index 5519649..3e14b5d 100644
--- a/src/entry/runs-command.ts
+++ b/src/entry/runs-command.ts
@@ -14,6 +14,7 @@ import { redact } from "../infra/log.ts";
 import { cancel } from "../services/dispatch-service.ts";
 import { registerSavedSecrets } from "../services/jev-service.ts";
 import { runDebug } from "../services/run-debug.ts";
+import { supersedeRun } from "../services/run-service.ts";
 import { findRun, listRuns, readRecords, type Run } from "../services/run-store.ts";
 import { groupRuns, type RunSession, type SessionGroup } from "../services/session-view.ts";
 import { type RunSummary, status, summarizeRun } from "../services/summary.ts";
@@ -208,6 +209,7 @@ const list = defineCommand({
         session: s.session,
         continuedIn: s.continuedIn,
         waiting: s.waiting,
+        supersededBy: s.supersededBy ?? null,
       };
     };
     const groups = groupRuns(shown);
@@ -218,7 +220,7 @@ const list = defineCommand({
       for (const x of g.runs) {
         const r = row(x.run);
         console.log(
-          `  ${r.id}  ${r.live ? `${r.live} live` : r.waiting ? `${r.waiting.stalled ? "stalled · " : ""}waiting for orchestrator ${r.waiting.seconds}s` : "idle"}  ${r.roleRuns} role run(s)  ${r.title}  ${r.repo}${movedNote(x)}`,
+          `  ${r.id}  ${r.supersededBy ? `superseded by ${r.supersededBy}` : r.live ? `${r.live} live` : r.waiting ? `${r.waiting.stalled ? "stalled · " : ""}waiting for orchestrator ${r.waiting.seconds}s` : "idle"}  ${r.roleRuns} role run(s)  ${r.title}  ${r.repo}${movedNote(x)}`,
         );
       }
     }
@@ -336,9 +338,30 @@ const retryPush = defineCommand({
   },
 });
 
+const supersede = defineCommand({
+  meta: {
+    name: "supersede",
+    description: "Close a run with a pointer to the run that took it over; status hides it",
+  },
+  args: {
+    id: { type: "positional", required: true, description: "the run to close" },
+    by: { type: "string", required: true, description: "the run that took it over" },
+    ...json,
+  },
+  async run({ args }) {
+    const r = await supersedeRun(defaultDeps(), { run: args.id, by: args.by });
+    if (args.json) return printJson(r);
+    console.log(`${mark("ok")} ${r.run} superseded by ${r.by}`);
+    for (const h of r.hints ?? []) console.log(`  ${h}`);
+  },
+});
+
 /** Spec §8 `catherd runs list|show [--debug]|cancel`; a bare `catherd runs` lists them, as `status` needs no run. */
 export const runsCommand = defineCommand({
-  meta: { name: "runs", description: "Runs: list them (the default), show one, cancel a live role" },
-  subCommands: { list, show, cancel: cancelCmd, "retry-push": retryPush },
+  meta: {
+    name: "runs",
+    description: "Runs: list them (the default), show one, cancel a live role, supersede one",
+  },
+  subCommands: { list, show, cancel: cancelCmd, "retry-push": retryPush, supersede },
   default: "list",
 });
diff --git a/src/services/admission.ts b/src/services/admission.ts
index 1d99a90..cda686c 100644
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -33,7 +33,7 @@ import {
 import { finalizeDispatch } from "./finalize.ts";
 import { assertNotPaused } from "./pause.ts";
 import type { Deps } from "./ports.ts";
-import { readRecords, recordsOnThread, type Run, runPaths } from "./run-store.ts";
+import { readRecords, recordsOnThread, type Run, runPaths, supersededBy } from "./run-store.ts";
 import { currentSession } from "./sessions.ts";
 import { withRunAdmission } from "./workspace-admission.ts";
 
@@ -141,6 +141,11 @@ export async function admit(
   if (i.lane !== null) assertId("lane", i.lane);
   // a machine or workspace pause refuses every dispatch it covers, with its reason (spec 1.5 "Group pause")
   assertNotPaused(run);
+  const closed = supersededBy(run);
+  if (closed)
+    throw new CatherdError("E_RUN_NOT_LIVE", `run ${run.id} is superseded by ${closed.by}`, {
+      fix: `dispatch in run ${closed.by}`,
+    });
   const rung = parseRung(i.rung);
   const profile = deps.profiles.forRepo(run.meta.repo);
   const rc = profile.roles[i.role];
diff --git a/src/services/run-service.ts b/src/services/run-service.ts
index c73cabc..15bce98 100644
--- a/src/services/run-service.ts
+++ b/src/services/run-service.ts
@@ -6,12 +6,13 @@ import type { RunRecord } from "../domain/record.ts";
 import type { Role } from "../domain/roles.ts";
 import { awaitsCollect, dispatchPaths, endCollect, tryCollect } from "../infra/dispatch-dir.ts";
 import { gitToplevel } from "../infra/git.ts";
-import { writeTextAtomic } from "../infra/store.ts";
+import { writeJsonAtomic, writeTextAtomic } from "../infra/store.ts";
 import {
   dispatchState,
   type DispatchState,
   latestDispatch,
   listDispatches,
+  liveDispatches,
   recordHints,
 } from "./dispatches.ts";
 import type { Deps } from "./ports.ts";
@@ -25,14 +26,48 @@ import {
   knowledgeFile,
   readRecords,
   runFile,
+  supersededBy,
+  supersededFile,
 } from "./run-store.ts";
 import { protocolView } from "./protocol.ts";
 import { claimRun, currentSession } from "./sessions.ts";
 import { refreshState } from "./state.ts";
 
+/**
+ * `runs supersede <run> --by <run>`: closes `run` with a pointer to the run that took it over (a planning
+ * run handed to the execution run in a worktree). Status hides it; dispatch refuses it. A run with live
+ * roles is refused: cancel them, or let them finish, first.
+ */
+export async function supersedeRun(
+  deps: Deps,
+  i: { run: string; by: string },
+): Promise<{ run: string; by: string; at: string; hints?: string[] }> {
+  const run = findRun(i.run);
+  const by = findRun(i.by);
+  if (run.id === by.id)
+    throw new CatherdError("E_INPUT_INVALID", `run ${run.id} cannot supersede itself`, {
+      fix: "pass the run that took over as --by",
+    });
+  if (supersededBy(by)?.by === run.id)
+    throw new CatherdError("E_INPUT_INVALID", `run ${by.id} is itself superseded by ${run.id}`, {
+      fix: "supersede the older run by the newer one",
+    });
+  const live = liveDispatches(run, deps.now());
+  if (live.length)
+    throw new CatherdError(
+      "E_INPUT_INVALID",
+      `run ${run.id} still has live roles: ${live.map((d) => d.admit.name).join(", ")}`,
+      { fix: `cancel them (cancel(run, name)) or let them finish, then supersede ${run.id}` },
+    );
+  const at = new Date(deps.now()).toISOString();
+  writeJsonAtomic(supersededFile(run), { schema: 1, by: by.id, at });
+  const { hints } = await refreshState(run, { next: `superseded by ${by.id}: continue there` });
+  return { run: run.id, by: by.id, at, ...(hints.length ? { hints } : {}) };
+}
+
 export async function startRun(
   deps: Deps,
-  i: { repo: string; title: string; aLines: string[] },
+  i: { repo: string; title: string; aLines: string[]; from?: string },
 ): Promise<{
   run: string;
   dir: string;
@@ -44,6 +79,12 @@ export async function startRun(
     throw new CatherdError("E_IO_PATH", `${i.repo} is not inside a git repository`, {
       fix: "pass the path of the repository to work in",
     });
+  // the run this one takes over must exist and be free to close before anything is created
+  const from = i.from === undefined ? null : findRun(i.from);
+  if (from && liveDispatches(from, deps.now()).length)
+    throw new CatherdError("E_INPUT_INVALID", `run ${from.id} still has live roles`, {
+      fix: `cancel them or let them finish, then run_start with from: ${from.id}`,
+    });
   const run = createRun({
     repo: top,
     title: i.title,
@@ -53,8 +94,10 @@ export async function startRun(
     startedBy: currentSession(deps),
   });
   await claimRun(deps, run);
+  const superseded = from ? await supersedeRun(deps, { run: from.id, by: run.id }) : null;
   // a failed state.md refresh never fails the start: the run exists and is usable, so a retry would orphan it
   const { hints } = await refreshState(run);
+  hints.push(...(superseded?.hints ?? []));
   // spec 1.1 §10: the milestone loop, so the orchestrator starts on the protocol
   return { run: run.id, dir: run.dir, protocol: protocolView(run, []), ...(hints.length ? { hints } : {}) };
 }
diff --git a/src/services/run-store.ts b/src/services/run-store.ts
index 630ac01..8aa31ef 100644
--- a/src/services/run-store.ts
+++ b/src/services/run-store.ts
@@ -304,7 +304,25 @@ export function appendKnowledge(toplevel: string, at: Date, source: string, text
   return line;
 }
 
+/** Spec 1.5 "runs supersede": the run that took over a closed one, and when. */
+const SupersededSchema = z.looseObject({ schema: z.literal(1), by: z.string(), at: z.string() });
+export type Superseded = z.infer<typeof SupersededSchema>;
+
+export const supersededFile = (run: Run): string => join(run.dir, "superseded.json");
+
+/** The pointer `runs supersede` left, or null: an open run, or a pointer that cannot be read. */
+export function supersededBy(run: Run): Superseded | null {
+  const file = supersededFile(run);
+  if (!existsSync(file)) return null;
+  try {
+    return readVersioned(file, SupersededSchema, 1);
+  } catch {
+    return null;
+  }
+}
+
 const SERVER_OWNED = new Set([
+  "superseded.json",
   "workspace-contract.md",
   "meta.json",
   "state.md",
diff --git a/src/services/summary.ts b/src/services/summary.ts
index 31b3c57..3f44dca 100644
--- a/src/services/summary.ts
+++ b/src/services/summary.ts
@@ -23,6 +23,7 @@ import {
   readRoutes,
   type Run,
   runPaths,
+  supersededBy,
 } from "./run-store.ts";
 
 export interface RunSummary {
@@ -30,6 +31,8 @@ export interface RunSummary {
   waiting?: OrchestratorWait | null;
   delivery: (DeliveryInspection & { name: string; dispatchId: string })[];
   id: string;
+  /** spec 1.5 "runs supersede": the run that took this one over; status() without a run hides it */
+  supersededBy?: string | null;
   /** spec 1.1 §8: the owner questions not answered yet, listed first */
   questions: OpenQuestion[];
   title: string;
@@ -83,6 +86,7 @@ export function summarizeRun(deps: Deps, run: Run): RunSummary {
       })),
     ),
     id: run.id,
+    supersededBy: supersededBy(run)?.by ?? null,
     questions: openQuestions(run),
     title: run.meta.title,
     repo: run.meta.repo,
@@ -151,8 +155,10 @@ export function status(
       warnings: [],
     };
   }
-  const { runs, corrupt } = listRuns();
+  const { runs: listed, corrupt } = listRuns();
   const warnings = corrupt.map((c) => `skipped run ${c.id}: ${c.reason}`);
+  // a superseded run is closed: only status(run) shows it
+  const runs = listed.filter((r) => !supersededBy(r));
   const all = runs.map((r) => summarizeRun(deps, r));
   const active = all.filter((s) => s.live.length > 0 || s.waiting);
   const shown = active.length ? active : all.slice(0, 1);
````

### Task 8: `After:` orders lanes, `Allow:` excuses hits, `write_run_file` checks lane headers

**Files:** `src/domain/lane.ts`, `src/domain/errors.ts`, `src/services/admission.ts`, `src/services/preflight.ts`, `src/services/protocol.ts`, `src/services/run-service.ts`, `test/domain/lane.test.ts`, `test/services/admission.test.ts`, `test/services/lanes-run.test.ts`, `test/services/preflight.test.ts`, `test/services/protocol.test.ts`.

**Produces:** `LaneHeader.after`, `LaneHeader.allow`, `assertLaneValues(text, where)`, `onlyAllowedHits(lines, allow)`; `unfinishedAfter(run, lane, routes?)`; `E_ADMIT_ORDER`; `runCheck` returns `lines`; `protocolNext` holds lanes behind `After:`.

- [ ] **Step 1: the failing tests.** Apply the test diff. Run `bun test test/domain/lane.test.ts test/services/protocol.test.ts test/services/preflight.test.ts test/services/admission.test.ts test/services/lanes-run.test.ts`.
- [ ] **Step 2: the code.** Apply the source diff; run the same command and `bun test test/services/lane-headers.test.ts test/integration/mcp-stdio.test.ts test/architecture.test.ts`.
- [ ] **Step 3: commit** `feat(lanes): order lanes by After:, excuse Allow: hits, check headers on write` (scratch `5b28277`).

**Tests (scratch `5b28277`):**

````diff
diff --git a/test/domain/lane.test.ts b/test/domain/lane.test.ts
index 4ebe5e1..9de2939 100644
--- a/test/domain/lane.test.ts
+++ b/test/domain/lane.test.ts
@@ -1,6 +1,12 @@
 import { describe, expect, it } from "bun:test";
 import { isCatherdError } from "../../src/domain/errors.ts";
-import { normalizeOwned, overlaps, parseLaneHeader } from "../../src/domain/lane.ts";
+import {
+  assertLaneValues,
+  normalizeOwned,
+  onlyAllowedHits,
+  overlaps,
+  parseLaneHeader,
+} from "../../src/domain/lane.ts";
 
 const LANE = [
   "# M1.L2 — Add the export button",
@@ -20,9 +26,44 @@ describe("parseLaneHeader", () => {
       fastCheck: "bun test test/export.test.ts",
       kind: "repo_code",
       difficulty: "build",
+      after: [],
+      allow: [],
     });
   });
 
+  it("reads After: lanes and the Allow: exceptions under the check", () => {
+    const h = parseLaneHeader(`${LANE}\nAfter: M1.L1, \`M0.L3\`\nAllow: src/job/command.go:120, docs/`);
+    expect(h.after).toEqual(["M1.L1", "M0.L3"]);
+    expect(h.allow).toEqual(["src/job/command.go:120", "docs/"]);
+  });
+});
+
+describe("assertLaneValues (write_run_file)", () => {
+  it("refuses a wrong value, never a missing line", () => {
+    expect(() => assertLaneValues("# M1.L1\nOwns: a.ts\n", "lanes/M1.L1.md")).not.toThrow();
+    expect(() => assertLaneValues("# M1.L1\nDifficulty: medium\n", "lanes/M1.L1.md")).toThrow(
+      'lanes/M1.L1.md: Difficulty "medium" is not one the catalog knows',
+    );
+    expect(() => assertLaneValues("# x\nAfter: L1\nAllow: /etc/passwd\n", "lanes/x.md")).toThrow(
+      'After "L1" is not a lane id like M1.L1; Allow "/etc/passwd" is not a repo path, or path:line',
+    );
+    expect(() => assertLaneValues("# x\nOwns: ../out\n", "lanes/x.md")).toThrow("lanes/x.md: owned path");
+  });
+});
+
+describe("onlyAllowedHits", () => {
+  const allow = ["services/verification/internal/job/command.go:120", "docs/"];
+  it("passes a check whose every hit is an allowed exception, and nothing else", () => {
+    expect(onlyAllowedHits(["services/verification/internal/job/command.go:120:func Allowed()"], allow)).toBe(
+      true,
+    );
+    expect(onlyAllowedHits(["docs/a.md:3:Allowed"], allow)).toBe(true);
+    expect(onlyAllowedHits(["services/verification/internal/job/command.go:121:x"], allow)).toBe(false);
+    expect(onlyAllowedHits(["error: rg not found"], allow)).toBe(false);
+    expect(onlyAllowedHits([], allow)).toBe(false);
+    expect(onlyAllowedHits(["docs/a.md:3:x"], [])).toBe(false);
+  });
+
   it("returns nulls for missing or unknown kind and difficulty", () => {
     const h = parseLaneHeader("# x\nOwns: a.ts\nKind: poetry\n");
     expect(h.kind).toBeNull();
diff --git a/test/services/admission.test.ts b/test/services/admission.test.ts
index c318a8a..cdc570a 100644
--- a/test/services/admission.test.ts
+++ b/test/services/admission.test.ts
@@ -10,10 +10,10 @@ import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
 import { type AdmitInput, admit } from "../../src/services/admission.ts";
 import { resetReadiness } from "../../src/services/backends.ts";
 import { latestDispatch } from "../../src/services/dispatches.ts";
-import { readRecords } from "../../src/services/run-store.ts";
+import { appendRecord, readRecords } from "../../src/services/run-store.ts";
 import { snapshotEnv } from "../helpers.ts";
 import { simPath, withScenario } from "../sim/scenario.ts";
-import { fakeDeps, fakeDispatch, fakeGit, freshRun, testView, writeLane } from "./helpers.ts";
+import { fakeDeps, fakeDispatch, fakeGit, freshRun, makeRecord, testView, writeLane } from "./helpers.ts";
 
 afterEach(snapshotEnv());
 // a test that needs a backend with no adapter unregisters a real one (plan 17 Ruling X2)
@@ -81,6 +81,24 @@ describe("admission", () => {
     expect(latestDispatch(run, "worker-M1.L1")?.admit.dispatchId).toBe(d.admit.dispatchId);
   });
 
+  it("refuses a lane whose After: lane has not finished, naming it (spec 1.5 lane order)", async () => {
+    const { run } = setup();
+    writeLane(run, "M1.L2", ["src/b.ts"], "true", "Kind: repo_code\nDifficulty: build\nAfter: M1.L1\n");
+    const e = await admit(fakeDeps(), run, input({ name: "worker-M1.L2", lane: "M1.L2" })).catch((x) => x);
+    expect(e).toMatchObject({
+      code: "E_ADMIT_ORDER",
+      message: "M1.L2 runs after M1.L1 (its After: line), which has not finished",
+    });
+    const first = await admit(fakeDeps(), run, input());
+    await appendRecord(
+      run,
+      makeRecord({ runId: run.id, dispatchId: first.d.admit.dispatchId, name: "worker-M1.L1" }),
+    );
+    expect(await refusal(admit(fakeDeps(), run, input({ name: "worker-M1.L2", lane: "M1.L2" })))).toBe(
+      "admitted",
+    );
+  });
+
   it("keeps the server's environment out of spec.json, which only its owner can read (spec §10.4)", async () => {
     const { repo, run } = setup();
     process.env.FOO_API_KEY = "s3cret";
diff --git a/test/services/lanes-run.test.ts b/test/services/lanes-run.test.ts
index 26cb8a8..a4bee42 100644
--- a/test/services/lanes-run.test.ts
+++ b/test/services/lanes-run.test.ts
@@ -326,6 +326,17 @@ describe("run files, result and agent runs", () => {
     expect(nextLine(runPaths(run.dir).state)).toBe("Next: paused: user asked");
   });
 
+  it("refuses a lane whose header values are wrong when it is written, not at preflight", async () => {
+    const { run } = freshRun();
+    const lane = "# M1.L1\nOwns: src/a.ts\nKind: repo_code\nDifficulty: medium\n";
+    expect(await codeOf(() => writeRunFile({ run: run.id, path: "lanes/M1.L1.md", content: lane }))).toBe(
+      "E_LANE_INVALID",
+    );
+    expect(existsSync(join(run.dir, "lanes", "M1.L1.md"))).toBe(false);
+    // only a lane is checked: a plan may quote the word
+    writeRunFile({ run: run.id, path: "plan.md", content: lane });
+  });
+
   it("returns a live role's state, then its record, capped reply and hints", async () => {
     const { run } = freshRun();
     const deps = fakeDeps();
diff --git a/test/services/preflight.test.ts b/test/services/preflight.test.ts
index 933a6b5..6032b2f 100644
--- a/test/services/preflight.test.ts
+++ b/test/services/preflight.test.ts
@@ -46,6 +46,31 @@ describe("preflight", () => {
     expect(r.results[4]?.note).toBe("lanes/M1.L5.md has no Fast check: line");
   });
 
+  it("passes an absence check whose every hit is one of the lane's Allow: exceptions", async () => {
+    const { run } = freshRun();
+    const grep = (hits: string) => `printf '${hits}'; exit 1`;
+    writeLane(
+      run,
+      "M1.L1",
+      ["src/a.go"],
+      grep("src/job/command.go:120:func Allowed()\\n"),
+      "Kind: repo_code\nDifficulty: build\nAllow: src/job/command.go:120\n",
+    );
+    writeLane(
+      run,
+      "M1.L2",
+      ["src/a.go"],
+      grep("src/job/command.go:121:func Allowed()\\n"),
+      "Kind: repo_code\nDifficulty: build\nAllow: src/job/command.go:120\n",
+    );
+    const r = await preflight(fakeDeps(), { run: run.id });
+    expect(outcomes(r)).toEqual([
+      ["M1.L1", "pass"],
+      ["M1.L2", "fails-as-expected"],
+    ]);
+    if (!r.needsConfirmation) expect(r.results[0]?.note).toBe("every hit is an Allow: exception (1)");
+  });
+
   it("stops a check at its timeout and calls it cannot-start", async () => {
     const { run } = freshRun();
     writeLane(run, "M1.L1", ["src/a.ts"], "sleep 5");
diff --git a/test/services/protocol.test.ts b/test/services/protocol.test.ts
index da991c1..7bf5e13 100644
--- a/test/services/protocol.test.ts
+++ b/test/services/protocol.test.ts
@@ -145,6 +145,27 @@ describe("Protocol next (spec 1.1 §10)", () => {
     expect(protocolNext(run, [])).toBe("M1: reviewer");
   });
 
+  it("keeps a lane back until the lanes its After: line names have finished ok", async () => {
+    const { run } = freshRun();
+    const deps = fakeDeps();
+    writeLane(run, "M1.L1", ["kit/"]);
+    writeLane(run, "M1.L2", ["web/"], "true", "Kind: repo_code\nDifficulty: build\nAfter: M1.L1\n");
+    writeLane(run, "M1.L3", ["api/"]);
+    for (const l of ["M1.L1", "M1.L2", "M1.L3"])
+      await route(deps, { run: run.id, laneFile: `lanes/${l}.md`, role: "worker" });
+    expect(protocolNext(run, [])).toBe("dispatch M1.L1, M1.L3; then M1.L2 after M1.L1");
+    worked(run, "M1.L3");
+    const kit = await fakeDispatch(run, { name: "worker-M1.L1", lane: "M1.L1" }, { proc: "self" });
+    expect(protocolNext(run, [])).toBe("M1: lanes running (worker-M1.L1); then M1.L2 after M1.L1");
+    await appendRecord(
+      run,
+      makeRecord({ runId: run.id, dispatchId: kit.admit.dispatchId, name: "worker-M1.L1", status: "failed" }),
+    );
+    expect(protocolNext(run, [])).toBe("dispatch M1.L1; then M1.L2 after M1.L1");
+    worked(run, "M1.L1");
+    expect(protocolNext(run, [])).toBe("dispatch M1.L2");
+  });
+
   it("says finish once every milestone landed", async () => {
     const { repo, run } = freshRun();
     writeLane(run, "M1.L1", ["src/a.ts"]);
````

**Code (scratch `5b28277`):**

````diff
diff --git a/src/domain/errors.ts b/src/domain/errors.ts
index 59fde2f..a02d459 100644
--- a/src/domain/errors.ts
+++ b/src/domain/errors.ts
@@ -18,6 +18,7 @@ export type ErrorCode =
   | "E_ADMIT_ID"
   | "E_ADMIT_THREAD"
   | "E_ADMIT_PAUSED"
+  | "E_ADMIT_ORDER"
   | "E_LANE_INVALID"
   | "E_LAND_GATE"
   | "E_CLIMB_DESIGN"
diff --git a/src/domain/lane.ts b/src/domain/lane.ts
index 76e7e73..69318fe 100644
--- a/src/domain/lane.ts
+++ b/src/domain/lane.ts
@@ -11,8 +11,18 @@ export interface LaneHeader {
   fastCheck: string | null;
   kind: Kind | null;
   difficulty: Difficulty | null;
+  /** `After: M1.L1, M1.L2`: lanes that must finish first (protocol.next and admission keep the order) */
+  after: string[];
+  /** `Allow: path[:line], …` under the check: hits of the lane's absence check that are allowed exceptions */
+  allow: string[];
 }
 
+/** A lane id in an After: line: Mx.Ly, the shape lanes/<id>.md takes. */
+const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9._-]*$/;
+
+/** An Allow: entry: a repo-relative path, optionally `:<line>`. */
+const ALLOW_ENTRY = /^([^\s:]+)(?::(\d+))?$/;
+
 const unquote = (s: string) =>
   s
     .trim()
@@ -51,15 +61,81 @@ export function parseLaneHeader(text: string): LaneHeader {
   const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? null;
   const owns = (field(text, "owns") ?? "").split(",").map(unquote).filter(Boolean).map(normalizeOwned);
   const check = field(text, "fast check");
+  const list = (label: string) => (field(text, label) ?? "").split(",").map(unquote).filter(Boolean);
   return {
     title,
     owns,
     fastCheck: check ? unquote(check) || null : null,
     kind: oneOf(field(text, "kind"), KINDS),
     difficulty: oneOf(field(text, "difficulty"), DIFFICULTIES),
+    after: list("after"),
+    allow: list("allow"),
   };
 }
 
+/** What is wrong with the After: and Allow: entries, one line each; none when they are well formed. */
+function orderProblems(h: LaneHeader): string[] {
+  const out: string[] = [];
+  for (const a of h.after) if (!LANE_ID.test(a)) out.push(`After "${a}" is not a lane id like M1.L1`);
+  for (const a of h.allow) {
+    const m = ALLOW_ENTRY.exec(a);
+    try {
+      if (!m) throw new Error();
+      normalizeOwned(m[1] as string);
+    } catch {
+      out.push(`Allow "${a}" is not a repo path, or path:line`);
+    }
+  }
+  return out;
+}
+
+/**
+ * Spec 1.5 "Lane editing": `write_run_file` refuses a lane whose header values are present but wrong (a Kind
+ * or Difficulty the catalog does not know, an Owns path that leaves the repo, a malformed After: or Allow:),
+ * so a typo is caught when the lane is written, not at preflight. A missing line is left to routing.
+ */
+export function assertLaneValues(text: string, where: string): LaneHeader {
+  let h: LaneHeader;
+  try {
+    h = parseLaneHeader(text);
+  } catch (e) {
+    throw new CatherdError("E_LANE_INVALID", `${where}: ${(e as Error).message}`, {
+      fix: "write Owns: paths like src/foo/ or src/bar.ts",
+    });
+  }
+  const problems: string[] = [];
+  const kind = field(text, "kind");
+  const difficulty = field(text, "difficulty");
+  if (kind !== null && h.kind === null) problems.push(`Kind "${unquote(kind)}" is not one the catalog knows`);
+  if (difficulty !== null && h.difficulty === null)
+    problems.push(`Difficulty "${unquote(difficulty)}" is not one the catalog knows`);
+  problems.push(...orderProblems(h));
+  if (problems.length)
+    throw new CatherdError("E_LANE_INVALID", `${where}: ${problems.join("; ")}`, {
+      fix: `${LANE_HEADER_FIX}; After: M1.L1, M1.L2; Allow: path or path:line`,
+    });
+  return h;
+}
+
+/**
+ * Whether every line a failing check printed is a `path:line` hit its lane allows: an absence check (a grep
+ * that must find nothing) whose only hits are the lane's declared exceptions has passed.
+ */
+export function onlyAllowedHits(lines: string[], allow: string[]): boolean {
+  const hits = lines.map((l) => /^([^\s:]+):(\d+)(?::|$)/.exec(l.trim()));
+  if (allow.length === 0 || hits.length === 0 || hits.some((m) => !m)) return false;
+  return hits.every((m) =>
+    allow.some((entry) => {
+      const [, path, line] = ALLOW_ENTRY.exec(entry) ?? [];
+      if (!path) return false;
+      const file = (m as RegExpExecArray)[1] as string;
+      const at = (m as RegExpExecArray)[2];
+      const inPath = file === path || (path.endsWith("/") && file.startsWith(path));
+      return inPath && (line === undefined || line === at);
+    }),
+  );
+}
+
 /** The fix every lane-header refusal carries: the values the catalog knows. */
 export const LANE_HEADER_FIX = `write the lane's header lines as Kind: ${KINDS.join("|")} and Difficulty: ${DIFFICULTIES.join("|")}`;
 
@@ -78,6 +154,7 @@ export function assertLaneHeader(text: string, where: string): LaneHeader {
   };
   check("Kind", field(text, "kind"), h.kind !== null);
   check("Difficulty", field(text, "difficulty"), h.difficulty !== null);
+  problems.push(...orderProblems(h));
   if (problems.length)
     throw new CatherdError("E_LANE_INVALID", `${where}: ${problems.join("; ")}`, { fix: LANE_HEADER_FIX });
   return h;
diff --git a/src/services/admission.ts b/src/services/admission.ts
index cda686c..27618e0 100644
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -32,6 +32,7 @@ import {
 } from "./dispatches.ts";
 import { finalizeDispatch } from "./finalize.ts";
 import { assertNotPaused } from "./pause.ts";
+import { unfinishedAfter } from "./protocol.ts";
 import type { Deps } from "./ports.ts";
 import { readRecords, recordsOnThread, type Run, runPaths, supersededBy } from "./run-store.ts";
 import { currentSession } from "./sessions.ts";
@@ -193,6 +194,14 @@ export async function admit(
       { fix: "dispatch a fresh thread (omit `thread`)" },
     );
   const owns = i.lane === null ? [] : laneOwns(run, i.lane);
+  // spec 1.5 "Lane editing": an After: line orders lanes that compile against each other
+  const before = i.lane === null ? [] : unfinishedAfter(run, i.lane);
+  if (before.length)
+    throw new CatherdError(
+      "E_ADMIT_ORDER",
+      `${i.lane} runs after ${before.join(", ")} (its After: line), which ${before.length > 1 ? "have" : "has"} not finished`,
+      { fix: `dispatch ${i.lane} once ${before.join(", ")} ${before.length > 1 ? "end" : "ends"} ok` },
+    );
   const id = newDispatchId();
   const dir = join(roleDir(run, i.name), id);
   const p = dispatchPaths(dir);
diff --git a/src/services/preflight.ts b/src/services/preflight.ts
index a914082..ea55185 100644
--- a/src/services/preflight.ts
+++ b/src/services/preflight.ts
@@ -1,7 +1,7 @@
 import { existsSync, readdirSync, readFileSync } from "node:fs";
 import { join } from "node:path";
 import { CatherdError, errorMessage } from "../domain/errors.ts";
-import { assertLaneHeader, LANE_HEADER_FIX, parseLaneHeader } from "../domain/lane.ts";
+import { assertLaneHeader, LANE_HEADER_FIX, onlyAllowedHits, parseLaneHeader } from "../domain/lane.ts";
 import { checkEnv } from "../infra/env.ts";
 import { heavySlots, withHeavySlot } from "../infra/heavy-lock.ts";
 import { killGroup } from "../infra/proc.ts";
@@ -47,6 +47,8 @@ interface LaneCheck {
   lane: string;
   check: string | null;
   owns: string[];
+  /** spec 1.5: the Allow: exceptions of the lane's absence check */
+  allow: string[];
   problem: string | null;
   /** spec 1.1 §6: why its Kind: or Difficulty: line is refused */
   invalid: string | null;
@@ -73,15 +75,19 @@ function laneChecks(run: Run): LaneCheck[] {
           lane,
           check: h.fastCheck,
           owns: h.owns,
+          allow: h.allow,
           problem: h.fastCheck ? null : `lanes/${f} has no Fast check: line`,
           invalid,
         };
       } catch (e) {
-        return { lane, check: null, owns: [], problem: (e as Error).message, invalid };
+        return { lane, check: null, owns: [], allow: [], problem: (e as Error).message, invalid };
       }
     });
 }
 
+/** How many output lines a check's Allow: exceptions are matched against; past it, the check fails as before. */
+const ALLOW_LINES = 1_000;
+
 /** How long the pipes may stay open after the check's own process exits. */
 export const DRAIN_MS = 500;
 
@@ -116,7 +122,7 @@ export async function runCheck(
   repo: string,
   check: string,
   timeoutMs: number,
-): Promise<{ code: number | null; timedOut: boolean; tail: string[] }> {
+): Promise<{ code: number | null; timedOut: boolean; tail: string[]; lines: string[] }> {
   const p = Bun.spawn(["sh", "-c", check], {
     cwd: repo,
     env: checkEnv(process.env, repo),
@@ -141,11 +147,10 @@ export async function runCheck(
       Bun.sleep(DRAIN_MS).then(() => false),
     ]);
     if (!drained) killGroup(p.pid, "SIGKILL"); // leftovers still in the check's group
-    const tail = `${out.text()}${err.text()}`
-      .split("\n")
-      .filter((l) => l.trim())
-      .slice(-TAIL_LINES);
-    return { code: timedOut ? null : code, timedOut, tail };
+    // every line, up to a bound, for a lane's Allow: exceptions; the tail is what the report shows
+    const all = `${out.text()}${err.text()}`.split("\n").filter((l) => l.trim());
+    const lines = all.length <= ALLOW_LINES ? all : [];
+    return { code: timedOut ? null : code, timedOut, tail: all.slice(-TAIL_LINES), lines };
   } finally {
     clearTimeout(timer);
     out.stop();
@@ -203,13 +208,19 @@ export async function preflight(
       continue;
     }
     const r = await withHeavySlot(heavySlots(profile.heavy), () => runCheck(run.meta.repo, check, timeoutMs));
+    // spec 1.5: an absence check whose every hit is one of the lane's Allow: exceptions has passed
+    const allowed = classify(r) === "fails-as-expected" && onlyAllowedHits(r.lines, l.allow);
     results.push({
       lane: l.lane,
       check,
-      outcome: classify(r),
+      outcome: allowed ? "pass" : classify(r),
       exitCode: r.code,
       tail: r.tail,
-      note: r.timedOut ? `timed out after ${timeoutMs / 1000} s` : null,
+      note: r.timedOut
+        ? `timed out after ${timeoutMs / 1000} s`
+        : allowed
+          ? `every hit is an Allow: exception (${r.lines.length})`
+          : null,
     });
   }
   return {
diff --git a/src/services/protocol.ts b/src/services/protocol.ts
index bd5fb78..1fd69d0 100644
--- a/src/services/protocol.ts
+++ b/src/services/protocol.ts
@@ -2,6 +2,7 @@ import { existsSync, readdirSync, readFileSync } from "node:fs";
 import { join } from "node:path";
 import type { RunRecord } from "../domain/record.ts";
 import type { RouteRow } from "../domain/route.ts";
+import { parseLaneHeader } from "../domain/lane.ts";
 import { ensurePrivateDir, readJsonl, writeTextAtomic } from "../infra/store.ts";
 import { type Dispatch, listDispatches, liveDispatches } from "./dispatches.ts";
 import type { VerifierStep } from "./gate-service.ts";
@@ -78,6 +79,24 @@ function laneDone(run: Run, lane: string, routes: RouteRow[], live: Dispatch[]):
   return latest?.ok ?? false;
 }
 
+/** The lane's After: lanes, from its file; none when it has none or cannot be read. */
+function afterOf(run: Run, lane: string): string[] {
+  try {
+    return parseLaneHeader(readFileSync(join(runPaths(run.dir).lanes, `${lane}.md`), "utf8")).after;
+  } catch {
+    return [];
+  }
+}
+
+/**
+ * Spec 1.5 "Lane editing": the lanes `lane`'s After: line names that have not finished: their milestone has
+ * not landed and their latest try since the latest climb is still running, or did not end ok.
+ */
+export function unfinishedAfter(run: Run, lane: string, routes: RouteRow[] = readRoutes(run)): string[] {
+  const landed = new Set(landedMilestones(run));
+  return afterOf(run, lane).filter((a) => !landed.has(milestoneOf(a)) && !laneDone(run, a, routes, []));
+}
+
 /**
  * The step the milestone loop is at: the first milestone neither landed nor parked, and within it the
  * first of route, dispatch, collect, reviewer, verifier and land that is still to do.
@@ -105,10 +124,19 @@ export function protocolNext(run: Run, parked: string[], now = Date.now()): stri
     return last?.source === "climb" && last.from === last.rung;
   });
   const waiting = notDone.filter((l) => !spent.includes(l));
-  if (waiting.length) return `dispatch ${waiting.join(", ")}`;
+  // an After: line keeps a lane back until the lanes it names have finished
+  const held = new Map(waiting.map((l) => [l, unfinishedAfter(run, l, routes)]));
+  const ready = waiting.filter((l) => held.get(l)?.length === 0);
+  const order = waiting
+    .filter((l) => !ready.includes(l))
+    .map((l) => `${l} after ${held.get(l)?.join(", ")}`)
+    .join("; ");
+  if (ready.length) return `dispatch ${ready.join(", ")}${order ? `; then ${order}` : ""}`;
   if (spent.length) return `${spent.join(", ")}: out of rungs — ask finding, then the architect or park ${m}`;
   const running = live.filter((d) => d.admit.lane !== null && mine.includes(d.admit.lane));
-  if (running.length) return `${m}: lanes running (${running.map((d) => d.admit.name).join(", ")})`;
+  if (running.length)
+    return `${m}: lanes running (${running.map((d) => d.admit.name).join(", ")})${order ? `; then ${order}` : ""}`;
+  if (order) return `${m}: ${order} (After:), not done: finish those lanes first`;
   const start = milestoneStart(run, m);
   if (!reviewerPassed(run, m, start)) return `${m}: reviewer`;
   if (!verifierPassed(run, m, start)) return `${m}: verifier`;
diff --git a/src/services/run-service.ts b/src/services/run-service.ts
index 15bce98..a85ddff 100644
--- a/src/services/run-service.ts
+++ b/src/services/run-service.ts
@@ -1,7 +1,8 @@
 import { existsSync, readFileSync } from "node:fs";
-import { relative } from "node:path";
+import { relative, sep } from "node:path";
 import { CatherdError } from "../domain/errors.ts";
 import { assertId, parseRung } from "../domain/ids.ts";
+import { assertLaneValues } from "../domain/lane.ts";
 import type { RunRecord } from "../domain/record.ts";
 import type { Role } from "../domain/roles.ts";
 import { awaitsCollect, dispatchPaths, endCollect, tryCollect } from "../infra/dispatch-dir.ts";
@@ -106,7 +107,11 @@ export function writeRunFile(i: { run: string; path: string; content: string }):
   path: string;
   bytes: number;
 } {
-  const file = runFile(findRun(i.run), i.path, "write");
+  const run = findRun(i.run);
+  const file = runFile(run, i.path, "write");
+  // spec 1.5 "Lane editing": a lane's header values are checked when it is written, not first at preflight
+  const lane = /^lanes\/([^/]+)\.md$/.exec(relative(run.dir, file).split(sep).join("/"));
+  if (lane) assertLaneValues(i.content, `lanes/${lane[1]}.md`);
   writeTextAtomic(file, i.content);
   return { path: file, bytes: Buffer.byteLength(i.content) };
 }
````

### Task 9: `lane_set` edits one header line and `owns_add` grows Owns mid-lane

**Files:** `src/services/lane-edit.ts` (new), `src/services/finalize.ts`, `src/entry/mcp/lane-tools.ts`, `test/services/lane-edit.test.ts` (new), `test/entry/mcp.test.ts`.

**Produces:** `LANE_FIELDS`, `LaneField`, `setHeaderLine`, `laneSet`, `ownsAdd`, `currentOwns`; MCP `lane_set`, `owns_add` (36 tools); finalize holds a lane dispatch to its admitted Owns plus the lane file's. **Consumes:** Task 8's `assertLaneValues`.

- [ ] **Step 1: the failing tests.** Apply the test diff. Run `bun test test/services/lane-edit.test.ts test/entry/mcp.test.ts`.
- [ ] **Step 2: the code.** Apply the source diff; run it and `bun test test/services/dispatch.test.ts test/services/adapter-hooks.test.ts test/architecture.test.ts`.
- [ ] **Step 3: commit** `feat(lanes): lane_set edits one header line and owns_add grows Owns mid-lane` (scratch `c056bd1`).

**Tests (scratch `c056bd1`):**

````diff
diff --git a/test/entry/mcp.test.ts b/test/entry/mcp.test.ts
index f923bef..a56b4a8 100644
--- a/test/entry/mcp.test.ts
+++ b/test/entry/mcp.test.ts
@@ -48,13 +48,15 @@ const TOOLS = [
   "workspace_budget",
   "workspace_pause",
   "workspace_resume",
+  "lane_set",
+  "owns_add",
 ];
 
 describe("MCP server", () => {
-  it("lists exactly the run and workspace tools, 34 of them", async () => {
+  it("lists exactly the run and workspace tools, 36 of them", async () => {
     freshRun();
     const c = await mcpClient();
-    expect(TOOLS).toHaveLength(34);
+    expect(TOOLS).toHaveLength(36);
     expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
     const described = (name: string) =>
       c.listTools().then((l) => l.tools.find((t) => t.name === name)?.description ?? "");
diff --git a/test/services/lane-edit.test.ts b/test/services/lane-edit.test.ts
new file mode 100644
index 0000000..3fc6a0f
--- /dev/null
+++ b/test/services/lane-edit.test.ts
@@ -0,0 +1,87 @@
+import { afterEach, expect, it } from "bun:test";
+import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
+import { join } from "node:path";
+import { finalizeDispatch } from "../../src/services/finalize.ts";
+import { laneSet, ownsAdd, setHeaderLine } from "../../src/services/lane-edit.ts";
+import { snapshotEnv } from "../helpers.ts";
+import { fakeDeps, fakeDispatch, freshRun, writeLane } from "./helpers.ts";
+
+afterEach(snapshotEnv());
+
+const read = (file: string) => readFileSync(file, "utf8");
+
+it("sets one header line in place, or adds it under the title", () => {
+  const text = "# M1.L1 — x\nOwns: a.ts\n**Fast check:** `go test`\n\nbody\n";
+  expect(setHeaderLine(text, "Fast check", "pnpm check && go test")).toBe(
+    "# M1.L1 — x\nOwns: a.ts\nFast check: pnpm check && go test\n\nbody\n",
+  );
+  expect(setHeaderLine(text, "After", "M1.L0")).toBe(
+    "# M1.L1 — x\nAfter: M1.L0\nOwns: a.ts\n**Fast check:** `go test`\n\nbody\n",
+  );
+});
+
+it("lane_set writes a valid line, and refuses a wrong value without touching the file", async () => {
+  const { run } = freshRun();
+  const file = writeLane(run, "M1.L1", ["src/a.ts"]);
+  const deps = fakeDeps();
+  const r = await laneSet(deps, { run: run.id, lane: "M1.L1", field: "fast_check", value: "pnpm check" });
+  expect(r.header.fastCheck).toBe("pnpm check");
+  expect(read(file)).toContain("Fast check: pnpm check\n");
+  const before = read(file);
+  await expect(
+    laneSet(deps, { run: run.id, lane: "M1.L1", field: "difficulty", value: "medium" }),
+  ).rejects.toMatchObject({ code: "E_LANE_INVALID" });
+  await expect(
+    laneSet(deps, { run: run.id, lane: "M1.L1", field: "owns", value: "../outside" }),
+  ).rejects.toMatchObject({ code: "E_LANE_INVALID" });
+  expect(read(file)).toBe(before);
+  await expect(
+    laneSet(deps, { run: run.id, lane: "M9.L9", field: "kind", value: "ui" }),
+  ).rejects.toMatchObject({
+    code: "E_LANE_INVALID",
+  });
+});
+
+it("owns_add grows Owns with its why, refusing a path a running lane owns", async () => {
+  const { run } = freshRun();
+  const file = writeLane(run, "M1.L3", ["services/notification/"]);
+  writeLane(run, "M1.L4", ["web/panels/"]);
+  const deps = fakeDeps({ now: () => Date.parse("2026-10-02T10:00:00.000Z") });
+  await fakeDispatch(run, { name: "worker-M1.L5", lane: "M1.L5", owns: ["kit/"] }, { proc: "self" });
+  await expect(
+    ownsAdd(deps, { run: run.id, lane: "M1.L3", paths: ["kit/x.go"], why: "the grep missed it" }),
+  ).rejects.toMatchObject({ code: "E_ADMIT_OVERLAP" });
+  const r = await ownsAdd(deps, {
+    run: run.id,
+    lane: "M1.L3",
+    paths: ["./services/notification/cmd/audit_platform_test.go", "web/panels/a.tsx"],
+    why: "the plan's grep excluded _test.go",
+  });
+  expect(r.added).toEqual(["services/notification/cmd/audit_platform_test.go", "web/panels/a.tsx"]);
+  expect(r.hints).toEqual(["lanes/M1.L4.md also owns web/panels/a.tsx: do not run the two together"]);
+  expect(read(file)).toContain(
+    "Owns: services/notification/, services/notification/cmd/audit_platform_test.go, web/panels/a.tsx\n",
+  );
+  expect(read(file)).toContain(
+    "Owns added 2026-10-02T10:00:00.000Z: services/notification/cmd/audit_platform_test.go, web/panels/a.tsx — the plan's grep excluded _test.go",
+  );
+  await expect(ownsAdd(deps, { run: run.id, lane: "M1.L3", paths: ["x"], why: " " })).rejects.toThrow(
+    "owns_add needs a why",
+  );
+});
+
+it("holds a dispatch still running when its Owns grew to the new list, so the added path is not a violation", async () => {
+  const { run } = freshRun();
+  writeLane(run, "M1.L1", ["src/a.ts"]);
+  const d = await fakeDispatch(
+    run,
+    {},
+    { proc: "dead", exit: { code: 0, signal: null, reason: "exited", endedAt: new Date().toISOString() } },
+  );
+  await ownsAdd(fakeDeps(), { run: run.id, lane: "M1.L1", paths: ["src/a_test.ts"], why: "its test" });
+  mkdirSync(join(run.meta.repo, "src"), { recursive: true });
+  writeFileSync(join(run.meta.repo, "src", "a_test.ts"), "t");
+  const record = await finalizeDispatch(run, d);
+  expect(record.changedOwned).toEqual(["src/a_test.ts"]);
+  expect(record.violations).toEqual([]);
+});
````

**Code (scratch `c056bd1`):**

````diff
diff --git a/src/entry/mcp/lane-tools.ts b/src/entry/mcp/lane-tools.ts
index 00a23a9..2eb4e52 100644
--- a/src/entry/mcp/lane-tools.ts
+++ b/src/entry/mcp/lane-tools.ts
@@ -3,6 +3,7 @@ import { z } from "zod";
 import { ID_PATTERN } from "../../domain/ids.ts";
 import { ROLES } from "../../domain/roles.ts";
 import { CLIMB_REASONS } from "../../domain/route.ts";
+import { LANE_FIELDS, type LaneField, laneSet, ownsAdd } from "../../services/lane-edit.ts";
 import { ask, climb, LAND_SKIPS, land, route } from "../../services/lane-service.ts";
 import type { Deps } from "../../services/ports.ts";
 import { preflight } from "../../services/preflight.ts";
@@ -23,6 +24,37 @@ export function registerLaneTools(server: McpServer, deps: Deps): void {
     (a) => handle(() => route(deps, { run: a.run, laneFile: a.lane_file, role: a.role })),
   );
 
+  const lane = z.string().regex(ID_PATTERN);
+  server.registerTool(
+    "lane_set",
+    {
+      description:
+        "Set one header line of a lane file (owns, fast_check, kind, difficulty, after, allow), validated as write_run_file validates a lane: an unknown Kind or Difficulty, an Owns path outside the repo, or a malformed After:/Allow: is refused with E_LANE_INVALID, and an Owns that a running lane holds with E_ADMIT_OVERLAP. after names lanes that must finish first; allow lists path or path:line hits the lane's absence check may report. Returns the line and the header as it now reads. Orchestrator only.",
+      inputSchema: {
+        run: z.string(),
+        lane,
+        field: z.enum(Object.keys(LANE_FIELDS) as [LaneField, ...LaneField[]]),
+        value: z.string(),
+      },
+    },
+    (a) => handle(() => laneSet(deps, a)),
+  );
+
+  server.registerTool(
+    "owns_add",
+    {
+      description:
+        "Grow a lane's Owns mid-lane, with why (kept in the lane file): a running lane that owns one of the paths refuses it with E_ADMIT_OVERLAP; another lane file that lists one comes back as a hint. A dispatch of the lane still running is held to the new list when it finishes, so its edits there are not violations. Orchestrator only.",
+      inputSchema: {
+        run: z.string(),
+        lane,
+        paths: z.array(z.string().min(1)).min(1).max(100),
+        why: z.string().min(1),
+      },
+    },
+    (a) => handle(() => ownsAdd(deps, a)),
+  );
+
   server.registerTool(
     "preflight",
     {
diff --git a/src/services/finalize.ts b/src/services/finalize.ts
index 7741065..eae8e9a 100644
--- a/src/services/finalize.ts
+++ b/src/services/finalize.ts
@@ -25,6 +25,7 @@ import {
   writeTextAtomic,
 } from "../infra/store.ts";
 import { type Dispatch, dispatchState, listDispatches, readProc } from "./dispatches.ts";
+import { currentOwns } from "./lane-edit.ts";
 import { tail } from "./run-debug.ts";
 import { appendRecord, readRecords, recordsOnThread, type Run, runPaths } from "./run-store.ts";
 
@@ -186,7 +187,8 @@ async function compute(run: Run, d: Dispatch): Promise<RunRecord> {
   const { changedOwned, violations } = after
     ? splitChanges(
         changedPaths(a.before, after),
-        a.owns,
+        // spec 1.5 owns_add: paths the lane gained while it ran are its own, not violations
+        a.lane === null ? a.owns : [...new Set([...a.owns, ...currentOwns(run, a.lane)])],
         // from admission, when the before-snapshot was taken, not from the worker's start
         othersOwns(run, d, Date.parse(a.admittedAt), end),
         a.lane !== null || a.access === "read-only",
diff --git a/src/services/lane-edit.ts b/src/services/lane-edit.ts
new file mode 100644
index 0000000..5c67a93
--- /dev/null
+++ b/src/services/lane-edit.ts
@@ -0,0 +1,151 @@
+import { existsSync, readdirSync, readFileSync } from "node:fs";
+import { join } from "node:path";
+import { CatherdError } from "../domain/errors.ts";
+import { assertId } from "../domain/ids.ts";
+import {
+  assertLaneValues,
+  type LaneHeader,
+  normalizeOwned,
+  overlaps,
+  parseLaneHeader,
+} from "../domain/lane.ts";
+import { cell } from "../domain/util.ts";
+import { withFileLock } from "../infra/filelock.ts";
+import { writeTextAtomic } from "../infra/store.ts";
+import { pendingDispatches } from "./dispatches.ts";
+import type { Deps } from "./ports.ts";
+import { findRun, type Run, runPaths } from "./run-store.ts";
+
+/** lanes/<lane>.md in the run folder (admission's laneFile, kept here so finalize can import this module). */
+const laneFile = (run: Run, lane: string): string => join(runPaths(run.dir).lanes, `${lane}.md`);
+
+// Spec 1.5 "Lane editing": one header line at a time, validated, instead of `sed` on the run folder; and an
+// Owns list that can grow mid-lane, with the overlap re-checked.
+
+/** The header lines lane_set writes, and their labels in the lane file. */
+export const LANE_FIELDS = {
+  owns: "Owns",
+  fast_check: "Fast check",
+  kind: "Kind",
+  difficulty: "Difficulty",
+  after: "After",
+  allow: "Allow",
+} as const;
+export type LaneField = keyof typeof LANE_FIELDS;
+
+/** `label`'s first header line, as parseLaneHeader reads it (`**Label:**` and `_Label_:` included). */
+const lineOf = (label: string) => new RegExp(`^\\s*[*_]*${label}[*_]*\\s*:.*$`, "im");
+
+/** `text` with `label`'s line set to `value`: replaced where it is, else added under the title. */
+export function setHeaderLine(text: string, label: string, value: string): string {
+  const line = `${label}: ${value}`;
+  if (lineOf(label).test(text)) return text.replace(lineOf(label), line);
+  const lines = text.split("\n");
+  const title = lines.findIndex((l) => /^#\s+/.test(l));
+  lines.splice(title + 1, 0, line);
+  return lines.join("\n");
+}
+
+function readLane(run: Run, lane: string): { file: string; text: string } {
+  assertId("lane", lane);
+  const file = laneFile(run, lane);
+  if (!existsSync(file))
+    throw new CatherdError("E_LANE_INVALID", `no lane file lanes/${lane}.md`, {
+      fix: "write it with write_run_file first",
+    });
+  return { file, text: readFileSync(file, "utf8") };
+}
+
+/**
+ * Paths of `owns` another running lane owns: refused as admission refuses them. Other lanes' Owns lines
+ * that overlap come back as hints: they are not running, so nothing collides yet.
+ */
+function overlapCheck(deps: Deps, run: Run, lane: string, owns: string[]): string[] {
+  for (const d of pendingDispatches(run, deps.now())) {
+    if (d.admit.lane === lane) continue;
+    const shared = overlaps(owns, d.admit.owns);
+    if (shared.length)
+      throw new CatherdError(
+        "E_ADMIT_OVERLAP",
+        `${lane} would own ${shared.join(", ")}, which ${d.admit.name} (running) owns`,
+        { fix: `add it once ${d.admit.name} finishes, or give the work to ${d.admit.lane ?? d.admit.name}` },
+      );
+  }
+  const dir = runPaths(run.dir).lanes;
+  const hints: string[] = [];
+  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
+    const other = f.endsWith(".md") ? f.slice(0, -3) : null;
+    if (!other || other === lane) continue;
+    try {
+      const shared = overlaps(owns, parseLaneHeader(readFileSync(join(dir, f), "utf8")).owns);
+      if (shared.length) hints.push(`lanes/${f} also owns ${shared.join(", ")}: do not run the two together`);
+    } catch {
+      // an unreadable lane is preflight's to report
+    }
+  }
+  return hints;
+}
+
+/**
+ * `lane_set(run, lane, field, value)`: one header line, validated as `write_run_file` validates a lane; an
+ * Owns line also re-checks overlap with the running lanes. Returns the line and the header as it now reads.
+ */
+export async function laneSet(
+  deps: Deps,
+  i: { run: string; lane: string; field: LaneField; value: string },
+): Promise<{ lane: string; line: string; header: LaneHeader; hints?: string[] }> {
+  const run = findRun(i.run);
+  const label = LANE_FIELDS[i.field];
+  if (!label)
+    throw new CatherdError("E_INPUT_INVALID", `no lane field "${i.field}"`, {
+      fix: `one of ${Object.keys(LANE_FIELDS).join(", ")}`,
+    });
+  const value = i.value.replace(/\s*\n\s*/g, " ").trim();
+  const { file } = readLane(run, i.lane);
+  return withFileLock(file, () => {
+    const next = setHeaderLine(readLane(run, i.lane).text, label, value);
+    const header = assertLaneValues(next, `lanes/${i.lane}.md`);
+    const hints = i.field === "owns" ? overlapCheck(deps, run, i.lane, header.owns) : [];
+    writeTextAtomic(file, next);
+    return { lane: i.lane, line: `${label}: ${value}`, header, ...(hints.length ? { hints } : {}) };
+  });
+}
+
+/**
+ * `owns_add(run, lane, paths, why)`: grows a lane's Owns mid-lane (a test file the plan's grep missed, a clone
+ * found after the gate ran), refused when a running lane owns one of them. The why is kept in the lane file.
+ * A running dispatch of the lane is held to the new list when it finishes.
+ */
+export async function ownsAdd(
+  deps: Deps,
+  i: { run: string; lane: string; paths: string[]; why: string },
+): Promise<{ lane: string; owns: string[]; added: string[]; hints?: string[] }> {
+  const run = findRun(i.run);
+  if (!i.why.trim())
+    throw new CatherdError("E_INPUT_INVALID", "owns_add needs a why", {
+      fix: "say what made the lane need the paths, in one line",
+    });
+  const paths = i.paths.map(normalizeOwned);
+  const { file } = readLane(run, i.lane);
+  return withFileLock(file, () => {
+    const text = readLane(run, i.lane).text;
+    const owns = parseLaneHeader(text).owns;
+    const added = paths.filter((p) => !owns.includes(p));
+    const merged = [...owns, ...added];
+    const hints = overlapCheck(deps, run, i.lane, added);
+    const note = `\nOwns added ${new Date(deps.now()).toISOString()}: ${added.join(", ")} — ${cell(i.why)}\n`;
+    const next = setHeaderLine(text, "Owns", merged.join(", "));
+    assertLaneValues(next, `lanes/${i.lane}.md`);
+    if (added.length) writeTextAtomic(file, `${next.replace(/\n*$/, "\n")}${note}`);
+    return { lane: i.lane, owns: merged, added, ...(hints.length ? { hints } : {}) };
+  });
+}
+
+/** The lane's Owns as its file reads now: a finishing dispatch is held to what owns_add granted since. */
+export function currentOwns(run: Run, lane: string): string[] {
+  try {
+    return parseLaneHeader(readFileSync(laneFile(run, lane), "utf8")).owns;
+  } catch {
+    return [];
+  }
+}
````

### Task 10: Pin the profile, access and isolation per run; `run_pin` re-pins

**Files:** `src/services/run-pin.ts` (new), `src/services/state.ts`, `src/domain/state.ts`, `src/services/run-service.ts`, `src/services/workspace-service.ts`, `src/services/admission.ts`, `src/services/lane-service.ts`, `src/services/dispatch-service.ts`, `src/services/summary.ts`, `src/entry/mcp/run-tools.ts`, `src/entry/runs-command.ts`, `test/services/run-pin.test.ts` (new), `test/entry/mcp.test.ts`.

**Produces:** `readPin`, `writePin`, `runProfile`, `pinChanges`, `repin`, `pinFile`; notes field `pinChanges` and the `Pinned:` line of `state.md`; `RunSummary.pinChanges`; MCP `run_pin` (37 tools); `catherd runs pin <id>`.

- [ ] **Step 1: the failing tests.** Apply the test diff. Run `bun test test/services/run-pin.test.ts test/entry/mcp.test.ts`.
- [ ] **Step 2: the code.** Apply the source diff; run it, then the full suite once (every `startRun` now writes `pin.json`).
- [ ] **Step 3: commit** `feat(runs): pin the profile, access and isolation per run, and run_pin re-pins` (scratch `8b94454`).

**Tests (scratch `8b94454`):**

````diff
diff --git a/test/entry/mcp.test.ts b/test/entry/mcp.test.ts
index a56b4a8..e5a921f 100644
--- a/test/entry/mcp.test.ts
+++ b/test/entry/mcp.test.ts
@@ -50,13 +50,14 @@ const TOOLS = [
   "workspace_resume",
   "lane_set",
   "owns_add",
+  "run_pin",
 ];
 
 describe("MCP server", () => {
-  it("lists exactly the run and workspace tools, 36 of them", async () => {
+  it("lists exactly the run and workspace tools, 37 of them", async () => {
     freshRun();
     const c = await mcpClient();
-    expect(TOOLS).toHaveLength(36);
+    expect(TOOLS).toHaveLength(37);
     expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
     const described = (name: string) =>
       c.listTools().then((l) => l.tools.find((t) => t.name === name)?.description ?? "");
diff --git a/test/services/run-pin.test.ts b/test/services/run-pin.test.ts
new file mode 100644
index 0000000..23817a8
--- /dev/null
+++ b/test/services/run-pin.test.ts
@@ -0,0 +1,99 @@
+import { afterEach, beforeEach, expect, it } from "bun:test";
+import { readFileSync } from "node:fs";
+import { admit } from "../../src/services/admission.ts";
+import { resetReadiness } from "../../src/services/backends.ts";
+import { pinChanges, readPin, repin, runProfile } from "../../src/services/run-pin.ts";
+import { startRun } from "../../src/services/run-service.ts";
+import { findRun, runPaths } from "../../src/services/run-store.ts";
+import { refreshState } from "../../src/services/state.ts";
+import { summarizeRun } from "../../src/services/summary.ts";
+import { snapshotEnv } from "../helpers.ts";
+import { simPath, withScenario } from "../sim/scenario.ts";
+import { fakeDeps, freshRun, testView, writeLane } from "./helpers.ts";
+
+afterEach(snapshotEnv());
+beforeEach(resetReadiness);
+
+async function pinnedRun() {
+  const { repo } = freshRun();
+  const deps = fakeDeps();
+  const started = await startRun(deps, { repo, title: "pinned", aLines: ["A1 it works"] });
+  return { deps, run: findRun(started.run) };
+}
+
+it("run_start pins the profile, each role's access and each backend's isolation", async () => {
+  const { run } = await pinnedRun();
+  expect(readPin(run)).toMatchObject({
+    profile: "test",
+    access: { worker: "workspace-write", reviewer: "read-only" },
+    isolated: {},
+  });
+});
+
+it("keeps the pinned values when the repo's profile changes, and says what changed", async () => {
+  const { deps, run } = await pinnedRun();
+  const pinned = testView();
+  // the owner switched the active profile and turned isolation on while the run was paused
+  Object.assign(deps.view, {
+    name: "just-claude",
+    isolated: { codex: true },
+    roles: { ...deps.view.roles, worker: { ...deps.view.roles.worker!, access: "full" } },
+  });
+  deps.profiles.get = (name) => ({
+    active: "just-claude",
+    here: "just-claude",
+    profiles: ["test", "just-claude"],
+    profile: name === "test" ? pinned : deps.view,
+    enforcement: {},
+  });
+  expect(pinChanges(deps, run)).toEqual([
+    "profile: pinned test, the repo now runs on just-claude",
+    "worker access: pinned workspace-write, now full",
+    "codex isolated: pinned false, now true",
+  ]);
+  const view = runProfile(deps, run);
+  expect(view.name).toBe("test");
+  expect(view.roles.worker?.access).toBe("workspace-write");
+  expect(view.isolated.codex === true).toBe(false);
+  expect(summarizeRun(deps, run).warnings).toContainEqual(
+    "pinned: codex isolated: pinned false, now true; dispatch keeps the pinned value (run_pin re-pins)",
+  );
+  // a dispatch admitted now runs on the pinned access and isolation
+  process.env.PATH = simPath();
+  Object.assign(process.env, withScenario({}).env);
+  writeLane(run, "M1.L1", ["src/a.ts"]);
+  const { d } = await admit(deps, run, {
+    role: "worker",
+    name: "worker-M1.L1",
+    brief: "b",
+    rung: "codex:gpt-6-luna#high",
+    thread: null,
+    lane: "M1.L1",
+    failoverFrom: null,
+  });
+  expect(d.admit).toMatchObject({ access: "workspace-write", isolated: false });
+  // re-pinning follows the repo, and nothing differs any more
+  const r = await repin(deps, { run: run.id });
+  expect(r.changed).toHaveLength(3);
+  expect(r.pin.profile).toBe("just-claude");
+  expect(pinChanges(deps, run)).toEqual([]);
+  expect(runProfile(deps, run).isolated.codex).toBe(true);
+});
+
+it("logs the changes in state.md, and drops the line once re-pinned", async () => {
+  const { deps, run } = await pinnedRun();
+  await refreshState(run, { pinChanges: ["codex isolated: pinned false, now true"] });
+  expect(readFileSync(runPaths(run.dir).state, "utf8")).toContain(
+    "Pinned: codex isolated: pinned false, now true (dispatch keeps the pinned values; run_pin re-pins)",
+  );
+  await repin(deps, { run: run.id });
+  expect(readFileSync(runPaths(run.dir).state, "utf8")).not.toContain("Pinned:");
+});
+
+it("reads the repo's profile for a run with no pin (before 1.5)", () => {
+  const { run } = freshRun();
+  const deps = fakeDeps();
+  expect(readPin(run)).toBeNull();
+  expect(runProfile(deps, run)).toBe(deps.view);
+  expect(pinChanges(deps, run)).toEqual([]);
+});
````

**Code (scratch `8b94454`):**

````diff
diff --git a/src/domain/state.ts b/src/domain/state.ts
index e261056..eef8364 100644
--- a/src/domain/state.ts
+++ b/src/domain/state.ts
@@ -16,6 +16,8 @@ export interface StateView {
   dirty: { path: string; owner: string | null }[];
   running: { name: string; rung: string; thread: string | null; since: string; brief: string }[];
   lastCheck: string | null;
+  /** spec 1.5 "Pinned per run": what changed since the pin; dispatch keeps the pinned values */
+  pinChanges?: string[];
   next: string;
   /** spec 1.1 §10: the protocol's next step, derived from the run's files; always the last line */
   protocol: string;
@@ -40,6 +42,9 @@ export function renderState(s: StateView): string {
       : ["- none"]),
     "",
     `Last check: ${s.lastCheck ?? "none"}`,
+    ...(s.pinChanges?.length
+      ? [`Pinned: ${s.pinChanges.join("; ")} (dispatch keeps the pinned values; run_pin re-pins)`]
+      : []),
     "",
     // 1.1: no tool waits; each running role's record arrives as a catherd message
     `Next: ${waiting.length ? `running ${waiting.join(", ")} (results arrive as catherd messages; peek to check); then ${s.next}` : s.next}`,
diff --git a/src/entry/mcp/run-tools.ts b/src/entry/mcp/run-tools.ts
index 521eef7..71ef2e6 100644
--- a/src/entry/mcp/run-tools.ts
+++ b/src/entry/mcp/run-tools.ts
@@ -15,6 +15,7 @@ import {
   startRun,
   writeRunFile,
 } from "../../services/run-service.ts";
+import { repin } from "../../services/run-pin.ts";
 import { runsSummary, status } from "../../services/summary.ts";
 import { handle } from "./result.ts";
 
@@ -34,6 +35,16 @@ export function registerRunTools(server: McpServer, deps: Deps): void {
     (a) => handle(() => startRun(deps, { repo: a.repo, title: a.title, aLines: a.a_lines, from: a.from })),
   );
 
+  server.registerTool(
+    "run_pin",
+    {
+      description:
+        "Re-pin a run to what its repo runs on now: the profile, each role's access and each backend's isolation. run_start pins them; while they differ, dispatch keeps the pinned values and status and state.md say what changed. Only on the owner's word. Returns the new pin and what it changed. Orchestrator only.",
+      inputSchema: { run: z.string().regex(ID_PATTERN) },
+    },
+    (a) => handle(() => repin(deps, a)),
+  );
+
   server.registerTool(
     "write_run_file",
     {
diff --git a/src/entry/runs-command.ts b/src/entry/runs-command.ts
index 3e14b5d..9238f99 100644
--- a/src/entry/runs-command.ts
+++ b/src/entry/runs-command.ts
@@ -14,6 +14,7 @@ import { redact } from "../infra/log.ts";
 import { cancel } from "../services/dispatch-service.ts";
 import { registerSavedSecrets } from "../services/jev-service.ts";
 import { runDebug } from "../services/run-debug.ts";
+import { repin } from "../services/run-pin.ts";
 import { supersedeRun } from "../services/run-service.ts";
 import { findRun, listRuns, readRecords, type Run } from "../services/run-store.ts";
 import { groupRuns, type RunSession, type SessionGroup } from "../services/session-view.ts";
@@ -356,12 +357,26 @@ const supersede = defineCommand({
   },
 });
 
+const pin = defineCommand({
+  meta: {
+    name: "pin",
+    description: "Re-pin a run to the profile, access and isolation its repo runs on now",
+  },
+  args: { id: { type: "positional", required: true, description: "run id" }, ...json },
+  async run({ args }) {
+    const r = await repin(defaultDeps(), { run: args.id });
+    if (args.json) return printJson(r);
+    console.log(`${mark("ok")} ${args.id} pinned to ${r.pin.profile}`);
+    for (const c of r.changed) console.log(`  was: ${c}`);
+  },
+});
+
 /** Spec §8 `catherd runs list|show [--debug]|cancel`; a bare `catherd runs` lists them, as `status` needs no run. */
 export const runsCommand = defineCommand({
   meta: {
     name: "runs",
-    description: "Runs: list them (the default), show one, cancel a live role, supersede one",
+    description: "Runs: list them (the default), show one, cancel a live role, supersede or re-pin one",
   },
-  subCommands: { list, show, cancel: cancelCmd, "retry-push": retryPush, supersede },
+  subCommands: { list, show, cancel: cancelCmd, "retry-push": retryPush, supersede, pin },
   default: "list",
 });
diff --git a/src/services/admission.ts b/src/services/admission.ts
index 27618e0..965fa29 100644
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -33,6 +33,7 @@ import {
 import { finalizeDispatch } from "./finalize.ts";
 import { assertNotPaused } from "./pause.ts";
 import { unfinishedAfter } from "./protocol.ts";
+import { runProfile } from "./run-pin.ts";
 import type { Deps } from "./ports.ts";
 import { readRecords, recordsOnThread, type Run, runPaths, supersededBy } from "./run-store.ts";
 import { currentSession } from "./sessions.ts";
@@ -148,7 +149,8 @@ export async function admit(
       fix: `dispatch in run ${closed.by}`,
     });
   const rung = parseRung(i.rung);
-  const profile = deps.profiles.forRepo(run.meta.repo);
+  // spec 1.5: the run's pinned profile, access and isolation, whatever the repo runs on now
+  const profile = runProfile(deps, run);
   const rc = profile.roles[i.role];
   if (!rc?.enabled)
     throw new CatherdError("E_ADMIT_RUNG", `the ${i.role} role is off in profile ${profile.name}`, {
diff --git a/src/services/dispatch-service.ts b/src/services/dispatch-service.ts
index d30aec0..fb7b2e1 100644
--- a/src/services/dispatch-service.ts
+++ b/src/services/dispatch-service.ts
@@ -36,6 +36,7 @@ import type { Deps } from "./ports.ts";
 import { route } from "./lane-service.ts";
 import { findRun, readRecords, readRoutes, type Run } from "./run-store.ts";
 import { claimRun, ownsRun, runOwner } from "./sessions.ts";
+import { pinChanges, runProfile } from "./run-pin.ts";
 import { type NotesPatch, refreshState } from "./state.ts";
 
 export interface DispatchInput {
@@ -324,7 +325,13 @@ export async function dispatch(deps: Deps, i: DispatchInput): Promise<DispatchSt
     // a launch that failed is still watched: its record (lost, after the start grace) is announced
     watch(deps, run, d);
   }
-  await refresh(run, i.next ? { next: i.next } : {}, hints);
+  // spec 1.5: a change since the run's pin is logged in state.md each time a role starts
+  const changes = pinChanges(deps, run);
+  if (changes.length)
+    hints.push(
+      `dispatched on the run's pinned values: ${changes.join("; ")}; run_pin(run) re-pins to the repo's now`,
+    );
+  await refresh(run, { ...(i.next ? { next: i.next } : {}), pinChanges: changes }, hints);
   return { dispatched: dispatchedOf(d), hints };
 }
 
@@ -498,7 +505,7 @@ async function failover(deps: Deps, run: Run, d: Dispatch, limited: RunRecord):
     return failedOver(already.admit.rung, already);
   }
   // else that stand-in never ran and is over (recorded as lost, or past its start grace): admit a new one
-  const standIn = standInFor(deps.profiles.forRepo(run.meta.repo).failover, limited.rung, run.meta.repo);
+  const standIn = standInFor(runProfile(deps, run).failover, limited.rung, run.meta.repo);
   if (!standIn) return { hints, started: null, pause: paused };
   // the stand-in answers to whoever owns the run now, which a claim from another host may have changed
   assertNativeHost(standIn, runOwner(run)?.host ?? deps.host.host);
diff --git a/src/services/lane-service.ts b/src/services/lane-service.ts
index 6ab41bb..93cc96f 100644
--- a/src/services/lane-service.ts
+++ b/src/services/lane-service.ts
@@ -52,6 +52,7 @@ import {
 } from "./run-store.ts";
 import { writeDigest } from "./protocol.ts";
 import { openQuestions } from "./questions.ts";
+import { runProfile } from "./run-pin.ts";
 import { type Notes, type NotesPatch, patchNotes, refreshState } from "./state.ts";
 
 const withHints = (hints: string[]) => (hints.length ? { hints } : {});
@@ -97,7 +98,7 @@ export async function route(
 ): Promise<RouteResult> {
   const run = findRun(i.run);
   const lane = i.laneFile === undefined ? null : readLaneFile(run, i.laneFile);
-  const profile = deps.profiles.forRepo(run.meta.repo);
+  const profile = runProfile(deps, run);
   const a = await deps.routing.route({
     host: deps.host.host,
     runDir: run.dir,
diff --git a/src/services/run-pin.ts b/src/services/run-pin.ts
new file mode 100644
index 0000000..05be28b
--- /dev/null
+++ b/src/services/run-pin.ts
@@ -0,0 +1,125 @@
+import { existsSync } from "node:fs";
+import { join } from "node:path";
+import { z } from "zod";
+import { errorMessage } from "../domain/errors.ts";
+import { ACCESS } from "../domain/record.ts";
+import { ROLES } from "../domain/roles.ts";
+import { readVersioned, writeJsonAtomic } from "../infra/store.ts";
+import type { Deps, ProfileView } from "./ports.ts";
+import { findRun, type Run } from "./run-store.ts";
+import { refreshState } from "./state.ts";
+
+// Spec 1.5 "Pinned per run": run_start records the profile the run started on, each role's access and each
+// backend's isolation. A later change (another active profile, a toggled isolation, a version that changed a
+// default) is logged in state.md and status, and dispatch keeps the pinned values until the owner re-pins.
+
+const PinSchema = z.looseObject({
+  schema: z.literal(1),
+  at: z.string(),
+  profile: z.string(),
+  access: z.partialRecord(z.enum(ROLES), z.enum(ACCESS)),
+  isolated: z.record(z.string(), z.boolean()),
+});
+export type Pin = z.infer<typeof PinSchema>;
+
+export const pinFile = (run: Run): string => join(run.dir, "pin.json");
+
+/** The run's pin, or null: a run from before 1.5, or a pin that cannot be read (the profile then rules). */
+export function readPin(run: Run): Pin | null {
+  if (!existsSync(pinFile(run))) return null;
+  try {
+    return readVersioned(pinFile(run), PinSchema, 1);
+  } catch {
+    return null;
+  }
+}
+
+const pinOf = (view: ProfileView, at: string): Pin => ({
+  schema: 1,
+  at,
+  profile: view.name,
+  access: Object.fromEntries(
+    Object.entries(view.roles).flatMap(([role, rc]) => (rc ? [[role, rc.access]] : [])),
+  ),
+  isolated: Object.fromEntries(Object.entries(view.isolated).map(([k, v]) => [k, v === true])),
+});
+
+/** Records what the run runs on now: the profile its repo runs on, each role's access, each backend's isolation. */
+export function writePin(deps: Deps, run: Run): Pin {
+  const pin = pinOf(deps.profiles.forRepo(run.meta.repo), new Date(deps.now()).toISOString());
+  writeJsonAtomic(pinFile(run), pin);
+  return pin;
+}
+
+/** The pinned profile's view, or null with why when it can no longer be read (deleted, invalid). */
+function pinnedView(deps: Deps, run: Run, pin: Pin): { view: ProfileView | null; why: string | null } {
+  const current = deps.profiles.forRepo(run.meta.repo);
+  if (current.name === pin.profile) return { view: current, why: null };
+  try {
+    return { view: deps.profiles.get(pin.profile, run.meta.repo).profile, why: null };
+  } catch (e) {
+    return { view: null, why: errorMessage(e) };
+  }
+}
+
+/**
+ * The profile a run's dispatch, routing and failover read: its pinned profile, with its pinned access and
+ * isolation laid over it. A run with no pin, or whose pinned profile is gone, reads its repo's profile.
+ */
+export function runProfile(deps: Deps, run: Run): ProfileView {
+  const pin = readPin(run);
+  if (!pin) return deps.profiles.forRepo(run.meta.repo);
+  const view = pinnedView(deps, run, pin).view ?? deps.profiles.forRepo(run.meta.repo);
+  const roles: ProfileView["roles"] = {};
+  for (const [role, rc] of Object.entries(view.roles) as [
+    keyof ProfileView["roles"],
+    NonNullable<ProfileView["roles"][keyof ProfileView["roles"]]>,
+  ][])
+    roles[role] = { ...rc, access: pin.access[role] ?? rc.access };
+  // a backend the pin does not name ran with no isolation when the run started
+  const backends = new Set([...Object.keys(view.isolated), ...Object.keys(pin.isolated)]);
+  const isolated = Object.fromEntries([...backends].map((k) => [k, pin.isolated[k] === true]));
+  return { ...view, roles, isolated };
+}
+
+/** What changed since the pin, one line each, in words; none while the run's repo still runs as pinned. */
+export function pinChanges(deps: Deps, run: Run): string[] {
+  const pin = readPin(run);
+  if (!pin) return [];
+  let now: ProfileView;
+  try {
+    now = deps.profiles.forRepo(run.meta.repo);
+  } catch {
+    // a profile that cannot be read is doctor's and profile validate's to report, not a pin change
+    return [];
+  }
+  const out: string[] = [];
+  if (now.name !== pin.profile) {
+    const { why } = pinnedView(deps, run, pin);
+    out.push(
+      `profile: pinned ${pin.profile}, the repo now runs on ${now.name}${why ? ` (${pin.profile} cannot be read: ${why}; dispatch reads ${now.name})` : ""}`,
+    );
+  }
+  for (const [role, access] of Object.entries(pin.access)) {
+    const was = now.roles[role as keyof ProfileView["roles"]]?.access;
+    if (was !== undefined && was !== access) out.push(`${role} access: pinned ${access}, now ${was}`);
+  }
+  for (const backend of new Set([...Object.keys(pin.isolated), ...Object.keys(now.isolated)])) {
+    const isolated = pin.isolated[backend] === true;
+    const was = now.isolated[backend] === true;
+    if (was !== isolated) out.push(`${backend} isolated: pinned ${isolated}, now ${was}`);
+  }
+  return out;
+}
+
+/** `run_pin`: the owner re-pins the run to what its repo runs on now. Returns the new pin and what it changed. */
+export async function repin(
+  deps: Deps,
+  i: { run: string },
+): Promise<{ pin: Pin; changed: string[]; hints?: string[] }> {
+  const run = findRun(i.run);
+  const changed = pinChanges(deps, run);
+  const pin = writePin(deps, run);
+  const { hints } = await refreshState(run, { pinChanges: [] });
+  return { pin, changed, ...(hints.length ? { hints } : {}) };
+}
diff --git a/src/services/run-service.ts b/src/services/run-service.ts
index a85ddff..26607bb 100644
--- a/src/services/run-service.ts
+++ b/src/services/run-service.ts
@@ -31,6 +31,7 @@ import {
   supersededFile,
 } from "./run-store.ts";
 import { protocolView } from "./protocol.ts";
+import { writePin } from "./run-pin.ts";
 import { claimRun, currentSession } from "./sessions.ts";
 import { refreshState } from "./state.ts";
 
@@ -94,6 +95,8 @@ export async function startRun(
     now: new Date(deps.now()),
     startedBy: currentSession(deps),
   });
+  // spec 1.5 "Pinned per run": what the run starts on stays what it dispatches on
+  writePin(deps, run);
   await claimRun(deps, run);
   const superseded = from ? await supersedeRun(deps, { run: from.id, by: run.id }) : null;
   // a failed state.md refresh never fails the start: the run exists and is usable, so a retry would orphan it
diff --git a/src/services/state.ts b/src/services/state.ts
index a340d70..f99ba2a 100644
--- a/src/services/state.ts
+++ b/src/services/state.ts
@@ -19,6 +19,8 @@ const NotesSchema = z.looseObject({
   lastLandedAt: z.string().nullable(),
   /** spec 1.1 §8: the milestones waiting on the owner */
   parked: z.array(z.string()).optional(),
+  /** spec 1.5: what changed since the run's pin, as dispatch last saw it */
+  pinChanges: z.array(z.string()).optional(),
 });
 export type Notes = z.infer<typeof NotesSchema>;
 export type NotesPatch = Partial<Omit<Notes, "schema">>;
@@ -68,6 +70,7 @@ export function updateState(run: Run, change: NotesPatch | ((n: Notes) => NotesP
         brief: relative(run.dir, dispatchPaths(d.dir).brief),
       })),
       lastCheck: next.lastCheck,
+      pinChanges: next.pinChanges ?? [],
       next: next.next,
       protocol: protocolNext(run, next.parked ?? []),
     });
diff --git a/src/services/summary.ts b/src/services/summary.ts
index 3f44dca..c9d00a1 100644
--- a/src/services/summary.ts
+++ b/src/services/summary.ts
@@ -10,6 +10,7 @@ import { nonBlankLines, readJsonl } from "../infra/store.ts";
 import { spendOf } from "./budget.ts";
 import { latestVerifierStep, type VerifierStep } from "./gate-service.ts";
 import { type Pause, pausesOver } from "./pause.ts";
+import { pinChanges } from "./run-pin.ts";
 import { type OpenQuestion, openQuestions } from "./questions.ts";
 import { type DispatchState, listDispatches, liveDispatches } from "./dispatches.ts";
 import { type RunSession, sessionFacts } from "./session-view.ts";
@@ -33,6 +34,8 @@ export interface RunSummary {
   id: string;
   /** spec 1.5 "runs supersede": the run that took this one over; status() without a run hides it */
   supersededBy?: string | null;
+  /** spec 1.5: what changed since the run's pin; dispatch keeps the pinned values */
+  pinChanges?: string[];
   /** spec 1.1 §8: the owner questions not answered yet, listed first */
   questions: OpenQuestion[];
   title: string;
@@ -68,6 +71,9 @@ export function summarizeRun(deps: Deps, run: Run): RunSummary {
   const sum = (f: (t: Tokens) => number) => records.reduce((n, r) => n + f(r.tokens), 0);
   let budget: BudgetStatus | null = null;
   const warnings = corrupt ? [`runs.jsonl: skipped ${corrupt} unreadable row(s)`] : [];
+  // spec 1.5 "Pinned per run": a change since the pin, which dispatch does not follow
+  const pinned = pinChanges(deps, run);
+  for (const c of pinned) warnings.push(`pinned: ${c}; dispatch keeps the pinned value (run_pin re-pins)`);
   try {
     budget = budgetStatus(
       spendOf(run, records, live, now),
@@ -87,6 +93,7 @@ export function summarizeRun(deps: Deps, run: Run): RunSummary {
     ),
     id: run.id,
     supersededBy: supersededBy(run)?.by ?? null,
+    pinChanges: pinned,
     questions: openQuestions(run),
     title: run.meta.title,
     repo: run.meta.repo,
diff --git a/src/services/workspace-service.ts b/src/services/workspace-service.ts
index c61f511..3c5837f 100644
--- a/src/services/workspace-service.ts
+++ b/src/services/workspace-service.ts
@@ -10,6 +10,7 @@ import { readVersioned, writeTextAtomic } from "../infra/store.ts";
 import { listDispatches } from "./dispatches.ts";
 import { landedCommits, landedMilestones } from "./milestones.ts";
 import { assertNotPaused, pausesOver } from "./pause.ts";
+import { writePin } from "./run-pin.ts";
 import type { Deps } from "./ports.ts";
 import { createRun, readRecords, type Run } from "./run-store.ts";
 import { claimRun, currentSession } from "./sessions.ts";
@@ -191,6 +192,7 @@ async function childFor(
       startedBy: currentSession(deps),
       workspace: { id: workspace.id, step: step.id },
     });
+    writePin(deps, run);
   }
   const contract = existsSync(contractFile) ? join(run.dir, "workspace-contract.md") : null;
   if (contract && !existsSync(contract)) writeTextAtomic(contract, readFileSync(contractFile, "utf8"));
````

### Task 11: Count only `verifier-<M>`; leave parked and paused time out of the minutes

**Files:** `src/services/milestones.ts`, `src/services/lane-service.ts`, `src/domain/util.ts`, `src/services/questions.ts`, `src/services/pause.ts`, `src/entry/mcp/lane-tools.ts`, `test/services/ledger.test.ts` (new), `test/services/land-gate.test.ts`.

**Produces:** `verifierName(m)`, `Span`, `coveredMs(from, to, spans)`, `parkedSpans(run, milestone)`, `pauseSpans(run)`; `land`'s minutes leave them out. **Consumes:** Task 5's `pauseIntervals`.

- [ ] **Step 1: the failing tests.** Apply the test diff. Run `bun test test/services/ledger.test.ts test/services/land-gate.test.ts`.
- [ ] **Step 2: the code.** Apply the source diff; run it and `bun test test/services test/integration`.
- [ ] **Step 3: commit** `fix(land): count only verifier-<M> and leave parked and paused time out of the minutes` (scratch `9c23aad`).

**Tests (scratch `9c23aad`):**

````diff
diff --git a/test/services/land-gate.test.ts b/test/services/land-gate.test.ts
index 2a5c9c4..d8f6a82 100644
--- a/test/services/land-gate.test.ts
+++ b/test/services/land-gate.test.ts
@@ -113,7 +113,7 @@ describe("the land gate (spec 1.1 §6)", () => {
     const e = await refusal(land(fakeDeps(), landing(run.id, commitFiles(repo, ["src/a.ts"]))));
     expect(e.code).toBe("E_LAND_GATE");
     expect(e.message).toBe(
-      "land M1: missing a reviewer record (a dispatch named reviewer-M1, or record_agent_run with role reviewer and that name, status ok) and a verifier verdict (record_agent_run with role verifier and a name holding M1, status ok; a headless verifier's reply opening VERDICT: PASS), since its lanes started",
+      "land M1: missing a reviewer record (a dispatch named reviewer-M1, or record_agent_run with role reviewer and that name, status ok) and a verifier verdict (record_agent_run with role verifier named exactly verifier-M1, status ok; a headless verifier-M1's reply opening VERDICT: PASS), since its lanes started",
     );
     expect(e.fix).toContain('record_agent_run(name: "verifier-M1")');
   });
diff --git a/test/services/ledger.test.ts b/test/services/ledger.test.ts
new file mode 100644
index 0000000..c3fc803
--- /dev/null
+++ b/test/services/ledger.test.ts
@@ -0,0 +1,102 @@
+import { afterEach, expect, it } from "bun:test";
+import { execFileSync } from "node:child_process";
+import { readFileSync, writeFileSync } from "node:fs";
+import { coveredMs } from "../../src/domain/util.ts";
+import { land } from "../../src/services/lane-service.ts";
+import { pauseMachine, resumeMachine } from "../../src/services/pause.ts";
+import { answer, park } from "../../src/services/questions.ts";
+import { appendAgentRun, createRun, runPaths } from "../../src/services/run-store.ts";
+import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
+import { fakeDeps, passGate } from "./helpers.ts";
+
+afterEach(snapshotEnv());
+
+const T0 = Date.parse("2026-10-02T18:00:00.000Z");
+const min = (n: number) => T0 + n * 60_000;
+const at = (n: number) => new Date(min(n)).toISOString();
+
+function setup() {
+  withHome();
+  const repo = tempRepo();
+  const run = createRun({ repo, title: "ledger", aLines: ["A1"], version: "t", now: new Date(T0) });
+  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
+  const landing = { run: run.id, milestone: "M2", what: "w", commit, evidence: "ok", next: "M3" };
+  return { run, landing };
+}
+
+it("counts each paused minute once, open spans running to the end", () => {
+  expect(coveredMs(0, 100, [])).toBe(0);
+  expect(
+    coveredMs(0, 100, [
+      { from: 10, to: 30 },
+      { from: 20, to: 40 },
+      { from: 90, to: null },
+      { from: -50, to: 5 },
+    ]),
+  ).toBe(5 + 30 + 10);
+});
+
+it("lands only on a verifier named exactly verifier-<M>: verifier-M2-pre does not count", async () => {
+  const { run, landing } = setup();
+  await passGate(run, "M2", at(1));
+  // a later failed attempt under a looser name is not M2's verifier either way
+  for (const name of ["verifier-M2-pre", "verifier-M2-gate1"])
+    appendAgentRun(run, {
+      at: at(2),
+      name,
+      role: "verifier",
+      rung: "claude:claude-opus-5-5#low",
+      agent: null,
+      totalTokens: 1,
+      costUsd: null,
+      secs: 1,
+      status: "failed",
+      lane: null,
+    });
+  await expect(land(fakeDeps({ now: () => min(3) }), landing)).resolves.toHaveProperty("minutes", 3);
+});
+
+it("refuses a milestone whose only verifier verdicts carry a longer name", async () => {
+  const { run, landing } = setup();
+  await passGate(run, "M2", at(1));
+  // drop the exact row passGate wrote: keep only verifier-M2-gate3
+  const agents = runPaths(run.dir).agents;
+  writeFileSync(
+    agents,
+    readFileSync(agents, "utf8")
+      .split("\n")
+      .filter((l) => !l.includes('"verifier-M2"'))
+      .join("\n"),
+  );
+  appendAgentRun(run, {
+    at: at(2),
+    name: "verifier-M2-gate3",
+    role: "verifier",
+    rung: "claude:claude-opus-5-5#low",
+    agent: null,
+    totalTokens: 1,
+    costUsd: null,
+    secs: 1,
+    status: "ok",
+    lane: null,
+  });
+  await expect(land(fakeDeps({ now: () => min(3) }), landing)).rejects.toMatchObject({
+    code: "E_LAND_GATE",
+    message: expect.stringContaining("named exactly verifier-M2"),
+  });
+});
+
+it("leaves the parked night and a machine pause out of the ledger minutes", async () => {
+  const { run, landing } = setup();
+  let now = min(10);
+  const deps = fakeDeps({ now: () => now });
+  await park(deps, { run: run.id, milestone: "M2", question: "which bucket?" });
+  now = min(10 + 600); // ten hours parked overnight
+  await answer(deps, { run: run.id, milestone: "M2", answer: "the EU one" });
+  pauseMachine(min(620), "the VPN takes the default route");
+  resumeMachine(min(650));
+  await passGate(run, "M2", at(660));
+  now = min(670);
+  // 670 minutes since the run started, less 600 parked and 30 paused
+  expect((await land(deps, landing)).minutes).toBe(40);
+});
````

**Code (scratch `9c23aad`):**

````diff
diff --git a/src/domain/util.ts b/src/domain/util.ts
index 19be046..9ec0c5f 100644
--- a/src/domain/util.ts
+++ b/src/domain/util.ts
@@ -16,6 +16,28 @@ export function median(xs: readonly number[]): number | null {
   return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
 }
 
+/** A stretch of time in epoch ms; `to` null while it is still open. */
+export interface Span {
+  from: number;
+  to: number | null;
+}
+
+/** How many ms of [from, to] any of `spans` covers, overlaps counted once; an open span runs to `to`. */
+export function coveredMs(from: number, to: number, spans: readonly Span[]): number {
+  const clipped = spans
+    .map((s) => [Math.max(from, s.from), Math.min(to, s.to ?? to)] as const)
+    .filter(([a, b]) => b > a)
+    .sort((x, y) => x[0] - y[0]);
+  let total = 0;
+  let end = -Infinity;
+  for (const [a, b] of clipped) {
+    if (b <= end) continue;
+    total += b - Math.max(a, end);
+    end = b;
+  }
+  return total;
+}
+
 /** A plain object: not null and not an array. */
 export const isPlain = (v: unknown): v is Record<string, unknown> =>
   typeof v === "object" && v !== null && !Array.isArray(v);
diff --git a/src/entry/mcp/lane-tools.ts b/src/entry/mcp/lane-tools.ts
index 2eb4e52..64fbbfa 100644
--- a/src/entry/mcp/lane-tools.ts
+++ b/src/entry/mcp/lane-tools.ts
@@ -99,7 +99,7 @@ export function registerLaneTools(server: McpServer, deps: Deps): void {
     "land",
     {
       description:
-        "Record a landed milestone after you commit it: its five-column ledger row (with the minutes it took) and state.md's last check and next step, with any hints. learned, when given, goes to this repo's knowledge.md. Returns digest: the milestone's digest (R/digests/<milestone>.md: A-lines, commit, lanes with rungs and climbs, reviewer findings, the verifier's verdict with carried items, minutes and tokens), for the milestone push to link. Refused with E_LAND_GATE unless, since the milestone's lanes started, a reviewer named reviewer-<milestone> ended ok (a dispatch, or a Claude subagent recorded with record_agent_run, role reviewer) and a verifier verdict naming the milestone was recorded ok (record_agent_run, role verifier; a headless verifier's reply opening VERDICT: PASS). A skip over an empty commit range is refused: commit first. skip: docs-only lands a milestone whose commit range changed only docs; skip: no-code one that changed no source file (put the evidence, e.g. a green pipeline, in evidence).",
+        "Record a landed milestone after you commit it: its five-column ledger row (with the minutes it took) and state.md's last check and next step, with any hints. learned, when given, goes to this repo's knowledge.md. Returns digest: the milestone's digest (R/digests/<milestone>.md: A-lines, commit, lanes with rungs and climbs, reviewer findings, the verifier's verdict with carried items, minutes and tokens), for the milestone push to link. Refused with E_LAND_GATE unless, since the milestone's lanes started, a reviewer named reviewer-<milestone> ended ok (a dispatch, or a Claude subagent recorded with record_agent_run, role reviewer) and a verifier verdict was recorded ok under exactly verifier-<milestone> (record_agent_run, role verifier; a headless verifier's reply opening VERDICT: PASS; verifier-M1-pre does not count). minutes leave out the time the milestone was parked and any machine or workspace pause. A skip over an empty commit range is refused: commit first. skip: docs-only lands a milestone whose commit range changed only docs; skip: no-code one that changed no source file (put the evidence, e.g. a green pipeline, in evidence).",
       inputSchema: {
         run: z.string(),
         milestone: z.string().regex(ID_PATTERN),
diff --git a/src/services/lane-service.ts b/src/services/lane-service.ts
index 93cc96f..d8ec778 100644
--- a/src/services/lane-service.ts
+++ b/src/services/lane-service.ts
@@ -4,7 +4,7 @@ import { CatherdError } from "../domain/errors.ts";
 import { assertId, ID_PATTERN, parseRung } from "../domain/ids.ts";
 import { assertLaneHeader, type Difficulty, type Kind } from "../domain/lane.ts";
 import type { Role } from "../domain/roles.ts";
-import { cell } from "../domain/util.ts";
+import { cell, coveredMs } from "../domain/util.ts";
 import {
   type ClimbReason,
   currentRoute,
@@ -51,7 +51,8 @@ import {
   runPaths,
 } from "./run-store.ts";
 import { writeDigest } from "./protocol.ts";
-import { openQuestions } from "./questions.ts";
+import { pauseSpans } from "./pause.ts";
+import { openQuestions, parkedSpans } from "./questions.ts";
 import { runProfile } from "./run-pin.ts";
 import { type Notes, type NotesPatch, patchNotes, refreshState } from "./state.ts";
 
@@ -290,7 +291,7 @@ async function gate(run: Run, m: string, commit: string, skip: LandSkip | undefi
     ...(verdict?.passed
       ? []
       : [
-          `a verifier verdict (record_agent_run with role verifier and a name holding ${m}, status ok; a headless verifier's reply opening VERDICT: PASS)${verdict ? `: the latest, ${verdict.name}${verdict.headless ? " (headless)" : ""}, is ${verdict.verdict}` : ""}`,
+          `a verifier verdict (record_agent_run with role verifier named exactly verifier-${m}, status ok; a headless verifier-${m}'s reply opening VERDICT: PASS)${verdict ? `: the latest, ${verdict.name}${verdict.headless ? " (headless)" : ""}, is ${verdict.verdict}` : ""}`,
         ]),
   ];
   if (missing.length)
@@ -384,10 +385,14 @@ async function landRun(
   const now = new Date(deps.now());
   let row = "";
   let minutes = 0;
+  // spec 1.5 "The ledger": the minutes leave out the time the milestone was parked and any machine or
+  // workspace pause, so a night parked on a question does not count
+  const paused = [...parkedSpans(run, i.milestone), ...pauseSpans(run)];
   const landRow = (notes: Notes): NotesPatch => {
+    const from = Date.parse(notes.lastLandedAt ?? run.meta.createdAt);
     minutes = Math.max(
       0,
-      Math.round((now.getTime() - Date.parse(notes.lastLandedAt ?? run.meta.createdAt)) / 60_000),
+      Math.round((now.getTime() - from - coveredMs(from, now.getTime(), paused)) / 60_000),
     );
     row = [i.milestone, i.what, i.commit, String(minutes), i.evidence].map(cell).join(" | ");
     appendLedger(run, row);
diff --git a/src/services/milestones.ts b/src/services/milestones.ts
index 404e94b..7057e59 100644
--- a/src/services/milestones.ts
+++ b/src/services/milestones.ts
@@ -108,9 +108,13 @@ export interface MilestoneVerifier {
   verdict: string;
 }
 
+/** The one name a milestone's verifier is counted under (spec 1.5 "The ledger"): verifier-<m>, exactly. */
+export const verifierName = (m: string): string => `verifier-${m}`;
+
 /**
  * The milestone's latest verifier attempt since its lanes started, whatever it said: a record_agent_run row
- * with role verifier whose name names the milestone (the skill records a FAIL as failed), passing when its
+ * with role verifier named exactly verifier-<m> (the skill records a FAIL as failed; verifier-M2-pre or
+ * verifier-M2-gate1 is not M2's verifier), passing when its
  * status is ok; or a headless verifier's dispatch record of the same shape, passing when it exited ok and its
  * reply opens VERDICT: PASS (status ok means only the CLI exited). A later FAIL undoes an earlier PASS. Null
  * when there is none.
@@ -122,7 +126,7 @@ export function milestoneVerifier(
 ): MilestoneVerifier | null {
   const found: MilestoneVerifier[] = [
     ...readAgentRuns(run)
-      .filter((a) => a.role === "verifier" && namesMilestone(a.name, m) && since(a.at, start))
+      .filter((a) => a.role === "verifier" && a.name === verifierName(m) && since(a.at, start))
       .map((a) => ({
         name: a.name,
         at: a.at,
@@ -131,7 +135,7 @@ export function milestoneVerifier(
         verdict: a.status,
       })),
     ...readRecords(run)
-      .records.filter((r) => r.role === "verifier" && namesMilestone(r.name, m) && since(r.endedAt, start))
+      .records.filter((r) => r.role === "verifier" && r.name === verifierName(m) && since(r.endedAt, start))
       .map((r) => {
         const first = replyVerdict(run, r);
         const passed = r.status === "ok" && first !== null && VERDICT_PASS.test(first);
diff --git a/src/services/pause.ts b/src/services/pause.ts
index a6d63e2..381d5bb 100644
--- a/src/services/pause.ts
+++ b/src/services/pause.ts
@@ -1,5 +1,6 @@
 import { join } from "node:path";
 import { CatherdError } from "../domain/errors.ts";
+import type { Span } from "../domain/util.ts";
 import { dataDir } from "../infra/paths.ts";
 import { appendJsonl, ensureJsonlHeader, readJsonl } from "../infra/store.ts";
 /** What a pause is checked against: a run, or a workspace step about to start one. */
@@ -118,6 +119,15 @@ export function pausesFor(run: Covered | null): Pause[] {
   return out;
 }
 
+/** Every stretch the machine, or the run's workspace, was paused, in epoch ms: `land` leaves them out. */
+export function pauseSpans(run: Covered): Span[] {
+  const id = run.meta.workspace?.id;
+  const files = [machinePauseFile(), ...(id ? [workspacePauseFile(id)] : [])];
+  return files.flatMap((f) =>
+    pauseIntervals(f).map((p) => ({ from: Date.parse(p.from), to: p.to === null ? null : Date.parse(p.to) })),
+  );
+}
+
 /** The pauses in force over any of `runs`, each once, the machine's first. */
 export function pausesOver(runs: Covered[]): Pause[] {
   const seen = new Set<string>();
diff --git a/src/services/questions.ts b/src/services/questions.ts
index d0b0eba..bac7045 100644
--- a/src/services/questions.ts
+++ b/src/services/questions.ts
@@ -1,6 +1,7 @@
 import { join } from "node:path";
 import { CatherdError } from "../domain/errors.ts";
 import { assertId } from "../domain/ids.ts";
+import type { Span } from "../domain/util.ts";
 import { appendJsonl, ensureJsonlHeader, readJsonl } from "../infra/store.ts";
 import type { Deps } from "./ports.ts";
 import { findRun, type Run } from "./run-store.ts";
@@ -38,6 +39,20 @@ export function openQuestions(run: Run): OpenQuestion[] {
   return [...open.values()];
 }
 
+/** Spec 1.5 "The ledger": when `milestone` was parked, question to answer; the last one open while unanswered. */
+export function parkedSpans(run: Run, milestone: string): Span[] {
+  const out: Span[] = [];
+  for (const r of rows(run)) {
+    if (r.milestone !== milestone) continue;
+    const at = Date.parse(r.at);
+    if (Number.isNaN(at)) continue;
+    const open = out.at(-1);
+    if (r.kind === "question" && (!open || open.to !== null)) out.push({ from: at, to: null });
+    else if (r.kind === "answer" && open && open.to === null) open.to = at;
+  }
+  return out;
+}
+
 function append(run: Run, row: QuestionRow): void {
   const file = questionsFile(run);
   ensureJsonlHeader(file, "questions");
````

### Task 12: Key knowledge by the git origin; migrate worktree files on read

**Files:** `src/infra/git.ts`, `src/infra/paths.ts`, `src/services/run-store.ts`, `src/services/run-service.ts`, `src/services/lane-service.ts`, `test/services/knowledge-origin.test.ts` (new).

**Produces:** `gitOrigin(repo)`, `normalizeOrigin(url)`, `originDir(url)`, `knowledgeFor(toplevel): Promise<string>`; `appendKnowledge` is async (callers await it). `knowledgeFile(toplevel)` stays: the toplevel-keyed path, used with no origin.

- [ ] **Step 1: the failing tests.** Apply the test diff. Run `bun test test/services/knowledge-origin.test.ts`.
- [ ] **Step 2: the code.** Apply the source diff; run it and `bun test test/entry/knowledge-command.test.ts test/services/lanes-run.test.ts test/entry/role-mcp.test.ts`.
- [ ] **Step 3: commit** `feat(knowledge): key knowledge by the git origin and migrate worktree files on read` (scratch `6e5b8cf`).

**Tests (scratch `6e5b8cf`):**

````diff
diff --git a/test/services/knowledge-origin.test.ts b/test/services/knowledge-origin.test.ts
new file mode 100644
index 0000000..988cb30
--- /dev/null
+++ b/test/services/knowledge-origin.test.ts
@@ -0,0 +1,60 @@
+import { afterEach, expect, it } from "bun:test";
+import { execFileSync } from "node:child_process";
+import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
+import { join } from "node:path";
+import { normalizeOrigin, originDir } from "../../src/infra/paths.ts";
+import { addKnowledge, knowledgePath, readKnowledge } from "../../src/services/run-service.ts";
+import { knowledgeFile } from "../../src/services/run-store.ts";
+import { snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";
+
+afterEach(snapshotEnv());
+
+const ORIGIN = "git@github.com:Acme/platform.git";
+
+/** A repo with an origin, and a second worktree of it on another branch. */
+function worktrees(): { main: string; other: string } {
+  withHome();
+  const main = tempRepo();
+  const git = (...a: string[]) => execFileSync("git", a, { cwd: main, stdio: "ignore" });
+  git("remote", "add", "origin", ORIGIN);
+  const other = join(tempDir("catherd-wt-"), "auth-kit-cleanup");
+  git("worktree", "add", "-q", "-b", "auth", other);
+  return { main, other };
+}
+
+it("names one repository the same however it is cloned", () => {
+  for (const url of [
+    "git@github.com:Acme/platform.git",
+    "https://github.com/Acme/platform",
+    "https://user@GitHub.com/Acme/platform.git/",
+    "ssh://git@github.com:22/Acme/platform.git",
+  ])
+    expect(normalizeOrigin(url)).toBe("github.com/Acme/platform");
+});
+
+it("shares what one worktree learned with every other worktree of the repo", async () => {
+  const { main, other } = worktrees();
+  await addKnowledge(main, "the auth suite needs DOCKER_HOST", new Date("2026-10-02T00:00:00Z"));
+  expect(await readKnowledge(other)).toContain("the auth suite needs DOCKER_HOST");
+  expect((await knowledgePath(other)).path).toBe(join(originDir(ORIGIN), "knowledge.md"));
+});
+
+it("migrates a worktree's toplevel-keyed knowledge on read, once", async () => {
+  const { main, other } = worktrees();
+  await addKnowledge(main, "shared line", new Date("2026-10-01T00:00:00Z"));
+  // written by 1.4 under the worktree's own toplevel key
+  const legacy = knowledgeFile(
+    execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: other, encoding: "utf8" }).trim(),
+  );
+  mkdirSync(join(legacy, ".."), { recursive: true });
+  writeFileSync(legacy, "- 2026-09-30 M1: kept from M1\n- 2026-10-01 by hand: shared line\n");
+  const text = await readKnowledge(other);
+  expect(text.split("\n").filter(Boolean)).toEqual([
+    "- 2026-10-01 by hand: shared line",
+    "- 2026-09-30 M1: kept from M1",
+  ]);
+  expect(existsSync(legacy)).toBe(false);
+  expect(existsSync(`${legacy}.migrated`)).toBe(true);
+  expect(await readKnowledge(main)).toBe(text);
+  expect(readFileSync(join(originDir(ORIGIN), "knowledge.md"), "utf8")).toBe(text);
+});
````

**Code (scratch `6e5b8cf`):**

````diff
diff --git a/src/infra/git.ts b/src/infra/git.ts
index 8edaccf..69b7547 100644
--- a/src/infra/git.ts
+++ b/src/infra/git.ts
@@ -54,6 +54,12 @@ export async function gitToplevel(dir: string): Promise<string | null> {
   return r.kind === "ok" ? r.out.trim() || null : null;
 }
 
+/** The repo's `origin` remote URL, or null when it has none (or git cannot say). */
+export async function gitOrigin(repo: string): Promise<string | null> {
+  const r = await git(repo, ["config", "--get", "remote.origin.url"]);
+  return (r.kind === "ok" && r.out.trim()) || null;
+}
+
 /** The short HEAD, or null when git cannot say (no commit, not a repo, failure, timeout). */
 export async function gitHead(repo: string, timeoutMs?: number): Promise<string | null> {
   const r = await git(repo, ["rev-parse", "--short", "HEAD"], timeoutMs);
diff --git a/src/infra/paths.ts b/src/infra/paths.ts
index a3a7310..97fe7be 100644
--- a/src/infra/paths.ts
+++ b/src/infra/paths.ts
@@ -34,6 +34,27 @@ export function repoKey(toplevel: string): string {
 }
 
 export const repoDir = (toplevel: string): string => join(dataDir(), "repos", repoKey(toplevel));
+
+/**
+ * One repository however it is cloned or checked out (spec 1.5 "Knowledge keyed by git origin"):
+ * `git@github.com:a/b.git`, `https://user@github.com/a/b` and `ssh://git@github.com/a/b.git/` are all
+ * `github.com/a/b`. The host is lower-cased; the path keeps its case.
+ */
+export function normalizeOrigin(url: string): string {
+  let s = url
+    .trim()
+    .replace(/\/+$/, "")
+    .replace(/\.git$/, "");
+  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(s);
+  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `${scp[1]}/${scp[2]}`;
+  else s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]+@/, "");
+  const [host = "", ...path] = s.split("/");
+  return [host.toLowerCase().replace(/:\d+$/, ""), ...path].join("/");
+}
+
+/** Where what runs of one repository learned lives, keyed by its origin, whatever worktree it runs in. */
+export const originDir = (url: string): string =>
+  join(dataDir(), "repos", `origin-${repoKey(normalizeOrigin(url))}`);
 export const runsDir = (toplevel: string): string => join(repoDir(toplevel), "runs");
 export const logsDir = (): string => join(dataDir(), "logs");
 export const discoveryDir = (): string => join(dataDir(), "discovery");
diff --git a/src/services/lane-service.ts b/src/services/lane-service.ts
index d8ec778..d321fca 100644
--- a/src/services/lane-service.ts
+++ b/src/services/lane-service.ts
@@ -420,7 +420,7 @@ async function landRun(
     hints.push(
       `land: no routed lane is in milestone "${i.milestone}" (routed: ${routed.slice(0, 5).join(", ")}${routed.length > 5 ? ", …" : ""}); check its name: no lane outcome was recorded`,
     );
-  if (i.learned) appendKnowledge(run.meta.repo, now, `${run.meta.title} ${i.milestone}`, i.learned);
+  if (i.learned) await appendKnowledge(run.meta.repo, now, `${run.meta.title} ${i.milestone}`, i.learned);
   // spec 1.1 §10: the milestone's digest, which the milestone push links
   const digest = writeDigest(run, {
     milestone: i.milestone,
diff --git a/src/services/run-service.ts b/src/services/run-service.ts
index 26607bb..8c6158e 100644
--- a/src/services/run-service.ts
+++ b/src/services/run-service.ts
@@ -24,7 +24,7 @@ import {
   appendKnowledge,
   createRun,
   findRun,
-  knowledgeFile,
+  knowledgeFor,
   readRecords,
   runFile,
   supersededBy,
@@ -248,7 +248,7 @@ async function repoTop(repo: string): Promise<string> {
 
 /** What past runs of the repo learned; `repo` may be any path inside it. */
 export async function readKnowledge(repo: string): Promise<string> {
-  const file = knowledgeFile(await repoTop(repo));
+  const file = await knowledgeFor(await repoTop(repo));
   const text = existsSync(file) ? readFileSync(file, "utf8") : "";
   return text.trim() ? text : "catherd: no knowledge recorded yet for this repo";
 }
@@ -256,7 +256,7 @@ export async function readKnowledge(repo: string): Promise<string> {
 /** Where the repo's knowledge.md is (it may not exist yet); `repo` may be any path inside it. */
 export async function knowledgePath(repo: string): Promise<{ repo: string; path: string }> {
   const top = await repoTop(repo);
-  return { repo: top, path: knowledgeFile(top) };
+  return { repo: top, path: await knowledgeFor(top) };
 }
 
 /** The repo's knowledge.md as its lines, none when it is missing or blank; `repo` may be any path inside it. */
diff --git a/src/services/run-store.ts b/src/services/run-store.ts
index 8aa31ef..f8641fc 100644
--- a/src/services/run-store.ts
+++ b/src/services/run-store.ts
@@ -1,4 +1,4 @@
-import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
+import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync } from "node:fs";
 import { dirname, join, relative, resolve, sep } from "node:path";
 import { z } from "zod";
 import { CatherdError } from "../domain/errors.ts";
@@ -7,13 +7,15 @@ import { type RunRecord, RunRecordSchema } from "../domain/record.ts";
 import type { OutcomeRow, RouteRow } from "../domain/route.ts";
 import { cell, slug } from "../domain/util.ts";
 import { withFileLock } from "../infra/filelock.ts";
-import { dataDir, repoDir, runsDir } from "../infra/paths.ts";
+import { gitOrigin } from "../infra/git.ts";
+import { dataDir, originDir, repoDir, runsDir } from "../infra/paths.ts";
 import {
   appendJsonl,
   ensureJsonlHeader,
   ensurePrivateDir,
   PRIVATE_DIR,
   appendPrivate,
+  nonBlankLines,
   readJsonl,
   readVersioned,
   writeJsonAtomic,
@@ -291,16 +293,43 @@ export function appendLedger(run: Run, row: string): void {
   appendPrivate(runPaths(run.dir).ledger, `${row}\n`);
 }
 
-/** Spec §4.7: what past runs of a repo learned, keyed by its git toplevel. */
+/** Spec §4.7: what past runs of a repo learned, keyed by its git toplevel (before 1.5, and with no origin). */
 export const knowledgeFile = (toplevel: string): string => join(repoDir(toplevel), "knowledge.md");
 
+/**
+ * Spec 1.5 "Knowledge keyed by git origin": the knowledge.md every worktree and clone of one repository
+ * shares, keyed by its `origin` remote, else by its toplevel. A toplevel-keyed file this worktree left before
+ * is migrated on read: its lines not there yet are appended, and it is renamed `knowledge.md.migrated`.
+ */
+export async function knowledgeFor(toplevel: string): Promise<string> {
+  const origin = await gitOrigin(toplevel);
+  const legacy = knowledgeFile(toplevel);
+  if (!origin) return legacy;
+  const file = join(originDir(origin), "knowledge.md");
+  if (!existsSync(legacy)) return file;
+  ensurePrivateDir(dirname(file));
+  await withFileLock(file, () => {
+    if (!existsSync(legacy)) return;
+    const have = new Set(existsSync(file) ? nonBlankLines(file) : []);
+    const add = nonBlankLines(legacy).filter((l) => !have.has(l));
+    if (add.length) appendPrivate(file, `${add.join("\n")}\n`);
+    renameSync(legacy, `${legacy}.migrated`);
+  });
+  return file;
+}
+
 /**
  * Appends one line to the repo's knowledge.md, `- <date> <source>: <text>` with `text` on one line, and returns
  * it. The single writer of knowledge.md: `land`'s `learned` and `catherd knowledge add` both come through here.
  */
-export function appendKnowledge(toplevel: string, at: Date, source: string, text: string): string {
+export async function appendKnowledge(
+  toplevel: string,
+  at: Date,
+  source: string,
+  text: string,
+): Promise<string> {
   const line = `- ${at.toISOString().slice(0, 10)} ${source}: ${cell(text)}`;
-  appendPrivate(knowledgeFile(toplevel), `${line}\n`);
+  appendPrivate(await knowledgeFor(toplevel), `${line}\n`);
   return line;
 }
````

### Task 13: The digest lists the commits, the review's findings and what is open

**Files:** `src/services/protocol.ts`, `src/services/milestones.ts`, `src/services/lane-service.ts`, `src/entry/mcp/lane-tools.ts`, `test/services/protocol.test.ts`, `test/services/lanes-run.test.ts`.

**Produces:** `milestoneCommits(run, commit)`; `writeDigest` takes `commits` and `pausedMinutes` and writes `Commits:`, `Findings:`, `Open:`; `land` returns `digestPath`. **Consumes:** Task 11's paused minutes.

- [ ] **Step 1: the failing tests.** Apply the test diff. Run `bun test test/services/protocol.test.ts test/services/lanes-run.test.ts`.
- [ ] **Step 2: the code.** Apply the source diff; run it and `bun test test/services/land-gate.test.ts test/services/ledger.test.ts test/entry/mcp.test.ts test/skills.test.ts`.
- [ ] **Step 3: commit** `feat(land): the digest lists the commits, the review's findings and what is open` (scratch `77b3517`).

**Tests (scratch `77b3517`):**

````diff
diff --git a/test/services/lanes-run.test.ts b/test/services/lanes-run.test.ts
index a4bee42..20c0109 100644
--- a/test/services/lanes-run.test.ts
+++ b/test/services/lanes-run.test.ts
@@ -169,6 +169,7 @@ describe("land", () => {
       ledger: `M1 | login / form | ${c1} | 12 | bun test/12/12`,
       minutes: 12,
       digest: "digests/M1.md",
+      digestPath: join(run.dir, "digests", "M1.md"),
     });
     now += 5 * 60_000;
     const second = await land(deps, {
@@ -239,6 +240,7 @@ describe("a failed state.md refresh", () => {
       ledger: `M1 | x | ${c1} | 3 | ok`,
       minutes: 3,
       digest: "digests/M1.md",
+      digestPath: join(run.dir, "digests", "M1.md"),
       hints: [hint],
     });
     expect(readFileSync(runPaths(run.dir).state, "utf8")).toBe(state);
diff --git a/test/services/protocol.test.ts b/test/services/protocol.test.ts
index 7bf5e13..c4314a0 100644
--- a/test/services/protocol.test.ts
+++ b/test/services/protocol.test.ts
@@ -247,6 +247,11 @@ describe("the milestone digest (spec 1.1 §10)", () => {
       "- M1.L1 · codex:gpt-6-luna#high → codex:gpt-6-sol#medium · climbs: check-failed-twice",
     );
     expect(text).toContain("Reviewer: reviewer-M1 · 2 finding(s): 0 BLOCKER, 1 BUG, 1 NIT");
+    // spec 1.5: the commits, the review's BLOCKER and BUG lines, and what is still open
+    expect(text).toContain(`Commits: ${head(repo)} init`);
+    expect(text).toContain("Findings: BUG src/a.ts:3 — x — y");
+    expect(text).toContain("Open: none");
+    expect(landed.digestPath).toBe(join(r.dir, "digests", "M1.md"));
     expect(text.find((l) => l.startsWith("Verifier: "))).toMatch(
       /^Verifier: PASS \(verifier-M1\) · carried: unit tests from [0-9a-f]+$/,
     );
````

**Code (scratch `77b3517`):**

````diff
diff --git a/src/entry/mcp/lane-tools.ts b/src/entry/mcp/lane-tools.ts
index 64fbbfa..b0eb292 100644
--- a/src/entry/mcp/lane-tools.ts
+++ b/src/entry/mcp/lane-tools.ts
@@ -99,7 +99,7 @@ export function registerLaneTools(server: McpServer, deps: Deps): void {
     "land",
     {
       description:
-        "Record a landed milestone after you commit it: its five-column ledger row (with the minutes it took) and state.md's last check and next step, with any hints. learned, when given, goes to this repo's knowledge.md. Returns digest: the milestone's digest (R/digests/<milestone>.md: A-lines, commit, lanes with rungs and climbs, reviewer findings, the verifier's verdict with carried items, minutes and tokens), for the milestone push to link. Refused with E_LAND_GATE unless, since the milestone's lanes started, a reviewer named reviewer-<milestone> ended ok (a dispatch, or a Claude subagent recorded with record_agent_run, role reviewer) and a verifier verdict was recorded ok under exactly verifier-<milestone> (record_agent_run, role verifier; a headless verifier's reply opening VERDICT: PASS; verifier-M1-pre does not count). minutes leave out the time the milestone was parked and any machine or workspace pause. A skip over an empty commit range is refused: commit first. skip: docs-only lands a milestone whose commit range changed only docs; skip: no-code one that changed no source file (put the evidence, e.g. a green pipeline, in evidence).",
+        "Record a landed milestone after you commit it: its five-column ledger row (with the minutes it took) and state.md's last check and next step, with any hints. learned, when given, goes to this repo's knowledge.md. Returns digest: the milestone's digest (R/digests/<milestone>.md: A-lines, the commits, lanes with rungs and climbs, the reviewer's BLOCKER and BUG lines, the owner questions still open, the verifier's verdict with carried items, minutes and tokens), and digestPath, its full path, for the milestone push to link. Refused with E_LAND_GATE unless, since the milestone's lanes started, a reviewer named reviewer-<milestone> ended ok (a dispatch, or a Claude subagent recorded with record_agent_run, role reviewer) and a verifier verdict was recorded ok under exactly verifier-<milestone> (record_agent_run, role verifier; a headless verifier's reply opening VERDICT: PASS; verifier-M1-pre does not count). minutes leave out the time the milestone was parked and any machine or workspace pause. A skip over an empty commit range is refused: commit first. skip: docs-only lands a milestone whose commit range changed only docs; skip: no-code one that changed no source file (put the evidence, e.g. a green pipeline, in evidence).",
       inputSchema: {
         run: z.string(),
         milestone: z.string().regex(ID_PATTERN),
diff --git a/src/services/lane-service.ts b/src/services/lane-service.ts
index d321fca..9ccfc05 100644
--- a/src/services/lane-service.ts
+++ b/src/services/lane-service.ts
@@ -1,5 +1,5 @@
 import { existsSync, readFileSync } from "node:fs";
-import { relative, sep } from "node:path";
+import { join, relative, sep } from "node:path";
 import { CatherdError } from "../domain/errors.ts";
 import { assertId, ID_PATTERN, parseRung } from "../domain/ids.ts";
 import { assertLaneHeader, type Difficulty, type Kind } from "../domain/lane.ts";
@@ -34,6 +34,7 @@ import {
   milestoneFiles,
   milestoneStart,
   reviewerPassed,
+  milestoneCommits,
   milestoneVerifier,
 } from "./milestones.ts";
 import type { Deps, Verdict } from "./ports.ts";
@@ -319,7 +320,7 @@ type LandInput = {
   skip?: LandSkip;
 };
 
-type LandResult = { ledger: string; minutes: number; digest: string; hints?: string[] };
+type LandResult = { ledger: string; minutes: number; digest: string; digestPath: string; hints?: string[] };
 
 export async function land(deps: Deps, i: LandInput): Promise<LandResult> {
   const run = findRun(i.run);
@@ -382,18 +383,20 @@ async function landRun(
       fix: "commit the milestone first, then pass its hash",
     });
   await gate(run, i.milestone, i.commit, i.skip);
+  // read before the ledger row: the range runs from the previous landing to this commit
+  const commits = await milestoneCommits(run, i.commit);
   const now = new Date(deps.now());
   let row = "";
   let minutes = 0;
+  let pausedMinutes = 0;
   // spec 1.5 "The ledger": the minutes leave out the time the milestone was parked and any machine or
   // workspace pause, so a night parked on a question does not count
   const paused = [...parkedSpans(run, i.milestone), ...pauseSpans(run)];
   const landRow = (notes: Notes): NotesPatch => {
     const from = Date.parse(notes.lastLandedAt ?? run.meta.createdAt);
-    minutes = Math.max(
-      0,
-      Math.round((now.getTime() - from - coveredMs(from, now.getTime(), paused)) / 60_000),
-    );
+    const left = coveredMs(from, now.getTime(), paused);
+    pausedMinutes = Math.round(left / 60_000);
+    minutes = Math.max(0, Math.round((now.getTime() - from - left) / 60_000));
     row = [i.milestone, i.what, i.commit, String(minutes), i.evidence].map(cell).join(" | ");
     appendLedger(run, row);
     return { lastCheck: cell(i.evidence), next: i.next, lastLandedAt: now.toISOString() };
@@ -429,8 +432,11 @@ async function landRun(
     evidence: i.evidence,
     minutes,
     at: now.toISOString(),
+    commits,
+    pausedMinutes,
   });
-  return { ledger: row, minutes, digest, ...withHints(hints) };
+  // spec 1.5: the digest's full path, for the milestone push to link
+  return { ledger: row, minutes, digest, digestPath: join(run.dir, digest), ...withHints(hints) };
 }
 
 /** Jev's `finding` or `same-defect` answer, through the routing port. */
diff --git a/src/services/milestones.ts b/src/services/milestones.ts
index 7057e59..55df6ac 100644
--- a/src/services/milestones.ts
+++ b/src/services/milestones.ts
@@ -190,6 +190,24 @@ export async function milestoneFiles(run: Run, commit: string): Promise<string[]
   return r.out.split("\n").filter(Boolean);
 }
 
+/** The most commits a digest lists; the rest are counted. */
+const DIGEST_COMMITS = 20;
+
+/**
+ * The commits the milestone lands, `<short hash> <subject>`, oldest first: from the previous landed commit
+ * (else the commit alone) to `commit`. Just the hash when git cannot say: a digest never fails a landing.
+ */
+export async function milestoneCommits(run: Run, commit: string): Promise<string[]> {
+  const base = landedCommits(run).at(-1);
+  const range = base ? [`${base}..${commit}`] : ["-1", commit];
+  const r = await git(run.meta.repo, ["log", "--reverse", "--format=%h %s", ...range]);
+  if (r.kind !== "ok") return [commit.slice(0, 7)];
+  const all = r.out.split("\n").filter(Boolean);
+  return all.length > DIGEST_COMMITS
+    ? [...all.slice(-DIGEST_COMMITS), `and ${all.length - DIGEST_COMMITS} earlier`]
+    : all;
+}
+
 /** `rev`'s full commit hash in the run's repo. Throws E_IO_UNEXPECTED when git cannot say. */
 export async function fullCommit(run: Run, rev: string): Promise<string> {
   const r = await git(run.meta.repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
diff --git a/src/services/protocol.ts b/src/services/protocol.ts
index 1fd69d0..b48ff9e 100644
--- a/src/services/protocol.ts
+++ b/src/services/protocol.ts
@@ -15,6 +15,7 @@ import {
   reviewerPassed,
   verifierPassed,
 } from "./milestones.ts";
+import { openQuestions } from "./questions.ts";
 import { readAgentRuns, readRecords, readRoutes, type Run, runPaths } from "./run-store.ts";
 
 // Spec 1.1 §10: the protocol's next step, derived from the run's own files so a session that lost its
@@ -164,6 +165,17 @@ function findingCounts(run: Run, r: RunRecord | undefined): string {
   return `${total} finding(s): ${n.BLOCKER} BLOCKER, ${n.BUG} BUG, ${n.NIT} NIT`;
 }
 
+/** The reviewer's BLOCKER and BUG lines, as it wrote them: what the digest lists as findings. */
+function findingLines(run: Run, r: RunRecord | null | undefined): string[] {
+  if (!r?.replyPath) return [];
+  const file = join(run.dir, r.replyPath);
+  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
+  return text
+    .split("\n")
+    .filter((l) => /^(BLOCKER|BUG)$/.test(FINDING.exec(l)?.[1] ?? ""))
+    .map((l) => l.trim().replace(/^[-*]\s*/, ""));
+}
+
 const k = (x: number) => (x >= 1000 ? `${Math.round(x / 1000)}k` : String(x));
 
 /**
@@ -173,7 +185,18 @@ const k = (x: number) => (x >= 1000 ? `${Math.round(x / 1000)}k` : String(x));
  */
 export function writeDigest(
   run: Run,
-  i: { milestone: string; what: string; commit: string; evidence: string; minutes: number; at: string },
+  i: {
+    milestone: string;
+    what: string;
+    commit: string;
+    evidence: string;
+    minutes: number;
+    at: string;
+    /** spec 1.5: the commits the milestone landed, `<hash> <subject>`, oldest first */
+    commits?: string[];
+    /** spec 1.5: the parked and paused minutes `minutes` leaves out */
+    pausedMinutes?: number;
+  },
 ): string {
   const m = i.milestone;
   const start = milestoneStart(run, m);
@@ -191,6 +214,9 @@ export function writeDigest(
   const records = readRecords(run).records;
   // the reviewer the gate counted: since the milestone's lanes started, a dispatch or a native subagent
   const reviewer = milestoneReviewer(run, m, start);
+  // spec 1.5: the review's BLOCKER and BUG lines, and the owner questions still open in the run
+  const findings = findingLines(run, reviewer?.record);
+  const open = openQuestions(run);
   const agents = readAgentRuns(run);
   // the verdict the gate counted: the latest attempt, native or headless, a FAIL shown as such
   const verdict = milestoneVerifier(run, m, start);
@@ -221,7 +247,8 @@ export function writeDigest(
   const text = [
     `# ${m} — ${i.what}`,
     "",
-    `Commit ${i.commit} · ${i.minutes} min · landed ${i.at}`,
+    `Commit ${i.commit} · ${i.minutes} min${i.pausedMinutes ? ` (${i.pausedMinutes} min parked or paused left out)` : ""} · landed ${i.at}`,
+    ...(i.commits?.length ? [`Commits: ${i.commits.join("; ")}`] : []),
     `A-lines: ${aLines.length ? aLines.join("; ") : "none named in what or evidence"}`,
     "",
     "Lanes:",
@@ -229,6 +256,8 @@ export function writeDigest(
     "",
     `Reviewer: ${reviewer ? `${reviewer.name} · ${reviewer.record ? findingCounts(run, reviewer.record) : "a Claude subagent (findings in its reply)"}` : "none"}`,
     `Verifier: ${verdict ? `${verdict.passed ? "PASS" : `FAIL: ${verdict.verdict}`} (${verdict.name}${verdict.headless ? ", headless" : ""})` : "none"}${steps.length ? ` · carried: ${steps.map((s) => `${s.item}${s.commit ? ` from ${s.commit}` : ""}`).join(", ")}` : ""}`,
+    `Findings: ${findings.length ? findings.join(" · ") : "no BLOCKER or BUG lines"}`,
+    `Open: ${open.length ? open.map((q) => `${q.milestone} parked: ${q.question}`).join(" · ") : "none"}`,
     `Evidence: ${i.evidence}`,
     `Tokens: ${k(tokens.input)} in (${k(tokens.cached)} cached) · ${k(tokens.output)} out · Claude subagents ${k(reported)} (reported)`,
     "",
````

### Task 14: The skill, the architect brief and the README

**Files:** `plugin/skills/catherd/SKILL.md`, `src/domain/role-prompts.ts`, `README.md`.

The skill's tool table gains `run_start`'s `from`, `run_pin`, `lane_set`/`owns_add`; its errors list `E_ADMIT_ORDER`, `E_ADMIT_PAUSED` and `E_RUN_NOT_LIVE` on dispatch; the workspace section the completion-milestone rule, merge release, budget and pause; the lane-file step the `After:`/`Allow:` lines; the land step `digestPath`, the exact verifier name and pause-free minutes. The architect brief names the two optional lane lines. The README's command table and workspace section follow. `bun run format` reflows the README table (the diff is its output).

- [ ] **Step 1:** apply the diff; run `bun run format:check && bun test test/skills.test.ts test/plugin.test.ts test/domain test/entry/help-text.test.ts`.
- [ ] **Step 2: commit** `docs: runs, programs and lanes in the skill, the architect brief and the README` (scratch `abeaf2b`).

**Code (scratch `abeaf2b`):**

````diff
diff --git a/README.md b/README.md
index 7498a85..e150dca 100644
--- a/README.md
+++ b/README.md
@@ -185,24 +185,26 @@ This acknowledges possible duplicate native input; an accepted receipt still sup
 
 In a terminal:
 
-| Command                                                                                     | What it does                                                                                        |
-| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
-| `catherd`                                                                                   | The dashboard: Status, Profiles and Runs (below)                                                    |
-| `catherd init [--host codex\|claude-code\|auto] [--no-input] [--no-global] [--profile <p>]` | First-run setup; installs the global `catherd` at its own version unless `--no-global`              |
-| `catherd doctor [--host codex\|claude-code\|auto] [--test-push] [--json]`                   | Readiness and capability report; no send unless explicit smoke; exits 3 when not ready              |
-| `catherd profile list\|show\|use [--repo]\|new [--from <p>]\|copy\|rm\|diff\|validate`      | Profiles; `use --repo` binds one to the repo you are in                                             |
-| `catherd profile use --repo --clear`                                                        | Unbinds the repo you are in; it runs on the active profile again                                    |
-| `catherd profile set <path> <value> [--profile <p>]`                                        | One field, e.g. `roles.verifier.access read-only`, `roles.worker.network false`, `budget.usd 20`    |
-| `catherd status [run]`, `catherd watch [--once] [--interval <s>]`                           | Where runs stand, grouped by host and session; read-only ownership                                  |
-| `catherd runs list [--repo <path>]\|show <id> [--debug [--name <n>]]\|cancel <id> <name>`   | Past runs, by session; `--debug` adds exit.json and the stderr and event tails, `--name` one role's |
-| `catherd catalog refresh\|list [--backend <b>] [--role <r>] [--text <t>] [--scored]`        | The models catherd can place, filtered                                                              |
-| `catherd catalog sync [--force] [--unmatched]`                                              | Fetches the public model facts and scores now (below); `--unmatched` lists ids no model matched     |
-| `catherd catalog treat-like <rung> <like>`                                                  | Scores an unscored rung as a scored one                                                             |
-| `catherd catalog treat-like --suggest <rung>\|--clear <rung>\|--reset`                      | The three nearest stand-ins for a rung; removes one or every mapping of yours                       |
-| `catherd knowledge show\|add "<line>"\|path [--repo <path>]`                                | The repo's knowledge.md, which new runs read; `add` appends a fact of yours, marked "by hand"       |
-| `catherd lock [--slots N] -- <cmd>`                                                         | Runs a heavy command behind the machine-wide semaphore, in its own session (no /dev/tty)            |
-| `catherd mcp`                                                                               | The MCP server on stdio; the plugin starts it, you never need to                                    |
-| `catherd capture-fixtures [--backend <b>] [--out <dir>]`                                    | Contributors: records sanitized test fixtures from real runs (see CONTRIBUTING.md)                  |
+| Command                                                                                              | What it does                                                                                                                                |
+| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
+| `catherd`                                                                                            | The dashboard: Status, Profiles and Runs (below)                                                                                            |
+| `catherd init [--host codex\|claude-code\|auto] [--no-input] [--no-global] [--profile <p>]`          | First-run setup; installs the global `catherd` at its own version unless `--no-global`                                                      |
+| `catherd doctor [--host codex\|claude-code\|auto] [--test-push] [--json]`                            | Readiness and capability report; no send unless explicit smoke; exits 3 when not ready                                                      |
+| `catherd profile list\|show\|use [--repo]\|new [--from <p>]\|copy\|rm\|diff\|validate`               | Profiles; `use --repo` binds one to the repo you are in                                                                                     |
+| `catherd profile use --repo --clear`                                                                 | Unbinds the repo you are in; it runs on the active profile again                                                                            |
+| `catherd profile set <path> <value> [--profile <p>]`                                                 | One field, e.g. `roles.verifier.access read-only`, `roles.worker.network false`, `budget.usd 20`                                            |
+| `catherd status [run]`, `catherd watch [--once] [--interval <s>]`                                    | Where runs stand, grouped by host and session; read-only ownership                                                                          |
+| `catherd runs list [--repo <path>]\|show <id> [--debug [--name <n>]]\|cancel <id> <name>`            | Past runs, by session; `--debug` adds exit.json and the stderr and event tails, `--name` one role's                                         |
+| `catherd catalog refresh\|list [--backend <b>] [--role <r>] [--text <t>] [--scored]`                 | The models catherd can place, filtered                                                                                                      |
+| `catherd catalog sync [--force] [--unmatched]`                                                       | Fetches the public model facts and scores now (below); `--unmatched` lists ids no model matched                                             |
+| `catherd catalog treat-like <rung> <like>`                                                           | Scores an unscored rung as a scored one                                                                                                     |
+| `catherd catalog treat-like --suggest <rung>\|--clear <rung>\|--reset`                               | The three nearest stand-ins for a rung; removes one or every mapping of yours                                                               |
+| `catherd knowledge show\|add "<line>"\|path [--repo <path>]`                                         | The repo's knowledge.md, which new runs read; `add` appends a fact of yours, marked "by hand"                                               |
+| `catherd runs supersede <id> --by <id>`, `catherd runs pin <id>`                                     | Closes a run with a pointer to the one that took over; re-pins a run to the repo's profile now                                              |
+| `catherd pause --machine\|--workspace <id> "<reason>"`, `catherd resume --machine\|--workspace <id>` | Pauses every run on the machine (or in a workspace) on one blocker; dispatch is refused until resume                                        |
+| `catherd lock [--slots N] [--role verifier [--run <id>]] -- <cmd>`                                   | Runs a heavy command behind the machine-wide semaphore, in its own session (no /dev/tty); `--role verifier` keeps two runs' verifiers apart |
+| `catherd mcp`                                                                                        | The MCP server on stdio; the plugin starts it, you never need to                                                                            |
+| `catherd capture-fixtures [--backend <b>] [--out <dir>]`                                             | Contributors: records sanitized test fixtures from real runs (see CONTRIBUTING.md)                                                          |
 
 A profile command without a profile name (`show`, `set`, `diff`, `validate`), like the MCP profile tools, acts
 on the profile the repo you are in runs on: the one bound to it, else the active one. Pass `repo` explicitly to MCP tools; profile CLI commands accept `--host` for effective defaults. Run them as
@@ -248,6 +250,9 @@ in `catherd.workspace.json`; catherd does not scan neighboring folders:
 Run `catherd workspace inspect /path/to/workspace --json` to check the resolved members. Through MCP,
 `workspace_start` takes `root`, `title`, `a_lines`, and `steps`: each step has `id`, a member `repo`, `title`,
 `a_lines`, optional `depends_on` step ids, and the `milestone` that releases its dependents (default `M1`).
+A step with `release: "merge"` and a `base` ref (`origin/main`) releases them only once its landed commit is
+an ancestor of that ref (`git merge-base --is-ancestor`), checked when a dependent asks; fetch first, nothing
+is polled.
 An explicit `repos` map can replace the manifest. Only members used by the steps enter the run snapshot.
 Steps reusing one member must be ordered by dependencies. A final verification step can reuse a member
 after both parallel producer steps land; unordered steps in the same repository are refused.
@@ -259,12 +264,15 @@ Use the existing route, dispatch, verification and land workflow with that child
 its own profile, knowledge and repository rules; workers write within their own repository.
 
 `workspace_status(workspace)` and `catherd workspace status <id> --json` show the shared view and spending.
-The optional workspace `budget` (`minutes`, `tokens`, `usd`) stops new admissions when aggregate observed
-spending reaches its cap, alongside each child's budget. Running workers may overshoot; native subagent
-usage is reported after execution. Dependency readiness requires a recorded landing and finalized
-dispatches, not just a finished worker. Landing and dispatch admission share the parent lock.
-Workspaces support at most 100 repositories and 100 steps. Unreadable or negative usage evidence blocks
-continuation until repaired. Stored status remains available after a checkout disappears, while child
+The optional workspace `budget` (`minutes`, `tokens`, `usd`; no cap unless given, minutes from the first
+child) stops new admissions when aggregate observed spending reaches its cap, alongside each child's budget;
+`workspace_budget(workspace, …)` raises it. Running workers may overshoot; native subagent usage is reported
+after execution. Dependency readiness requires a recorded landing and finalized dispatches, not just a
+finished worker. Landing a step's completion milestone and dispatch admission share the parent lock; other
+milestones land freely, and a landed step admits a post-land fix. `workspace_pause(workspace, reason)` stops
+every child's admission on one blocker until `workspace_resume`. Workspaces support at most 100 repositories
+and 100 steps. A run folder without a readable `meta.json` is skipped and named in `workspace_status`; with a
+cap set, unreadable or negative usage evidence blocks admission until repaired. Stored status remains available after a checkout disappears, while child
 recovery and admission require the captured Git root. catherd never automatically commits, pushes,
 rolls back repositories or starts the next child.
 
diff --git a/plugin/skills/catherd/SKILL.md b/plugin/skills/catherd/SKILL.md
index cc782f9..8584a5b 100644
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -39,33 +39,38 @@ Native headless Codex and Claude Code roles receive a dedicated `catherd_role` M
 
 Pass the actual project `repo` explicitly to profile, setup and catalog tools that accept it. The native Codex MCP server starts in the installed plugin root, so its cwd is not evidence of the project. `run_start(repo, ...)` establishes the run's repository.
 
-| Tool                                                                                                  | Use                                                                                                                                                                                                                                                                                                              |
-| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
-| `status(run?)`                                                                                        | First, and whenever the user asks where it stands: `version`, then per run the open owner questions, the `state.md` tail, live roles, totals, Claude subagents, the verifier's step, budget, milestones                                                                                                          |
-| `run_start(repo, title, a_lines)`                                                                     | Once per project. Returns `run`, the id every other call takes, `dir`, the run folder `R`, and `protocol`: the next step of the milestone loop and its six-line checklist                                                                                                                                        |
-| `peek(run?, name?)`                                                                                   | Never waits. Per run: the open owner questions first (the owner's to answer), each live role with its rung, time and last event, every finished record not yet read, the next step, the verifier's step, and `protocol` (the milestone loop's next step and the checklist). It marks nothing read: `result` does |
-| `route(run, lane_file?, role?)`                                                                       | A lane's rung (from Jev, else the lane file's `Kind:`/`Difficulty:`, else the profile), or a role's rung. Returns `rung`, `ladder`, `backend`, `agent`                                                                                                                                                           |
-| `preflight(run, confirmed?)`                                                                          | Each lane's fast check once, before any lane runs. Outcomes below                                                                                                                                                                                                                                                |
-| `dispatch(run, role, name, brief, rung, thread?, lane?, next?)`                                       | Starts one process role (Codex, claude-code or opencode) and returns at launch, in about a second, with `dispatched`. It routes a lane not routed yet, appends the role's reply contract to the brief, and its result arrives as a catherd message                                                               |
-| `result(run, name)`                                                                                   | A role's latest reply, capped, its record and its `hints`; reading a finished record marks it read                                                                                                                                                                                                               |
-| `cancel(run, name)`                                                                                   | Stops a live role and returns its record, `cancelled`, and `hints`                                                                                                                                                                                                                                               |
-| `record_agent_run(run, name, role, rung, total_tokens, duration_ms?, cost_usd?, status?, lane?)`      | Native Claude Agent results on Claude Code only. The budget counts them; `lane` counts their time toward that lane's kind; a verifier named `verifier-<M>` records FAIL with `status: "failed"`                                                                                                                  |
-| `climb(run, lane, reason, evidence?, env?)`                                                           | The lane's next rung, with its `backend` and `agent`, or `top: true`. `env: true` when the environment, not the rung, caused it                                                                                                                                                                                  |
-| `ask(run, question, state)`                                                                           | Jev's `finding` or `same-defect` answer                                                                                                                                                                                                                                                                          |
-| `gate_check(run, item, command, paths, milestone?)`, `gate_pass(run, item, command, paths, evidence)` | The verifier's gate ledger: an item that passed on the same content is carried over, not run again; `milestone` scopes the digest's carried items                                                                                                                                                                |
-| `park(run, milestone, question)`, `answer(run, milestone, answer)`                                    | An owner question parks its milestone while the rest of the run goes on; the owner's answer unparks it                                                                                                                                                                                                           |
-| `land(run, milestone, what, commit, evidence, next, learned?, skip?)`                                 | A landed milestone's ledger row, with the minutes it took, `state.md`, and `digest`, the milestone's digest. Refused until the milestone has its reviewer and its verifier. `learned` appends to this repo's `knowledge.md`                                                                                      |
-| `read_knowledge(repo)`                                                                                | What past runs of this repo learned. The dossier brief reads it                                                                                                                                                                                                                                                  |
-| `write_run_file(run, path, content)`, `read_run_file(run, path)`                                      | Files in `R`. Never your own Write or Read tools there: `R` is outside the repo                                                                                                                                                                                                                                  |
-| `set_next(run, next)`                                                                                 | The next step, when you pause or the plan changes. Returns `state` and, when git fails, `hints`                                                                                                                                                                                                                  |
-| `runs_summary(run?, repo?, role?, since_days?)`                                                       | Time, tokens, refusals and climbs per role and rung, the Claude subagent runs, and the harness cost, for the report                                                                                                                                                                                              |
-| `profile_get(repo?)`                                                                                  | The profile this repo runs on: each role's access, rungs and enforcement, failover, budget, timeouts, and the moments to push                                                                                                                                                                                    |
+| Tool                                                                                                  | Use                                                                                                                                                                                                                                                                                                                                                                |
+| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
+| `status(run?)`                                                                                        | First, and whenever the user asks where it stands: `version`, then per run the open owner questions, the `state.md` tail, live roles, totals, Claude subagents, the verifier's step, budget, milestones                                                                                                                                                            |
+| `run_start(repo, title, a_lines, from?)`                                                              | Once per project. Returns `run`, the id every other call takes, `dir`, the run folder `R`, and `protocol`: the next step of the milestone loop and its six-line checklist. `from`: the run this one takes over (a planning run handed to a worktree), closed with a pointer here. It pins the profile, each role's access and each backend's isolation for the run |
+| `run_pin(run)`                                                                                        | Only on the owner's word: re-pins the run to what its repo runs on now. Until then dispatch keeps the pinned values, and `status` and `state.md` say what changed                                                                                                                                                                                                  |
+| `lane_set(run, lane, field, value)`, `owns_add(run, lane, paths, why)`                                | One lane header line (`owns`, `fast_check`, `kind`, `difficulty`, `after`, `allow`), validated, instead of editing the file by hand; `owns_add` grows a lane's Owns mid-lane, refused when a running lane owns a path                                                                                                                                              |
+| `peek(run?, name?)`                                                                                   | Never waits. Per run: the open owner questions first (the owner's to answer), each live role with its rung, time and last event, every finished record not yet read, the next step, the verifier's step, and `protocol` (the milestone loop's next step and the checklist). It marks nothing read: `result` does                                                   |
+| `route(run, lane_file?, role?)`                                                                       | A lane's rung (from Jev, else the lane file's `Kind:`/`Difficulty:`, else the profile), or a role's rung. Returns `rung`, `ladder`, `backend`, `agent`                                                                                                                                                                                                             |
+| `preflight(run, confirmed?)`                                                                          | Each lane's fast check once, before any lane runs. Outcomes below                                                                                                                                                                                                                                                                                                  |
+| `dispatch(run, role, name, brief, rung, thread?, lane?, next?)`                                       | Starts one process role (Codex, claude-code or opencode) and returns at launch, in about a second, with `dispatched`. It routes a lane not routed yet, appends the role's reply contract to the brief, and its result arrives as a catherd message                                                                                                                 |
+| `result(run, name)`                                                                                   | A role's latest reply, capped, its record and its `hints`; reading a finished record marks it read                                                                                                                                                                                                                                                                 |
+| `cancel(run, name)`                                                                                   | Stops a live role and returns its record, `cancelled`, and `hints`                                                                                                                                                                                                                                                                                                 |
+| `record_agent_run(run, name, role, rung, total_tokens, duration_ms?, cost_usd?, status?, lane?)`      | Native Claude Agent results on Claude Code only. The budget counts them; `lane` counts their time toward that lane's kind; a verifier named `verifier-<M>` records FAIL with `status: "failed"`                                                                                                                                                                    |
+| `climb(run, lane, reason, evidence?, env?)`                                                           | The lane's next rung, with its `backend` and `agent`, or `top: true`. `env: true` when the environment, not the rung, caused it                                                                                                                                                                                                                                    |
+| `ask(run, question, state)`                                                                           | Jev's `finding` or `same-defect` answer                                                                                                                                                                                                                                                                                                                            |
+| `gate_check(run, item, command, paths, milestone?)`, `gate_pass(run, item, command, paths, evidence)` | The verifier's gate ledger: an item that passed on the same content is carried over, not run again; `milestone` scopes the digest's carried items                                                                                                                                                                                                                  |
+| `park(run, milestone, question)`, `answer(run, milestone, answer)`                                    | An owner question parks its milestone while the rest of the run goes on; the owner's answer unparks it                                                                                                                                                                                                                                                             |
+| `land(run, milestone, what, commit, evidence, next, learned?, skip?)`                                 | A landed milestone's ledger row, with the minutes it took, `state.md`, and `digest`, the milestone's digest. Refused until the milestone has its reviewer and its verifier. `learned` appends to this repo's `knowledge.md`                                                                                                                                        |
+| `read_knowledge(repo)`                                                                                | What past runs of this repo learned. The dossier brief reads it                                                                                                                                                                                                                                                                                                    |
+| `write_run_file(run, path, content)`, `read_run_file(run, path)`                                      | Files in `R`. Never your own Write or Read tools there: `R` is outside the repo                                                                                                                                                                                                                                                                                    |
+| `set_next(run, next)`                                                                                 | The next step, when you pause or the plan changes. Returns `state` and, when git fails, `hints`                                                                                                                                                                                                                                                                    |
+| `runs_summary(run?, repo?, role?, since_days?)`                                                       | Time, tokens, refusals and climbs per role and rung, the Claude subagent runs, and the harness cost, for the report                                                                                                                                                                                                                                                |
+| `profile_get(repo?)`                                                                                  | The profile this repo runs on: each role's access, rungs and enforcement, failover, budget, timeouts, and the moments to push                                                                                                                                                                                                                                      |
 
 **A tool returns `hints` when it has any:** one line each, on what to do next. Read them before you move on.
 
 **Every error is `{ code, message, fix }`.** Read the code, act on the fix, and never retry the same call blindly:
 
 - `E_ADMIT_OVERLAP`: the lane shares an owned path with a running lane. Dispatch it when that one returns.
+- `E_ADMIT_ORDER`: the lane's `After:` line names a lane that has not finished. Dispatch that one first.
+- `E_ADMIT_PAUSED`: the machine (`catherd pause --machine`) or the run's workspace (`workspace_pause`) is paused on a blocker; the message gives the reason. Wait for the owner, or resume once the blocker is gone.
+- `E_RUN_NOT_LIVE` on dispatch: the run is superseded; dispatch in the run the message names.
 - `E_ADMIT_DUPLICATE`: that role name is already running. It reports through a catherd message when it finishes; `peek(run, name)` shows it now, and `cancel` stops it.
 - `E_ADMIT_RUNG`: the rung is not on that role's ladder, it is a `claude:` rung, or the profile turns the role off. Use the rung `route` returned; native `claude:` requires Claude Code; skip a role that is off. On Codex, explain the exact `claude-code:` model/effort equivalent or the reviewed host-default reset instead of converting the rung yourself.
 - `E_RUN_BUDGET`: the run's budget is spent (a soft cap: roles already running finish). Pause, report and push.
@@ -94,8 +99,16 @@ Use `workspace_status(workspace)` for ready, waiting, active and landed steps an
 Start only ready steps with `workspace_child_start(workspace, step)`; it returns the ordinary child `run`
 id, `dir`, and frozen contract path. Repeating it returns the same child. Children are created lazily, and a
 dependency becomes ready only after its predecessor's declared milestone is recorded by `land`.
-Finish and collect every child dispatch before landing; live or uncollected work blocks completion.
-Repair corrupt accounting evidence before continuing rather than treating unknown usage as zero.
+Finish and collect every child dispatch before landing the step's completion milestone; live or uncollected
+work blocks it, not the step's other milestones. A landed step still admits a post-land fix.
+When the program's order is "after it is merged", give the step `release: "merge"` and a `base` ref
+(`origin/main`): its dependents start once its landed commit is in that ref. Fetch, then ask again;
+nothing is polled. The workspace budget has no cap unless you set one; `workspace_budget(workspace, …)`
+raises it on the owner's word. One blocker for every child (a VPN, Docker down) is one
+`workspace_pause(workspace, reason)` and one push, not a park per run; `workspace_resume` lifts it. For
+every run on the machine, the owner runs `catherd pause --machine "<reason>"`.
+With a cap set, repair corrupt accounting evidence before continuing rather than treating unknown usage as
+zero; `workspace_status` names any run folder it skipped.
 
 Follow the single-repo milestone sequence below independently for each child. Read each member's rules,
 profile and knowledge separately. Include the copied `workspace-contract.md` in role briefs; do not give
@@ -248,7 +261,7 @@ Nothing else pushes: a phone that buzzes for progress teaches the user to ignore
 
 3. **Architect,** once, with the A-lines, the run id and the dossier's path. It reads the dossier first, writes `plan.md` and every `lanes/Mx.Ly.md` itself with `write_run_file`, and replies with a short list of milestones and lanes. Each lane names its owned files and its **fast check**: its targeted tests plus the linter, and the type check when the repo has one, scoped to the lane's owned packages (seconds to a minute or two). Each milestone names its **full check** (the whole suite).
    - A full check slower than about five minutes is a problem to solve, not to live with. The architect makes speeding it up (parallel tests, a shared fixture) an early lane.
-   - Every lane file starts with these lines: `# Mx.Ly — <title>`, `Owns: <paths>` (repo-relative, a trailing `/` for a folder, never a glob), `Fast check: <command>`, `Kind: repo_code|terminal|ui|prose|research` and `Difficulty: copy|build|logic|hard`.
+   - Every lane file starts with these lines: `# Mx.Ly — <title>`, `Owns: <paths>` (repo-relative, a trailing `/` for a folder, never a glob), `Fast check: <command>`, `Kind: repo_code|terminal|ui|prose|research` and `Difficulty: copy|build|logic|hard`. Two optional lines follow: `After: Mx.Ly, …` when the lane compiles against another lane's changes (`protocol.next` and `dispatch` hold it until those finish ok), and `Allow: path[:line], …` under a fast check that greps for absence, naming the hits that are allowed exceptions. `write_run_file` refuses a lane whose header values are wrong; fix one line with `lane_set`.
    - **Plan in hand** (a `plan:` A-line): no dossier. Brief the architect with the A-lines, the run id and the plan's paths, to translate, not design: each plan task becomes lanes (`Owns:`, `Fast check:`, `Kind:`, `Difficulty:`), each MR or phase a milestone with its full check. It copies the plan's decisions into `plan.md` and the lane files, redesigns only what the plan leaves undecided, and stays the target for `design` findings.
    - **No dossier and no architect** for a polish or fix run (a list of known defects or tweaks to code that exists) or a single mechanical task. You write the lane files yourself with `write_run_file`, straight from the A-lines: one lane per cluster of defects that share files, with owned files found by `grep -n`, and the same header lines.
 4. **Route and preflight.** `route(run, "lanes/Mx.Ly.md")` for every lane, one call per lane; each may wait up to 25 s on Jev (`dispatch` routes a lane you missed, and starts it at the routed rung when yours is off its ladder). `route`, `preflight` and `dispatch` refuse a lane whose `Kind:` or `Difficulty:` the catalog does not know (`E_LANE_INVALID`). Then, once every lane file exists, `preflight(run)` once, before dispatching any lane. Each lane comes back as one of:
@@ -276,7 +289,7 @@ Nothing else pushes: a phone that buzzes for progress teaches the user to ignore
    - On FAIL, the owning worker fixes it, and you ask the same verifier to re-check: native Claude `SendMessage`, or process `dispatch` with its own recorded thread followed by `result`.
    - A second FAIL on the same line goes to the architect.
    - A third one: pause, report and push.
-10. **Land.** Commit the milestone path-scoped, then `land(run, milestone, what, commit, evidence, next, learned)`, passing `learned` when the milestone taught the next run something worth knowing (a slow suite, a flaky test, a pattern to copy); push if the profile's `notify` has `milestone`, with the digest's path, and move to the next milestone.
+10. **Land.** Commit the milestone path-scoped, then `land(run, milestone, what, commit, evidence, next, learned)`, passing `learned` when the milestone taught the next run something worth knowing (a slow suite, a flaky test, a pattern to copy); push if the profile's `notify` has `milestone`, with `digestPath` (the digest's full path: its commits, findings and what is open), and move to the next milestone. Only a verifier named exactly `verifier-<M>` counts, and the minutes leave out parked and paused time.
     - `land` refuses (`E_LAND_GATE`) a milestone with no reviewer record (a `reviewer-<M>` dispatch record, or a native Claude `record_agent_run` row with role reviewer and that name, status `ok`) or no verifier verdict since its lanes started. A skip over an empty commit range is refused too: commit first. A milestone that changed only docs lands with `skip: "docs-only"`; one that changed no source file with `skip: "no-code"` and the required local gate evidence in `evidence`. Follow the repo's CI policy; a skill never authorizes triggering checks.
     - Commit only while no role is writing. A pre-commit hook may stash unstaged files, and a role's edits vanish under it.
     - The next milestone's lanes can start in the same turn as the `land`.
diff --git a/src/domain/role-prompts.ts b/src/domain/role-prompts.ts
index 309cdc0..697a2ba 100644
--- a/src/domain/role-prompts.ts
+++ b/src/domain/role-prompts.ts
@@ -41,6 +41,8 @@ const architect = [
   "",
   "catherd reads the Owns: line to keep two running lanes off the same file, and to tell a refusal (owned files unchanged) from work. It reads Kind: and Difficulty: to pick the lane's model when its router is unsure.",
   "",
+  "Two optional lines follow the five when they apply: `After: Mx.Ly, …` when the lane compiles against another lane's changes (catherd dispatches it only once those finish), and `Allow: path[:line], …` under a fast check that greps for absence, naming the hits that are allowed exceptions. Write such greps with word boundaries.",
+  "",
   "Signatures, data shapes and test case names are yours. Function bodies are the worker's. A plan that contains the implementation turns the worker into a typist and spends the most expensive model on typing.",
   "",
   "Prefer the smallest design that meets the acceptance lines: no abstraction with one implementation, no config for a value that never changes, no comments restating code.",
````

### Task 15: Remove the fixed entries from `docs/dev/ideas.md`

Removed: the whole "#43 (workspace runs), review findings" list (findings 1–9: 1–8 by Tasks 1–3; 9's merge release, group pause and verifier contention by Tasks 4–6); from "From the 1.1.0 platform run" the `protocol.next` lane order entry, the `Allow:` entry, the sandbox-changed-silently entry, the "Ledger and knowledge" pair and "The profile is not pinned per run either"; from "From the payment run" the "Programs span runs" section and the `lane_set` and lane-values entries; from "From the agentic-machine identity run" "A superseded run stays open"; from "Orchestration" "A per-milestone digest". Trimmed: "An Owns list cannot grow mid-lane" keeps only its open part, the "discover, then split" step. Kept for other plans: the `dispatch` thread entry (plan 22), "Jev overrode the lane headers" (plan 24), "A writer's edits are blamed on the lanes" (plan 21).

- [ ] **Step 1:** apply the diff; `bun run format:check`.
- [ ] **Step 2: commit** `docs(ideas): drop the runs, programs and lanes entries plan 25 fixes` (scratch `17c4e03`).

**Code (scratch `17c4e03`):**

````diff
diff --git a/docs/dev/ideas.md b/docs/dev/ideas.md
index 0e2ddaf..b9be9b6 100644
--- a/docs/dev/ideas.md
+++ b/docs/dev/ideas.md
@@ -41,32 +41,6 @@ the contributor. Owner rulings:
    timeout on a loaded machine. Check the timeout; set `startup_timeout_sec` or drop `required`.
 9. **`docs/dev/reports/role-access-orchestration-wait-pr.md`** is a PR description, not a run report; delete it.
 
-#43 (workspace runs), review findings:
-
-1. **One unrelated broken run blocks the whole workspace.** `workspaceChildren` (`workspace-store.ts`) reads every
-   run in each member repo and throws `E_RUN_CORRUPT` on any folder without `meta.json`; `createRun` writes meta
-   last, so a concurrent `run_start` or a crash bricks child start, admission, land, route and `workspace_status`,
-   with no folder named. Reproduced with one empty run folder. Fix: only workspace-linked runs with a meta; skip or
-   warn on the rest, and name the folder.
-2. **Strict reads of every child for every operation.** One torn jsonl line in one child stops every sibling and
-   makes `workspace_status` throw. Read only the evidence the operation needs; status reports a corrupt child as a
-   warning. Reproduced.
-3. **A child cannot land any milestone while any dispatch is pending** (`lane-service.ts`), not only its completion
-   milestone: landing M1 while an M2 lane runs gives `E_LAND_GATE`. Apply the rule only when
-   `milestone === step.milestone`.
-4. **The default workspace budget is the profile's per-run budget over all children**, with minutes from the
-   workspace's creation and no way to raise it: one night parked on a question refuses every later child. Default
-   no cap, or start the clock at the first child, and allow raising it.
-5. **The workspace lock is held across slow git work** (admission's status snapshot, land's diffs and state
-   refresh; up to 15 s each) while waiters give up at 10 s, so dispatches in other repos fail `E_IO_LOCK`.
-6. **MCP step objects use `z.object`**, which drops `dependsOn` silently; use `z.strictObject`.
-7. **A landed step's child can never admit again** (a post-land fix needs a new workspace), and a `milestone` that
-   never lands (`m1` vs `M1`) leaves dependents waiting with no warning.
-8. **Admission and child start check dependencies differently** (lenient without the runs lock vs strict).
-9. **Dependencies release on `land`, not on merge.** The payment run's need was "M1 of run B after M1 of run A is
-   merged, then rebase"; worktrees of one repo count as distinct members, so it fits otherwise. Also still open
-   from the same evidence: a group-level environment pause and verifier contention across runs.
-
 Shipped in 1.0, so not re-proposed here: `catherd doctor`; the harness-cost line in `runs_summary` and the final
 report; quota failover (the profile's `failover` map); the `preflight` tool; per-repo knowledge
 (`<data>/repos/<slug>-<hash8>/knowledge.md`, read with `read_knowledge`, appended by `land`); the run budget (from 80 %
@@ -505,24 +479,17 @@ Run `20260928-172920-m3-auth-plan-5-mr-b-the-kit-clean-up` (sanitell/platform, a
 **Delivery and the loop**
 
 - **Messages arrive only when the next turn starts.** worker-M3.L1 ended at 17:43:08, and its catherd message reached the main thread only after the owner's next message, about 20 min later. An idle main thread is not woken. Until something wakes it, `peek` is the only way to see it, and the owner read the silence as a hang. Fix: wake an idle owner session, or let `status` show "finished, unread" prominently.
-- **`protocol.next` ignores lane order.** It said "dispatch M3.L3, M3.L4" while both depended on L1's kit changes, which have to compile first. Admission guards only file overlap, not package-level compile coupling. Fix: add a `After: M3.L1` lane header that `protocol.next` and admission respect.
 - **The dispatch description still says "wait(run) collects its record".** `wait` was removed in 1.1.0.
 
 **Lanes and Owns**
 
-- **An Owns list cannot grow mid-lane.**
-  - L3 (Task 11 Go) ended partial on `services/notification/cmd/notification/audit_platform_test.go:93`, outside its Owns. The plan's grep excluded `_test.go`.
-  - L4 (Task 12) stopped on four panel clones that `dupes` found only after the allowlist emptied.
-  - Each case needed a hand-written lane: L5, L6, L7, and a rescoped L4.
-
-  Fix: an `owns_add(run, lane, paths, why)` tool that re-checks overlap. Clone-driven work also needs a "discover, then split" step, because the files are knowable only after the gate runs.
+- **Clone-driven work needs a "discover, then split" step.** L4 (Task 12) stopped on four panel clones that `dupes` found only after the allowlist emptied, and needed a hand-written rescoped lane. `owns_add` (1.5) grows one lane's Owns; splitting work the gate discovers into new lanes is still by hand, because the files are knowable only after the gate runs.
 - **A writer's edits are blamed on the lanes.** The writer role has no lane and no Owns:
   - its record reads "0 owned files changed" after it edited 11 docs;
   - the L4 fix record listed its 7 concurrent doc edits as L4 violations.
 
   Fix: give non-lane roles an Owns (or a docs lane), and attribute each edit to the process that wrote it.
 - **Jev overrode the lane headers.** All four first lanes declared `Kind`/`Difficulty`, and routing replaced them (declared logic → `repo_code`/`copy`), so the logic lanes started on `luna#high`. Fix: a declared header wins, or the route record says why it didn't.
-- **A lane could not declare an allowed exception to its own absence grep.** The plan's `func Allowed` grep also matched an unrelated `services/verification/internal/job/command.go:120`, and `acceptancetest\.SignIn` matched the surviving `SignInAuth` and `SignInSSO`. The workers returned partial correctly, but a check that can never pass looks the same as work that isn't done yet. Fix: an `Allow:` line under the check, and word boundaries in plan greps.
 - **`dispatch` accepted a thread id that doesn't exist.** The orchestrator passed a wrong thread for the L4 fix, the role launched, and codex failed with "no rollout found for thread id". Fix: check `thread` against `runs.jsonl` (same name) before launching, or default to the name's last thread.
 
 **Preflight and environment**
@@ -533,7 +500,6 @@ Run `20260928-172920-m3-auth-plan-5-mr-b-the-kit-clean-up` (sanitell/platform, a
   - `proxy.golang.org` returned EOF inside an image build.
 
   Both came out as a plain FAIL. Fix: a verdict of `BLOCKED: environment`, with the probe that proves it, so the orchestrator surfaces the blocker instead of cycling fix rounds.
-- **The version bump changed the sandbox silently.** Worker records went from `workspace-write, isolated: true` (1.1.0) to `access: full, isolated: false` (1.2.0) with no note in the run. Fix: pin the protocol and the sandbox per run, or log the change in `state.md`.
 
 **Verifier**
 
@@ -541,17 +507,11 @@ Run `20260928-172920-m3-auth-plan-5-mr-b-the-kit-clean-up` (sanitell/platform, a
 - **Lint reached only the verifier.** The workers' fast checks ran `go test`, never `golangci-lint`, so an `unparam` in tokenapi and a `revive` in both services' `audit_names.go` cost a full verifier round of about 43 min. Fix: a lane's fast check includes the linter of every package it touched.
 - **`gate_check` carried nothing across rounds.** The round-2 verifier didn't have round 1's item names, so every item ran again. Fix: `gate_check` lists the milestone's recorded items, and the verifier reuses their names.
 
-**Ledger and knowledge**
-
-- **`land` accepted inexact verifier names.** M2 landed with verifier records named `verifier-M2-pre`, `-gate1` and `-gate3`, with no exact `verifier-M2` row. Its ledger minutes (1689) counted the whole paused night. Fix: match the name exactly, and subtract the pauses.
-- **`knowledge.md` is keyed by worktree path.** Every worktree (`dev-registry`, `auth-verification`, `auth-kit-cleanup`) is a new repo, so `read_knowledge` for M3 was empty although M1 and M2 wrote `learned`. Fix: key by the git origin.
-
 **Resume (2026-09-29)**
 
 - **A "foreground" verifier is still a background agent.** On the resume, the orchestrator briefed the verifier to stay in the foreground, and the Agent tool launched it async anyway ("Async agent launched successfully"). The verifier can block inside its own turn, but the main thread only learns the verdict from a notification. Fix: the skill says so plainly, and `protocol.next` treats the verifier as a dispatched role whose result arrives as a message, not as a call that returns.
 - **`status` shows a stale verifier step as live.** After the round-2 verifier was gone, `status` and `peek` still reported `verifier: {item: "acceptance notification", at: 10:04:03Z}`, with no process running. They also listed the previous owner session as `live: true` after a new session had taken the run. `gate_check` records a step, but nothing ends one. Fix: close the step on `gate_pass`, on `record_agent_run(role: verifier)`, or when the owning session is gone, and show its age.
 - **`state.md`'s Next outlives the step.** It still read "dispatch M3.L1 at codex:gpt-6-sol#medium on a fresh thread" ten hours after that dispatch ended ok (L1 attempt 3, 23:55). Fix: `result()` of the named dispatch clears or advances Next.
-- **The profile is not pinned per run either.** The active profile changed from the codex one to `just-claude` while M3 was paused, so the run's verifier rung changed (`catherd-default-verifier-*` is gone and `catherd-just-claude-verifier-claude-opus-5-5-low` took over), and any re-dispatched lane would route on Sonnet instead of the Codex rungs it started on. Nothing in the run records the switch. Fix: same as the sandbox item: pin the profile at `run_start`, or log the change in `state.md`.
 - **A host probe needs to run twice.** Right after the AnyConnect VPN was disconnected, the first unsigned Go probe to `203.0.113.20` still got `no route to host`. The next seven, including one from a freshly built binary on a fresh network, answered 200. A single probe would have stopped the run for nothing. Fix: when catherd ships a host probe, it retries once after a few seconds before calling the host blocked.
 
 - **An isolated headless worker cannot read its lane file.** worker-M4.L1 (`claude-code`, `isolated: true`) was told "your lane file is lanes/M4.L1.md in the run" and replied "I couldn't find `lanes/M4.L1.md` on disk, so I worked from your summary". It guessed its Owns from the brief and edited four files the lane file did not list, which came back as violations (`directory.go`, `internal_test.go`, two Dokploy READMEs). All four were right to edit, but only because the brief happened to be detailed. Fix: `dispatch` inlines the lane file (Owns, Fast check, body) into the brief, or passes its absolute path and grants read access to the run folder.
@@ -561,25 +521,12 @@ Run `20260928-172920-m3-auth-plan-5-mr-b-the-kit-clean-up` (sanitell/platform, a
 
 catherd 1.2.1, profile just-claude, sanitell/platform payment plans 1–11. That is eleven runs, one per plan and its worktree, from `20260929-113331` (plan 1) to `20260929-145705` (plan 11). The run ended with eleven MRs merged to staging (!59–!62, !64–!70). Evidence lives in each run folder: `runs.jsonl`, `agents.jsonl`, the lane files and the role records.
 
-**Programs span runs**
-
-- **One run per worktree, and nothing links them.** Each plan had its own worktree, so it needed its own run with a lone `M1`. The program's order lived only in the orchestrator's head:
-  - 1, 2 and 4 in parallel;
-  - 3 after 2;
-  - the chain 5→11.
-
-  Nothing models "M1 of run B needs M1 of run A merged", and after each merge the stack had to be rebased by hand. Fix: a program or run group with cross-run `After:` edges.
-- **One environment blocker took three parks.** A VPN took the default route and blocked every run. `park` is per run and per milestone, so it took three parks and three pushes. Fix: a machine-level or group-level "paused: environment" state.
-- **Two verifiers at once starve each other.** Plan 2's and plan 4's verifiers ran side by side. Plan 4's vitest ran next to a `task check` and hit six 5000 ms timeouts in files the diff does not touch. The lock's heavy slots let the two overlap, and catherd has no view of the machine across runs.
-
 **Routing and dispatch**
 
 - **`route` bloats the orchestrator.** Every call returns the full provenance block, about 3k tokens per lane, into the most expensive context of the run. Fix: return rung, ladder, backend and agent, and write provenance to `R/routes.jsonl`.
 - **Ladders were inverted on just-claude.** `Difficulty: build` lanes got the ladder [sonnet#high] with no room to climb (source `jev-kind`). `logic` lanes started lower, at sonnet#medium. Every claude-code value in provenance was `inferred` from a gpt-6-sol benchmark. Evidence: the first four routes of runs `-113331`, `-113334` and `-113338`.
 - **`dispatch` needs a rung it then overrides.** `rung` is required, even when the lane is not routed yet. The orchestrator guessed a rung, and dispatch overrode it with a hint. Fix: make `rung` optional on a lane dispatch.
 - **The catherd message does not carry the thread id.** Passing the dispatchId gave `E_ADMIT_THREAD`. Every fix round needed `jq … runs.jsonl`. Fix: put `thread:` in the message's first line, or accept `thread: "latest"`.
-- **Lane values are refused only at preflight.** `Difficulty: medium` (the word plans use) was refused as `E_LANE_INVALID` at preflight, not when `write_run_file` wrote the lane. Evidence: run `-135414`.
-- **There is no `lane_set`.** Fixing one header line (a fast check without `pnpm check`, or an Owns path) meant `sed` on the run folder. Evidence: runs `-113331` and `-143512`.
 
 **Preflight**
 
@@ -707,10 +654,6 @@ owner turned isolation off (the host is itself a sandbox).
 - **Only worker dispatches leave a route record.** `routes.jsonl` has 11 entries for 34 dispatches. The writer,
   researcher, reviewer, verifier and architect rungs (for example writer on Luna high instead of the ladder's first
   rung) cannot be audited. Fix: `route` and `dispatch` record every role's decision, its source and the ladder.
-- **A superseded run stays open.** Planning run `20261002-002615-…` (main checkout) handed over to the execution run
-  in the worktree, because there is one run per worktree. It still lists as `idle`, with
-  `Protocol next: route and preflight M1's lanes`. Fix: `runs supersede <run> --by <run>` (or a field set by
-  `run_start` with a `from:` line) closes it with a pointer, and `status` hides it.
 - **doctor misses a Docker client that injects proxies.** `access:codex` passed `docker version`, but
   `~/.docker/config.json` had a `proxies` block, so every container got `HTTP_PROXY`. That broke a compose stack's
   internal names (`minio-buckets` could not reach `minio`) and a BusyBox `wget` loopback health check
@@ -818,9 +761,6 @@ owner turned isolation off (the host is itself a sandbox).
 
 ## Orchestration
 
-- **A per-milestone digest.** One screen per landed milestone: A-lines met, commits, climbs, open findings, time and
-  tokens. The push notification links it. _Why:_ the user asked "where is it" about 8 times in one run; the milestone
-  push answers when, and the digest answers what. _Where:_ `land` writes it into the run folder; `watch` shows it.
 - **Milestone per branch.** A real multi-MR build wants one branch and one MR per milestone, some in parallel. `land`
   only commits. _Where:_ an optional `branch` on milestones, and a finish step that opens the MR through the repo's
   own tooling.
````

## After the plan

- The full gate on the combined head. Then the final review (CLAUDE.md), with the Review Focus above.
- Copy the ledger to `docs/handoff/plan25-ledger.md` and update `docs/handoff/HANDOFF.md`. No changeset (plan 27).
