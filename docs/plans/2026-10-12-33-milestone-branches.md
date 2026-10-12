# catherd 1.6, plan 33: a milestone per branch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a run started with `base` gives every milestone its own branch and git worktree, made from `origin/<base>`
and set up once. Its roles work in that worktree. The milestone lands only when the branch contains the latest
`origin/<base>`, and `land` returns what the orchestrator needs to push, open and merge the MR on the user's word.
A milestone whose `After:` milestones are merged starts beside the others. A run without `base` behaves exactly as
in 1.5.

**Architecture:** a new service, `src/services/milestone-tree.ts`, owns the worktrees: it claims one (`git worktree
add -b` is the atomic claim), sets it up, answers where a milestone's work lives (`treeOf`), and removes merged ones.
Each place that runs or reads the work in `run.meta.repo` asks `treeOf` instead: admission (cwd, change
snapshot, `admit.repo`), preflight, the gate hash and `land`. With no `base`, `treeOf` returns `run.meta.repo`, so
1.5 code paths stay as they are. The git primitives (`fetchBase`, `isAncestor`) go in `src/infra/git.ts`. The branch
name, the plan's `Setup:` line and milestone-level `After:` entries are pure domain. Milestone readiness and the
per-milestone protocol steps live in `src/services/protocol.ts`. catherd never pushes, opens an MR or merges: those
stay the orchestrator's, under the rule the skill already states.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, `@modelcontextprotocol/sdk`, git ≥ 2.30 (`worktree add --no-track`).
No new dependency.

**Spec:** `docs/specs/2026-10-12-catherd-1.6-design.md`, "Plan 33: a milestone per branch". The deferral it
reverses is in `docs/specs/2026-10-02-catherd-1.5-design.md`, "Not in 1.5". t3herd sources (read-only, at 71cbb6a):
`src/state.ts:113-221` (`landed`, `claim`, `nextMilestones`), `src/step.ts:612-628` (the extra commit),
`src/step.ts:742-760, 984-1055` (`precheck`, `onlyMerges`, `behind`, `integrating`), `prompts/integrate.md`,
`prompts/role/reviewer.md:6`, `prompts/role/verifier.md:9`, and commits 333612a, 9319a05, 0040b29, 48ac945, f552380,
b324800, e573b93.

**Pre-validation: spiked the git sequence (`worktree add --no-track -b` from `origin/main` against a local bare
origin; a second `-b` claim of the same branch fails; `worktree remove` refuses a dirty tree; `merge-base
--is-ancestor` sees a `--no-ff` merge pushed from another clone), targeted tests only; the full gate runs at
execution.**

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`). `branch.ts` and the
  `lane.ts` additions are domain. `fetchBase` and `isAncestor` are infra. `milestone-tree.ts` is a service.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`.
  Tests that could reach the network delete `ANTHROPIC_API_KEY`. Their origin is a local bare repo
  (`git clone --bare`), never a URL. No wall-clock sleep for correctness. The setup timeout is a seam
  (`treeLimits.setupMs`).
- Commits: conventional (commitlint), subject ≤ 100 characters, lower-case first word after the scope.
- **A run with no `base` is 1.5.** Every function this plan changes keeps its 1.5 result when `run.meta.base` is
  absent: same cwd, same refusals, same `protocol.next` text, same `land` result (no `branch` key). Each task that
  touches a 1.5 path keeps an existing test green, or adds one that pins this.
- **No push, no MR, no merge into the base by catherd.** The rule stays, verbatim: "Commits and pushes still require
  the user's authorization and repository rules; there is no automatic commit, push or rollback." It is now in
  `plugin/skills/catherd/SKILL.md:119-120` for workspaces and moves to cover branch runs too. Roles stay denied
  `git push` (`src/adapters/claude-code/index.ts:42`, `src/adapters/opencode/agents.ts:49`). catherd's own git
  writes are local only: `worktree add/remove`, `submodule update`. Its only network git call is `fetch origin
  <base>` (D5).
- **Never lose work.** A tree is removed with `git worktree remove` without `--force`. A dirty tree stays, and the
  call reports a hint. The branch is never deleted.
- Binding spec values, verbatim:
  - "A milestone worktree is made from `origin/<base>` with submodules and the plan's `Setup:` command.
    `git worktree add -b` is the atomic claim."
  - "When the base has moved, `integrate` merges it and a worker resolves conflicts. Reviews stay fresh across
    merges and plan-only commits (`onlyMerges`)."
  - "Reviewers diff with three dots, and work outside the lanes is committed before the first review."
  - "`land` carries a precheck run right before the merge. "Landed" means origin's base contains the branch, not
    that `glab` returned. Landed worktrees are removed."
  - "Milestones whose `After:` milestones have landed run in parallel."
  - "Must not break single-tree runs: a run without a base branch behaves as in 1.5."

## Design

The spec lists behaviors. These are the decisions that turn them into catherd's model. Rulings below record the
smaller calls.

- **D1. Opt-in per run.** `run_start(repo, title, a_lines, from?, base?)`. `base` is a branch name on `origin`
  (`main`, `staging`), never `origin/main` or a range. It is stored as `meta.base` (an optional key on schema 1, so
  no schema bump). `run_start` fetches it and refuses `E_INPUT_INVALID` when `origin/<base>` does not resolve. A
  workspace child never gets one (`workspace_child_start` is unchanged). Without `base`, nothing below applies.
  Rejected: a profile switch, because the choice belongs to one project, not to every run of a repo.
- **D2. Where a milestone lives.** The worktree is at `<run dir>/trees/<M>`, inside the private run folder. The
  branch is `milestoneBranch(title, M)`: the run title's slug (as `createRun` cuts it, 40 characters) then `-` and
  the milestone in lower case (`wallet-split-m1`). It is t3herd's `branchOf` with the run title in place of the plan
  slug. No new state file: the tree's existence and its checked-out branch are the record.
- **D3. The claim.** `claimTree(run, M)` runs under a file lock on `<run dir>/trees/<M>`. In order:
  1. A tree that exists must have `milestoneBranch` checked out, else `E_TREE`.
  2. With no tree, the branch may already exist. If `M` is in the ledger (a post-land fix after its tree was
     removed), the claim re-adds the worktree on that branch. If not, the branch belongs to someone else: `E_TREE`,
     with a fix that names `git branch -m`.
  3. Otherwise each prerequisite (D9) must be merged (D6), else `E_ADMIT_ORDER`. Then
     `git worktree add --no-track -b <branch> <tree> origin/<base>`, after `fetchBase`.
  4. Then `git submodule update --init --recursive` when `.gitmodules` exists, then the plan's `Setup:` command.

  A setup that succeeds writes `<run dir>/trees/<M>.ready`. While that file is missing, every claim runs setup
  again. A failed setup throws `E_TREE` with the exit code and the last 1500 characters of output. The tree stays.
  Claims never run under the run's admission lock, because setup can take minutes.
- **D4. `Setup:` comes from plan.md.** It is a header line under plan.md's `# ` title, parsed with the lane-header
  reader (`headerBlock`/`headerLine`). The architect writes it from the dossier. It runs with `sh -c` in the tree,
  through preflight's `runCheck` with `checkEnvFor(run.meta.repo)` (the login env plus the gate env). The timeout is
  `treeLimits.setupMs` (15 min). No `Setup:` line means no setup.
- **D5. catherd fetches its base, and only that.** `fetchBase(repo, base)` runs `git fetch -q origin <base>` with a
  60 s timeout. Three calls use it: `claimTree` before it branches or checks a prerequisite, `land` before its
  precheck, and `removeMergedTrees`. A failed fetch never fails the call. The call works from the last fetched
  `origin/<base>` and adds a hint (`fetch of origin/<base> failed: using the copy from the last fetch`). Nothing
  polls. This departs from plan 25's workspace rule ("catherd never fetches") on t3herd's evidence (333612a): the
  local base lags behind MR merges.
- **D6. Landed and merged are two facts.** `land` keeps its 1.5 meaning: the gate passed, and the ledger row and
  digest are written. **Merged** is the git fact: the milestone's latest landed commit (`landedCommitOf`) is an
  ancestor of `origin/<base>`. This is plan 25's `release: "merge"` test, now in `isAncestor`. Dependents (D9) and
  tree removal (D10) wait on merged. A squash merge is not detected (Ruling 9).
- **D7. Where roles work.** A dispatch's milestone is its lane's milestone. For a lane-less dispatch, it is the one
  milestone of the run (from `lanes/*.md`) that its name names (`namesMilestone`). Otherwise there is none, and an
  architect or the dossier researcher stays in `run.meta.repo`. In a branch run, admission claims the milestone's
  tree. It then uses the tree for the adapter's `repo` (cwd and writable root), the `before` snapshot and
  `admit.repo`, so finalize diffs the tree. The profile, `agentFor`, stand-ins and the gate env keep
  `run.meta.repo`, because they are keyed by repo or origin. A native Claude role cannot be given a cwd, so `route`
  returns `tree` for a lane, and the skill tells the orchestrator to brief native roles with it.
- **D8. Briefs carry the branch, and the review starts from a commit.** `BriefContext.branch` adds one line to the
  role notes of every dispatch in a branch milestone. It gives the tree, the branch, its base, and the diff
  ``git diff origin/<base>...HEAD``, with three dots and the reason (48ac945). In a branch run, a `reviewer`,
  `ui-reviewer` or `verifier` dispatch is refused `E_ADMIT_ORDER` while the tree is dirty (f552380). The fix names the
  dirty paths and says to commit the milestone's work, lanes and extras alike, on the branch first.
- **D9. Prerequisites.** An `After:` entry may now name a whole milestone (`After: M1`), as well as a lane
  (`M1.L2`). In a branch run, a milestone's prerequisites are the milestones its lanes' `After:` entries name, other
  than itself (`milestoneAfter`). A milestone with none starts from the base at once, beside the others. That is
  t3herd's model, and the architect prompt says so. Until the final task group lands, the prerequisite is the
  previous milestone (Task 4). In a 1.5 run, `After: M1` holds the lane until M1 lands. That is what the sequential
  loop already does, so no 1.5 behavior changes.
- **D10. Removal.** `removeMergedTrees(run)` runs `git worktree remove <tree>` (no `--force`) for each tree whose
  milestone is merged and has no live dispatch. It deletes `<M>.ready` with it and keeps the branch. `land` calls it
  after its ledger row, and `claimTree` calls it before it adds a tree. A dirty or locked tree stays and yields a
  hint.
- **D11. Integrate, and the land precheck.** In a branch run, `land` fetches. It then refuses `E_LAND_GATE` unless
  `commit` is the branch tip and `origin/<base>` is an ancestor of it. The fix is the integrate procedure:
  `git -C <tree> merge --no-ff -m "Merge origin/<base> into <branch>" origin/<base>`, then on conflicts a
  `worker-<M>-integrate` dispatch, with the conflicted files and the integrate rules (skill text, from t3herd's
  `prompts/integrate.md`). The orchestrator commits the merge, a fresh verifier gates the new HEAD (plan 29's rule),
  and `land` runs again. The review stands, because catherd counts reviews by time, not by HEAD (Ruling 1). When
  the land succeeds, it returns `branch: { name, base, tree, precheck }`. The precheck is
  `git -C <tree> fetch -q origin <base> && git -C <tree> merge-base --is-ancestor origin/<base> HEAD`. The
  orchestrator runs it right before the merge (b324800).
- **D12. Ranges in a branch run** run from `origin/<base>`, not from the previous ledger row. Parallel milestones
  land in any order, so the ledger order says nothing about a branch's own commits. `milestoneFiles` diffs
  `origin/<base>...<commit>`, and `milestoneCommits` logs `origin/<base>..<commit>`.
- **D13. `protocol.next` with milestones side by side** (final task group). `protocolSteps(run, parked, now):
  string[]` returns one step per milestone that is not landed, not parked and has all its prerequisites in the
  ledger. Each step is today's per-milestone text, unchanged (its lane ids or `M2:` prefix name the milestone). A milestone whose
  prerequisites are not landed shows as `M3 waits for M1 to land and merge`. `protocolNext` returns the steps
  joined by ` · `. In a 1.5 run it returns exactly one step, as today. `actionability` judges each step: a run is
  not actionable only when every step is covered.

## Rulings

Step 0, the spec's items checked against 1.5.0 (2061e6e):

1. Ruling: `onlyMerges` (reviews stay fresh across base merges and plan-only commits) is dropped as already true.
   catherd counts a reviewer by time since the milestone's lanes started (`src/services/milestones.ts:54-70`,
   `since(start)`), never by HEAD. Its plan lives in the run folder, outside the repo, so no commit can touch only
   the plan. A base merge after the review needs only a fresh verifier, through plan 29's HEAD rule — none, unless a
   later plan ties reviews to HEAD.
2. Ruling: lane `After:` ordering is already in 1.5 (plan 25, 0d356a6: `src/domain/lane.ts:14-15`,
   `src/services/protocol.ts:105-124`, `src/services/admission.ts:221-229`), cross-milestone entries included. This
   plan only widens it to a whole-milestone id and reads it as milestone prerequisites (D9) — none.
3. Ruling: the merged test is plan 25's `release: "merge"` (`src/services/workspace-admission.ts:126-147`). This plan
   moves its git call into `isAncestor` and its ledger lookup into `milestones.ts` `landedCommitOf`, which also
   closes `ideas.md` "`landedCommitOf` lines up two separately filtered arrays" (Minor 8) — none.
4. Ruling: everything else in the section is absent from 1.5 (`grep -rn worktree src` finds only knowledge-keying
   comments) and is planned here.

Calls this plan makes:

5. Ruling: catherd fetches `origin <base>` itself (D5), unlike plan 25's workspace check — t3herd's 333612a shows
   the local base lags behind MR merges — a VPN or proxy outage makes every claim work from the last fetch, which
   the hint names.
6. Ruling: the push, the MR and the merge stay the orchestrator's, and only on the user's authorization. t3herd's
   conductor pushes and runs `glab mr merge` on its own. catherd's skill forbids that, and the brief says to keep
   catherd's rule — an autopilot user confirms each first push. Their standing "do everything" authorizes the rest.
7. Ruling: the branch name has no run id, so it reads like a feature branch. A same-titled branch that is not this
   run's is refused `E_TREE`, not adopted — two runs with one title in one repo must rename one branch.
8. Ruling: a failed `Setup:` throws `E_TREE` and is retried at each claim. It is not recorded as state, unlike
   t3herd's `setup.json` — the next dispatch reruns a slow setup that failed, which is the point.
9. Ruling: a squash merge does not count as merged. A dependent of a squash-merged milestone waits until the
   orchestrator removes that `After:` entry with `lane_set` (on the owner's word), and the skill says so. t3herd
   also needs a merge commit ("never squash") — a repo that squashes cannot chain milestones without that manual
   step. This is open question 1.
10. Ruling: `E_TREE` is one new error code for tree problems: a foreign branch, a wrong checkout, a failed setup. A
    missing prerequisite reuses `E_ADMIT_ORDER`, as a lane's `After:` does — none.
11. Ruling: `milestone-tree.ts` imports `runCheck` and `checkEnvFor` from `preflight.ts`, and `preflight.ts` imports
    `claimTree` back. The cycle is function-only, which ESM resolves, and the import-graph test has no cycle rule —
    if one is added later, `runCheck` moves to `src/services/check-run.ts`.
12. Ruling: carried gate passes stay keyed by toplevel (`ideas.md`, plan 25 controller carry-over). Each milestone
    tree is its own toplevel, so a pass carries within a milestone, never across — none for correctness. The idea
    stays open.
13. Ruling: "Stacked milestones" (`ideas.md`, Orchestration) stays an idea. A dependent starts from the merged base,
    as in t3herd — none.

## Cross-plan interfaces

Plans 28–32 run first. This plan assumes:

- **Plan 28** turns `composeBrief` into `roleSections(role, version, { context, task })`. `task` is the
  orchestrator's text, the lane block and `roleNotes`. The `branch` line (Task 5) stays in `roleNotes`, so it lands
  in `task`. The architect text (Task 9) is appended to wherever plan 28 left `architect` in
  `src/domain/role-prompts.ts`.
- **Plan 29**: `land` requires the verifier's `HEAD:` to equal the landed commit (`MilestoneVerifier.head`). The
  gate runs the milestone check itself through `machineGate(run, m, head)` and `CheckJob { run, repo, cwd, milestone,
  command, head, base, baseline }`. Task 6 sets `CheckJob.cwd` to `treeOf(run, m)`. It also re-points any other
  `run.meta.repo` that plan 29 added for running or hashing a milestone's content (`grep -n "meta.repo"
  src/services/gate-service.ts src/services/lane-service.ts` and plan 29's check files). In a branch run,
  `CheckJob.base` is `origin/<base>`. Tests that land use plan 29's `passGate(run, m, at?, head?)`, with
  `head` = the branch tip. Plan 33 does not implement the HEAD rule.
- **Plan 32**: the digest carries known issues and gate facts, and is the MR body. Task 7 returns `digestPath` as
  today, and the skill says the MR body is the digest. Plan 32 Ruling 10 leaves milestone-level lint to this plan:
  "milestones that can run together but share files", milestone `After:` without a shared file, and the milestone
  critical path. Task 8 adds the first of these as a preflight `warnings` line, using plan 32's lint helper if it
  exported one, else `overlaps` from `src/domain/lane.ts`. The other two stay in `ideas.md`.

## Parallelism

Other 1.6 plans also touch: `src/services/lane-service.ts` (29, 30, 32), `src/services/admission.ts` (28, 30),
`src/domain/brief.ts` and `src/domain/role-prompts.ts` (28), `src/services/protocol.ts` (29, 30, 32),
`src/services/gate-service.ts` (29), `src/services/preflight.ts` (32), `src/domain/lane.ts` (32),
`src/services/peek.ts` (30), `plugin/skills/catherd/SKILL.md`, `README.md`, `docs/dev/ideas.md`. Line numbers below
are at 2061e6e. Refresh them at execution.

Within the plan: Tasks 1, 2 and 3 are independent. Task 4 needs 1–3. Tasks 5 and 6 need 4 and can run together.
Task 7 needs 4 and touches `lane-service.ts` like Task 5's `route` change, so run it after 5. Task 8 (the final
group, parallel milestones) needs 4–7. Then Task 9, then Task 10.

## Review Focus

1. **A run without `base`.** Expected: byte-identical 1.5 behavior: dispatch cwd and `admit.repo` are the repo, no
   fetch runs, `land` returns no `branch`, and `protocol.next` gives the same single step. Pinned in Task 5: "a run
   without base dispatches in the repo, as in 1.5", Task 7: "a run without base lands as in 1.5, with no branch
   key", and Task 8: "a run without base keeps one sequential step".
2. **Uncommitted work in a merged milestone's tree.** Expected: the tree is not removed, the work is still on disk,
   and the call returns a hint naming the tree. Pinned in Task 4: "never removes a dirty tree, even when merged".
3. **The fetch fails (a VPN or proxy outage).** Expected: the claim still makes the tree from the last fetched
   `origin/<base>` and says so in a hint. `land` still checks against the last fetch. A prerequisite stays unmerged.
   Pinned in Task 4: "works from the last fetch when origin cannot be reached".
4. **A branch with the milestone's name already exists** from another run with the same title. Expected: `E_TREE`
   naming the branch and `git branch -m`, and the branch is not touched. Pinned in Task 4: "refuses a branch with the
   milestone's name that is not this run's".
5. **A prerequisite squash-merged into the base.** Expected: the dependent stays refused `E_ADMIT_ORDER` (not
   merged), and the fix names `lane_set` to drop the `After:` entry. Pinned in Task 8: "a squash-merged
   prerequisite does not release its dependent".

---

### Task 1: domain — branch name, `Setup:`, milestone ids in `After:`

**Files:**
- Create: `src/domain/branch.ts`
- Modify: `src/domain/lane.ts:20-21` (`LANE_ID`), `:96-109` (`orderProblems` message), new export after `:59`
- Modify: `src/services/run-store.ts:83` (export `runSlug` or import it from the new file)
- Test: `test/domain/branch.test.ts` (new), `test/domain/lane.test.ts`

**Interfaces:**
- Produces:
  - `milestoneBranch(title: string, m: string): string`. It returns `${runSlug(title)}-${m.toLowerCase()}`, where
    `runSlug` is the one `createRun` uses (`slug(title).slice(0, 40) || "run"`). Move `runSlug` into
    `src/domain/branch.ts` and import it in `run-store.ts`.
  - `BaseBranchSchema`: `BaseRefSchema` (`src/domain/workspace.ts:16-19`), refined to refuse a value that starts
    with `origin/` or `refs/`.
  - `planSetup(planText: string): string | null`: the `Setup:` value from the header block under plan.md's first
    `# ` title, with backticks stripped. It returns null when the line is absent or empty. Reuse `headerBlock` and
    `headerLine`.
  - `LANE_ID` accepts a milestone id (`M1`) as well as a lane id (`M1.L2`). The refusal reads
    `After "<x>" is not a lane or milestone id like M1.L1 or M1`.

- [ ] **Step 1: Write the failing tests**

```ts
it("names a milestone's branch after the run title, lower case", () => {
  expect(milestoneBranch("Wallet split", "M1")).toBe("wallet-split-m1");
  expect(milestoneBranch("!!!", "M2")).toBe("run-m2");
});
it("takes a base branch name, never a remote ref or a range", () => {
  expect(BaseBranchSchema.safeParse("staging").success).toBe(true);
  for (const bad of ["origin/main", "refs/heads/main", "main..x", "--upload-pack=x", "a b"])
    expect(BaseBranchSchema.safeParse(bad).success).toBe(false);
});
it("reads Setup: from plan.md's header block only", () => {
  expect(planSetup("# Plan\nSetup: `pnpm install`\n\n## D1\nSetup: no")).toBe("pnpm install");
  expect(planSetup("# Plan\n\nSetup: body prose")).toBeNull();
});
// test/domain/lane.test.ts
it("accepts a whole milestone in After:", () => {
  expect(parseLaneHeader("# M2.L1 — x\nAfter: M1, M1.L2\n").after).toEqual(["M1", "M1.L2"]);
  expect(() => assertLaneValues("# M2.L1 — x\nAfter: M1 L2\n", "lanes/M2.L1.md")).toThrow(/lane or milestone id/);
});
```

- [ ] **Step 2: Run them, expect FAIL** — `bun test test/domain/branch.test.ts test/domain/lane.test.ts`.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run them, expect PASS**, plus `bun test test/services/lane-headers.test.ts test/services/lane-edit.test.ts`.
- [ ] **Step 5: Commit** — `feat(lanes): milestone branch names, a plan's setup line, whole-milestone after entries`.

### Task 2: infra — fetch the base, ancestry, the landed commit

**Files:**
- Modify: `src/infra/git.ts` (two new exports)
- Modify: `src/services/milestones.ts` (new export `landedCommitOf`, near `landedCommits` at `:245-259`)
- Modify: `src/services/workspace-admission.ts:126-147` (use both, delete the local `landedCommitOf`)
- Test: `test/infra/git.test.ts`, `test/services/workspace.test.ts` (the existing release-on-merge tests stay green)

**Interfaces:**
- Produces:
  - `fetchBase(repo: string, base: string, timeoutMs = 60_000): Promise<boolean>` runs `git fetch -q origin
    <base>` and returns true when it exits 0.
  - `isAncestor(repo: string, commit: string, ref: string): Promise<boolean | null>`: true on exit 0, false on
    exit 1, null when git cannot tell (another exit, a timeout).
  - `landedCommitOf(run: Run, m: string): string | null`: the commit of `m`'s latest ledger row. It parses each row
    once into `{ milestone, commit }`, which fixes Minor 8.
- `unmerged` (workspace-admission) keeps its three messages, mapped from `true | false | null`.

- [ ] **Step 1: Write the failing tests**

```ts
it("fetches origin's base and tells an ancestor from a stranger", async () => {
  const { repo, origin } = repoWithOrigin(); // tempRepo + git clone --bare + remote add + push main
  const c = commitInClone(origin, "x");      // a commit pushed to origin main from another clone
  expect(await isAncestor(repo, c, "origin/main")).toBeNull(); // unknown object before the fetch
  expect(await fetchBase(repo, "main")).toBe(true);
  expect(await isAncestor(repo, c, "origin/main")).toBe(true);
  expect(await isAncestor(repo, "HEAD", "origin/main")).toBe(true);
  expect(await fetchBase(repo, "no-such-branch")).toBe(false);
});
it("finds a milestone's latest landed commit when an earlier row has no commit", () => {
  // ledger rows: M1 | w | abc1234 ; M2 | w | - ; M1 | w | def5678
  expect(landedCommitOf(run, "M1")).toBe("def5678");
  expect(landedCommitOf(run, "M2")).toBeNull();
});
```

  Put `repoWithOrigin()` and `commitInClone()` in `test/helpers.ts` beside `tempRepo()`. Tasks 3–8 use them.

- [ ] **Step 2: Run, expect FAIL** — `bun test test/infra/git.test.ts test/services/workspace.test.ts`.
- [ ] **Step 3: Implement**, then switch `unmerged` to `isAncestor` + `landedCommitOf`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `refactor(git): fetch the base and test ancestry in one place`.

### Task 3: `run_start` takes `base`

**Files:**
- Modify: `src/services/run-store.ts:34-46` (`base: z.string().optional()` on `RunMetaSchema`), `:87-…`
  (`createRun` takes `base?: string`)
- Modify: `src/services/run-service.ts:123-158` (`startRun` input gains `base?: string`)
- Modify: `src/entry/mcp/run-tools.ts:24-36` (`base: BaseBranchSchema.optional()`, description sentence)
- Test: `test/services/run-start.test.ts` (or the file that tests `startRun` today; find it with
  `grep -ln "startRun(" test/services`), `test/services/helpers.ts` (new `branchRun`)

**Interfaces:**
- Consumes: `fetchBase`, `BaseBranchSchema`.
- Produces: `run.meta.base: string | undefined`, and the test helper
  `branchRun(title = "t"): { repo: string; origin: string; run: Run }` (`freshRun` with an origin, and
  `createRun({ …, base: "main" })`). The tool description gains: "base: a branch on origin (main, staging): each
  milestone then gets its own branch and worktree from origin/<base>; without it the run works in the repo, as
  before."
- `startRun` with `base` fetches. When `git rev-parse --verify origin/<base>` then fails, it throws
  `E_INPUT_INVALID` (`origin/<base> does not exist in <repo>`, fix: `pass a branch origin has, or omit base`) before
  any run folder is created.

- [ ] **Step 1: Failing tests:** "records base and fetches it", "refuses a base origin does not have, creating no
  run" (`listRuns` count unchanged), and "a run without base has no meta.base".
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, plus `bun test test/entry` for the MCP schema snapshot, if one exists.
- [ ] **Step 5: Commit** — `feat(runs): run_start takes a base branch for milestone branches`.

### Task 4: the milestone tree service

**Files:**
- Create: `src/services/milestone-tree.ts`
- Modify: `src/domain/errors.ts:1-34` (add `"E_TREE"`)
- Modify: `src/services/protocol.ts` (new export `prerequisites`)
- Test: `test/services/milestone-tree.test.ts` (new)

**Interfaces:**
- Consumes: `milestoneBranch`, `planSetup`, `fetchBase`, `isAncestor`, `landedCommitOf`, `landedMilestones`,
  `runCheck`/`checkEnvFor` (`src/services/preflight.ts:126`, `:226`), `withFileLock`, `liveDispatches`,
  `statusSnapshot`.
- Produces (all in `milestone-tree.ts`):
  - `export const treeLimits = { setupMs: 15 * 60_000 }`
  - `treeDir(run: Run, m: string): string` returns `join(run.dir, "trees", m)`.
  - `treeOf(run: Run, m: string | null): string` is sync. It returns `treeDir` when `run.meta.base` and `m` are set
    and the dir exists, else `run.meta.repo`.
  - `milestoneOfDispatch(run: Run, name: string, lane: string | null): string | null` (D7).
  - `claimTree(run: Run, m: string): Promise<{ tree: string; branch: string; base: string; hints: string[] }>`
    (D3, D4, D5). Callers check `run.meta.base` first. Called without one, it throws `E_INPUT_INVALID`.
  - `removeMergedTrees(run: Run, now: number): Promise<{ removed: string[]; hints: string[] }>` (D10).
  - `isMerged(run: Run, m: string): Promise<boolean>` is `landedCommitOf` + `isAncestor(…, "origin/<base>")`. Null
    and no landed commit both count as false.
- In `protocol.ts`: `prerequisites(run: Run, m: string): string[]`. For now it returns the milestone before `m` in
  `byNumber` order of the run's lane milestones, or `[]` for the first. Task 8 replaces it with `milestoneAfter`.
- The `E_ADMIT_ORDER` message for an unmerged prerequisite:
  `<M> starts from origin/<base> once <P> is merged into it: <P> is not landed | <P> (<short>) is not in origin/<base> yet`.
  The fix: `merge <P>'s branch (<branch>) into <base>, then dispatch again`.

- [ ] **Step 1: Write the failing tests** (each on `branchRun()`; `writeLane` for M1/M2; plan.md written with
  `writeRunFile` or `writeFileSync`):

```ts
it("claims M1 from origin's base, runs Setup: once, and finds the same tree again", async () => {
  // plan.md: "# P\nSetup: echo ok > setup.txt"; origin main has a commit the local main lacks
  const a = await claimTree(run, "M1");
  expect(a.tree).toBe(treeDir(run, "M1"));
  expect(a.branch).toBe("t-m1");
  expect(git(a.tree, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "origin/main")); // origin's, not local
  expect(existsSync(join(a.tree, "setup.txt"))).toBe(true);
  rmSync(join(a.tree, "setup.txt"));
  await claimTree(run, "M1");
  expect(existsSync(join(a.tree, "setup.txt"))).toBe(false); // .ready: no second setup
  expect(treeOf(run, "M1")).toBe(a.tree);
  expect(treeOf(run, null)).toBe(run.meta.repo);
});
it("throws E_TREE on a failed setup, keeps the tree, and retries setup next claim", …);
it("refuses a branch with the milestone's name that is not this run's", …); // git branch t-m1 first → E_TREE, branch sha unchanged
it("holds M2 until M1 is landed and merged into origin's base", …);          // E_ADMIT_ORDER twice, then a --no-ff merge pushed from a clone → claim ok
it("works from the last fetch when origin cannot be reached", …);           // remote set-url origin /nonexistent → tree made, hint /last fetch/
it("never removes a dirty tree, even when merged", …);                        // untracked file in tree → removed [], hint names the tree, file still there
it("removes a merged, clean tree with no live dispatch and keeps its branch", …);
```

- [ ] **Step 2: Run, expect FAIL** — `bun test test/services/milestone-tree.test.ts`.
- [ ] **Step 3: Implement** `milestone-tree.ts` per D3–D5 and D10, then `prerequisites`. The claim order is fixed
  (D3). The `git worktree add` failure path re-reads the dir, so a racing claim of the same milestone returns the
  tree the other one made.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(runs): a worktree per milestone, claimed from origin's base and set up once`.

### Task 5: roles work in the tree

**Files:**
- Modify: `src/services/admission.ts:161-…` (`admit`: claim before `prepared` at `:236`, then use the tree at
  `:236-242`, `:244-256`, `:305`, `:328`, and in the brief context at `:339-347`)
- Modify: `src/domain/brief.ts:6-16` (`BriefContext.branch`), `:53-67` (`roleNotes`)
- Modify: `src/services/lane-service.ts:69-79` (`RouteResult.tree`), `:162-215` (`record` fills it)
- Modify: `src/services/protocol.ts:118-124` (`unfinishedAfter`: in a branch run only same-milestone entries)
- Test: `test/services/admission.test.ts`, `test/domain/brief.test.ts`, `test/services/route.test.ts` (or wherever
  `route` is tested: `grep -ln "route(" test/services`)

**Interfaces:**
- Consumes: `claimTree`, `milestoneOfDispatch`, `treeOf`, `statusSnapshot`.
- Produces:
  - `BriefContext.branch: { tree: string; name: string; base: string } | null`. When set, `roleNotes` adds after
    its first line: ``You work in <tree>, on branch <name>, which starts from origin/<base>. The milestone's diff is `git diff origin/<base>...HEAD`: three dots, because other milestones land on the base meanwhile and a two-dot diff shows their work as deleted here.``
  - `RouteResult.tree: string | null`. In a branch run, a lane's `route` claims the tree and returns it. Every other
    case returns null.
  - In a branch run, a `reviewer`, `ui-reviewer` or `verifier` dispatch whose tree is dirty is refused
    `E_ADMIT_ORDER`: `<M>'s tree has uncommitted changes (<up to 5 paths>, …)`. The fix:
    `commit the milestone's work on <branch>, the lanes' and any files outside them, then dispatch <name> again`.
  - Claim hints reach the `dispatch` result's `hints`.

- [ ] **Step 1: Write the failing tests**

```ts
it("a run without base dispatches in the repo, as in 1.5", async () => {
  // freshRun; admit a lane worker → spec.cwd === repo, admit.repo === repo, no trees/ dir
});
it("dispatches a branch lane in its milestone's tree, and the reviewer too", async () => {
  // branchRun; writeLane M1.L1; admit worker-M1.L1 → spec.cwd === treeDir(run,"M1"), d.admit.repo === tree
  // commit nothing; admit reviewer-M1 → E_ADMIT_ORDER /uncommitted/ ; commit in tree → admitted, cwd === tree
});
it("puts the branch and the three-dot diff in a branch role's notes only", () => {
  expect(roleNotes({ ...ctx, branch: { tree: "/t", name: "x-m1", base: "main" } })).toContain("git diff origin/main...HEAD");
  expect(roleNotes({ ...ctx, branch: null })).not.toContain("origin/");
});
it("route returns a branch lane's tree for a native role", …);
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The claim and the dirty check run before `withRunAdmission`, after the `After:` check
  (`:222-229`). Everything inside the lock reads `tree` where it read `run.meta.repo` for the working copy. The
  profile, `agentFor`, `standInFor` and `readGateEnv` keep `run.meta.repo`.
- [ ] **Step 4: Run, expect PASS**, plus `bun test test/services/dispatch.test.ts test/services/lanes-run.test.ts`.
- [ ] **Step 5: Commit** — `feat(dispatch): a branch milestone's roles work in its worktree`.

### Task 6: preflight and the gate read the tree

**Files:**
- Modify: `src/services/preflight.ts:268-355` (per lane: `claimTree` for its milestone in a branch run, then the
  tree for `unborn`, `runCheck`, `checkEnvFor` stays `run.meta.repo`)
- Modify: `src/services/gate-service.ts:374-459` (`gateCheck`, `gatePass`: content from the tree), plus plan 29's
  additions (see Cross-plan interfaces)
- Test: `test/services/preflight.test.ts`, `test/services/gate-service.test.ts`

**Interfaces:**
- Consumes: `claimTree`, `treeOf`.
- Produces:
  - In a branch run, a lane whose claim is refused is `skipped`, its note the refusal's message (for example
    `M2 starts from origin/main once M1 is merged into it: …`). Other lanes still run.
  - In a branch run, `gate_check` without `milestone` is refused `E_INPUT_INVALID`
    (`a branch run's gate_check names its milestone`). `gate_pass` takes its tree from the milestone of the latest
    recorded step with the same item and command.

- [ ] **Step 1: Failing tests:** "preflights a branch lane in its tree" (check `test -f marker`, where the marker
  exists only in the tree), "skips a lane whose milestone cannot start yet, naming why", "hashes a branch
  milestone's gate content from its tree", and "a run without base preflights and hashes in the repo" (the existing
  tests stay green).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(gate): preflight and gate checks read the milestone's worktree`.

### Task 7: `land` on a branch

**Files:**
- Modify: `src/services/lane-service.ts:342-432` (`gate` takes the tree), `:449` (`LandResult.branch`), `:498-566`
  (`landRun`)
- Modify: `src/services/milestones.ts:266-298` (`milestoneFiles`, `milestoneCommits`: D12 in a branch run)
- Modify: `src/entry/mcp/lane-tools.ts:117` (the description: the branch result and the integrate refusal)
- Test: `test/services/land-gate.test.ts`

**Interfaces:**
- Consumes: `fetchBase`, `isAncestor`, `treeOf`, `milestoneBranch`, `removeMergedTrees`.
- Produces:
  - `LandResult.branch?: { name: string; base: string; tree: string; precheck: string }`. It is present only in a
    branch run, and `precheck` is the exact string from D11.
  - New refusals, in a branch run, before the 1.5 gate:
    - `commit` is not the branch tip → `E_LAND_GATE` `land <M>: <commit> is not <branch>'s tip (<short>)`. The fix:
      `commit on <branch> in <tree> and land its tip`.
    - `origin/<base>` is not an ancestor of `commit` → `E_LAND_GATE` `land <M>: origin/<base> moved since <branch>
      left it`. The fix: `integrate: git -C <tree> merge --no-ff -m "Merge origin/<base> into <branch>"
      origin/<base>; on conflicts dispatch worker-<M>-integrate with the conflicted files (git -C <tree> diff
      --name-only --diff-filter=U); commit the merge, run a fresh verifier-<M> on the new HEAD, then land again`.
  - A skip's "commit is HEAD" check compares with the tree's HEAD.
  - After the ledger row, `removeMergedTrees(run, now)`. Its hints join the result's.

- [ ] **Step 1: Write the failing tests**

```ts
it("a run without base lands as in 1.5, with no branch key", …);            // existing passGate path; expect(r.branch).toBeUndefined()
it("lands a branch milestone at its tip and returns the precheck", async () => {
  // branchRun; claim M1; commit in tree; passGate(run,"M1"); land → r.branch = { name: "t-m1", base: "main", tree, precheck }
  // precheck runs green in sh -c; its digest lists only the tree's own commits (D12)
});
it("refuses a branch milestone that is behind origin's base, naming the integrate merge", …); // push a commit to origin main from a clone
it("refuses a commit that is not the branch tip", …);
```

- [ ] **Step 2: Run, expect FAIL** — `bun test test/services/land-gate.test.ts`.
- [ ] **Step 3: Implement.** The branch checks run after `commitExists`, before `gate(...)`. A failed fetch adds the
  D5 hint and checks against the last fetch.
- [ ] **Step 4: Run, expect PASS**, plus `bun test test/services/ledger.test.ts test/services/workspace.test.ts`.
- [ ] **Step 5: Commit** — `feat(land): a branch milestone lands on its tip, containing origin's base`.

### Task 8: milestones side by side (final group)

**Files:**
- Modify: `src/services/protocol.ts:126-196` (split `protocolNext` into `milestoneStep` + `protocolSteps`; add
  `milestoneAfter`; `prerequisites` uses it in a branch run)
- Modify: `src/services/peek.ts:63-91` (`actionability` takes `string[]`), `:103` (pass `protocolSteps`)
- Modify: `src/services/preflight.ts` (`warnings`: milestones side by side that share files)
- Test: `test/services/protocol.test.ts`, `test/services/peek.test.ts`, `test/services/milestone-tree.test.ts`

**Interfaces:**
- Produces:
  - `milestoneAfter(run: Run, m: string): string[]` lists, sorted `byNumber`, the milestones (`milestoneOf` of each
    entry) that `m`'s lanes' `After:` lines name, other than `m`.
  - `prerequisites(run, m)` is `milestoneAfter(run, m)` in a branch run. A 1.5 run never calls it.
  - `protocolSteps(run: Run, parked: string[], now?: number): string[]` (D13).
    `protocolNext = (…) => protocolSteps(…).join(" · ")`.
  - `actionability(live, unread, steps: string[])`. The parked case, the unread case and the per-step `covered`
    test are unchanged for one step. With several steps, the run is not actionable only when every step is
    covered or parked.
  - In a branch run, `preflight` adds one warning per pair of milestones that neither reaches through
    `milestoneAfter` (both can run at once) and whose lanes' `Owns:` overlap:
    `M1 and M2 can run side by side but both own <paths>: their merges will conflict; add After: M1 to an M2 lane,
    or split the files`. The text is plan 32's warning wording, if plan 32 fixed one.
  - The `E_ADMIT_ORDER` fix for an unmerged prerequisite gains: `if <P> was squash-merged, catherd cannot see it:
    on the owner's word, drop "<P>" from the After: line with lane_set`.

- [ ] **Step 1: Write the failing tests**

```ts
it("a run without base keeps one sequential step", …);  // existing protocol tests; protocolSteps(run, []).length === 1
it("starts independent milestones side by side in a branch run", async () => {
  // branchRun; lanes M1.L1, M2.L1 (no After) → claimTree M1 and M2 both succeed
  // protocolSteps → ["dispatch M1.L1", "dispatch M2.L1"]; protocolNext joins them with " · "
});
it("holds a milestone whose lane names After: M1 until M1 is landed and merged", …); // step "M2 waits for M1 to land and merge"; claim E_ADMIT_ORDER
it("a squash-merged prerequisite does not release its dependent", …);  // squash M1's branch onto origin main → claim M2 still E_ADMIT_ORDER, fix /lane_set/
it("is actionable while any milestone's step is not covered by a live role", …); // peek: M1 lanes running, M2 "dispatch M2.L1" → actionable true
it("warns when milestones that can run side by side own the same file", …); // M1.L1 and M2.L1 both own src/a.ts, no After → warnings has /side by side/; with After: M1 → none
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `milestoneStep` is today's body from `const mine = …` to `return \`land ${m}\``,
  unchanged. A branch run's land step reads `land M1 (branch t-m1; land checks it contains origin/<base>)`.
- [ ] **Step 4: Run, expect PASS**, plus `bun test test/services/next-step.test.ts test/services/reentry.test.ts`.
- [ ] **Step 5: Commit** — `feat(protocol): branch milestones whose after milestones merged run side by side`.

### Task 9: skill, architect, README, ideas

**Files:**
- Modify: `src/domain/role-prompts.ts:31-70` (architect)
- Modify: `plugin/skills/catherd/SKILL.md` (tool table row `run_start` at `:45`, `land` at `:60`; loop step 10 at
  `:311`; the workspace rule at `:119-120`; a new section "A milestone per branch" after the single-repo sequence)
- Modify: `README.md` (a `### A milestone per branch` subsection under `## Use`, before `### Coordinating several
  repositories` at `:251`)
- Modify: `docs/dev/ideas.md`: delete "Milestone per branch" (`:226-228`), "One run per worktree: `dispatch` takes no
  cwd" (`:182-184`) and "`landedCommitOf` lines up two separately filtered arrays" (`:135-138`). Keep "Stacked
  milestones". Add "Squash merges do not release a milestone's dependents" with Ruling 9's evidence and the
  `lane_set` workaround. Add "Milestone lint: an `After:` milestone with no shared file, and the milestone critical path" (plan 32 Ruling 10; only the shared-files warning is in Task 8).
- Test: `test/skills.test.ts`, `test/domain/verifier-prompt.test.ts` (if it snapshots role prompts)

**Interfaces:** text only. These are the binding lines:
- Architect, appended to the lane-file paragraph on optional lines: "In a branch run each milestone is its own
  branch and merge request from the base, and milestones run side by side: a milestone that builds on another's
  code names it on a lane's After: line (After: M1). When a fresh checkout needs a command before anything runs
  (installing dependencies, generating code), put Setup: <command> on the line under plan.md's # title."
- Skill, the new section must state, one bullet each:
  - `run_start(…, base)` opts in.
  - Each milestone works in its tree. `route` returns `tree` for its lanes. A native Claude role's brief opens
    with `Work only in <tree>; every path is relative to it`.
  - Commit the milestone's work on its branch before the reviewer. Dispatch refuses a dirty tree.
  - After `land`, the push, the MR (its body is the digest at `digestPath`) and the merge need the user's
    authorization and follow the repository's rules. catherd does none of them.
  - Run `branch.precheck` right before the merge. When it fails, integrate (the `land` refusal's fix), get a fresh
    verifier, and land again.
  - Merge with a merge commit. Dependents start once `origin/<base>` contains the branch. Fetching is catherd's,
    at the next dispatch.
  - catherd removes a merged, clean tree. It keeps the branch.
  - The integrate worker's brief: t3herd's `prompts/integrate.md` rules in catherd's words. Resolve every
    conflict so both sides keep their intent. Regenerate a generated file (a client, a lockfile, a module sum)
    with the repository's generator. Change nothing outside the conflicts. Leave the merge uncommitted.
  - Replace "Commits and pushes still require the user's authorization and repository rules; there is no automatic
    commit, push or rollback." at `:119-120` with the same sentence moved to apply to workspaces and branch runs.
- README: what `base` does, where trees live, that catherd never pushes, the merge-commit requirement.

- [ ] **Step 1: Failing test** in `test/skills.test.ts`. The skill text contains `run_start(repo, title, a_lines,
  from?, base?)`, `branch.precheck` and `Work only in <tree>`, and still contains "there is no automatic commit,
  push or rollback".
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Edit the four files.**
- [ ] **Step 4: Run, expect PASS** — `bun test test/skills.test.ts test/plugin.test.ts test/domain`.
- [ ] **Step 5: Commit** — `docs(skill): a milestone per branch: trees, landing, push on the user's word`.

### Task 10: changeset

**Files:**
- Create: `.changeset/milestone-branches.md`

- [ ] **Step 1: Write it**

```md
---
"catherd-cli": minor
---

A milestone per branch: `run_start(…, base)` gives each milestone its own branch and worktree, made from
`origin/<base>` and set up once with the plan's `Setup:` line. Roles work in it, the reviewer and the verifier
start from a committed tree, and their diff is three-dot. `land` requires the branch to contain the latest
`origin/<base>` and returns the precheck to run right before the merge. Milestones whose `After:` milestones are
merged run side by side, and merged worktrees are removed. catherd still never pushes or merges. A run without
`base` works as before.
```

- [ ] **Step 2: Run the full gate once on the combined head**:
  `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`.
  Expected: green.
- [ ] **Step 3: Commit** — `chore(release): changeset for milestone branches`.

## Open questions for the owner (defaults apply until answered)

1. **Squash merges.** Dependents wait for a merge commit (Ruling 9). The way out is to drop the `After:` entry with
   `lane_set`. Should catherd also accept "the MR is merged" from the orchestrator, for repos that squash? Default:
   no.
2. **Pushes on autopilot.** The default keeps catherd's rule: the user authorizes pushes and MRs. t3herd pushes and
   merges on its own. Should a branch run's first push need no question when the owner said "do everything"?
   Default: the skill's rule stands as written.
