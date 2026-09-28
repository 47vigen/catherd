# Final whole-branch review: plan 11 (access and protocol), 546e5f8..272522b

Reviewer: final whole-branch seat (superpowers `requesting-code-review/code-reviewer.md`). Read-only on the checkout.
Method: I read the whole 6,835-line review diff in passes (src, then tests, then docs and skill). I checked what
lies outside the diff in a scratch worktree at 272522b, with a second one at 546e5f8 for comparison. I ran
typecheck, lint, format:check and the full `bun test` there, and ran targeted scripts to confirm each finding
below that is marked "Reproduced".

Gate at 272522b (scratch worktree): typecheck, lint and format:check are clean. `bun test` gave 1350 pass, 10
skip and 1 fail. The failing test changes from run to run: "doctor > fails on a credentials file others can
read" (a 5 s timeout) and "catherd status and watch --once" (a `0s`/`1s` wall-clock race). Both also fail on the
base 546e5f8 in this sandbox, so they are pre-existing flakes and not plan 11's. They are in Declined to judge.

## Strengths

- **The grants come from one source.** `codexGrants` and `claudeAccessArgs` (src/adapters/codex/index.ts:36,
  src/adapters/claude-code/index.ts:73) build what the workers get. Doctor's probes reuse exactly those
  arguments, so doctor tests what a worker runs with. `network !== false` is carried from the profile through
  `viewOf` into `admit` (admission.ts), and failover stand-ins inherit it.
- **The widened sandbox matches the §5 intent on Codex.** The only additions are `network_access` and two
  writable roots (the lock dir and the real TMPDIR), on fresh, resumed and isolated runs. `read-only` and
  `full` get nothing. `network: false` removes only `network_access`, and the tests pin the argv in all
  three shapes.
- **Every new tool input that becomes a path is validated before any write.**
  - Milestone ids: `assertId` in land, park and answer, plus `ID_PATTERN` in the MCP schemas.
  - Gate paths: `normalizeOwned` refuses `..` and absolute paths. A path that exists nowhere is refused
    before anything is recorded.
  - `digests/`, `verifier.jsonl` and `questions.jsonl` are server-owned. `findRun` validates the run id
    everywhere.
  - Every git call takes its arguments as an array, so none of this input reaches a shell.
- **The land gate runs in the right place.** It runs after `commitExists` and before the ledger append. It
  names only what is missing, and each refusal carries a fix. The tests for it use real git commits and a
  fake clock.
- **The parked prefix is normalised in one place.** `withParked`, applied through `parkedNext` on both write
  paths, means no writer of `next` can drop the prefix. Fix round 1's idempotent `answer` closes the
  split-brain case.
- **The plan-10 merges are correct.** Dispatch runs claim, then route, then admit, then start and watch. Peek
  keeps every plan-10 field and adds `questions` first, then `protocol` and `verifier`. The skill keeps plan
  10's push wording, and the MCP list is pinned at 25 tools.
- **Layers and imports hold.** The layer rule holds (architecture test green). The new service graph has no
  import cycle: state → protocol → milestones → dispatches → run-store.
- **The new tests are well isolated.** Each gets its own `CATHERD_HOME`, uses `snapshotEnv`, uses no
  wall-clock sleeps for correctness, and points doctor's own tests at a local `Bun.serve` and a missing
  docker.

## Issues

### Critical (Must Fix)

None.

### Important (Should Fix)

1. **Doctor probes backends that are not installed. Tests outside doctor.test therefore reach the real npm
   registry and run the real `docker`.**
   - File: src/services/doctor-access.ts:160 (`accessChecks` loops over `workspaceWriteNetwork(profiles)`) and
     src/adapters/opencode/index.ts (`accessShell: async () => scratchShell(...)`, with no install check).
   - What happens: the default profile fails every Codex rung over to opencode, so `access:opencode` is
     always probed. opencode's (and claude-code's) access shell is a plain `sh`, so the probes run even when
     the CLI is missing. The row then says what "a worker" can reach on a backend that cannot run at all.
   - Tests that call `doctor()` without `CATHERD_PROBE_URL` or `CATHERD_PROBE_DOCKER` fetch
     https://registry.npmjs.org/-/ping and run `docker version`:
     - test/services/doctor-push.test.ts:143, which calls doctor twice;
     - test/entry/init-command.test.ts, because `catherd init` runs doctor;
     - test/entry/tui/pty.test.ts, through the Status tab.
   - Reproduced: with PATH holding no backend CLI, `doctor()` returned `access:opencode … blocked: docker version
     ( Context: default)` in 309 ms, and the HTTPS probe passed. The probe really went out.
   - Why it matters: it breaks the constraint that no test reaches the network beyond the probe's intent
     (CLAUDE.md, plan Global Constraints). With the network black-holed, each call waits up to 20 s. The row
     is also misleading for users.
   - Fix: in `accessChecks`, skip (row `skip`, "not installed") any backend whose `probe().installed` is
     false. Doctor already has that probe in `backendChecks`, so reuse it. Also set `CATHERD_PROBE_URL`
     and `CATHERD_PROBE_DOCKER` in `withHome()` or a test preload, so no future doctor test can leak. Add a
     test: no opencode on PATH gives no probe run.

2. **The failed probe's "why" is the wrong line in real use.**
   - File: src/services/doctor-access.ts:105: `last = \`${err}\n${out}\`.trim().split("\n").at(-1)`.
   - What happens: stdout comes last, so a probe that prints to stdout reports stdout's last line.
     - Reproduced, real `docker version` with the daemon down: stdout ends with the client block, so the
       row reads `docker version ( Context: default)` while the actual error is on stderr.
     - A failed fetch (no route, DNS) is an uncaught throw in `bun -e`. Its stderr ends with Bun's trailer, so
       the row reads `outbound HTTPS (Bun v1.4.2 (Linux x64))`.
   - Why it hides in tests: the tests' fake docker prints only to stderr, and the sandbox-deny simulator
     prints one line.
   - Why it matters: Review Focus 5 expects "names the probe and its last error line". For the two failures
     users will actually hit (daemon down, no route), the row says nothing useful.
   - Fix:
     - Prefer the last non-empty stderr line, and ignore a `^Bun v\d` trailer.
     - Wrap FETCH in `try { … } catch (e) { console.error(e.code ?? e.message); process.exit(1) }`.
     - Add a test with a fake docker that prints a client block on stdout and the error on stderr, and one
       with an unreachable URL (e.g. port 9) that asserts the reason (`ConnectionRefused`).

3. **The land gate never accepts a native reviewer, so such a milestone can never land.**
   - File: src/services/milestones.ts:44 (`reviewerPassed` reads only `readRecords`, the dispatch records).
   - What happens: the skill's own rule ("When `route` returns `backend: "claude"`, run that role with
     `Agent`… then `record_agent_run`") applies to any role, and `validate` allows a `claude:` reviewer rung.
     A profile that puts the reviewer on `claude:…` (a Claude-only user, or someone who prefers Opus for
     review) produces an `agents.jsonl` row with role reviewer and no dispatch record.
   - The effect: `land` refuses with E_LAND_GATE forever, and `Protocol next` stays at `M1: reviewer`
     forever. The only way out is `skip`, which is refused for code.
   - Why it matters: this is the "wrongly blocks" half of the focus. The spec's "a dispatch whose name starts
     reviewer-<M>" is silent on the native path, and a reasonable user expects their configured reviewer to
     count.
   - Fix: mirror `verifierPassed`. Also accept `readAgentRuns(run)` rows with `role === "reviewer"`,
     `reviewsMilestone(a.name, m)`, status ok and `since(a.at, start)`. Update the E_LAND_GATE text, the land
     description and the digest's reviewer pick to match. Add a test.

4. **The gate counts a verifier FAIL as a verdict.**
   - Files:
     - src/services/milestones.ts:54 (`verifierPassed`);
     - src/entry/mcp/run-tools.ts:101 (`record_agent_run` `status` defaults to `"ok"`);
     - plugin/skills/catherd/SKILL.md:237.
   - What happens: `status` in `record_agent_run` means the subagent ran, not that it passed. The skill says
     "After every Claude subagent returns, call `record_agent_run`…" and step 9 says "that row, status `ok`,
     is the milestone's verdict". Nowhere does it say to record a FAIL with `status: "failed"`.
   - The normal flow therefore records a FAIL as ok: the verifier says FAIL, the orchestrator reports the
     run as usual, and the gate then treats that FAIL as a pass. For a headless verifier (`claude-code:`
     rung), a dispatch record's `status: ok` only means the CLI exited cleanly.
   - Why it matters: the gate's job is to stop a milestone landing without a passing verifier. As written, it
     only checks that a verifier ran.
   - Fix, cheapest first:
     - Skill step 9 and the `record_agent_run` description: "pass `status: "failed"` when the verdict is
       FAIL; only a PASS is recorded ok".
     - For dispatch records, require the reply's first line to be `VERDICT: PASS` (the verifier's contract
       now guarantees that shape), or a `replyStatus` of complete.
     - Add a test: a verifier record whose reply starts `VERDICT: FAIL` does not open the gate.

5. **`skip` treats any nested `docs/` folder as docs, so code there lands without review.**
   - File: src/services/milestones.ts:100: ``DOC = /(^|\/)docs\/|…/``.
   - Reproduced:
     - `isDocPath("src/docs/handler.ts")` and `isDocPath("app/docs/page.tsx")` are both true, and
       `isSourcePath` is false for both.
     - So `skip: "docs-only"` and `skip: "no-code"` both accept a milestone that changed real code under
       any `…/docs/` folder (a Next.js `app/docs/` route, a Docusaurus `website/docs/*.tsx`, a `src/docs/`
       generator).
   - Why it matters: this is a bypass of the gate the plan's Review Focus 3 targets. Ruling 16 says "docs are
     `docs/` paths", meaning the repo's docs folder.
   - Fix: anchor the folder rule (`^docs\/`). A nested `docs/` counts only through the doc extensions. Add
     `app/docs/page.tsx` to the refusal test.

6. **Codex's `writable_roots` override replaces the user's own roots.**
   - File: src/adapters/codex/index.ts:42.
   - What happens: `-c sandbox_workspace_write.writable_roots=[locks, tmp]` sets that key. It does not
     append to what `~/.codex/config.toml` (or a `--profile`) lists. A user who added, say, `~/.cache/pip`
     or `~/.m2` to `writable_roots` loses those roots in every catherd worker, silently.
   - Why it matters: this breaks the owner's native-harness rule ("roles run in each vendor CLI exactly as the
     user configured it"). It narrows the user's sandbox where §5 only means to widen it. Neither the research
     note nor live-verification §4 mentions it.
   - Fix:
     - When the run is not isolated, read `writable_roots` from the Codex home's config.toml and pass the
       union.
     - Or, at minimum: state it in the research note, add a live-verification line (a root the user
       configured stays writable), and have doctor's `access:codex` row name the replacement.
   - Verify the replace semantics live. `-c` values are TOML values, and I know of no array merge in Codex.

7. **The Claude Code `--settings` merge is unverified, and nothing checks it.**
   - Files: docs/research/2026-09-28-worker-access.md:119 and docs/dev/live-verification.md §4.
   - What happens: the research note marks the `--settings` merge semantics **[unverified]** and says "the
     live check compares a worker's `/sandbox` view with and without catherd's flags". Section 4 of
     live-verification has only the Codex commands. Nothing tells the owner to check Claude Code.
   - Why it matters: `claudeAccessArgs` passes a `sandbox` object on every workspace-write headless run.
     - If Claude Code replaces the top-level `sandbox` object instead of deep-merging it, the user's
       `sandbox.enabled: true` (and their `allowedDomains`) is dropped for catherd's workers.
     - A user who turned the sandbox on would then get an unsandboxed Bash. That is the one path in this plan
       that could reach beyond the §5 intent.
     - The array case (their `allowWrite` replaced) is the milder version of the same unknown.
   - Fix, a docs-only fix before merge: add a Claude Code step to §4. With `sandbox.enabled: true` and a
     custom `allowWrite` and `allowedDomains` in the user settings, run `claude -p --settings '<catherd's
     JSON>' "/sandbox"` (or a Bash probe that writes outside the grants), and record whether the user's keys
     survive.
   - Defensive option: include `enabled: true` in the object only when `claudeSandboxOn()` says it is on.
     See also deferred minor B2-5: that check reads only `~/.claude/settings.json`.

### Minor (Nice to Have)

1. **A climb past the top rung leaves `Protocol next` at dispatch.**
   - File: src/services/protocol.ts:51 (`laneDone`); also the fix1 re-review's deferred line.
   - What happens: a climb past the top appends a route row, so the lane counts as "not done". `Protocol
     next` says `dispatch M1.L1` indefinitely, while `Next:` says "failed on its top rung: ask finding, then
     the architect or the report".
   - A session re-entering after compaction follows `Protocol next` (skill, Resume). It would dispatch the
     lane again at its top rung, which is the failure §10 exists to prevent. I triage this as **fix before
     merge**, below.
   - Fix: when the lane's latest route row is a climb whose `from === rung` (the top), return `M1: M1.L1 failed
     its top rung: ask finding, then the architect`, or skip the lane once its open outcome is recorded.
2. **`skip` accepts an empty commit range.**
   - File: src/services/milestones.ts:87.
   - What happens: `land(M2, commit: <M1's commit>, skip: "docs-only")` diffs a range with no files and lands
     M2 with no review. The M2 work may be uncommitted: the protocol says commit first, and this is exactly
     that slip.
   - This was deferred minor B3-3. I triage it as **fix before merge**: refuse an empty range with
     E_LAND_GATE ("commit the milestone first").
3. **The ownership regex's "owned by" also catches environment errors.**
   - File: src/services/lane-service.ts:123.
   - What happens: `owned by` also matches environment evidence such as "EACCES: /var/lib/x owned by root"
     or "port 5432 owned by pid 812". A `blocked` climb with that evidence (and `env` not passed) is refused
     as E_CLIMB_DESIGN.
   - Fix: narrow it to `owned by (lane |M\d+\.L\d+)` or `owned by another lane`.
4. **Dispatch routes before admission refuses.**
   - File: src/services/dispatch-service.ts:257.
   - What happens: the auto-route runs before admission's checks (budget, duplicate name, overlap). A dispatch
     that `admit` refuses (e.g. E_RUN_BUDGET) still spends up to 25 s on Jev and appends a route row.
   - This is harmless for correctness, since the route is recorded anyway. Consider moving the cheap
     refusals first, or accept it.
5. **`gate_pass` names HEAD for a pass on an uncommitted tree.**
   - File: src/services/gate-service.ts:`gatePass`.
   - What happens: `commit` is HEAD even when the hash covers uncommitted files. The verifier then reports
     "carried over from <HEAD>" for a pass that was on a later, uncommitted tree.
   - Consider recording `dirty: true`, or saying "from the tree after <HEAD>".
6. **A multi-line question breaks the status line.**
   - File: src/entry/runs-command.ts (`parked M: question`).
   - What happens: a multi-line `question` prints over several lines in `catherd status`. Use
     `cell()`-style flattening.
7. **A stale test title.**
   - File: test/entry/mcp.test.ts.
   - What happens: the test that pins the 25 tools is still titled "lists exactly the 1.0 tools".
8. **`no-code` accepts config-only milestones.**
   - What happens: a `no-code` skip accepts changes to Dockerfile, package.json, bun.lock and
     `.github/workflows/*.yml`, since none has a source extension. This is Ruling 16 and spec-sanctioned
     ("source roots"). Note it for the 1.2 per-repo config.
9. **The branch conflicts with plan 10's current head.**
   - What happens: replaying the branch onto plan 10's head (e5957c4, 5 bot-round commits past 546e5f8)
     conflicts in src/services/dispatch-service.ts. The conflict is only at the imports: plan 10's
     `claimRun, ownsRun` against plan 11's `readRoutes` and `route`.
   - Resolve by keeping both. `git merge-tree` shows no other conflict.

## Deferred minors from progress.md: triage

"Fix now" means before merge, in the final fix wave. "Fold" means cheap and recommended in the same wave, but not
blocking. "Defer" means record it in `docs/dev/ideas.md` or leave it.

| Source | Item | Verdict |
| --- | --- | --- |
| batch1 #1 | lock dir and docker socket not realpathed (macOS symlinks) | Fold. Same `realpathSync` fallback as `realTmpdir`; it matters when Claude's sandbox is on (Seatbelt compares real paths) |
| batch1 #2 | a non-unix `DOCKER_HOST` falls back to local sockets | Fold. Return null for `tcp://`/`ssh://`; do not grant a root-equivalent socket the user's docker client does not use |
| batch1 #3 | docstring and skill say "network and loopback", but Docker goes too | Fold (wording) |
| batch1 #4 | `profile show` padding | Defer |
| batch1 #5 | blank-line churn in backend.ts | Defer |
| batch1 #6 | `dockerSocket` fallback untested | Fold with #2 |
| batch1 #7 | `network` not nullable in the patch | Defer |
| batch2 #1, #2 | proxy 4xx, timeout message | Fixed in fix1 |
| batch2 #3 | lane header parsed twice | Defer |
| batch2 #4 | the header gate also applies to `ask finding` | Defer (add a comment) |
| batch2 #5 | `claudeSandboxOn` reads only `~/.claude/settings.json` | Fold. A sandbox enabled in settings.local.json or the project settings gives a false "ready"; ties into Important 7 |
| batch2 #6–#8 | isolated CODEX_HOME in the probes, probe runtime, curl vs fetch in the docs | Defer |
| batch3 #1, #6 | the reviewer-M10 prefix, `.txt` manifests | Fixed in fix1 |
| batch3 #2 | the first milestone's range is only its own commit | Defer to ideas.md (store the start HEAD in meta.json); sanctioned by Ruling 15 |
| batch3 #3 | empty range accepted by `skip` | **Fix now** (Minor 2 above) |
| batch3 #4 | route-if-unrouted race | Defer |
| batch3 #5 | caller rung vs routed start rung | Defer (predates this plan) |
| batch3 #7 | import order | Defer |
| batch4 #1, #2 | parked split-brain, a gate path that exists nowhere | Fixed in fix1 |
| batch4 #3 | staged rename drops out of the hash | Defer |
| batch4 #4 | Jev asked before the routed check | Fold. Move the `currentRoute` check before `refuseDesign` (saves a Jev call and a jev.jsonl row) |
| batch4 #5 | `answer` overwrites the next step | Defer (plan-mandated; `Protocol next` stays true) |
| batch4 #6 | misleading test name, and a trivial assertion | Fold (test-only) |
| batch4 #7, #8 | `./` refused, UTC time | Defer |
| batch5 #1 | digest reviewer without a `since(start)` filter | Fold (one filter; same code as Important 3) |
| batch5 #2–#5 | carried steps per milestone, `Date.now` vs `deps.now`, parked not in `Protocol next`, `k()` boundary | Defer |
| batch6 #1–#3 | shadowed `r`, double `readNotes`, comment wrap | Defer (cosmetic; the wrap is one line) |
| batch6 #4–#8 | skill rows and the peek-without-run test | Fixed in fix1 |
| fix1 re-review | a climb past the top rung leaves `Protocol next` at dispatch | **Fix now** (Minor 1 above) |
| fix1 re-review | re-route after a run sends the lane back to dispatch | Defer (unusual) |
| fix1 re-review | `laneDone` re-reads records per lane | Defer (cost only) |

## Recommendations

- One fix wave carries Importants 1–7 and the two "fix now" minors. Each is small, and none changes a tool's
  shape.
  - Importants 3 and 4 are gate logic, plus one line in the skill and the tool description.
  - Important 5 is one regex.
  - Importants 1 and 2 are doctor-access.ts.
  - Importants 6 and 7 are a small Codex union, or a doc line and a live-verification step.
- Put a `CATHERD_PROBE_URL=http://127.0.0.1:9/` default in the shared test helper, so a doctor call anywhere
  in the suite cannot reach the registry.
- Carry Importants 6 and 7 into the owner's live verification (plan 12 §8 points at §4).

## Declined to judge

- Live Codex behaviour:
  - whether `codex sandbox -c sandbox_mode=workspace-write … -- cmd` selects the workspace-write policy on
    the current CLI;
  - whether Landlock and seccomp with `network_access=true` let an AF_UNIX connect reach the Docker socket
    on Linux;
  - whether `-c` replaces or merges `writable_roots` (raised as Important 6 on the TOML semantics; live
    confirmation is out of reach).
- Live Claude Code behaviour: how `--settings` merges with the user's settings (raised as Important 7 only
  for the missing check), and whether `excludedCommands: ["docker *"]` matches compound commands such as
  `docker ps && curl …`, which would run the whole line unsandboxed.
- Live opencode behaviour: the unsandboxed shell is assumed from the 2026-09-25 research.
- macOS: Seatbelt's real-path comparison, the `/var/folders` → `/private/var/folders` realpath, the
  OrbStack, Docker Desktop and Colima socket paths, and `--safe-mode` interplay with `--settings`.
- Whether Bun's fetch honours `HTTPS_PROXY` inside the Codex sandbox, and whether the proxy is reachable from
  there.
- Whether a native verifier subagent actually sees the catherd MCP tools (`gate_check`, `gate_pass`) under
  their plugin names, and whether users' existing verifier agent files are regenerated on upgrade so they
  pick up the new prompt. This is plan 12's release concern.
- Docker access as a sandbox escape. Talking to a Docker socket, and `excludedCommands: ["docker *"]`, is
  root-equivalent by nature. Spec §5 asks for it, so I did not grade it as a widening.
- Pre-existing flaky tests that fail on base 546e5f8 too, in this sandbox:
  - "doctor > fails on a credentials file others can read" (a 5 s timeout);
  - "catherd status and watch --once > prints the run with a live role", where `running 0s` against `1s`
    is a wall-clock race between two CLI spawns. It should be fixed in its own task, since it breaks
    CLAUDE.md's rule against depending on the wall clock.
- README and MIGRATION 1.1 sections, the changelog, and the runs page's digest view: plan 12 (Ruling P7 and the
  plan's "Not in this plan").
- The spec's own choice that a reviewer record needs only `status ok` (not "no BLOCKER"): accepted as
  written.

## Assessment

**Ready to merge?** With fixes

**Reasoning:** The plan is complete and well built. Its tests are real, it integrates cleanly with plan 10,
it keeps 25 tools and the layer rule, and it validates every new path-shaped input. Seven Importants remain. Five are on the land gate and doctor:
- the gate wrongly blocks a native `claude:` reviewer forever;
- it lets a verifier FAIL through;
- it lets code under a nested `docs/` folder through `skip`;
- doctor probes (and in tests, reaches the network for) backends that are not installed;
- doctor's failure reasons are the wrong line in the two common real failures.

Two are on the widened sandbox:
- Codex's `writable_roots` override replaces the user's roots;
- Claude's `--settings` merge needs the live step the research note promised.

Two deferred minors (a climb past the top rung, an empty `skip` range) are worth fixing in the same wave.
