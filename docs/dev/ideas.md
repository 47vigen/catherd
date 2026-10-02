# Ideas for 1.x

Improvements collected from real catherd runs and from designing it, not yet planned. When one is picked up it moves
into a spec or plan under `docs/specs/` or `docs/plans/` (or a GitHub issue) and leaves this list. One entry per idea: what, why
(the evidence), and where it would live.

## From the reviews of #42 and #43 (2026-10-02)

Both PRs were merged as they stood (owner decision); the findings below are fixed in the next autopilot run, not by
the contributor.

#43 (workspace runs), review findings:

1. **One unrelated broken run blocks the whole workspace.** `workspaceChildren` (`workspace-store.ts`) reads every
   run in each member repo and throws `E_RUN_CORRUPT` on any folder without `meta.json`; `createRun` writes meta
   last, so a concurrent `run_start` or a crash bricks child start, admission, land, route and `workspace_status`,
   with no folder named. Reproduced with one empty run folder. Fix: only workspace-linked runs with a meta; skip or
   warn on the rest, and name the folder.
2. **Strict reads of every child for every operation.** One torn jsonl line in one child stops every sibling and
   makes `workspace_status` throw. Read only the evidence the operation needs; status reports a corrupt child as a
   warning. Reproduced.
3. **A child cannot land any milestone while any dispatch is pending** (`lane-service.ts`), not only its completion
   milestone: landing M1 while an M2 lane runs gives `E_LAND_GATE`. Apply the rule only when
   `milestone === step.milestone`.
4. **The default workspace budget is the profile's per-run budget over all children**, with minutes from the
   workspace's creation and no way to raise it: one night parked on a question refuses every later child. Default
   no cap, or start the clock at the first child, and allow raising it.
5. **The workspace lock is held across slow git work** (admission's status snapshot, land's diffs and state
   refresh; up to 15 s each) while waiters give up at 10 s, so dispatches in other repos fail `E_IO_LOCK`.
6. **MCP step objects use `z.object`**, which drops `dependsOn` silently; use `z.strictObject`.
7. **A landed step's child can never admit again** (a post-land fix needs a new workspace), and a `milestone` that
   never lands (`m1` vs `M1`) leaves dependents waiting with no warning.
8. **Admission and child start check dependencies differently** (lenient without the runs lock vs strict).
9. **Dependencies release on `land`, not on merge.** The payment run's need was "M1 of run B after M1 of run A is
   merged, then rebase"; worktrees of one repo count as distinct members, so it fits otherwise. Also still open
   from the same evidence: a group-level environment pause and verifier contention across runs.

Shipped in 1.0, so not re-proposed here: `catherd doctor`; the harness-cost line in `runs_summary` and the final
report; quota failover (the profile's `failover` map); the `preflight` tool; per-repo knowledge
(`<data>/repos/<slug>-<hash8>/knowledge.md`, read with `read_knowledge`, appended by `land`); the run budget (from 80 %
`route` starts at the cheapest rung that clears the bar; once spent, `E_RUN_BUDGET` pauses the run); the trimmed catalog (`catalog/models.json`, `scores.json`, `jev.json`); a plan in hand (a `plan:` A-line: no dossier, the architect translates); lint and type check in each lane's fast check; `status` showing the run's native and isolated dispatches, with the harness figure compared within one repo; and a sure Jev kind kept when its difficulty is unsure (`source: "jev-kind"`).

## 1.5 follow-ups (plan reviews, 2026-10-02)

Plan 21 (roles and ownership) review:

- **A role's own peek still claims.** A role may `peek` its own dispatch (ruling 4), but `peek` still calls
  `claim()`; on a 1.4-era run whose owner of record is that role's thread, adopt and recover then run inside the role
  process. Evidence: `src/services/peek.ts:126`, `src/services/dispatch-service.ts:216`. Fix: return from `claim`
  when `deps.role` is set, and skip `startNotifier` in a role process (`src/entry/mcp/server.ts`). (Minor 4.)
- **Refused notices pile up in delivery.jsonl.** Each deliver pass writes another `failed` attempt and another
  `error` log line for the same notice refused for a role's thread, so `delivery.jsonl` grows without bound while the
  owner of record stays a role. Evidence: `src/services/notifier.ts:248-252`. Fix: skip the notice when its latest
  attempt is already a role-thread refusal (`ROLE_THREAD_REFUSAL`) for the same target. (Minor 5.)
- **A role's shell still reaches the coordinator CLI forms.** Under `CATHERD_ROLE`, `catherd runs cancel` and
  `catherd profile set` (the CLI forms of the `cancel` and `profile_set` tools) still run. Evidence:
  `src/entry/runs-command.ts:279`, `src/entry/profile-command.ts`; only `src/entry/role-cli-command.ts:16` reads
  `roleScopeFromEnv`. Fix: refuse them with `E_ROLE_SCOPE` when `roleScopeFromEnv(process.env)` is set. (Minor 7.)

## 1.2 follow-ups (minors from the 1.2 reviews, 2026-09-28)

Owner rule: review Minors and non-correctness bot P2s land here, not in code. From the plan 13 final review
(`ee661e4..5209310`):

- **doctor's handshake starts a boot sync** (`src/entry/mcp/handshake.ts`): each `doctor` with a stale cache spends
  fetches (AA included) in a server it kills a moment later, and records nothing. Set `CATHERD_NO_SYNC=1` in
  `handshakeEnv`.
- **Piped `init` reads a new line order** (Jev, AA, profile, replace): an old script piping `KEY\nwork\ny` now sends
  `work` as the AA key. Say so in the 1.2 changeset and MIGRATION (plan 14).
- **Fetchers store an answer of the wrong shape as a success** (AA `pages: []`, an Arena answer without `rows`),
  replacing the last good one. Throw when a parser yields no rows or page 1 is empty.
- **`writeDerived` does not validate what it writes**, while `readDerived` does: one score with a bad date makes the
  whole file unreadable. `ScoreSchema.safeParse` each score in `derive` and drop the invalid ones.
- **`catalog_sync` right after boot** waits up to 120 s for the boot sync's lock and may throw `E_IO_LOCK` when
  sources hang. Return `busy` from the tool instead of waiting.
- **`testAaKey` retries 429 and 5xx** through `sourceGet` (up to 3 requests); the spec says one. Pass `retries: 0`.
- **doctor's "requests left today" can be stale:** a failed AA attempt with no header keeps the old
  `rateLimitRemaining` under a new `lastAttemptAt`. Keep the header's own timestamp.
- **`derive` keeps the highest value per key** whatever the field's direction; fine for today's dims, wrong for
  `cost_per_task` or time to first token once they are facts. Carry a direction per field.
- **`saveCredential` writes without a file lock**; two concurrent `init`s could lose a key (the Jev key's old
  pattern). Take the profiles lock or a credentials lock.

From the plan 14 final review (`cff7d19..04a48e2`) and its plan writer:

- **A threshold's `why` in `route` always shows the default's `barsWhy`**, even when the user's override replaced
  it (`provenance.ts`): `min: 70` beside "the median … 66.6". Say "your override" when `c.bars` differs.
- **A failover stand-in scored only by an inferred stand-in has no mark** in `profile show` and the tree
  (`note` is set only for a treat-like). Add "`<dims>` inferred from X".
- **`route` reads every run on the machine for evidence, unguarded** (`routing-service.ts`): an unreadable run file
  fails routing, though evidence is display-only. Wrap it; `evidence: null` on error.
- **The TUI save preview checks the repair rule against a profile with no stored file**, which the service refuses:
  the dialog offers Save and the save comes back invalid. Preview `repair: false` when the profile does not exist.
- **An unscored `defaultRung` falls back silently** to the cheapest candidate (`select.ts` `defaultLadder`); say so
  in the warning.
- **`speedLadder`'s main dimension for `ui` is `repo_code`**, while `ui` now gates on `frontend`.
- **Ruling 7 says `steer` is never inferred**, but a user's steer bar makes it inferred (`standins.ts` `barDimsIn`).
  Align the ruling or the code.
- **`catalog/ATTRIBUTION.md` says models.dev data is never shipped**, but `models.json` now ships its release dates.
  Move models.dev to the shipped section with its MIT line.
- **`catalog-refresh.yml` keeps the token in `.git/config` while `bun install` runs scripts** (as `release.yml`
  does). `persist-credentials: false`; push with the token only in the PR step.
- **`valueWords` in `provenance.ts` is exported and unused.**
- **`adjacent` values overstate lower efforts** (Luna none carries Luna max's DeepSWE). A per-effort discount, or
  spreading only upward, once sources score low efforts (plan 14 Ruling 3).
- **The logic and hard bars sit above every Sol rung** on the default ladder (Sol agentic 0.0818 vs 0.08606): the
  owner's call, percentiles as specced or a ladder with a stronger top rung.
- **Haiku 4.5's terminal value returns** when Epoch's Terminal-Bench covers five anchor rungs (plan 14 C-2).
- **The Artificial Analysis fixtures are synthetic** (plan 13 R-C); re-record them with a key.
- **`catalog list` says "inferred from X" for a user treat-like's values too**, the same as a stand-in's guess;
  tell a user's mapping apart ("like X").
- **`treat-like --clear` does not name a rung that keeps some values but loses a bar dimension** to no stand-in
  (neither unscored nor inferred). Spec §6.4 arguably covers the partial gap.
- **The text `catalog list` format changed in 1.2** (values line, then `runs:`); any script scraping it should use
  `--json`.

## 1.1 follow-ups (minors from the 1.1 reviews, 2026-09-28)

Owner rule for the end of 1.1: review Minors and non-correctness bot P2s land here, not in code. Each is small.

- **Runs page (TUI).** A ref is written during render in `runs.tsx`; the role screen keeps polling a finished role;
  a recent run opened from the Status tab lands on the session's first role, not that run; a session opens on its
  first milestone row and live roles can sit below the fold; `milestoneAt` rebuilds its list on every key; a
  milestone whose id is not `M<n>` gets a row only once it has landed. The `watchDirs` real-fs test can pass on a
  late probe event; doctor's `failed` push row is tested only with a hand-made outcome.
- **Protocol and gate (plan 11).** `laneDone` reads the records file once per lane; `peek.ts` shadows `r` and reads
  the notes twice. A verifier that writes `**VERDICT: PASS**` in markdown counts as no verdict (fails safe): say so in
  the `E_LAND_GATE` fix. The first milestone's commit range is its landed commit only (store the start HEAD in
  meta.json). `dispatch` routes (asks Jev, writes a route row) before admission can refuse, and two concurrent
  dispatches of one lane both route it. The ownership regex for climbs also catches environment errors that say
  "owned by". `gate_pass` names HEAD for a pass on an uncommitted tree; a staged rename out of a gate's paths is not
  seen; `./` is refused where `.` is meant.
- **Access and doctor.** Doctor's claude-code access row reads the sandbox setting of the directory doctor runs in,
  not each bound repo. `profile show` pads the "(no network)" row wrong; nothing warns about `network: false` on a
  read-only or full role. Live check: whether `bunx catherd-cli@latest init` sees bunx's own `.bin` on PATH and
  reports the global install as present.
- **Failover and validation (plan 12).** An unscored stand-in gets both its "unscored" error and a "downgrade"
  warning; `ladderDropDims` has no direct unit test; `rankStandIns` recomputes the bar check per pool member.
- **Docs.** live-verification §9.2 reads verifier minutes from `agents.jsonl`, so a headless (`claude-code:`)
  verifier prints nothing; the "back to published" block reuses `$version`, empty in a new shell.
- **Install (plan 12 final review).** `bun add -g` in `init` has no time limit; the spawned init test passes
  `BUN_INSTALL` through; `init` no longer warns "shadowed" when the global install is current but an older `catherd`
  comes first on PATH (the launcher then falls back to bunx); an open milestone row lost its description; §9 check 5
  should say "at least three" worker folders.
- **Tests.** Three doctor tests run close to the 5 s default under load (plan 11's probes make a doctor run ~2.3 s):
  give them 30 s like their neighbour. One full `bun test` run in five failed once on plan 12's head with no name recorded; heavy parallel
  load in a shared sandbox times out git- and notifier-based tests at 5 s.

## Picked up

- **Push results to the main thread, drop `wait`**, and **the runs page by main-thread session** (both designed
  2026-09-28): now spec 1.1 §3 and §4, built by `docs/plans/2026-09-28-10-push-sessions.md`. The facts they rest on
  are in `docs/research/2026-09-28-cross-session-messaging.md`, which corrects two of the first notes: the self-sent
  rule runs on Linux too (a `/proc` walk), and `CLAUDE_CODE_HOST_SESSION_ID` is set only by a host (Desktop).

## 1.1.0 scope, settled (grilled 2026-09-28)

Written up as `docs/specs/2026-09-28-catherd-1.1-design.md`, which governs where the two differ.

1.1.0 = push results to the main thread (section above), the runs page by session (above) and the whole fix bundle
(below). Model scores from public sources go to 1.2.0. Implemented by the maintainer's own subagents in reviewed
bundles, not by catherd on itself; the plan goes to `docs/plans/`. Decisions per item:

- **Worker access.** Roles that write (worker, artist, writer) get network access plus the lock dir and the temp dir
  as writable roots by default; the rest of the disk stays closed. Verified 2026-09-28 on Codex 0.157 with
  `-c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c
  sandbox_workspace_write.writable_roots=[<locks>,"/private/tmp"]`: lock-dir write, `docker ps` over the OrbStack
  socket, a loopback `bind()`, an HTTPS fetch and a `/tmp` write all pass. A profile field `network: false` tightens
  it. opencode and headless Claude Code get the same intent through their own mechanisms (a researcher pins them
  down first); where one cannot, `doctor` says which of the five probes fail. `doctor` runs the five probes with the
  exact flags workers get.
- **Protocol enforced by the tools.** `dispatch` routes an unrouted lane itself; `dispatch` appends the role's reply
  contract (last line `STATUS: …`) to every brief; `land` refuses a milestone without a reviewer record and a
  verifier verdict unless the reason is `docs-only` or `no-code`, and it checks the diff to hold the claim.
- **MCP server launch.** `.mcp.json` runs the global `catherd mcp` when installed (`init` installs it), else falls
  back to `bunx`; `doctor` starts the server once and says "reinstall" when a module is missing.
- **Verifier.** Its brief says to run independent gate items side by side within the lock's slots and to build each
  commit's image once. A small gate ledger records each passed item with the command and the hash of its paths; a
  later run in the same repo reports an item as carried over when both match, except items whose paths are in the
  milestone's diff. The verifier reports each step it starts, so `peek` and `status` show where it is.
- **Owner questions.** `park(run, milestone, question)` pushes the full question and parks only that milestone; the
  rest continues. The answer comes in the main session, which records it and unparks; with no session, the next
  `run_start` or `peek` shows unanswered questions first.
- **Climb.** `climb` asks Jev for the kind of the failure first; plan design or file ownership is refused with a fix
  line ("send it to the architect").
- **Routing.** Under objective `cost`, `route` starts at the cheapest rung whose score clears the lane's difficulty,
  using today's `scores.json`.
- **Failover.** An inferred stand-in must clear the rung's own bar; Claude-plan rungs rank last; with no fitting
  stand-in there is none, and `doctor` says so. Fix the "treated like" labels.
- **Small items.** The marketplace plugin source becomes a full HTTPS URL; `doctor`'s sandbox probe uses `codex
  sandbox [COMMAND]`; `validate` warns on a descending ladder; `doctor` shows the shipped defaults' access rows as
  info; `init` says "installing catherd…" before the first resolve; the TUI's first frame does not say "0 profiles".
  First-turn cost stays an idea.
- **Acceptance.** CI green; a `claude -p` test on a scratch repo proving messages arrive while the session is free,
  `peek` works, route/review/verify are enforced and a worker runs `bun install` and its tests itself; then the real
  run: merge MR !54 and run auth plan 5 MR B in a fresh Desktop session, compared with MR A's numbers.

## Fix bundle: everything open, by priority

One line per open problem found in real use; the entry with the evidence is in the section named after it.

1. **Workers cannot run their checks:** the sandbox denies Docker, loopback ports, the network and the lock dir (Top priority; 1.0.0 fresh install; headless test).
2. **The protocol is optional:** `route`, the reviewer and the verifier get skipped, before and after compaction; replies carry no STATUS because `dispatch` does not add the reply contract (Top priority; headless test).
3. **Plugin install fails without GitHub SSH:** `git-subdir` shorthand URL (1.0.0 fresh install).
4. **The plugin's MCP server dies on a half-cleaned bunx cache** (1.0.0 platform run).
5. **The verifier is the bottleneck:** serial gate items, reruns of unchanged checks, an image built twice, no progress in `status` (1.0.0 platform run).
6. **One owner question stops everything** (Top priority).
7. **`doctor`'s sandbox probe is dead on Codex 0.157** (1.0.0 fresh install).
8. **Routing:** easy lanes start at the default rung, not the cheapest that clears them; climbs used for plan or ownership problems (headless test; Orchestration).
9. **Profiles:** failover downgrades high rungs or lands on the Claude quota with an odd label; ladders that go down validate clean (1.0.0 fresh install; headless test).
10. **Cost:** a first Codex turn is 280k to 580k input tokens even on an easy lane, native or isolated (headless test; Routing and cost).
11. **Noise and polish:** warnings on the shipped defaults, a silent 30 s first `bunx`, the TUI's "0 profiles" first frame (1.0.0 fresh install).

Already fixed in 1.0 and confirmed live: serial dispatch (`dispatch` + `wait`, lanes overlap), the plan-in-hand path,
lint in the fast check, the `status` harness line, Jev keeping a sure kind.

## Top priority

- **Workers cannot run their own checks.** In the auth build 60 of 171 worker replies were `partial`/`blocked`
  because the sandbox denied Docker, loopback ports or the lock dir, so the Opus main thread ran the tests itself and
  even edited test files. Fix: network, the lock dir and `DOCKER_HOST` in the worker sandbox, or a `check(run, lane)`
  tool that runs the fast check outside it. _Evidence:_ `reports/2026-09-27-auth-build.md`, finding 1.
- **The skill decays after compaction.** Runs started after a compaction called no `route`, no reviewer and no
  verifier. Fix: `run_start` returns the checklist, `state.md` names the next protocol step, and `land` refuses a
  milestone without a review and a verdict unless the run says why. _Evidence:_ the same report, finding 3.
- **One owner question stops everything.** A blocked milestone should park with a push while independent milestones
  and runs continue; one question held the auth build for 4.5 h. _Evidence:_ the same report, finding 4.

## From the 1.0.0 fresh install (2026-09-27)

A clean 1.0.0 setup on macOS after removing every 0.x file: `bunx catherd-cli init`, the plugin commands, `doctor`, the
TUI.

- **Plugin install fails without GitHub SSH (blocker).** `marketplace.json` gives the plugin a `git-subdir` source
  with `"url": "47vigen/catherd"`. The marketplace itself clones over HTTPS, but Claude Code clones that shorthand over
  SSH, so `claude plugin install catherd@catherd` dies with `ssh: connect to host github.com port 22` on any machine
  without GitHub SSH. 0.x used `"source": "./plugin"` and installed fine. Fix: `"url": "https://github.com/47vigen/catherd.git"`,
  keeping `path` and `ref`. Workaround used: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf
  GIT_CONFIG_VALUE_0=git@github.com: claude plugin install catherd@catherd`.
- **`doctor`'s sandbox probe is dead on current Codex.** `canWrite` runs `codex sandbox macos --full-auto`; Codex
  0.157 has no `macos` subcommand (`codex sandbox [COMMAND]`, seatbelt implied) and no `--full-auto` there, so the row
  reads "not tested: no codex sandbox to test with" on every current install. It is the one check meant to catch the
  auth build's top finding. Fix: probe `codex sandbox -- sh -c ...` first, fall back to the old form.
- **The worker sandbox still cannot run checks (auth-build finding 1, confirmed on 1.0).** Under `codex sandbox`, a
  write to the locks dir, the Docker socket (`docker ps`), a loopback `bind()` and a write to `/tmp` are all denied.
  The default worker is `workspace-write`, so a Go monorepo with testcontainers repeats the auth build. Fix options: a
  worker access level between `workspace-write` and `full` (network, loopback, the lock dir, `DOCKER_HOST`), or a
  `check(run, lane)` tool that runs the fast check outside the sandbox behind the lock; `doctor` should say which one
  this machine needs.
- **Failover downgrades high rungs.** The inferred failover maps `codex:gpt-6-sol#high` and `#xhigh` to
  `opencode-go/kimi-k3#max` "treated like gpt-6-sol#medium". A usage limit on a climbed lane silently drops it back
  to the medium tier it just climbed from. Prefer a stand-in that clears the rung's own bar, or mark the row as a
  downgrade in `profile show` and `doctor`.
- **Warnings on the defaults.** A fresh `doctor` shows two `!` rows (full access for verifier and ui-reviewer, advisory
  access for the Claude roles) about the shipped defaults, which the user did not choose and cannot act on. Show them
  as info, or only when the profile departs from the defaults.
- **Silent first `bunx`.** The first `bunx catherd-cli init` resolves about 108 packages (TypeScript among them,
  pulled in transitively) for about 30 s before any output. Check what pulls TypeScript into the runtime tree, and
  say "installing catherd…" before the resolve where possible (README: suggest `bun add -g catherd-cli` first).
- **TUI first frame.** The Status tab shows "active · 0 profiles" before the profile list loads, then "1 profile".

## From the 1.0.0 headless test (2026-09-27)

`claude -p "/catherd:catherd ..."` on a scratch Bun + TypeScript repo, three independent utils plus an index, profile
with `codex.isolated: true`. Finished in 5 min for $0.89 of Claude; `bun test` 21/21 and `tsc` clean.

- **Parallel lanes work.** Three `dispatch` calls, then `wait({ all: true })`: the three Codex workers ran fully
  overlapped (12:50:59 to 12:54:35); M1 took 3.6 min against 7.6 min of summed worker time. Plan 9 finding 1 is
  fixed live.
- **`route` skipped for 3 of 4 lanes.** The orchestrator routed M1.L1 only and reused its rung for L2, L3 and M2.L1;
  `land` warned "no routed lane" and went on. This is a short run with no compaction, so it is not only the
  compaction decay. Fix: `dispatch` with a `lane` routes it itself when `routes.jsonl` has no entry, or refuses with a
  fix line.
- **No reviewer and no verifier.** The orchestrator read the code, ran the tests and made both commits itself. Fix:
  `land` refuses a milestone without a reviewer record and a verifier verdict, unless the call names why (and the
  skill lists the allowed reasons).
- **Replies carry no STATUS.** All four records have `replyStatus: null`: the orchestrator's briefs never asked for
  the STATUS line, and `dispatch` does not add the role's reply contract itself. The auth runs 3 to 5 showed the same.
  Fix: `dispatch` appends the role's reply contract (last line `STATUS: ...`) to every brief.
- **Sandbox denies the network.** The worker's `bun install` failed on DNS inside `workspace-write`; it passed only
  because `node_modules` already existed. Same root as the auth build's finding 1, on a trivial repo.
- **Easy lanes start at the default rung.** All four "Difficulty: easy" lanes ran on `gpt-6-sol#medium`, not the
  cheaper `gpt-6-luna#high` at the bottom of the ladder, under objective `cost`. The route should start at the
  cheapest rung that clears the lane's difficulty.
- **Worker first turn, isolated.** An easy lane still read 583k input tokens (L1); isolation does not make small lanes
  cheap.
- **Profile ladders can go down.** A ladder `... → sol#xhigh → luna#medium` validates clean. `validate` should warn when
  a rung scores below the one before it. Inferred failover labels read oddly too:
  `claude-code:claude-opus-5-5#low (treated like claude-opus-5-5#xhigh)`, and failover to a Claude rung spends the
  Claude quota the user ranks last.

## From the 1.0.0 platform run (2026-09-27)

Dev-registry MR and the end of auth plan 5 MR A, two runs side by side in one Desktop session. With the prompt forcing
route, reviewer and verifier, every lane was routed, both roles ran, replies carried STATUS, and lanes overlapped.

- **The verifier is the bottleneck.** At 63 min into MR A: workers and reviewer took about 9 min, the verifier about
  47 (26 min for the boot and SSO half, 20+ for the gate half, one attempt lost when it was cut and relaunched). Inside
  the gate, building the acceptance images took about 13 min, 7 of them a `pnpm install` in two Docker stages despite
  a cache mount; the suite itself ran after that. Ideas, catherd side: (1) the verifier runs independent gate items
  side by side within the lock's slots instead of one after another; (2) a gate item whose inputs have not changed
  since it last passed (tree hash of its paths) is reported as carried over, not rerun, when the milestone's diff
  since that pass is small; (3) the verifier builds each image once per commit and the boot check and the acceptance
  suite share it; (4) `status` shows the verifier's current step and elapsed time, so a long gate is visible instead
  of looking stuck. Repo side (platform): the Docker `pnpm install` should hit the package mirror and a warm store.
- **Final numbers for MR A.** The run took 100 min (13:18 to 14:58) before the user paused it with MR !54 open and
  green: workers and reviewer about 9 min, three verifier passes about 85 min (the last, the full gate with the
  acceptance suite, 14:01 to 14:57). M1 (dev registry), in its own run beside it, took 50 min end to end.
- **The plugin's MCP server dies on a half-cleaned bunx cache (second time).** `plugin/.mcp.json` runs `bunx
  catherd-cli@1.0.0 mcp`, which lives in `$TMPDIR/bunx-502-catherd-cli@1.0.0/`. A day later the plugin failed in
  every new session: `Cannot find module './v4/classic/external.js'` from `zod/index.js`: part of the tree was gone
  (macOS cleans `$TMPDIR` by age), and bunx reused the broken folder instead of reinstalling. 0.2.1 hit the same
  with `fast-deep-equal`. Claude Code then caches the failure for 15 min. Fix: run the MCP server from a stable place
  (the global `catherd` binary when present, else `bun x` with a cache under `~/.cache/catherd`), and have
  `doctor` import the tree once and say "reinstall" when a module is missing. Workaround: delete the bunx folder.

## Scores and catalog from public sources (2026-09-27)

_Picked up:_ designed in `docs/specs/2026-09-28-catherd-1.2-design.md` (1.2.0). The spec is binding where it differs from this section.

_What:_ `catherd catalog sync` pulls every independent, machine-readable source of model facts and scores, merges them
into the catalog routing already reads, and asks the user to pick a stand-in only for the rungs no source covers.
_Why:_ `catalog/models.json` and `scores.json` are written by hand today. A release like 2026-09-22 (Opus 5.5, GPT-6
Sol/Luna/Astra) leaves every new rung unscored until someone reads blog posts and types numbers in, and each unscored
rung needs a hand `treat-like`. Every source below was called with curl on 2026-09-27; none of the chosen ones is run
by a model vendor.

### Sources

Keyless, always on:

| Source | Call | Gives | License |
|---|---|---|---|
| models.dev | `GET https://models.dev/api.json` | per model: `reasoning_options` (the effort list), `limit.context`/`output`, `cost` (input, output, cache read/write, fast mode), `tool_call`, `modalities`, `release_date`, `knowledge` | MIT; opencode reads the same file |
| OpenRouter models | `GET https://openrouter.ai/api/v1/models` | id, context, pricing; new models appear the day they ship | public API |
| OpenRouter endpoints | `GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints` | per provider: `uptime_last_5m/30m/1d`, `latency_last_30m`, `throughput_last_30m` | public API |
| LiteLLM | `GET https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` | price and context, `supports_xhigh/max_reasoning_effort`; cross-check only | MIT |
| Arena (LMArena) | `GET https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=<c>&split=latest&length=100` | Agent Arena configs `agent` (Net Improvement), `agent_task_outcome_explicit`, `agent_bash_recovery_steps`, `agent_steerability`, `agent_tool_hallucination`, `agent_praise_complaint`; plus `webdev` and `text` (rating, CI, votes); `leaderboard_publish_date` | CC-BY-4.0, attribution |
| Vectara hallucination | `GET https://raw.githubusercontent.com/vectara/hallucination-leaderboard/main/README.md` (markdown table, parsed) | hallucination rate, factual consistency; "Last updated" line | Apache-2.0 |
| Epoch AI | `GET https://epoch.ai/data/benchmark_data.zip` (CSV per benchmark) | `frontiercode_external`, `webdev_arena_external`, `terminalbench_external`, `metr_time_horizons_external`, … with reasoning effort in `Model version` (`gpt-6-astra_max`) | CC-BY; external tables keep their own license |

Keyed, optional (asked in `init` like the Jev key):

| Source | Call | Gives | Terms |
|---|---|---|---|
| Artificial Analysis | `GET https://artificialanalysis.ai/api/v2/data/llms/models`, header `x-api-key` | one request, 674 rows, **one row per effort** (`gpt-6-astra-xhigh`, bare slug = `max`): `terminalbench_v2_1`, `terminalbench_hard`, `livecodebench`, `scicode`, `tau2`, `tau_banking`, `ifbench`, `lcr`, `hle`, `gpqa`, coding/intelligence/math index, pricing, `median_output_tokens_per_second`, `median_time_to_first_token_seconds` | free key, 100 requests/day, internal use only, attribution |
| same, fallback | `GET https://artificialanalysis.ai/api/v2/language/models/free?page=N` (4 pages) | intelligence/coding/agentic index, `cost_per_task`, pricing, speed | same |

The first AA path is the legacy v2 route: the free key reads it today but the current docs no longer list it, so a
404/403 there falls back to `/language/models/free`. `/language/models`, `/language/models/{slug}` (Pro) and
`/language/providers` (Commercial) answer 403 to a free key and are not used.

Checked and left out: Aider polyglot (last row 2025-10), SWE-rebench (last month 2026-07, no GPT-6), official SWE-bench
`leaderboards.json` (2026-02), the Terminal-Bench leaderboard repo (self-submitted by agent vendors, last 2025-11),
Galileo agent leaderboard and Helicone (stale), Scale SEAL / SWE-bench Pro and Vellum (403), BridgeBench (no API,
Cloudflare, `/api/` disallowed), llm-stats / benchlm / modelgrep (resell other sources), Kilo and OpenRouter rankings
(usage, not quality). Unresolved, worth a second look: BFCL, LiveBench and Design Arena have data but no endpoint was
pinned down.

### The AA key, like the Jev key

- `init` gains a second optional step after Jev: `ARTIFICIAL_ANALYSIS_API_KEY` in the env wins; else the saved key;
  else `Artificial Analysis API key (optional; Enter skips): `. The key is tested before it is saved (one request to
  `/language/models/free?page=1`: 200 saves, 401 does not) and never stops `init` (Ruling 11).
- Saved in `credentials.json` as `artificialAnalysisApiKey` beside `typesafeApiKey`, mode 600; the schema is a
  `looseObject`, so no schema bump. The env name joins `SECRET_ENV` in `infra/env.ts`, the saved key goes through
  `addSecret`, so workers never see it and logs redact it.
- Per-user keys keep the licence clean: each user reads AA for their own use, and catherd never ships AA numbers. The
  keyless sources are CC-BY or Apache, so their values could be shipped in `scores.json` too, with attribution.
- `doctor` gets a row: key present, last sync time, requests left today (`x-ratelimit-remaining`).

### The sync

- **At every session start, in the background.** The plugin's MCP server starts with each Claude Code session, so its
  boot fires the sync without awaiting it: no hook to add, and the server's handshake and first tool call never wait
  on the network. One TTL for every source, 12 h: a source is fetched only if its cached file is older than that. It
  costs AA 2 requests a day (10 on fallback) of the key's 100. A lock file in `<data>/sources/` keeps two sessions
  opened together from fetching twice.
- **Refresh on demand.** `catherd catalog sync --force` ignores the TTL (CLI); the TUI's catalog view gets an `r`
  key that does the same and shows each source's age and last error; and an MCP tool `catalog_sync` lets the setup
  skill or the user refresh from inside a session, returning what changed (new rungs scored, stand-ins no longer
  needed, sources that failed). Routing reads whatever is cached when it is asked; a sync that lands mid-run
  is picked up by the next `route`, and a failed one logs at debug and leaves the last good files.
- `catherd catalog sync` runs the same thing in the foreground (also run by `init`, and by `freshenDiscovery` when the
  cache is older than the TTL). It fetches all
  sources in parallel with the Jev client's retry policy, one timeout per source, and writes each raw answer to
  `<data>/sources/<source>.json` with its fetch time. A source that fails keeps its last good file; the sync reports it
  and goes on.
- Id mapping: lowercase, `.` → `-` (`gpt-5.6-sol` → `gpt-5-6-sol`), then a small alias table in `catalog/sources.json`
  for the irregular ones (AA `claude-4-5-haiku` → `claude-haiku-4-5`). Effort: AA slug suffix (none = `max`), Arena's
  `(Max)` / `(xHigh)` / `(High)`, Epoch's `_max` suffix. A model with no effort in its name maps to the family's
  default effort, marked `effort: assumed`. Unmatched ids are listed by `catalog sync --unmatched`, never guessed.
- Catalog facts: models.dev fills `efforts`, `context`, `price`, `capabilities` for families on the user's backends;
  OpenRouter and LiteLLM only cross-check (a price that disagrees by more than 10 % is a warning). The shipped
  `models.json` stays the floor, and the backend's own listing still decides what is callable.

### Dimensions and sources

| Dim | Anchor (the unit of the bars) | Other sources, calibrated |
|---|---|---|
| `repo_code` | DeepSWE (today's shipped values) | AA `livecodebench`, `scicode`, coding index; Epoch FrontierCode |
| `terminal` | AA `terminalbench_v2_1` | Epoch `terminalbench_external` |
| `honesty` | shipped (Broken Search Tool) | Vectara factual consistency; Arena `agent_tool_hallucination` |
| `agentic` (new) | Arena `agent` Net Improvement | Arena task outcome and bash recovery; AA `tau2` |
| `steer` (new) | Arena `agent_steerability` | — |
| `frontend` (new) | Arena `webdev` | Epoch WebDev |
| `speed` (fact, not a bar) | AA tokens/s and time to first token | OpenRouter `latency_last_30m`, `throughput_last_30m` |
| `cost` (fact, not a bar) | models.dev price | AA `cost_per_task` |

Bars are in each dim's anchor unit, so a value from another source is never compared to a bar raw. Calibration: on
the rungs both sources cover, fit anchor = a·x + b (at least 5 shared rungs, else the source is not used for that
dim) and store the fit with its R² in `<data>/sources/calibration.json`. A calibrated value carries its source and
the fit. New dims ship with no bars, so they change nothing until a profile sets one; `route` shows them.

### Precedence and confidence

`Score.confidence` grows from `verified | secondary | inferred` to, best first: `verified` (vendor or official
source), `measured` (an independent source for this exact rung, anchor unit), `calibrated` (an independent source for
this rung, mapped onto the anchor), `adjacent` (same model, another effort, from any source), `secondary`,
`inferred`. The user's override always wins, as today. Two sources at the same level: the newer `date` wins. A value
older than 90 days drops one level. Every value keeps `benchmark`, `version`, `url`, `date` and its source, so `route`
and the TUI can say where a number came from.

### When a rung has no data: the user picks its stand-in

1. `sync` ends with the list of enabled rungs that still have no value on a dim their bars need.
2. For each, catherd ranks the scored rungs by similarity on what every source does have for new models: AA
   intelligence index, `hle`, `scicode`, `lcr`, `cost_per_task`, tokens/s, models.dev price and context, same vendor
   and family. The distance is a z-score Euclidean over the features both rungs have, and a pair with fewer than 3
   shared features is not suggested.
3. The TUI's treat-like picker opens with the top 3 suggestions first, each with its distance and the features it
   rests on ("Opus 5.5#high ≈ Fable 5.1#medium: intelligence 53.6 vs 48.9, scicode 0.60 vs 0.59, price $4/$20 vs
   $10/$50"). The CLI prints the same: `catherd catalog treat-like <rung> --suggest`. The user picks, or types any
   rung; the choice goes to `catalog.override.json` as today, marked `source: "user"`.
4. `init --no-input` and headless runs never block on it: they take the top suggestion as `inferred`, and `doctor`
   lists it as a warning to confirm.
5. When a later sync brings real data for that rung, the stand-in is no longer needed: `sync` says so and
   `catherd catalog treat-like <rung> --clear` removes it (a user's pick is never removed silently).

### Where it lives

- `src/infra/sources/<source>.ts`: one fetcher and parser per source, returning `{ rung, field, value, date, url }` rows.
- `src/services/source-sync.ts`: fetch, cache, id mapping, calibration, merge into the `Catalog` layers in
  `catalog-service.ts`.
- `src/domain/catalog.ts`: new dims in `DIMS`, the longer confidence enum, `RANK` extended.
- `src/entry/init-command.ts`: `aaStep` beside `jevStep`; `catalog-command.ts`: `sync [--force]`,
  `treat-like --suggest|--clear`; `entry/mcp/`: the background sync at server boot and the `catalog_sync` tool;
  `entry/tui/`: the `r` refresh key and the stand-in picker's suggestions.
- `catalog/sources.json`: aliases and the list of sources with their licence and attribution line.
- Tests: one recorded fixture per source (parsers), the id mapping table, the calibration fit, precedence, and the
  suggestion ranking on the 2026-09-27 data (Opus 5.5 has no coding or terminal value in any source that day).

### Today's gap, for calibration

On 2026-09-27 AA has full per-effort values for GPT-6 Astra, Claude Fable 5.1 and GPT-5.6 Sol/Terra/Luna, but only
intelligence index, `hle`, `scicode` and `lcr` for Opus 5.5 and GPT-6 Sol/Luna (released five days earlier); Arena's
agent board has GPT-6 Sol (Max) but not Opus 5.5 or GPT-6 Luna; Vectara has GPT-6 Sol and Astra. So the stand-in
picker is the path for exactly the rungs a fresh release adds, and each daily sync shrinks that list without anyone
typing a number.

## From the 1.1.0 install (2026-09-28)

- **An invalid profile cannot be repaired field by field.** Clearing `treatLike` in `catalog.override.json` left three
  rungs unscored (`gpt-5.6-sol#high`, `gpt-5.6-sol#medium`, `gpt-6-luna#medium`). Every `catherd profile set` then
  failed with `E_CONFIG_INVALID`, even a `set` that removes one of those rungs, because each save validates the whole
  profile and the other bad field still fails. The workaround was to restore the mappings, make the edits, and clear them
  again. Fix: a save that removes errors and adds none goes through, and the result lists the errors still open.
- **`treat-like` cannot be undone from the CLI.** There is no `catherd catalog treat-like --rm`, so the only way to
  reset a mapping is to edit `catalog.override.json` by hand. Add `--rm <rung>` and `--reset`. Before removing a mapping,
  warn which profile rungs it would leave unscored.

- **The runs tab shows 00:00 for running roles.** In the M3 platform run (2026-09-28), two workers had been running for
  3 minutes and their event logs were growing, yet the TUI showed `running 00:00` for both. The owner took this to mean
  the run was stuck. Elapsed time should count from `proc.json` `startedAt`. Also show the last event's age, so that
  "alive" and "stuck" look different.
- **Workspace-write codex cannot reach the Go build cache.** In the same run, the M3.L1 worker's `go vet ./...` failed
  with "operation not permitted": the Go build cache (`~/Library/Caches/go-build`) is outside `writable_roots`. The
  worker got past it by pointing `GOCACHE` at `/private/tmp`, which forces a cold cache on every lane. Fix: add the
  toolchain caches that are present (`go env GOCACHE`/`GOMODCACHE`, the pnpm store, `~/.bun/install/cache`) to
  `writable_roots`, and add a `doctor` probe for them.

## From the 1.1.0 platform run (2026-09-28/29)

Run `20260928-172920-m3-auth-plan-5-mr-b-the-kit-clean-up` (sanitell/platform, auth plan 5 MR B) went from 1.1.0 to 1.2.0 mid-run, during a pause. It ran seven worker lanes, a writer, a reviewer, and a verifier in three rounds. Evidence lives in that run folder (`runs.jsonl`, the lane files and the role records).

**Delivery and the loop**

- **Messages arrive only when the next turn starts.** worker-M3.L1 ended at 17:43:08, and its catherd message reached the main thread only after the owner's next message, about 20 min later. An idle main thread is not woken. Until something wakes it, `peek` is the only way to see it, and the owner read the silence as a hang. Fix: wake an idle owner session, or let `status` show "finished, unread" prominently.
- **`protocol.next` ignores lane order.** It said "dispatch M3.L3, M3.L4" while both depended on L1's kit changes, which have to compile first. Admission guards only file overlap, not package-level compile coupling. Fix: add a `After: M3.L1` lane header that `protocol.next` and admission respect.

**Lanes and Owns**

- **An Owns list cannot grow mid-lane.**
  - L3 (Task 11 Go) ended partial on `services/notification/cmd/notification/audit_platform_test.go:93`, outside its Owns. The plan's grep excluded `_test.go`.
  - L4 (Task 12) stopped on four panel clones that `dupes` found only after the allowlist emptied.
  - Each case needed a hand-written lane: L5, L6, L7, and a rescoped L4.

  Fix: an `owns_add(run, lane, paths, why)` tool that re-checks overlap. Clone-driven work also needs a "discover, then split" step, because the files are knowable only after the gate runs.
- **Jev overrode the lane headers.** All four first lanes declared `Kind`/`Difficulty`, and routing replaced them (declared logic → `repo_code`/`copy`), so the logic lanes started on `luna#high`. Fix: a declared header wins, or the route record says why it didn't.
- **A lane could not declare an allowed exception to its own absence grep.** The plan's `func Allowed` grep also matched an unrelated `services/verification/internal/job/command.go:120`, and `acceptancetest\.SignIn` matched the surviving `SignInAuth` and `SignInSSO`. The workers returned partial correctly, but a check that can never pass looks the same as work that isn't done yet. Fix: an `Allow:` line under the check, and word boundaries in plan greps.

**Preflight and environment**

- **Preflight runs without the user's environment.** The testcontainers checks in L1 and L3 failed "rootless Docker not found", because `DOCKER_HOST` points at OrbStack and preflight doesn't inherit it. They were reported as fails-as-expected, not as cannot-start. Fix: run preflight in the user's login environment, and class "cannot start" apart from "fails as expected".
- **The verdict has no environment class.** In verifier rounds 2 and 3, both acceptance suites failed on the environment:
  - a connected Cisco AnyConnect socket filter drops unsigned binaries' connections to the docker bridge subnet, while `curl` passes, and a 20-line Go binary reproduces it;
  - `proxy.golang.org` returned EOF inside an image build.

  Both came out as a plain FAIL. Fix: a verdict of `BLOCKED: environment`, with the probe that proves it, so the orchestrator surfaces the blocker instead of cycling fix rounds.
- **The version bump changed the sandbox silently.** Worker records went from `workspace-write, isolated: true` (1.1.0) to `access: full, isolated: false` (1.2.0) with no note in the run. Fix: pin the protocol and the sandbox per run, or log the change in `state.md`.

**Verifier**

- **The foreground verifier handed off and ended.** Its first turn ended after 80 s with "the status monitor will report each one as it finishes". No monitor reports to the main thread, so it had to be resumed with SendMessage, and ending the turn killed an auth `task check` mid-govulncheck. Fix: the verifier prompt forbids background watchers and ending the turn while a command runs.
- **Lint reached only the verifier.** The workers' fast checks ran `go test`, never `golangci-lint`, so an `unparam` in tokenapi and a `revive` in both services' `audit_names.go` cost a full verifier round of about 43 min. Fix: a lane's fast check includes the linter of every package it touched.
- **`gate_check` carried nothing across rounds.** The round-2 verifier didn't have round 1's item names, so every item ran again. Fix: `gate_check` lists the milestone's recorded items, and the verifier reuses their names.

**Ledger and knowledge**

- **`land` accepted inexact verifier names.** M2 landed with verifier records named `verifier-M2-pre`, `-gate1` and `-gate3`, with no exact `verifier-M2` row. Its ledger minutes (1689) counted the whole paused night. Fix: match the name exactly, and subtract the pauses.
- **`knowledge.md` is keyed by worktree path.** Every worktree (`dev-registry`, `auth-verification`, `auth-kit-cleanup`) is a new repo, so `read_knowledge` for M3 was empty although M1 and M2 wrote `learned`. Fix: key by the git origin.

**Resume (2026-09-29)**

- **A "foreground" verifier is still a background agent.** On the resume, the orchestrator briefed the verifier to stay in the foreground, and the Agent tool launched it async anyway ("Async agent launched successfully"). The verifier can block inside its own turn, but the main thread only learns the verdict from a notification. Fix: the skill says so plainly, and `protocol.next` treats the verifier as a dispatched role whose result arrives as a message, not as a call that returns.
- **`status` lists a previous owner session as live.** After a new session had taken the run, `status` and `peek` still listed the previous owner session as `live: true` (the stale verifier step itself closes since 1.5).
- **The profile is not pinned per run either.** The active profile changed from the codex one to `just-claude` while M3 was paused, so the run's verifier rung changed (`catherd-default-verifier-*` is gone and `catherd-just-claude-verifier-claude-opus-5-5-low` took over), and any re-dispatched lane would route on Sonnet instead of the Codex rungs it started on. Nothing in the run records the switch. Fix: same as the sandbox item: pin the profile at `run_start`, or log the change in `state.md`.
- **A host probe needs to run twice.** Right after the AnyConnect VPN was disconnected, the first unsigned Go probe to `203.0.113.20` still got `no route to host`. The next seven, including one from a freshly built binary on a fresh network, answered 200. A single probe would have stopped the run for nothing. Fix: when catherd ships a host probe, it retries once after a few seconds before calling the host blocked.

- **`preflight` reruns every past milestone's lanes.** Called for M4, which had one new lane, it ran all seven M3 lane checks too (Go testcontainers and four panels), took about 2 min behind the lock while the M4 worker was already running, and reported a failure on an M3 lane (`TestSeedWritesEveryStateThePanelShows`) that has nothing to do with M4. Fix: preflight only lanes that have not landed, or take a `milestone` argument.

## From the payment run (2026-09-29)

catherd 1.2.1, profile just-claude, sanitell/platform payment plans 1–11. That is eleven runs, one per plan and its worktree, from `20260929-113331` (plan 1) to `20260929-145705` (plan 11). The run ended with eleven MRs merged to staging (!59–!62, !64–!70). Evidence lives in each run folder: `runs.jsonl`, `agents.jsonl`, the lane files and the role records.

**Programs span runs**

- **One run per worktree, and nothing links them.** Each plan had its own worktree, so it needed its own run with a lone `M1`. The program's order lived only in the orchestrator's head:
  - 1, 2 and 4 in parallel;
  - 3 after 2;
  - the chain 5→11.

  Nothing models "M1 of run B needs M1 of run A merged", and after each merge the stack had to be rebased by hand. Fix: a program or run group with cross-run `After:` edges.
- **One environment blocker took three parks.** A VPN took the default route and blocked every run. `park` is per run and per milestone, so it took three parks and three pushes. Fix: a machine-level or group-level "paused: environment" state.
- **Two verifiers at once starve each other.** Plan 2's and plan 4's verifiers ran side by side. Plan 4's vitest ran next to a `task check` and hit six 5000 ms timeouts in files the diff does not touch. The lock's heavy slots let the two overlap, and catherd has no view of the machine across runs.

**Routing and dispatch**

- **`route` bloats the orchestrator.** Every call returns the full provenance block, about 3k tokens per lane, into the most expensive context of the run. Fix: return rung, ladder, backend and agent, and write provenance to `R/routes.jsonl`.
- **Ladders were inverted on just-claude.** `Difficulty: build` lanes got the ladder [sonnet#high] with no room to climb (source `jev-kind`). `logic` lanes started lower, at sonnet#medium. Every claude-code value in provenance was `inferred` from a gpt-6-sol benchmark. Evidence: the first four routes of runs `-113331`, `-113334` and `-113338`.
- **`dispatch` needs a rung it then overrides.** `rung` is required, even when the lane is not routed yet. The orchestrator guessed a rung, and dispatch overrode it with a hint. Fix: make `rung` optional on a lane dispatch.
- **Lane values are refused only at preflight.** `Difficulty: medium` (the word plans use) was refused as `E_LANE_INVALID` at preflight, not when `write_run_file` wrote the lane. Evidence: run `-135414`.
- **There is no `lane_set`.** Fixing one header line (a fast check without `pnpm check`, or an Owns path) meant `sed` on the run folder. Evidence: runs `-113331` and `-143512`.

**Preflight**

- **Environment failures are classed as expected.** A testcontainers check without `DOCKER_HOST` failed with "rootless Docker not found", and preflight called it `fails-as-expected`. This happened on plan 1 and again on plan 3. An environment error should be `cannot-start`.
- **A filter that matches nothing passes.** `pnpm --filter checkout …` passed before `apps/checkout` existed, because pnpm exits 0 on an empty filter. It should be `skipped`. Evidence: run `-135414`, M1.L4.
- **A broken check is called expected.** A compose file that is valid only layered on another failed `config -q`, and preflight called that `fails-as-expected`. Evidence: run `-143512`, M1.L5.

**Workers**

- **"Do not commit" conflicts with acceptance built from HEAD.** `tooling/acceptance.sh` builds from `git archive HEAD`, so a lane told not to commit cannot run the acceptance it owns. One worker skipped it (plan 5). Another made an unreferenced commit and a detached worktree (plan 10). Fix: a per-lane WIP-commit escape, or acceptance belongs to the verifier by default.
- **There is no "flaky" outcome.** Three cases needed a judgement with no record:
  - an input-otp timer error that the worker never reproduced;
  - a notification timing test that failed once in turbo and passed 3/3 alone;
  - vitest timeouts under load.

  Climb, accept or rerun is left to the orchestrator.
- **An environment block is not tagged.** A worker replied `STATUS: blocked` with `ENV: vpn` on its own line, but the hints did not flag it. Climb-by-default would have spent a rung. Evidence: run `-113338`, worker-M1.L4.
- **Lanes share the testcontainers reaper.** Parallel lanes on one daemon failed with "reaper container name already in use". Evidence: run `-135414`, worker-M1.L1.

**Reviewers and verifiers**

- **The low-effort reviewer stops at "partial".** On plans 4, 5, 9, 10 and 11, reviewer-M1 at claude-opus#low read the core and replied `STATUS: partial`. `record_agent_run` counts it `ok`, and `land` accepts it. Second passes scoped to the unread files found real issues:
  - a vacuous property walk (plan 10);
  - two bugs in plan 11's review actions, found on its first scoped pass.

  Fix: size the reviewer to the diff, or refuse a partial review as the milestone's review.
- **The verifier runs in the background even when told not to.** The Agent call returned "Async agent launched" and an interim "waiting for the gate" message. The verdict came as a second notification. Evidence: runs `-113331` and `-133255`.
- **The verifier sets up the environment by hand.** Every verifier's first `task check` or turbo hit govulncheck's 403, because `HTTPS_PROXY` was missing. Every first testcontainers run needed `DOCKER_HOST`. Fix: carry a per-repo gate environment in the profile or the knowledge file, and inject it into verifier briefs.
- **Nothing cleans up Docker.** After about 30 image and acceptance builds, Docker hit "no space left on device", and even `builder prune` failed until dangling images were removed. About 20 GB was freed. Evidence: plan 11 verifier, 15:42.
- **The verifier caught what review could not, and it paid off.** The hardened property walk, run `-count=3` by the verifier, found a real cross-payment ledger bug in refund. The plan 8 and plan 11 reviewers found real bugs as well. The loop earned its cost on this run.

**Outside catherd, noted for the orchestrator**

- **Branch pipelines held the runner.** Pushing five stacked branches started five branch pipelines on the single runner, and plan 5's MR pipeline sat pending for about 30 min. Stacked pushes need `-o ci.skip`.

## From the platform review-fix run (2026-09-30)

catherd 1.2.1, sanitell/platform review-fix plans 1–7, one run per plan and its worktree, seven MRs merged to staging (!73–!79) in about 13 h 20 min. Already listed above and seen again: one run per worktree (`dispatch` takes no cwd), and a "foreground" verifier that runs in the background anyway.

- **`protocol.next` offers the verifier before the fix round.** After a reviewer returns findings, the next step it names is the verifier, not the fix round. Fix: `protocol.next` reads the reviewer record, and with open BLOCKER or BUG lines it names the fix round.
- **A verifier resumed with SendMessage hangs.** More than once, the resumed verifier never returned. The workaround was a fresh verifier with a 10-minute cap on each command. Fix: re-checks go to a fresh verifier by default, with the failed items named and a per-command timeout in its brief; `gate_check` already carries over what passed.
- **`preflight` times out at 300 s behind the lock.** With testcontainers suites from other lanes holding the lock slots, preflight waited past its own timeout. Fix: preflight takes a lock slot per check with its own wait budget, or reports `lock-busy` instead of a timeout.

## From the agentic-machine identity run (2026-10-02)

catherd 1.4.0 on a Codex-only Linux host (Ubuntu 26.04, Codex CLI 0.160.0, opencode 2.0.21). Codex was the
coordinator, first on GPT-6.1 Sol medium and later on GPT-6 Astra medium. Run
`20261002-005043-identity-implementation-m1-through-m5` on sanitell/platform: five sequential MRs, full autopilot.
After 9 h 15 min it had 34 role dispatches and 496 role minutes, and M1 had not landed. Its code was reviewed and
clean by 03:30. The six and a half hours after that went to seven verifier attempts, mostly on environment
failures. The coordinator read 26.7 M input tokens (97 % cached). The harnesses were isolated until 10:20, when the
owner turned isolation off (the host is itself a sandbox).

- **Isolated roles cannot reach catherd's own tools.** The isolated `CODEX_HOME` has no catherd MCP server. The
  verifier was told to call `gate_check`/`gate_pass`, so it wrote a stdio MCP client (`/tmp/m1-verifier-mcp.py`),
  wrapped it in `/tmp/m1-gate.py`, and drove `catherd mcp` by hand for every gate item. That spawned about 200 one-shot `catherd mcp` processes, one per call (03:31–10:17 in
  `catherd-2026-10-02.jsonl`), each paying a boot and a reconcile. Fix: add CLI forms any role
  can run (`catherd gate check|pass`, `catherd run-file write`), name them in the verifier's brief, and stop
  telling an isolated role to call MCP tools. Or write a catherd-only `[mcp_servers]` entry into the isolated
  config. Isolation per role, not only per harness, would also have kept the verifier native here.
- **`gate_check` paths do not fit a monorepo gate.** The log has six `E_INPUT_INVALID` (03:32–08:33):
  `gate path apps/checkout/dist exists neither at HEAD nor in the working tree`, and
  `gate path node_modules/.bun/@adobe+react-spectrum@… holds more than 10000 files to hash`. A full
  `turbo run check` really does read `.`, `node_modules` and ignored build outputs. Fix: hash tracked content from
  `git ls-files -s` plus the lockfiles for dependencies. Treat an absent ignored path as part of the hash ("absent"),
  not as an error. Leave `node_modules` and the gitignored outputs out of the walk unless a path names them.
  (`src/services/gate-service.ts`.)
- **The wall timeout kills a long gate.** Verifier attempt 3 hit `wall-timeout, exit SIGTERM` at 90 minutes inside
  the root gate (55 turbo tasks plus testcontainers). Attempt 4 took 85 minutes for that gate alone. The
  coordinator then split the gate and acceptance into separate continuations by hand. Fix: per-role `timeouts`
  (`roles.verifier.timeouts.wallMin`). Or count the wall from the last output, not from the start, while a
  `catherd lock` child of the role is alive and writing. The verifier brief also splits the root gate from the
  per-service acceptance items by default.
- **`run_start` could warn about an active Codex goal.** In the identity run a thread goal made Codex start a
  goal-continuation turn about once a minute (11 turns in 21 minutes, 7.2 M input tokens). Since 1.5 the skill ends
  such a turn with no tool call and `peek` answers `actionable: false`; a warning at `run_start` when the thread
  has an active goal would catch it before the first poll.
- **Equal scores never reach the second quota.** In 34 dispatches there were 0 opencode rungs and 0 climbs. Under
  `objective: speed`, DeepSeek 4.1 Flash max (treat-like GPT-6 Luna xhigh, the same values as Luna high) sits
  second in the worker ladder, so Luna always won. The writer and researcher ladders behaved the same way. The
  ChatGPT plan carried everything while the OpenCode Go subscription sat idle. Fix: break ties on quota headroom
  across billing keys, starting the lane on the less used subscription when scores tie. Or add an objective that
  balances subscriptions. `route` says when a tie decided the pick.
  Root cause, found after the run: the profile's ladder order is never read. `candidates` sorts by cost
  (`compareCost`), or by measured seconds first under `speed`. The three opencode-go models have no catalog family,
  so `costOf(null, …)` returns `value: null` and they have no `secs` yet, and both sorts put them after every Codex
  rung. Only `billing.codex: metered` (tier 1) together with `objective: cost` put them first. A dry run of
  `select` then started worker copy/build/prose lanes, and every writer and researcher lane, on DeepSeek or Muse.
  Fix: an unpriced subscription rung costs 0 within its tier, not "unknown, last". The profile's ladder order breaks
  ties. `profile validate` warns about a subscription rung that can never start.
- **The climb ladder goes down above the top rung.** `M1.L2` (repo_code/hard) got the ladder
  `gpt-6.1-sol#medium → deepseek-v4.1-flash#max → glm-5.3-flash#max`: no rung cleared the hard bar, so the "climb"
  was all weaker rungs. Fix: a climb ladder holds only rungs that score at least the start. When nothing clears the
  bar, `route` says so (`no rung clears repo_code/hard; best is …`), and `profile validate` warns about a kind and
  difficulty no rung of a role can reach.
- **Only worker dispatches leave a route record.** `routes.jsonl` has 11 entries for 34 dispatches. The writer,
  researcher, reviewer, verifier and architect rungs (for example writer on Luna high instead of the ladder's first
  rung) cannot be audited. Fix: `route` and `dispatch` record every role's decision, its source and the ladder.
- **A superseded run stays open.** Planning run `20261002-002615-…` (main checkout) handed over to the execution run
  in the worktree, because there is one run per worktree. It still lists as `idle`, with
  `Protocol next: route and preflight M1's lanes`. Fix: `runs supersede <run> --by <run>` (or a field set by
  `run_start` with a `from:` line) closes it with a pointer, and `status` hides it.
- **doctor misses a Docker client that injects proxies.** `access:codex` passed `docker version`, but
  `~/.docker/config.json` had a `proxies` block, so every container got `HTTP_PROXY`. That broke a compose stack's
  internal names (`minio-buckets` could not reach `minio`) and a BusyBox `wget` loopback health check
  (`notification-fake`). Three of the seven verifier attempts failed on it. Fix: doctor warns when the client config
  has `proxies`, and probes a two-container compose network by service name with a loopback `wget` health check.
- **A provider outage looks like progress.** `researcher-M1-signin-failures` on
  `opencode-go/muse-spark-1.3-contributor#xhigh` (10:29:39) produced no tool call and no text in 4.5 minutes. The
  session held one assistant message with `retry.attempt: 6` and `503 service_overloaded: The backend is
  temporarily overloaded`. Each opencode retry emitted a `step_start`, which reset the 15-minute idle timer, and
  `failover` covers only usage limits. The role would have sat until `wallMin`. The owner cancelled it by hand
  (`runs cancel` interrupted the server session cleanly: `aborted: Step interrupted`). Fix: the opencode adapter
  reads the session's `retry` field (or counts consecutive `step_start` with no part between them). After N
  provider retries (say 3) or about 3 minutes of retry-only events, it fails the attempt as `provider-unavailable`,
  and `climb`/failover treats that like a usage limit: the next rung on another backend. A retry-only stretch
  does not count as activity for `idleMin`.
- **Investigate: three MCP servers for one Codex session.** At 09:36 one Codex TUI started `catherd mcp` three times
  (pids 633954 and 634083 as host codex, and 634148 as host `unknown`). Each reconciled the runs. Check whether
  Codex spawns the plugin server per tool context. If so, make boot sync and reconcile single-flight across
  processes.
- **Scores of a new same-family release start absurd.** With no public numbers, GPT-6.1 Sol was inferred at
  repo_code 37.2 (low) and 56.6 (medium), below GPT-6 Luna, so the router would have avoided it. It was fixed
  locally with `treat-like` from the Artificial Analysis Intelligence Index per effort (slopalytics.com): Sol 6.1
  medium 47.8 ≈ Astra low, high 50.2 ≈ Astra medium. GLM 5.3 Flash max (41.8) and DeepSeek 4.1 Flash max (39.5)
  were mapped the same way. Fix: read the AA Intelligence Index per model and effort as a calibration source. Until
  a value arrives, a release of the same family takes at least its predecessor's values at the same effort.

## 1.3 follow-ups (plan reviews, 2026-09-29)

- **Discovery runs a non-Cursor `agent`.** `refreshDiscovery` calls `listModels()` without a probe, so with only
  grok's `agent` on PATH catherd runs `agent models`. Its lines do not parse, so nothing is written, but the row shows a
  raw spawn error. Fix: `listModels` returns `[]` unless the `agent` found prints Cursor's date-hash version, or
  `refreshDiscovery` skips a backend `probeBackend` calls not installed. (Plan 15 final review, Minor 2.)
- **Downgrade fixes can suggest a Cursor stand-in** on a machine without Cursor. `profile-rules` builds its stand-in
  pool from every registered adapter. Fix: limit the pool to backends the profile already names. (Plan 15 final
  review, Minor 4.)

- **Isolated grok discovery lists under the native identity.** With both a grok login and `XAI_API_KEY`, `listModels`
  runs under the user's `GROK_HOME` (the login wins) while an isolated worker uses the key, so `prepare` can judge a
  model by the wrong account's listing. Fix: list and cache per identity when isolated. (Codex, PR #31.)
- **Doctor ignores implicit paired stand-ins.** `usedBackends` scans role rungs and `profile.failover`, not
  `PAIRED_FAILOVER`, so a missing Cursor reads as an unused `skip` although a Grok rung would fail over to it. Fix:
  count paired targets as failover use. (Codex, PR #31.)
- **Doctor's `sandbox:grok` check keeps the real HOME and the compat features on** (it moves only `GROK_HOME`). Fix:
  add the ten compat toggles and `GROK_MEMORY=0`, or a scratch HOME. (Plan 16 final review, Minor 2.)
- **sandbox.toml: bare keys after catherd's block change tables** when the block moves to the end; and two catherd
  homes on one machine rewrite each other's block. Both rare. (Plan 16 final review, Minors 3 and 5.)

- **A sandbox.toml link catherd cannot follow or write** (dangling, or into a read-only store such as Nix) fails
  closed with a raw ENOENT/EACCES instead of `E_CONFIG_INVALID` and the isolate fix. And `sessionFor` could hash
  the dispatch id alone rather than the full dispatch path, so a differently resolved data dir cannot change it.
  (Plan 16 re-review, Minors.)

- **Isolated agy lists models as the native account.** `prepare` checks an isolated rung against `agy models` run
  under the user's HOME and its shared discovery cache, so a Google-plan listing can reject (or admit) a rung the
  `GEMINI_API_KEY` project serves differently. List under the isolated HOME, with the cache keyed by auth route.
  (Codex P2, PR #32; the grok twin is above.)
- **agy's 10-minute readiness cache.** A probe that saw agy signed in is kept 10 minutes, so a sign-out inside that
  window still reaches a native `-p` (which opens a browser). Document it, or re-run `agy models` in native
  `prepare` (~10 s a dispatch). (Plan 17 final review, Minor 3.)

- **A sparse rung borrows its nearest stand-in's honesty.** Shipping GPT-6.1 Sol's one honesty value (97.92, a
  Broken Search Tool figure) would have become the honesty stand-in for 18 unrelated rungs, e.g.
  `opencode/claude-haiku-4-5#high` 22.5 → 97.92: the similarity ranking seems to favour rungs with few values of their
  own. Check the nearest-stand-in distance before shipping any single-dimension row. (PR #36.)

## Routing and cost

- **Jev hit-rate review.** After N runs, show how often each Jev start rung had to climb, per kind and difficulty:
  "build lanes on `codex:gpt-6-luna#high` climbed 3 of 10". _Why:_ it is the raw material for catalog tuning, and it
  tells the user whether a bar is too low today. _Where:_ `runs_summary`, `watch`, and the setup skill.
- **Jev difficulty calibration.** In the first two real runs Jev was sure of the kind (1.0) but not the difficulty
  (0.4), so 3 of 4 routes fell back to the default. Log each lane's final outcome (climbed or not) beside Jev's answer,
  then tune the difficulty question's wording, its options or its threshold from that data.
- **Batch `route`.** `route` takes one lane per call, and each call may wait up to 25 s on Jev, so a milestone of
  six lanes can spend minutes routing before its first dispatch. One `route(run, lanes: [...])` could ask Jev for
  every lane at once and return one answer per lane. _Where:_ the `route` tool and `routing-service.ts`.
- **First-turn cost on small lanes.** A native Codex turn starts at about 280k input tokens (mostly cached) whatever
  the lane's size. A profile rule such as "isolated below difficulty build" could save most of it without touching the
  user's harness for real work. _Where:_ the profile's `harness.<backend>.isolated`, made conditional.

## Orchestration

- **A per-milestone digest.** One screen per landed milestone: A-lines met, commits, climbs, open findings, time and
  tokens. The push notification links it. _Why:_ the user asked "where is it" about 8 times in one run; the milestone
  push answers when, and the digest answers what. _Where:_ `land` writes it into the run folder; `watch` shows it.
- **Milestone per branch.** A real multi-MR build wants one branch and one MR per milestone, some in parallel. `land`
  only commits. _Where:_ an optional `branch` on milestones, and a finish step that opens the MR through the repo's
  own tooling.
- **Stacked milestones.** Starting M2 only after M1 merged serializes the run behind review and the gate. M2 could
  start on a branch stacked on M1 while M1's gate and MR run, and rebase once it merges.
- **Climb only for capability.** Half the climbs in the auth build were plan contradictions or file-ownership limits,
  which a stronger model cannot fix. Before climbing a `blocked` reply, `ask(run, "finding")`, and send `design` or
  ownership to the architect. _Evidence:_ `reports/2026-09-27-auth-build.md`, finding 5.
- **Verifier in the foreground, no polling.** All nine verifier calls ran in the background, and the main thread ran
  46 sleep/poll loops while waiting on dispatches. The `wait` tool removes the loops; `land` should record how the
  verdict was produced.

## Later

- **Race mode.** For lanes a profile marks as critical, dispatch two rungs at once in separate worktrees and keep the
  first whose fast check passes. It trades quota for wall-clock time.
- **Automatic retro.** At the finish, write a short retro (climbs, the slowest steps, failures) and suggest
  improvements.
- **`catherd bench`.** Replay recorded real tasks under different profiles to measure them on the user's own work.
- **Standalone binaries.** `bun build --compile` per platform, published as optional platform packages, so users need
  no Bun install. It waits until OpenTUI's native core embeds cleanly in a compiled binary.

## Live coverage still missing

An opencode lane, quota failover and a budget stop have run only in tests, never in a real orchestrated run; the
live kit now scripts them, with parallel lanes and a forced climb (`live-verification.md` §6), and they leave this
list once a release run records them. A climb and a multi-milestone, multi-MR build are covered live (the auth
build, 8 climbs, 16 MRs).
