# Final whole-branch review: plan 12 (catherd 1.1), 3cea949..21862d5

Reviewer: final code review (superpowers `requesting-code-review/code-reviewer.md`), read-only. I did it in passes
without subagents: spec §2 and §11–§15, the plan's Global Constraints, Review Focus and Rulings, the ledger and the
preflight, then the diff by area (failover and validate; launcher, stamp and marketplace; handshake and doctor; init
and global install; runs-page digest and TUI; README, MIGRATION, live-verification and the changeset). I checked out
21862d5 into a scratch worktree, and 3cea949 plus two intermediate commits into others, to run the gate and to
bisect. I never moved this checkout's HEAD. Note: this checkout moved on its own during the review (5a77003 and then
0556b69, plan 11's Codex rounds); that was not me.

## Gate evidence (21862d5, scratch worktree, Linux container, Bun 1.4.2)

- `bun install --frozen-lockfile`, `typecheck`, `lint`, `format:check`: clean.
- `bun test`: 1425 pass, 10 skip, 3 fail. The three failures are all 5 s default timeouts:
  - `doctor > tests a Jev key…`
  - `doctor > fails on an old Bun…`
  - `catherd doctor > keeps init's glyphs under NO_COLOR…`

  **They are not plan 12's.** The same three fail at 3cea949 in the same container (a true 3cea949 worktree, same
  timings). Each doctor run there takes about 2.3 s, most of it in `backendChecks` and plan 11's `accessChecks`
  (about 1.1 s each), so a test that runs doctor three times goes past 5 s. The controller's machine passes them
  (1428 × 3). This belongs to plan 11 or main (see Minor 7).
- The architecture/layer test passes. `src/domain/failover.ts` imports only domain modules, and
  `src/services/global-install.ts` imports only domain and infra.

## Strengths

- **The failover defaults are derived, not hand-picked.** `rankStandIns` states every exclusion in one place (same
  quota, native `claude:`, unscored, metered tier 1, a downgrade on a bar dim), and Claude-billed rungs sort last.
  `DEFAULT_FAILOVER` is pinned by a test that re-derives it from the shipped catalog. The two remaining defaults are
  both OpenCode Go (a subscription). None bills Claude and none downgrades. Sol high and xhigh get no stand-in, as
  the spec says ("a rung with no such stand-in has none").
  - I checked the runtime path. `standInFor` (`src/services/backends.ts:37-44`) uses the profile's map, then the
    opencode adapter's Go→Zen rule. That rule applies only to `opencode-go/` rungs, so a Codex Sol rung with no entry
    pauses (`dispatch-service.ts:495`).
- **Every §11 rule warns and none errors.** A 1.0 map with Sol high/xhigh → Kimi gives exactly two
  `downgrade: … scoring below it on repo_code` warnings. I benchmarked it: about 3 ms per validate, or 9 ms with an
  opencode listing.
- **The launcher is tight POSIX sh.**
  - It is quoted throughout and `exec`s in every branch.
  - It runs through `sh ${CLAUDE_PLUGIN_ROOT}/…`, so it does not depend on the exec bit.
  - It exits cleanly with a message when HOME and XDG are unset or `mkdir` fails.
  - It drops a stray `CATHERD_USER_TMPDIR` in the global branch.
  - The tests run the real script against fake `catherd`/`bunx` for every branch, including one where `--version`
    fails.
  - I verified in Bun 1.4.2 that `os.tmpdir()` sees the `process.env.TMPDIR` that `restoreTmpdir` puts back.
    `Bun.spawn` without an `env` does not (it uses the startup environment). Every `Bun.spawn` in `src` passes an
    explicit env built from `process.env`, except the `sh read/kill` watchdog, where TMPDIR does not matter. So
    workers really do get the user's TMPDIR back.
- **An existing install keeps working.**
  - A 1.0 plugin keeps its own `.mcp.json` (`bunx catherd-cli@1.0.0 mcp`).
  - A 1.1 plugin with a global catherd at another version falls back to bunx at the stamped version.
  - A `catherd` on PATH that is broken or does not answer `--version` also falls back to bunx.
  - `init`'s global step catches every failure (`ensureGlobal` and `realGlobalInstall.install` both `.catch`).
  - When the installed version is shadowed on PATH, `init` says so with a fix.
  - `--no-global` never probes.
- **The `mcp` row is useful.** It shows the stderr tail, `broken install` / `missing` with `reinstall: bun add -g
  catherd-cli@<v>` as a copyable fix, and a 60 s budget for a cold bunx. Plan 10's scrubbed `handshakeEnv` is kept
  (R2).
- **Info rows (R3/R4).** `info` never touches `ready` and never counts as a warning. The changed/shipped split is per
  role and per backend, so the verifier moved to another backend still warns. Tests pin the row order and the JSON
  round-trip.
- **The digest view is well built.**
  - `milestoneDetail` now accepts any id that `land` accepts (`ID_PATTERN`, no `..`) and checks membership through
    `milestonesOf`, which is still path-safe.
  - An empty file counts as no digest, the bullets wrap with a hanging indent, and esc returns to the row.
- **Fix round 1 closed every Important from batches 3 and 4.** I re-verified these against the code:
  - `.secs`
  - `roles/*/*/events.jsonl`
  - the routed-lane jq (`source == "route"`, `src/domain/route.ts:35`)
  - `runs show --json` `.records[]` (`runs-command.ts:212-217`)
  - the `profile new/use --repo/--clear/rm` commands
  - the data dir under `~/.local/share/catherd` on macOS too (`paths.ts`)
  - the changesets branch `changeset-release/main` (release.yml does not override it)
  - the `bun pm pack` file name (`catherd-cli-<v>.tgz`, checked)
- **The changeset and MIGRATION cover all of 1.1.** I checked each spec §2 item from 1 to 11 against both, and every
  one is there. That includes plan 10's push/peek/result/sessions/env scrubbing and plan 11's access, protocol,
  gate ledger, park/answer, climb and digest.

## Issues

### Critical (Must Fix)

None.

### Important (Should Fix)

1. **`docs/dev/live-verification.md:306`: the acceptance install command fails.**
   - What is wrong: `bun add -g "./catherd-cli-$version.tgz"` fails on Bun 1.4.2. I checked with a throwaway package
     and `BUN_INSTALL` in scratch: `error: ENOENT extracting tarball from ./tiny-cli-x-1.1.0.tgz / Invalid dependency
     name`. `bun add -g` resolves a relative path against the global folder, not the cwd. The same command with an
     absolute path works and links the bin.
   - Why it matters: this is the owner's first acceptance command, and "must work exactly as written" is the review
     focus. Everything after it depends on it.
   - Fix: `bun add -g "$PWD/catherd-cli-$version.tgz"`.

2. **`docs/dev/live-verification.md:297-333` (§9): the release candidate is installed, but `catherd init` is never
   run.**
   - What is wrong: native Claude agent files are rendered per profile with the role prompts and `VERSION`
     (`agent-links.ts:47-56`, `agentFiles(getProfile(name), VERSION)`). Only `init` or a profile write rewrites them.
     1.1 changed the role prompts: `src/domain/role-prompts.ts`, +33 lines since main 9707a70 (the gate ledger, the
     verifier steps, the reply contract).
   - Run 1 is fine, because `profile new acceptance` renders fresh files. Run 2, the real run on the owner's existing
     profile, would use the 1.0-rendered agents. The verifier would get the 1.0 prompt, which has no `gate_check`
     and no side-by-side items. That is exactly the number the run exists to compare ("verifier ~85 min"), and
     `doctor` would show the agents as stale.
   - Fix: after `catherd --version`, add `catherd init --no-input` and say it refreshes the agent files. `init` finds
     the tgz version already global and skips the install. Also tell the owner to start new sessions afterwards.
     MIGRATION already says to upgrade through `init`, so this is only a §9 gap.

3. **`test/entry/mcp-handshake.test.ts:17-24`: a real MCP server runs on the developer's real catherd data.**
   - What is wrong: the test sets only `PATH` and `ANTHROPIC_API_KEY`. `mcpHandshake()` then spawns the real
     `catherd mcp` (through the launcher and `test/bin/catherd`) with `handshakeEnv(process.env)`, so it gets the
     real `HOME`/`CATHERD_HOME`. `startMcpServer` runs `reconcileAll` over every run in the user's
     `~/.local/share/catherd`, starts the notifier scan and writes logs there.
   - Why it matters: every other stdio test isolates the server (`test/integration/mcp-stdio.test.ts:36-48` sets
     `CATHERD_HOME` and `XDG_CONFIG_HOME`, and doctor-command's `machine()` uses `withHome()`). This one can reconcile
     a maintainer's live runs, possibly runs another session owns, every time the suite runs.
   - Fix: call `withHome()` (or set `CATHERD_HOME`, `XDG_CONFIG_HOME` and `CLAUDE_CONFIG_DIR` to a temp dir) before
     the handshake in that test.

### Minor (Nice to Have)

1. **`src/domain/profile-rules.ts:216`: an unscored stand-in is reported twice** (batch 1 m1, still open). It gets the
   error "stand-in X is unscored" and also `downgrade: … on <every bar dim>`, because a missing score counts as
   below. Fix: skip `downgradeDims` when `valuesOf(c, to)` is null. It is a one-line fix plus a test, and users see
   the noise.
2. **`src/services/global-install.ts:42-46`: `bun add -g` has no time limit.** A registry that is down fails fast (a
   `!` line, as Review Focus 5 expects). A blackholed or proxied one can leave `init` sitting after "installing
   catherd…" for as long as Bun's own retries last. Consider a kill after about 120 s, reported as `failed` with the
   retry command.
3. **The spawned init test would run a real `bun add -g` if the shim ever missed.**
   - Where: `test/entry/init-command.test.ts:18-25`, which spawns with `...process.env`, `BUN_INSTALL` included.
   - The risk: the test asserts afterwards that no "installing" line printed, so the damage (a real global install,
     over the network) would come before the failure.
   - Fix: set `BUN_INSTALL` to a temp dir and `BUN_CONFIG_REGISTRY=http://127.0.0.1:9` in that env. A regression
     then fails fast and touches nothing.
4. **`docs/dev/live-verification.md:366`: the count is wrong.** The text says "names three dispatch folders", but a
   reviewer or verifier that runs `bun test` adds folders. Say "at least one folder per worker lane (three)".
5. **`docs/dev/live-verification.md:329-334`: the clean-up block assumes the same shell.** It uses `$version` from a
   shell opened much earlier. Re-derive it with `version="$(jq -r .version ~/catherd-rc/package.json)"`.
6. **`src/entry/tui/views/runs.tsx:274-278`: an open (not landed) milestone row shows only "not landed".** It lost
   the `what` text it showed before plan 12. Consider `not landed · <what>`.
7. **Plan 11 or main: doctor tests time out in slower environments** (see Gate evidence; this predates plan 12). The
   three tests that run doctor two or three times keep the 5 s default. Their neighbour already has `30_000` with a
   comment about slow macOS runners. Give them the same, or make the probe cost smaller in tests.
8. **The stderr tail of a failed handshake can come up short** (batch 2 m7, still open; `handshake.ts` catch path).
   The close can win the race against the last stderr chunk, so a `Cannot find module` failure can show as "no
   answer". It is rare, and the fix is to wait briefly for the stderr stream to end.

## Triage of the deferred minors

| Source | Item | Status | Verdict |
| --- | --- | --- | --- |
| batch1 m1 | unscored stand-in: error plus downgrade noise | open | **fix now** (Minor 1: cheap and visible to users) |
| batch1 m2 | `valuesOf` exported but unused outside | open | leave (it is the brief's interface) |
| batch1 m3 | no direct `ladderDropDims` unit tests | open | defer (covered through `validateProfile`) |
| batch1 m4 | long comment line in profile-rules / live-verification | open | defer (cosmetic; oxfmt accepts it) |
| batch1 m5 | `barDims` recomputed per candidate | open | defer (measured 3–9 ms per validate) |
| batch2 m1 | globalStep claims "without bunx" without checking PATH | fixed (`shadowed`) | — |
| batch2 m2 | `installedVersion` reads stderr | fixed (stdout only) | — |
| batch2 m3 | `install` has no `.catch` | fixed (two layers) | — |
| batch2 m4 | launcher: HOME unset / mkdir fails | fixed, tested | — |
| batch2 m5 | stray `CATHERD_USER_TMPDIR` | fixed, tested | — |
| batch2 m6 | the `bunx` row is imprecise | open | defer (Ruling 16; the `mcp` row covers it) |
| batch2 m7 | stderr race on close | open | defer (Minor 8) |
| batch2 m8 | type-only cycle doctor ↔ doctor-checks | open | defer |
| batch2 m9 | constant-path test adds little | open | defer |
| batch2 m10 | no test for a failing `--version` | fixed (test added) | — |
| batch3 m1–m6 | stale `@1.1.0`, push id, `! not confirmed`, "every linked profile", wallMinutes timing, milestone-message wording | all fixed | — |
| batch3 m7 | README long line | open | defer (cosmetic) |
| batch4 m1 | session cursor starts on a milestone; many landed milestones push roles down | open | defer (UX; follows the brief) |
| batch4 m2 | hanging indent | fixed | — |
| batch4 m3 | empty digest file | fixed | — |
| batch4 m4, m5 | changeset wording, milestone message | fixed | — |
| batch4 m6 | `milestoneAt` rebuilds a list on every key | open | defer |
| progress.md | "Check in batch3: MIGRATION names the 1.0 Sol high/xhigh downgrade warnings" | done (MIGRATION "Failover and validation") | — |

Must fix before merge: none of the deferred minors. Batch 1 m1 is recommended for the fix wave because it is one
line.

## Recommendations

- **Replay onto main.** Plan 11 gained 13 commits after 3cea949 (on this checkout: 4e243bb … e43482c). Two touch what
  plan 12 documents or reads:
  - `6bf8a0d` changes how milestone names end, which `milestonesOf` and therefore `milestoneDetail` depend on.
  - `f4f3da0` gives `gate_check` an optional `milestone` argument.

  After the rebase, rerun `test/services/runs-page.test.ts` and the runs TUI tests, and reread MIGRATION's
  `gate_check` bullet and the changeset against the rebased tree.
- **R11 is an owner decision that the PR must name.** With the new defaults, Sol high and xhigh pause on a usage
  limit instead of falling back to Kimi K3. The spec implies this, but the owner feels it on a real run.
- `doctor`'s `mcp` row runs the package's own launcher, not the installed plugin's (whose version the `plugin` row
  checks). That is right for "the way the plugin does". On a dev checkout (§7's `bun src/cli.ts doctor`), though, it
  tests whichever global `catherd` matches the checkout's stamped version, which may be the published one (Ruling 14
  names this cost). Worth one sentence in §7.

## Declined to judge

- A live Claude Code / Desktop plugin install from the HTTPS `git-subdir` source and from a local marketplace with
  `"source": "./plugin"`: needs a real Claude Code. Owner acceptance §9.
- Whether `claude -p` stays alive to receive peer-inbox notices after the orchestrator ends its turn (§9 run 1,
  criterion 1): live Claude Code behaviour, plan 10's area.
- macOS itself: whether TMPDIR cleaning spares `~/.cache/catherd/bunx`; OrbStack/Docker probe results; `mktemp -d`
  under `/var/folders`, which is realpath'd.
- Live backends (Codex, opencode, headless claude-code) and the live network probes.
- `bunx` really honouring TMPDIR for its package folder on macOS: the plan's "verified facts" say so; I cannot
  reproduce it here.
- Whether `claude plugin update catherd@catherd` exists in the owner's Claude Code version. The command predates plan
  12 (`doctor-checks.ts:27`).
- Behaviour that predates plan 12: the opencode adapter's implicit Go→Zen failover (`opencode/index.ts:277`), which
  can spend metered Zen when a Go stand-in hits its own limit (1.0 spec §4.5). Plan 12 did not touch it; worth an
  `ideas.md` line.
- pack-smoke (real registry): not run here.
- Windows (the launcher is POSIX sh): not a supported platform.

## Assessment

**Ready to merge: With fixes**

**Reasoning:** The code meets spec §11–§13 and keeps every existing install working, and the changeset and
MIGRATION cover all of 1.1. The owner's §9 acceptance, though, has one command that fails as written and one missing
`catherd init`. Without that `init`, run 2 measures the 1.0 verifier prompt. One new test also runs a real MCP server
on the developer's own catherd data. All three are small fixes.
