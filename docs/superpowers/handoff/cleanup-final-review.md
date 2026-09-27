# Final whole-branch review: pre-1.0 cleanup (47vigen/catherd#12)

Range: d87a791 (main) .. a6f25a0 (HEAD), 36 commits, 158 files (127 under src/ and test/).
Reviewer passes: src/test diff in full; secret and file-mode paths; CLI run by hand in a throwaway
`CATHERD_HOME` with `ANTHROPIC_API_KEY=` empty; doc links and claims; package and plugin; full gate in a
separate worktree (`/tmp/review-cl` at a6f25a0).

## Gate (separate worktree, a6f25a0)

`bun install --frozen-lockfile`, `typecheck`, `lint`, `format:check` all clean; `bun test`: 1085 pass,
10 skip, 0 fail (1095 tests, 107 files). `bun test/pack-smoke.ts` also passes: the tarball has the right
files and no tests, docs or CI files; the installed `catherd --version`, `doctor --json` and MCP
`tools/list` all work.

## Strengths

- **B1 is closed at the root.** `readJsonFile` (src/infra/store.ts:88-103) never passes on the parser's
  message, and every stored JSON file goes through it (`readVersioned` and `readV1` in profile-store.ts).
  The other `JSON.parse` sites on stored files (setup.ts `isLegacy`, doctor-checks.ts plugin read,
  dispatches.ts `readJson`, reconcile.ts, filelock.ts `readHolder`) all swallow the error without quoting.
  zod 4's `prettifyError` does not echo input values, and the credentials schema is loose, so a key pasted
  as a JSON key is not echoed either. The credentials fix now names a way out that works
  (`delete … and run catherd init, or write it as {...}`).
- **One secret rule, at least as strict as each old copy.** domain/secrets.ts matches credential env names
  anywhere in the name (the old log rule matched only the suffix), adds key shapes to the log (the log had
  none before), lowers the fixture `sk-` bar from 20 to 16 characters, lowers Jev's Bearer bar from 16 to
  10, and makes the fixture Bearer match case-insensitive. The `key = value` rule stays in Jev only, with
  the reason written down. `secrets.test.ts` covers it.
- **Modes are applied everywhere catherd writes**: `writeTextAtomic` defaults to 0600, and appends, `wx`
  creates, the supervisor's stdout/stderr, the claim and cancel files, supervisor.log, the ledger and
  knowledge.md all pass `PRIVATE_FILE`. Dirs are made through `ensurePrivateDir`. Files other programs
  read still work: agent files are 0600 but owned by the user, and the links in `~/.claude/agents` are
  made with the default mode. Capture fixtures keep the default umask (meta.json is explicitly 0644).
  codex's own reply.md is tightened with `makePrivate`. Checked by hand: config/, data/ and everything in
  them came out 700 and 600.
- **The batch C splits change no behaviour.** I compared the sorted, import-stripped bodies of
  doctor → doctor/doctor-checks/doctor-backends, profile-service → profile-service/profile-store/
  agent-links, and profile-tree → profile-tree/profile-edits. The only differences are the try/catch →
  `tryParseRung` rewrites, the `backendOf` helper, the removed dead `relink`/`countLinkedAgents`, and
  comments. The median merge keeps each caller's result: `harnessCosts` rounds through `tokenMedian`, and
  `measuredSecs` stays unrounded. The run slug keeps its 40-character cap and "run" fallback.
- **Lazy loading holds (spec §3.1).** I walked the static imports of `mcp/command.ts`, `lock-command.ts`,
  `supervise-command.ts`, `supervise-bin.ts` and `cli.ts`: none reaches `entry/tui/`, `@opentui/*` or
  `react`. `glyphs.ts` was moved out of `tui/theme.ts` so that CLI commands no longer pull in the theme.
  The architecture test now also checks that `src/` holds only the five layers plus `cli.ts`.
- **The CLI matches spec §8.** Exit codes checked by hand:
  - exit 2: `--bogus`, `nope`, `watch --interval x`, `lock` with no command, `runs show` with no id, and
    a dashboard with no terminal.
  - exit 3: `doctor` when not ready.
  - every other case exits 0.

  Every read command lists `--json`. `lock --help` shows the real usage line. Piped help has no ANSI.
- **Doctor's fix commands work.** In a fresh home I ran exactly what doctor printed, in order:
  1. `profile set roles.worker.defaultRung null`
  2. `profile set roles.<role>.rungs claude-code:…` for all five roles
  3. `profile set roles.artist.enabled false`
  4. `profile use default`

  Each one ran. The codex row then turned into "no profile uses it", the agents row read "2 linked", and
  only the plugin row, which is outside catherd, was still ✗.
- **Docs are in order.** Markdown files outside docs/superpowers and docs/archive have no broken relative
  links. README's command table, env-var table (checked against every `process.env.*` in src), exit
  codes, `--plain` and `NO_COLOR` claims all match the code. The plugin skill's tool table matches the 20
  registered MCP tools, including the corrected `runs_summary(run?, repo?, role?, since_days?)`
  signature.

## Issues

### Critical

None.

### Important

1. **SECURITY.md:57-59 understates the log redaction rule, and a security policy should not get this
   wrong.** It says the log redacts env vars "whose name ends in `_KEY`, `_TOKEN`, `_SECRET` or
   `_PASSWORD`". Since ccc302a the rule is domain/secrets.ts:5 (`KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL`
   anywhere in the name). Every row also has key-shaped strings (private-key blocks, `sk-`, `sk-ant-`,
   GitHub, AWS and Slack tokens, `Bearer …`, and a URL's password) replaced. Batch A updated only the
   modes table. The capture-fixtures bullet is accurate but vague.
   *Fix:* reword the first bullet to something like: "the value of any environment variable whose name
   contains KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL (8+ characters), the saved Jev key, and anything
   shaped like a key (private-key blocks, `sk-…`, GitHub/AWS/Slack tokens, `Bearer …`, a URL's password)
   become `[redacted]`". Point both bullets at the same rule.

### Minor

1. **src/cli.ts:3**: `errorMessage` is imported statically before the Bun-version refusal, whose comment
   says "before anything else loads". `errors.ts` is also imported dynamically at line 18. It is harmless,
   since errors.ts has no imports and uses plain syntax, but it contradicts the comment. *Fix:* take
   `errorMessage` from the existing dynamic `import("./domain/errors.ts")` on line 18.
2. **Unknown options are refused only on a bare `catherd`, and there too strictly** (src/cli.ts:128).
   - `catherd status --bogus` still exits 0 silently, because citty ignores unknown flags.
   - On the bare command, `catherd --no-plain` is refused as unknown even though citty accepts it as the
     negated boolean, because the check matches only literal key names.

   *Fix (1.0.x):* accept `no-<boolean>` in the bare check. Refusing unknown options on subcommands can wait
   for 1.1; log it as a deferred minor.
3. **src/entry/tui/run.tsx:45**: the no-terminal refusal's `fix:` line is prose ("in a script, run
   catherd status, catherd doctor or catherd watch --once"), not the single exact command that spec §8 and
   the rest of the CLI give. *Fix:* `fix: catherd status` (or `catherd watch --once`).
4. **Doctor's codex fix is long prose with several commands in it** (src/services/doctor-backends.ts:70-80).
   It works, but after it is followed the profile row warns for each stranded `failover.codex:…` entry,
   and its fix (`catherd profile validate default`) only lists them again. *Fix:* give the "on no enabled
   role's ladder" warning (src/domain/profile-rules.ts:202) the fix
   `catherd profile set failover.<rung> null`. I checked that this command works.
5. **CONTRIBUTING.md:62** says "Each CLI subcommand lives in `src/entry/<name>-command.ts`", but
   `status` and `watch` live in `runs-command.ts`. *Fix:* "…in `src/entry/<name>-command.ts`
   (`status` and `watch` with `runs`; the MCP server's in `src/entry/mcp/command.ts`)".
6. **.changeset/catherd-1-0.md** is the 1.0 changelog text, and it says nothing about two changes 0.x
   users will notice: config and data are now private (folders 0700, files 0600, an older 0755 root is
   tightened), and a bare `catherd` refuses unknown options. *Fix:* add one bullet.
7. **Log redaction can over-match (src/domain/secrets.ts:5).** With the name rule matching anywhere, a
   non-secret 8+ character value such as `PASSWORD_STORE_DIR=/home/u/.password-store` or a `*KEY*_DIR`
   path is blanked everywhere it appears in a log row. It fails safe and was already the fixture rule, so
   no change is needed; if it proves noisy, exempt values that are existing absolute paths.
8. **src/services/lane-service.ts:31 and src/services/setup.ts:9** add the `../infra/store.ts` import
   after the `./…` imports, unlike the rest of the file. This is cosmetic.

## Declined to judge

- The plugin on main pins `catherd-cli@0.2.1` while its skill describes 1.0: a known ledger risk that the
  held release PR #11 resolves when it stamps the version. That is release sequencing, not this PR.
- Versions still 0.2.1 in package.json, plugin.json and .mcp.json: bumped by the Changesets release PR,
  by design.
- `nonBlankLines` returning `[]` on any read error (summary used to throw on EACCES): a recorded, reasoned
  deviation in progress.md. Summary reads are advisory, so I accept it.
- Batch B's change to `NO_COLOR` (it now drops colour only, never glyphs): spec §9.3/§583 is ambiguous, and
  README/help now describe the new behaviour consistently.
- Stale 0.x code paths in docs/research/*.md (`src/core/…`, `docs/ideas.md`): these are dated research
  records of the 0.x tree, which batch D chose to leave as history.
- Relative links inside docs/superpowers/plans (paths in code blocks, sibling-relative references):
  historical plan records, outside the link check the brief asked for.
- Plan 8 anchors after the doctor, profile-service and capture-fixtures splits: the ledger already rules a
  fresh re-check before plan 8 runs, and plan 8 is not executed here.
- The `UPGRADE` fix string is two alternatives rather than one command: it is the audit N12 wording, and
  plugin users upgrade through the plugin anyway.
- Deferred minors in docs/superpowers/handoff/plan7-final-review.md: excluded by the brief.
- Whether GitHub private vulnerability reporting is enabled (SECURITY.md depends on it): an owner action
  already logged in progress.md, and I cannot check it from here.
- Live backends (Codex, opencode, a real Jev key, the plugin inside Claude Code): cannot be exercised in
  this container. Covered by docs/dev/live-verification.md and the owner's held verification.

## Verdict

**Ready to merge after fixes.** Fix Important 1 (the SECURITY.md redaction wording, a doc-only change of a
few lines) before 1.0 is published. The Minors can go in the same commit or wait for 1.0.x. None of them
blocks the merge.
