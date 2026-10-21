# catherd 2.0, plan 35: a milestone per branch, parallel milestones capped by free memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a run started with `base` gives each milestone its own branch and git worktree, made from `origin/<base>` and set up once by the daemon; every role of the milestone works in that tree; milestones whose `After:` milestones are merged run side by side, a new one starting only while the machine has the free memory for it; a merged milestone's clean tree is removed. A run without `base` behaves as it does after plan 30b: one tree, the repo, one milestone at a time.

**Architecture:** Domain: branch names, `Setup:` and milestone `After:` (`branch.ts`, `lane.ts`), the memory rule (`milestone-memory.ts`), and plan 30's machine gaining one action (`claimTree`), two events (`tree.ready`, `tree.deferred`) and a several-milestone `activeMilestones`. Infra: the memory reader (`memory.ts`). Services: the tree service (`milestone-tree.ts`), and every service and effect that reads the working copy asking `treeOf` instead of `run.meta.repo`. Entry: `run_start` takes `base`. catherd still never pushes, opens an MR or merges.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, `@modelcontextprotocol/sdk`, git ≥ 2.30 (`worktree add --no-track`, `worktree prune`). No new dependency.

**Spec:** `docs/specs/2026-10-12-catherd-2.0-design.md`, decision 21, minus the landing rules plan 30b owns ("landed" meaning origin's base contains the branch, base integration, dependants waiting for the merge, the push question). Plans `docs/plans/2026-10-21-30-run-daemon.md` and `docs/plans/2026-10-21-30b-unattended.md` bind this one (their Design, Produces and Rulings). Input: `docs/plans/drafts-1.6/2026-10-12-33-milestone-branches.md` (D1–D13, Rulings 1–13, its tests), re-shaped for the daemon. t3herd 71cbb6a: `src/state.ts:113-221` (`landed`, `claim`, `nextMilestones`), `prompts/integrate.md`.

**Pre-validation: spiked the git sequence against a local bare origin (`worktree add --no-track -b` from `origin/main`; a second `-b` of the same branch fails with exit 255; `worktree remove` then `worktree add <dir> <branch>` re-adds; `worktree remove` refuses an untracked file and removes a tree holding only ignored files, keeping the branch; `merge-base --is-ancestor` sees a `--no-ff` merge pushed from another clone) and the memory reading on the owner's 18 GB Mac (`os.freemem()` 0.13 GB while `sysctl kern.memorystatus_level` read 50 and `memory_pressure` "System-wide memory free percentage: 50%"), targeted tests only; the full gate runs at execution.** Written against `main` at 2061e6e (1.5.0); plans 28–34 merge first, so every line number below is 1.5's and is re-found by context.


## Owner answers (2026-10-21, binding over the Rulings below)

- The memory numbers are a profile setting: `limits.memory.reserveMb` (default 2048), `limits.memory.perMilestoneMb` (3072) and `limits.memory.floorMb` (3072), validated as positive integers, settable with `catherd profile set` and the panel. `MEMORY_LIMITS` becomes the defaults.
- Ruling 12 is reversed: a "push" answer to the milestone's push question makes catherd run `git push -u origin <branch>` itself, then report the MR command. It never opens an MR and never merges.

## Global Constraints

- Everything in plan 30's and 30b's Global Constraints, unchanged. Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`): `branch.ts`, `milestone-memory.ts` and the machine are domain; `memory.ts` infra; `milestone-tree.ts` a service.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`; executors run each task's targeted files, the full gate once per wave.
- **A run without `base` is unchanged.** No fetch, no `trees/` folder, no `claimTree` action, one active milestone, `treeOf` returns `run.meta.repo`, digests and ranges as 1.5. Every task touching a path both kinds of run share keeps an existing test green or adds one pinning this.
- **No push, no MR, no merge into the base by catherd.** catherd's git writes stay local: `worktree add/remove/prune`, `submodule update`, its commits and the integrate merge on the milestone's own branch. Its network git calls: `fetch -q origin <base>` (60 s, 30b's `fetchBase`) and `submodule update`. Roles stay denied `git push`.
- **Never lose work.** A tree is removed with `git worktree remove` without `--force`; a branch is never deleted; a tree with uncommitted or untracked files stays.
- Tests use a local bare origin (30b's `repoWithOrigin()`, `commitInClone()`), never a URL; memory readings are injected; no wall-clock sleep (`treeLimits.setupMs` is the Setup: seam).
- Commits: conventional, subject ≤ 100 characters, lower-case first word after the scope; check `git log` after each.
- Spec values, verbatim: "A milestone per branch: a worktree from `origin/<base>`, base integration, "landed" meaning origin's base contains the branch, and parallel milestones, capped by free memory (the t3herd shop run swapped 9 GB at load 42–74). A run without `base` behaves as 1.5. Pushes and MRs still need the user's authorization. In a squash-merging repo, dependants are unblocked by hand."

## Design

- **D1. Opt-in per run.** `run_start { …, base? }`: a branch on `origin`, never `origin/main`, a ref path or a range. `runStart` fetches it and refuses `E_INPUT_INVALID` before any run folder exists when `origin/<base>` does not resolve. One value, stored twice: `meta.base` (optional key, schema 1) for the services and the role server, `run.started.base` for the machine (Ruling 1).
- **D2. Where a milestone lives.** `<run dir>/trees/<M>`, its marker `<run dir>/trees/<M>.ready` beside it (never dirtying it); branch `milestoneBranch(title, M)` (`wallet-split-m1`, draft D2).
- **D3. Claiming is a daemon action.** In a base run the machine emits `claimTree{ M }` for an active milestone with no tree, before `route`, one claim at a time in plan order. The effect asks the memory rule (D6): no room → `tree.deferred`, retried at the recheck; else Task 4's `claimTree()` → `tree.ready`. A throw is plan 30's `effect.failed` (one retry, then the milestone parks with the message); the answer resumes the claim.
- **D4. `Setup:`** is a header line under a plan's `# ` title: `<run>/plan.md`'s (the architect writes it, Task 7), else the first of plan 32's input copies (`planDocs(run)`) that has one. It runs in the tree in a heavy slot with the gate's check env, 15 minutes at most; a failure throws `E_TREE` with the output's tail, keeps the tree and writes no `.ready`, so the next claim runs it again.
- **D5. Everything that touches the working copy asks `treeOf(run, m)`**: the tree when `meta.base` is set, `m` is a milestone and the tree exists, else `run.meta.repo`. That covers `admit` (cwd and writable root, the `before` snapshot, `admit.repo`, so finalize diffs the tree), preflight, the fast check, the commit, the gate items' hash, `gate_run`'s cwd and `checkBase`, integrate. What is keyed by repo keeps `run.meta.repo`: profile, `agentFor`, stand-ins, gate env, knowledge, `gates.jsonl`, `checks.jsonl` (a pass carries between a run's trees on equal content). Every role is headless (plan 30 D12), so every role gets the cwd.
- **D6. Parallel milestones, capped by free memory.** `activeMilestones` in a base run: every milestone not landed, merged or parked whose `after` milestones are merged (30b Ruling 17) and that has a tree, plus the first such without one. The `claimTree` effect starts one when `working === 0` (a run always moves), else when `availableMb − floorMb − ramping × estimateMb ≥ estimateMb`; `working` = milestones with a tree not landed, merged or parked; `ramping` = those whose `tree.ready` is younger than `rampMs`, counted at their estimate since their lanes have not reached their memory yet. `availableMb` = Linux `MemAvailable`, macOS `kern.memorystatus_level` × total, else `os.freemem()` (Ruling 5). The heavy slots and 30b's load wait still bound heavy commands machine-wide.
- **D7. Milestone `After:`.** A lane's `After:` may name a milestone (`After: M1`). `MilestonePlan.after = milestoneAfter(lanes, m)`. In a base run a cross-milestone entry waits for that milestone's merge; with no entry a milestone starts from the base beside the others (Ruling 8).
- **D8. Briefs carry the branch** (draft D8): every dispatch of a base-run milestone gets ``You work in <tree>, on branch <branch>, which starts from origin/<base>. The milestone's diff is `git diff origin/<base>...HEAD`: three dots, because other milestones land on the base meanwhile and a two-dot diff shows their work as deleted here.``, and the reviewer's range is that diff.
- **D9. Ranges** (draft D12): in a base run `milestoneFiles` diffs `origin/<base>...<commit>`, `milestoneCommits` logs `origin/<base>..<commit>`.
- **D10. Removal.** `checkMerged` (30b), once git or an answered `push` question says merged, calls `removeTree` (no `--force`), then appends `milestone.merged`; a tree with uncommitted or untracked files stays, logged. In a base run it also runs every 10 minutes while a landed milestone's `push` question is open, so trees go and the run ends once the owner merges.
- **D11. Integrate and the push question** (30b Rulings 14, 15) use the tree and `M.branch`. The question reads: `M1 landed on <branch> at <commit12>: push it (git -C <repo> push -u origin <branch>), open its MR with <digestPath> as the body, and merge it with a merge commit; right before the merge run git -C <tree> fetch -q origin <base> && git -C <tree> merge-base --is-ancestor origin/<base> HEAD. Answer once it is merged; in a repo that squash-merges, catherd cannot see the merge, so your answer is what unblocks the milestones after it.`

## Produces (for plans 36 and later)

```ts
// src/domain/branch.ts
export function runSlug(title: string): string;                 // moved from run-store.ts:83, unchanged
export function milestoneBranch(title: string, m: string): string;   // `${runSlug(title)}-${m.toLowerCase()}`
export const BaseBranchSchema: z.ZodType<string>;               // BaseRefSchema, refusing "origin/…" and "refs/…"
export function planSetup(planText: string): string | null;     // Setup: under plan.md's # title, backticks stripped
export const unitMilestone = (unit: string): string | null;      // "run" → null; "M1" → "M1"; "M1.L2" → "M1"
// src/domain/lane.ts
export function milestoneAfter(lanes: { id: string; after: string[] }[], m: string): string[];  // numeric order
// src/domain/milestone-memory.ts
export const MEMORY_LIMITS = { estimateMb: 3072, floorMb: 2048, rampMs: 300_000, recheckMs: 120_000 } as const;
export type MemoryLimits = { estimateMb: number; floorMb: number; rampMs: number; recheckMs: number };
export function memoryLoad(ms: { tree: string | null; status: string; treeAt: string | null }[], nowMs: number, l?: MemoryLimits): { working: number; ramping: number };
export function mayStartMilestone(i: { availableMb: number; working: number; ramping: number }, l?: MemoryLimits): boolean;
export const neededMb = (ramping: number, l?: MemoryLimits): number;  // floorMb + (ramping + 1) × estimateMb
// src/infra/memory.ts
export function availableMemoryMb(o?: { platform?: NodeJS.Platform; sysctl?: () => string | null; meminfo?: () => string | null }): number;
// src/domain/errors.ts: ErrorCode gains "E_TREE"
// src/domain/run-events.ts (plan 30's union gains)
//  tree.ready    { milestone, tree, branch, base, hints: string[] }
//  tree.deferred { milestone, availableMb: number, needMb: number }
// src/domain/run-state.ts: MilestoneState gains tree: string | null, branch: string | null, treeAt: string | null, claimAfter: string | null
// src/domain/run-machine.ts: Action gains { type: "claimTree"; milestone: string }; actionKey "claimTree:<M>"
// src/services/milestone-tree.ts
export const treeLimits = { setupMs: 15 * 60_000 };
export const memoryReader = { read: (): number => availableMemoryMb() };   // test seam
export const treeDir = (run: Run, m: string): string;          // <run dir>/trees/<m>
export function treeOf(run: Run, m: string | null): string;     // sync
export interface TreeClaim { tree: string; branch: string; base: string; hints: string[] }
export async function claimTree(deps: Deps, run: Run, m: string, o: { known: boolean }): Promise<TreeClaim>;
export async function removeTree(run: Run, m: string): Promise<{ removed: boolean; hint: string | null }>;
// src/services/admission.ts: AdmitInput.cwd?: string
// src/services/milestone-check.ts (30b): checkBase(run: Run, m?: string): Promise<string | null>
```

## Cross-plan interfaces

- **Consumes from plan 30** (its Produces, exact names): `RunEventSchema`/`RunEvent`/`RunEventInput`, `describeEvent`, `run.started.base`, `MilestonePlanSchema` (`after`), `MilestoneState`, `RunState` (`base`, `wakeAt`, `failedEffects`), `reduce`, `replay`, `activeMilestones` ("plan 35: several"), `Action`, `next`, `actionKey`, `confirms`, `effect.failed`, `Effects`/`realEffects` (`dispatch`, `route`, `fastCheck`, `commit`, `land`, `finish`), `planOf`, `briefFor`, `runStart(deps, i: { repo, title, aLines })`, the session tool `run_start`, `daemonLimits`. If plan 30 wrote `advance` for `activeMilestones(s)[0]` only, Task 5 makes it loop over all of them.
- **Consumes from plan 30b:** `fetchBase(repo, base, timeoutMs?)`, `isAncestor(repo, commit, ref)`, `currentBranch(repo)` (`src/infra/git.ts`); `landedCommitOf`; `checkBase(run)`, `runMilestoneCheck`, `CheckJob { run, repo, cwd, … }`, `machineGate` (`src/services/milestone-check.ts`); the `land` (base run: `base.behind`), `integrate` and `checkMerged` effects; the base-run transitions (Rulings 14–17: `after` milestones must be merged, the `push` park, an answered `push` question counting as merged, the 10-minute merge check); `repoWithOrigin()`, `commitInClone()` (`test/helpers.ts`). If 30b keys `checks.jsonl` by the cwd's toplevel, Task 6 keys it by `CheckJob.repo` (`run.meta.repo`).
- **Consumes from plan 32:** the architect's brief body in `briefFor` (Task 7 appends two sentences in a base run); `planDocs(run): PlanDoc[]` (`src/services/plan-input.ts`: the input copies under `<run>/plan-input/`, else plan.md), whose text `planSetup` reads; `run_start`'s `plan`, kept beside `base`; plan 32's `orderProblems` addition (`Tasks:` refs) beside Task 1's.
- **Plan 31:** `RunView` is unchanged; a milestone's branch and a memory wait reach the timeline through `describeEvent`.
- **Plan 36:** MIGRATION "From 1.5 to 2.0" gains "### A milestone per branch" (Task 8), which 36 consolidates.

## Review Focus

1. **macOS reports almost no free memory through `os.freemem()`.** Expected: the reader uses `kern.memorystatus_level`, so an idle 18 GB Mac starts a second milestone; when sysctl fails, `os.freemem()` is used and the run still moves one milestone at a time. Task 2: "reads macOS's free percentage, Linux's MemAvailable, and falls back to os.freemem".
2. **The memory reading is low while nothing works yet, or every working milestone parks.** Expected: the first milestone (and any milestone while none is working) starts regardless; a parked milestone's tree does not count as working. Task 2: "always lets a milestone start when none is working"; Task 5: "a parked milestone keeps its tree and does not count as working".
3. **The daemon dies mid-claim** (tree added, Setup: unfinished) **and is revived.** Expected: the claim reuses the tree and runs Setup: again, since `.ready` was never written; no second tree, no `-b` error. Task 4: "resumes a claim a crash interrupted".
4. **A branch with the milestone's name already exists from another run of the same title.** Expected: `E_TREE` naming the branch and `git branch -m`; the branch's commit is unchanged; after one retry the milestone parks with that message, and the rest of the run goes on. Task 4: "refuses a branch with the milestone's name that is not this run's"; Task 5: "parks a milestone whose claim failed twice, and claims it again after the answer".
5. **A merged milestone's tree holds untracked work.** Expected: the tree stays with its files, a warn log names it, `milestone.merged` is still appended so dependants start. Task 4: "never removes a tree with untracked files"; Task 7: "removes a merged milestone's clean tree, keeps a dirty one, and appends milestone.merged either way".

## Rulings

Step 0, decision 21 against 1.5.0 and plans 30/30b: the landing rules (origin contains the branch, integrate, merged dependants, the push park, squash by answer) are 30b's and only re-pointed at the tree here; lane `After:` order is 1.5's (`src/domain/lane.ts:14-15`, `src/services/protocol.ts:105-124`), and a whole-milestone entry already works in `unfinishedAfter` once `LANE_ID` accepts it; worktrees, Setup:, parallel milestones and the memory cap are absent (`grep -rn worktree src` finds only comments).

1. Ruling: `base` lives in `meta.base` and `run.started.base`, both from `runStart` — the role server and the 1.5 services see only `Run`, the machine only events — a hand-edited meta.json disagrees with the events; `treeOf` follows meta.
2. Ruling: this plan adds one action and two events to plan 30's unions — 30 Ruling 1 bound 30b, and 30 names this plan as `activeMilestones`' consumer; claiming needs a fact the machine can wait on — none.
3. Ruling: a failed claim is plan 30's `effect.failed` (one retry, then park with the message and fix); one new code `E_TREE` — draft Rulings 8, 10 — a foreign branch costs one pointless retry.
4. Ruling: a claim knows a branch is this run's from `MilestoneState.branch` (a `tree.ready` happened), not the ledger (draft D3) — the daemon re-claims after a crash or a removed folder before anything lands — a crash between `worktree add` and the append leaves a folder, which the claim reuses.
5. Ruling: available memory is Linux `MemAvailable`, macOS `kern.memorystatus_level` × total, else `os.freemem()` — the brief named `os.freemem()`, but on the owner's Mac it read 0.13 GB of 18 GB while the kernel reported 50 % free, so macOS would never run two milestones — where both readings fail the run goes one milestone at a time.
6. Ruling: start when nothing works, else when `available − 2048 − ramping × 3072 ≥ 3072` MB, a new milestone counted at its estimate for 5 minutes, recheck every 2 minutes — the shop run swapped 9 GB with unbounded milestones; 3 GB is one milestone's workers, checks and dev server at that fan-out; the owner's 18 GB Mac (8–9 GB available) runs two — constants, not a profile setting (Owner question 1) — a repo needing 6 GB per milestone swaps at two.
7. Ruling: one claim at a time, in plan order — each reading counts the previous claim — a small milestone waits behind a large deferred one.
8. Ruling: no implicit order for milestones sharing files and no overlap warning (draft Task 8 dropped) — textual conflicts are integrate's (30b), semantic order is an `After:` line the architect writes — a 1.5 plan with no milestone `After:` runs side by side, so the architect's base-run sentence is binding; a hot shared file costs an integrate worker per milestone.
9. Ruling: draft D8's dirty-tree refusal, D7's native `route.tree`, D11's tip check and D13's `protocolSteps` are not built — plan 30 commits before reviewers and verifiers, runs every role headless, takes `M.commit` from the tree's HEAD, and retired `protocol.next` — none.
10. Ruling: `Setup:` and submodules run in a heavy slot — an install is a milestone's heaviest command — a slow first install delays other runs' checks.
11. Ruling: `submodule update --init --recursive` is the one network git call beside `fetch origin <base>` — the tree must build (t3herd does it) — a submodule host down parks the claim after one retry.
12. Ruling: the push stays the owner's; the question carries the branch, push command, digest, precheck and merge-commit rule — "Pushes and MRs still need the user's authorization" — a night run's milestones wait for one answer each (Owner question 2).
13. Ruling: a squash merge is unblocked by the owner's answer to the `push` question (30b Ruling 16), which also lets `checkMerged` remove that tree — the owner default — one answer per milestone.
14. Ruling: ledger minutes still count from the previous landing of any milestone — the scorecard measures per run — parallel milestones' minutes read short.
15. Ruling: `ideas.md` "Milestone per branch" and "One run per worktree: `dispatch` takes no cwd" close; "Stacked milestones" stays; "Carried gate passes are not shared between worktrees" narrows to worktrees the user made — the platform run's need (a branch and MR per step) is a base run — one run per existing user worktree is still not possible.
16. Ruling: a kept (dirty) tree is only logged and never retried — no event type for it — the owner finds it under `<run>/trees/` (an ideas.md entry).

Owner questions (each built as stated until answered):

1. The memory numbers are constants (3 GB per milestone, 2 GB floor). Should they be a profile setting? Built: constants, with an ideas.md entry to measure the run's process tree on the scorecard runs.
2. On autopilot, should an answer of `push` to a landed milestone's question let catherd push the branch itself (still no MR, no merge)? Built: no; catherd's rule stands.

## Parallelism

| Wave | Tasks | Files |
| --- | --- | --- |
| 1 | 1 ∥ 2 | 1: `src/domain/{branch,lane}.ts`, `src/services/run-store.ts` (the `runSlug` import), tests · 2: `src/domain/milestone-memory.ts`, `src/infra/memory.ts`, tests |
| 2 | 3 ∥ 5 | 3: `src/services/{run-store,run-client}.ts`, `src/entry/mcp/session-tools.ts`, `test/services/helpers.ts` · 5: `src/domain/{run-events,run-state,run-machine}.ts`, their tests |
| 3 | 4 | `src/services/milestone-tree.ts`, `src/domain/errors.ts`, its test (needs Task 3's `branchRun`) |
| 4 | 6 | `src/services/{admission,preflight,gate-service,milestone-check,milestones}.ts`, their tests |
| 5 | 7 | `src/services/{run-effects,run-briefs}.ts`, their tests |
| 6 | 8, then 9 | skill, README, MIGRATION, ideas, `test/skills.test.ts` · `.changeset/milestone-branches.md` |

Tasks 1 and 3 both touch `run-store.ts` (an import; the meta key), in different waves. Task 5 and Task 7 meet only through Produces names.

---

### Task 1: domain — branch name, `Setup:`, whole-milestone `After:`

**Files:**
- Create: `src/domain/branch.ts`
- Modify: `src/domain/lane.ts:20-21` (`LANE_ID`), `:96-110` (`orderProblems` message), new export `milestoneAfter`
- Modify: `src/services/run-store.ts:83` (import `runSlug` from the domain)
- Test: `test/domain/branch.test.ts` (new), `test/domain/lane.test.ts`

**Interfaces:**
- Consumes: `slug` (`src/domain/util.ts:2`), `BaseRefSchema` (`src/domain/workspace.ts:16-19`), `headerBlock`, `headerLine` (`src/domain/lane.ts:37,47`).
- Produces: the `branch.ts` and `milestoneAfter` lines of Produces. `LANE_ID` becomes `/^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9._-]*)?$/`; the refusal reads `After "<x>" is not a lane or milestone id like M1.L1 or M1`. `milestoneAfter` maps each entry to `entry.split(".")[0]`, drops `m`, dedupes, sorts with `localeCompare(…, "en", { numeric: true })`.

- [ ] **Step 1: Write the failing tests** (draft Task 1's, plus):

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
  expect(planSetup("# Plan\nSetup: `pnpm install`\n\n## M1\nSetup: no")).toBe("pnpm install");
  expect(planSetup("# Plan\n\nSetup: body prose")).toBeNull();
});
it("names a unit's milestone", () => expect(["run", "M1", "M1.L2"].map(unitMilestone)).toEqual([null, "M1", "M1"]));
// test/domain/lane.test.ts
it("accepts a whole milestone in After:", () => {
  expect(parseLaneHeader("# M2.L1 — x\nAfter: M1, M1.L2\n").after).toEqual(["M1", "M1.L2"]);
  expect(() => assertLaneValues("# M2.L1 — x\nAfter: M1 L2\n", "lanes/M2.L1.md")).toThrow(/lane or milestone id/);
});
it("lists the milestones a milestone's lanes wait on, other than itself", () =>
  expect(milestoneAfter([{ id: "M3.L1", after: ["M10", "M2.L1"] }, { id: "M3.L2", after: ["M3.L1", "M2"] }, { id: "M1.L1", after: [] }], "M3"))
    .toEqual(["M2", "M10"]));
```

- [ ] **Step 2: Run** `bun test test/domain/branch.test.ts test/domain/lane.test.ts`. Expected: FAIL (module missing; the After refusal text).
- [ ] **Step 3: Implement** as in Interfaces; `run-store.ts` imports `runSlug` and drops its local one.
- [ ] **Step 4: Run** the Step 2 command and `bun test test/services/lane-headers.test.ts test/services/lane-edit.test.ts test/services/run-store.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(lanes): milestone branch names, a plan's setup line, whole-milestone after entries"`

### Task 2: the memory rule and its reader

**Files:**
- Create: `src/domain/milestone-memory.ts`, `src/infra/memory.ts`
- Test: `test/domain/milestone-memory.test.ts`, `test/infra/memory.test.ts`

**Interfaces:**
- Consumes: `freemem`, `totalmem` (`node:os`). `memoryLoad` takes a structural row type, so it does not wait for Task 5's `MilestoneState` fields; `MilestoneState[]` satisfies it once they exist.
- Produces: the `milestone-memory.ts` and `memory.ts` lines of Produces.
  - `memoryLoad`: `working` counts milestones with `tree !== null` and `status` not in `landed | merged | parked`; `ramping` those of them with `Date.parse(treeAt) > nowMs − rampMs`.
  - `availableMemoryMb`: `darwin` → `sysctl()` (default `Bun.spawnSync(["sysctl", "-n", "kern.memorystatus_level"])`, stdout or null on a non-zero exit or a throw) parsed as an integer 0–100 → `Math.floor(level / 100 × totalmem() / 2^20)`; `linux` → `meminfo()` (default `readFileSync("/proc/meminfo", "utf8")`, null on a throw) matched by `/^MemAvailable:\s+(\d+) kB$/m` → `Math.floor(kB / 1024)`; anything unreadable, or another platform → `Math.floor(freemem() / 2^20)`. Never throws.

- [ ] **Step 1: Write the failing tests:**

```ts
it("always lets a milestone start when none is working", () =>
  expect(mayStartMilestone({ availableMb: 0, working: 0, ramping: 0 })).toBe(true));
it("starts another milestone only with its estimate above the floor, counting ramping ones at theirs", () => {
  expect(mayStartMilestone({ availableMb: 5120, working: 1, ramping: 0 })).toBe(true);    // 5120 − 2048 ≥ 3072
  expect(mayStartMilestone({ availableMb: 5119, working: 1, ramping: 0 })).toBe(false);
  expect(mayStartMilestone({ availableMb: 8191, working: 2, ramping: 1 })).toBe(false);   // 8192 needed
  expect(neededMb(1)).toBe(8192);
});
it("counts working milestones, and ramping ones by their tree's age", () => {
  const now = Date.parse("2026-10-21T10:10:00.000Z");
  expect(memoryLoad([ms("M1", "lanes", "2026-10-21T10:00:00.000Z"), ms("M2", "review", "2026-10-21T10:08:00.000Z"),
    ms("M3", "parked", "2026-10-21T10:09:00.000Z"), ms("M4", "waiting", null)], now)).toEqual({ working: 2, ramping: 1 });
});
// test/infra/memory.test.ts
it("reads macOS's free percentage, Linux's MemAvailable, and falls back to os.freemem", () => {
  expect(availableMemoryMb({ platform: "darwin", sysctl: () => "50\n" })).toBe(Math.floor((0.5 * totalmem()) / 2 ** 20));
  expect(availableMemoryMb({ platform: "linux", meminfo: () => "MemTotal: 1 kB\nMemAvailable:    8388608 kB\n" })).toBe(8192);
  const free = Math.floor(freemem() / 2 ** 20);
  for (const o of [{ platform: "darwin" as const, sysctl: () => null }, { platform: "darwin" as const, sysctl: () => "x" },
    { platform: "linux" as const, meminfo: () => "MemFree: 1 kB" }, { platform: "win32" as const }])
    expect(Math.abs(availableMemoryMb(o) - free)).toBeLessThan(256);   // freemem moves between reads
});
```

- [ ] **Step 2: Run** `bun test test/domain/milestone-memory.test.ts test/infra/memory.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces. A `sysctl` level outside 0–100 counts as unreadable.
- [ ] **Step 4: Run** the Step 2 command and `bun test test/architecture.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): how much memory a new milestone needs, and how much the machine has"`

### Task 3: `run_start` takes `base`

**Files:**
- Modify: `src/services/run-store.ts:34-46` (`RunMetaSchema.base: z.string().optional()`), `:87-…` (`createRun` takes `base?: string`, written to meta only when set)
- Modify: `src/services/run-client.ts` (`runStart` input gains `base?: string`), `src/entry/mcp/session-tools.ts` (`run_start`'s `base: BaseBranchSchema.optional()`, its description)
- Modify: `test/services/helpers.ts` (new `branchRun`)
- Test: `test/services/run-client.test.ts`, `test/entry/session-tools.test.ts`

**Interfaces:**
- Consumes: `fetchBase`, `git` (`src/infra/git.ts`), `BaseBranchSchema`, `repoWithOrigin` (30b).
- Produces: `run.meta.base: string | undefined`; `run.started.base` = `i.base ?? null`; `branchRun(title = "t"): { repo: string; origin: string; run: Run }` (`withHome`, `repoWithOrigin`, `createRun({ …, base: "main" })`). With `base`, `runStart` runs `fetchBase(repo, base)`, then `git rev-parse --verify --quiet origin/<base>^{commit}`; a failure throws `E_INPUT_INVALID` `origin/<base> does not exist in <repo>`, fix `pass a branch origin has, or omit base`, before `createRun`. `run_start`'s description gains: "base: a branch on origin (main, staging): each milestone then gets its own branch and worktree from origin/<base>, and independent milestones run side by side; without it the run works in the repo."

- [ ] **Step 1: Write the failing tests:**

```ts
it("records base in meta and run.started, after fetching it", async () => {
  const { repo, origin } = repoWithOrigin();
  commitInClone(origin, "x");                                  // origin main moves past the local copy
  const r = await runStart(deps, { repo, title: "w", aLines: ["A1 x"], base: "main" });
  const run = findRun(r.run);
  expect(run.meta.base).toBe("main");
  expect(readEvents(run)[0]).toMatchObject({ type: "run.started", base: "main" });
  expect(git(repo, "rev-parse", "origin/main")).toBe(git(origin, "rev-parse", "main"));
});
it("refuses a base origin does not have, creating no run", async () => {
  const before = listRuns().length;
  const e = await refusal(runStart(deps, { repo, title: "w", aLines: ["A1 x"], base: "nope" }));
  expect([e.code, listRuns().length]).toEqual(["E_INPUT_INVALID", before]);
});
it("a run without base has no meta.base and run.started.base null", …);
it("run_start refuses a remote ref as base", …);   // session tool, base "origin/main" → schema error
```

- [ ] **Step 2: Run** `bun test test/services/run-client.test.ts test/entry/session-tools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** the Step 2 command and `bun test test/services/run-store.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(runs): run_start takes a base branch for a milestone per branch"`

### Task 4: the tree service

**Files:**
- Create: `src/services/milestone-tree.ts`
- Modify: `src/domain/errors.ts:1-35` (`"E_TREE"`)
- Test: `test/services/milestone-tree.test.ts` (new)

**Interfaces:**
- Consumes: `milestoneBranch`, `planSetup` (Task 1); `availableMemoryMb` (Task 2); `fetchBase`, `currentBranch`, `git` (30b, `src/infra/git.ts`); `runCheck`, `checkEnvFor` (`src/services/preflight.ts:126,226`); `withHeavySlot`, `heavySlots` (`src/infra/heavy-lock.ts:11,20`); `runProfile` (`src/services/run-pin.ts`); `runPaths(run.dir).plan`, plan 32's `planDocs`; `log`.
- Produces: the `milestone-tree.ts` block of Produces. `claimTree(deps, run, m, { known })`, in order:
  1. No `run.meta.base` → `E_INPUT_INVALID`.
  2. `fetchBase(run.meta.repo, base)`; false → hint `fetch of origin/<base> failed: using the copy from the last fetch`.
  3. `git worktree prune` in the repo.
  4. The folder exists: `currentBranch(tree)` must be the branch, else `E_TREE` `<tree> has <x> checked out, not <branch>`, fix `move the folder away, then answer`.
  5. No folder, the branch exists: `known` → `git worktree add <tree> <branch>`; else `E_TREE` `branch <branch> exists and is not this run's`, fix `rename it (git branch -m <branch> <branch>-old) or delete it, then answer`.
  6. Neither → `git worktree add --no-track -b <branch> <tree> origin/<base>`.
  7. Unless `<tree>.ready` exists: `git submodule update --init --recursive` when `.gitmodules` exists, then the first non-null `planSetup` over plan.md and `planDocs(run)` (D4); success writes `.ready`. A failure throws `E_TREE` `Setup: <command> exited <code> in <tree>: <last 1500 characters>` (or `timed out after 15 min`), fix `correct the Setup: line in plan.md or the machine, then answer`; the submodule failure reads `git submodule update failed in <tree>`.
  `removeTree`: no folder → `{ removed: false, hint: null }`; `git worktree remove <tree>` ok → delete `.ready`, `{ removed: true, hint: null }`; refused → `{ removed: false, hint: "kept <tree>: it has uncommitted or untracked files; git worktree remove it once they are saved" }`.

- [ ] **Step 1: Write the failing tests** (each on Task 3's `branchRun()`; plan.md written with `writeFileSync(runPaths(run.dir).plan, …)`; `treeLimits` restored in `afterEach`):

```ts
it("claims a milestone from origin's base, not the local one, runs Setup: once, and finds the same tree again", async () => {
  // plan.md "# P\nSetup: echo ok > setup.txt"; commitInClone(origin, "x") moved origin main past the local main
  const a = await claimTree(deps, run, "M1", { known: false });
  expect([a.tree, a.branch, a.base]).toEqual([treeDir(run, "M1"), "t-m1", "main"]);
  expect(git(a.tree, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "origin/main"));
  expect(existsSync(join(a.tree, "setup.txt"))).toBe(true);
  rmSync(join(a.tree, "setup.txt"));
  await claimTree(deps, run, "M1", { known: true });
  expect(existsSync(join(a.tree, "setup.txt"))).toBe(false);   // .ready: no second setup
  expect([treeOf(run, "M1"), treeOf(run, null), treeOf(run, "M2")]).toEqual([a.tree, run.meta.repo, run.meta.repo]);
});
it("throws E_TREE on a failed Setup:, keeps the tree, and runs Setup: again on the next claim", …);  // "exit 3" → /exited 3/; then "true" → ok, .ready
it("times Setup: out at its limit", …);                                     // treeLimits.setupMs = 50, "sleep 5" → /timed out/
it("refuses a branch with the milestone's name that is not this run's", async () => {
  git(repo, "branch", "t-m1"); const sha = git(repo, "rev-parse", "t-m1");
  const e = await refusal(claimTree(deps, run, "M1", { known: false }));
  expect([e.code, e.fix?.includes("git branch -m"), git(repo, "rev-parse", "t-m1")]).toEqual(["E_TREE", true, sha]);
});
it("re-adds this run's branch when its tree folder is gone", …);              // claim, commit in tree, rm -rf the folder → known: true → same branch tip
it("resumes a claim a crash interrupted: the tree is reused and Setup: runs since it never finished", …);  // worktree add by hand, no .ready
it("works from the last fetch when origin cannot be reached, and says so", …);   // remote set-url origin /nonexistent → tree made, hints /last fetch/
it("never removes a tree with untracked files, and removes a clean one, ignored files and all, keeping its branch", …);
it("treeOf is the repo for a run without base", …);                            // freshRun: treeOf(run, "M1") === repo, no trees/ dir
```

- [ ] **Step 2: Run** `bun test test/services/milestone-tree.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces; `treeOf` is `existsSync`-based and sync.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(runs): a worktree per milestone, claimed from origin's base and set up once"`

### Task 5: the machine runs milestones side by side

**Files:**
- Modify: `src/domain/run-events.ts` (two members, `describeEvent`), `src/domain/run-state.ts` (the four `MilestoneState` fields, `reduce`, `activeMilestones`, `wakeAt`), `src/domain/run-machine.ts` (`claimTree`, the advance rules, `actionKey`, `confirms`, lane readiness)
- Test: `test/domain/run-events.test.ts` (`oneOfEach` gains both), `test/domain/run-state.test.ts`, `test/domain/run-machine.test.ts`

**Interfaces:**
- Consumes: plan 30's machine and state, 30b's base-run rules, `MEMORY_LIMITS.recheckMs`, `unitMilestone`.
- Produces: the run-events, run-state and run-machine lines of Produces, as these rules (a run without base: none of them):

| Event or state | Effect on state / actions |
| --- | --- |
| `tree.ready` | M: `tree`, `branch`, `treeAt = at`, `claimAfter = null` |
| `tree.deferred` | M: `claimAfter = at + recheckMs`; `wakeAt` includes it |
| `activeMilestones` (base) | not `landed`/`merged`/`parked`, every `after` merged; those with a tree, plus the first in plan order without one |
| active `waiting`, `tree` null, `claimAfter` null or ≤ `s.at` | `claimTree{ M }` (`actionKey` `claimTree:<M>`; confirmed by `tree.ready`, `tree.deferred`, `effect.failed{ action: "claimTree", unit: M }`) |
| active `waiting`, `tree` set | plan 30's `route{ M, confirmed: false }` |
| lane `after` entry | same milestone: that lane `done` · other milestone's lane, or a milestone id: that milestone landed or merged; in a base run merged |
| base: landed M whose `push` question is open, 10 min since its last `checkMerged` or its landing | `checkMerged{ M }` (30b's 10-minute wake, widened from "while another waits on it") |
| `question.answered` on a `push` question | 30b's merged count, plus `checkMerged{ M }` so its tree goes |

`describeEvent`: `M1 has its worktree on branch t-m1` · `M2 waits for memory: 3100 MB available, 5120 MB needed`.

- [ ] **Step 1: Write the failing tests** (plan 30's `feed`, `started`, `ev`; `base` fixtures feed `run.started{ base: "main" }`):

```ts
it("a run without base never claims a tree and keeps one milestone active", () => {
  const f = feed([started(), planReady(["M1", "M2"])]);
  expect(f.all.some((a) => a.type === "claimTree")).toBe(false);
  expect(activeMilestones(f.state).map((m) => m.id)).toEqual(["M1"]);
});
it("claims a base run's first milestone, then routes it in its tree", () => {
  const f = feed([started({ base: "main" }), planReady(["M1"])]);
  expect(f.last).toContainEqual({ type: "claimTree", milestone: "M1" });
  expect(feed([...f.events, treeReady("M1")]).last).toContainEqual({ type: "route", milestone: "M1", confirmed: false });
});
it("starts independent milestones side by side, one claim at a time", () => {
  const f = feed([started({ base: "main" }), planReady(["M1", "M2", "M3"])]);
  expect(claims(f.all)).toEqual(["M1"]);
  const g = feed([...f.events, treeReady("M1")]);
  expect(claims(g.last)).toEqual(["M2"]);
  expect(activeMilestones(g.state).map((m) => m.id)).toEqual(["M1", "M2"]);
});
it("holds a milestone whose lane names After: M1 until M1 is merged, and a cross-milestone lane entry likewise", …);
it("waits out a memory deferral and claims again at the recheck", () => {
  const f = feed([...baseRun(["M1", "M2"]), treeReady("M1"), deferred("M2", "2026-10-21T10:00:00.000Z")]);
  expect(f.state.wakeAt).toBe("2026-10-21T10:02:00.000Z");
  expect(claims(f.last)).toEqual([]);
  expect(claims(feed([...f.events, tick("2026-10-21T10:02:00.000Z")]).last)).toEqual(["M2"]);
});
it("parks a milestone whose claim failed twice, and claims it again after the answer", …);
it("checks a landed milestone's merge every 10 minutes while its push question is open, even when nothing waits on it", …);
it("a parked milestone keeps its tree and does not count as working", () =>
  expect(memoryLoad(feed([...baseRun(["M1"]), treeReady("M1"), parked("M1", "environment")]).state.milestones, NOW).working).toBe(0));
it("never returns two claimTree actions at once", …);        // over every fixture state of the file
```

- [ ] **Step 2: Run** `bun test test/domain/run-events.test.ts test/domain/run-state.test.ts test/domain/run-machine.test.ts`. Expected: FAIL (the new tests; plan 30's and 30b's still pass).
- [ ] **Step 3: Implement.** `advance` iterates every active milestone; the lane rule reads `s.base` for the merged-or-landed choice.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): base-run milestones claim a tree and run side by side"`

### Task 6: the services read the milestone's tree

**Files:**
- Modify: `src/services/admission.ts:50-63` (`AdmitInput.cwd?: string`), `:236-242`, `:253-262`, `:305`, `:328` (`const cwd = i.cwd ?? run.meta.repo` for `prepared`'s and `adapter.plan`'s `repo`, `statusSnapshot`, `admitted.repo`; `agentFor`, `standInFor`, `readGateEnv` keep `run.meta.repo`)
- Modify: `src/services/preflight.ts:267-355` (`const cwd = treeOf(run, i.milestone ?? null)` for the unborn check and `runCheck`; `checkEnvFor` and `repoLinter` keep the repo)
- Modify: `src/services/gate-service.ts:319-322` (`carryingPass(repo, command, paths, cwd = repo)`: hash in `cwd`, passes from `repo`), `:330-358` (`recordedItems` hashes in `treeOf(run, m)`), `:374-400` (`gateCheck`: in a base run without `milestone` → `E_INPUT_INVALID` `a base run's gate_check names its milestone`, fix `pass milestone`; else hash in its tree), `:437-459` (`gatePass`: the tree of the milestone of the latest step with the same item and command; HEAD from that tree)
- Modify: `src/services/milestone-check.ts` (30b: `checkBase(run, m?)`; `runMilestoneCheck`'s cwd `i.at ?? treeOf(run, i.milestone)`; `CheckJob.repo` stays `run.meta.repo`), `src/services/milestones.ts:266-297` (`milestoneFiles`, `milestoneCommits`: D9 in a base run)
- Test: `test/services/admission.test.ts`, `test/services/preflight.test.ts`, `test/services/gate-service.test.ts`, `test/services/milestone-check.test.ts`, `test/services/ledger.test.ts`

**Interfaces:**
- Consumes: `treeOf`, `claimTree` (Task 4, to make trees in tests), `branchRun` (Task 3).
- Produces: `AdmitInput.cwd`, `checkBase(run: Run, m?: string): Promise<string | null>` — in a base run with `m`: `git -C <tree> merge-base origin/<base> HEAD`, null when git cannot say; otherwise 30b's `run.meta.startHead ?? null`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("admits in the given tree: the role's cwd, its before snapshot and admit.repo", async () => {
  // branchRun; claimTree M1; an untracked file in the repo only; admit worker-M1.L1 with cwd: tree
  expect([spec.cwd, d.admit.repo, Object.keys(d.admit.before)]).toEqual([tree, tree, []]);
});
it("without cwd, admits in the repo as 1.5", …);                    // freshRun; spec.cwd === repo, admit.repo === repo
it("preflights a base-run milestone's lanes in its tree", …);        // check `test -f marker`, the marker only in the tree → pass
it("hashes a base-run milestone's gate items in its tree, and carries a pass between a run's trees on equal content", …);
it("refuses gate_check without a milestone in a base run", …);
it("runs gate_run in the milestone's tree and takes its base from origin's base", …);   // record.head = tree HEAD; checkBase = merge-base
it("checkBase is the start HEAD in a run without base", …);
it("a base-run digest lists only the branch's own commits and files, whatever landed before", …);   // M2 lands after M1 on another branch
```

- [ ] **Step 2: Run** `bun test test/services/admission.test.ts test/services/preflight.test.ts test/services/gate-service.test.ts test/services/milestone-check.test.ts test/services/ledger.test.ts`. Expected: FAIL (the new tests).
- [ ] **Step 3: Implement** per Files. In `milestones.ts` the base-run branch runs before the 1.5 one and returns; a failed git keeps each function's 1.5 failure behavior.
- [ ] **Step 4: Run** the Step 2 command and `bun test test/services/dispatch.test.ts test/services/land-gate.test.ts test/services/verifier-brief.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(gate): admission, preflight and the gate read the milestone's worktree"`

### Task 7: the daemon's effects and briefs work in the tree

**Files:**
- Modify: `src/services/run-effects.ts` (`claimTree` effect; `dispatch`, `fastCheck`, `commit`, `integrate` in `treeOf(run, unitMilestone(unit))`; `checkMerged` removes the tree; the `push` question's text; `planOf`'s `after`), `src/services/run-briefs.ts` (the branch line, the reviewer's three-dot range, the architect's base-run sentences)
- Test: `test/services/run-effects.test.ts`, `test/services/run-briefs.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6; plan 30's `Effects`, `briefFor`, `planOf`; 30b's `integrate`, `checkMerged`, `land` effects.
- Produces, per action:
  - `claimTree{ M }`: `const load = memoryLoad(s.milestones, deps.now())`, `const availableMb = memoryReader.read()`; `!mayStartMilestone({ availableMb, ...load })` → `tree.deferred{ milestone, availableMb, needMb: neededMb(load.ramping) }`; else `claimTree(deps, run, M, { known: M.branch !== null })` → `tree.ready{ milestone, tree, branch, base, hints }`, each hint also logged.
  - `dispatch`: `admit(…, { …, cwd: treeOf(run, unitMilestone(a.unit)) })`. `fastCheck`: `runCheck(treeOf(run, lane's milestone), …)`. `commit`: every git call in the tree; `commit.made.commit` is the tree's HEAD. `integrate`: in the tree, the branch `M.branch`.
  - `checkMerged`: git-merged or counted merged in `s` → `removeTree(run, M)`; a hint → `log("warn", "trees", hint)`; then `milestone.merged{ M }`.
  - `land` in a base run: the `push` question is D11's text, verbatim.
  - `planOf`: `after: milestoneAfter(lanes, m)`.
  - `briefFor`: in a base run, every dispatch whose unit has a milestone with a tree gets D8's line before its notes; the reviewer's range is `git diff origin/<base>...HEAD`. The architect's brief in a base run gains: "In this run each milestone is its own branch and merge request from origin/<base>, and milestones run side by side: a milestone that builds on another's code names it on its first lane's After: line (After: M1), and only those wait. When a fresh checkout needs a command before anything runs (installing dependencies, generating code), put Setup: <command> on the line under plan.md's # title." The integrate worker's notes (30b Ruling 14) gain "edit the conflicted files only; do not git add or commit: catherd does".

- [ ] **Step 1: Write the failing tests** (local bare origin through `branchRun`; `memoryReader.read` and `deps.now` injected and restored):

```ts
it("claims a tree when memory allows, and defers with the numbers when it does not", async () => {
  memoryReader.read = () => 5000;                      // M1 working since 10 min: 5000 − 2048 < 3072
  await fx.run({ type: "claimTree", milestone: "M2" }, withWorking("M1"));
  expect(lastEvent(run)).toMatchObject({ type: "tree.deferred", milestone: "M2", availableMb: 5000, needMb: 5120 });
  memoryReader.read = () => 9000;
  await fx.run({ type: "claimTree", milestone: "M2" }, withWorking("M1"));
  expect(lastEvent(run)).toMatchObject({ type: "tree.ready", milestone: "M2", branch: "t-m2" });
});
it("always claims the first milestone, whatever the memory reads", …);   // read = () => 0, nothing working → tree.ready
it("turns a refused claim into effect.failed with its message", …);       // foreign branch t-m1 → effect.failed /not this run's/
it("dispatches, fast-checks and commits a base-run milestone in its tree", …);
it("integrates in the milestone's tree, on its branch", …);
it("removes a merged milestone's clean tree, keeps a dirty one, and appends milestone.merged either way", …);
it("parks a landed milestone for its push, naming its branch, the push command, the digest and the precheck", …);
it("a run without base dispatches, checks and commits in the repo", …);
// test/services/run-briefs.test.ts
it("gives every role of a base-run milestone its tree, branch and three-dot diff, and no role without base", …);
it("tells a base run's architect that milestones run side by side unless After: names one, and where Setup: goes", …);
```

- [ ] **Step 2: Run** `bun test test/services/run-effects.test.ts test/services/run-briefs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the Step 2 command and `bun test test/services/run-daemon.test.ts test/domain/run-machine.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): each milestone's roles, checks and commits run in its worktree"`

### Task 8: skill, README, MIGRATION, ideas

**Files:** `plugin/skills/catherd/SKILL.md`, `README.md`, `MIGRATION.md`, `docs/dev/ideas.md`; Test `test/skills.test.ts`

- [ ] **Step 1: Update the test:** `expect(skill("catherd")).toContain("run_start(repo, title, a_lines, base)")` and `toContain("catherd never pushes")`.
- [ ] **Step 2: Run** `bun test test/skills.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the text.**
  - SKILL.md (stays under plan 30's 120 lines), three bullets: pass `base` (a branch on origin) when each milestone should be its own branch and MR; independent milestones then run side by side while the machine has memory for them, and a milestone that builds on another names it on an `After:` line; each landed milestone asks the owner to push it and merge its MR with a merge commit (the question carries the commands), catherd never pushes, and in a squash-merging repo the owner's answer is what unblocks the milestones after it.
  - README, a `### A milestone per branch` subsection under `## Use`: what `base` does; trees under the run folder and removed once merged and clean; `Setup:` on plan.md's header; the memory rule and its numbers (D6), and that macOS is read through `kern.memorystatus_level`; pushes, MRs and merges stay the owner's.
  - MIGRATION "From 1.5 to 2.0", `### A milestone per branch`: `run_start` takes `base`; `After: M1` is now valid in a lane header; a run without `base` works in the repo as before.
  - `docs/dev/ideas.md` (Ruling 15): remove "Milestone per branch" and "One run per worktree: `dispatch` takes no cwd"; narrow "Carried gate passes are not shared between worktrees of one repo" to worktrees the user made; keep "Stacked milestones"; add "**The milestone memory estimate is a constant.** 3 GB per working milestone and a 2 GB floor were set from the shop run's 9 GB swap, not measured per milestone. Fix: record the peak RSS of each milestone's process tree on the scorecard runs, then make it a profile setting if repos differ." and "**A kept worktree is only logged.** A merged milestone's tree with untracked files stays under `<run>/trees/` and only the daemon log says so. Fix: list kept trees in the run's report."
- [ ] **Step 4: Run** `bun test test/skills.test.ts test/entry/plugin-packaging.test.ts`, then `bun run format:check`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "docs(skill): a milestone per branch: base, side by side by memory, pushes on the owner's word"`

### Task 9: changeset

- [ ] **Step 1:** Create `.changeset/milestone-branches.md`: `"catherd-cli": major`; "2.0.0 (part of): run_start takes base: each milestone gets its own branch and worktree from origin/<base>, set up once with the plan's Setup: line, and its roles, checks and commits work there; milestones whose After: milestones are merged run side by side while the machine has the memory for them (3 GB each above a 2 GB floor); merged, clean worktrees are removed. catherd still never pushes or merges. A run without base works in the repo as before."
- [ ] **Step 2: Run** `bunx changeset status`. Expected: `catherd-cli` major.
- [ ] **Step 3: Commit** — `git commit -m "chore(release): changeset for milestone branches"`
