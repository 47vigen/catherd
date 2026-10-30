# Plan 55: per-writer worktrees and merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec D5 on stage 2: in a run with a base, every writing task works in its own worktree cut from the run's
branch, catherd merges finished work back one merge at a time (its fast check run in the task's tree, an oracle change
held at the merge), and the seams plans 53 and 54 left for D5 move to their D5 places, while a profile switch keeps
stage 1's shared tree for the O7 comparison and the revert.

**Architecture:** The run's tree (`trees/run`, on the run's branch) is the integration tree. `delegate_task` places a
writing task: its own tree (`trees/<T>`, branch `catherd/<run>/<T>`), a retry's continuation of the last unmerged tree,
another task's tree, or the run's tree; the choice is `task.delegated.tree`. The start effect makes the tree and runs
the dispatch in it; the end checkpoints it under `refs/catherd/<run>/<owner>/<n>`. A task in its own tree that ends
complete gets a `merge.requested` from catherd in the same write as its `dispatch.ended` (plan 53's pattern); the
machine runs merges one at a time; `runMerge` commits the tree, holds an oracle change, merges the run's branch in
(regenerable paths keep the run's side), runs the fast check there (`check {ref: T}`), fast-forwards the run's branch,
removes the tree and tells every running writer what landed, with the paths a writer would now conflict in. A conflict
or a red check goes back to the same writer as a new task with `cause`.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod, `bun:test`, git ≥ 2.38 (`merge-tree --write-tree`); `web/` only for the
regenerated OpenAPI types.

**Spec:** `docs/specs/2026-10-27-architect-led-runs-design.md` — "### Worktrees" (D5), with D3 (`delegate_task
{worktree, from}`, `check {ref}`, `merge`), D6 (the fast check "in the task's tree at merge time"), D9 (the hold "a
merge whose diff changes an oracle path"), D10 (a new integration commit is news), D11 (landing) and "## Migration" item
17 (stage 2 is measured against stage 1; "If isolation does not reduce blocked minutes, it is reverted (O7)").

**Seams this plan closes:** plan 53 R1 and R8 (the fast check on the shared tree; no `check {ref}`), plan 54 R1 and R2
(the oracle diff is the task's window, not its author), and the matching `docs/dev/ideas.md` entries.

**Pre-validated:** every task was built test-first in `.superpowers/plan55-scratch` from `main` 86daa039; Tasks 3 and 4
were built on Task 1 alone and merged onto Task 2 to prove the wave. The scratch commits follow this plan's commit on
this branch, one per task, in task order. Full gate and the panel's gate green on the final head (2160 pass, 13 skip,
0 fail; web 335 pass).

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`).
- Tests never wall-clock sleep for correctness; spawned processes get an explicit `env` with `ANTHROPIC_API_KEY: ""`.
- No personal hosts or infrastructure names in the repo; evidence is "a real scorecard run".
- Fewer code comments: one line for a why the code cannot show.
- Commits: conventional, subject ≤ 100 characters, lower-case first word, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`.
  Task 1 regenerates `web/openapi.json` (`bun run panel:openapi`) and `web/src/client/types.gen.ts` (`cd web && bun run
  gen`), never by hand, so it also runs the panel's gate in `web/`.
- Known env-only failures on a Mac: the Codex-only doctor timeout, a timing test in `preflight.test.ts`, a load flake
  in `plan-input.test.ts` (rerun it alone).
- Old runs replay unchanged: every new event field is optional; `run.started` without `trees` is a shared-tree run.
- Changesets are `minor` while the line is `2.0.0-next.*` (spec Migration 16).

## Rulings

- **R1 — isolation is a pinned profile switch, `trees: "writer" | "shared"`, default `writer`.** `catherd profile set
  trees shared` puts a run's writers back on stage 1's one tree; `run.started.trees` pins it (a run without a base is
  always `shared`: the owner's checkout has no branch to merge into). Spec C ("isolation only for lanes the architect
  marks risky") is rejected for two code paths; this is not that: the shared path is stage 1's code, already needed
  for runs without a base, and the switch is per run, not per task. — O7 says the stage is reverted if blocked minutes
  do not fall; a switch lets the same tasks run both ways (Migration 17's per-task comparison) and reverts without a
  code revert. — Cost if wrong: two placements stay until the O7 verdict; delete the losing one then.
- **R2 — blocked minutes stay stage 1's metric, and D5's own cost joins it.** A dispatch of a task catherd sent back
  after a merge counts in `blockedMin` under `merge_conflict` or `merge_red` however it ended (`MetricDispatch.rework`).
  No schema change. — A stage-1 `check_broken` was a writer waiting on a sibling; its stage-2 counterpart is the rework
  after a conflict or a red merge. Leaving rework out would make isolation look free. — Cost if wrong: a rework that
  also had other news counts whole; the comparison overstates D5's cost, which errs toward reverting.
- **R3 — which tree.** Writing roles (worker, writer, artist) default to a new tree; a retry on the same ledger task
  continues in the last attempt's tree while it is unmerged and free (spec: "continues from the last attempt's snapshot
  by default"; the tree itself still holds that work, so nothing is copied); `from: "clean"` starts a new tree;
  `worktree: "task:<id>"` joins an unmerged task's free tree; `worktree: "integration"` is the run's tree. Readers
  (reviewer, verifier, researcher) run on the run's tree and are refused a tree of their own; spec D5 "read-only roles
  get no tree" — they read a ref with git, as plan 51's review snapshots already do. A `thread_send` follow-up keeps its
  task's tree (a new one once merged). — Cost if wrong: a docs writer that wanted the shared tree pays one tree setup.
- **R4 — a tree is cut from the run's branch as last committed,** never from the run's tree's uncommitted files. The
  architect's contract says to commit its own edits before delegating work that needs them. — Committing the
  integration tree at each cut would commit a running writer's or verifier's half-state there. — Cost if wrong: one
  architect turn; in `ideas.md`.
- **R5 — catherd commits a writer's tree at merge; the worker contract's "Do not commit" stays.** The brief of a task
  in its own tree says to leave the work uncommitted, and that catherd commits, merges and checks it. A conflict sent
  back says to run `git merge <branch>`, resolve, and leave it uncommitted: catherd's `add -A && commit` concludes the
  merge. — The [walls] cause was "workers cannot commit, so a HEAD-reading check never sees their work"; catherd
  committing before the check removes it without changing a shared contract. — Cost if wrong: none; a writer that
  commits anyway is merged the same way.
- **R6 — catherd merges a task that ended complete, at once; `merge {taskId}` is the architect's for the rest.**
  Spec D5: "The daemon merges a finished task … after that task's fast check passes on the merged result"; D3 lists
  `merge`. `settle` appends `merge.requested {by: "catherd"}` under the same events lock as `dispatch.ended`
  (`mergeFor`, plan 53 R4's pattern), and `fastCheckFor` gives a task in its own tree none: its fast check runs in the
  merge (`check` id `<M>-fast`, a `checks` row with `scope: "fast"`, so plan 53's `fastCheckShare` counts it). The
  architect calls `merge` for a partial task, after an `oracle_accept`, or after it fixed a tree. — Cost if wrong: a
  task the architect wanted to hold back merges; it can send a fix.
- **R7 — merges run one at a time, in the order asked.** The machine issues the first queued merge only; a full check
  without `ref` waits while a merge or a catherd fast check is queued (plan 53's hold, widened). A full check with a ref
  never waits. — The fast-forward needs the run's branch to stand still between the merge-in and the move. — Cost if
  wrong: a merge waits for the one before it, about a fast check's length.
- **R8 — a conflict or a red check goes back to the same writer, by catherd.** `sendBack` delegates a new task with
  `cause`, `by: "catherd"`, the same role, rung, check, oracle, tree and thread (a thread-less backend reads the tree's
  first brief again under the merge's text); the attempts cap and the stall rule apply as to any delegation, and a
  refusal is named in the merge's digest line ("could not send it back … send it back or replan"). `by: "catherd"` is
  the architect's for waking. — Spec D5: "goes back to the same writer's thread with the conflict list … and the
  architect gets the event". — Cost if wrong: a loop of red merges is bounded by the attempts cap (4).
- **R9 — the oracle rule moves to the merge (closes plan 54 R1, R2).** `runMerge` diffs the task's own commits
  (`merge-base HEAD <run branch>` to `HEAD`) on its oracle paths; a change is `merge.done {outcome: "held", oracle}`,
  which sets the task's `oracle` hold as plan 54's `dispatch.ended.oracle` did; `oracle_accept` releases it and the
  architect merges again. A task in its own tree takes no delegation snapshot and no `dispatch.ended` diff, and land's
  `unreleasedOracles` skips held tasks in their own trees (an unmerged change is not in HEAD by construction). One
  accept in a tree covers that tree's next merge. — D9's wording: "A merge whose diff changes an oracle path …
  authored by that task's writer". — Cost if wrong: a writer that edits the oracle again after an accept merges it;
  the MR still lists the override.
- **R10 — `check {ref}` (closes plan 53 R8).** A ref is resolved when the tool is called: a task id with an unmerged
  tree checks that tree; anything else must name a commit (`rev-parse --verify <ref>^{commit}`) and is stored as its
  full sha, checked in a detached tree set up as the base's is. A pass is cached by the sha. `base` and `ref` together
  are refused. Land's `greenFull` reads the row's `ref`, so a green full check on the pushed sha counts. — A full check
  on the run's branch head then runs beside the writers and merges. — Cost if wrong: a ref check pays a tree setup.
- **R11 — checkpoints at every writer dispatch's end only.** `settle` snapshots the tree (plan 51's alternate-index
  recipe) and `update-ref`s it before `dispatch.ended`, which carries the ref and the digest names it. No two-minute
  timer: a tree stays on disk until it merges, so a kill or a timeout loses nothing the end's checkpoint misses. `from`
  takes only `clean`. — Cost if wrong: a rewind to a mid-attempt state needs a hand-made ref; in `ideas.md`.
- **R12 — after a merge, the completed-change notice and predicted conflicts.** Every working worker, writer or artist
  gets one `queue` notice from `catherd`: the task, the run's branch, the sha and up to 20 files; a writer in its own
  tree is also told the paths `git merge-tree --write-tree --name-only` predicts against a snapshot of its tree (no
  tree touched). A failed send is logged. — Spec D5, both bullets. — Cost if wrong: a notice per writer per merge; plan
  53's notice already reaches every role.
- **R13 — regenerable paths are the profile's `regen {paths, command}`.** The merge passes `-c core.attributesFile=<run
  dir>/trees/regen.attributes -c merge.regen.driver="cp %B %A"`, so no repository config or attribute file changes;
  when both sides changed a regen path, `command` runs in the task's tree under a heavy slot (Setup:'s limit) and its
  result is committed; a failing command is a red merge. — Spec D5 names the profile or the repo; the profile already
  carries `fastCheck`. — Cost if wrong: a profile shared by repos lists one set; in `ideas.md`.
- **R14 — the writer cap stays 4, not memory-bound.** Spec D5 applies plan 35's milestone memory to writers; that is a
  free-memory read in admission plus a wait, and stage 2 has not measured a tree's memory yet ([box]: contention 3–5%).
  — Cost if wrong: four trees on a small box; in `ideas.md`.
- **R15 — trees and refs outlive the run.** A merged tree and its branch are removed at the merge; an unmerged one and
  every checkpoint ref stay, as the run's own tree does. — Removing an unmerged tree at the run's end would drop work
  the checkpoint holds only as a commit nobody looks for. — Cost if wrong: disk (~50 MB a tree); in `ideas.md`.
- **R16 — the run's tree is claimed once at a time.** With writer trees, the architect's first turn and a task's start
  claim it together; `claimRunTree` shares one in-flight claim per run (the race showed as "cannot lock ref" in the
  Task 5 daemon test).
- **R17 — a tree with a queued or running merge is busy (review C1).** `treeBusy` counts a merge in `queued` state
  (until its `merge.done`); `treeOf` and `continuedTree` fall back to a new tree, `worktree: task:<id>` and a
  `thread_send` follow-up to a task whose tree waits to merge are refused ("its merge result wakes you"), and catherd's
  own send-back is the one task allowed in (`viaMerge`). `runMerge` looks once more under the events lock right before
  the fast-forward and refuses, keeping the tree, when a task was delegated into it after `merge.requested`; `merge.done`
  marks merged only the tasks delegated before that seq. — A follow-up resumed in a new tree would lack the thread's
  own work. — Cost if wrong: one wait for a merge result.
- **R18 — a merge never commits what its own check left (re-review).** The fast check runs in a clean tree (everything
  was committed and the run's branch merged in), so any untracked file after it is the check's. `runMerge` records the
  untracked files before the merge-in and the check; when the check leaves new ones, or leaves the tree otherwise
  unclean, the merge is refused (the tree is kept), and under the events lock, once no task was delegated into the tree,
  `git clean -f` removes exactly those files, so "merge again" cannot commit them with `add -A`. A check that always
  leaves files therefore never merges until they are ignored or the check cleans up: the digest says so. Tracked files
  a check changed stay as the writer's to commit or restore. The lock is never held for the tree's removal: the
  fast-forward is under it, the removal after it (the merge is queued still, so no delegate joins). — Cost if wrong: a
  project whose check builds into an untracked directory needs a `.gitignore` line. A red check gets the same sweep
  (re-review 2): under the events lock, when no task was delegated into the tree after `merge.requested`, the files
  it left are removed before the send-back goes out, so the writer does not inherit them and the next merge does not
  commit them.
- **R19 — a task-ref check and that tree's merge never run together (re-review 2).** A `check {ref: <task>}` runs in
  the writer's live tree, which a merge changes and then removes. `architectNext` orders them by their request seq
  (`ArchCheck.seq`, `treeRaced`): a queued check waits while a queued merge of the same tree was asked for earlier, and
  the queue's head merge waits while an earlier task-ref check of its tree is queued; the other goes when the first is
  done, so neither can wait on the other. Commit-ref checks, checks of other trees and the fast check inside a merge
  are unaffected. A task-ref check that runs after the merge finds no tree: it checks the commit the merge
  fast-forwarded to (`mergedRef`), as a commit ref would; before, it failed on the missing directory. — Cost if wrong:
  a check waits for a merge's fast check (minutes).

## Review Focus

- **A daemon restart while a merge runs:** the merge action is issued again (no `merge.done`); `runMerge` must be safe
  to repeat: a tree left mid-merge by a killed git, or a run's branch already fast-forwarded. Reviewer: confirm the
  `commit` step concludes a leftover `MERGE_HEAD` and a repeated fast-forward is a no-op; a removed tree is `refused`
  ("tree is gone"), not a crash.
- **The architect edits the run's tree while a merge's check runs:** the fast-forward carries non-overlapping
  uncommitted files and refuses overlapping ones with a message to commit them (Task 5's `refused`). Reviewer: confirm
  no path resets the run's tree.
- **A run an earlier build started, or a `trees: shared` run:** `task.delegated` has no `tree`, nothing is merged, plan
  53's fast check and plan 54's dispatch-end oracle diff run as before. (The existing architect-effects, oracle and land
  tests run without the fields.)
- **A task cancelled while its merge is queued, or a run that finishes:** the machine stops issuing merges once
  `finishing`; `sendBack` is skipped when the run is stopping. Reviewer: confirm `mergeFor` and the effect's guard.
- **A writer that leaves conflict markers and ends complete:** catherd commits them; the fast check, when there is
  one, goes red and sends it back; without one, the markers merge. Reviewer: judge whether a marker grep belongs before
  the commit (`git diff --check` exits 2 on markers) — not built: the profile's `fastCheck` is the gate D6 names.

## Parallelism

Wave 1: Task 1 (domain; everything below reads its events and state). Wave 2: Tasks 2, 3 and 4 at once (2 places and
starts tasks; 3 is `check {ref}`; 4 is the metric). They share `src/services/architect-tools.ts`,
`src/domain/role-prompts.ts`, `test/services/architect-tools.test.ts` and `test/domain/architect-trees.test.ts` in
separate hunks: Task 2's tool tests go before "delegate_task records a task's fast check…", Task 3's at the end of the
file's first `describe`, Task 3's domain test at the end of `architect-trees.test.ts`. The scratch merge of 3 and 4 onto
2 was clean. Wave 3: Task 5 (the merge; it reads 2's trees and 3's task-ref check). Wave 4: Task 6 (after-merge and
docs, in `merge.ts`). Gate once per wave.

---

### Task 1: writer trees in the run's state: the pin, the merge events, one merge at a time

**Files:**
- Modify: `src/domain/caps.ts` (`TREE_MODES`, `TreeMode`), `src/domain/profile.ts` (`ProfileDocSchema.trees`,
  `.regen`; `Profile.trees`, `Profile.regen`, `Regen`, `regenOf`; `resolveProfile`; `ProfilePatchSchema.trees`,
  `.regen`), `src/services/ports.ts` (`ProfileView.trees?`, `.regen?`), `src/services/profile-service.ts` (`viewOf`),
  `src/services/run-client.ts` (`run.started.trees`), `src/domain/run-events.ts`, `src/domain/run-state.ts`,
  `src/domain/architect-state.ts`, `src/domain/run-machine.ts`, `src/domain/architect-machine.ts`,
  `src/services/tree-path.ts`, `web/openapi.json`, `web/src/client/types.gen.ts` (regenerated)
- Create: `test/domain/architect-trees.test.ts`
- Test: `test/domain/profile.test.ts`, `test/services/profile-service.test.ts`, `test/services/run-client.test.ts`,
  `test/domain/run-fixtures.ts` (`endDispatch` takes `checkpoint?`)

**Interfaces:**
- Produces (domain): `TREE_MODES = ["writer", "shared"]`; `Profile.trees: TreeMode` (unknown value → `writer`),
  `Profile.regen?: { paths: string[]; command: string }` (both trimmed and non-empty, else absent); patch
  `trees: z.enum(TREE_MODES).nullable().optional()`, `regen: strictObject({paths: string().trim().min(1)[] min 1,
  command: string().trim().min(1)}).nullable().optional()`.
- Events: `run.started.trees?`; `task.delegated.tree?: string` (the owner task id), `.cause?: "conflict" | "red"`
  (`MERGE_CAUSES`); `dispatch.ended.checkpoint?: string`; `merge.requested {mergeId, taskId, by, why}`; `merge.done
  {mergeId, taskId, outcome: "merged" | "conflict" | "red" | "held" | "refused" (MERGE_OUTCOMES), sha: string | null,
  files: string[], message, oracle?: {paths, diff}}`; `ACTION_TYPES` gains `"merge"`; `describeEvent`:
  `` `${by} asked to merge ${taskId} (${mergeId}): ${why}` `` and `` `merge ${mergeId} of ${taskId} ${outcome}: ${message}` ``.
- State: `RunState.trees: TreeMode` (`"shared"` when absent); `ArchTask.tree: string | null`, `.merged: boolean`,
  `.cause`, `.checkpoint: string | null`; `ArchMerge {mergeId, taskId, by, state: "queued" | "done"}`;
  `ArchState.merges`. Action `{type: "merge"; mergeId}` (key `merge:<id>`, unit the id, confirmed by `merge.done`).
- Functions: `nextMergeId(a) = M<count+1>`; `continuedTree(a, ledgerTask): string | null` (the latest non-refused task
  on it with a tree, by `delegatedSeq`, when not merged); `treeBusy(a, tree): boolean` (a queued or working task in
  it); `mergeFor(s, end): {mergeId} | null` (the task has an unmerged tree, is `working`, ended `ok/complete`, the run is
  not ended, cancelling or finishing); `fastCheckFor` returns null for a task with a tree.
- Paths (`tree-path.ts`): `taskTreeDir(run, owner) = <run>/trees/<owner>`, `taskReadyFile = <run>/trees/<owner>.ready`,
  `taskBranch(run, owner) = catherd/<run.id>/<owner>`, `checkpointRef(run, owner, n) = refs/catherd/<run.id>/<owner>/<n>`.

- [ ] **Step 1: Write the failing tests**

`profile.test.ts`, "reads where a base run's writers work, writer trees by default, and a regen with paths and a
command (plan 55)": no key, `"shared"` and `"lanes"` give `writer`, `shared`, `writer`; `regen: {paths: [" bun.lock ",
""], command: " bun install "}` gives `{paths: ["bun.lock"], command: "bun install"}`; no command, or no path, gives
`undefined`; `patchAt("trees", "shared")` is `{trees: "shared"}`.

`profile-service.test.ts`, "sets where writers work and what a merge regenerates, gives both to the view, and removes
them with null (plan 55)": the view starts `trees: "writer"`, no `regen`; after `set({trees: "shared", regen})` both are
in the view; after `set({trees: null, regen: null})` it is `writer` and no `regen`.

`run-client.test.ts`, "pins where the run's writers work: the profile's for a base run, the shared checkout without one
(plan 55)": over `repoWithOrigin()`, `runStart` with `base: "main"` pins `trees: "writer"`, then `"shared"` after
`deps.view.trees = "shared"`; without a base it pins `shared` even with the view on `writer`.

`architect-trees.test.ts`, describe "writer trees in the architect's state (plan 55, spec D5)", over a log with
`run.started {base: "main", trees: "writer"}` and a `work(log, taskId, {tree?, ledgerTask?, check?})` helper that
delegates and starts a worker:
- "pins where writers work …": `trees` is `writer`; a `run.started` without the field replays `shared`.
- "merges a task in its own tree when it ends complete, and fast-checks a task on the run's tree as before": T1 (tree
  T1, check) → `mergeFor` `{mergeId: "M1"}`, `fastCheckFor` null; `partial` → null; T2 (no tree, check) → `mergeFor`
  null, `fastCheckFor` has its command; after a `merge.requested` M1 the next is `M2`; after `run.finishing` null.
- "runs merges one at a time in the order asked, and holds a full check until they are in": M1 and M2 queued and a full
  C1 → the merge actions are `[M1]` and no `runCheck C1`; after M1's `merge.done` → `[M2]`; after `effect.failed
  {action: "merge", unit: "M2"}` → none, and `runCheck C1` is issued.
- "marks every task of a merged tree merged, wakes the architect, and counts the merge as news": T1 and T2 share tree
  T1; `merge.done` merged for T2 → both `merged`, `newsSeq` is that event's seq, the inbox's last item is `{text: "M1
  (merge of T2) merged: merged at bbbbbbbbbbbb: 1 file", wakes: true}`, and `describeEvent` is `"merge M1 of T2 merged:
  merged at bbbbbbbbbbbb: 1 file"`.
- "holds a merge that changed the task's oracle until the architect accepts it": `merge.done` held with `oracle` →
  `T1.oracle` is `{paths: ["test/pay.test.ts"], diff: "tasks/T1/oracle.diff", accepted: null}` and `merged` false.
- "continues a ledger task's next attempt in its last unmerged tree, and starts a new one after a merge":
  `continuedTree(L1)` null, then T1's tree once T1 ended (`treeBusy(T1)` true while it works, false after); a task on
  the run's tree gives null; after a merged `merge.done` null again.
- "wakes the architect when a task catherd sent back ends, and names the end's checkpoint": a `task.delegated {by:
  "catherd", cause: "conflict", tree: "T1"}` → `cause` set; its `dispatch.ended {checkpoint}` → `T1.checkpoint` and a
  waking inbox line containing `checkpoint refs/catherd/r/T1/1`.

- [ ] **Step 2: Run them to verify they fail** — `bun test test/domain/architect-trees.test.ts test/domain/profile.test.ts
  test/services/profile-service.test.ts test/services/run-client.test.ts`: FAIL (no `mergeFor`, no `trees`).

- [ ] **Step 3: Implement**

- `resolveProfile`: `trees: TREE_MODES.includes(doc.trees) ? doc.trees : "writer"`, `...(regenOf(doc) ? {regen} : {})`
  (`ProfileDocSchema.trees` is `z.unknown()` and `regen` a loose object of unknowns, so a hand edit never breaks the
  file); `viewOf` passes both. `runStart`: `trees: i.base ? (runProfile(deps, run).trees ?? "writer") : "shared"`.
- `architect-state.ts`: the reducer cases above; `merge.done` merged sets `newsSeq` and marks every task whose `tree`
  equals the merged task's; the digest line is `` `${mergeId} (merge of ${taskId}) ${outcome}: ${message}` ``,
  waking, with no `taskId` (a `task.read` must not drop it); `dispatch.ended` appends
  `` `, checkpoint ${ref}` `` to the `ended …` part; `byArchitect` counts `"catherd"`; `idleNow` counts queued merges;
  `effect.failed` for `merge` sets that merge done.
- `architect-machine.ts`: `pending` = a queued merge or a queued catherd fast check; a full check waits while
  `pending`; then `const merge = queuedMerges[0]` pushes `{type: "merge", mergeId}` (before the pause return, as checks
  and lands are).
- Regenerate the OpenAPI document and the panel's types.

- [ ] **Step 4: Verify** — the Step 2 files and `test/entry/panel-openapi.test.ts` pass; `bun run typecheck && bun run
  lint && bun run format:check`; the panel's gate in `web/`.

- [ ] **Step 5: Commit** `feat: writer trees in the run's state: the pin, merge events, one merge at a time`

### Task 2: each writing task works in its own worktree, checkpointed when it ends

**Files:**
- Create: `src/services/writer-tree.ts`, `test/services/writer-tree.test.ts`
- Modify: `src/services/architect-tools.ts` (`delegate`, `treeOf`, `WORKTREE`, `delegate_task`'s shape, `thread_send`'s
  resume, `task_status`, `capabilities`), `src/services/run-effects.ts` (`start`, `settle`, `endedEvent`),
  `src/services/architect-run.ts` (`taskBrief`), `src/domain/role-prompts.ts` (`ARCHITECT_LOOP`'s `delegate_task` line)
- Test: `test/services/architect-tools.test.ts`, `test/services/base-run-dispatch-cwd.test.ts`,
  `test/services/architect-run.test.ts`

**Interfaces:**
- Consumes: Task 1's events, `continuedTree`, `treeBusy`, the `tree-path.ts` helpers.
- Produces: `claimTaskTree(deps, run, owner): Promise<string>` (the dir); `removeTaskTree(run, owner): Promise<void>`;
  `checkpointTree(run, owner, n): Promise<string | null>` (the ref); `delegate_task {…, worktree?: "new" | "integration"
  | "task:T<n>", from?: "clean"}`; `delegate`'s input gains `worktree?`, `from?`, `cause?`; `endedEvent(run, record,
  unit, oracle = null, checkpoint: string | null = null)`; `task_status.tree: {branch, merged, checkpoint} | null`;
  `capabilities.trees`.

- [ ] **Step 1: Write the failing tests**

`writer-tree.test.ts`, describe "a writer's own worktree (plan 55, spec D5)", over `branchRun("wallet")`:
- "cuts it from the run's branch as last committed, on a branch of its own, and finds it again": a committed `a.txt`
  and an uncommitted `b.txt` in the run's tree → the new tree is `taskTreeDir(run, "T1")` on `taskBranch(run, "T1")`
  at the run's HEAD, has `a.txt`, not `b.txt`; a second claim returns the same dir with the writer's file in it.
- "makes a half-made tree again …": a `trees/T2` dir with a junk file and no ready mark → claimed fresh, junk gone.
- "checkpoints the tree under a ref, untracked files in and the index untouched, and keeps the ref after removal": an
  untracked `new.txt` → `checkpointTree(run, "T1", 1)` is `refs/catherd/<run.id>/T1/1`, `git show <ref>:new.txt` is
  `untracked`, `git status --porcelain` is still `?? new.txt`; after `removeTaskTree` the dir and branch are gone and
  the ref still shows the file; a second checkpoint with no tree is null.

`architect-tools.test.ts`, before "delegate_task records a task's fast check…":
- "delegate_task puts a writing task in its own tree, continues a retry in it, and gives readers none (plan 55, spec
  D5)": a `branchRun` with `run.started {base: "main", trees: "writer", caps: {wallMin: 720, attempts: 9}}` and ledger
  L1. A worker on L1 → `tree: "T1"`; `worktree: "integration"` → no `tree`; a reviewer → none; a reviewer with `worktree:
  "new"`, a worker with `worktree: "task:T9"`, and `task:T1` while T1 is queued are `E_INPUT_INVALID`; a second L1
  worker while T1 is queued → `T4`. After T1 and T4 end (threads `th-T1`, `th-T4`): an L1 worker continues in `T4`;
  `thread_send {to: "T1"}` resumes as T6 with `tree: "T1"`; an L1 writer with `from: "clean"` → `T7`; `worktree:
  "task:T4", from: "clean"` is refused; `capabilities` has `trees: "writer"`.
- "delegate_task refuses a tree of its own on a run whose writers share one (plan 55)": the shared `architectRun()` →
  `worktree: "new"` is refused; a plain worker has no `tree`.

`base-run-dispatch-cwd.test.ts`, "starts a task in its own tree on a writer-trees run, and checkpoints that tree when it
ends (plan 55, spec D5)": a delegated T1 with `tree: "T1"`, `realEffects(...).run` of its dispatch action → the
dispatch's `admit.repo` is `taskTreeDir(run, "T1")`; its `dispatch.ended` has `checkpoint:
refs/catherd/<run.id>/T1/1`, and so does `arch.tasks.T1.checkpoint`.

`architect-run.test.ts`, in "a task's fast check in its brief (plan 53)": "tells a task in its own tree its branch, that
catherd commits and merges it, and where its check runs (plan 55)": the brief contains
`` on branch `catherd/<run.id>/T1`, cut from the run's branch `wallet` ``, `Leave your work uncommitted: when you end
complete, catherd commits it`, and `catherd runs it in your tree, merged with the run's branch, when you end complete`.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement**

- `claimTaskTree`: return the dir when its ready mark and dir exist; else `claimRunTree`, remove any half-made tree,
  its registration and branch (`worktree remove --force`, `rm -rf`, `worktree prune`, `branch -D`), `git worktree add
  --no-track -b <taskBranch> <dir> <run tree's HEAD sha>` from the repo, `setUp(deps, run, dir)`, write the mark.
  `removeTaskTree`: the mark, `worktree remove --force`, the dir, `prune`, `branch -D`. `checkpointTree`:
  `snapshotTree(dir)` then `git update-ref <checkpointRef> <sha>`; null on no dir or a git failure.
- `delegate`: `isolated = replayRun(run).trees === "writer" && run.meta.base`; `ownTree = isolated && (worker | writer |
  artist) && worktree !== "integration"`. Refusals (`E_INPUT_INVALID`), before the lock: `from` or a non-integration
  `worktree` on a run that is not isolated ("this run's writers share one tree (profile trees: shared, or a run without
  a base)"), or for a reader ("a <role> reads the run's tree and gets no tree of its own"); `from` with a worktree other
  than `new`. Plan 54's oracle snapshot only when `!ownTree`. Inside the lock, `tree = ownTree ? treeOf(s, i, id) :
  null`, spread into `task.delegated` with `cause`. `treeOf`: `task:<id>` → that task's tree (refused when absent,
  merged, or `treeBusy`); `new` or `from: clean` → `id`; else `continuedTree` when it is not busy, else `id`.
- `thread_send`'s resume passes `worktree: t.tree === null ? "integration" : t.merged ? "new" : `task:${t.taskId}``.
- `start`: `const tree = s.arch.tasks[a.name]?.tree`; when set, `cwd = await claimTaskTree(deps, run, tree)` before
  `admit`, which gets `cwd` (a claim that throws is the dispatch's `effect.failed`, so the task is refused with the
  message). `settle`: before the lock, `n` = the tasks of that tree with an `endedSeq`, plus one; `checkpoint = tree ?
  await checkpointTree(run, tree, n).catch(() => null) : null`, passed to `endedEvent`.
- `taskBrief`, before the fast-check line, for a task with a tree: ``You work in your own worktree, on branch
  `<taskBranch>`, cut from the run's branch `<runBranch>`; no other task writes in it. Leave your work uncommitted:
  when you end complete, catherd commits it, merges the run's branch into yours, runs your fast check there, and then
  merges your work into the run's branch. A notice that another task merged names its files: run `git merge
  <runBranch>` in your tree when you need that work.``; the fast-check line says "in your tree, merged with the run's
  branch," instead of "on the run's tree".
- `ARCHITECT_LOOP`'s `delegate_task` line names `check?, worktree?, from?` and ends: "In a run with a base, a writing
  task (worker, writer, artist) works in its own worktree cut from the run's branch as last committed (worktree: new),
  and a retry on the same ledger task continues in the last attempt's tree unless from: clean; worktree: task:<id>
  joins that task's unmerged tree, and integration puts it on the run's tree. Readers (reviewer, verifier, researcher)
  read the run's tree. Commit your own edits in the run's tree before you delegate work that needs them."

- [ ] **Step 4: Verify** — the Step 1 files, `architect-effects.test.ts` and `oracle.test.ts` pass; typecheck, lint,
  format.

- [ ] **Step 5: Commit** `feat: each writing task works in its own worktree, checkpointed when it ends`

### Task 3: check a ref: a commit in a tree of its own, or a task's own tree

**Files:**
- Modify: `src/domain/run-events.ts` (`check.requested.ref?`), `src/domain/architect-state.ts` (`ArchCheck.ref?`,
  `isTaskRef`, the reducer, the `check.done` digest), `src/domain/architect-machine.ts` (a ref check never waits),
  `src/services/architect-check.ts` (`refTree`, `execute`), `src/services/architect-tools.ts` (`check`'s `ref`,
  `checkRef`, its description), `src/domain/role-prompts.ts` (the `check` line)
- Test: `test/services/architect-check.test.ts`, `test/services/architect-tools.test.ts` (at the end of the first
  `describe`), `test/domain/architect-trees.test.ts` (at the end)

**Interfaces:**
- Consumes: Task 1's `ArchTask.tree`, `taskTreeDir`.
- Produces: `isTaskRef(ref) = /^T\d+$/`; `ArchCheck.ref?: string` (a full sha or a task id); `check {…, ref?}` →
  `{checkId, ref?}`; `runArchitectCheck` honours `c.ref` (Task 5 calls it with `ref: <taskId>`).

- [ ] **Step 1: Write the failing tests**

`architect-check.test.ts`, describe "a check on a ref (plan 55, spec D3 and D5)":
- "checks a commit in a tree of its own, names it as the result's ref, and reuses a pass on it": with a dirty file in
  the checkout, `test ! -f dirty.txt` on `ref: <HEAD sha>` passes, its row is `{ref: sha, tree: sha}`, a second one is
  `cached`, the same command without ref exits 1, and `checks/ref-<sha12>-C1` is gone after it.
- "refuses a task ref with no tree of its own": `ref: "T3"` rejects with `E_INPUT_INVALID`.

`architect-tools.test.ts`, "check takes a ref: a commit resolved to its sha, or a task with an unmerged tree of its own
(plan 55)": `ref: "HEAD"` returns `{checkId: "C1", ref: <sha>}` and the event has it; `no-such-ref`, `T1` (no task yet)
and `HEAD` with `base: true` are refused one after another (sequential awaits: concurrent rejected calls leave an
unhandled rejection between tests); after a `task.delegated` T1 with `tree: "T1"`, `ref: "T1"` is `{checkId: "C2", ref:
"T1"}`.

`architect-trees.test.ts`, "runs a full check on a commit or a task's tree beside the merges, and names what it checked
(plan 55)": with M1 queued, full checks with `ref` 40×`d` and `T1` are both issued; their passing digest lines start
`C1 (full, on dddddddddddd) passed` and `C2 (full, in T1's tree) passed`.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement**

- `execute`: `commit = c.ref && !c.base && !isTaskRef(c.ref) ? c.ref : null`; `repo = (c.ref && !c.base ?
  refTree(run, c.ref) : null) ?? runTree(run)` (`refTree`: a task ref's `taskTreeDir` of its `tree`, else throws
  `E_INPUT_INVALID`); `sha = c.base ? baseSha(...) : commit`; `detached = sha !== null` replaces every `c.base` that
  chose the detached tree, its setup, the before/after identity and its removal; the detached dir is
  `checks/<base|ref>-<sha12>-<checkId>`; `head = commit ?? state.head`; the row's `ref` is the sha when detached; a
  failing full check's base comparison drops `ref`.
- `checkRef(c, ref, base)`: `base` → refused; a task id → its task (via `taskOf`) must have an unmerged tree; else
  `git rev-parse --verify --quiet <ref>^{commit}` in `runTree(run)` → the sha, or refused "names no commit".
- The `check` line of `ARCHITECT_LOOP` names `ref?` ("or on ref: a commit, checked out apart, or a task id, that task's
  own tree") and adds after the hold: "or give it ref: a commit (the run's branch head) is checked out apart, so writers
  and merges go on beside it, and land final takes a green full check on the commit it pushes."

- [ ] **Step 4: Verify** — the Step 1 files and `test/services/land.test.ts` pass; typecheck, lint, format.

- [ ] **Step 5: Commit** `feat: check a ref: a commit in a tree of its own, or a task's own tree`

### Task 4: count a sent-back task's minutes as merge rework in the blocked minutes

**Files:**
- Modify: `src/domain/run-metrics.ts` (`MetricDispatch.rework?`, `lostReason`), `src/services/run-metrics.ts`
  (`metricsOf`)
- Test: `test/domain/run-metrics.test.ts`, `test/services/run-metrics.test.ts`

**Interfaces:**
- Consumes: Task 1's `ArchTask.cause`.
- Produces: `MetricDispatch.rework?: string` (`merge_conflict` | `merge_red`), read first by `lostReason`.

- [ ] **Step 1: Write the failing tests**

Domain, "counts the minutes of a task a merge sent back as rework by what the merge found, however it ended (plan 55)":
dispatches 0–10 `rework: "merge_conflict"`, 10–14 `rework: "merge_red"` ended blocked `needs_user`, 14–20 blocked
`check_broken` → `blockedMin` is `{merge_conflict: 10, merge_red: 4, check_broken: 6}`.

Services, "names a sent-back task's dispatch rework by its cause, beside stage 1's blocked reasons (plan 55, spec D5)":
T1 (architect's) and T2 (`by: "catherd", cause: "conflict"`) delegated; records T1 0–10 min and T2 10–13 min, both
`ok/complete` (`appendRecord`, `makeRecord`) → `blockedMin` is `{merge_conflict: 3}`.

- [ ] **Step 2–4:** fail, implement (`rework(name)` = `merge_${s.arch.tasks[name].cause}` when set), pass.

- [ ] **Step 5: Commit** `feat: count a sent-back task's minutes as merge rework in the blocked minutes`

### Task 5: merge a writer's tree into the run's branch, its fast check run there

**Files:**
- Create: `src/services/merge.ts`, `test/services/merge.test.ts`
- Modify: `src/services/run-effects.ts` (`settle`'s `merge.requested`, `perform`'s claim and `merge` case),
  `src/services/architect-tools.ts` (`sendBack`, the `merge` tool), `src/domain/role-tools.ts` (`"merge"` after
  `"check"`), `src/services/oracle.ts` (`unreleasedOracles`), `src/services/land.ts` (`WHY_EVENTS`, the audit filter),
  `src/services/run-tree.ts` (one claim at a time, R16), `src/domain/role-prompts.ts` (`delegate_task`'s fast-check
  words, the `merge` line, the `oracle_accept` line)
- Test: `test/services/architect-effects.test.ts`, `test/services/architect-tools.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 (`mergeFor`, `treeBusy`, `nextMergeId`, `claimTaskTree`, `removeTaskTree`, `runArchitectCheck`
  with `ref`).
- Produces: `runMerge(deps, run, m: ArchMerge, checkMs: number): Promise<{done: MergeDone; back: SendBack | null}>`
  with `SendBack {cause: "conflict" | "red"; text: string}`; `sendBack(deps, run, taskId, back): Promise<string>` (the
  new task id); the `merge {taskId, why}` tool → `{mergeId}`.

- [ ] **Step 1: Write the failing tests**

`merge.test.ts`, describe "merging a writer's tree into the run's branch (plan 55, spec D5)", over a `treesRun(seed?)`
(a `branchRun` seeded through `commitInClone`, its run tree claimed, `run.started {base: "main", trees: "writer"}`)
and `worked(run, deps, taskId, {check?, ledgerTask?, oracle?, end?})` (a delegated worker in its own tree, started and
ended `th-<id>`, its tree claimed):
- "commits the tree, checks it merged with the run's branch, fast-forwards the run's branch and removes the tree": T1
  writes `src/a.ts`, check `test -f src/a.ts` → `{outcome: "merged", files: ["src/a.ts"]}`, `sha` is the run tree's
  new HEAD, its last subject `catherd: T1`, the tree is gone, and a `checks` row `M1-fast` has `scope: "fast", exit: 0`.
- "sends a conflict back with its paths, and leaves the run's branch and the writer's tree as they were": seeded
  `a.txt`, the writer writes `mine`, the run's tree commits `theirs` → `{outcome: "conflict", files: ["a.txt"], sha:
  null}`, `back` is `conflict` with `conflicts in: a.txt`, the run's HEAD is unchanged, the writer's file is `mine` and
  its status clean.
- "sends a red fast check back with its failing lines …": check `echo '(fail) wallet balance'; exit 1` → `red`, the
  message has the line, `back.text` starts `Your fast check`, the run's HEAD unchanged, the tree kept.
- "holds a merge whose writer changed its oracle, and merges it once the architect accepts (spec D9)": ledger L1 with
  oracle `test/pay.test.ts` (seeded); the writer skips the test → `{outcome: "held", oracle: {paths:
  ["test/pay.test.ts"], diff: "tasks/T1/oracle.diff"}}`, the diff file has `+it.skip("pays"`, HEAD unchanged; after
  appending that `merge.done` and an `oracle.accepted`, M2 is `merged`.
- "refuses a task on the run's tree, and a tree a task still works in": a working T1 → `refused` with `still works`;
  T9 → `refused`.
- "sends a conflicted task back to its writer as a new task in the same tree (the effect)": the conflict above through
  `realEffects(...).run({type: "merge", mergeId: "M1"})` → a `task.delegated` T2 `{by: "catherd", cause: "conflict",
  tree: "T1", thread: "th-T1", rung}`, the last event a `merge.done` conflict whose message ends `: catherd sent it back
  as T2`, and T2's brief has `conflicts in: a.txt`.

`architect-effects.test.ts`, before plan 53's streaming test, "merges a task in its own tree the moment it ends
complete, its fast check run there (plan 55, spec D5)": a `branchRun` with `trees: "writer"`, a worker T1 with `tree:
"T1"` and check `test -d .git || test -f .git`, the daemon to its end → `merge.requested {mergeId: "M1", taskId: "T1",
by: "catherd"}` at the seq right after T1's `dispatch.ended`, no `check.requested` at all, a `merge.done` merged for T1,
a `checks` row `M1-fast` `{scope: "fast", exit: 0}`, and T1's tree gone. (The sim's `touch` writes in every dispatch,
the architect's turns too, so this test changes no file; `merge.test.ts` covers the content.)

`architect-tools.test.ts`, at the end of the first `describe`, "merge asks for a task's tree to merge, once, and only
when nothing works in it (plan 55, spec D5)": a queued T1 (own tree) is refused; after it ends, T2 (on the run's tree)
is refused; T1 returns `{mergeId: "M1"}` with a `merge.requested` by `architect-1`; a second merge of T1 is refused.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement**

- `runMerge`, in order; each early end is a `merge.done` (`sha: null`, `files: []` unless named):
  1. `refused` unless the task has a tree, not merged, `!treeBusy`, and the dir exists.
  2. A dirty tree: `add -A`, `commit -q -m "catherd: <T>[ (<ledgerTask>)]"`.
  3. Oracle (R9, `heldOracle`): `t.delegatedOracle ?? oracleOf(...)`; none, or an accepted hold in the tree → go on;
     else `merge-base HEAD <run branch>` → `diff --name-only <base> HEAD -- <oracle>` (git failing: the whole oracle);
     paths → write `git diff <base> HEAD -- <paths>` to `oracleDiffFile(T)` and return `held` with `files` and `oracle`,
     message ``it changed <paths>, the oracle of ledger <L> (diff <file>): accept it with oracle_accept and merge it
     again, or send the task back to restore it``.
  4. `git merge --no-edit -q <run branch>` in the tree; failing → the `--diff-filter=U` names, `merge --abort`,
     `conflict` with message `the run's branch conflicts with it in <paths>: catherd sends it back to its writer` and
     `back.text` ``Merging the run's branch `<b>` into your tree conflicts in: <paths>. Run `git merge <b>` in your tree,
     resolve the conflicts, and leave the result uncommitted: catherd commits it and merges again when you end
     complete.``
  5. With `t.check`: `runArchitectCheck` on `{checkId: "<M>-fast", scope: "fast", ref: <T>, …}`; a non-zero exit
     whose failures are not all pre-existing → `red`, message `` its fast check in its tree, merged with the run's
     branch, `<cmd>` failed (exit N): <≤3 lines>; log <path>: catherd sends it back to its writer ``, back text
     beginning `Your fast check`.
  6. `git merge --ff-only -q <taskBranch>` in the run's tree; failing → `refused` (commit or drop the run tree's own
     edits in those files, then merge again).
  7. `files` = `diff --name-only <old HEAD> <new HEAD>`, `removeTaskTree`, `merged` with `sha`, message `` `<branch>
     is at <sha12>: <n> file(s) from <T> (<≤10 files>)` ``.
- `settle`: after the fast-check block, `mergeFor(s, record)` → `add(merge.requested {…merge, taskId, by: "catherd",
  why: "<T> ended complete: its merge"})`.
- `perform`: the run's tree is claimed for `merge` too; `case "merge"`: `runMerge(…, effectLimits.checkMs)`; with a
  `back` and a run not stopping, `sendBack` first and the message's ending `: catherd sends it back to its writer`
  becomes `: catherd sent it back as <id>` or `; catherd could not send it back (<error>): send it back or replan`; then
  `append(done)`.
- `sendBack`: a `ToolContext` with caller `{name: "catherd", role: "architect"}`; the task's thread from its dispatch;
  `task` = the back text, plus `\n\nThe task you work on:\n<the brief of the tree's first task>` when there is no
  thread; `delegate` with the task's role, rung, ledger task, `check: t.check ?? ""`, oracle, `worktree: task:<T>`,
  `cause`.
- The `merge` tool: description "Merge a task's own tree into the run's branch: catherd commits what the tree holds,
  merges the run's branch into it, runs the task's fast check there, and fast-forwards the run's branch. A task that
  ends complete is merged by itself; call merge for one that ended partial, after an oracle_accept, or after you fixed
  its tree. A conflict or a red fast check goes back to the task's writer; the result wakes you." Under the events
  lock: refused for no unmerged tree, a busy tree, or a merge of that tree already queued; appends `merge.requested`
  with `nextMergeId`.
- `unreleasedOracles` groups only held tasks with `tree === null`. Land's `WHY_EVENTS` gains `merge.requested`, and the
  audit drops one `by: "catherd"` as it drops catherd's `check.requested`.
- `claimRunTree` keeps one in-flight claim per run id (`Map<string, Promise<TreeClaim>>`, deleted on settle).
- `ARCHITECT_LOOP`: the `delegate_task` fast-check words become "catherd runs it the moment the task ends complete (a
  task in its own tree: in that tree, merged with the run's branch, as part of its merge)"; a new line before
  `oracle_accept`: "- merge {taskId, why}: merge a task's own tree into the run's branch. A task that ends complete is
  merged by itself: catherd commits its tree, merges the run's branch into it, runs its fast check there, and
  fast-forwards the run's branch; every merge wakes you. A conflict or a red fast check leaves the run's branch as it
  was and goes back to the same writer as a new task. Call merge for a task that ended partial, after an oracle_accept,
  or after you fixed its tree yourself."; the `oracle_accept` line adds "(in its own tree, the merge is held)" after the
  diff and "and merge it again" after the reason.

- [ ] **Step 4: Verify** — the Step 1 files, `test/entry/role-mcp.test.ts` (it lists `ARCHITECT_TOOLS`), `land.test.ts`,
  `oracle.test.ts` and `test/domain` pass; typecheck, lint, format.

- [ ] **Step 5: Commit** `feat: merge a writer's tree into the run's branch, its fast check run there`

### Task 6: tell running writers what merged, predict their conflicts, regenerate lockfiles

**Files:**
- Modify: `src/services/merge.ts` (`regenConfig`, `regenerate`, `noticeMerged`, `predictedConflicts`),
  `src/services/run-effects.ts` (`noticeMerged` after the `merge.done`), `docs/dev/ideas.md`, `docs/handoff/HANDOFF.md`
- Create: `.changeset/plan-55-writer-trees.md`
- Test: `test/services/merge.test.ts` (describe "after a merge (plan 55, spec D5)")

**Interfaces:**
- Consumes: Task 1's `Profile.regen`, Task 5's `runMerge`.
- Produces: `noticeMerged(run, done: MergeDone): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

- "keeps the run's side of a regenerable path both sides changed, then regenerates it in the task's tree": seeded
  `bun.lock`, `deps.view.regen = {paths: ["bun.lock"], command: "printf 'regenerated\n' > bun.lock"}`, the writer and
  the run's tree both change it → `merged` with `files: ["bun.lock"]`, the run's `bun.lock` is `regenerated`, its last
  subject `catherd: regenerate bun.lock`.
- "sends the task back when the regenerate command fails": the command `echo 'registry down'; exit 7` → `red` with
  `exited 7`, `back.cause` `red`.
- "tells every running writer what merged, and a writer in its own tree the paths it would now conflict in": T1 ended
  (writes `a.txt` `one`), T2 working in its own tree (`a.txt` `two`), T3 a working writer on the run's tree; after
  T1's merge, `noticeMerged` → the message to T2 contains `Your work would conflict with it in: a.txt`, to T3 `It is
  in the run's tree you work in`, every message is from `catherd` and starts `T1 merged into the run's branch`.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement**

- `runMerge` step 4 takes `...regenConfig(run, regen.paths)` before `merge` when the profile has `regen`: it writes
  `<run>/trees/regen.attributes` (`<path> merge=regen` a line) and returns `-c core.attributesFile=<file> -c
  merge.regen.name=… -c merge.regen.driver=cp %B %A`. After a clean merge, `regenerate`: the paths both the task
  (`<merge-base>..<pre-merge HEAD>`) and the run's branch (`<merge-base>..<branch>`) changed; none → nothing; else
  `command` in the tree under `withHeavySlot` with `checkEnvFor` and `treeLimits.setupMs`; a timeout or non-zero exit →
  `red` (`the regenerate command \`<cmd>\` for <paths> exited N: <tail>: catherd sends it back to its writer`); a dirty
  tree after it → `commit -q -m "catherd: regenerate <paths>"` (≤ 100 characters).
- `noticeMerged`: only for `merged` with a sha; head `` `<T> merged into the run's branch `<b>` at <sha12>: <≤20
  files | no file changed>.` ``; to every `working` worker, writer or artist, `teamSend({from: "catherd", to: <task>,
  mode: "queue"})`: on the run's tree `<head> It is in the run's tree you work in.`; in its own tree, with
  `predictedConflicts` (snapshot, `git merge-tree --write-tree --name-only --no-messages <sha> <snapshot>`, exit 1 →
  the lines after the first), `<head> Your work would conflict with it in: <paths>. Run \`git merge <b>\` in your tree
  now and resolve them.`, else `<head> Run \`git merge <b>\` in your tree when you need that work.`; a send that throws
  is logged.
- `docs/dev/ideas.md`: a `### From plan 55 (writer trees and merge)` section above plan 53's, "Left out of plan 55 on
  purpose:", with R14, R11 (no two-minute checkpoint; `from` takes only `clean`), submodules without `--reference
  --dissociate`, R15, R13's per-profile `regen` and `core.attributesFile`, R4, the refused fast-forward over the run
  tree's own edits, and a claim serialized per process only. Plan 53's first two bullets become one ("A fast check runs
  on the shared run tree of a `trees: shared` run (and a run without a base) …"); plan 54's first bullet says the
  window stays only on a `trees: shared` run.
- `docs/handoff/HANDOFF.md`: a row after plan 54's: `| 55 writer trees | docs/plans/2026-10-30-55-writer-trees.md |
  written (stage 2, spec D5: …; scratch reference .superpowers/plan55-scratch) |`.
- `.changeset/plan-55-writer-trees.md`, `"catherd-cli": minor`, one paragraph: per-writer worktrees and merge (spec
  D5); a retry continues in its tree (`delegate_task {worktree, from: "clean"}`); on a complete end catherd commits,
  merges the run's branch in, runs the fast check there and fast-forwards; a conflict or red check goes back to the
  writer, an oracle change holds the merge; the notice and predicted conflicts; `merge {taskId}`, `check {ref}`, the
  profile's `regen`, checkpoints under `refs/catherd/`; `catherd profile set trees shared`; rework counted under
  `merge_conflict` and `merge_red`.

- [ ] **Step 4: Verify** — `merge.test.ts` passes; then the full gate (inside the machine's gate lock when another gate
  runs on the box) and the panel's gate.

- [ ] **Step 5: Commit** `feat: tell running writers what merged, predict their conflicts, regenerate lockfiles`

## Out of scope (stage 2 follow-ups and later stages)

- The memory-bound writer cap, periodic checkpoints, `from: <checkpoint>`, submodule borrowing, tree and ref cleanup:
  `docs/dev/ideas.md`, "From plan 55".
- E1 (race), E2 (speculation) and E4 (warm pool) build on these trees; each is a later experiment flag.
- Stage 3 (memory, D14).
