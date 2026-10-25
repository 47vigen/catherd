# Plan 43 — release hardening

Setup: bun install --frozen-lockfile

Source: the audits of runs `20261024-133108-plan-40-run-efficiency` (plan 40's run, before plan 40's code) and `20261024-225710-plans-41-42-cheap-tier-and-panel-models` (plan 40's code live), the 2.0 release-readiness read of 2026-10-25, the coordinator findings of the two overnight runs of 2026-10-23/24 on another repo (credit and platform, both before plan 40), and docs/dev/ideas.md "From plan 40". Every item makes an unattended run need no human, or stops a wrong result. Priority: findings that reach their lane without an LLM, stops that park or resume instead of looping, cost that counts once, parks that need no owner (format hook, rung, pause, disk), then catherd merging its own landed milestones.

Evidence by item (seq = the run's events.jsonl):

- Passing tests read as failures: `checkFailLines` keeps `(pass) parseFailLines > lists the FAIL and BUG lines …` (checks.jsonl of the plans 41–42 run: 9–11 such lines on every green run, C3); plan 40's run parked M2 on an all-PASS verifier reply caused by them (seq 93–98); the platform run's `✓ TestNoRefundSectionOnAnUncapturedLeg: FAILED` at exit 0.
- A red Check pays a judge and an architect: M20's `milestone.checked` (plans 41–42 run, seq 100) has three BLOCKERs with `file: null`; judge-100 and architect-M20-2 ran (seq 101–118, $3.07, about 9 min).
- ui-reviewer findings are unowned: seq 68 (`graph/RunGraph.tsx` relative, in parentheses) and seq 254 (`file: "/models"`, the real path written `CostChart.tsx:~58`); each cost a judge and a queued second worker dispatch.
- Claude cost counts a resumed thread again: worker-M4.L3 of plan 40's run, one session, `result.total_cost_usd` 2.5055 → 3.0729 → 3.4351 while its `usage` and `num_turns` (136, 18, 18) are each dispatch's own; recorded $60.54, real $34.65.
- A replan re-runs nothing: after architect-M20-2 (seq 117–118) the same HEAD 848b345 was committed again (seq 119), re-reviewed, re-checked from cache (seq 122) and the same red re-triaged by judge-122, before worker-M20.L2 ran (seq 126).
- `check_broken` retried blind: plan 40's run M1.L3 attempt 3 (seq 56 → 57, 272 s, $0.5) with the same blocker, then a park; the credit run's M21.L1 the same (seq 1235, 1267, 1269).
- A reply with no `STATUS:` recorded ok: plan 40's run seq 31, 44, 171; the credit run's claude-code workers that ended on "the monitor will notify me" (M25.L1, M34.L1) were committed half-done; `STATUS: done` (ui-reviewer-M0) read as clean.
- A profile edit strands a lane: plan 40's run seq 185–189, `E_ADMIT_RUNG` for `claude-code:claude-haiku-5-5#max`, parked `effect` 14 min until the coordinator appended `lane.climbed` by hand (seq 188).
- The format hook parks: plan 40's run M5 `commit.failed` (seq 292–295, lefthook `oxfmt --check` on four files); the plan 39 run seq 260.
- Push questions sat 3–29 min per milestone: 54.9 of the plans 41–42 run's 116 minutes were idle behind a landed milestone waiting for a human merge.
- `run_start` failed after the run existed (`E_IO_UNEXPECTED`, posix_spawn of a removed Bun path); the retry made run `20261024-133032` (cancelled).
- A paused machine: 37 `dispatch.refused E_ADMIT_PAUSED` for reviewer-M4 (plan 40's run seq 194–266); the platform run's judge refused while paused was never dispatched after resume.
- A verifier's scratch `TMPDIR` fails 48 CLI tests (plan 40's run seq 68, verifier-M3 NIT).
- The credit run: a resumed claude-code thread with orphaned background tasks emitted a `result` with `num_turns: 0`; the supervisor took it as final and killed the live worker (`after-final`, exit 143); a submodule left stale after `integrate` parked verifier-M5; milestone trees shared one compose project name ("platform"); the daemon died on ENOSPC and stayed dead until a `status()` call; a verifier FAILed a red-before-code A-line from git history; known issues accepted at a park came back in the re-verify after an integrate; an answer to a verifier park could only re-run the verifier.
- The platform run: an owner edit of `plan-input/` was undone by the copy from the source plan on the next answer.

Already fixed on main (086ee80), so not in this plan: dotted task ids (plan 40 D10, fbf1bfb); a `check_broken` lane held by a transitive dependent (D23: `waitsForSibling` excludes every lane that `dependsOn` it, src/domain/run-machine.ts); a nested `catherd lock` under a held slot (D8, `CATHERD_LOCK_HELD` in every check catherd runs); unfair slots, silent lock waits and role-lock starvation across runs (D7); `cd dir && cmd` split into two items (D9); a passing verifier refused for gate items recorded on an earlier HEAD, or with another path set (D1 the daemon's own Check record, D3c content-hash carry, D6); `accept, …` with text after it at a blocker or land park (D5, `isAccept` at src/domain/run-state.ts:1193 and 1199); re-verifying after a base merge that misses the milestone, and integrating only after the verifier (D3b, D4); preflight's 120 s timeout (D14, 600 s); a known red baseline and a land gate comparing exit codes (D13 `Baseline:`, `freshFailures` counts only new lines); the 600 s gate item limit (D12, 30 min); two gate runs on one head killing each other (the role's `gate_run` joins `runMilestoneCheck`'s flight); a Check frozen at dispatch (`machineCheck` reads plan.md each time, src/services/run-effects.ts:747); an owned gitignored path failing `git add` (D11, src/services/run-effects.ts:844); `E_ADMIT_OVERLAP` across separate worktrees (D22, src/services/admission.ts:300); a sibling's half-written file (D23); a commit-history A-line from the planner (D11 lint, and D19 below for the verifier); dependants cut from a stale base after a squash merge (every tree cut fetches `origin/<base>`, src/services/milestone-tree.ts:110, plan 35 aa94754 — not reproduced on main; with D20 catherd merges before it marks a milestone merged).

Changed from the brief: item 10's premise does not hold in this repo — `bunx commitlint` passes `Merge branch 'plan-40-run-efficiency-m3' into plans-40-42`, since config-conventional ignores merge subjects by default (checked 2026-10-25). The ready subject stays (D12): repos with `defaultIgnores: false` or a server-side subject rule refuse it, and D20's own merge commits need one. Item 13 keeps the scratch-path signal for the MCP server only (D15): Codex starts MCP servers without `CATHERD_ROLE` (test/services/role-env.test.ts:43), so dropping it there would let a role's Codex call coordinator tools.

## What already exists

- src/domain/fail-lines.ts — `normalizeFailLine` (8–22, absolute paths become `<path>`), `checkFailLines(out)` (28–38: the regex at 34 matches `FAIL`/`FAILED`/`✗` anywhere after a space, so a `(pass) … FAIL …` line counts), `newFails` (41), `checkItems`, `coveredDir`.
- src/domain/findings.ts — `PATH` (6: `:L?\d+(?:[-,:]L?\d+)*`, so `:~58` drops the token), `filesOf` (14–22, a token with `/` or an extension: `/models` is a path), `fileOf` (25–27, first 4 tokens only), `parseFindings` (30–40), `parseFailLines` (43–53).
- src/domain/record.ts — `STATUS_LINE` (104, `STATUS: <word> — <why>` with the dash required), `parseReplyStatus` (119–123, the last line only).
- src/domain/plan-doc.ts — `isAccept` (163), `milestoneSection` (211), `baselineItems` (229: a milestone section's lines, then the preamble's).
- src/domain/branch.ts — `mrCommand` (43). src/services/tree-path.ts — `treeDir`, `treeOf(run, m)`.
- src/domain/role-scope.ts — `roleScopeOfScratch(tmpdir)` (36–46), `roleScopeFromEnv(env)` (49–51: `CATHERD_ROLE`, else a scratch `TMPDIR`). Callers: src/entry/cli-kit.ts `refuseInRole` (33), src/entry/role-cli-command.ts (18), src/entry/deps.ts `defaultDeps` (19, `role`), which src/entry/mcp/server.ts `startMcpServer` (165) uses. test/preload.ts strips catherd's data and config dirs and `CATHERD_LOCK_HELD`, not the role.
- src/domain/run-state.ts — `mergePlan` (412–519: an existing lane keeps its status; `MilestonePlan` lanes carry no digest), `settle` (528–546), `ownerOfFile` (361–371, exact path or under a directory entry), `completeRound` (≈ 596–634: the dispute test at 616 reads only `ownerOfFile(f.file)`), `ownersOf` (638–648, `filesOf(f.text)` then `f.file`), `fixRound` (651–700), `unexplained` (727–732: ok with `replyStatus` null goes to Jev's classify), `laneStopped` (738–781: `check_broken` back to pending once, parks on the second, 767–775), `holdsFor`/`waitForSiblings` (791–812), `laneEnded` (815–866: ok with a null `replyStatus` goes on to "checking"), `afterVerdict` (877), `waiveCheck` (882), `mergedIn` (887–895), `onAnswered` (1146–1209: a land or `check_broken` answer that is not an accept falls to `m.status = from`, 1208), `plan.ready` (1224–1232), `lanes.routed` (1239–1247), `dispatch.refused` (1300–1338: `E_ADMIT_PAUSED` waits `REFUSAL_WAIT_MS`, 1309; any other code parks `effect`, 1336), `commit.failed` (1442–1449, always parks), `run.paused`/`run.resumed` (1612–1616), the plan-check park (≈ 1642–1650).
- src/domain/run-machine.ts — `waitsForSibling` (≈ 299–311), `precheck`/`pushQuestion` (562–578, "merge it with a merge commit"), `advance` (595–618: a landed base-run milestone parks `push`), `PAUSED_STEPS` (698–707), `next` (711–724, holds `PAUSED_STEPS` only while `state.paused`).
- src/domain/run-events.ts — `MilestonePlanSchema` (79–93), `run.started` (110), `plan.ready` (121), `commit.failed` (192), `milestone.merged` (215), `run.paused`/`run.resumed` (251–252), `describeEvent`.
- src/services/run-effects.ts — `planOf(run)` (204–≈260, lane headers from lanes/*.md), `rungFor` (365–405), `start` (459–555: an admission error is `dispatch.refused`, 516–522), `readPlan` (561–600), `route` (604–640, `routeLanes` then `lanes.routed`), `fastCheck` (≈ 655–700, `checkEnvFor(run.meta.repo)` at 665), `machineCheck` (≈ 738–795: findings `file: fileOf(line)` at 768), `commit` (822–892: the hook's refusal of `git commit` at 881 is `commit.failed`), `landIt` (894–940), `integrate` (945–970, no submodule update), `checkMerged` (977–994, `removeTree` then `milestone.merged`), `claim` (1000–1033), `pushBranch` (1035–1053).
- src/services/milestone-check.ts — `CheckRecordSchema` (36–57), `CheckJob` (110–119: `cwd`, `baseline`), `runLogged` (130–150, env from `checkEnvFor(job.repo)`), the record (≈ 215–240, `fails: checkFailLines(out)`), `freshFailures` (443–456), `missingBaselines`.
- src/services/preflight.ts — `checkEnvFor(repo)` (256–264). src/services/gate-env.ts — `RESERVED` (68). src/services/admission.ts — the off-ladder refusal (201–208), the overlap loop (300–312), the dispatch env (388–397).
- src/adapters/claude-code/index.ts — `finalize` (302–333, `costUsd: res?.costUsd`), `parse` (354–374: every `result` is `final`, `costUsd = total_cost_usd` at 370); no `settle`. src/adapters/claude-code/events.ts — `foldClaudeEvents` (70–88, the last `result` wins). src/adapters/codex/index.ts `settle` (161–171) and src/adapters/opencode/index.ts `settle` (278–293) — the plan 40 D19 pattern; src/services/finalize.ts `priorOn` (111–122, sums earlier records' tokens and `costUsd` on the thread), `settled` (125–143). src/infra/supervisor.ts — `finalAt` (229, 278), `after-final` (320–321).
- src/infra/launch.ts — `launchDetached` (22–37, `Bun.spawn([process.execPath, …])`). src/services/daemon.ts — `daemonLauncher`, `ensureDaemon` (73–87), `runDaemon` (≈ 133–205: an effect's error is logged and its key stays issued, 160–171; a loop error rethrows, 197). src/entry/daemon-bin.ts (15). src/services/run-client.ts — `runStart` (54–104: `ensureDaemon` at 89 after `run.started`), `answerUnit` (copies the plan inputs again at 119). src/services/pause.ts — `pausesFor(run)` (115), `assertNotPaused` (173).
- src/domain/role-prompts.ts — `WORKER_REPLY` (28), the verifier body (≈ 73–97). src/services/run-briefs.ts — `verifyBrief` (387–≈430, no known issues).
- src/domain/profile.ts — `ProfileDocSchema` (55–77), `Profile` (182–200), `resolveProfile` (≈ 350–380), `ProfilePatchSchema` (≈ 405–440, `preflight: { confirm }` the pattern). src/services/profile-service.ts `viewOf` (330–350). src/entry/profile-command.ts (115–117, the `preflight` line). src/services/panel-setup.ts (69 `preflightConfirm`, 213). web/src/routes/_app/setup/-components/SettingsSections.tsx (`PreflightSection`, 56, 557–570), web/src/routes/_app/setup/-lib/patch.ts (25, 98–100), `bun run panel:openapi` writes web/openapi.json, `(cd web && bun run gen)` writes web/src/client/types.gen.ts.
- Full root suite: about 180 s (`catherd lock -- bun test`).

## Contracts

```ts
// src/domain/fail-lines.ts
export const PASS_LINE: RegExp; // a pass marker first, after an optional `<pkg> <script>:` prefix: (pass) ✓ ✔ √ ok --- PASS PASS
export function failFiles(out: string, root: string): Record<string, string[]>; // normalized fail line → repo-relative files

// src/domain/findings.ts — PATH also takes `:~58`; filesOf skips a route (leading `/`, no extension)
export function fileOf(text: string): string | null; // the first of filesOf(text), whole text

// src/domain/record.ts — the last STATUS line outside fences; list marker, bold, trailing `.` and a missing `— why` allowed
export function parseReplyStatus(reply: string): { status: ReplyStatus | null; why: string | null };

// src/domain/plan-doc.ts
export function formatCommand(planText: string, id: string): string | null; // `Format: <cmd>`, section first, then preamble

// src/domain/branch.ts
export function mergeSubject(runId: string, milestone: string, title: string): string; // `chore: merge <slug> <m> <title>`, lower-case, ≤ 100

// src/domain/role-scope.ts
export function roleScopeFromEnv(env: Record<string, string | undefined>, o?: { scratch?: boolean }): RoleScope | null;

// src/services/tree-path.ts
export function composeProjectOf(run: Run, m: string | null, baseline?: boolean): string | null;

// src/adapters/claude-code/index.ts
async function settle(o: Outcome, run: FinishedRun, prior: Spent): Promise<Outcome>; // registered as claude-code's `settle`

// src/infra/launch.ts
export function bunBinary(execPath?: string, which?: (cmd: string) => string | null): string;

// src/services/run-client.ts — runStart(...): { …; daemon: "revived" | "alive" | "failed"; warning?: string }

// src/services/milestone-check.ts
// CheckRecordSchema += { failFiles?: Record<string, string[]> }
export async function freshFailures(run: Run, m: string, head: string): Promise<{ item: string; lines: string[]; files: Record<string, string[]> }[]>;

// src/domain/run-events.ts
// MilestonePlanSchema lanes[] += { digest?: string }  (M4)
// commit.failed += { hook?: boolean }                 (M4)
type PauseLifted = { type: "pause.lifted" };         // (M4)
// run.started += { autoMerge?: boolean }; milestone.merged += { by?: "catherd"; commit?: string } (M5)
type MergeFailed = { type: "merge.failed"; milestone: string; error: string }; // (M5)

// src/domain/run-state.ts
// LaneState += { digest: string | null; statusAsked: boolean }  (M3: statusAsked, M4: digest)
// MilestoneState += { hookFixes: number } (M4); { mergeError: string | null } (M5)
// RunState += { held: string | null } (M4); { autoMerge: boolean } (M5)
export const STATUS_ASK: string; // M3
export function siblingMayChange(s: RunState, l: LaneState): boolean; // M3, run-machine's waitsForSibling reads it

// src/domain/run-machine.ts
type MergeLandedAction = { type: "mergeLanded"; milestone: string }; // key mergeLanded:<m>, in PAUSED_STEPS (M5)

// src/domain/profile.ts
// ProfileDoc += { land?: { autoMerge?: boolean } }; Profile += { land: { autoMerge: boolean } } (default false)
// ProfilePatch += { land?: { autoMerge: boolean } }; ProfileView += { land }
```

## Decisions

- D1 — A line is never a failure when it starts, after an optional `<package> <script>:` prefix, with a pass marker: `(pass)`, `✓`, `✔`, `√`, `ok`, `--- PASS`, `PASS` — rejected: matching a test name list — the output has no list, and the marker is what every runner prints.
- D2 — A machine Check finding names the files of its failing output: the output is cut into blocks that end at each `(pass)`/`(fail)` line; a fail line gets the block's bun file header (`test/x.test.ts:`) and every repo path the block names (`path:line`, and an absolute path under the tree made relative; `node_modules` left out). `machineCheck` writes them into the finding's text (`— in a, b`) and `file`, so `ownersOf` sends the finding to every owning lane with no judge — rejected: running the judge on every red Check (today) — $3.07 and 9 min for M20 where the owner was obvious.
- D3 — `PATH` takes `:~58`; a token that starts with `/` and has no extension is a route, not a file; `fileOf` reads the whole text. `ownerOfFile` also matches a relative file to the one lane whose file entry ends with `/<file>`; two such lanes is no owner. The dispute test reads `ownersOf`, not `f.file` — rejected: a ui-reviewer format rule — the reviewer's prose is free, and both misses were catherd's parsing.
- D4 — A resumed claude-code dispatch records `total_cost_usd` minus what earlier records on its thread counted, never below 0; tokens stay as reported, since claude's `usage` is per invocation — rejected: summing per dispatch (today) — +75 % in plan 40's run. Verified on that run's worker-M4.L3 results (cost rises, usage and turns are each dispatch's own).
- D5 — A claude `result` with `num_turns: 0` is not the final reply (the supervisor's `after-final` grace never starts on it); the fold keeps the last result as today — rejected: killing orphaned background tasks on resume — catherd cannot see them, and D8's ask makes the earlier dispatch end clean.
- D6 — `planOf` gives each lane a `digest`: sha-256 (first 16 hex) of its lane file without the `Owns:` line. On `plan.ready`, a done lane of an unfinished milestone whose digest changed goes back to pending with the note "The architect changed lanes/<id>.md: re-read it and make the change it asks for.", its thread kept. A lane with no stored digest takes the new one with no change — rejected: re-pending every lane of the milestone — the M20 replan changed one lane. The `Owns:` line is left out because `owns_add` rewrites it while a lane runs.
- D7 — A `check_broken` stop parks at once with the worker's reason, unless a sibling of its milestone may still change the tree (`siblingMayChange`: running, or pending and untried since its last climb — the rule `waitsForSibling` uses today, moved to run-state and shared) — rejected: one blind retry (today) — the retry has no new input.
- D8 — `parseReplyStatus` reads the last `STATUS:` line outside code fences, allowing a list marker, bold, a trailing period and no `— why`. A lane's ok reply that still has none is not sent to Jev: the lane goes back to pending on the same thread with `STATUS_ASK` as its note, once (`statusAsked`); a second one is a failed attempt (`attempts += 1`, thread dropped). An unknown word (`STATUS: done`) is no status — rejected: classifying it with Jev (today) — the classifier read "the monitor will notify me" as no reason, and the half-done round was committed.
- D9 — A milestone park whose reason is `land` or `check_broken`, answered with neither an accept nor a first word `retry`, starts a fix round: the answer is one BLOCKER finding, routed by the files it names, else to the triage judge. `accept…` on a verifier `check_broken` park lands when `checkedOn === commit` (the verifier's PASS waived, as D5 of plan 40 does after a FAIL); `retry` keeps today's re-run. The two park questions say so — rejected: a new answer verb — the owner's words already carry the fix.
- D10 — An `E_ADMIT_RUNG` refusal of a lane dispatch with no failover routes the lane again (`routeLanes` on its lane file, the run's profile as it is now, so the lane's own bar), appends `lanes.routed` for it, and admits once more with the new rung. The same rung again, or no rung, is the refusal it was — rejected: refusing the route — the ladder is the owner's, and a hand-appended `lane.climbed` was the only way out.
- D11 — A plan line `Format: <command>` (milestone section first, then the preamble, like `Baseline:`) makes `commit` run `<command> <staged owned files>` in the tree before the commit, then stage those files again; a formatter that fails is logged and the hook decides. A refusal from `git commit` itself is `commit.failed` with `hook: true`; the reducer turns the first one of a round into a fix round (one BLOCKER, `The pre-commit hook refused the commit:` and the tail, routed by the files it names), and a second in the same round parks as today. `hookFixes` resets on `commit.made` — rejected: running the `format` script of package.json — its arguments are unknown, and a whole-tree run reflowed about 100 unrelated lines in plan 40's run; rejected: the knowledge digest — prose, not a command.
- D12 — `mergeSubject` is `chore: merge <slug> <milestone> <title>`, lower-cased, cut to 100 characters; the slug is the run id without its `YYYYMMDD-HHMMSS-` prefix. Both push questions say "merge it with a merge commit whose subject is `<subject>`" — rejected: dropping the item — this repo's commitlint passes git's own subject, but repos with `defaultIgnores: false` or a server rule do not, and D20 needs a subject.
- D13 — `launchDetached` spawns `bunBinary()`: `process.execPath` when it exists, else `bun` on `PATH`. `runStart` wraps `ensureDaemon` once `run.started` is written: an error gives `daemon: "failed"` and `warning: "the run started, its daemon did not: <message>; status(run) starts it again"` with the run id — rejected: rolling the run back — the run folder and events are valid, and a retry is what made the duplicate.
- D14 — `E_ADMIT_PAUSED` sets `held` (once) instead of a timed wait; while `held` is set `next` holds every `PAUSED_STEPS` action, as for `run.paused`. The daemon reads `pausesFor(run)` on its beat (5 s) while `held` is set, and appends one `pause.lifted` when none covers the run; that clears `held`, and the owed actions are issued again — rejected: a tick every 30 s — 540 events in a 4.5 h pause, worse than the 37 refusals.
- D15 — `roleScopeFromEnv` reads only `CATHERD_ROLE` unless `{ scratch: true }`; only `startMcpServer` passes it, since Codex starts a role's MCP servers without `CATHERD_ROLE` but with its `TMPDIR`. The shared test helper is test/preload.ts: it deletes `CATHERD_ROLE` and `CATHERD_DISPATCH_ID`, so every test file and every child it spawns runs as no role — rejected: a per-spawn helper with a guard test — 23 files with 40 spreads for what one preload line does; rejected: no path signal anywhere — a role's Codex could call `run_start` through the owner's catherd MCP server. Cost: a role harness that drops `CATHERD_ROLE` from its shell (a custom Codex `shell_environment_policy`) runs the orchestrator's CLI commands unguarded.
- D16 — Roles and checks of a base-run milestone get `COMPOSE_PROJECT_NAME=catherd-<run date-time, no dash>-<m lower-case>` (`-base` for a baseline tree) unless the gate env sets one; a run without base sets none. catherd does not tear stacks down — rejected: `compose down` on land — catherd cannot know which stacks a gate started (stays in ideas.md).
- D17 — `integrate` runs `git submodule update --init --recursive` after a clean merge, before `integrate.done`; its failure is the effect's error — rejected: leaving it to `Setup:` — setup runs once per tree.
- D18 — An effect that fails with `ENOSPC` stops the daemon loop with that error, and daemon-bin, on an `ENOSPC` error, waits (30 s polls) until `heavyLimits.freeMb() >= heavyLimits.diskReserveMb`, then runs the daemon again, which replays and issues what was lost — rejected: an alert (ideas.md) — surviving is what the run needs unattended.
- D19 — The worker reply contract says never to end the turn waiting on a background command or a Monitor ("nothing resumes you: run long commands in the foreground"). The verifier body says an A-line about commit history (red before code, alone in a commit) is judged from the tree: the test exists and fails without the code, since catherd commits each round's tests and code together. `verifyBrief` lists the milestone's known issues under "The owner accepted these; do not FAIL on them:" — rejected: dropping known-issue findings in the reducer — their text differs between verifiers.
- D20 — `land.autoMerge` (profile, default false) is pinned at run start in `run.started.autoMerge`. In a base run with it set, a landed milestone owes `mergeLanded` instead of the push question. The effect fetches `origin/<base>`, adds a detached worktree of it under the run's scratch, runs `git merge --no-ff -m <mergeSubject> <commit>` there, pushes `HEAD:refs/heads/<base>` to origin (never `--force`), removes the worktree and the milestone's tree, and appends `milestone.merged` with `by: "catherd"`. Any git failure (conflict, hook, rejected push) removes the worktree and appends `merge.failed`; the milestone then parks the push question with "catherd could not merge it: <error>" — rejected: merging in the owner's checkout — it may be dirty or on another branch; rejected: reading the profile at each land — a mid-run edit would change who merges half a run.
- D21 — `answerUnit` keeps copying the plan inputs from their source (it is how an owner's fix reaches the run). The approval question and the plan-check park end with "Edit the source plan files, not the run's plan-input copies: catherd copies them again when you answer." — rejected: an owner-side plan-input write — a second copy to keep in step.
- D22 — run-state.ts, run-machine.ts and run-events.ts change in M3, M4 and M5 only, one lane each, in that order; run-effects.ts likewise — rejected: side-by-side milestones — they would conflict in the reducer.

## M1 — Parsers: fail lines, finding paths, STATUS, plan lines, role scope

A1 — passing lines are never failures and fail lines know their files; finding paths read `:~N`, skip routes and use the whole text; a STATUS line with a marker, bold or a period parses; `Format:` lines and `mergeSubject` read as in Contracts; the CLI reads a role only from `CATHERD_ROLE`, the MCP server also from its scratch, and the suite runs as no role (Check).
A2 — the root gate is green (Check).
A3 — web/ is untouched.
A4 — each fix has a test that fails without the fix.
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 1: Pass lines and the files of fail lines

Files: src/domain/fail-lines.ts, test/domain/fail-lines.test.ts

`checkFailLines` skips a normalized line that `PASS_LINE` matches, before the fail regex. `failFiles(out, root)` works on the raw lines (ANSI stripped): blocks end at each line that starts `(pass)` or `(fail)`; a block's files are the last bun file header seen (a whole line `<path>.test.<ext>:` or `.spec.`), then each path `filesOf` finds in the block, an absolute one under `root` made relative and any under `node_modules/` dropped, in order, unique. Each line of the block that `checkFailLines` keeps maps to them. `// shortcut: blocks follow bun's layout; another runner gets the paths its lines name, upgrade when a second runner needs headers`.

Test: test/domain/fail-lines.test.ts — "a passing line that names FAIL is no failure" — `(pass) parseFailLines > lists the FAIL and BUG lines [0.12ms]`, `payment-panel test:    ✓ TestNoRefundSectionOnAnUncapturedLeg: FAILED`, `ok 3 - FAIL marker`, `--- PASS: TestFAIL (0.00s)` → `[]`; `(fail) a > b` and `--- FAIL: TestX` still kept.
Test: test/domain/fail-lines.test.ts — "a fail line carries its block's files" — `test/services/capture.test.ts:`, `error: expect(received).toMatchObject(expected)`, `      at <anonymous> (<root>/test/services/capture.test.ts:127:5)`, `      at settle (<root>/src/adapters/opencode/index.ts:290:9)`, `      at x (<root>/node_modules/a/b.js:1:1)`, `(fail) capture-fixtures > records the totals [12.00ms]`, `(pass) capture-fixtures > other` → both fail lines map to `["test/services/capture.test.ts", "src/adapters/opencode/index.ts"]`.

### Task 2: Finding paths

Files: src/domain/findings.ts, test/domain/findings.test.ts

`PATH`'s line part becomes `(?::[L~]?\d+(?:[-,:][L~]?\d+)*)?`. `filesOf` drops a path that starts with `/` and has no `.<ext>` in its last segment. `fileOf(text)` is `filesOf(text)[0] ?? null`.

Test: test/domain/findings.test.ts — "a ~ line mark keeps its path and a route is no file" — `BUG /models tooltip — raw float — at web/src/routes/_app/models/-components/CostChart.tsx:~58 — /tmp/shots/m33.png` → `fileOf` is `web/src/routes/_app/models/-components/CostChart.tsx`; `filesOf` has no `/models`.
Test: test/domain/findings.test.ts — "fileOf reads past the fourth word" — `BUG run graph, Fit to view — hides nodes (\`graph/RunGraph.tsx\`)` → `graph/RunGraph.tsx`.

### Task 3: A lenient STATUS line

Files: src/domain/record.ts, test/domain/record.test.ts, test/domain/reply.test.ts

`STATUS_LINE` becomes `^(?:[-*]\s+)?\**STATUS\**:\**\s*(complete|partial|blocked|refused|flaky)\b\.?\**\s*(?:(?:—|–|-)\s*(.*))?$`; `parseReplyStatus` takes the last line outside code fences (the `unfencedLines` helper) that matches; `why` is `""` when the dash part is absent.

Test: test/domain/record.test.ts — "a STATUS line with a marker, bold or a period parses" — `- STATUS: complete` → complete, why ""; `**STATUS:** partial — two left.` → partial; `STATUS: complete.` followed by two lines of text → complete.
Test: test/domain/record.test.ts — "an unknown status word is no status" — `STATUS: done` → `{ status: null, why: null }`; a `STATUS: complete — x` inside a ``` fence only → null.

### Task 4: Format lines

Files: src/domain/plan-doc.ts, test/domain/plan-doc.test.ts

`formatCommand(planText, id)`: the last `Format: <command>` line of `milestoneSection(planText, id)`, else of the preamble, trimmed; null when none.

Test: test/domain/plan-doc.test.ts — "formatCommand reads the section, then the preamble" — preamble `Format: bunx oxfmt`, M2 section `Format: npx prettier --write` → M2 `npx prettier --write`, M1 `bunx oxfmt`; a plan with neither → null.

### Task 5: The merge subject

Files: src/domain/branch.ts, test/domain/branch.test.ts

Test: test/domain/branch.test.ts — "mergeSubject is a conventional subject of at most 100 characters" — `("20261024-225710-plans-41-42-cheap-tier", "M33", "Panel Models Page")` → `chore: merge plans-41-42-cheap-tier m33 panel models page`; a 200-character title → length 100, starts `chore: merge `.

### Task 6: Role scope reads env, the server also its scratch

Files: src/domain/role-scope.ts, src/entry/mcp/server.ts, test/preload.ts, test/fixtures/role-probe.test.ts, test/domain/role-scope.test.ts, test/entry/pause-command.test.ts, test/services/role-env.test.ts, test/entry/role-scope-mcp.test.ts, test/helpers.test.ts

`roleScopeFromEnv(env, o)` is `parseRoleScope(env[ROLE_ENV]) ?? (o?.scratch ? roleScopeOfScratch(env.TMPDIR) : null)`. `startMcpServer`'s default deps are `{ ...defaultDeps(), role: roleScopeFromEnv(process.env, { scratch: true }) }`. test/preload.ts deletes `CATHERD_ROLE` and `CATHERD_DISPATCH_ID`. test/fixtures/role-probe.test.ts expects both unset. The existing TMPDIR tests (role-scope.test.ts:21, role-env.test.ts:44) pass `{ scratch: true }`; pause-command.test.ts's `byTmp` case now pauses (exit 0, the pause written).

Test: test/domain/role-scope.test.ts — "a CLI shell with only a scratch TMPDIR is no role" — `roleScopeFromEnv({ TMPDIR: scratch })` → null; with `{ scratch: true }` → the scope.
Test: test/entry/role-scope-mcp.test.ts — "the MCP server knows a role by its scratch TMPDIR" — env `TMPDIR` a role's scratch, no `CATHERD_ROLE` → `run_start` gets E_ROLE_SCOPE.
Test: test/helpers.test.ts — "a suite started in a role's shell runs as no role" — spawn `bun test test/fixtures/role-probe.test.ts` with `CATHERD_ROLE: "r/worker-M1.L1"`, `CATHERD_DISPATCH_ID: "d1"`, `ANTHROPIC_API_KEY: ""` → exit 0.

### M1 lanes

- M1.L1 — Task 1 — owns src/domain/fail-lines.ts, test/domain/fail-lines.test.ts — fast check: `bun test test/domain/fail-lines.test.ts && bun run typecheck && bun run lint`
- M1.L2 — Task 2 — owns src/domain/findings.ts, test/domain/findings.test.ts — fast check: `bun test test/domain/findings.test.ts && bun run typecheck && bun run lint`
- M1.L3 — Task 3 — owns src/domain/record.ts, test/domain/record.test.ts, test/domain/reply.test.ts — fast check: `bun test test/domain/record.test.ts test/domain/reply.test.ts && bun run typecheck && bun run lint`
- M1.L4 — Task 4 — owns src/domain/plan-doc.ts, test/domain/plan-doc.test.ts — fast check: `bun test test/domain/plan-doc.test.ts && bun run typecheck && bun run lint`
- M1.L5 — Task 5 — owns src/domain/branch.ts, test/domain/branch.test.ts — fast check: `bun test test/domain/branch.test.ts && bun run typecheck && bun run lint`
- M1.L6 — Task 6 — owns src/domain/role-scope.ts, src/entry/mcp/server.ts, test/preload.ts, test/fixtures/role-probe.test.ts, test/domain/role-scope.test.ts, test/entry/pause-command.test.ts, test/services/role-env.test.ts, test/entry/role-scope-mcp.test.ts, test/helpers.test.ts — fast check: `bun test test/domain/role-scope.test.ts test/entry/pause-command.test.ts test/services/role-env.test.ts test/entry/role-scope-mcp.test.ts test/helpers.test.ts && bun run typecheck && bun run lint`

## M2 — Claude cost and final reply, run_start, role briefs

A1 — a resumed claude-code dispatch records only its own cost and a no-turn `result` is not final; `run_start` spawns a Bun that exists and returns the run id even when the daemon launch fails; workers are told never to end on a background wait, verifiers judge commit-history A-lines from the tree and see the owner's known issues (Check).
A2 — the root gate is green (Check).
A3 — web/ is untouched.
A4 — each fix has a test that fails without the fix.
A5 — no panel API change (web/openapi.json unchanged).
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 7: Claude cost deltas and the no-turn result

Files: src/adapters/claude-code/index.ts, src/adapters/claude-code/events.ts, test/adapters/claude-code.test.ts, test/fixtures/adapters/claude-code/resume-cost.jsonl, test/fixtures/adapters/claude-code/orphan-result.jsonl

`settle` returns `o` when `run.request.thread === null` or `o.costUsd === null`; else `costUsd: Math.max(0, o.costUsd - prior.costUsd)`, tokens unchanged. It is registered on the adapter. `parse` sets `final` only when `num_turns` is not 0. resume-cost.jsonl is a `system` init, one assistant message and a `result` with `total_cost_usd: 3.07293573`, `num_turns: 18`, `usage` input 32 / cache read 7 844 170 / cache creation 65 994 / output 43 683 (a placeholder session id). orphan-result.jsonl is a `system` `task_notification`, a `result` with `num_turns: 0` and empty `result`, then assistant lines and a `result` with `num_turns: 4`.

Test: test/adapters/claude-code.test.ts — "a resumed dispatch records only its own cost" — resume-cost.jsonl, thread set, prior `costUsd: 2.50550973` → `costUsd` 0.567426 (to 6 places), tokens as the fixture's usage.
Test: test/adapters/claude-code.test.ts — "a fresh thread keeps its total cost" — thread null → 3.07293573.
Test: test/adapters/claude-code.test.ts — "a result with no turns is not the final reply" — each line of orphan-result.jsonl through `parse` → `final` only on the last; `finalize` takes the last result's text.

### Task 8: A Bun that exists, a run that is returned

Files: src/infra/launch.ts, src/services/run-client.ts, test/infra/launch.test.ts, test/services/run-client.test.ts

`bunBinary(execPath = process.execPath, which = Bun.which)` is `existsSync(execPath) ? execPath : (which("bun") ?? execPath)`; `launchDetached` spawns it. `runStart` as D13.

Test: test/infra/launch.test.ts — "a removed Bun path falls back to the bun on PATH" — `bunBinary("/nonexistent/bun", () => "/opt/bun/bin/bun")` → `/opt/bun/bin/bun`; an existing path → itself.
Test: test/services/run-client.test.ts — "run_start returns the run when the daemon launch fails" — `daemonLauncher.launch` throws `posix_spawn failed` → resolves with the run id, `daemon: "failed"`, `warning` naming the error, and `listRuns()` holds one run.

### Task 9: Role briefs: background waits, history A-lines, known issues

Files: src/domain/role-prompts.ts, src/services/run-briefs.ts, test/domain/agents.test.ts, test/domain/verifier-prompt.test.ts, test/services/run-briefs.test.ts

`WORKER_REPLY` gains, after its first sentence: "Never end your turn to wait for a background command or a Monitor: nothing resumes you. Run long commands in the foreground and wait for them." The verifier body gains: "An acceptance line about commit history (red before the code, alone in its own commit) is judged from the tree: the test exists and fails without the code. catherd commits a round's tests and code together, so history cannot show it." `verifyBrief`, when `m.knownIssues` is not empty, adds `The owner accepted these; do not FAIL on them:` and one line per issue.

Test: test/domain/agents.test.ts — "a worker is told never to end its turn on a background wait" — the worker prompt contains `Never end your turn to wait`.
Test: test/domain/verifier-prompt.test.ts — "the verifier judges a commit-history line from the tree" — the verifier prompt contains `judged from the tree`.
Test: test/services/run-briefs.test.ts — "a verifier brief lists the owner's known issues" — `knownIssues: ["A8 red-first: accepted by the owner"]` → the brief holds that line after `do not FAIL on them`.

### M2 lanes

- M2.L1 — Task 7 — owns src/adapters/claude-code/index.ts, src/adapters/claude-code/events.ts, test/adapters/claude-code.test.ts, test/fixtures/adapters/claude-code/resume-cost.jsonl, test/fixtures/adapters/claude-code/orphan-result.jsonl — fast check: `bun test test/adapters/claude-code.test.ts && bun run typecheck && bun run lint`
- M2.L2 — Task 8 — owns src/infra/launch.ts, src/services/run-client.ts, test/infra/launch.test.ts, test/services/run-client.test.ts — fast check: `bun test test/infra/launch.test.ts test/services/run-client.test.ts && bun run typecheck && bun run lint`
- M2.L3 — Task 9 — owns src/domain/role-prompts.ts, src/services/run-briefs.ts, test/domain/agents.test.ts, test/domain/verifier-prompt.test.ts, test/services/run-briefs.test.ts — fast check: `bun test test/domain/agents.test.ts test/domain/verifier-prompt.test.ts test/services/run-briefs.test.ts && bun run typecheck && bun run lint`

## M3 — Findings to their lanes, stops that park or ask

After: M1

A1 — a red Check's findings, and relative or `:~N` ui-reviewer paths, reach the owning lane with no judge; `check_broken` with no sibling at work parks at once with the worker's reason; a reply with no STATUS line is asked once on the same thread; a named fix on a land or verifier park starts a fix round; an off-ladder rung is routed again; trees get their own compose project; submodules follow `integrate` (Check).
A2 — the root gate is green (Check).
A3 — web/ is untouched.
A4 — each fix has a test that fails without the fix.
A5 — no panel API change (web/openapi.json unchanged).
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 10: Routing, stops and answers in the reducer

Files: src/domain/run-state.ts, src/domain/run-machine.ts, test/domain/run-state.test.ts, test/domain/run-machine.test.ts

D3's `ownerOfFile` suffix rule and the dispute test through `ownersOf`. D7: `siblingMayChange(s, l)` holds the body of today's `waitsForSibling` loop; `waitsForSibling` calls it; `laneStopped` `check_broken` parks at once unless it is true (the second stop parks as today). D8: `unexplained` returns false for an ok end with a null `replyStatus`; in `laneEnded`, before the cheap-try branch, an ok end with a null `replyStatus` and no reason: `statusAsked` false → `statusAsked = true`, thread kept, `notes = [STATUS_ASK]`, pending; true → `statusAsked = false`, `attempts += 1`, thread null, pending. Any end with a status sets `statusAsked = false`. `STATUS_ASK` = "Your last reply had no STATUS: line. If the work is not finished, finish it; then end your reply with STATUS: complete|partial|blocked|refused — <why>." D9 in `onAnswered`, and the verifier `check_broken` question becomes `… could not run the check: <why>. Answer accept to land on catherd's green Check, retry to run the verifier again, or name the fix.`; the land question's "or name the fix" stays. Existing tests that pin the blind `check_broken` retry or the classify of a STATUS-less reply change with them.

Test: test/domain/run-state.test.ts — "a check_broken stop with no sibling at work parks at once" — one lane, worker ends ok, reason check_broken, why `test/x.test.ts:12 asserts the old head` → lane parked, `stuck["M1.L1"].question` contains the why, no dispatch owed; with a sibling running → pending, no park.
Test: test/domain/run-state.test.ts — "a reply with no STATUS line is asked once on the same thread" — ended ok, `replyStatus: null`, thread `t1` → pending, thread t1, notes `[STATUS_ASK]`, no classify owed; the second such end → attempts 1, thread null.
Test: test/domain/run-state.test.ts — "a relative path finds the lane owning its suffix" — BUG text `(\`graph/RunGraph.tsx\`)`, L2 owns `web/src/components/graph/RunGraph.tsx` → L2 pending with the note; L1 and L2 both owning a `…/graph/RunGraph.tsx` → unowned.
Test: test/domain/run-state.test.ts — "a capped BLOCKER that names a lane's file is no dispute" — the round stops at the cap on a BLOCKER with `file: null` whose text names src/a.ts, owned by L1 → a blocker park, no triage judge owed.
Test: test/domain/run-state.test.ts — "a named fix on a land park starts a fix round" — land park, answer `src/a.ts: drop the stale assertion`, L1 owns src/a.ts → L1 pending with the answer; answer `retry` → verifying, machineCheck owed.
Test: test/domain/run-state.test.ts — "accept on a verifier check_broken park lands on a green check" — `checkedOn === commit`, verifier ends ok reason check_broken, answer `accept, the env is flaky` → landing.
Test: test/domain/run-machine.test.ts — "waitsForSibling and the reducer agree" — a pending untried sibling → `waitsForSibling` true and `siblingMayChange` true; the sibling done → both false.

### Task 11: A compose project per tree, in the role's env

Files: src/services/tree-path.ts, src/services/admission.ts, test/services/tree-path.test.ts, test/services/admission.test.ts

`composeProjectOf(run, m, baseline = false)`: null when `run.meta.base` is null or `m` is null; else `catherd-${run.id.slice(0, 15).replace("-", "")}-${m.toLowerCase()}${baseline ? "-base" : ""}`. The dispatch env adds `COMPOSE_PROJECT_NAME` from `composeProjectOf(run, milestone of the dispatch)` when it is set and `gate.values` has none.

Test: test/services/tree-path.test.ts — "a base run's milestone has its own compose project" — run `20261024-225710-x` with base, `M20` → `catherd-20261024225710-m20`; baseline → `…-m20-base`; no base → null.
Test: test/services/admission.test.ts — "a role's env names its tree's compose project" — base run, lane M1.L1 → spec env `COMPOSE_PROJECT_NAME` `catherd-<…>-m1`; a gate env value wins.

### Task 12: Check files in findings, re-routing, compose and submodules in the effects

Files: src/services/milestone-check.ts, src/services/run-effects.ts, test/services/milestone-check-run.test.ts, test/services/milestone-check.test.ts, test/services/run-effects.test.ts

The record gains `failFiles: failFiles(out, job.cwd)` when it has fails; `freshFailures` returns `files` (the record's `failFiles`, `{}` for older records). `machineCheck` builds each finding as `` `<item>` fails: <line> `` plus ` — in <files joined ", ">` when it has files, `file: files[0] ?? fileOf(line)`. `runLogged` and `fastCheck` set `COMPOSE_PROJECT_NAME ??= composeProjectOf(run, milestone, job.baseline)` in the child env. `start` handles `E_ADMIT_RUNG` as D10. `integrate` runs the submodule update of D17.

Test: test/services/milestone-check-run.test.ts — "a failing record keeps its lines' files" — item `printf 'test/a.test.ts:\nerror: x\n(fail) a > b\n'; exit 1` → `failFiles` maps both lines to `["test/a.test.ts"]`.
Test: test/services/run-effects.test.ts — "a red check's finding names the failing files" — stub records a failing item with one fresh line and `failFiles` `["test/a.test.ts"]` → the BLOCKER's text ends `— in test/a.test.ts`, `file` `test/a.test.ts`.
Test: test/services/run-effects.test.ts — "an off-ladder rung is routed again" — the profile's worker ladder is `[claude-code:claude-sonnet-5-5#medium]`, the lane routed to `claude-code:claude-haiku-5-5#max` → `lanes.routed` with the sonnet rung and `dispatch.started` on it; no `dispatch.refused`.
Test: test/services/run-effects.test.ts — "a role off the profile is still refused" — worker role disabled → `dispatch.refused` E_ADMIT_RUNG, no `lanes.routed`.
Test: test/services/run-effects.test.ts — "integrate updates submodules" — origin's base moves a submodule pointer → after `integrate.done` the tree's submodule is at the new commit.
Test: test/services/milestone-check-run.test.ts — "a milestone check runs in its tree's compose project" — item `printenv COMPOSE_PROJECT_NAME` logs `catherd-<…>-m1`.

### M3 lanes

- M3.L1 — Task 10 — owns src/domain/run-state.ts, src/domain/run-machine.ts, test/domain/run-state.test.ts, test/domain/run-machine.test.ts — fast check: `bun test test/domain/run-state.test.ts test/domain/run-machine.test.ts && bun run typecheck && bun run lint`
- M3.L2 — Task 11 — owns src/services/tree-path.ts, src/services/admission.ts, test/services/tree-path.test.ts, test/services/admission.test.ts — fast check: `bun test test/services/tree-path.test.ts test/services/admission.test.ts && bun run typecheck && bun run lint`
- M3.L3 — Task 12 — after M3.L2 — owns src/services/milestone-check.ts, src/services/run-effects.ts, test/services/milestone-check-run.test.ts, test/services/milestone-check.test.ts, test/services/run-effects.test.ts — fast check: `bun test test/services/milestone-check-run.test.ts test/services/milestone-check.test.ts test/services/run-effects.test.ts && bun run typecheck && bun run lint`

## M4 — Replans, the format hook, pauses and a full disk

After: M3

A1 — a replan that edits a done lane's file re-runs that lane; a plan `Format:` line formats before the commit and a hook refusal is a fix round; a paused machine is one refusal and one `pause.lifted`; the daemon outlives ENOSPC; the push questions name a conventional merge subject; plan parks say to edit the source plan files (Check).
A2 — the root gate is green (Check).
A3 — web/ is untouched.
A4 — each fix has a test that fails without the fix.
A5 — no panel API change (web/openapi.json unchanged).
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 13: Digests, hook refusals, the pause hold and the questions in the reducer

Files: src/domain/run-events.ts, src/domain/run-state.ts, src/domain/run-machine.ts, test/domain/run-events.test.ts, test/domain/run-state.test.ts, test/domain/run-machine.test.ts

The Contracts' M4 fields and event (`mergePlan` defaults: `digest: null`, `hookFixes: 0`, `held: null`). D6 in `mergePlan`. D11: `commit.failed` with `hook` and `m.hookFixes === 0` → `hookFixes = 1`, `fixRound(s, m, [{ label: "BLOCKER", text: \`The pre-commit hook refused the commit:\n${tail}\`, file: filesOf(tail)[0] ?? null }], new Set())`; else the park of today. `commit.made` sets `hookFixes = 0`. D14: `E_ADMIT_PAUSED` → `s.held ??= e.at`, no `waiting` entry; `pause.lifted` → `held = null`, `recomputeWake`; `next` holds `PAUSED_STEPS` while `paused` or `held`. D12 in both push questions. D21 in the approval question and the plan-check park. `describeEvent`: `pause.lifted` reads "the machine pause was lifted".

Test: test/domain/run-state.test.ts — "a replan that edits a done lane's file re-runs it" — L1 and L2 done with digests `a`/`b`, milestone fixing with a delta, `plan.ready` with L1 `c`, L2 `b` → L1 pending with the note and its thread, L2 done; then the milestone owes L1's dispatch, not a commit.
Test: test/domain/run-state.test.ts — "a hook refusal goes to the owning lane once" — `commit.failed { hook: true, tail: "src/a.ts: not formatted" }`, L1 owns src/a.ts → L1 pending with the note, no park; a second hook refusal before `commit.made` → `stuck.M1.reason` commit.
Test: test/domain/run-state.test.ts — "a paused machine holds the run with one refusal" — `dispatch.refused E_ADMIT_PAUSED` → `held` set, `next` after a `tick` owes no dispatch and no judge; `pause.lifted` → the dispatch is owed again.
Test: test/domain/run-machine.test.ts — "the push question names the merge subject" — base run, M2 landed, title `Lanes` → the question contains `chore: merge`, `m2 lanes`.
Test: test/domain/run-events.test.ts — "pause.lifted and the new fields parse and describe" — `pause.lifted`, `commit.failed` with `hook`, a `plan.ready` lane with `digest` validate; `pause.lifted` has a describeEvent line.

### Task 14: Lane digests, the Format line and the hook flag in the effects

Files: src/services/run-effects.ts, test/services/run-effects.test.ts

`planOf` adds `digest` per D6. `commit`, outside a merge and when `formatCommand(plan.md, milestone)` is set and files are staged: `sh -c '<cmd> "$@"' sh <files>` in the tree with `checkEnvFor(run.meta.repo)`, `effectLimits.commitMs`; a non-zero exit is logged; then `git add -- <files>` again. A failure of the `git commit` call itself (the round's commit, or the open merge's) appends `commit.failed` with `hook: true`.

Test: test/services/run-effects.test.ts — "a plan Format line formats the staged files before the commit" — plan.md preamble `Format: sh fmt.sh` where fmt.sh appends `formatted` to each argument; a lane changed src/a.ts → `commit.made`, and the committed src/a.ts ends with `formatted`.
Test: test/services/run-effects.test.ts — "a hook refusal is a commit.failed with hook" — `.git/hooks/pre-commit` prints `src/a.ts is not formatted` and exits 1 → `commit.failed` with `hook: true`, tail naming src/a.ts.
Test: test/services/run-effects.test.ts — "a lane's digest ignores its Owns line" — two lane files differing only in `Owns:` → equal digests; one more line of text → different.

### Task 15: The pause lift and ENOSPC in the daemon

Files: src/services/daemon.ts, src/entry/daemon-bin.ts, test/services/daemon.test.ts, test/entry/daemon-bin.test.ts

`runDaemon`'s loop, on its beat while `state.held !== null`, appends `pause.lifted` once when `pausesFor(run)` is empty. An effect whose error has `code === "ENOSPC"` (or a message starting `ENOSPC`) sets a stop error the loop throws after its in-flight effects settle, releasing the lock. `superviseDaemon(once, o = { freeMb: heavyLimits.freeMb, reserveMb: () => heavyLimits.diskReserveMb, sleep: Bun.sleep, pollMs: 30_000 })` in daemon.ts calls `once()`; on an ENOSPC error it sleeps until `freeMb() >= reserveMb()` and calls it again; any other error rethrows. daemon-bin.ts runs `superviseDaemon(() => runDaemon(…))`.

Test: test/services/daemon.test.ts — "a lifted machine pause appends one pause.lifted" — `held` set by a refusal, the machine paused (`pauseMachine` in a temp catherd home), two beats → none; `resumeMachine`, one beat → exactly one `pause.lifted`.
Test: test/services/daemon.test.ts — "an effect that hits ENOSPC stops the loop" — an effect throwing `ENOSPC: no space left on device, write` → `runDaemon` rejects with it and the daemon lock is free.
Test: test/entry/daemon-bin.test.ts — "a daemon stopped by ENOSPC runs again once there is disk" — `once` throws ENOSPC, then returns "ended"; `freeMb` 10, then 5000; `reserveMb` 4096 → `once` called twice, `sleep` once; an `E_IO_UNEXPECTED` error rethrows at once.

### M4 lanes

- M4.L1 — Task 13 — owns src/domain/run-events.ts, src/domain/run-state.ts, src/domain/run-machine.ts, test/domain/run-events.test.ts, test/domain/run-state.test.ts, test/domain/run-machine.test.ts — fast check: `bun test test/domain/run-events.test.ts test/domain/run-state.test.ts test/domain/run-machine.test.ts && bun run typecheck && bun run lint`
- M4.L2 — Task 14 — after M4.L1 — owns src/services/run-effects.ts, test/services/run-effects.test.ts — fast check: `bun test test/services/run-effects.test.ts && bun run typecheck && bun run lint`
- M4.L3 — Task 15 — after M4.L1 — owns src/services/daemon.ts, src/entry/daemon-bin.ts, test/services/daemon.test.ts, test/entry/daemon-bin.test.ts — fast check: `bun test test/services/daemon.test.ts test/entry/daemon-bin.test.ts && bun run typecheck && bun run lint`

## M5 — catherd merges its landed milestones (opt-in)

After: M2, M4

A1 — `land.autoMerge` is a profile field (default false) that profile show, validate and the panel's settings show; a base run started with it merges each landed milestone into the base with a `--no-ff` merge commit carrying the conventional subject, pushes it without force and marks it merged with no push question; any git failure falls back to the push question with the error (Check).
A2 — the root gate is green (Check).
A3 — the panel gate is green (Check).
A4 — each fix has a test that fails without the fix.
A6 — web/openapi.json and web/src/client/types.gen.ts are regenerated, not hand-edited.
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test && (cd web && bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun run test)

### Task 16: The profile field

Files: src/domain/profile.ts, src/services/profile-service.ts, src/entry/profile-command.ts, src/services/panel-setup.ts, web/openapi.json, test/domain/profile.test.ts, test/services/profile-service.test.ts, test/entry/profile-command.test.ts, test/services/panel-setup.test.ts

As Contracts, the `preflight.confirm` pattern at each layer. profile show prints `land ${autoMerge ? "merges each landed milestone into the base itself" : "asks you to merge each landed milestone"}` after the preflight line. The panel's section values gain `landAutoMerge`. Then `bun run panel:openapi`.

Test: test/domain/profile.test.ts — "land.autoMerge defaults to false" — a doc without `land` → false; `{ land: { autoMerge: true } }` → true; the patch `{ land: { autoMerge: "yes" } }` is refused.
Test: test/entry/profile-command.test.ts — "profile show prints who merges" — `profile set land.autoMerge true`, then show → the `land merges each landed milestone` line.
Test: test/services/panel-setup.test.ts — "the settings carry landAutoMerge" — the view of a profile with it set → `landAutoMerge: true`.

### Task 17: The merge in the reducer and machine

Files: src/domain/run-events.ts, src/domain/run-state.ts, src/domain/run-machine.ts, test/domain/run-events.test.ts, test/domain/run-state.test.ts, test/domain/run-machine.test.ts

`run.started` sets `s.autoMerge = e.autoMerge ?? false`. `advance`: a landed milestone of a base run with no question and no stuck entry owes `mergeLanded` when `s.autoMerge && m.mergeError === null`, else today's push or `pushBranch`. `merge.failed` sets `mergeError`; it and `milestone.merged` confirm `mergeLanded:<m>`; `pushQuestion` then starts `catherd could not merge it: <error>.`. `milestone.merged` with `by` is today's case. `mergeLanded` is in `PAUSED_STEPS`; `describeEvent` covers `merge.failed` and `milestone.merged` by catherd.

Test: test/domain/run-state.test.ts — "an autoMerge run's landed milestone is merged by catherd" — `run.started` base main, autoMerge true; M1 landed → `mergeLanded` owed, no push park; `milestone.merged { by: "catherd" }` → M1 merged, M2 (after M1) claims its tree.
Test: test/domain/run-state.test.ts — "a failed merge falls back to the push question" — `merge.failed { error: "CONFLICT (content): src/a.ts" }` → a push park whose question contains the error and `chore: merge`.
Test: test/domain/run-machine.test.ts — "a run without autoMerge still asks to push" — landed, autoMerge false → the push park, no `mergeLanded`.

### Task 18: The merge effect and the pinned flag

Files: src/services/run-effects.ts, src/services/run-client.ts, test/services/run-effects.test.ts, test/services/run-client.test.ts

`runStart`'s `run.started` carries `autoMerge: runProfile(deps, run).land.autoMerge`. `mergeLanded(a, s)` as D20, with `gitRun` and `effectLimits.commitMs` per call, the worktree at `<run>/scratch/merge-<m>` (`git worktree remove --force` in a `finally`), and `removeTree(run, m)` after a push that worked, as `checkMerged` does. `merge.failed.error` is the failing call's tail (`tailOf`, 5 lines).

Test: test/services/run-effects.test.ts — "a landed milestone is merged with a merge commit and pushed" — a bare origin with `main`, the milestone's branch one commit ahead → origin's `main` is a commit with two parents whose subject is `mergeSubject(run.id, "M1", title)`; `milestone.merged` by catherd; no `scratch/merge-M1`.
Test: test/services/run-effects.test.ts — "a conflicting merge falls back and leaves origin alone" — origin's `main` changed the same line → `merge.failed` naming the conflict, origin's `main` unchanged, no `scratch/merge-M1`.
Test: test/services/run-client.test.ts — "run.started pins the profile's autoMerge" — profile with `land.autoMerge: true` → the `run.started` event has `autoMerge: true`.

### Task 19: The panel setting

Files: web/src/routes/_app/setup/-components/SettingsSections.tsx, web/src/routes/_app/setup/-lib/patch.ts, web/src/routes/_app/setup/-lib/patch.test.ts, web/src/client/types.gen.ts

`(cd web && bun run gen)`, then a `LandSection` beside `PreflightSection`, the same component, `meaning` "Merge each landed milestone into the run's base branch with a merge commit, instead of asking you to.", label "Let catherd merge landed milestones"; patch.ts gains the `land` case.

Test: web/src/routes/_app/setup/-lib/patch.test.ts — "the land section patches land.autoMerge" — `patchFor("land", { autoMerge: true })` → `{ land: { autoMerge: true } }`.

### M5 lanes

- M5.L1 — Task 16 — owns src/domain/profile.ts, src/services/profile-service.ts, src/entry/profile-command.ts, src/services/panel-setup.ts, web/openapi.json, test/domain/profile.test.ts, test/services/profile-service.test.ts, test/entry/profile-command.test.ts, test/services/panel-setup.test.ts — fast check: `bun test test/domain/profile.test.ts test/services/profile-service.test.ts test/entry/profile-command.test.ts test/services/panel-setup.test.ts test/entry/panel-openapi.test.ts && bun run typecheck && bun run lint`
- M5.L2 — Task 17 — owns src/domain/run-events.ts, src/domain/run-state.ts, src/domain/run-machine.ts, test/domain/run-events.test.ts, test/domain/run-state.test.ts, test/domain/run-machine.test.ts — fast check: `bun test test/domain/run-events.test.ts test/domain/run-state.test.ts test/domain/run-machine.test.ts && bun run typecheck && bun run lint`
- M5.L3 — Task 18 — after M5.L1, M5.L2 — owns src/services/run-effects.ts, src/services/run-client.ts, test/services/run-effects.test.ts, test/services/run-client.test.ts — fast check: `bun test test/services/run-effects.test.ts test/services/run-client.test.ts && bun run typecheck && bun run lint`
- M5.L4 — Task 19 — after M5.L1 — owns web/src/routes/_app/setup/-components/SettingsSections.tsx, web/src/routes/_app/setup/-lib/patch.ts, web/src/routes/_app/setup/-lib/patch.test.ts, web/src/client/types.gen.ts — fast check: `(cd web && bun run typecheck && bun run lint && bun run test -- src/routes/_app/setup)`

## M6 — Docs, ideas.md and the changeset

After: M1, M2, M3, M4, M5

A1 — README documents `land.autoMerge`, the `Format:` plan line and what a park answer that names a fix does; docs/dev/ideas.md drops what plan 43 fixed and lists what it left, each with its evidence.
A2 — the root gate is green (Check).
A7 — the diff adds no home-directory path and no private host name.
A8 — a catherd-cli patch changeset names the user-visible changes: `land.autoMerge`, the `Format:` plan line, park answers that start a fix round, the conventional merge subject, and claude-code costs per dispatch.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 20: README, ideas.md and the changeset

Files: README.md, docs/dev/ideas.md, .changeset/plan-43-release-hardening.md

README, "A milestone per branch": after "catherd never opens an MR and never merges", say that with `catherd profile set land.autoMerge true` a base run started afterwards merges each landed milestone into the base itself (a `--no-ff` merge commit `chore: merge <run> <milestone> <title>`, pushed without force), and that any git failure falls back to the question. In the plan-lines text (where `Baseline:` and `(Check)` are described, else the same section): `Format: <command>` formats the staged owned files before each milestone commit, and a pre-commit hook refusal becomes a fix round. One sentence: a land or verifier park answered with a fix starts a fix round; `retry` re-runs; `accept` waives.

ideas.md drops, from "From plan 40": the TMPDIR item, the off-ladder rung item, `run_start` reports a failure, the profile-edit rung item, the format hook item, the merge-commit item, the missing `STATUS:` item, the `E_ADMIT_PAUSED` item; from "From plan 38": "A push takes two parked round trips per milestone" (keep one line: with `land.autoMerge` off it still does) and "One push and merge answer per milestone"; from the plan 39 findings: "Spawned-CLI tests inherit the worker's role", "A pre-commit hook failure parks the milestone", "Passing tests can be reported as failures when their names contain `FAIL`"; and the `git submodule update` item. It amends "Tearing down compose stacks a gate started" with D16 (each tree has its own project now; teardown still open). It adds, each with its evidence and no run path: the memory deferral that does not say how its need is computed (platform run, `6266 MB available, 8192 MB needed`); a land refusal's fix text that names `gate_pass` but not `gate_check`; a dispatch shown as "ended failed … fast check green" whose cause is only in runs.jsonl (credit run, `Step interrupted`); a second landed sibling whose base moved before the owner's merge answer is not re-integrated (credit run M31/M33); the plans 41–42 audit's C5 (a 177 s stall inside M20's Check with no wait recorded), C6 (`execMilestoneCheck run by a verifier role` flaky under load), C7 (report minutes are time since the previous landing), C8 (round counters skip), C9 (a worker's screenshots keep a tree), C10 (a fix round waits for every reviewer of its round), C11 (the no-verifier path is unreachable when A1 is "as written") and C13 (memory `tree.deferred` carries no `resource`); and every new catherd defect the M1–M5 lanes and reviews reported (the orchestrator lists them in this lane's brief).

The changeset: `"catherd-cli": patch`, one paragraph naming the A8 changes.

Test: none (prose) — the fast check asserts the changeset names catherd-cli.

### M6 lanes

- M6.L1 — Task 20 — chore — after M1, M2, M3, M4, M5 — owns README.md, docs/dev/ideas.md, .changeset/plan-43-release-hardening.md — fast check: `grep -q catherd-cli .changeset/plan-43-release-hardening.md && bun run format:check`

## Edge cases

- A passing line that names a failing test elsewhere (`(pass) … see (fail) …`) stays a pass: the marker leads.
- A red Check whose failing files no lane owns (a stale test of an earlier milestone) still goes to the triage judge, as today.
- Two lanes whose files end in the same relative path: no owner, the judge decides.
- A Claude record written before D4 on a resumed thread counted the session total: `prior` over-counts and the delta clamps at 0.
- A synthetic `result` that is the only one: the stream ends, the fold reads it, its empty reply has no STATUS line, and D8 asks on the same thread.
- A replan that only widens a lane's `Owns:` re-pends nothing (D6); a new lane in a replan is pending already.
- A `check_broken` stop while a sibling is still writing: the wait of today; the second stop parks.
- A STATUS ask whose resumed thread the adapter refuses (`E_ADMIT_THREAD`): the stand-in brief path of plan 40 applies; the ask is still the note.
- A land park answered `retry` after a load flake: the machine Check reruns on the same head (its per-item cache answers the green items).
- A reroute that lands on a rung whose quota is held: `rungFor`'s failover applies as for any rung.
- A `Format:` command that is not installed: it fails, is logged, and the hook decides as today.
- A machine pause lifted while the daemon is down: the next daemon replays `held` and appends `pause.lifted` on its first beat.
- An ENOSPC inside `appendEvent` of the loop itself: the loop throws it, and daemon-bin waits as for an effect.
- `land.autoMerge` turned on mid-run: that run keeps asking (pinned at start); the next run merges.
- A base branch protected on origin: the push is rejected, and the run falls back to the question with git's message.
- Two milestones landing together with autoMerge: each merge starts from a fresh `origin/<base>`; a conflict falls back to its question.
- Old events without `digest`, `hook`, `autoMerge` or `by` replay as today.

## Out of scope

- Live verification and the scorecard (the release gate), the release PR, and npm.
- Tearing down compose stacks; alerting on ENOSPC; a per-run pause; retry-when-idle for load timeouts; a ui-reviewer login; owner rulings reaching later briefs; the base branch deleted by a merge (all stay in ideas.md).
- Changing the reviewer's contract, the round barrier, the per-milestone pipeline, or how a squash merge is detected.
