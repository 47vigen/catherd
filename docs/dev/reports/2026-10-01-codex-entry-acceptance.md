# Codex entry packaged acceptance — 2026-10-01

Release status: **held for owner packaged acceptance**.

This report records actual packaged evidence separately from research, simulations and scoped source tests. Plan18/19 source at b14c5e6 is personally verified; handoff9fda729 records311 passing scoped tests. Plan20 implementation is frozen at09f9561. The controller personally reviewed both shared skills, the implementation diffs and the final installed copies. No native conversation processing is established by the no-model checks below.

## Package and native identity

- Feature source:09f9561; native packaging1d6d140, optional-Claude probe fix5b5d756, portable docs345d257/80d9483 and existing-assertion correction09f9561.
- Package version:1.3.0 (unreleased feature; version alone cannot identify this build).
- Actual tarball SHA-256:`93aa951f43dd6b9e4b0ea2d041d0df34fc1734cfcbe4e395d25b8a32f74bb44e`. Both tracked offline pack smoke and the controller's original-provider-PATH replay produced this same package fingerprint.
- Retained tarball:`/var/folders/p6/f8p6x5lj3gj1qgxnmdfxmt2m0000gp/T/catherd-pack-wUVWOd/catherd-cli-1.3.0.tgz`.
- Actual installed core:`/private/var/folders/p6/f8p6x5lj3gj1qgxnmdfxmt2m0000gp/T/catherd-pack-wUVWOd/app/node_modules/catherd-cli/src/cli.ts`; CLI file SHA-256:`c3ecc7dd9c550ae55e5220f29e6ee5b191a305e883c39f540456a331d6db4145`. The tarball fingerprints all modules; this file hash alone does not.
- Installed native plugin root:`/private/var/folders/p6/f8p6x5lj3gj1qgxnmdfxmt2m0000gp/T/catherd actual packaged root with spaces F54Qpp/native config/plugins/cache/catherd-controller-package/catherd/1.3.0`. Native MCP resolved `sh`, `args:["./bin/catherd-mcp"]`, this root as cwd and only the Codex launcher discriminator. The resolved launcher matches the packaged shared launcher hash`111b4041f35fec83da2c6ad48f93bc859147bf0a924c86215d2c72943741eefd`.
- Installed skill SHA-256: catherd`f37dc293e9eb06cc51b52c1a849fce0ac71fdb6e4059f3f35eaa11c883bc3edf`; catherd-setup`8ac5e1feac1983bb9fda62ced65f3995c858e7a6923d74bd77decf12a1ebf1c9`. Both installed files exactly match the source files read end to end by the controller.
- Actual installed native CLI:`/opt/homebrew/bin/codex`, version0.159.2. Desktop/daemon versions were not reconfirmed through a packaged live turn; earlier research observed CLI0.159.2/daemon0.159.3 and is not acceptance.
- Actual no-model MCP client:`catherd-packaged-controller`; host resolved from the installed launcher as codex, conflict null, session null. Real HOME/CODEX_HOME/configuration/credentials were preserved for MCP/setup/doctor, while CATHERD_HOME was temporary. Parser installation alone used temporary native HOME/config. No native client/thread identity was forged.
- Actual scratch run:`20261001-163052-no-model-packaged-acceptance`; durable owner/origin null, no dispatch/event/receipt/native continuation or collection claim. Rejected native accounting left zero agent records (the JSONL schema header is not a record).

## Required case ledger

| Case | State | Evidence |
| --- | --- | --- |
| Native plugin root with spaces and initialized tools | passed | Actual tarball installed via native marketplace/plugin commands; resolved shared launcher and generic no-model initialize/tools-list:26 tools. No unresolved macro. |
| Shared pinned version and global mismatch fallback | passed | Tarball inventories both declarations/skills; shared stamp/pin regression tests and fake mismatching global CLI prove exact pinned fallback without a registry request. Actual controller launch uses the fingerprinted installed core first on PATH. |
| Codex CLI idle original-owner wake and explicit collection | unverified | Actual packaged role and native continuation required |
| Codex Desktop idle original-owner wake and explicit collection | unverified | Actual installed tools and native continuation required |
| Codex CLI busy ordered follow-up | unverified | Active native barrier before role completion required |
| Codex Desktop busy ordered follow-up | unverified | Active native barrier before role completion required |
| Codex-only exact high/low routes and zero Claude writes | passed | Actual packaged profile_get/profile_set/run_start/route; architect exact SOL high, verifier exact SOL low; terminal init exited0. Recursive real ~/.claude inventory plus ~/.claude.json:25941 entries, zero creates/edits/pruning. No role model turn is claimed. |
| Explicit headless Claude from Codex and missing CLI/login | unverified | Actual packaged entry required |
| Native Claude and native failover reject from Codex | unverified | Actual packaged record_agent_run refused E_CONFIG_INVALID and wrote no agent record. Explicit native role/profile/failover dispatch in an installed native conversation remains untested. |
| Unknown/conflicting identity does not claim/send | unverified | Actual packaged entry required |
| Terminal host setup invents no session | passed | Actual packaged init --host codex --no-input --no-global exited0; doctor --host codex --test-push --json reported no-session/unconfirmed; durable scratch owner/origin null. No live smoke was sent. |
| Existing Claude plugin, native accounting and collection | unverified | Actual Claude host required |
| Claude peer priority and post-clear registry target | unverified | Actual Claude host and clear transition required |
| Packaged cross-host owner transfer during send barrier | unverified | Real run origin/journal and immutable receipt required |
| Concurrent MCP claims/coalescing and duplicate input | unverified | Actual packaged entry required |
| Startup/restart/unloaded/interrupted retained input | unverified | Durable unread and honest receipt status required |
| Unavailable/refused/timeout/missing receipt recovery | unverified | Packaged controlled failure fixtures required |
| Default doctor sends nothing; explicit smoke separates processing | unverified | Actual no-send pack doctor passed and terminal explicit smoke returned no-session/unconfirmed. Validated native-owner smoke and observed processing remain untested. |
| Landing refuses without real verifier verdict | unverified | Actual packaged scratch run without either reviewer or verifier refused E_LAND_GATE. An installed native milestone with independent real role records and verifier verdict remains required. |
| Final frozen full local gate and tarball smoke | passed | Serial controller frozen install/statics/full test/tarball smoke exited0;1929pass23skip0fail,176files271.55s. Separate original-provider-PATH tarball replay and actual native parser/MCP verification exited0. |

## Exact controller checks and limitations

All shell commands used `rtk proxy`; heavy checks were serialized. Commands from the feature checkout:

```text
bun --version                                      # 1.4.0
bun install --frozen-lockfile                       # exit0, lock unchanged
bun run typecheck                                  # exit0
bun run lint                                       # exit0
bun run format:check                               # exit0
env -u FORCE_COLOR bun test                         # final exit0
bun test/pack-smoke.ts                             # exit0
bun .superpowers/sdd/2026-10-01-20-codex-packaging-acceptance/pack-original-provider-path.ts
bun .superpowers/sdd/2026-10-01-20-codex-packaging-acceptance/controller-packaged-native.ts .superpowers/sdd/2026-10-01-20-codex-packaging-acceptance/controller-package-metadata.json
```

The first frozen full run at80d9483 had1927pass23skip2fail: two obsolete exact-prose skill assertions. Owning worker09f9561 corrected only those existing assertions; controller reviewed the full diff and repeated statics/full suite on the frozen tree. Final result:1929pass23skip0fail,90snapshots14116assertions across176files in271.55s. Skipped live vendor/model and opt-in cases are not passed. Separate Task1 installed native opt-in was personally verified within90/0 scoped tests.

The original-provider-PATH driver reuses the tracked pack smoke with only its checkout/import location and provider PATH restored; its native configuration is isolated. The actual packaged native driver copies the installed tarball's plugin into a disposable local marketplace with spaces, installs it through the real native parser, then launches exactly the resolved config with the real native user environment and temporary catherd data. It runs no model turn, queue send or app-server. Generic SDK success is no proof of native skill invocation, wake, busy ordering or collection.

Durable scratch inspection confirmed null owner/origin and no native accounting record. The initial artifact-inspection assertions incorrectly expected the initialized agents JSONL file to be absent/zero lines; reading its actual schema header corrected the inspection to count records. No product change or fabricated receipt resulted.

Ignored evidence workspace: `.superpowers/sdd/2026-10-01-20-codex-packaging-acceptance/`. Retained logs:controller-final-typecheck.log,controller-final-lint.log,controller-final-format.log,controller-full-test.log,controller-final-full-test.log,controller-final-pack.log,controller-original-provider-path.log,controller-packaged-native.log. Structured evidence:controller-package-metadata.json,controller-packaged-evidence.json,controller-packaged-run-artifacts.json,controller-current-native-config.json and controller-current-global-core.json. The original installed evidence file is `controller-evidence.json` beside the temporary native config. Paths are local evidence, not shipped runtime configuration.

Current real `codex mcp list --json` still resolves catherd as `sh ["${CLAUDE_PLUGIN_ROOT}/bin/catherd-mcp"]`, cwd null, no host discriminator. The current Desktop conversation exposes no callable catherd MCP tools. Rechecked stable global CLI1.3.0 resolves `/Users/vigen/.bun/install/global/node_modules/catherd-cli/src/cli.ts`, SHA-256`0a43658b51d55e365e27e707b276ffb785801ac62afb56ab58dbfa2742a61462`, different from the candidate. The candidate was installed only in disposable native config/prefixes, not activated in the user's live host; these facts prevent native conversation acceptance here. No user marketplace/config was removed or replaced to guess precedence, and no private IPC/history/SQLite/second-server fallback was used. CLI/Desktop original-owner idle/busy, legacy Claude, cross-host/concurrent delivery and recovery cases remain unverified.

Five cases passed; fifteen required cases remain unverified. The minor Changeset covers plans18–20. Version and remote release tag remain unchanged, and publication stays held until those actual packaged cases pass and the owner accepts the evidence.

## Evidence rules

A queue receipt proves acceptance only. Native user input and original-thread assistant continuation establish processing. Only explicit result collection establishes collected. Research wake markers and simulator passes never promote a packaged case. Each required failed or unverified case retains the release hold. No publication, push or CI check is authorized.
