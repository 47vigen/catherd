# catherd 1.0 — Plan 5: profiles, the CLI and doctor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 0.x profile code with spec §7 (profile schema v1, the default profile, validation with errors and warnings, the ProfileService as the single locked writer of profiles, agent files and links), give catherd its full §8 CLI (`init --no-input`, `doctor`, `profile …`, `status`, `watch`, `runs …`, `lock`) with §8's exit codes and one-line errors, add §10.2's structured log and §10.3's `doctor`, and delete the 0.x bridge and profile modules.

**Architecture:** The profile rules are pure domain code: `src/domain/profile.ts` (schema, defaults, the merge patch, `set <path> <value>`, diff, agent names), `src/domain/profile-rules.ts` (validation) and `src/domain/agents.ts` with `src/domain/role-prompts.ts` (the native agent files). `src/services/profile-service.ts` is the only writer: every write holds one file lock, rewrites the agent files and relinks the union of the active and repo-bound profiles, and it implements plan 2's `ProfilePort`, so the run engine, the MCP tools, the new CLI commands and (through a small shim) the 0.x TUI all go through it. The CLI is a thin entry layer (`src/cli.ts` plus one module per command) over the services, with `src/services/doctor.ts`, `src/services/setup.ts` (init) and `src/services/run-debug.ts` holding the logic; `src/infra/log.ts` is the JSONL log.

**Tech Stack:** Bun ≥ 1.4 (`bun test`), TypeScript 7 (`tsc --noEmit`), zod 4, citty 0.2, `@modelcontextprotocol/sdk`, oxlint, oxfmt. No new dependency; `microdiff` is removed.

**Spec:** `docs/superpowers/specs/2026-09-25-catherd-1.0-design.md` — §7 in full (§7.1 schema v1, §7.2 the default profile, §7.3 ProfileService), §8 (the CLI), §10.2 (logging), §10.3 (doctor), §3.1 (the Bun guard and lazy subcommands), §3.4 (schema versions, the file lock, unknown fields), §3.5 (`config.json`, `projects.json`, `profiles/`, `agents/`, `logs/`), §4.8 (`profile_set` with every field), D2 (clean break), D3 (native or headless Claude per role), D10 (access with its enforcement). Research: `docs/research/2026-09-25-audit.md` (E2 log, E4 doctor, the profile findings), `docs/research/2026-09-25-opencode.md` §1.2 (the OpenCode Go lineup). Plans 1–4 (`docs/superpowers/plans/2026-09-25-0{1,2,3,4}-*.md`) built everything this plan stands on. It uses plan 4's names: `loadCatalog`, `catalogQuery`, `refreshDiscovery`, `saveTreatLike` (`src/services/catalog-service.ts`), `routingService` (`src/services/routing-service.ts`), `jevKey`/`saveJevKey`/`testJevKey`/`askJev` (`src/services/jev-service.ts`), `rungInfo`/`scoresOf`/`capableFor`/`effortOffered`/`billingKeyOf`/`BILLING_KEYS` (`src/domain/catalog.ts`), `candidates`/`clearsBar`/`RoutingProfile` (`src/domain/select.ts`), `BILLING_MODES`/`DEFAULT_BILLING` (`src/domain/cost.ts`), `ProfilePort.agentFor` and the `ProfileView` fields `billing` and `jev` (`src/services/ports.ts`), `catherd catalog` (`src/entry/catalog-command.ts`), and `test/domain/shipped.ts`.

## Global Constraints

- Runtime Bun ≥ 1.4, no build step; `.ts` files imported with explicit `.ts` extensions. "A runtime guard at startup checks `Bun.version >= 1.4.0` and exits 1 with the upgrade command." `bun run typecheck`, `bun run lint` (`oxlint --deny-warnings src test`) and `bun run format:check` (oxfmt, print width 110) stay clean after every task; run `bun run format` before checking.
- "The dependency order, lowest first, is `domain` (pure types, schemas, errors, routing; no I/O) → `infra` → `adapters` → `services` → `entry`. A layer imports only from layers below it, and never from the 0.x modules (`src/core`, `src/mcp`, `src/routing`, `src/profile`, `src/tui`, `src/types.ts`), which are deleted once 1.0 replaces them." "`cli.ts` imports subcommands lazily: `mcp`, `lock` and `_supervise` never load OpenTUI or React."
- "A backend is one folder under `src/adapters/<id>/` plus its fixtures. No other module names a backend." Anything backend-specific that `doctor` needs is an optional adapter hook.
- "Every file carries `"schema": 1` (JSON) … Readers reject a newer schema with `E_CONFIG_NEWER_SCHEMA` and a "upgrade catherd" fix; unknown fields are preserved on rewrite." "Every JSON write is `write tmp → fsync → rename`" (`writeJsonAtomic`). "A cross-process advisory lock … guards read-modify-write of: … profiles, `config.json`, `projects.json`, the catalog override, and the agent links."
- §7.1: "Every role key is optional; a missing role takes the built-in default. Adding a role never breaks a profile. Unknown fields are preserved." "`access` defaults: architect, reviewer, researcher `read-only`; worker, writer, artist `workspace-write`; verifier, ui-reviewer `full`. `validate` warns (never errors) on a mismatch such as a verifier on `read-only`." "`validate` errors: worker disabled; an enabled role with no usable rung; an unscored rung without a treat-like; a failover stand-in unscored or on the same backend; a rung whose backend is unknown."
- §7.2: "architect `claude:claude-opus-5-5#high`; verifier `claude:claude-opus-5-5#low`; worker as above; reviewer `codex:gpt-6-sol#high`; ui-reviewer and artist `codex:gpt-6-sol#medium`; writer and researcher `codex:gpt-6-luna#high`. Failover for each Codex rung: the best-matching Go model by treat-like, marked `inferred`. Astra, Fable, Sonnet 5 and Haiku are in the catalog but not enabled."
- §7.3: "The single writer of profiles, agent files and agent links, used by the TUI, the `catherd profile` commands and MCP `profile_set`. Operations: `get`, `list`, `create`, `copy`, `delete`, `patch`, `validate`, `diff`, `activate(name, repo?)`." "Agent files are named `catherd-<profile>-<role>-<model slug>-<effort>.md`. Links in `~/.claude/agents` (or `CATHERD_CLAUDE_AGENTS_DIR`) cover the union of the active profile and every repo-bound profile; relinking happens on every save and activation; only catherd's own symlinks are ever replaced or pruned. Every operation that changes links returns the agents that need a new Claude Code session."
- §8: "Exit codes: `0` ok, `1` error, `2` usage, `3` not ready (`doctor`), `130` interrupted. Every read command has `--json`. Errors print one line: `error E_CODE: message` and `fix: …`."
- §10.2: "`<data>/logs/catherd-<date>.jsonl`, 7-day rotation, level via `--verbose` or `CATHERD_LOG`. Logged: every MCP tool call with duration and outcome, every spawn (argv and env keys, never values), reconciles, Jev calls. A redactor removes known secret values and `*_KEY`/`*_TOKEN` env values everywhere. `catherd runs show <id> --debug` prints the record, `exit.json`, the stderr tail and the event tail."
- §10.3: "Checks: Bun version; each backend (installed, version ≥ min, logged in, discovery ok); Jev key (present, test question); plugin installed and its version equal to the package's; agent links present and not stale; the MCP server starts and answers `tools/list` over stdio; the heavy-lock directory is writable, including from inside a Codex `workspace-write` sandbox; warnings for `full` access, advisory enforcement and Cursor's weak isolation; credential file modes. Output: one row per check with state, word and fix; `--json`; exit 3 when not ready."
- §10.4: "Secrets never reach workers or logs; credential files are mode 600." "agent links only replace catherd's links."
- Tests: an isolated `CATHERD_HOME` per test (`withHome()` or `freshRun()`), `afterEach(snapshotEnv())` in every file that sets an env var, no network (every Jev call gets a fake fetch or no key; backend CLIs are the simulators or `PATH=/nonexistent`), never the real `~/.claude` (`withHome()` sets `CATHERD_CLAUDE_AGENTS_DIR`; doctor tests set `CLAUDE_CONFIG_DIR`). **A test that spawns a process passes `env` explicitly** (`env: process.env` or a spread of it): Bun hands a child its own start-up environment, not later `process.env` changes (verified on Bun 1.4.2), so a child without `env` would use the real home.
- Style: short doc comments only where the why is not obvious; Conventional Commits.

## Review Focus

1. **A profile file written by a newer catherd, or edited by hand, carries fields and roles this catherd does not know.** Expected: every read works, and every write (`profile set`, `profile_set`, the TUI) keeps them. Task 1 pins it ("reads a document with fields and roles it does not know, and keeps them through a patch"); Task 4 pins it through the service ("creates a missing profile from the default, and keeps fields it does not know").
2. **The user has their own file in `~/.claude/agents` under a name catherd wants to link.** Expected: catherd never replaces or deletes it; the save is refused with a fix and the profile on disk is unchanged. Task 4 pins it: "never touches a file it does not own, and refuses to save over one".
3. **Two catherd processes save a profile at the same moment** (the TUI and an MCP `profile_set`, or two CLI calls). Expected: both updates land; neither is lost. Task 4 pins it: "serialises writers across processes, so no update is lost".
4. **A 0.x install upgrades.** Expected: every 1.0 command that reads a 0.x `config.json`, `projects.json` or profile fails with `E_CONFIG_INVALID` and the fix `run catherd init`; `init` moves the 0.x files to a backup folder and writes 1.0 ones, never mixing the two. Task 4 pins the read ("refuses a 0.x profile with the init fix …"), Task 12 the doctor row ("fails on an old Bun, an invalid profile, and a 0.x config"), Task 13 the move ("moves every 0.x file to a dated backup and leaves 1.0 files alone").
5. **A worker's stderr, a spawn's argv or the env carries an API key.** Expected: the log and `runs show --debug` print `[redacted]` in its place, and env maps only by their keys. Task 7 pins the redactor ("scrubs every *_KEY and *_TOKEN value …") and the Jev row ("… never the state or the key"); Task 10 pins `runs show --debug` ("… secrets redacted").

## Rulings on the spec

1. **Native or headless Claude is the rung's backend.** A `claude:` rung runs as a native subagent, a `claude-code:` rung headless (D3); the profile stores the rung as written, so no separate per-role field is needed and plan 3's `claudeBackendFor`/`NATIVE_CLAUDE_ROLES` go away. The built-in architect and verifier are native (§6.2's defaults). Failover keys are stored verbatim too, which closes plan 3's deferred "failover keys rewritten to `claude-code:` for native roles".
2. **The default failover (§7.2).** OpenCode Go serves GPT-6 Luna itself, so `codex:gpt-6-luna#high` fails over to `opencode:opencode-go/gpt-6-luna#high` (canonically the same rung). Go has no Sol, so the three Sol rungs fail over to `opencode:opencode-go/kimi-k3#max` (Kimi K3's only variant, research §2.1), made usable by a shipped treat-like `opencode-go/kimi-k3#max → gpt-6-sol#medium` in `catalog/scores.json`. A stand-in is **marked inferred** when its scores come through a treat-like or are all `inferred`: both default stand-ins are, and `profile show` prints the mark. Nothing extra is stored in the profile.
3. **"On the same backend" means on the same quota.** A stand-in is refused when its billing key equals the limited rung's, with native `claude` and `claude-code` counted as one (both draw on the Claude plan). OpenCode Go and Zen bill apart, so they may stand in for each other.
4. **Defaults.** A missing role takes the built-in role; a role that lists its own `rungs` does not inherit the built-in `defaultRung`. A missing `failover` is `{}` (only the written default profile carries the Go stand-ins). `default` exists before its file: reading it serves the full default document.
5. **Validation.** Errors are exactly §7.1's list, plus a rung that does not parse and a `defaultRung` missing from the role's rungs (both leave routing nothing to do). Everything else is a warning: an access mode other than the role's default, a model the backend's last listing lacks, an effort that cannot be checked before the backend lists its models, worker bars no rung clears, a stand-in on no enabled ladder, and a native (`claude:`) stand-in, which dispatch hands back to the orchestrator (plan 2's branch, now reachable).
6. **Profile names** are `^[a-z0-9][a-z0-9-]{0,31}$`: they become part of Claude Code agent names.
7. **One synchronous lock.** `<config>/profiles.lock` guards profiles, `config.json`, `projects.json`, the agent files and the links; writers take it with a new `withFileLockSync` (a blocking poll), because the 0.x TUI calls save synchronously and the section lasts milliseconds. Writers are never nested.
8. **New sessions.** `newSessionNeededFor` lists every agent whose link was created or retargeted, or whose file's content changed: Claude Code reads agent files only when a session starts.
9. **Patches.** `profile_set` and `catherd profile set` share one strict zod schema covering every field (§4.8), so an unknown key is `E_INPUT_INVALID` instead of dropped (plan-2 review m9), and a rung's model or effort can no longer look like a flag (`parseRung` now refuses a leading `-` or a space). Patches follow JSON merge-patch rules: maps merge, lists replace, `null` removes. `set <path> <value>` takes JSON when it parses, else the word; under `failover.` and `billing.` the rest of the path is one key (rungs hold dots); a rung list may be comma-separated.
10. **The 0.x TUI keeps working through a minimal shim.** `src/tui/profile-shim.ts` translates the 0.x shape (`roles[role].models`, rungs without a backend) to and from the ProfileService, keeping every 1.0-only field on save; the editor, init screen, dashboard and `src/core/status.ts` import it. The bridge (`src/bridge/v0.ts`) and `src/profile/*` are deleted. The shim goes with the TUI in plan 6. The CLI's `init` and `watch` no longer open the 0.x screens (the dashboard still can).
11. **`init` without the TUI.** It asks for the optional Jev key (hidden input on a terminal), the profile to set up and whether to replace an existing one; piped answers are read from stdin; `--no-input` asks nothing, keeps an existing 1.0 profile and writes the default otherwise. 0.x files move to `<config>/0.x-backup-<stamp>/` (D2: no migration). It ends with the doctor report and the plugin install commands, and exits 0 even when not ready.
12. **`doctor`'s readiness.** Not ready (exit 3) on: an old Bun, an unreadable config, an invalid active profile, a backend an enabled role of a linked profile runs on, a missing or stale plugin, missing or stale agent links, an MCP server that does not answer, an unwritable lock dir, a credentials file others can read. Warnings: a backend only a stand-in uses, Jev (optional), the lock dir from a Codex sandbox, `full` access, advisory enforcement, weak isolation, `bunx` missing and unreadable run folders (the last two from the audit's doctor list). The sandbox check is a new optional adapter hook, `canWrite(dir)`, which the Codex adapter implements with `codex sandbox <linux|macos> --full-auto` and which returns null (skipped) when it cannot test; weak isolation is a new optional `isolationNote`, which no 1.0 adapter sets and Cursor's (1.1) will.
13. **Logging.** `CATHERD_LOG` takes `off|error|warn|info|debug` (default `info`); `--verbose` sets it to `debug` for catherd and whatever it starts. Seven days are kept, today included. Tool calls log the tool, milliseconds, `ok` and the error code, never the input; spawns log argv and env keys; `runCli` spawns log at debug. The redactor scrubs the values of `*_KEY`, `*_TOKEN`, `*_SECRET` and `*_PASSWORD` env variables of 8 characters or more, and the Jev key once used.
14. **Exit codes.** A citty parse error and `E_INPUT_INVALID` are usage errors (2); any other `CatherdError` is 1; anything else prints as `E_IO_UNEXPECTED` with exit 1. Ctrl-C exits 130, except in `lock`, which forwards it. The new code `E_RUNTIME_TOO_OLD` names the Bun guard.
15. **`watch` without `--once`** redraws the plain `status` snapshot every 2 s until Ctrl-C; plan 6's Runs tab replaces it. `runs list` takes `--repo <path>`; `runs show --debug` takes `--name` to narrow to one role.
16. **Carried from plans 2–4:** `catalog_query` prices rungs with the active profile's billing (plan 4 Ruling 10); `set_next` returns `{ state, hints? }` like every other tool (plan-2 m8); `catherd lock` forwards signals to the command's process group once, kills it on a second Ctrl-C, forwards SIGHUP, and says when it falls back to half the cores (plan-2 m10); `_supervise` is hidden; the read-only researcher is no longer asked to measure the suite (plan-3 re-review). Plan 3's opencode session accounting needs no rework: the native/headless defaults did not change.

## Verified facts this plan relies on

- Every task's code was built and tested task by task in a scratch copy (in the order 1–14; the waves below run Task 7 earlier, and its only file in common with Tasks 2–6 is `src/entry/mcp/server.ts`, where Task 5 edits other lines), on `main` at `b7df77d` plus plan 4 as its own replay produced it, then rebased onto `main` at `ede2450` (plan 3's later fixes). There, `bun run typecheck`, `bun run lint` and `bun run format:check` are clean and `bun test` passes (864 pass, 10 skip, 0 fail on Bun 1.4.2), and no test writes to the real `~/.local/share/catherd`. The only merge point with the later plan-3 fixes is `failoverFor?(rung: Rung, repo?: string)` in `src/adapters/backend.ts` (Task 12 adds its lines after it).
- Bun 1.4.2: `Bun.spawn({ detached: true })` starts the child in its own session (its pid is its process group and session id), and `await child.exited` is `128 + n` when signal `n` killed it; `Bun.spawn`/`spawnSync` without `env` pass the process's start-up environment, not later `process.env` changes.
- citty 0.2.2 reads `--no-input` as `input: false`, honours `meta.hidden`, and exits 1 on its own parse errors unless the caller runs `runCommand` itself (Task 8 does).
- `claude plugin --help` (2.1.282) lists `marketplace add <source>` and `install <plugin>@<marketplace>`; Claude Code records plugins in `<CLAUDE_CONFIG_DIR or ~/.claude>/plugins/installed_plugins.json` as `{ "version": 2, "plugins": { "<name>@<marketplace>": [{ "version", … }] } }` (read on this machine).
- UNVERIFIED: `codex sandbox <linux|macos> --full-auto -- <cmd>` against a real Codex CLI (none is installed here); the Codex simulator implements that shape, and the check degrades to "not tested" when the control command fails.

---

## File Structure

```
catalog/scores.json                     (modify) the shipped treat-like for Go's Kimi K3 stand-in
src/domain/profile.ts                   schema v1, built-in roles, default profile, resolve, merge patch, patchAt, diff, agentName
src/domain/profile-rules.ts             validateProfile (errors, warnings), quotaOf, inferredScores
src/domain/role-prompts.ts              the role prompts (moved from src/profile), rolePrompt, nativeDisallowedTools
src/domain/agents.ts                    renderAgent, agentFiles
src/domain/runtime.ts                   MIN_BUN, bunTooOld, runtimeRefusal
src/domain/ids.ts                       (modify) parseRung refuses flag-shaped models and efforts
src/domain/errors.ts                    (modify) E_RUNTIME_TOO_OLD
src/domain/roles.ts                     (modify) claudeBackendFor removed
src/infra/filelock.ts                   (modify) withFileLockSync
src/infra/paths.ts                      (modify) claudeHome, claudeAgentsDir
src/infra/log.ts                        the JSONL log, rotation, the redactor
src/infra/{supervisor,launch}.ts        (modify) log spawns and launches
src/adapters/backend.ts                 (modify) optional canWrite and isolationNote hooks
src/adapters/codex/index.ts             (modify) canWrite through codex sandbox
src/adapters/cli.ts                     (modify) log runCli spawns at debug
src/services/profile-service.ts         the ProfileService: reads, locked writes, agent files and links, profileService(): ProfilePort
src/services/ports.ts                   (modify) ProfilePort: warnings, ProfileSaved, enforcement, agentFor(repo, …); catalog billing
src/services/{admission,dispatch-service,lane-service,run-service,routing-service}.ts   (modify) agentFor(repo, …), catalog billing
src/services/run-service.ts             (modify) setNext returns { state, hints? }
src/services/{jev-service,reconcile}.ts (modify) log Jev calls and reconciles
src/services/run-debug.ts               runDebug for runs show --debug
src/services/doctor.ts                  doctor(): the readiness report
src/services/setup.ts                   moveLegacy, initSetup
src/entry/deps.ts                       defaultDeps (moved out of the MCP server)
src/entry/cli-kit.ts                    EXIT, printError, exitCodeOf, printJson, mark
src/entry/profile-command.ts            catherd profile list|show|use|new|copy|rm|set|diff|validate
src/entry/runs-command.ts               catherd status, watch, runs list|show|cancel
src/entry/doctor-command.ts             catherd doctor
src/entry/init-command.ts, prompt.ts    catherd init, and its prompts
src/entry/mcp/handshake.ts              the MCP stdio handshake doctor runs
src/entry/mcp/{server,setup-tools,run-tools}.ts   (modify) tool-call log, the strict full patch, set_next
src/entry/lock.ts                       (replace) group signal forwarding, the fallback warning
src/entry/supervise.ts                  (modify) _supervise hidden
src/cli.ts                              (replace) Bun guard, lazy subcommands, exit codes
src/tui/profile-shim.ts                 the 0.x TUI's profile API over the ProfileService
src/tui/{editor,init,dashboard}.tsx, src/tui/profiles.ts, src/tui/commands.ts, src/core/status.ts   (modify) the shim; init and watch leave the TUI
src/bridge/v0.ts, src/profile/{profile,agents,role-prompts}.ts   (delete)
plugin/skills/catherd-setup/SKILL.md    (replace) the 1.0 fields and tools
plugin/skills/catherd/SKILL.md, README.md, docs/dependencies.md, package.json, bun.lock   (modify)
test/domain/{profile,profile-rules,agents}.test.ts, test/services/{profile-service,doctor,setup}.test.ts
test/entry/{mcp-profile,mcp-log,cli,profile-command,runs-command,doctor-command,init-command}.test.ts
test/infra/log.test.ts, test/tui/profile-shim.test.ts, test/import-graph.ts, test/fixtures/profiles/bad.json
test/sim/{codex,scenario.ts}            (modify) codex sandbox
test/{bridge/v0,domain/roles,agents,profile,validate}.test.ts   (delete)
```

## Parallelism

Tasks that share no files and whose inputs exist can run in parallel worktrees; each merges before its dependents start.

| Wave | Tasks | Needs |
|---|---|---|
| 1 | 1 (profile schema), 7 (the log) | plan 4 |
| 2 | 2 (validation), 3 (agent files), 8 (the CLI runner) | 2, 3: 1 · 8: 7 (`test/infra/launch.test.ts`) |
| 3 | 4 (ProfileService) | 1, 2, 3 |
| 4 | 5 (the run engine and MCP on the ProfileService; the bridge removed) | 4, 7 (`server.ts`) |
| 5 | 6 (the TUI shim; 0.x profile removed), 9 (`profile`), 10 (`status`, `watch`, `runs`), 11 (`lock`), 12 (`doctor`) | 6: 5 · 9: 4, 8 · 10: 5, 7, 8 · 11: 4, 5, 8 · 12: 4, 8 |
| 6 | 13 (`init`), 14 (skills, `set_next`, README) | 13: 10, 12 · 14: 5, and every command for the README |

Tasks 9, 10 and 12 each add lines to `main`'s `subCommands` in `src/cli.ts`; when merging, keep every line. Tasks 10 and 13 both edit `src/tui/commands.ts` (10 first). Task 7 edits `src/entry/mcp/server.ts` before Task 5 does; their edits touch different lines.

---

### Task 1: Profile schema v1 and the default profile

The domain half of spec §7.1 and §7.2: the stored document's schema (loose at every level, so unknown fields survive), the built-in roles, the default profile with its OpenCode Go stand-ins, `resolveProfile` (every default filled in), the strict patch schema that `profile_set` and `catherd profile set` share, the merge patch, `patchAt` for `set <path> <value>`, the diff, and agent names. `parseRung` stops accepting a model or effort shaped like a flag.

**Files:**
- Create: `src/domain/profile.ts`
- Modify: `src/domain/ids.ts` (`parseRung`), `catalog/scores.json` (one shipped treat-like)
- Test: `test/domain/profile.test.ts`, `test/domain/ids.test.ts`

**Interfaces:**
- Consumes: `parseRung` (`src/domain/ids.ts`); `BILLING_KEYS`, `BillingKey` (`src/domain/catalog.ts`, plan 4); `BILLING_MODES`, `BillingMode`, `DEFAULT_BILLING` (`src/domain/cost.ts`, plan 4); `ACCESS`, `Access` (`src/domain/record.ts`); `DEFAULT_ACCESS`, `ROLES`, `Role` (`src/domain/roles.ts`); `Budget` (`src/domain/budget.ts`); `CatherdError`.
- Produces: `PROFILE_SCHEMA = 1`; `PROFILE_NAME`; `assertProfileName(name): string` (throws `E_INPUT_INVALID`); `NOTIFY`, `type NotifyMoment`; `HARNESS_KEYS`; `RungSchema`; `ProfileDocSchema`, `type ProfileDoc`; `type RoleConfig = { enabled; access; rungs: string[]; defaultRung? }`; `interface Profile { name; objective; jev: { use }; billing: Record<string, BillingMode>; roles: Record<Role, RoleConfig>; harness: Record<string, { isolated: boolean }>; failover: Record<string, string>; budget: Budget; timeouts: { idleMin; wallMin }; preflight: { confirm }; lock: { heavy }; notify: NotifyMoment[] }`; `BUILTIN_ROLES`; `DEFAULT_FAILOVER`; `defaultProfileDoc(name = "default"): ProfileDoc`; `resolveProfile(doc, name): Profile`; `agentName(profile, role, rung): string`; `ProfilePatchSchema`, `type ProfilePatch`; `mergePatch(target, patch)`; `applyPatch(doc, patch): ProfileDoc`; `patchAt(path, raw): ProfilePatch` (throws `E_INPUT_INVALID`); `interface Change { path; before; after }`; `diffProfiles(a, b): Change[]`.

- [ ] **Step 1: Write the failing tests**

`test/domain/profile.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  agentName,
  applyPatch,
  assertProfileName,
  BUILTIN_ROLES,
  DEFAULT_FAILOVER,
  defaultProfileDoc,
  diffProfiles,
  patchAt,
  ProfileDocSchema,
  ProfilePatchSchema,
  resolveProfile,
} from "../../src/domain/profile.ts";
import { ROLES } from "../../src/domain/roles.ts";

describe("the default profile (spec §7.2)", () => {
  const p = resolveProfile(defaultProfileDoc(), "default");

  it("places every role as the owner's setup does", () => {
    expect(Object.fromEntries(ROLES.map((r) => [r, p.roles[r].rungs]))).toEqual({
      architect: ["claude:claude-opus-5-5#high"],
      verifier: ["claude:claude-opus-5-5#low"],
      worker: [
        "codex:gpt-6-luna#high",
        "codex:gpt-6-sol#medium",
        "codex:gpt-6-sol#high",
        "codex:gpt-6-sol#xhigh",
      ],
      reviewer: ["codex:gpt-6-sol#high"],
      "ui-reviewer": ["codex:gpt-6-sol#medium"],
      artist: ["codex:gpt-6-sol#medium"],
      writer: ["codex:gpt-6-luna#high"],
      researcher: ["codex:gpt-6-luna#high"],
    });
    expect(p.roles.worker.defaultRung).toBe("codex:gpt-6-sol#medium");
  });

  it("gives each role its default access", () => {
    expect(Object.fromEntries(ROLES.map((r) => [r, p.roles[r].access]))).toEqual({
      architect: "read-only",
      verifier: "full",
      worker: "workspace-write",
      reviewer: "read-only",
      "ui-reviewer": "full",
      artist: "workspace-write",
      writer: "workspace-write",
      researcher: "read-only",
    });
  });

  it("fails every Codex rung over to OpenCode Go, and writes out every field", () => {
    expect(p.failover).toEqual(DEFAULT_FAILOVER);
    expect(Object.keys(DEFAULT_FAILOVER).sort()).toEqual([...new Set(p.roles.worker.rungs)].sort());
    expect(Object.keys(defaultProfileDoc())).toEqual([
      "schema",
      "name",
      "objective",
      "jev",
      "billing",
      "roles",
      "harness",
      "failover",
      "budget",
      "timeouts",
      "preflight",
      "lock",
      "notify",
    ]);
    expect(defaultProfileDoc().billing).toEqual({
      codex: "chatgpt-plan",
      claude: "claude-plan",
      "claude-code": "claude-plan",
      "opencode-go": "subscription",
      opencode: "metered",
    });
  });
});

describe("resolveProfile", () => {
  it("fills a bare document from the built-in roles and the spec defaults", () => {
    const p = resolveProfile({ schema: 1 }, "bare");
    expect(p.roles).toEqual(BUILTIN_ROLES);
    expect([p.objective, p.jev.use, p.timeouts, p.preflight, p.lock, p.failover]).toEqual([
      "cost",
      "auto",
      { idleMin: 15, wallMin: 90 },
      { confirm: false },
      { heavy: "cpus/2" },
      {},
    ]);
    expect(p.harness["claude-code"]).toEqual({ isolated: false });
    expect(p.billing.cursor).toBe("metered");
  });

  it("takes a partial role's missing fields from the built-in one, but not its default rung", () => {
    const p = resolveProfile(
      {
        schema: 1,
        roles: { verifier: { access: "read-only" }, worker: { rungs: ["codex:gpt-6-sol#high"] } },
      },
      "x",
    );
    expect(p.roles.verifier).toEqual({ ...BUILTIN_ROLES.verifier, access: "read-only" });
    expect(p.roles.worker).toEqual({
      enabled: true,
      access: "workspace-write",
      rungs: ["codex:gpt-6-sol#high"],
    });
  });

  it("reads a document with fields and roles it does not know, and keeps them through a patch", () => {
    const doc = ProfileDocSchema.parse({
      schema: 1,
      theme: "ginger",
      roles: { tester: { enabled: true }, worker: { enabled: true, color: "red" } },
      timeouts: { idleMin: 5, graceSec: 3 },
    });
    expect(resolveProfile(doc, "x").timeouts).toEqual({ idleMin: 5, wallMin: 90 });
    const after = applyPatch(doc, { timeouts: { wallMin: 60 }, roles: { worker: { access: "full" } } });
    expect(after).toEqual({
      schema: 1,
      theme: "ginger",
      roles: { tester: { enabled: true }, worker: { enabled: true, color: "red", access: "full" } },
      timeouts: { idleMin: 5, graceSec: 3, wallMin: 60 },
    });
  });
});

describe("applyPatch", () => {
  it("replaces lists, merges maps, and deletes a key patched to null", () => {
    const doc = defaultProfileDoc();
    const after = applyPatch(doc, {
      roles: { worker: { rungs: ["codex:gpt-6-sol#high"], defaultRung: null } },
      failover: {
        "codex:gpt-6-sol#high": null,
        "codex:gpt-6-sol#medium": "claude-code:claude-sonnet-5#high",
      },
      budget: { usd: 5 },
      billing: { opencode: null },
    });
    expect(after.roles?.worker).toEqual({
      enabled: true,
      access: "workspace-write",
      rungs: ["codex:gpt-6-sol#high"],
    });
    expect(after.failover?.["codex:gpt-6-sol#high"]).toBeUndefined();
    expect(after.failover?.["codex:gpt-6-sol#medium"]).toBe("claude-code:claude-sonnet-5#high");
    expect(after.budget).toEqual({ usd: 5 });
    expect(after.billing?.opencode).toBeUndefined();
    expect(doc.budget).toEqual({});
  });
});

describe("ProfilePatchSchema", () => {
  it("refuses unknown keys at every level, and flag-shaped rungs", () => {
    for (const bad of [
      { colour: "red" },
      { roles: { worker: { model: "x" } } },
      { roles: { chef: { enabled: true } } },
      { harness: { codex: { isolated: true, extra: 1 } } },
      { failover: { "codex:gpt-6-sol#high": "codex:--yolo#high" } },
      { budget: { usd: -1 } },
    ])
      expect(ProfilePatchSchema.safeParse(bad).success).toBe(false);
  });

  it("takes every field spec §4.8 names", () => {
    const patch = {
      objective: "speed",
      jev: { use: "off" },
      billing: { codex: "metered" },
      roles: {
        reviewer: { enabled: true, access: "full", rungs: ["codex:gpt-6-sol#high"], defaultRung: null },
      },
      harness: { "claude-code": { isolated: true } },
      failover: { "codex:gpt-6-sol#high": "opencode:opencode-go/kimi-k3#max" },
      budget: { minutes: 30, tokens: null },
      timeouts: { idleMin: 5, wallMin: 60 },
      preflight: { confirm: true },
      lock: { heavy: 2 },
      notify: ["finish"],
    };
    expect(ProfilePatchSchema.parse(patch)).toEqual(patch as never);
  });
});

describe("patchAt", () => {
  it("builds a patch from a path and a JSON or plain value", () => {
    expect(patchAt("roles.verifier.access", "read-only")).toEqual({
      roles: { verifier: { access: "read-only" } },
    });
    expect(patchAt("budget.usd", "5")).toEqual({ budget: { usd: 5 } });
    expect(patchAt("budget.usd", "null")).toEqual({ budget: { usd: null } });
    expect(patchAt("preflight.confirm", "true")).toEqual({ preflight: { confirm: true } });
    expect(patchAt("harness.claude-code.isolated", "true")).toEqual({
      harness: { "claude-code": { isolated: true } },
    });
    expect(patchAt("notify", "finish,blocked")).toEqual({ notify: ["finish", "blocked"] });
  });

  it("keeps a rung key with dots whole, and splits a comma-separated rung list", () => {
    expect(patchAt("failover.codex:gpt-5.6-sol#high", "opencode:opencode-go/gpt-5.6-luna#max")).toEqual({
      failover: { "codex:gpt-5.6-sol#high": "opencode:opencode-go/gpt-5.6-luna#max" },
    });
    expect(patchAt("roles.worker.rungs", "codex:gpt-6-sol#high, codex:gpt-6-sol#xhigh")).toEqual({
      roles: { worker: { rungs: ["codex:gpt-6-sol#high", "codex:gpt-6-sol#xhigh"] } },
    });
  });

  it("refuses an unknown path or a bad value with E_INPUT_INVALID and a fix", () => {
    for (const [path, value] of [
      ["roles.worker.colour", "red"],
      ["timeouts.idleMin", "soon"],
      ["roles..access", "full"],
      ["failover.", "codex:gpt-6-sol#high"],
    ] as const) {
      expect(() => patchAt(path, value)).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
    }
  });
});

describe("names", () => {
  it("names a native agent after the profile, role, model and effort", () => {
    expect(agentName("default", "architect", "claude:claude-opus-5-5#high")).toBe(
      "catherd-default-architect-claude-opus-5-5-high",
    );
    expect(agentName("fast", "verifier", "claude:claude-haiku-4-5-20251001#default")).toBe(
      "catherd-fast-verifier-claude-haiku-4-5-20251001-default",
    );
  });

  it("takes lowercase profile names only, since they become agent names", () => {
    expect(assertProfileName("team-2")).toBe("team-2");
    for (const bad of ["Team", "-x", "a b", "", "x".repeat(33), "a_b"])
      expect(() => assertProfileName(bad)).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
  });
});

describe("diffProfiles", () => {
  it("lists each changed leaf with its before and after", () => {
    const a = resolveProfile(defaultProfileDoc(), "a");
    const b = resolveProfile(
      applyPatch(defaultProfileDoc(), { budget: { usd: 5 }, roles: { verifier: { access: "read-only" } } }),
      "b",
    );
    expect(diffProfiles(a, b)).toEqual([
      { path: "budget.usd", before: null, after: 5 },
      { path: "roles.verifier.access", before: "full", after: "read-only" },
    ]);
  });
});
```

In `test/domain/ids.test.ts`, add three rungs to the list `parseRung` must reject. Replace:

```ts
  it.each(["gpt-6-sol#high", "codex:#high", "codex:gpt-6-sol#", "codex:gpt-6-sol", "nope:m#e", ""])(
```

with:

```ts
  it.each([
    "gpt-6-sol#high",
    "codex:#high",
    "codex:gpt-6-sol#",
    "codex:gpt-6-sol",
    "nope:m#e",
    "",
    "codex:--dangerously-bypass-approvals-and-sandbox#high",
    "codex:gpt 6#high",
    "codex:gpt-6-sol#-x",
  ])(
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/domain/profile.test.ts test/domain/ids.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/profile.ts'`, and the three new `parseRung` cases pass through without a throw.

- [ ] **Step 3: Write the implementation**

`src/domain/profile.ts`:

```ts
import { z } from "zod";
import type { Budget } from "./budget.ts";
import { BILLING_KEYS, type BillingKey } from "./catalog.ts";
import { BILLING_MODES, type BillingMode, DEFAULT_BILLING } from "./cost.ts";
import { CatherdError } from "./errors.ts";
import { parseRung } from "./ids.ts";
import { ACCESS, type Access } from "./record.ts";
import { DEFAULT_ACCESS, ROLES, type Role } from "./roles.ts";

/** Spec §3.4: every file carries its schema version; a profile is schema 1. */
export const PROFILE_SCHEMA = 1;

/** Profile names end up in agent names (`catherd-<profile>-…`), which Claude Code wants lowercase. */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function assertProfileName(name: string): string {
  if (!PROFILE_NAME.test(name))
    throw new CatherdError("E_INPUT_INVALID", `bad profile name "${name}"`, {
      fix: "use lowercase letters, digits and '-', at most 32, starting with a letter or digit",
    });
  return name;
}

export const NOTIFY = ["milestone", "finish", "blocked"] as const;
export type NotifyMoment = (typeof NOTIFY)[number];

/** The harnesses a profile can isolate (spec §7.1 `harness`); the native `claude` path has none. */
export const HARNESS_KEYS = ["codex", "claude-code", "opencode", "cursor", "grok"] as const;

const isRung = (s: string): boolean => {
  try {
    parseRung(s);
    return true;
  } catch {
    return false;
  }
};
/** A `<backend>:<model>#<effort>` rung, for input schemas; stored profiles keep any string and validate. */
export const RungSchema = z.string().refine(isRung, "a rung is <backend>:<model>#<effort>");

const positive = z.number().positive();

// Stored files: every level is loose, so fields a newer catherd wrote survive a rewrite (spec §3.4), and
// rung strings are checked by validateProfile rather than making the whole file unreadable.
const RoleDocSchema = z.looseObject({
  enabled: z.boolean().optional(),
  access: z.enum(ACCESS).optional(),
  rungs: z.array(z.string()).optional(),
  defaultRung: z.string().optional(),
});

export const ProfileDocSchema = z.looseObject({
  schema: z.literal(PROFILE_SCHEMA),
  name: z.string().optional(),
  objective: z.enum(["cost", "speed"]).optional(),
  jev: z.looseObject({ use: z.enum(["auto", "off"]).optional() }).optional(),
  billing: z.record(z.string(), z.enum(BILLING_MODES)).optional(),
  roles: z.record(z.string(), RoleDocSchema).optional(),
  harness: z.record(z.string(), z.looseObject({ isolated: z.boolean().optional() })).optional(),
  failover: z.record(z.string(), z.string()).optional(),
  budget: z
    .looseObject({ minutes: positive.optional(), tokens: positive.optional(), usd: positive.optional() })
    .optional(),
  timeouts: z.looseObject({ idleMin: positive.optional(), wallMin: positive.optional() }).optional(),
  preflight: z.looseObject({ confirm: z.boolean().optional() }).optional(),
  lock: z
    .looseObject({ heavy: z.union([z.number().int().positive(), z.literal("cpus/2")]).optional() })
    .optional(),
  notify: z.array(z.enum(NOTIFY)).optional(),
});
export type ProfileDoc = z.infer<typeof ProfileDocSchema>;

// a type, not an interface, so the built-in roles can be written into a loose (indexed) document
export type RoleConfig = {
  enabled: boolean;
  access: Access;
  /** in ladder order, each `backend:model#effort`; `claude:` runs as a native subagent, `claude-code:` headless */
  rungs: string[];
  defaultRung?: string;
};

/** A profile with every default filled in: what the run engine, the CLI and the agent files read. */
export interface Profile {
  name: string;
  objective: "cost" | "speed";
  jev: { use: "auto" | "off" };
  billing: Record<string, BillingMode>;
  roles: Record<Role, RoleConfig>;
  harness: Record<string, { isolated: boolean }>;
  failover: Record<string, string>;
  budget: Budget;
  timeouts: { idleMin: number; wallMin: number };
  preflight: { confirm: boolean };
  lock: { heavy: number | "cpus/2" };
  notify: NotifyMoment[];
}

const LUNA_HIGH = "codex:gpt-6-luna#high";
const SOL = (effort: string) => `codex:gpt-6-sol#${effort}`;

/**
 * Spec §7.2, the owner's setup (Codex on a ChatGPT plan, a Claude plan, OpenCode Go). A role missing
 * from a profile takes its entry here. Architect and verifier run as native Claude subagents (D3).
 */
export const BUILTIN_ROLES: Record<Role, RoleConfig> = {
  architect: { enabled: true, access: DEFAULT_ACCESS.architect, rungs: ["claude:claude-opus-5-5#high"] },
  verifier: { enabled: true, access: DEFAULT_ACCESS.verifier, rungs: ["claude:claude-opus-5-5#low"] },
  worker: {
    enabled: true,
    access: DEFAULT_ACCESS.worker,
    rungs: [LUNA_HIGH, SOL("medium"), SOL("high"), SOL("xhigh")],
    defaultRung: SOL("medium"),
  },
  reviewer: { enabled: true, access: DEFAULT_ACCESS.reviewer, rungs: [SOL("high")] },
  "ui-reviewer": { enabled: true, access: DEFAULT_ACCESS["ui-reviewer"], rungs: [SOL("medium")] },
  artist: { enabled: true, access: DEFAULT_ACCESS.artist, rungs: [SOL("medium")] },
  writer: { enabled: true, access: DEFAULT_ACCESS.writer, rungs: [LUNA_HIGH] },
  researcher: { enabled: true, access: DEFAULT_ACCESS.researcher, rungs: [LUNA_HIGH] },
};

/**
 * Spec §7.2: each Codex rung fails over to the best-matching OpenCode Go model. Go serves GPT-6 Luna
 * itself; for Sol it has no GPT model, so Kimi K3 stands in through a shipped treat-like (scores.json),
 * which `profile show` marks inferred.
 */
export const DEFAULT_FAILOVER: Record<string, string> = {
  [LUNA_HIGH]: "opencode:opencode-go/gpt-6-luna#high",
  [SOL("medium")]: "opencode:opencode-go/kimi-k3#max",
  [SOL("high")]: "opencode:opencode-go/kimi-k3#max",
  [SOL("xhigh")]: "opencode:opencode-go/kimi-k3#max",
};

/** The five billing keys spec §7.1 writes out; cursor and grok arrive with their backends. */
const WRITTEN_BILLING: BillingKey[] = ["codex", "claude", "claude-code", "opencode-go", "opencode"];

/** The full default profile document, every field written out: what `init` and `profile new` save. */
export function defaultProfileDoc(name = "default"): ProfileDoc {
  return {
    schema: PROFILE_SCHEMA,
    name,
    objective: "cost",
    jev: { use: "auto" },
    billing: Object.fromEntries(WRITTEN_BILLING.map((k) => [k, DEFAULT_BILLING[k]])),
    roles: structuredClone(BUILTIN_ROLES),
    harness: {
      codex: { isolated: false },
      "claude-code": { isolated: false },
      opencode: { isolated: false },
    },
    failover: { ...DEFAULT_FAILOVER },
    budget: {},
    timeouts: { idleMin: 15, wallMin: 90 },
    preflight: { confirm: false },
    lock: { heavy: "cpus/2" },
    notify: [...NOTIFY],
  };
}

/** Spec §7.1: every field a document leaves out takes its default; a missing role takes the built-in one. */
export function resolveProfile(doc: ProfileDoc, name: string): Profile {
  const roles = {} as Record<Role, RoleConfig>;
  for (const role of ROLES) {
    const d = doc.roles?.[role];
    const b = BUILTIN_ROLES[role];
    // a role that lists its own rungs never inherits the built-in default rung, which may not be among them
    const defaultRung = d?.defaultRung ?? (d?.rungs === undefined ? b.defaultRung : undefined);
    roles[role] = {
      enabled: d?.enabled ?? b.enabled,
      access: d?.access ?? DEFAULT_ACCESS[role],
      rungs: [...(d?.rungs ?? b.rungs)],
      ...(defaultRung ? { defaultRung } : {}),
    };
  }
  const harness: Profile["harness"] = {};
  for (const k of new Set([...HARNESS_KEYS, ...Object.keys(doc.harness ?? {})]))
    harness[k] = { isolated: doc.harness?.[k]?.isolated ?? false };
  const budget: Budget = {};
  for (const k of ["minutes", "tokens", "usd"] as const) {
    const v = doc.budget?.[k];
    if (v !== undefined) budget[k] = v;
  }
  return {
    name,
    objective: doc.objective ?? "cost",
    jev: { use: doc.jev?.use ?? "auto" },
    billing: { ...DEFAULT_BILLING, ...doc.billing },
    roles,
    harness,
    failover: { ...doc.failover },
    budget,
    timeouts: { idleMin: doc.timeouts?.idleMin ?? 15, wallMin: doc.timeouts?.wallMin ?? 90 },
    preflight: { confirm: doc.preflight?.confirm ?? false },
    lock: { heavy: doc.lock?.heavy ?? "cpus/2" },
    notify: [...(doc.notify ?? NOTIFY)],
  };
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Spec §7.3: `catherd-<profile>-<role>-<model slug>-<effort>`, the native subagent for a `claude:` rung. */
export function agentName(profile: string, role: Role, rung: string): string {
  const r = parseRung(rung);
  return `catherd-${profile}-${role}-${slug(r.model)}-${slug(r.effort)}`;
}

// Patches: what profile_set and `catherd profile set` accept. Strict at every level, so a misspelt key is
// refused with E_INPUT_INVALID instead of dropped (plan-2 review m9). `null` removes a map entry.
const RolePatchSchema = z
  .strictObject({
    enabled: z.boolean(),
    access: z.enum(ACCESS),
    rungs: z.array(RungSchema),
    defaultRung: RungSchema.nullable(),
  })
  .partial();

export const ProfilePatchSchema = z.strictObject({
  objective: z.enum(["cost", "speed"]).optional(),
  jev: z.strictObject({ use: z.enum(["auto", "off"]) }).optional(),
  billing: z.partialRecord(z.enum(BILLING_KEYS), z.enum(BILLING_MODES).nullable()).optional(),
  roles: z.partialRecord(z.enum(ROLES), RolePatchSchema).optional(),
  harness: z.partialRecord(z.enum(HARNESS_KEYS), z.strictObject({ isolated: z.boolean() })).optional(),
  failover: z.record(RungSchema, RungSchema.nullable()).optional(),
  budget: z
    .strictObject({ minutes: positive.nullable(), tokens: positive.nullable(), usd: positive.nullable() })
    .partial()
    .optional(),
  timeouts: z.strictObject({ idleMin: positive, wallMin: positive }).partial().optional(),
  preflight: z.strictObject({ confirm: z.boolean() }).optional(),
  lock: z.strictObject({ heavy: z.union([z.number().int().positive(), z.literal("cpus/2")]) }).optional(),
  notify: z.array(z.enum(NOTIFY)).optional(),
});
export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** RFC 7396 merge: objects merge key by key, `null` deletes, anything else (arrays too) replaces. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlain(patch)) return patch;
  const out: Record<string, unknown> = isPlain(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/** The document with `patch` applied; every field the patch does not name, known or not, is kept. */
export function applyPatch(doc: ProfileDoc, patch: ProfilePatch): ProfileDoc {
  return ProfileDocSchema.parse(mergePatch(doc, patch));
}

/** Map fields whose keys are rungs or billing keys, which may hold dots: the rest of the path is one key. */
const MAP_FIELDS = new Set(["failover", "billing"]);
const LIST_FIELDS = (keys: string[]) =>
  (keys[0] === "roles" && keys[2] === "rungs") || (keys[0] === "notify" && keys.length === 1);

/**
 * `catherd profile set <path> <value>` as a patch. The value is JSON when it parses (numbers, booleans,
 * `null`, arrays), else the plain word; a rung list may also be comma-separated.
 */
export function patchAt(path: string, raw: string): ProfilePatch {
  const segs = path.split(".");
  const keys =
    MAP_FIELDS.has(segs[0] ?? "") && segs.length > 1 ? [segs[0] as string, segs.slice(1).join(".")] : segs;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  if (LIST_FIELDS(keys) && typeof value === "string")
    value = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const patch = keys.reduceRight<unknown>((inner, k) => ({ [k]: inner }), value);
  const r = keys.some((k) => !k) ? null : ProfilePatchSchema.safeParse(patch);
  if (!r?.success)
    throw new CatherdError(
      "E_INPUT_INVALID",
      `cannot set ${path} to ${raw}${r ? `: ${z.prettifyError(r.error).replace(/\n\s*/g, " ")}` : ""}`,
      {
        fix: "catherd profile show --json lists the fields; e.g. catherd profile set roles.worker.access read-only",
      },
    );
  return r.data;
}

export interface Change {
  path: string;
  before: unknown;
  after: unknown;
}

/** Leaves by dotted path; an empty object has none, so `budget: {}` → `budget.usd: 5` is one change. */
function flatten(v: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isPlain(v)) for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  else if (v !== undefined) out.set(prefix, v);
}

/** Every leaf that differs between two profiles; lists compare whole. */
export function diffProfiles(a: Profile, b: Profile): Change[] {
  const fa = new Map<string, unknown>();
  const fb = new Map<string, unknown>();
  flatten({ ...a, name: undefined }, "", fa);
  flatten({ ...b, name: undefined }, "", fb);
  const changes: Change[] = [];
  for (const path of [...new Set([...fa.keys(), ...fb.keys()])].sort()) {
    const before = fa.get(path) ?? null;
    const after = fb.get(path) ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ path, before, after });
  }
  return changes;
}
```

In `src/domain/ids.ts`, replace:

```ts
export function parseRung(s: string): Rung {
  const colon = s.indexOf(":");
  const hash = s.lastIndexOf("#");
  const backend = s.slice(0, Math.max(colon, 0));
  const model = s.slice(colon + 1, hash);
  const effort = s.slice(hash + 1);
  if (colon < 1 || hash <= colon + 1 || !effort || !(RUNG_BACKENDS as readonly string[]).includes(backend))
```

with:

```ts
/** A model id or effort starts with a letter or digit and holds no space, so it can never read as a flag. */
const MODEL = /^[A-Za-z0-9][^\s#]*$/;
const EFFORT = /^[A-Za-z0-9][\w-]*$/;

export function parseRung(s: string): Rung {
  const colon = s.indexOf(":");
  const hash = s.lastIndexOf("#");
  const backend = s.slice(0, Math.max(colon, 0));
  const model = s.slice(colon + 1, hash);
  const effort = s.slice(hash + 1);
  if (
    colon < 1 ||
    hash <= colon + 1 ||
    !MODEL.test(model) ||
    !EFFORT.test(effort) ||
    !(RUNG_BACKENDS as readonly string[]).includes(backend)
  )
```

In `catalog/scores.json`, add the default profile's Sol stand-in to `treatLike` (Ruling 2). Replace:

```json
    "claude-opus-5-5#high": { "like": "claude-opus-5-5#xhigh", "note": "only xhigh and max are published" }
  },
```

with:

```json
    "claude-opus-5-5#high": { "like": "claude-opus-5-5#xhigh", "note": "only xhigh and max are published" },
    "opencode-go/kimi-k3#max": {
      "like": "gpt-6-sol#medium",
      "note": "the default profile's OpenCode Go stand-in for Sol; no DeepSWE 1.1, Terminal-Bench 4.0 or honesty score is published for it"
    }
  },
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun run format && bun test test/domain`
Expected: PASS (every file in `test/domain`, plan 4's catalog tests included).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint && bun run format:check`
Expected: clean.

```bash
git add src/domain/profile.ts src/domain/ids.ts catalog/scores.json test/domain/profile.test.ts test/domain/ids.test.ts
git commit -m "feat(domain): profile schema v1, the default profile with Go stand-ins, and one strict patch"
```

---

### Task 2: Validation: errors and warnings

Spec §7.1's `validate`, as a pure function over a resolved profile and plan 4's catalog. Errors block a save; warnings never do (Ruling 5). Also `quotaOf` (Ruling 3) and `inferredScores` (Ruling 2's mark).

**Files:**
- Create: `src/domain/profile-rules.ts`
- Test: `test/domain/profile-rules.test.ts`

**Interfaces:**
- Consumes: Task 1 (`Profile`); plan 4's `billingKeyOf`, `Catalog`, `capableFor`, `effortOffered`, `ROLE_NEEDS`, `RungInfo`, `rungInfo`, `scoresOf` (`src/domain/catalog.ts`), `candidates`, `clearsBar`, `RoutingProfile` (`src/domain/select.ts`), `DIFFICULTIES`, `KINDS` (`src/domain/lane.ts`); `parseRung`, `Rung`; `DEFAULT_ACCESS`, `ROLES`, `Role`. Test helper `shipped()` (`test/domain/shipped.ts`, plan 4).
- Produces: `interface Issue { path: string; message: string; fix?: string }`; `interface Validation { errors: Issue[]; warnings: Issue[] }`; `routingProfileOf(p, role): RoutingProfile`; `quotaOf(r: Rung): string`; `inferredScores(c, info): { inferred: boolean; via: string | null }`; `validateProfile(p: Profile, c: Catalog, backends: readonly string[]): Validation` (`backends`: the backends catherd can run, `claude` included).

- [ ] **Step 1: Write the failing test**

`test/domain/profile-rules.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { rungInfo } from "../../src/domain/catalog.ts";
import {
  applyPatch,
  defaultProfileDoc,
  type ProfilePatch,
  resolveProfile,
} from "../../src/domain/profile.ts";
import { inferredScores, validateProfile } from "../../src/domain/profile-rules.ts";
import { shipped } from "./shipped.ts";

const BACKENDS = ["codex", "claude-code", "opencode", "claude"];
const check = (patch: ProfilePatch = {}, c = shipped()) =>
  validateProfile(resolveProfile(applyPatch(defaultProfileDoc(), patch), "p"), c, BACKENDS);
const messages = (issues: { message: string }[]) => issues.map((i) => i.message);

describe("validateProfile", () => {
  it("passes the default profile with no error and no warning", () => {
    expect(check()).toEqual({ errors: [], warnings: [] });
  });

  it("refuses a disabled worker", () => {
    expect(check({ roles: { worker: { enabled: false } } }).errors).toContainEqual({
      path: "roles.worker.enabled",
      message: "the worker cannot be disabled",
      fix: "catherd profile set roles.worker.enabled true",
    });
  });

  it("refuses an enabled role with no usable rung, and ignores a disabled one", () => {
    expect(messages(check({ roles: { writer: { rungs: [] } } }).errors)).toEqual([
      "the writer role has no usable rung",
    ]);
    expect(check({ roles: { writer: { rungs: [], enabled: false } } }).errors).toEqual([]);
  });

  it("refuses an unscored rung until a treat-like maps it", () => {
    const rung = "opencode:opencode-go/glm-5.3#high";
    const bad = check({ roles: { reviewer: { rungs: ["codex:gpt-6-sol#high", rung] } } });
    expect(bad.errors).toContainEqual({
      path: "roles.reviewer.rungs",
      message: `${rung} is unscored`,
      fix: `map it with: catherd catalog treat-like ${rung} <a scored rung>; catalog_query lists them`,
    });
    const liked = shipped({
      override: {
        schema: 1,
        treatLike: { "opencode-go/glm-5.3#high": "gpt-6-sol#high" },
        scores: [],
        bars: {},
      },
    });
    expect(check({ roles: { reviewer: { rungs: ["codex:gpt-6-sol#high", rung] } } }, liked).errors).toEqual(
      [],
    );
  });

  it("refuses a rung on a backend catherd cannot run yet, a bad effort, and an incapable model", () => {
    const e = messages(
      check({
        roles: {
          reviewer: { rungs: ["cursor:gpt-6-sol#high", "codex:gpt-6-sol#turbo", "codex:gpt-6-sol#high"] },
          artist: { rungs: ["claude-code:claude-opus-5-5#high", "codex:gpt-6-sol#medium"] },
        },
      }).errors,
    );
    expect(e).toContain("cursor:gpt-6-sol#high: catherd cannot run cursor yet");
    expect(e).toContain(
      'gpt-6-sol has no effort "turbo" on codex (it has low, medium, high, xhigh, max, ultra)',
    );
    expect(e).toContain("claude-code:claude-opus-5-5#high cannot fill the artist role (it needs imageGen)");
  });

  it("refuses a default rung that is not on the role's ladder", () => {
    expect(messages(check({ roles: { worker: { defaultRung: "codex:gpt-6-luna#max" } } }).errors)).toEqual([
      "codex:gpt-6-luna#max is not one of the worker's rungs",
    ]);
  });

  it("warns, and never errs, on an access mode other than the role's default", () => {
    const v = check({ roles: { verifier: { access: "read-only" }, worker: { access: "full" } } });
    expect(v.errors).toEqual([]);
    expect(messages(v.warnings)).toEqual([
      "verifier runs read-only; catherd's default for it is full",
      "worker runs full; catherd's default for it is workspace-write",
    ]);
  });

  it("refuses a stand-in that is unscored or on the same quota, native claude and claude-code counting as one", () => {
    const e = messages(
      check({
        failover: {
          "codex:gpt-6-sol#high": "codex:gpt-6-luna#high",
          "codex:gpt-6-sol#medium": "opencode:opencode-go/glm-5.3#high",
          "claude:claude-opus-5-5#high": "claude-code:claude-opus-5-5#high",
        },
        roles: { architect: { rungs: ["claude:claude-opus-5-5#high"] } },
      }).errors,
    );
    expect(e).toEqual([
      "stand-in opencode:opencode-go/glm-5.3#high is unscored",
      "stand-in codex:gpt-6-luna#high draws on the same quota as codex:gpt-6-sol#high, which is out when codex:gpt-6-sol#high hits its limit",
      "stand-in claude-code:claude-opus-5-5#high draws on the same quota as claude:claude-opus-5-5#high, which is out when claude:claude-opus-5-5#high hits its limit",
    ]);
  });

  it("lets Go and Zen stand in for each other, since they bill apart", () => {
    const v = check({
      failover: { "codex:gpt-6-luna#high": null, "codex:gpt-6-sol#high": "opencode:opencode/gpt-6-sol#high" },
      roles: {},
    });
    expect(v.errors).toEqual([]);
  });

  it("warns on a stand-in that never runs, or that dispatch cannot start", () => {
    const v = check({
      failover: {
        "codex:gpt-6-astra#high": "opencode:opencode-go/kimi-k3#max",
        "codex:gpt-6-sol#high": "claude:claude-opus-5-5#high",
      },
    });
    expect(v.errors).toEqual([]);
    expect(messages(v.warnings)).toEqual([
      "stand-in claude:claude-opus-5-5#high is a native subagent: the orchestrator must start it, dispatch cannot",
      "codex:gpt-6-astra#high is on no enabled role's ladder, so this never runs",
    ]);
  });

  it("warns when the backend's last listing lacks a model, and when an unlisted model's effort cannot be checked", () => {
    const listed = shipped({
      listed: {
        codex: {
          fetchedAt: "2026-09-25T00:00:00Z",
          models: [{ id: "gpt-6-sol", efforts: ["medium", "high", "xhigh"], context: null, imageIn: true }],
        },
      },
    });
    const v = check({}, listed);
    expect(messages(v.warnings)).toContain(
      "codex's last listing does not offer gpt-6-luna; routing skips it",
    );
    const w = check({
      roles: { reviewer: { rungs: ["codex:gpt-6-sol#high", "opencode:opencode-go/kimi-k3#max"] } },
    });
    expect(messages(w.warnings)).toContain(
      "opencode:opencode-go/kimi-k3#max: catherd cannot check its effort until opencode lists its models",
    );
  });
});

describe("inferredScores", () => {
  it("marks both of the default profile's Go stand-ins inferred, and Sol not", () => {
    const c = shipped();
    expect(inferredScores(c, rungInfo(c, "opencode:opencode-go/kimi-k3#max"))).toEqual({
      inferred: true,
      via: "gpt-6-sol#medium",
    });
    expect(inferredScores(c, rungInfo(c, "opencode:opencode-go/gpt-6-luna#high"))).toEqual({
      inferred: true,
      via: null,
    });
    expect(inferredScores(c, rungInfo(c, "codex:gpt-6-sol#high")).inferred).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/domain/profile-rules.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/profile-rules.ts'`.

- [ ] **Step 3: Write the implementation**

`src/domain/profile-rules.ts`:

```ts
import {
  billingKeyOf,
  type Catalog,
  capableFor,
  effortOffered,
  ROLE_NEEDS,
  type RungInfo,
  rungInfo,
  scoresOf,
} from "./catalog.ts";
import { parseRung, type Rung } from "./ids.ts";
import { DIFFICULTIES, KINDS } from "./lane.ts";
import type { Profile } from "./profile.ts";
import { DEFAULT_ACCESS, ROLES, type Role } from "./roles.ts";
import { candidates, clearsBar, type RoutingProfile } from "./select.ts";

/** One finding of `validate`: where in the profile, what is wrong, and the action that fixes it. */
export interface Issue {
  path: string;
  message: string;
  fix?: string;
}

export interface Validation {
  errors: Issue[];
  warnings: Issue[];
}

const TREAT_LIKE_FIX = (rung: string) =>
  `map it with: catherd catalog treat-like ${rung} <a scored rung>; catalog_query lists them`;

export const routingProfileOf = (p: Profile, role: Role): RoutingProfile => ({
  objective: p.objective,
  billing: p.billing,
  role: p.roles[role],
});

/**
 * Spec §7.1 and §4.5: a stand-in on the same quota would be out of quota too. The billing key names the
 * quota, except that the native `claude` path and headless `claude-code` both draw on the Claude plan.
 */
export const quotaOf = (r: Rung): string => (billingKeyOf(r) === "claude" ? "claude-code" : billingKeyOf(r));

function parsed(rung: string): Rung | null {
  try {
    return parseRung(rung);
  } catch {
    return null;
  }
}

/** Whether a rung's scores are catherd's guess: borrowed through a treat-like, or only `inferred` ones. */
export function inferredScores(c: Catalog, info: RungInfo): { inferred: boolean; via: string | null } {
  const s = scoresOf(c, info.canonical);
  if (!s) return { inferred: false, via: null };
  const records = Object.values(s.records);
  return { inferred: s.via !== null || records.every((r) => r.confidence === "inferred"), via: s.via };
}

/**
 * Spec §7.1. Errors: the worker disabled; an enabled role with no usable rung; an unscored rung without a
 * treat-like; a failover stand-in unscored or on the same quota; a rung whose backend catherd cannot run
 * (`backends` lists those it can, `claude` included). Everything else worth knowing is a warning: an access
 * mode other than the role's default, an effort or model the last listing does not offer, a stand-in
 * that never runs.
 */
export function validateProfile(p: Profile, c: Catalog, backends: readonly string[]): Validation {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if (!p.roles.worker.enabled)
    errors.push({
      path: "roles.worker.enabled",
      message: "the worker cannot be disabled",
      fix: "catherd profile set roles.worker.enabled true",
    });

  for (const role of ROLES) {
    const rc = p.roles[role];
    const at = `roles.${role}`;
    if (rc.access !== DEFAULT_ACCESS[role])
      warnings.push({
        path: `${at}.access`,
        message: `${role} runs ${rc.access}; catherd's default for it is ${DEFAULT_ACCESS[role]}`,
      });
    if (!rc.enabled) continue;
    for (const rung of rc.rungs) {
      const r = parsed(rung);
      if (!r) {
        errors.push({
          path: `${at}.rungs`,
          message: `"${rung}" is not a rung`,
          fix: "write it as <backend>:<model>#<effort>",
        });
        continue;
      }
      if (!backends.includes(r.backend)) {
        errors.push({
          path: `${at}.rungs`,
          message: `${rung}: catherd cannot run ${r.backend} yet`,
          fix: `use a rung on ${backends.join(", ")}`,
        });
        continue;
      }
      const info = rungInfo(c, rung);
      if (!capableFor(c, info, role))
        errors.push({
          path: `${at}.rungs`,
          message: `${rung} cannot fill the ${role} role (it needs ${Object.keys(ROLE_NEEDS[role]).join(" + ")})`,
          fix: `catalog_query({ role: "${role}" }) lists the models that can`,
        });
      if (info.efforts.length > 0 && !effortOffered(info))
        errors.push({
          path: `${at}.rungs`,
          message: `${r.model} has no effort "${r.effort}" on ${r.backend} (it has ${info.efforts.join(", ")})`,
        });
      else if (info.efforts.length === 0 && r.effort !== "default")
        warnings.push({
          path: `${at}.rungs`,
          message: `${rung}: catherd cannot check its effort until ${r.backend} lists its models`,
          fix: "catherd catalog refresh",
        });
      if (info.listed === false)
        warnings.push({
          path: `${at}.rungs`,
          message: `${r.backend}'s last listing does not offer ${r.model}; routing skips it`,
        });
      if (!scoresOf(c, info.canonical))
        errors.push({ path: `${at}.rungs`, message: `${rung} is unscored`, fix: TREAT_LIKE_FIX(rung) });
    }
    if (rc.defaultRung !== undefined && !rc.rungs.includes(rc.defaultRung))
      errors.push({
        path: `${at}.defaultRung`,
        message: `${rc.defaultRung} is not one of the ${role}'s rungs`,
        fix: `catherd profile set ${at}.defaultRung null, or add it to ${at}.rungs`,
      });
    const usable = candidates(c, routingProfileOf(p, role), role);
    if (usable.length === 0)
      errors.push({
        path: `${at}.rungs`,
        message: `the ${role} role has no usable rung`,
        fix: `enable a scored rung its backend offers, or turn the role off with: catherd profile set ${at}.enabled false`,
      });
    else if (role === "worker" && usable.length > 1) {
      const missed = KINDS.flatMap((k) =>
        DIFFICULTIES.filter((d) => !usable.some((x) => clearsBar(c, x, k, d))).map((d) => `${k}/${d}`),
      );
      if (missed.length)
        warnings.push({
          path: `${at}.rungs`,
          message: `no worker rung clears the bar for ${missed.join(", ")}; those lanes start at the default rung`,
        });
    }
  }

  const ladders = new Set(ROLES.filter((r) => p.roles[r].enabled).flatMap((r) => p.roles[r].rungs));
  for (const [from, to] of Object.entries(p.failover)) {
    const at = `failover.${from}`;
    const a = parsed(from);
    const b = parsed(to);
    if (!a || !b) {
      errors.push({
        path: at,
        message: `"${!a ? from : to}" is not a rung`,
        fix: "write it as <backend>:<model>#<effort>",
      });
      continue;
    }
    if (!backends.includes(b.backend)) {
      errors.push({ path: at, message: `stand-in ${to}: catherd cannot run ${b.backend} yet` });
      continue;
    }
    if (!scoresOf(c, rungInfo(c, to).canonical))
      errors.push({ path: at, message: `stand-in ${to} is unscored`, fix: TREAT_LIKE_FIX(to) });
    if (quotaOf(a) === quotaOf(b))
      errors.push({
        path: at,
        message: `stand-in ${to} draws on the same quota as ${from}, which is out when ${from} hits its limit`,
        fix: "name a stand-in on another backend or plan",
      });
    if (b.backend === "claude")
      warnings.push({
        path: at,
        message: `stand-in ${to} is a native subagent: the orchestrator must start it, dispatch cannot`,
      });
    if (!ladders.has(from))
      warnings.push({ path: at, message: `${from} is on no enabled role's ladder, so this never runs` });
  }
  return { errors, warnings };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run format && bun test test/domain/profile-rules.test.ts`
Expected: PASS (12 tests). The first one pins that the default profile, Go stand-ins included, validates with no error and no warning on the shipped catalog.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint && bun run format:check`
Expected: clean.

```bash
git add src/domain/profile-rules.ts test/domain/profile-rules.test.ts
git commit -m "feat(domain): profile validation with errors that block a save and warnings that do not"
```

---

### Task 3: Role prompts and native agent files

The native Claude subagents' files (spec §7.3), now per profile and per role access (D10), with the role prompts moved into the domain layer. The read-only researcher is no longer asked to measure the full suite, which it cannot run without a shell (plan-3 re-review).

**Files:**
- Create: `src/domain/role-prompts.ts` (from `src/profile/role-prompts.ts`, which stays until Task 6), `src/domain/agents.ts`
- Test: `test/domain/agents.test.ts`

**Interfaces:**
- Consumes: Task 1 (`agentName`, `Profile`, `applyPatch`, `defaultProfileDoc`, `resolveProfile`); `parseRung`; `Access`; `ROLES`, `Role`.
- Produces: `rolePrompt(role, version): string`; `nativeDisallowedTools(access): string[]`; `interface AgentFile { name; role; rung; text }`; `renderAgent(o: { profile; role; rung; access; version }): string`; `agentFiles(p: Profile, version: string): AgentFile[]` (sorted by name).

- [ ] **Step 1: Write the failing test**

`test/domain/agents.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { agentFiles, renderAgent } from "../../src/domain/agents.ts";
import {
  applyPatch,
  defaultProfileDoc,
  type ProfilePatch,
  resolveProfile,
} from "../../src/domain/profile.ts";
import { rolePrompt } from "../../src/domain/role-prompts.ts";

const profile = (patch: ProfilePatch = {}, name = "default") =>
  resolveProfile(applyPatch(defaultProfileDoc(name), patch), name);

describe("agentFiles", () => {
  it("writes one file per enabled role and native rung of the default profile", () => {
    const files = agentFiles(profile(), "1.0.0");
    expect(files.map((f) => [f.name, f.role, f.rung])).toEqual([
      ["catherd-default-architect-claude-opus-5-5-high", "architect", "claude:claude-opus-5-5#high"],
      ["catherd-default-verifier-claude-opus-5-5-low", "verifier", "claude:claude-opus-5-5#low"],
    ]);
    expect(files[0]?.text).toStartWith(
      [
        "---",
        "name: catherd-default-architect-claude-opus-5-5-high",
        "description: Internal architect role of the catherd orchestrator (profile default), on claude-opus-5-5 at high effort. Dispatched only by the catherd skill while a run is in flight. Never for a plain request, even one that names this role.",
        "model: claude-opus-5-5",
        "effort: high",
        "disallowedTools: Write, Edit, NotebookEdit, Agent",
        "---",
        "",
        "You are the architect of a catherd run.",
      ].join("\n"),
    );
  });

  it("takes the tool list from the role's access, not from the role", () => {
    const [verifier] = agentFiles(profile({ roles: { architect: { enabled: false } } }), "1.0.0");
    expect(verifier?.text).toContain("\ndisallowedTools: Agent\n");
    const [ro] = agentFiles(
      profile({ roles: { architect: { enabled: false }, verifier: { access: "read-only" } } }),
      "1.0.0",
    );
    expect(ro?.text).toContain("\ndisallowedTools: Write, Edit, NotebookEdit, Agent\n");
  });

  it("skips disabled roles and headless rungs, and counts a native stand-in", () => {
    const p = profile({
      roles: {
        architect: { enabled: false },
        verifier: { rungs: ["claude-code:claude-opus-5-5#low"] },
      },
      failover: { "codex:gpt-6-sol#high": "claude:claude-sonnet-5#high" },
    });
    expect(agentFiles(p, "1.0.0").map((f) => f.name)).toEqual([
      "catherd-default-reviewer-claude-sonnet-5-high",
      "catherd-default-worker-claude-sonnet-5-high",
    ]);
  });

  it("leaves the effort out for a model that takes none", () => {
    const text = renderAgent({
      profile: "p",
      role: "verifier",
      rung: "claude:claude-haiku-4-5-20251001#default",
      access: "full",
      version: "1.0.0",
    });
    expect(text).toContain("\nmodel: claude-haiku-4-5-20251001\ndisallowedTools: Agent\n");
  });
});

describe("rolePrompt", () => {
  it("names the catherd version whose lock the worker uses", () => {
    expect(rolePrompt("worker", "1.2.3")).toContain("bunx catherd-cli@1.2.3 lock -- <command>");
  });

  it("never asks the read-only researcher to run the suite for its time", () => {
    const text = rolePrompt("researcher", "1.0.0");
    expect(text).toContain("how long the full suite takes when the docs, the CI config or a log say so");
    expect(text).toContain('never run the suite to find out; write "unknown" instead');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/domain/agents.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/agents.ts'`.

- [ ] **Step 3: Write the implementation**

`src/domain/role-prompts.ts` (the 0.x prompts with three changes: the worker's prompt takes the version as a parameter instead of importing the 0.x `VERSION`, the researcher's dossier sentence no longer asks it to time the suite, and the tool lists derive from the role's access):

```ts
import type { Access } from "./record.ts";
import type { Role } from "./roles.ts";

// The role prompts of the native Claude subagents, ported from 0.x (spec D9). Headless backends get the
// same text from the orchestrator's briefs; only native agents carry it in their agent file.

const RUN_FILES =
  "The run folder is outside the project. Read and write it only through the catherd MCP tools read_run_file and write_run_file (in the tool list as mcp__plugin_catherd_catherd__read_run_file and mcp__plugin_catherd_catherd__write_run_file), with the run id the orchestrator gave you. Paths are relative to the run folder.";

const REPLY =
  "Do not commit. Reply in at most 15 lines: results, file:line, and evidence as a log path, not the log. The last line of your reply is: STATUS: complete|partial|blocked|refused — <one line why>";

const architect = [
  "You are the architect of a catherd run. The orchestrator gave you the goal, the acceptance lines, the run id, and usually a dossier: a researcher's map of the code this work touches. Workers are other models that run in the project directory with no memory of this conversation. They will write every line of code from your plan.",
  "",
  `Start from the dossier. Open a project file yourself only to settle a decision the dossier leaves open, and read each file once. Bash is for inspection only. Change nothing in the project. ${RUN_FILES}`,
  "",
  "Write plan.md with exactly these parts, in this order:",
  "",
  "1. Decisions D1…Dn: each one is a choice, the alternative you rejected, and one line on why. Cover only choices where two reasonable engineers would differ.",
  "2. Milestones M1…Mn: each one is a shippable step with its own acceptance lines and its full check (the command that proves the whole milestone). Order them so each builds on the last.",
  "3. Lanes inside each milestone, M1.L1…: each lane gives",
  "   - the files it owns (two lanes of one milestone never share a file);",
  "   - what changes, stated as behavior plus the exact signatures and data shapes it introduces;",
  "   - its fast check: the targeted command a worker reruns while it works, seconds to a minute or two.",
  "",
  "   Every lane of a milestone runs at the same time, so split for width: more small lanes beat one long one.",
  "4. Speed: if the full check takes more than about five minutes, name why and make speeding it up (parallel tests, one shared fixture, fewer real-time waits) a lane of the first milestone.",
  "5. Edge cases the tests must pin, one line each.",
  "6. Out of scope: what no worker may touch.",
  "",
  "Then write one file per lane, lanes/Mx.Ly.md. It is everything that worker needs and nothing else: the lane's section, the decisions and edge cases it relies on (copied, not referenced), and the out-of-scope lines. A worker reads its lane file, never plan.md. Its first three lines are exactly:",
  "",
  "    # Mx.Ly — <one line>",
  "    Owns: <repo-relative paths, comma-separated>",
  "    Fast check: <command>",
  "",
  "catherd reads the Owns: line to keep two running lanes off the same file, and to tell a refusal (owned files unchanged) from work.",
  "",
  "Signatures, data shapes and test case names are yours. Function bodies are the worker's. A plan that contains the implementation turns the worker into a typist and spends the most expensive model on typing.",
  "",
  "Prefer the smallest design that meets the acceptance lines: no abstraction with one implementation, no config for a value that never changes, no comments restating code.",
  "",
  "Your reply to the orchestrator is short: the milestones, each with its lanes as Mx.Ly — one line — owned files, and the full-check command per milestone. The detail lives in the files.",
  "",
  "When the orchestrator sends you a design finding later, answer with a delta: rewrite the affected lane files and the matching plan.md sections, and reply with what changed.",
].join("\n");

const verifier = [
  "You verify work you did not write. You get the acceptance lines, the check command and how to run the thing. You do not get the author's account of it, and you should not look for one.",
  "",
  "1. Run the check command once. Report its exit code and the failing lines.",
  "2. Exercise every acceptance line through the real entry point: the CLI, the HTTP route, the page. Read source only to find that entry point. When a line needs data or files, build them in a temporary directory outside the project.",
  "3. Read the diff (git diff plus untracked files) for bugs the acceptance lines miss: wrong edge behavior, dead code, leftovers.",
  "",
  "Change nothing in the project. Do not write mutation tests or extra proof tests. The job is to find out whether the work is right, not to grade its test suite.",
  "",
  "Return, in this order:",
  "- VERDICT: PASS or VERDICT: FAIL on the first line.",
  "- One line per acceptance line: A<n> PASS|FAIL, the command you ran and the decisive output.",
  "- Bugs outside the acceptance lines: file:line, what happens, the input that triggers it.",
  "- What you could not check, and why.",
].join("\n");

const worker = (version: string) =>
  [
    "You are a worker in a catherd run. The orchestrator's message is your brief: the acceptance lines, the lane file to read, the files you own and the files you must not touch, and your fast check.",
    "",
    `Read your lane file first. ${RUN_FILES} If the project has a CLAUDE.md or AGENTS.md, follow it.`,
    "",
    `Change only the files you own. Run your fast check until it passes. Run the full suite only if the brief says so, and wrap any full build or full test suite in: bunx catherd-cli@${version} lock -- <command>. Other lanes share this machine.`,
    "",
    REPLY,
  ].join("\n");

const reviewer = [
  "You review a milestone's diff that you did not write. The brief gives the acceptance lines and the changed files; read new files in full. Change nothing in the project.",
  "",
  "Report every finding as: BLOCKER|BUG|NIT file:line — problem — fix. Cover:",
  "- unmet acceptance lines and edge cases;",
  "- code or abstractions nobody needs;",
  "- comments that restate code;",
  "- tests that assert nothing.",
  "",
  "With no finding, the reply is CLEAN.",
  "",
  REPLY,
].join("\n");

const uiReviewer = [
  "You review the screens a milestone changed, from screenshots. The brief gives the URL, the changed screens by route, the viewports and the themes. Change nothing in the project.",
  "",
  "Take each screenshot with agent-browser screenshot <path> at viewport size, not full page, to the paths the brief names, and open each PNG yourself before you judge it.",
  "",
  "Report every finding as: BLOCKER|BUG|NIT <screen> — problem — fix — <screenshot path>, always with the path.",
  "",
  REPLY,
].join("\n");

const artist = [
  "You make the images a screen needs. The brief gives, per image, the screen, where the image sits, its shape, the mood and scene in words, and the final .webp path in the project.",
  "",
  "Use your built-in image tool, and copy its untouched output. The only processing is cwebp -q 85 in.png -o out.webp. Never paint, patch or upscale. Never redraw a real logo, and never present a generated person as a real customer. Add one provenance line per image to a README.md beside it.",
  "",
  REPLY,
].join("\n");

const writer = [
  "You write the docs a milestone needs: README, docs pages, the changelog, or a merge request body, as the brief says. The brief names the files you own; change nothing else. Write plainly, and describe what the code does now, not how it got there.",
  "",
  REPLY,
].join("\n");

const researcher = [
  "You answer a factual question about the code, or map it for a dossier. Change nothing in the project. Give file:line for every claim.",
  "",
  `A dossier lists: the files and folders involved, one line each on what they hold; the existing patterns the work should copy, by path; the build, test and run commands, with how long the full suite takes when the docs, the CI config or a log say so (never run the suite to find out; write "unknown" instead); the symbols the change will call or alter, with their signatures; the project rules (CLAUDE.md, AGENTS.md, conventions) that bind this work; and risks: shared files, generated code, slow or flaky tests. It may run to 200 lines. Write it with write_run_file to the path the brief names, and reply with that path. ${RUN_FILES}`,
  "",
  "For a single question, reply in at most 15 lines. The last line of your reply is: STATUS: complete|partial|blocked|refused — <one line why>",
].join("\n");

const BODIES: Record<Role, (version: string) => string> = {
  architect: () => architect,
  verifier: () => verifier,
  worker,
  reviewer: () => reviewer,
  "ui-reviewer": () => uiReviewer,
  artist: () => artist,
  writer: () => writer,
  researcher: () => researcher,
};

/** The role's prompt; the worker's names the catherd version whose `lock` it must use. */
export const rolePrompt = (role: Role, version: string): string => BODIES[role](version);

/**
 * Spec D10 for native subagents, whose only lever is the agent file's tool list: read-only drops the
 * editing tools (its Bash stays, for inspection, so enforcement is advisory); every role drops Agent,
 * so a role never spawns its own subagents.
 */
export const nativeDisallowedTools = (access: Access): string[] =>
  access === "read-only" ? ["Write", "Edit", "NotebookEdit", "Agent"] : ["Agent"];
```

`src/domain/agents.ts`:

```ts
import { parseRung } from "./ids.ts";
import { agentName, type Profile } from "./profile.ts";
import type { Access } from "./record.ts";
import { nativeDisallowedTools, rolePrompt } from "./role-prompts.ts";
import { ROLES, type Role } from "./roles.ts";

export interface AgentFile {
  /** the agent's name, also its file name without `.md` */
  name: string;
  role: Role;
  rung: string;
  text: string;
}

/** One native subagent's file: Claude Code reads `name`, `model`, `effort` and the tool list. */
export function renderAgent(o: {
  profile: string;
  role: Role;
  rung: string;
  access: Access;
  version: string;
}): string {
  const { model, effort } = parseRung(o.rung);
  return [
    "---",
    `name: ${agentName(o.profile, o.role, o.rung)}`,
    `description: Internal ${o.role} role of the catherd orchestrator (profile ${o.profile}), on ${model} at ${effort} effort. Dispatched only by the catherd skill while a run is in flight. Never for a plain request, even one that names this role.`,
    `model: ${model}`,
    ...(effort === "default" ? [] : [`effort: ${effort}`]),
    `disallowedTools: ${nativeDisallowedTools(o.access).join(", ")}`,
    "---",
    "",
    rolePrompt(o.role, o.version),
    "",
  ].join("\n");
}

/**
 * Spec §7.3: an agent file per enabled role and native `claude:` rung, counting a native stand-in for one
 * of the role's rungs, since dispatch hands those to the orchestrator as an Agent to start.
 */
export function agentFiles(p: Profile, version: string): AgentFile[] {
  const out = new Map<string, AgentFile>();
  for (const role of ROLES) {
    const rc = p.roles[role];
    if (!rc.enabled) continue;
    const rungs = [...rc.rungs, ...rc.rungs.flatMap((r) => p.failover[r] ?? [])];
    for (const rung of rungs) {
      let native: boolean;
      try {
        native = parseRung(rung).backend === "claude";
      } catch {
        continue;
      }
      if (!native) continue;
      const name = agentName(p.name, role, rung);
      out.set(name, {
        name,
        role,
        rung,
        text: renderAgent({ profile: p.name, role, rung, access: rc.access, version }),
      });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run format && bun test test/domain/agents.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint && bun run format:check`
Expected: clean.

```bash
git add src/domain/role-prompts.ts src/domain/agents.ts test/domain/agents.test.ts
git commit -m "feat(domain): native agent files per profile and access, and a researcher that never times the suite"
```

---

### Task 4: The ProfileService

Spec §7.3: the single writer. Reads are plain; every write holds one lock over profiles, `config.json`, `projects.json`, the agent files and the links (Ruling 7), validates before it writes, rewrites the agent files of every linked profile, relinks the union of the active and repo-bound profiles, never touches a file it does not own, and returns the agents that need a new Claude Code session. A 0.x file is refused with the `catherd init` fix. This task adds `withFileLockSync` and the Claude paths to the infra layer.

**Files:**
- Create: `src/services/profile-service.ts`
- Modify: `src/infra/filelock.ts`, `src/infra/paths.ts`
- Test: `test/services/profile-service.test.ts`, `test/infra/filelock.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; plan 4's `loadCatalog` (`src/services/catalog-service.ts`); `ADAPTER_IDS` (`src/adapters/backend.ts`), `adapterFor` (`src/adapters/registry.ts`); `writeJsonAtomic`, `writeTextAtomic` (`src/infra/store.ts`); `VERSION` (`src/infra/version.ts`); `configDir` (`src/infra/paths.ts`).
- Produces:
  - `withFileLockSync<T>(target, fn: () => T, o?: { timeoutMs?; pollMs? }): T` (`src/infra/filelock.ts`); `claudeHome(): string`, `claudeAgentsDir(): string` (`src/infra/paths.ts`).
  - `profilesDir()`, `configFile()`, `projectsFile()`, `agentsRoot()`; `type Config`, `type Projects`; `readConfig(): Config`; `readProjects(): Projects`; `listProfiles(): string[]`; `profileExists(name): boolean`; `readProfileDoc(name): ProfileDoc`; `getProfile(name): Profile`; `activeName(repo: string | null = null): string`; `profileFor(repo: string | null): Profile`; `runnableBackends(): string[]`; `validateNamed(name?): Validation`; `enforcementOf(rung, access): "enforced" | "advisory"`; `roleEnforcement(p): Record<Role, "enforced" | "advisory">`; `linkedProfiles(): string[]`; `interface Synced { linked: string[]; pruned: string[]; newSessionNeededFor: string[] }`; `agentLinkState(): { missing: string[]; stale: string[]; ok: string[] }`; `countLinkedAgents(): number`; `interface Saved extends Synced { saved; errors: Issue[]; warnings: Issue[]; diff: Change[] }`; `patchProfile(name: string | undefined, patch): Saved`; `createProfile(name, from?): Saved`; `resetProfile(name): Saved`; `deleteProfile(name): Synced`; `activate(name, repo: string | null = null): Synced & { active; repo }`; `relink(): Synced`; `diffNamed(a, b): Change[]`.

- [ ] **Step 1: Write the failing tests**

`test/services/profile-service.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { claudeAgentsDir, configDir } from "../../src/infra/paths.ts";
import {
  activate,
  activeName,
  agentLinkState,
  agentsRoot,
  createProfile,
  deleteProfile,
  diffNamed,
  enforcementOf,
  getProfile,
  linkedProfiles,
  listProfiles,
  patchProfile,
  profileFor,
  profilesDir,
  readProfileDoc,
  relink,
  resetProfile,
  roleEnforcement,
  validateNamed,
} from "../../src/services/profile-service.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const ARCHITECT = "catherd-default-architect-claude-opus-5-5-high";
const VERIFIER = "catherd-default-verifier-claude-opus-5-5-low";
const DEFAULT_AGENTS = [ARCHITECT, VERIFIER];
const links = () => (existsSync(claudeAgentsDir()) ? readdirSync(claudeAgentsDir()).sort() : []);
const file = (name: string) => join(profilesDir(), `${name}.json`);

describe("reading profiles", () => {
  it("serves the built-in default before any file exists", () => {
    withHome();
    expect(listProfiles()).toEqual(["default"]);
    expect(activeName()).toBe("default");
    expect(profileFor(null).roles.worker.defaultRung).toBe("codex:gpt-6-sol#medium");
    expect(validateNamed()).toEqual({ errors: [], warnings: [] });
  });

  it("refuses a 0.x profile with the init fix, and a newer schema with the upgrade fix", () => {
    withHome();
    mkdirSync(profilesDir(), { recursive: true });
    writeFileSync(file("old"), JSON.stringify({ name: "old", objective: "cost", roles: {} }));
    expect(() => readProfileDoc("old")).toThrow(
      expect.objectContaining({
        code: "E_CONFIG_INVALID",
        fix: "run catherd init, which moves 0.x files aside and writes 1.0 ones",
      }),
    );
    writeFileSync(file("new"), JSON.stringify({ schema: 2 }));
    expect(() => readProfileDoc("new")).toThrow(expect.objectContaining({ code: "E_CONFIG_NEWER_SCHEMA" }));
  });
});

describe("patchProfile", () => {
  it("creates a missing profile from the default, and keeps fields it does not know", () => {
    withHome();
    const r = patchProfile("default", { budget: { usd: 5 } });
    expect([r.saved, r.errors, r.diff]).toEqual([true, [], [{ path: "budget.usd", before: null, after: 5 }]]);
    const doc = JSON.parse(readFileSync(file("default"), "utf8"));
    writeFileSync(
      file("default"),
      JSON.stringify({ ...doc, theme: "ginger", roles: { ...doc.roles, tester: { enabled: true } } }),
    );
    patchProfile(undefined, { timeouts: { idleMin: 5 } });
    const after = JSON.parse(readFileSync(file("default"), "utf8"));
    expect([after.theme, after.roles.tester, after.budget, after.timeouts]).toEqual([
      "ginger",
      { enabled: true },
      { usd: 5 },
      { idleMin: 5, wallMin: 90 },
    ]);
  });

  it("writes nothing when the result is invalid, and returns the errors", () => {
    withHome();
    patchProfile("default", {});
    const before = readFileSync(file("default"), "utf8");
    const r = patchProfile("default", { roles: { worker: { enabled: false } } });
    expect(r.saved).toBe(false);
    expect(r.errors.map((e) => e.message)).toEqual(["the worker cannot be disabled"]);
    expect(readFileSync(file("default"), "utf8")).toBe(before);
  });

  it("stores rungs and failover keys as written, and every field profile_set can set", () => {
    withHome();
    const r = patchProfile("default", {
      roles: { reviewer: { rungs: ["claude-code:claude-opus-5-5#high"], access: "read-only" } },
      failover: { "claude-code:claude-opus-5-5#high": "codex:gpt-6-sol#high" },
      harness: { "claude-code": { isolated: true } },
      jev: { use: "off" },
      billing: { opencode: "subscription" },
      preflight: { confirm: true },
    });
    expect(r.errors).toEqual([]);
    const p = getProfile("default");
    expect(p.failover["claude-code:claude-opus-5-5#high"]).toBe("codex:gpt-6-sol#high");
    expect([p.harness["claude-code"], p.jev, p.billing.opencode, p.preflight]).toEqual([
      { isolated: true },
      { use: "off" },
      "subscription",
      { confirm: true },
    ]);
  });

  it("serialises writers across processes, so no update is lost", async () => {
    const home = withHome();
    const svc = join(import.meta.dir, "..", "..", "src", "services", "profile-service.ts");
    const writer = (field: string) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `const { patchProfile } = await import(${JSON.stringify(svc)});
           for (let i = 1; i <= 8; i++) patchProfile("default", ${field === "budget" ? "{ budget: { minutes: i } }" : "{ timeouts: { idleMin: i } }"});`,
        ],
        { env: { ...process.env, CATHERD_HOME: home }, stdout: "ignore", stderr: "inherit" },
      );
    const [a, b] = [writer("budget"), writer("timeouts")];
    expect([await a.exited, await b.exited]).toEqual([0, 0]);
    const p = getProfile("default");
    expect([p.budget.minutes, p.timeouts.idleMin]).toEqual([8, 8]);
    expect(existsSync(join(configDir(), "profiles.lock"))).toBe(false);
  }, 30_000);
});

describe("agent files and links", () => {
  it("links the active profile's native agents and says a new session needs them", () => {
    withHome();
    const r = patchProfile("default", {});
    expect(r.newSessionNeededFor).toEqual(DEFAULT_AGENTS);
    expect(links()).toEqual(DEFAULT_AGENTS.map((a) => `${a}.md`));
    const link = join(claudeAgentsDir(), `${ARCHITECT}.md`);
    expect(readlinkSync(link)).toBe(join(agentsRoot(), "default", `${ARCHITECT}.md`));
    expect(patchProfile("default", { budget: { usd: 1 } }).newSessionNeededFor).toEqual([]);
  });

  it("relinks on a change: the new agent is linked and needs a session, the old one is pruned", () => {
    withHome();
    patchProfile("default", {});
    const r = patchProfile("default", { roles: { verifier: { rungs: ["claude:claude-opus-5-5#medium"] } } });
    expect(r.newSessionNeededFor).toEqual(["catherd-default-verifier-claude-opus-5-5-medium"]);
    expect(r.pruned).toEqual(["catherd-default-verifier-claude-opus-5-5-low.md"]);
    expect(readdirSync(join(agentsRoot(), "default")).sort()).toEqual([
      "catherd-default-architect-claude-opus-5-5-high.md",
      "catherd-default-verifier-claude-opus-5-5-medium.md",
    ]);
  });

  it("asks for a new session when an agent's file changes under the same name", () => {
    withHome();
    patchProfile("default", {});
    const r = patchProfile("default", { roles: { verifier: { access: "read-only" } } });
    expect(r.newSessionNeededFor).toEqual(["catherd-default-verifier-claude-opus-5-5-low"]);
  });

  it("links the active profile and every repo-bound one, and a non-active save links nothing new", () => {
    withHome();
    patchProfile("default", {});
    createProfile("fast");
    expect(links()).toEqual(DEFAULT_AGENTS.map((a) => `${a}.md`));
    expect(existsSync(join(agentsRoot(), "fast"))).toBe(true);
    const r = activate("fast", "/r/app");
    expect(r.newSessionNeededFor).toEqual([
      "catherd-fast-architect-claude-opus-5-5-high",
      "catherd-fast-verifier-claude-opus-5-5-low",
    ]);
    expect(links()).toHaveLength(4);
    expect([activeName(), activeName("/r/app"), activeName("/r/other")]).toEqual([
      "default",
      "fast",
      "default",
    ]);
  });

  it("never touches a file it does not own, and refuses to save over one", () => {
    withHome();
    mkdirSync(claudeAgentsDir(), { recursive: true });
    writeFileSync(join(claudeAgentsDir(), "mine.md"), "---\nname: mine\n---\n");
    patchProfile("default", {});
    expect(readFileSync(join(claudeAgentsDir(), "mine.md"), "utf8")).toContain("name: mine");
    writeFileSync(join(claudeAgentsDir(), "catherd-default-verifier-claude-opus-5-5-medium.md"), "user file");
    const before = readFileSync(file("default"), "utf8");
    expect(() =>
      patchProfile("default", { roles: { verifier: { rungs: ["claude:claude-opus-5-5#medium"] } } }),
    ).toThrow(expect.objectContaining({ code: "E_CONFIG_INVALID" }));
    expect(readFileSync(file("default"), "utf8")).toBe(before);
    expect(
      lstatSync(
        join(claudeAgentsDir(), "catherd-default-verifier-claude-opus-5-5-medium.md"),
      ).isSymbolicLink(),
    ).toBe(false);
  });

  it("reports missing and stale links, and relink makes them current", () => {
    withHome();
    patchProfile("default", {});
    expect(agentLinkState()).toEqual({ missing: [], stale: [], ok: DEFAULT_AGENTS });
    writeFileSync(join(agentsRoot(), "default", `${ARCHITECT}.md`), "edited");
    rmSync(join(claudeAgentsDir(), `${VERIFIER}.md`));
    expect(agentLinkState()).toEqual({ missing: [VERIFIER], stale: [ARCHITECT], ok: [] });
    relink();
    expect(agentLinkState().ok).toEqual(DEFAULT_AGENTS);
  });
});

describe("create, delete, diff", () => {
  it("copies a profile, and refuses a name that exists", () => {
    withHome();
    patchProfile("default", { objective: "speed" });
    expect(createProfile("fast", "default").saved).toBe(true);
    expect(getProfile("fast").objective).toBe("speed");
    expect(JSON.parse(readFileSync(file("fast"), "utf8")).name).toBe("fast");
    expect(() => createProfile("fast")).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
    expect(diffNamed("default", "fast")).toEqual([]);
  });

  it("refuses to delete the active or a bound profile; deletes another with its agent files", () => {
    withHome();
    patchProfile("default", {});
    createProfile("fast");
    createProfile("team");
    activate("team", "/r/app");
    expect(() => deleteProfile("default")).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
    expect(() => deleteProfile("team")).toThrow(/bound to \/r\/app/);
    deleteProfile("fast");
    expect(listProfiles()).toEqual(["default", "team"]);
    expect(existsSync(join(agentsRoot(), "fast"))).toBe(false);
  });
});

describe("resetProfile and linkedProfiles", () => {
  it("writes the default profile over a changed one, and links it when it is linked", () => {
    withHome();
    patchProfile("default", {
      budget: { usd: 3 },
      roles: { verifier: { rungs: ["claude:claude-opus-5-5#max"] } },
    });
    const r = resetProfile("default");
    expect([r.saved, getProfile("default").budget]).toEqual([true, {}]);
    expect(r.newSessionNeededFor).toEqual(["catherd-default-verifier-claude-opus-5-5-low"]);
    expect(r.pruned).toEqual(["catherd-default-verifier-claude-opus-5-5-max.md"]);
  });

  it("lists the active profile and every repo-bound one, once each", () => {
    withHome();
    createProfile("fast");
    createProfile("team");
    activate("fast", "/r/a");
    activate("fast", "/r/b");
    expect(linkedProfiles()).toEqual(["default", "fast"]);
  });
});

describe("enforcement", () => {
  it("is the backend's for the role's access, and advisory for native Claude", () => {
    expect(enforcementOf("codex:gpt-6-sol#high", "read-only")).toBe("enforced");
    expect(enforcementOf("claude-code:claude-sonnet-5#high", "read-only")).toBe("advisory");
    expect(enforcementOf("claude:claude-opus-5-5#high", "read-only")).toBe("advisory");
    withHome();
    expect(roleEnforcement(getProfile("default"))).toMatchObject({
      architect: "advisory",
      worker: "enforced",
      reviewer: "enforced",
    });
  });
});
```

In `test/infra/filelock.test.ts`, import `withFileLockSync` as well. Replace:

```ts
import { withFileLock } from "../../src/infra/filelock.ts";
```

with:

```ts
import { withFileLock, withFileLockSync } from "../../src/infra/filelock.ts";
```

and append:

```ts
describe("withFileLockSync", () => {
  it("runs the section holding the lock, then releases it", () => {
    const t = target();
    expect(withFileLockSync(t, () => existsSync(`${t}.lock`))).toBe(true);
    expect(existsSync(`${t}.lock`)).toBe(false);
  });

  it("reclaims a dead holder's lock, and times out with E_IO_LOCK behind a live one", async () => {
    const t = target();
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(`${t}.lock`, JSON.stringify({ pid: dead.pid, startTime: "gone" }));
    expect(withFileLockSync(t, () => 7, { timeoutMs: 1000, pollMs: 5 })).toBe(7);
    writeFileSync(`${t}.lock`, JSON.stringify({ pid: process.pid, startTime: null }));
    expect(() => withFileLockSync(t, () => 1, { timeoutMs: 60, pollMs: 5 })).toThrow(
      expect.objectContaining({ code: "E_IO_LOCK" }),
    );
  });

  it("releases the lock when the section throws", () => {
    const t = target();
    expect(() =>
      withFileLockSync(t, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(`${t}.lock`)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/services/profile-service.test.ts test/infra/filelock.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/profile-service.ts'` and `Export named 'withFileLockSync' not found`.

- [ ] **Step 3: Write the implementation**

In `src/infra/filelock.ts`, replace the whole `withFileLock` function:

```ts
export async function withFileLock<T>(
  target: string,
  fn: () => T | Promise<T>,
  o: { timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
  const lock = `${target}.lock`;
  const self = me();
  const deadline = Date.now() + (o.timeoutMs ?? 10_000);
  while (!tryTake(lock, self)) {
    reclaimIfDead(lock);
    if (Date.now() > deadline)
      throw new CatherdError("E_IO_LOCK", `timed out waiting for the lock on ${target}`, {
        fix: `if no catherd process is running, delete ${lock}`,
      });
    await Bun.sleep(o.pollMs ?? 25);
  }
  try {
    return await fn();
  } finally {
    const h = readHolder(lock);
    if (h?.pid === self.pid && h.startTime === self.startTime) rmSync(lock, { force: true });
  }
}
```

with:

```ts
const timedOut = (target: string, lock: string) =>
  new CatherdError("E_IO_LOCK", `timed out waiting for the lock on ${target}`, {
    fix: `if no catherd process is running, delete ${lock}`,
  });

function release(lock: string, self: Holder): void {
  const h = readHolder(lock);
  if (h?.pid === self.pid && h.startTime === self.startTime) rmSync(lock, { force: true });
}

export async function withFileLock<T>(
  target: string,
  fn: () => T | Promise<T>,
  o: { timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
  const lock = `${target}.lock`;
  const self = me();
  const deadline = Date.now() + (o.timeoutMs ?? 10_000);
  while (!tryTake(lock, self)) {
    reclaimIfDead(lock);
    if (Date.now() > deadline) throw timedOut(target, lock);
    await Bun.sleep(o.pollMs ?? 25);
  }
  try {
    return await fn();
  } finally {
    release(lock, self);
  }
}

/**
 * `withFileLock` for a synchronous critical section, waiting with a blocking sleep. For writers whose
 * callers are synchronous (the profile service under the 0.x TUI); the lock is held for milliseconds.
 * Not reentrant: a section must not take the same lock again.
 */
export function withFileLockSync<T>(
  target: string,
  fn: () => T,
  o: { timeoutMs?: number; pollMs?: number } = {},
): T {
  const lock = `${target}.lock`;
  const self = me();
  const deadline = Date.now() + (o.timeoutMs ?? 10_000);
  while (!tryTake(lock, self)) {
    reclaimIfDead(lock);
    if (Date.now() > deadline) throw timedOut(target, lock);
    Bun.sleepSync(o.pollMs ?? 25);
  }
  try {
    return fn();
  } finally {
    release(lock, self);
  }
}
```

and in `tryLock`, replace the returned release:

```ts
  return () => {
    const h = readHolder(lock);
    if (h?.pid === self.pid && h.startTime === self.startTime) rmSync(lock, { force: true });
  };
```

with:

```ts
  return () => release(lock, self);
```

In `src/infra/paths.ts`, after `export const configDir = …`, add:

```ts
/** Claude Code's own folder, as Claude Code finds it (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
export const claudeHome = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** Where Claude Code reads user agents; catherd links its agent files here (spec §7.3). */
export const claudeAgentsDir = (): string =>
  process.env.CATHERD_CLAUDE_AGENTS_DIR || join(claudeHome(), "agents");
```

`src/services/profile-service.ts`:

```ts
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, join, sep } from "node:path";
import { z } from "zod";
import { ADAPTER_IDS } from "../adapters/backend.ts";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import { type AgentFile, agentFiles } from "../domain/agents.ts";
import { CatherdError } from "../domain/errors.ts";
import { parseRung } from "../domain/ids.ts";
import {
  applyPatch,
  assertProfileName,
  type Change,
  defaultProfileDoc,
  diffProfiles,
  PROFILE_NAME,
  type Profile,
  type ProfileDoc,
  ProfileDocSchema,
  type ProfilePatch,
  resolveProfile,
} from "../domain/profile.ts";
import { type Issue, type Validation, validateProfile } from "../domain/profile-rules.ts";
import type { Access } from "../domain/record.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { withFileLockSync } from "../infra/filelock.ts";
import { claudeAgentsDir, configDir } from "../infra/paths.ts";
import { writeJsonAtomic, writeTextAtomic } from "../infra/store.ts";
import { VERSION } from "../infra/version.ts";
import { loadCatalog } from "./catalog-service.ts";

export const profilesDir = (): string => join(configDir(), "profiles");
export const configFile = (): string => join(configDir(), "config.json");
export const projectsFile = (): string => join(configDir(), "projects.json");
/** `<config>/agents/<profile>/<agent>.md`: catherd's own agent files, which the links point at. */
export const agentsRoot = (): string => join(configDir(), "agents");
const profileFile = (name: string) => join(profilesDir(), `${name}.json`);

const ConfigSchema = z.looseObject({ schema: z.literal(1), activeProfile: z.string().optional() });
const ProjectsSchema = z.looseObject({
  schema: z.literal(1),
  bindings: z.record(z.string(), z.string()).default({}),
});
export type Config = z.infer<typeof ConfigSchema>;
export type Projects = z.infer<typeof ProjectsSchema>;

/**
 * Reads a schema-1 file. A file without `schema` was written by catherd 0.x, which 1.0 does not read
 * (spec D2): `catherd init` moves those aside.
 */
function readV1<T>(file: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new CatherdError("E_CONFIG_INVALID", `${file} is not readable JSON: ${(e as Error).message}`, {
      fix: `fix or delete ${file}`,
    });
  }
  const found = (raw as { schema?: unknown } | null)?.schema;
  if (found === undefined)
    throw new CatherdError("E_CONFIG_INVALID", `${file} is from catherd 0.x`, {
      fix: "run catherd init, which moves 0.x files aside and writes 1.0 ones",
    });
  if (typeof found === "number" && found > 1)
    throw new CatherdError(
      "E_CONFIG_NEWER_SCHEMA",
      `${file} has schema ${found}, newer than this catherd (1)`,
      {
        fix: "upgrade catherd: bunx catherd-cli@latest",
      },
    );
  const r = schema.safeParse(raw);
  if (!r.success)
    throw new CatherdError("E_CONFIG_INVALID", `${file} is invalid:\n${z.prettifyError(r.error)}`, {
      fix: `fix it with catherd profile set, or delete ${file}`,
    });
  return r.data;
}

export const readConfig = (): Config =>
  existsSync(configFile()) ? readV1(configFile(), ConfigSchema) : { schema: 1 };
export const readProjects = (): Projects =>
  existsSync(projectsFile()) ? readV1(projectsFile(), ProjectsSchema) : { schema: 1, bindings: {} };

/** Every profile name: the files in `profiles/`, and `default`, which exists even before its file does. */
export function listProfiles(): string[] {
  const onDisk = existsSync(profilesDir())
    ? readdirSync(profilesDir())
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length))
        .filter((n) => PROFILE_NAME.test(n))
    : [];
  return [...new Set(["default", ...onDisk])].sort();
}

export const profileExists = (name: string): boolean => listProfiles().includes(name);

/** The stored document; `default` without a file is the built-in default profile. */
export function readProfileDoc(name: string): ProfileDoc {
  assertProfileName(name);
  if (existsSync(profileFile(name))) return readV1(profileFile(name), ProfileDocSchema);
  if (name === "default") return defaultProfileDoc();
  throw new CatherdError("E_CONFIG_INVALID", `no profile named "${name}"`, { fix: "catherd profile list" });
}

export const getProfile = (name: string): Profile => resolveProfile(readProfileDoc(name), name);

/** The profile bound to `repo` (a git toplevel), else the active one, else `default`. */
export function activeName(repo: string | null = null): string {
  const bound = repo === null ? undefined : readProjects().bindings[repo];
  return bound ?? readConfig().activeProfile ?? "default";
}

export const profileFor = (repo: string | null): Profile => getProfile(activeName(repo));

/** The backends catherd can run: every registered adapter, and the native `claude` path. */
export const runnableBackends = (): string[] => ["claude", ...ADAPTER_IDS.filter((id) => adapterFor(id))];

export function validateNamed(name?: string): Validation {
  return validateProfile(
    getProfile(name ?? activeName()),
    loadCatalog({ timings: false }),
    runnableBackends(),
  );
}

/** Spec D10: how strongly the backend holds a role to its access mode. */
export function enforcementOf(rung: string, access: Access): "enforced" | "advisory" {
  let backend: string;
  try {
    backend = parseRung(rung).backend;
  } catch {
    return "advisory";
  }
  return adapterFor(backend)?.enforcement[access] ?? "advisory";
}

/** Each role's weakest enforcement over its rungs, for `profile show` and profile_get. */
export function roleEnforcement(p: Profile): Record<Role, "enforced" | "advisory"> {
  const out = {} as Record<Role, "enforced" | "advisory">;
  for (const role of ROLES) {
    const rc = p.roles[role];
    out[role] = rc.rungs.every((r) => enforcementOf(r, rc.access) === "enforced") ? "enforced" : "advisory";
  }
  return out;
}

// ---- agent files and links (spec §7.3) ----

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
const ours = (): string => `${agentsRoot()}${sep}`;
/** A link catherd made: a symlink into `<config>/agents/`. Nothing else in the agents dir is ever touched. */
const isOurLink = (path: string): boolean => {
  const st = lstatOrNull(path);
  return st !== null && st.isSymbolicLink() && readlinkSync(path).startsWith(ours());
};

/** Spec §7.3: the active profile and every repo-bound one are linked at once. */
export function linkedProfiles(): string[] {
  const names = new Set([activeName(), ...Object.values(readProjects().bindings)]);
  return [...names].filter(profileExists).sort();
}

interface Planned {
  files: Map<string, AgentFile[]>;
  links: Map<string, string>;
}

function plan(extra: string[] = []): Planned {
  const files = new Map<string, AgentFile[]>();
  for (const name of new Set([...linkedProfiles(), ...extra.filter(profileExists)]))
    files.set(name, agentFiles(getProfile(name), VERSION));
  const links = new Map<string, string>();
  for (const name of linkedProfiles())
    for (const f of files.get(name) ?? [])
      links.set(join(claudeAgentsDir(), `${f.name}.md`), join(agentsRoot(), name, `${f.name}.md`));
  return { files, links };
}

/** Refuses before anything is written when a planned link would replace a file catherd does not own. */
function assertNoConflict(p: Planned): void {
  for (const link of p.links.keys())
    if (lstatOrNull(link) && !isOurLink(link))
      throw new CatherdError("E_CONFIG_INVALID", `${link} exists and is not catherd's`, {
        fix: `move ${link} away, then run the command again`,
      });
}

export interface Synced {
  linked: string[];
  pruned: string[];
  /** agents whose link is new or whose file changed: Claude Code reads them only at a session's start */
  newSessionNeededFor: string[];
}

/** Writes the planned agent files and links, prunes catherd's stale ones, and says what changed. */
function apply(p: Planned, removed: string[] = []): Synced {
  const changed = new Set<string>();
  for (const [name, files] of p.files) {
    const dir = join(agentsRoot(), name);
    mkdirSync(dir, { recursive: true });
    const keep = new Set(files.map((f) => `${f.name}.md`));
    for (const f of files) {
      const path = join(dir, `${f.name}.md`);
      if (!existsSync(path) || readFileSync(path, "utf8") !== f.text) {
        writeTextAtomic(path, f.text);
        changed.add(path);
      }
    }
    for (const f of readdirSync(dir)) if (!keep.has(f)) rmSync(join(dir, f), { force: true });
  }
  for (const name of removed) rmSync(join(agentsRoot(), name), { recursive: true, force: true });

  const target = claudeAgentsDir();
  const newSession: string[] = [];
  if (p.links.size > 0) mkdirSync(target, { recursive: true });
  for (const [link, file] of p.links) {
    const fresh = !isOurLink(link) || readlinkSync(link) !== file;
    if (fresh) {
      rmSync(link, { force: true });
      symlinkSync(file, link);
    }
    if (fresh || changed.has(file)) newSession.push(basename(link, ".md"));
  }
  const pruned: string[] = [];
  if (existsSync(target))
    for (const entry of readdirSync(target)) {
      const link = join(target, entry);
      if (isOurLink(link) && !p.links.has(link)) {
        rmSync(link, { force: true });
        pruned.push(entry);
      }
    }
  return {
    linked: [...p.links.keys()].map((l) => basename(l, ".md")).sort(),
    pruned: pruned.sort(),
    newSessionNeededFor: newSession.sort(),
  };
}

/** What `doctor` compares: each link that should exist, and whether it and its file are current. */
export function agentLinkState(): { missing: string[]; stale: string[]; ok: string[] } {
  const p = plan();
  const out = { missing: [] as string[], stale: [] as string[], ok: [] as string[] };
  for (const [name, files] of p.files)
    for (const f of files) {
      const link = join(claudeAgentsDir(), `${f.name}.md`);
      if (!p.links.has(link)) continue;
      const file = join(agentsRoot(), name, `${f.name}.md`);
      if (!isOurLink(link)) out.missing.push(f.name);
      else if (readlinkSync(link) !== file || !existsSync(file) || readFileSync(file, "utf8") !== f.text)
        out.stale.push(f.name);
      else out.ok.push(f.name);
    }
  return out;
}

/** Read-only: how many of catherd's links are in the agents dir (the 0.x dashboard's status row). */
export function countLinkedAgents(): number {
  const target = claudeAgentsDir();
  return existsSync(target) ? readdirSync(target).filter((e) => isOurLink(join(target, e))).length : 0;
}

// ---- writers: one lock over profiles, config.json, projects.json, agent files and links ----

const locked = <T>(fn: () => T): T => {
  mkdirSync(configDir(), { recursive: true });
  return withFileLockSync(join(configDir(), "profiles"), fn);
};

const writeDoc = (name: string, doc: ProfileDoc) => writeJsonAtomic(profileFile(name), { ...doc, name });

export interface Saved extends Synced {
  saved: boolean;
  errors: Issue[];
  warnings: Issue[];
  diff: Change[];
}

const unsaved = (v: Validation): Saved => ({
  saved: false,
  ...v,
  diff: [],
  linked: [],
  pruned: [],
  newSessionNeededFor: [],
});

/**
 * Spec §7.3 `patch` (profile_set, `catherd profile set`): validates first and writes nothing when invalid.
 * A profile that does not exist yet starts from the default profile.
 */
export function patchProfile(name: string | undefined, patch: ProfilePatch): Saved {
  return locked(() => {
    const n = assertProfileName(name ?? activeName());
    const before = profileExists(n) ? readProfileDoc(n) : defaultProfileDoc(n);
    const after = applyPatch(before, patch);
    const resolved = resolveProfile(after, n);
    const v = validateProfile(resolved, loadCatalog({ timings: false }), runnableBackends());
    if (v.errors.length) return unsaved(v);
    const existed = existsSync(profileFile(n));
    writeDoc(n, after);
    try {
      const p = plan([n]);
      assertNoConflict(p);
      return { saved: true, ...v, diff: diffProfiles(resolveProfile(before, n), resolved), ...apply(p) };
    } catch (e) {
      // the links refused: put the profile back as it was
      if (existed) writeDoc(n, before);
      else rmSync(profileFile(n), { force: true });
      throw e;
    }
  });
}

/** Spec §7.3 `create` and `copy`: a new profile from `from` (default: the default profile). */
export function createProfile(name: string, from?: string): Saved {
  return locked(() => {
    assertProfileName(name);
    if (existsSync(profileFile(name)))
      throw new CatherdError("E_INPUT_INVALID", `profile "${name}" already exists`, {
        fix: `pick another name, or edit it with catherd profile set --profile ${name}`,
      });
    const doc = from === undefined ? defaultProfileDoc(name) : readProfileDoc(from);
    writeDoc(name, doc);
    const p = resolveProfile(doc, name);
    const v = validateProfile(p, loadCatalog({ timings: false }), runnableBackends());
    return { saved: true, ...v, diff: [], ...apply(plan([name])) };
  });
}

/** Writes the default profile under `name`, replacing what is there (`catherd init` when asked to). */
export function resetProfile(name: string): Saved {
  return locked(() => {
    assertProfileName(name);
    const doc = defaultProfileDoc(name);
    writeDoc(name, doc);
    const v = validateProfile(resolveProfile(doc, name), loadCatalog({ timings: false }), runnableBackends());
    return { saved: true, ...v, diff: [], ...apply(plan([name])) };
  });
}

/** Spec §7.3 `delete`: never the active profile or a repo-bound one; its agent files go with it. */
export function deleteProfile(name: string): Synced {
  return locked(() => {
    assertProfileName(name);
    if (!existsSync(profileFile(name)))
      throw new CatherdError("E_INPUT_INVALID", `profile "${name}" has no file to delete`, {
        fix: "catherd profile list",
      });
    if (name === activeName())
      throw new CatherdError("E_INPUT_INVALID", `"${name}" is the active profile`, {
        fix: "make another profile active first: catherd profile use <name>",
      });
    const bound = Object.entries(readProjects().bindings)
      .filter(([, p]) => p === name)
      .map(([repo]) => repo);
    if (bound.length)
      throw new CatherdError("E_INPUT_INVALID", `"${name}" is bound to ${bound.join(", ")}`, {
        fix: `bind those repos to another profile: catherd profile use <name> --repo (run inside each)`,
      });
    rmSync(profileFile(name), { force: true });
    return apply(plan(), [name]);
  });
}

/** Spec §7.3 `activate(name, repo?)`: the active profile, or the one bound to a repo; relinks the agents. */
export function activate(
  name: string,
  repo: string | null = null,
): Synced & { active: string; repo: string | null } {
  return locked(() => {
    assertProfileName(name);
    if (!profileExists(name))
      throw new CatherdError("E_INPUT_INVALID", `no profile named "${name}"`, {
        fix: "catherd profile list",
      });
    const config = readConfig();
    const projects = readProjects();
    const write = () =>
      repo === null
        ? writeJsonAtomic(configFile(), { ...config, schema: 1, activeProfile: name })
        : writeJsonAtomic(projectsFile(), {
            ...projects,
            schema: 1,
            bindings: { ...projects.bindings, [repo]: name },
          });
    write();
    try {
      const p = plan([name]);
      assertNoConflict(p);
      return { active: name, repo, ...apply(p) };
    } catch (e) {
      if (repo === null) writeJsonAtomic(configFile(), config);
      else writeJsonAtomic(projectsFile(), projects);
      throw e;
    }
  });
}

/** Rewrites every agent file and link from the profiles as they are (after an upgrade, or for doctor's fix). */
export const relink = (): Synced =>
  locked(() => {
    const p = plan();
    assertNoConflict(p);
    return apply(p);
  });

export function diffNamed(a: string, b: string): Change[] {
  return diffProfiles(getProfile(a), getProfile(b));
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun run format && bun test test/services/profile-service.test.ts test/infra/filelock.test.ts`
Expected: PASS (17 and 11 tests). The cross-process test starts two Bun processes that each patch the same profile eight times; both final values land and the lock file is gone.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint && bun run format:check`
Expected: clean.

```bash
git add src/services/profile-service.ts src/infra/filelock.ts src/infra/paths.ts test/services/profile-service.test.ts test/infra/filelock.test.ts
git commit -m "feat(services): the ProfileService, one locked writer of profiles, agent files and links"
```

---

### Task 5: The run engine and the MCP tools on the ProfileService; the bridge removed

`profileService()` implements plan 2's `ProfilePort` over Task 4, and every entry point uses it: the MCP server, `catherd lock`, and (Tasks 9–13) the CLI. `ProfilePort` grows what spec §7 adds: validation warnings, the full save result, each role's enforcement, and an `agentFor` that names the agent after the repo's profile. `profile_set` takes Task 1's strict patch with every §4.8 field. `catalog_query` prices with the active profile's billing. `src/bridge/v0.ts`, its test, plan 3's `claudeBackendFor` and the `microdiff` dependency go.

**Files:**
- Create: `src/entry/deps.ts`
- Modify: `src/services/profile-service.ts` (append the port), `src/services/ports.ts`, `src/services/{admission,dispatch-service,lane-service,run-service,routing-service}.ts`, `src/entry/mcp/server.ts`, `src/entry/mcp/setup-tools.ts` (replace), `src/entry/lock.ts`, `src/domain/roles.ts`, `package.json`, `bun.lock`, `docs/dependencies.md`
- Delete: `src/bridge/v0.ts`, `test/bridge/v0.test.ts`, `test/domain/roles.test.ts`
- Test: `test/entry/mcp-profile.test.ts`; modify `test/services/helpers.ts`, `test/services/routing-service.test.ts`, `test/architecture.test.ts`, `test/integration/mcp-stdio.test.ts`, `test/mcp-helpers.ts`

**Interfaces:**
- Consumes: Task 4 (every export), Task 1 (`agentName`, `PROFILE_NAME`, `ProfilePatchSchema`, `ProfilePatch`, `Change`), Task 2 (`Issue`); plan 4's `routingService`, `catalogQuery(filter, billing)`, `BillingMode`.
- Produces: `interface ProfileSaved { saved; errors: Issue[]; warnings: Issue[]; diff: Change[]; linked; pruned; newSessionNeededFor }`; `ProfilePort.get(name?)` → `{ active; profiles; profile: ProfileView; enforcement: Partial<Record<Role, "enforced" | "advisory">> }`; `ProfilePort.validate(name?)` → `{ valid; errors: Issue[]; warnings: Issue[] }`; `ProfilePort.set(name, patch): ProfileSaved`; `ProfilePort.agentFor(repo: string | null, role, rung): string | null`; `RoutingPort.catalog(filter, billing?)`; `viewOf(p: Profile): ProfileView`; `profileService(): ProfilePort`; `defaultDeps(): Deps` (`src/entry/deps.ts`).

- [ ] **Step 1: Write the failing test**

`test/entry/mcp-profile.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeAgentsDir } from "../../src/infra/paths.ts";
import { activate, createProfile, profileService, profilesDir } from "../../src/services/profile-service.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";

afterEach(snapshotEnv());

describe("the profile tools on the profile service", () => {
  it("profile_set stores every field spec §4.8 names, and returns the diff and the new sessions", async () => {
    withHome();
    const c = await mcpClient();
    const r = await call(c, "profile_set", {
      patch: {
        roles: { verifier: { access: "workspace-write", rungs: ["claude:claude-opus-5-5#medium"] } },
        billing: { opencode: "subscription" },
        jev: { use: "off" },
        harness: { "claude-code": { isolated: true } },
        failover: { "codex:gpt-6-sol#xhigh": null },
        budget: { usd: 20 },
        timeouts: { idleMin: 10, wallMin: 60 },
        preflight: { confirm: true },
      },
    });
    expect(r.isError).toBe(false);
    expect(r.data.saved).toBe(true);
    expect(r.data.newSessionNeededFor).toEqual([
      "catherd-default-architect-claude-opus-5-5-high",
      "catherd-default-verifier-claude-opus-5-5-medium",
    ]);
    expect(r.data.diff).toContainEqual({ path: "budget.usd", before: null, after: 20 });
    const file = JSON.parse(readFileSync(join(profilesDir(), "default.json"), "utf8"));
    expect([
      file.billing.opencode,
      file.jev,
      file.harness["claude-code"],
      file.timeouts,
      file.preflight,
    ]).toEqual([
      "subscription",
      { use: "off" },
      { isolated: true },
      { idleMin: 10, wallMin: 60 },
      { confirm: true },
    ]);
    expect(file.failover["codex:gpt-6-sol#xhigh"]).toBeUndefined();
    expect(
      readFileSync(join(claudeAgentsDir(), "catherd-default-verifier-claude-opus-5-5-medium.md"), "utf8"),
    ).toContain("disallowedTools: Agent");
  });

  it("refuses an unknown key or a flag-shaped rung as E_INPUT_INVALID, and saves nothing", async () => {
    withHome();
    const c = await mcpClient();
    for (const patch of [{ colour: "red" }, { roles: { worker: { rungs: ["codex:--yolo#high"] } } }]) {
      const r = await call(c, "profile_set", { patch });
      expect(r.error?.code).toBe("E_INPUT_INVALID");
    }
    expect((await call(c, "profile_get")).data.profiles).toEqual(["default"]);
  });

  it("profile_set returns errors and saves nothing when the result is invalid; profile_validate adds warnings", async () => {
    withHome();
    const c = await mcpClient();
    const bad = await call(c, "profile_set", { patch: { roles: { worker: { enabled: false } } } });
    expect([bad.data.saved, bad.data.errors[0].message]).toEqual([false, "the worker cannot be disabled"]);
    await call(c, "profile_set", { patch: { roles: { verifier: { access: "read-only" } } } });
    const v = await call(c, "profile_validate");
    expect(v.data).toEqual({
      valid: true,
      errors: [],
      warnings: [
        {
          path: "roles.verifier.access",
          message: "verifier runs read-only; catherd's default for it is full",
        },
      ],
    });
  });

  it("profile_get shows each role's access and its backend's enforcement", async () => {
    withHome();
    const r = await call(await mcpClient(), "profile_get");
    expect(r.data.profile.roles.reviewer).toEqual({
      enabled: true,
      access: "read-only",
      rungs: ["codex:gpt-6-sol#high"],
    });
    expect(r.data.enforcement).toMatchObject({ reviewer: "enforced", architect: "advisory" });
    expect(r.data.profile.isolated).toMatchObject({ codex: false, "claude-code": false, opencode: false });
  });

  it("catalog_query prices rungs with the active profile's billing", async () => {
    withHome();
    const c = await mcpClient();
    const cost = async () =>
      (await call(c, "catalog_query", { backend: "codex", text: "gpt-6-sol" })).data.models[0].rungs.find(
        (r: { rung: string }) => r.rung === "codex:gpt-6-sol#high",
      ).cost;
    expect((await cost()).mode).toBe("chatgpt-plan");
    await call(c, "profile_set", { patch: { billing: { codex: "metered" } } });
    expect((await cost()).mode).toBe("metered");
  });
});

describe("profileService().agentFor", () => {
  it("names the agent after the profile the repo runs on", () => {
    withHome();
    createProfile("fast");
    activate("fast", "/r/app");
    const p = profileService();
    expect(p.agentFor("/r/app", "architect", "claude:claude-opus-5-5#high")).toBe(
      "catherd-fast-architect-claude-opus-5-5-high",
    );
    expect(p.agentFor(null, "architect", "claude:claude-opus-5-5#high")).toBe(
      "catherd-default-architect-claude-opus-5-5-high",
    );
    expect(p.agentFor(null, "worker", "codex:gpt-6-sol#high")).toBeNull();
  });

  it("serves failover keys exactly as the profile stores them (plan-3 T9)", () => {
    withHome();
    profileService().set(undefined, {
      failover: { "claude-code:claude-opus-5-5#high": "codex:gpt-6-sol#high" },
    });
    expect(profileService().forRepo(null).failover["claude-code:claude-opus-5-5#high"]).toBe(
      "codex:gpt-6-sol#high",
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/entry/mcp-profile.test.ts`
Expected: FAIL — `Export named 'profileService' not found in module '…/profile-service.ts'`.

- [ ] **Step 3: Write the implementation**

Append to `src/services/profile-service.ts`:

```ts
export function viewOf(p: Profile): ProfileView {
  const roles: ProfileView["roles"] = {};
  for (const role of ROLES) roles[role] = { ...p.roles[role], rungs: [...p.roles[role].rungs] };
  return {
    name: p.name,
    objective: p.objective,
    roles,
    billing: p.billing,
    jev: p.jev,
    isolated: Object.fromEntries(Object.entries(p.harness).map(([k, h]) => [k, h.isolated])),
    failover: p.failover,
    budget: p.budget,
    timeouts: p.timeouts,
    preflight: p.preflight,
    heavy: p.lock.heavy,
    notify: p.notify,
  };
}

/** The ProfilePort the run engine and the MCP tools use (spec §7.3: the single writer). */
export function profileService(): ProfilePort {
  return {
    forRepo: (repo) => viewOf(profileFor(repo)),
    get(name) {
      const active = activeName();
      const p = getProfile(name ?? active);
      return { active, profiles: listProfiles(), profile: viewOf(p), enforcement: roleEnforcement(p) };
    },
    validate(name) {
      const v = validateNamed(name);
      return { valid: v.errors.length === 0, ...v };
    },
    set: (name, patch) => patchProfile(name, patch),
    agentFor: (repo, role, rung) =>
      parseRung(rung).backend === "claude" ? agentName(activeName(repo), role, rung) : null,
  };
}
```

and add two imports: in the import list from `"../domain/profile.ts"`, add `agentName,` before `applyPatch,`; after `import { loadCatalog } from "./catalog-service.ts";` add:

```ts
import type { ProfilePort, ProfileView } from "./ports.ts";
```

In `src/services/ports.ts`, after `import type { Role } from "../domain/roles.ts";` add:

```ts
import type { Change, ProfilePatch } from "../domain/profile.ts";
import type { Issue } from "../domain/profile-rules.ts";
```

replace the local patch type and the port:

```ts
/** `profile_set`'s patch, in 1.0 rungs. */
export interface ProfilePatch {
  objective?: "cost" | "speed";
  roles?: Partial<Record<Role, { enabled?: boolean; rungs?: string[]; defaultRung?: string }>>;
  harness?: Partial<Record<"codex" | "opencode", { isolated: boolean }>>;
  lock?: { heavy: number | "cpus/2" };
  notify?: ("milestone" | "finish" | "blocked")[];
  failover?: Record<string, string>;
  budget?: Budget;
}

export interface ProfilePort {
  /** The profile bound to `repo` (a git toplevel), else the active one; null asks for the active one. */
  forRepo(repo: string | null): ProfileView;
  get(name?: string): { active: string; profiles: string[]; profile: ProfileView };
  validate(name?: string): { valid: boolean; errors: string[] };
  set(
    name: string | undefined,
    patch: ProfilePatch,
  ): { saved: boolean; errors: string[]; diff: unknown[]; newSessionNeededFor: string[] };
  /** The native Claude agent that runs `rung` for `role`; null unless the rung is a `claude:` one. */
  agentFor(role: Role, rung: string): string | null;
}
```

with:

```ts
export type { ProfilePatch };

/** What a profile write returns (spec §7.3): whether it saved, why not, what changed, and the agents it touched. */
export interface ProfileSaved {
  saved: boolean;
  errors: Issue[];
  warnings: Issue[];
  diff: Change[];
  linked: string[];
  pruned: string[];
  /** agents whose link is new or whose file changed: they apply from the next Claude Code session */
  newSessionNeededFor: string[];
}

export interface ProfilePort {
  /** The profile bound to `repo` (a git toplevel), else the active one; null asks for the active one. */
  forRepo(repo: string | null): ProfileView;
  get(name?: string): {
    active: string;
    profiles: string[];
    profile: ProfileView;
    /** per role: whether its backend holds it to its access mode (spec D10) */
    enforcement: Partial<Record<Role, "enforced" | "advisory">>;
  };
  validate(name?: string): { valid: boolean; errors: Issue[]; warnings: Issue[] };
  set(name: string | undefined, patch: ProfilePatch): ProfileSaved;
  /** The native agent that runs `rung` for `role` under `repo`'s profile; null unless it is a `claude:` rung. */
  agentFor(repo: string | null, role: Role, rung: string): string | null;
}
```

and in `RoutingPort`, replace:

```ts
  catalog(filter: CatalogFilter): { total: number; models: unknown[] };
```

with:

```ts
  /** `billing` prices the rungs (spec §5.3); absent keys bill as DEFAULT_BILLING */
  catalog(filter: CatalogFilter, billing?: Partial<Record<string, BillingMode>>): { total: number; models: unknown[] };
```

Name the repo in every `agentFor` call (the run is in scope at each):
- `src/services/admission.ts`: `deps.profiles.agentFor(i.role, i.rung)` → `deps.profiles.agentFor(run.meta.repo, i.role, i.rung)`
- `src/services/dispatch-service.ts`: `deps.profiles.agentFor(d.admit.role, standIn)` → `deps.profiles.agentFor(run.meta.repo, d.admit.role, standIn)`
- `src/services/run-service.ts`: `agent: deps.profiles.agentFor(i.role, i.rung),` → `agent: deps.profiles.agentFor(run.meta.repo, i.role, i.rung),`
- `src/services/lane-service.ts`: `agent: deps.profiles.agentFor(i.role, a.rung),` → `agent: deps.profiles.agentFor(run.meta.repo, i.role, a.rung),` and `agent: next ? deps.profiles.agentFor(cur.role, next) : null,` → `agent: next ? deps.profiles.agentFor(run.meta.repo, cur.role, next) : null,`

In `src/services/routing-service.ts`, replace `catalog: (filter) => catalogQuery(filter),` with `catalog: (filter, billing) => catalogQuery(filter, billing),`.

`src/entry/deps.ts`:

```ts
import { VERSION } from "../infra/version.ts";
import type { Deps } from "../services/ports.ts";
import { profileService } from "../services/profile-service.ts";
import { routingService } from "../services/routing-service.ts";

/** The services every entry point (MCP server, CLI commands) runs on. */
export function defaultDeps(): Deps {
  return {
    profiles: profileService(),
    routing: routingService(),
    version: VERSION,
    pollMs: 250,
    tickMs: Number(process.env.CATHERD_TICK_MS) || 30_000,
    now: Date.now,
  };
}
```

In `src/entry/mcp/server.ts`, delete the two imports

```ts
import { v0Profiles } from "../../bridge/v0.ts";
import { VERSION } from "../../infra/version.ts";
```

replace `import { routingService } from "../../services/routing-service.ts";` with `import { defaultDeps } from "../deps.ts";`, and delete the whole `export function defaultDeps(): Deps { … }` (it moved to `src/entry/deps.ts`).

`src/entry/mcp/setup-tools.ts` (replace the file: the patch is Task 1's schema, `catalog_query` passes the billing, and the descriptions name the 1.0 fields):

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PROFILE_NAME, ProfilePatchSchema } from "../../domain/profile.ts";
import { ROLES } from "../../domain/roles.ts";
import type { Deps } from "../../services/ports.ts";
import { handle } from "./result.ts";

const PROFILE = z.string().regex(PROFILE_NAME).optional();

export function registerSetupTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "catalog_query",
    {
      description:
        "Models catherd can place, with capabilities, the roles they can fill, their scored rungs (backend:model#effort), any 'treat like', their cost under the active profile's billing, and whether this account's last listing offers them. Scored models first.",
      inputSchema: {
        role: z.enum(ROLES).optional(),
        backend: z.string().optional(),
        text: z.string().optional(),
        scored_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    (a) =>
      handle(() =>
        deps.routing.catalog(
          {
            role: a.role,
            backend: a.backend,
            text: a.text,
            scoredOnly: a.scored_only,
            limit: a.limit,
          },
          deps.profiles.forRepo(null).billing,
        ),
      ),
  );

  server.registerTool(
    "profile_get",
    {
      description:
        "A profile (the active one without a name) as the run engine reads it, with every default filled in: per role its access mode, rungs and default rung, and whether its backend enforces the access (enforcement); billing, jev, harness isolation, failover, budget, timeouts, preflight, lock and notify. Also the active name and every name.",
      inputSchema: { name: PROFILE },
    },
    (a) => handle(() => deps.profiles.get(a.name)),
  );

  server.registerTool(
    "profile_validate",
    {
      description:
        "Check a profile (the active one without a name). errors block a save: the worker disabled, an enabled role with no usable rung, an unscored rung without a 'treat like', a failover stand-in unscored or on the same quota, a backend catherd cannot run. warnings do not: an access mode other than the role's default, a model the backend's listing lacks, a stand-in that never runs. Each has a path, a message and often a fix.",
      inputSchema: { name: PROFILE },
    },
    (a) => handle(() => deps.profiles.validate(a.name)),
  );

  server.registerTool(
    "profile_set",
    {
      description:
        "Apply a patch to a profile (the active one without a name; a new name starts from the default profile): objective, jev.use, billing, roles (enabled, access, rungs, defaultRung), harness isolation per backend, failover, budget, timeouts, preflight.confirm, lock.heavy and notify. Lists replace, maps merge, and null removes a key. An unknown key is refused. It validates first and writes nothing when invalid; otherwise it saves, rewrites the agent files and relinks them. Returns the errors and warnings, the diff, and newSessionNeededFor: the agents that apply from the next Claude Code session.",
      inputSchema: { name: PROFILE, patch: ProfilePatchSchema },
    },
    (a) => handle(() => deps.profiles.set(a.name, a.patch)),
  );
}
```

In `src/entry/lock.ts`, replace `import { v0Profiles } from "../bridge/v0.ts";` with `import { profileFor } from "../services/profile-service.ts";` (after the heavy-lock import), and `slots = resolveSlots(args.slots, () => v0Profiles().forRepo(null).heavy);` with `slots = resolveSlots(args.slots, () => profileFor(null).lock.heavy);`. (Task 11 rewrites the command.)

In `src/domain/roles.ts`, delete `NATIVE_CLAUDE_ROLES`, `claudeBackendFor` and their doc comment (Ruling 1).

Delete the bridge and the tests of what went: `git rm src/bridge/v0.ts test/bridge/v0.test.ts test/domain/roles.test.ts`.

Remove `microdiff`, whose only user was the bridge: `bun remove microdiff`, and delete its line (`- microdiff — the diff \`profile_set\` returns — …`) from `docs/dependencies.md`.

Update the tests that named the bridge or the old port:
- `test/services/helpers.ts`, in `fakeDeps`, replace the `get`, `validate`, `set` and `agentFor(r, rung)` members with:

```ts
    get: () => ({ active: "test", profiles: ["test"], profile: view, enforcement: {} }),
    validate: () => ({ valid: true, errors: [], warnings: [] }),
    set: () => ({
      saved: false,
      errors: [{ path: "", message: "profiles are fixed in tests" }],
      warnings: [],
      diff: [],
      linked: [],
      pruned: [],
      newSessionNeededFor: [],
    }),
    agentFor(_repo, r, rung) {
```

- `test/services/routing-service.test.ts`: replace `import { v0Profiles } from "../../src/bridge/v0.ts";` with `import { profileService } from "../../src/services/profile-service.ts";` (after the `ports.ts` import), and in the test `"keeps the approved ladder through the default profile the bridge serves"` rename it to `"keeps the approved ladder through the default profile the profile service serves"` and replace `v0Profiles().forRepo(null)` with `profileService().forRepo(null)`.
- `test/architecture.test.ts`: delete the `BRIDGE` constant and its comment; replace

```ts
    if (LEGACY.has(top)) violations.push(`${file} imports 0.x ${target}`);
    else if (top === BRIDGE && from !== "entry") violations.push(`${file} (${from}) imports the 0.x bridge`);
```

with

```ts
    if (LEGACY.has(top) || top === "bridge") violations.push(`${file} imports 0.x ${target}`);
```

and replace the test `"lets only the entry layer import the 0.x bridge"` with:

```ts
  it("flags the 0.x bridge, which plan 5 removed, from every layer", () => {
    expect(
      violationsIn("entry/mcp/server.ts", `import { v0Profiles } from "../../bridge/v0.ts";`),
    ).toHaveLength(1);
  });
```

- `test/integration/mcp-stdio.test.ts`: replace `import { defaultProfile } from "../../src/profile/profile.ts";` with `import { defaultProfileDoc } from "../../src/domain/profile.ts";`; in `writeProfile`, replace the doc comment with `/** The user's profile file: the default profile document, with fields replaced. */` and `JSON.stringify({ ...defaultProfile(), ...extra })` with `JSON.stringify({ ...defaultProfileDoc(), ...extra })`; and replace `writeProfile({ failover: { "gpt-6-sol#medium": "gpt-6-sol#high" } });` with `writeProfile({ failover: { "codex:gpt-6-sol#medium": "codex:gpt-6-sol#high" } });`.
- `test/mcp-helpers.ts`: the doc comment of `mcpClient` becomes `/** An SDK client on an in-memory server; the default deps are the real services. */`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run format && bun test test/entry test/services test/architecture.test.ts test/integration`
Expected: PASS. `mcp-profile.test.ts` pins `profile_set` storing every field, the strict patch, errors and warnings, enforcement, the billing in `catalog_query`, `agentFor` per repo, and failover keys kept as written.

- [ ] **Step 5: Run everything, typecheck, lint, commit**

Run: `bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: clean, and the full suite passes (the 0.x TUI still uses `src/profile`, which Task 6 replaces).

```bash
git add -A src test package.json bun.lock docs/dependencies.md
git commit -m "feat(services): the run engine and profile tools on the ProfileService; the 0.x bridge removed"
```

---

### Task 6: The 0.x TUI on a shim; the 0.x profile modules removed

The 0.x TUI (editor, init screen, dashboard, and `src/core/status.ts` under `watch`) edits profiles in the 0.x shape. It must not write 0.x files over 1.0 ones, so it goes through a minimal shim over the ProfileService (Ruling 10) until plan 6 replaces it. Then `src/profile/*` and its tests are deleted.

**Files:**
- Create: `src/tui/profile-shim.ts`
- Modify: `src/tui/profiles.ts` (replace), `src/tui/editor.tsx`, `src/tui/init.tsx`, `src/tui/dashboard.tsx`, `src/core/status.ts`
- Delete: `src/profile/profile.ts`, `src/profile/agents.ts`, `src/profile/role-prompts.ts`, `test/validate.test.ts`, `test/agents.test.ts`, `test/profile.test.ts`
- Test: `test/tui/profile-shim.test.ts`; modify `test/select.test.ts`, `test/status.test.ts`, `test/tui/{editor.test.tsx,matrix-model.test.ts,matrix.test.tsx,profiles.test.ts}`

**Interfaces:**
- Consumes: Task 4 (`listProfiles`, `activeName`, `activate`, `deleteProfile`, `countLinkedAgents`, `getProfile`, `profileExists`, `readProfileDoc`, `patchProfile`, `runnableBackends`), Task 1 (`applyPatch`, `defaultProfileDoc`, `resolveProfile`, `Profile`, `ProfilePatch`), Task 2 (`validateProfile`), plan 4's `loadCatalog` and `Catalog`; the 0.x types `Catalog`, `Profile`, `RoleConfig` (`src/types.ts`).
- Produces (`src/tui/profile-shim.ts`, 0.x signatures): `countLinkedAgents(): number`, `listProfiles(): string[]`, `deleteProfile(name): void`, `activeProfileName(repo?): string`, `setActiveProfile(name, repo?): void`, `toV0(p): Profile0`, `patchFromV0(p0, before, c?): ProfilePatch`, `defaultProfile(): Profile0`, `loadProfile(name?): Profile0`, `validateProfile(p0, c?): string[]`, `saveProfile(p0): void` (throws on invalid), `saveProfileAndAgents(p0, c?): void`.

- [ ] **Step 1: Write the failing test**

`test/tui/profile-shim.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getProfile, patchProfile, profilesDir } from "../../src/services/profile-service.ts";
import { defaultProfile, loadProfile, saveProfile, validateProfile } from "../../src/tui/profile-shim.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

describe("the 0.x TUI's profile shim", () => {
  it("shows a 1.0 profile in the 0.x shape", () => {
    withHome();
    const p = loadProfile();
    expect(p.roles.worker).toEqual({
      enabled: true,
      models: { "gpt-6-luna": ["high"], "gpt-6-sol": ["medium", "high", "xhigh"] },
      defaultRung: "gpt-6-sol#medium",
    });
    expect(p.failover?.["gpt-6-sol#high"]).toBe("opencode-go/kimi-k3#max");
    expect(p.budget).toBeUndefined();
    expect(defaultProfile().roles.architect.models).toEqual({ "claude-opus-5-5": ["high"] });
  });

  it("saves through the profile service and keeps every 1.0 field the 0.x shape lacks", () => {
    withHome();
    patchProfile("default", {
      roles: { reviewer: { access: "full", rungs: ["claude-code:claude-opus-5-5#high"] } },
      jev: { use: "off" },
      harness: { "claude-code": { isolated: true } },
      timeouts: { idleMin: 7 },
    });
    const p0 = loadProfile();
    saveProfile({
      ...p0,
      objective: "speed",
      roles: { ...p0.roles, writer: { enabled: true, models: { "claude-opus-5-5": ["high"] } } },
    });
    const p = getProfile("default");
    expect(p.objective).toBe("speed");
    expect(p.roles.reviewer).toEqual({
      enabled: true,
      access: "full",
      rungs: ["claude-code:claude-opus-5-5#high"],
    });
    expect(p.roles.architect.rungs).toEqual(["claude:claude-opus-5-5#high"]);
    expect(p.roles.writer.rungs).toEqual(["claude-code:claude-opus-5-5#high"]);
    expect([p.jev.use, p.harness["claude-code"]?.isolated, p.timeouts.idleMin]).toEqual(["off", true, 7]);
    expect(JSON.parse(readFileSync(join(profilesDir(), "default.json"), "utf8")).schema).toBe(1);
  });

  it("validates with the 1.0 rules, and refuses to save what they refuse", () => {
    withHome();
    const p0 = loadProfile();
    const bad = { ...p0, roles: { ...p0.roles, worker: { ...p0.roles.worker, enabled: false } } };
    expect(validateProfile(bad)).toContain("the worker cannot be disabled");
    expect(() => saveProfile(bad)).toThrow(/the worker cannot be disabled/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/tui/profile-shim.test.ts`
Expected: FAIL — `Cannot find module '../../src/tui/profile-shim.ts'`.

- [ ] **Step 3: Write the implementation**

`src/tui/profile-shim.ts`:

```ts
// 0.x shim, removed by plan 6: the 0.x TUI (dashboard, editor, init) and src/core edit profiles in the 0.x
// shape (`roles[role].models`, rungs without a backend). This translates that shape to and from the 1.0
// profile service, the single writer, so the TUI never writes a 0.x file over a 1.0 one. Every 1.0 field
// the 0.x shape lacks (access, billing, jev, timeouts, per-role Claude backend…) is kept from the stored
// profile on save.
import type { Catalog as Catalog1 } from "../domain/catalog.ts";
import { parseRung } from "../domain/ids.ts";
import {
  applyPatch,
  defaultProfileDoc,
  type Profile as Profile1,
  type ProfilePatch,
  resolveProfile,
} from "../domain/profile.ts";
import { validateProfile as validate1 } from "../domain/profile-rules.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { loadCatalog as loadCatalog1 } from "../services/catalog-service.ts";
import * as svc from "../services/profile-service.ts";
import type { Catalog, Profile, RoleConfig } from "../types.ts";

export const countLinkedAgents = svc.countLinkedAgents;
export const listProfiles = svc.listProfiles;
export const deleteProfile = (name: string): void => void svc.deleteProfile(name);
export const activeProfileName = (repo?: string): string => svc.activeName(repo ?? null);
export const setActiveProfile = (name: string, repo?: string): void => void svc.activate(name, repo ?? null);

const rung0 = (rung1: string): string => {
  const r = parseRung(rung1);
  return `${r.model}#${r.effort}`;
};

/** A 1.0 profile in the 0.x shape: rungs lose their backend, grouped by model in ladder order. */
export function toV0(p: Profile1): Profile {
  const roles = {} as Record<Role, RoleConfig>;
  for (const role of ROLES) {
    const rc = p.roles[role];
    const models: Record<string, string[]> = {};
    for (const r of rc.rungs) {
      try {
        const { model, effort } = parseRung(r);
        (models[model] ??= []).push(effort);
      } catch {
        // a rung the 0.x shape cannot hold; validate reports it
      }
    }
    roles[role] = {
      enabled: rc.enabled,
      models,
      ...(rc.defaultRung ? { defaultRung: rung0(rc.defaultRung) } : {}),
    };
  }
  const failover = Object.fromEntries(Object.entries(p.failover).map(([a, b]) => [rung0(a), rung0(b)]));
  return {
    name: p.name,
    objective: p.objective,
    roles,
    harness: {
      codex: { isolated: p.harness.codex?.isolated ?? false },
      opencode: { isolated: p.harness.opencode?.isolated ?? false },
    },
    lock: p.lock,
    notify: p.notify,
    failover,
    // 0.x reads a missing budget as "no cap"; an empty one would count as a cap of nothing
    ...(Object.keys(p.budget).length ? { budget: p.budget } : {}),
  };
}

/**
 * The backend a 0.x `model#effort` runs on: the one the stored role already uses for that model, else the
 * 1.0 catalog's (a Claude model: native for architect and verifier, headless otherwise, spec D3).
 */
function backendFor(c: Catalog1, before: Profile1, role: Role | null, model: string): string {
  const own = (role ? before.roles[role].rungs : Object.keys(before.failover)).find((r) => {
    try {
      return parseRung(r).model === model;
    } catch {
      return false;
    }
  });
  if (own) return parseRung(own).backend;
  if (model.includes("/")) return "opencode";
  if (!c.families.some((f) => f.on["claude-code"]?.id === model)) return "codex";
  return role === "architect" || role === "verifier" ? "claude" : "claude-code";
}

/** The patch that turns the stored profile into `p0`, keeping every field the 0.x shape does not have. */
export function patchFromV0(
  p0: Profile,
  before: Profile1,
  c: Catalog1 = loadCatalog1({ timings: false }),
): ProfilePatch {
  const to1 = (role: Role | null, r0: string) => {
    const hash = r0.lastIndexOf("#");
    return `${backendFor(c, before, role, r0.slice(0, hash))}:${r0}`;
  };
  const roles: NonNullable<ProfilePatch["roles"]> = {};
  for (const role of ROLES) {
    const rc = p0.roles[role];
    roles[role] = {
      enabled: rc.enabled,
      rungs: Object.entries(rc.models).flatMap(([model, efforts]) =>
        efforts.map((e) => to1(role, `${model}#${e}`)),
      ),
      defaultRung: rc.defaultRung ? to1(role, rc.defaultRung) : null,
    };
  }
  const failover: Record<string, string | null> = Object.fromEntries(
    Object.keys(before.failover).map((k) => [k, null]),
  );
  for (const [a, b] of Object.entries(p0.failover ?? {})) failover[to1(null, a)] = to1(null, b);
  return {
    objective: p0.objective,
    roles,
    harness: {
      codex: { isolated: p0.harness.codex.isolated },
      opencode: { isolated: p0.harness.opencode.isolated },
    },
    lock: p0.lock,
    notify: p0.notify,
    failover,
    budget: {
      minutes: p0.budget?.minutes ?? null,
      tokens: p0.budget?.tokens ?? null,
      usd: p0.budget?.usd ?? null,
    },
  };
}

const stored = (name: string) =>
  svc.profileExists(name) ? svc.readProfileDoc(name) : defaultProfileDoc(name);

/** The default profile in the 0.x shape: where the 0.x editor and init start a new profile. */
export const defaultProfile = (): Profile => toV0(resolveProfile(defaultProfileDoc(), "default"));

export const loadProfile = (name?: string): Profile => toV0(svc.getProfile(name ?? svc.activeName()));

/** 1.0 validation of the 0.x profile as it would be saved; one line per error. */
export function validateProfile(p0: Profile, _c?: Catalog): string[] {
  const doc = stored(p0.name);
  const after = resolveProfile(applyPatch(doc, patchFromV0(p0, resolveProfile(doc, p0.name))), p0.name);
  return validate1(after, loadCatalog1({ timings: false }), svc.runnableBackends()).errors.map(
    (e) => e.message,
  );
}

/** Saves through the profile service, which validates, writes the agent files and relinks them. */
export function saveProfile(p0: Profile): void {
  const doc = stored(p0.name);
  const r = svc.patchProfile(p0.name, patchFromV0(p0, resolveProfile(doc, p0.name)));
  if (!r.saved)
    throw new Error(`catherd: profile "${p0.name}" is invalid: ${r.errors.map((e) => e.message).join("; ")}`);
}

export const saveProfileAndAgents = (p0: Profile, _c?: Catalog): void => saveProfile(p0);
```

`src/tui/profiles.ts` (replace the file: the delete moves into the shim, which the service backs):

```ts
import type { Catalog, Profile } from "../types.ts";
import { saveProfileAndAgents, setActiveProfile } from "./profile-shim.ts";

export { deleteProfile } from "./profile-shim.ts";

export function nameError(name: string, taken: string[]): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) return "Use lowercase letters, digits and dashes, up to 32.";
  if (taken.includes(name)) return `"${name}" already exists.`;
  return null;
}

export function saveAndActivate(p: Profile, c: Catalog): void {
  saveProfileAndAgents(p, c);
  setActiveProfile(p.name);
}
```

Point the 0.x modules at the shim:
- `src/tui/editor.tsx`: the `import { activeProfileName, defaultProfile, listProfiles, loadProfile, validateProfile } from "../profile/profile.ts";` block imports from `"./profile-shim.ts"` instead (place it after the `./matrix.tsx` import).
- `src/tui/init.tsx`: `import { defaultProfile, validateProfile } from "../profile/profile.ts";` → `import { defaultProfile, validateProfile } from "./profile-shim.ts";`
- `src/tui/dashboard.tsx`: delete `import { countLinkedAgents } from "../profile/agents.ts";` and `import { activeProfileName } from "../profile/profile.ts";`, and after `import { Editor } from "./editor.tsx";` add `import { activeProfileName, countLinkedAgents } from "./profile-shim.ts";`
- `src/core/status.ts`: `import { activeProfileName, loadProfile } from "../profile/profile.ts";` → `import { activeProfileName, loadProfile } from "../tui/profile-shim.ts";`

Delete the 0.x profile code and its tests (Tasks 2–4 replace them): `git rm src/profile/profile.ts src/profile/agents.ts src/profile/role-prompts.ts test/validate.test.ts test/agents.test.ts test/profile.test.ts`.

Point the remaining 0.x tests at the shim: in `test/status.test.ts`, `test/tui/editor.test.tsx`, `test/tui/matrix-model.test.ts`, `test/tui/matrix.test.tsx` and `test/tui/profiles.test.ts`, replace the module `"../../src/profile/profile.ts"` (or `"../src/profile/profile.ts"`) with `"../../src/tui/profile-shim.ts"` (or `"../src/tui/profile-shim.ts"`); the imported names are unchanged. Then:
- `test/select.test.ts` tests the 0.x selection the matrix still uses; `patchProfile` was a 0.x helper, so the file gets its own. Replace `import { defaultProfile, patchProfile } from "../src/profile/profile.ts";` with `import { defaultProfile } from "../src/tui/profile-shim.ts";`, add `type Profile, type Role, type RoleConfig,` to its import from `"../src/types.ts"`, add before `const TRACK_A`:

```ts
/** The 0.x default profile with the objective and some roles replaced; each role's fields merge. */
function patched(o: {
  objective?: Profile["objective"];
  roles?: Partial<Record<Role, Partial<RoleConfig>>>;
}): Profile {
  const p = defaultProfile();
  const roles = { ...p.roles };
  for (const [role, rc] of Object.entries(o.roles ?? {}))
    roles[role as Role] = { ...roles[role as Role], ...rc };
  return { ...p, objective: o.objective ?? p.objective, roles };
}
```

  and replace every `patchProfile(defaultProfile(), ` with `patched(`.
- `test/tui/editor.test.tsx`: validation now speaks 1.0; replace `expect(captureCharFrame()).toContain("worker: no usable model is enabled");` with `expect(captureCharFrame()).toContain("the worker role has no usable rung");`.
- The default profile now carries the Go stand-ins (spec §7.2), so the two failover tests that expect none start from a profile without them: in `test/tui/matrix-model.test.ts`, the test `"summarizes failover as a count"` starts with `const p = { ...defaultProfile(), failover: {} };`; in `test/tui/matrix.test.tsx`, `Harness` starts with

```ts
  // start with no failover, so the picker tests see "none" (the default profile fails Codex over to Go)
  const [p, setP] = useState<Profile>(() => ({ ...defaultProfile(), failover: undefined }));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run format && bun test test/tui test/select.test.ts test/status.test.ts test/catalog.test.ts`
Expected: PASS. `ls src/profile` reports no such directory.

- [ ] **Step 5: Run everything, typecheck, lint, commit**

Run: `bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: clean; the full suite passes.

```bash
git add -A src test
git commit -m "refactor(tui): the 0.x TUI edits profiles through a shim over the ProfileService; 0.x profile code removed"
```

---

### Task 7: The structured log and the redactor

Spec §10.2: one JSONL file per day under `<data>/logs/`, seven days kept, the level from `CATHERD_LOG` (Task 8 maps `--verbose` onto it), and a redactor applied to every row (Ruling 13). Logged: each MCP tool call (tool, duration, outcome), each worker spawn (argv, env keys), each supervisor launch, each `runCli` spawn (debug), each reconcile, and each Jev call. The supervisor and launch tests get their own home, since those code paths now write.

**Files:**
- Create: `src/infra/log.ts`
- Modify: `src/infra/supervisor.ts`, `src/infra/launch.ts`, `src/adapters/cli.ts`, `src/services/reconcile.ts`, `src/services/jev-service.ts`, `src/entry/mcp/server.ts`
- Test: `test/infra/log.test.ts`, `test/entry/mcp-log.test.ts`; modify `test/services/jev-service.test.ts`, `test/entry/supervise-bin.test.ts`, `test/infra/launch.test.ts`, `test/infra/supervisor.test.ts`

**Interfaces:**
- Consumes: `logsDir` (`src/infra/paths.ts`), `appendJsonl`, `ensureJsonlHeader` (`src/infra/store.ts`).
- Produces: `LEVELS`, `type Level`, `KEEP_DAYS = 7`, `logLevel()`, `addSecret(value)`, `secretValues(env?)`, `redact<T>(v, secrets?): T`, `logFile(now?)`, `rotate(now?)`, `resetRotation()`, `log(level, event, fields?, now?)` (never throws).

- [ ] **Step 1: Write the failing tests**

`test/infra/log.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addSecret, log, logFile, redact, resetRotation, rotate, secretValues } from "../../src/infra/log.ts";
import { logsDir } from "../../src/infra/paths.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetRotation());

const rows = (now = new Date()) =>
  readFileSync(logFile(now), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("log", () => {
  it("appends one row per event under a schema header, in today's file", () => {
    withHome();
    delete process.env.CATHERD_LOG;
    log("info", "tool", { tool: "status", ms: 3 });
    const [header, row] = rows();
    expect(header).toEqual({ schema: 1, kind: "log" });
    expect(row).toMatchObject({ level: "info", event: "tool", tool: "status", ms: 3, pid: process.pid });
    expect(logFile()).toEndWith(`catherd-${new Date().toISOString().slice(0, 10)}.jsonl`);
  });

  it("keeps rows at or above CATHERD_LOG, info when unset, and nothing when off", () => {
    withHome();
    process.env.CATHERD_LOG = "warn";
    log("info", "a");
    log("warn", "b");
    process.env.CATHERD_LOG = "debug";
    log("debug", "c");
    process.env.CATHERD_LOG = "off";
    log("error", "d");
    expect(
      rows()
        .slice(1)
        .map((r) => r.event),
    ).toEqual(["b", "c"]);
  });

  it("never throws, even when the data dir cannot be written", () => {
    const home = withHome();
    writeFileSync(join(home, "data"), "a file where the data dir should be");
    expect(() => log("error", "x")).not.toThrow();
  });
});

describe("redact", () => {
  it("scrubs every *_KEY and *_TOKEN value and added secrets at any depth, and keeps an env map's keys only", () => {
    const env = { OPENAI_API_KEY: "sk-live-0123456789", GH_TOKEN: "ghp_abcdefghij", HOME: "/home/me" };
    addSecret("tsk-jev-key-000111");
    const secrets = secretValues(env);
    expect(
      redact<unknown>(
        {
          argv: ["codex", "--key", "sk-live-0123456789"],
          note: "token ghp_abcdefghij and tsk-jev-key-000111",
          env,
        },
        secrets,
      ),
    ).toEqual({
      argv: ["codex", "--key", "[redacted]"],
      note: "token [redacted] and [redacted]",
      env: ["GH_TOKEN", "HOME", "OPENAI_API_KEY"],
    });
  });

  it("leaves short values alone, so an ordinary word is never blanked", () => {
    expect(secretValues({ SOME_KEY: "yes" })).not.toContain("yes");
  });
});

describe("rotate", () => {
  it("keeps the last seven days of logs, today included, and nothing else it did not write", () => {
    withHome();
    mkdirSync(logsDir(), { recursive: true });
    const now = new Date("2026-09-25T12:00:00Z");
    for (let d = 0; d < 10; d++) {
      const date = new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10);
      writeFileSync(join(logsDir(), `catherd-${date}.jsonl`), "");
    }
    writeFileSync(join(logsDir(), "notes.txt"), "");
    rotate(now);
    expect(readdirSync(logsDir()).sort()).toEqual([
      "catherd-2026-09-19.jsonl",
      "catherd-2026-09-20.jsonl",
      "catherd-2026-09-21.jsonl",
      "catherd-2026-09-22.jsonl",
      "catherd-2026-09-23.jsonl",
      "catherd-2026-09-24.jsonl",
      "catherd-2026-09-25.jsonl",
      "notes.txt",
    ]);
    expect(existsSync(join(logsDir(), "catherd-2026-09-18.jsonl"))).toBe(false);
  });
});
```

`test/entry/mcp-log.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { logFile } from "../../src/infra/log.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";

afterEach(snapshotEnv());

describe("the MCP server's log (spec §10.2)", () => {
  it("logs each tool call with its duration and outcome, never its input", async () => {
    withHome();
    delete process.env.CATHERD_LOG;
    const c = await mcpClient();
    await call(c, "status");
    await call(c, "status", { run: "secret-run-id-value" });
    const rows = readFileSync(logFile(), "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l));
    const tools = rows.filter((r) => r.event === "tool");
    expect(tools.map((r) => [r.tool, r.ok, r.code ?? null])).toEqual([
      ["status", true, null],
      ["status", false, "E_RUN_NOT_FOUND"],
    ]);
    expect(typeof tools[0].ms).toBe("number");
    expect(readFileSync(logFile(), "utf8")).not.toContain("secret-run-id-value");
  });
});
```

In `test/services/jev-service.test.ts`: import `beforeEach` from `bun:test`; add `import { logFile } from "../../src/infra/log.ts";` after the `jev-client.ts` import; after `afterEach(snapshotEnv());` add

```ts
// every test gets its own CATHERD_HOME, so Jev log rows never reach the real data dir
beforeEach(() => void withHome());
```

and append:

```ts
describe("askJev and the log", () => {
  it("logs each Jev call with its question set and state hash, never the state or the key", async () => {
    withHome();
    delete process.env.CATHERD_LOG;
    const key = "tsk-live-abcdefghijkl";
    const f = fakeFetch({ status: 503, body: { error: "down" } });
    await askJev(
      mkdtempSync(join(tmpdir(), "catherd-jevlog-")),
      "route-v2",
      { title: "lane secret-title" },
      { key, fetchImpl: f.impl, retries: 0 },
    );
    const text = readFileSync(logFile(), "utf8");
    const row = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((r) => r.event === "jev");
    expect(row).toMatchObject({ level: "warn", set: "route-v2", attempts: 1, error: "http 503" });
    expect(row.questionSet).toStartWith("route-v2#");
    expect(text).not.toContain("secret-title");
    expect(text).not.toContain(key);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/infra/log.test.ts test/entry/mcp-log.test.ts test/services/jev-service.test.ts`
Expected: FAIL — `Cannot find module '../../src/infra/log.ts'`.

- [ ] **Step 3: Write the implementation**

`src/infra/log.ts`:

```ts
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { logsDir } from "./paths.ts";
import { appendJsonl, ensureJsonlHeader } from "./store.ts";

// Spec §10.2: `<data>/logs/catherd-<date>.jsonl`, 7-day rotation, level from CATHERD_LOG or `--verbose`.

export const LEVELS = ["off", "error", "warn", "info", "debug"] as const;
export type Level = Exclude<(typeof LEVELS)[number], "off">;
/** Days of logs kept, today included. */
export const KEEP_DAYS = 7;

/** `CATHERD_LOG` (off, error, warn, info, debug); info when unset or unknown. */
export function logLevel(): (typeof LEVELS)[number] {
  const v = process.env.CATHERD_LOG?.toLowerCase();
  return (LEVELS as readonly string[]).includes(v ?? "") ? (v as Level) : "info";
}

const rank = (l: string) => LEVELS.indexOf(l as (typeof LEVELS)[number]);

/** Env names whose values are secrets: every `*_KEY` and `*_TOKEN`, and a few other shapes. */
const SECRET_NAME = /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/i;
/** A value this short is never scrubbed: it would blank ordinary words. */
const MIN_SECRET = 8;

const extra = new Set<string>();
/** A secret that lives outside the env (the saved Jev key): scrubbed from every row from now on. */
export function addSecret(value: string | null | undefined): void {
  if (value && value.length >= MIN_SECRET) extra.add(value);
}

export function secretValues(env: Record<string, string | undefined> = process.env): string[] {
  const vals = Object.entries(env)
    .filter(([k, v]) => SECRET_NAME.test(k) && v !== undefined && v.length >= MIN_SECRET)
    .map(([, v]) => v as string);
  return [...new Set([...vals, ...extra])].sort((a, b) => b.length - a.length);
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `v` with every known secret replaced by `[redacted]`, in any string at any depth, and every env map
 * (a field named `env`) reduced to its keys.
 */
export function redact<T>(v: T, secrets: string[] = secretValues()): T {
  const walk = (x: unknown, key: string | null): unknown => {
    if (typeof x === "string") return secrets.reduce((s, secret) => s.split(secret).join("[redacted]"), x);
    if (Array.isArray(x)) return x.map((y) => walk(y, null));
    if (isPlain(x)) {
      if (key === "env") return Object.keys(x).sort();
      return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y, k)]));
    }
    return x;
  };
  return walk(v, null) as T;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
export const logFile = (now: Date = new Date()): string => join(logsDir(), `catherd-${day(now)}.jsonl`);

let rotatedOn: string | null = null;
/** Deletes log files from before the last KEEP_DAYS days; once per process per day. */
export function rotate(now: Date = new Date()): void {
  if (rotatedOn === day(now) || !existsSync(logsDir())) return;
  rotatedOn = day(now);
  const oldest = day(new Date(now.getTime() - (KEEP_DAYS - 1) * 86_400_000));
  for (const f of readdirSync(logsDir())) {
    const m = /^catherd-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (m && (m[1] as string) < oldest) rmSync(join(logsDir(), f), { force: true });
  }
}

/** Tests only: rotate again on the next write. */
export const resetRotation = (): void => {
  rotatedOn = null;
};

/** One redacted JSONL row. Never throws: logging must not fail the work it records. */
export function log(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {},
  now: Date = new Date(),
): void {
  if (rank(level) > rank(logLevel())) return;
  try {
    rotate(now);
    const file = logFile(now);
    ensureJsonlHeader(file, "log");
    appendJsonl(file, redact({ at: now.toISOString(), level, event, pid: process.pid, ...fields }));
  } catch {
    // a full disk or an unwritable data dir costs the log row, never the call
  }
}
```

Hook it in:
- `src/infra/supervisor.ts`: import `log` from `"./log.ts"` (before the `./proc.ts` import), and right after the `child = Bun.spawn([spec.cmd, ...spec.args], { … });` statement add:

```ts
    log("info", "spawn", {
      backend: spec.backend,
      dispatch: spec.dispatchDir,
      argv: [spec.cmd, ...spec.args],
      env: spec.env,
      cwd: spec.cwd,
      pid: child.pid,
    });
```

  (`redact` turns `env` into its keys.)
- `src/infra/launch.ts`: add `import { log as logRow } from "./log.ts";` after the `./env.ts` import (the function has a local named `log`), and after `p.unref();` add `logRow("info", "launch", { spec: specPath, pid: p.pid });`.
- `src/adapters/cli.ts`: add `import { log } from "../infra/log.ts";`, and after the `if (!Bun.which(bin, …)) return null;` line add `log("debug", "spawn", { argv: [bin, ...args], env: o.env ?? {} });`.
- `src/services/reconcile.ts`: add `import { log } from "../infra/log.ts";` after the last import, and before the final `return { ...report, done: … };` add:

```ts
  log("info", "reconcile", {
    runs: runs.length,
    finalized: report.finalized.length,
    watching: report.watching.length,
    warnings: report.warnings,
  });
```

- `src/services/jev-service.ts`: add `import { addSecret, log } from "../infra/log.ts";` before the `paths.ts` import, and replace the request line in `askJev`

```ts
  const res = await jevRequest("POST", "/systemone", apiKey, { model: f.model, state, questions }, o);
```

  with:

```ts
  addSecret(apiKey);
  const res = await jevRequest("POST", "/systemone", apiKey, { model: f.model, state, questions }, o);
  log(res.ok ? "info" : "warn", "jev", {
    set,
    questionSet: meta.questionSet,
    stateHash: meta.stateHash,
    requestId: res.ok ? res.requestId : null,
    latencyMs: res.latencyMs,
    attempts: res.attempts,
    ...(res.ok ? {} : { error: res.error }),
  });
```

- `src/entry/mcp/server.ts`: after the `StdioServerTransport` import add

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../../infra/log.ts";
```

  before `export function buildServer` add

```ts
type Handler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

/** Spec §10.2: every tool call is logged with its duration and outcome (the error code), never its input. */
function logToolCalls(server: McpServer): void {
  const register = server.registerTool.bind(server) as unknown as (
    n: string,
    c: unknown,
    h: Handler,
  ) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, handler) =>
    register(name, config, async (...args: unknown[]) => {
      const started = Date.now();
      const r = await handler(...args);
      const code = r.isError ? (r.structuredContent as { code?: string } | undefined)?.code : undefined;
      log(r.isError ? "warn" : "info", "tool", {
        tool: name,
        ms: Date.now() - started,
        ok: !r.isError,
        code,
      });
      return r;
    });
}
```

  and make `logToolCalls(server);` the second line of `buildServer`, right after `const server = new McpServer(…)`, so it wraps every tool registered below.

Give the three test files whose code now logs their own home. In `test/entry/supervise-bin.test.ts` and `test/infra/launch.test.ts`: import `beforeEach` from `bun:test` and `withHome` with `snapshotEnv` from `"../helpers.ts"`, and after `afterEach(snapshotEnv());` add

```ts
// the supervisor and launchSupervisor log (spec §10.2): keep their rows out of the real data dir
beforeEach(() => void withHome());
```

In `test/infra/supervisor.test.ts`: import `afterEach, beforeEach` from `bun:test`, and after the `supervisor.ts` import add

```ts
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());
// the supervisor logs each spawn (spec §10.2): keep the rows out of the real data dir
beforeEach(() => void withHome());
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run format && bun test test/infra test/entry/mcp-log.test.ts test/entry/supervise-bin.test.ts test/services/jev-service.test.ts`
Expected: PASS. Afterwards `ls ~/.local/share/catherd/logs` shows nothing new: no test wrote to the real data dir.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint && bun run format:check`
Expected: clean.

```bash
git add -A src test
git commit -m "feat(infra): a daily JSONL log with 7-day rotation and a secret redactor, for tools, spawns, reconciles and Jev"
```

---

### Task 8: The CLI runner: the Bun guard, lazy subcommands and exit codes

`src/cli.ts` becomes spec §8's runner: the Bun guard runs before anything else loads (§3.1), every subcommand loads lazily, `--verbose` anywhere before `--` sets `CATHERD_LOG=debug`, `--help` and `--version` are answered first, and errors map to §8's exit codes and one-line format (Ruling 14). `_supervise` is hidden. `src/entry/cli-kit.ts` holds what every command shares. The import-graph helper moves out of the launch test so the CLI test can use it.

**Files:**
- Create: `src/domain/runtime.ts`, `src/entry/cli-kit.ts`, `test/import-graph.ts`
- Modify: `src/cli.ts` (replace), `src/domain/errors.ts`, `src/entry/supervise.ts`, `test/infra/launch.test.ts`
- Test: `test/entry/cli.test.ts`

**Interfaces:**
- Consumes: `CatherdError`, `isCatherdError`; `VERSION` (`src/infra/version.ts`).
- Produces: `MIN_BUN = "1.4.0"`, `bunTooOld(version, min?)`, `runtimeRefusal(version | undefined): string[] | null` (`src/domain/runtime.ts`); error code `E_RUNTIME_TOO_OLD`; `EXIT = { ok: 0, error: 1, usage: 2, notReady: 3, interrupted: 130 }`, `printError(e)`, `exitCodeOf(e)`, `printJson(v)`, `mark(state, plain?)` (`src/entry/cli-kit.ts`); `main`, `runCli(argv): Promise<number>` (`src/cli.ts`); test helpers `SRC`, `importGraph(entry)` (`test/import-graph.ts`).

- [ ] **Step 1: Write the failing test**

`test/import-graph.ts` (moved out of `test/infra/launch.test.ts`):

```ts
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export const SRC = resolve(import.meta.dir, "../src");
const IMPORT =
  /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/** Every file and package `entry` reaches through static and dynamic imports (paths relative to src/). */
export function importGraph(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const spec = (m[1] ?? m[2] ?? m[3]) as string;
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
      else packages.add(spec);
    }
  }
  return { files: [...files].map((f) => relative(SRC, f)), packages: [...packages] };
}
```

In `test/infra/launch.test.ts`, delete the `SRC` constant, the `IMPORT` regex and the `importGraph` function, add `import { importGraph, SRC } from "../import-graph.ts";`, and trim the `node:path` import to `import { join, relative } from "node:path";`.

`test/entry/cli.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { bunTooOld, MIN_BUN, runtimeRefusal } from "../../src/domain/runtime.ts";
import { VERSION } from "../../src/infra/version.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { importGraph, SRC } from "../import-graph.ts";

afterEach(snapshotEnv());

const CLI = join(SRC, "cli.ts");
function catherd(args: string[], env: Record<string, string | undefined> = {}) {
  const p = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: { ...process.env, PATH: "/nonexistent", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("the Bun guard (spec §3.1)", () => {
  it("compares versions numerically against 1.4.0", () => {
    expect(MIN_BUN).toBe("1.4.0");
    expect([
      bunTooOld("1.3.11"),
      bunTooOld("1.4.0"),
      bunTooOld("1.4.2"),
      bunTooOld("1.10.0"),
      bunTooOld("2.0.0"),
    ]).toEqual([true, false, false, false, false]);
  });

  it("refuses an old or missing Bun with the upgrade command", () => {
    expect(runtimeRefusal("1.3.11")).toEqual([
      "error E_RUNTIME_TOO_OLD: catherd needs Bun 1.4.0 or newer; this is Bun 1.3.11",
      "fix: bun upgrade (or install Bun: curl -fsSL https://bun.sh/install | bash)",
    ]);
    expect(runtimeRefusal(undefined)?.[0]).toContain("this is not Bun");
    expect(runtimeRefusal(Bun.version)).toBeNull();
  });
});

describe("catherd (spec §8)", () => {
  it("prints its version", () => {
    expect(catherd(["--version"])).toEqual({ code: 0, out: `${VERSION}\n`, err: "" });
  });

  it("exits 2 on a usage error, with one error line and a fix", () => {
    withHome();
    const r = catherd(["nope"], { NO_COLOR: "1" });
    expect([r.code, r.err]).toEqual([
      2,
      "error E_INPUT_INVALID: Unknown command nope\nfix: catherd --help\n",
    ]);
  });

  it("exits 1 on a catherd error, with one error line and a fix", () => {
    withHome();
    const r = catherd(["_supervise", "/nonexistent/spec.json"]);
    expect(r.code).toBe(1);
    expect(r.err).toStartWith("error E_CONFIG_INVALID: /nonexistent/spec.json is not readable JSON");
    expect(r.err).toContain("\nfix: fix or delete /nonexistent/spec.json\n");
  });

  it("hides _supervise from help, and leaves a command's own --help and --verbose after -- alone", () => {
    withHome();
    const help = catherd(["--help"], { NO_COLOR: "1" });
    expect(help.code).toBe(0);
    expect(help.out).toContain("capture-fixtures");
    expect(help.out).not.toContain("_supervise");
    const passed = catherd(
      ["lock", "--slots", "1", "--", "sh", "-c", 'echo "$@"', "sh", "--help", "--verbose"],
      {
        PATH: process.env.PATH,
      },
    );
    expect([passed.code, passed.out]).toEqual([0, "--help --verbose\n"]);
  });

  it("takes --verbose anywhere before --", () => {
    withHome();
    expect(catherd(["--verbose", "--version"])).toEqual({ code: 0, out: `${VERSION}\n`, err: "" });
    expect(catherd(["catalog", "list", "--verbose", "--backend", "codex", "--text", "gpt-6-luna"]).code).toBe(
      0,
    );
  });

  it("exits 130 when interrupted", async () => {
    const home = withHome();
    const p = Bun.spawn([process.execPath, CLI, "mcp"], {
      env: { ...process.env, CATHERD_HOME: home },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    await Bun.sleep(800);
    p.kill("SIGINT");
    expect(await p.exited).toBe(130);
  });

  it("never loads OpenTUI or React for mcp, lock or _supervise (spec §3.1)", () => {
    for (const entry of ["entry/mcp/command.ts", "entry/lock.ts", "entry/supervise.ts"]) {
      const g = importGraph(join(SRC, entry));
      expect(g.packages.filter((p) => p.startsWith("@opentui") || p === "react")).toEqual([]);
      expect(g.files.filter((f) => f.startsWith("tui/"))).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/entry/cli.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/runtime.ts'`.

- [ ] **Step 3: Write the implementation**

`src/domain/runtime.ts`:

```ts
/** Spec §3.1 and D6: catherd runs on Bun 1.4.0 or newer. */
export const MIN_BUN = "1.4.0";

const parts = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1) ?? ["0", "0", "0"]).map(Number);

export function bunTooOld(version: string, min: string = MIN_BUN): boolean {
  const a = parts(version);
  const b = parts(min);
  for (let i = 0; i < 3; i++)
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) < (b[i] as number);
  return false;
}

/** The two lines to print, and exit 1 on, when this Bun is too old; null when it is new enough. */
export function runtimeRefusal(version: string | undefined): string[] | null {
  if (version !== undefined && !bunTooOld(version)) return null;
  return [
    `error E_RUNTIME_TOO_OLD: catherd needs Bun ${MIN_BUN} or newer; this is ${version ? `Bun ${version}` : "not Bun"}`,
    "fix: bun upgrade (or install Bun: curl -fsSL https://bun.sh/install | bash)",
  ];
}
```

In `src/domain/errors.ts`, add `| "E_RUNTIME_TOO_OLD"` after `| "E_INPUT_INVALID"` in `ErrorCode`.

`src/entry/cli-kit.ts`:

```ts
import { type CatherdError, isCatherdError } from "../domain/errors.ts";

/** Spec §8: 0 ok, 1 error, 2 usage, 3 not ready (doctor), 130 interrupted. */
export const EXIT = { ok: 0, error: 1, usage: 2, notReady: 3, interrupted: 130 } as const;

// oxlint-disable-next-line no-control-regex -- citty colours its messages; the one-line error must not
const ANSI = /\x1b\[[0-9;]*m/g;

/** Spec §8: one line `error E_CODE: message`, then `fix: …` when there is one. */
export function printError(e: Pick<CatherdError, "code" | "message" | "fix">): void {
  console.error(`error ${e.code}: ${e.message.replace(ANSI, "").split("\n").join(" ")}`);
  if (e.fix) console.error(`fix: ${e.fix}`);
}

/** Bad input from the command line is a usage error; any other catherd error is an error. */
export const exitCodeOf = (e: unknown): number =>
  isCatherdError(e) && e.code === "E_INPUT_INVALID" ? EXIT.usage : EXIT.error;

export const printJson = (v: unknown): void => console.log(JSON.stringify(v, null, 2));

/** Glyph and word for a state, `✓ ready`-style (spec §9.3's words; ASCII with `--plain`). */
export function mark(state: "ok" | "warn" | "fail" | "skip", plain = false): string {
  const g = plain
    ? { ok: "+", warn: "!", fail: "x", skip: "-" }
    : { ok: "✓", warn: "!", fail: "✗", skip: "-" };
  return g[state];
}
```

`src/cli.ts` (replace the file):

```ts
#!/usr/bin/env bun
import { runtimeRefusal } from "./domain/runtime.ts";

// Spec §3.1: refuse an old Bun before anything else loads.
const refusal = runtimeRefusal(typeof Bun === "undefined" ? undefined : Bun.version);
if (refusal) {
  for (const line of refusal) console.error(line);
  process.exit(1);
}

const { realpathSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { defineCommand, runCommand, showUsage } = await import("citty");
const { CatherdError, isCatherdError } = await import("./domain/errors.ts");
const { EXIT, exitCodeOf, printError } = await import("./entry/cli-kit.ts");
const { VERSION } = await import("./infra/version.ts");

type Command = ReturnType<typeof defineCommand>;

/**
 * Spec §8. Every subcommand loads lazily, so `mcp`, `lock` and `_supervise` never load OpenTUI or React
 * (spec §3.1); a bare `catherd` opens the TUI.
 */
export const main: Command = defineCommand({
  meta: {
    name: "catherd",
    version: VERSION,
    description: "Herds coding agents. Any command takes --verbose: log at debug level (CATHERD_LOG=debug).",
  },
  subCommands: {
    init: () => import("./tui/commands.ts").then((m) => m.initCommand),
    watch: () => import("./tui/commands.ts").then((m) => m.watchCommand),
    catalog: () => import("./entry/catalog-command.ts").then((m) => m.catalogCommand),
    lock: () => import("./entry/lock.ts").then((m) => m.lockCommand),
    "capture-fixtures": () => import("./entry/capture-fixtures.ts").then((m) => m.captureFixturesCommand),
    mcp: () => import("./entry/mcp/command.ts").then((m) => m.mcpCommand),
    _supervise: () => import("./entry/supervise.ts").then((m) => m.superviseCommand),
  },
  // citty runs this after any subcommand too; only a bare `catherd` opens the dashboard.
  async run(ctx) {
    if (!ctx.rawArgs.every((a) => a.startsWith("-"))) return;
    await (await import("./tui/commands.ts")).editorRun(ctx);
  },
});

const resolve = async <T>(v: T | Promise<T> | (() => T | Promise<T>)): Promise<T> =>
  typeof v === "function" ? await (v as () => T | Promise<T>)() : await v;

/** The deepest command `argv` names and its parent: what `--help` and a usage error describe. */
async function commandFor(argv: string[]): Promise<[Command, Command | undefined, string[]]> {
  let cmd = main;
  let parent: Command | undefined;
  const path: string[] = [];
  for (const a of argv) {
    if (a.startsWith("-")) continue;
    const subs = cmd.subCommands ? await resolve(cmd.subCommands) : undefined;
    const next = subs?.[a];
    if (!next) break;
    parent = cmd;
    cmd = (await resolve(next)) as Command;
    path.push(a);
  }
  return [cmd, parent, path];
}

const isCliError = (e: unknown): e is Error & { code: string } => e instanceof Error && e.name === "CLIError";

/** Runs `catherd <argv>` and returns its exit code (spec §8). */
export async function runCli(argv: string[]): Promise<number> {
  // catherd's own flags are those before `--`; everything after belongs to the command `lock` runs
  const dashdash = argv.indexOf("--");
  const head = dashdash < 0 ? argv : argv.slice(0, dashdash);
  if (head.includes("--verbose")) process.env.CATHERD_LOG = "debug";
  const own = head.filter((a) => a !== "--verbose");
  const rawArgs = [...own, ...(dashdash < 0 ? [] : argv.slice(dashdash))];
  if (own.length === 1 && (own[0] === "--version" || own[0] === "-v")) {
    console.log(VERSION);
    return EXIT.ok;
  }
  if (own.includes("--help") || own.includes("-h")) {
    const [cmd, parent] = await commandFor(own);
    await showUsage(cmd, parent);
    return EXIT.ok;
  }
  // `lock` forwards signals to its command itself; everything else stops at once on Ctrl-C.
  if (own[0] !== "lock") process.once("SIGINT", () => process.exit(EXIT.interrupted));
  try {
    await runCommand(main, { rawArgs });
    return Number(process.exitCode ?? EXIT.ok);
  } catch (e) {
    if (isCliError(e)) {
      const [, , path] = await commandFor(own);
      printError(
        new CatherdError("E_INPUT_INVALID", e.message, { fix: `catherd ${[...path, "--help"].join(" ")}` }),
      );
      return EXIT.usage;
    }
    if (isCatherdError(e)) {
      printError(e);
      return exitCodeOf(e);
    }
    printError({
      code: "E_IO_UNEXPECTED",
      message: e instanceof Error ? e.message : String(e),
      fix: "this is a catherd bug: report it with this message and the output of the same command with --verbose",
    });
    return EXIT.error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
```

In `src/entry/supervise.ts`, hide the internal command: `meta: { name: "_supervise", description: "internal: supervise one worker process", hidden: true },`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run format && bun test test/entry test/infra/launch.test.ts test/tui/commands.test.ts`
Expected: PASS. The SIGINT test sees `catherd mcp` exit 130; the import-graph test sees no `@opentui` package and no `tui/` file behind `mcp`, `lock` or `_supervise`.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint && bun run format:check`
Expected: clean.

```bash
git add -A src test
git commit -m "feat(cli): the Bun 1.4 guard, lazy subcommands, spec §8 exit codes and one-line errors"
```

---

### Task 9: `catherd profile …`

Spec §8's `profile list|show|use [--repo]|new|copy|rm|set <path> <value>|diff|validate`, each a thin call into the ProfileService. `show` prints every role with its access and its backend's enforcement (D10) and marks inferred stand-ins (Ruling 2); `set` goes through `patchAt` (Ruling 9); an invalid save is one `E_CONFIG_INVALID` line with the first fix, exit 1; bad input is exit 2.

**Files:**
- Create: `src/entry/profile-command.ts`, `test/fixtures/profiles/bad.json`
- Modify: `src/cli.ts` (one subcommand)
- Test: `test/entry/profile-command.test.ts`

**Interfaces:**
- Consumes: Task 4 (`activate`, `activeName`, `createProfile`, `deleteProfile`, `diffNamed`, `getProfile`, `listProfiles`, `patchProfile`, `readProjects`, `roleEnforcement`, `runnableBackends`, `Synced`, `validateNamed`), Task 1 (`patchAt`, `Change`, `Profile`), Task 2 (`inferredScores`, `Issue`), Task 8 (`EXIT`, `mark`, `printJson`, the runner's error mapping); plan 4's `loadCatalog`, `rungInfo`; `gitToplevel` (`src/infra/git.ts`).
- Produces: `interface StandIn { from; to; inferred; via }`, `standIns(p, c): StandIn[]`, `formatChange(c): string`, `formatIssue(i, glyph): string[]`, `formatProfile(p, o: { active; enforcement; standIns; backends }): string[]`, `profileCommand`.

- [ ] **Step 1: Write the failing test**

`test/fixtures/profiles/bad.json`:

```json
{
  "schema": 1,
  "name": "bad",
  "roles": {
    "reviewer": { "rungs": ["codex:gpt-6-sol#turbo"] },
    "verifier": { "access": "read-only" }
  }
}
```

`test/entry/profile-command.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeAgentsDir } from "../../src/infra/paths.ts";
import { activeName, getProfile, profilesDir } from "../../src/services/profile-service.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { SRC } from "../import-graph.ts";

afterEach(snapshotEnv());

function catherd(args: string[], cwd?: string) {
  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), "profile", ...args], {
    env: { ...process.env, NO_COLOR: "1" },
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("catherd profile show", () => {
  it("shows each role's access and enforcement, and marks the Go stand-ins inferred", () => {
    withHome();
    const r = catherd(["show"]);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toBe("profile default (active)");
    expect(lines.find((l) => l.startsWith("  reviewer"))).toBe(
      "  reviewer     read-only, enforced          codex:gpt-6-sol#high",
    );
    expect(lines.find((l) => l.startsWith("  architect"))).toContain("read-only, advisory");
    expect(r.out).toContain("  codex:gpt-6-luna#high → opencode:opencode-go/gpt-6-luna#high (inferred)\n");
    expect(r.out).toContain(
      "  codex:gpt-6-sol#medium → opencode:opencode-go/kimi-k3#max (inferred: treated like gpt-6-sol#medium)\n",
    );
    expect(r.out).not.toContain("cursor");
  });

  it("prints JSON with every default filled in", () => {
    withHome();
    const j = JSON.parse(catherd(["show", "--json"]).out);
    expect(j.profile.timeouts).toEqual({ idleMin: 15, wallMin: 90 });
    expect(j.enforcement.worker).toBe("enforced");
    expect(j.standIns[1]).toEqual({
      from: "codex:gpt-6-sol#medium",
      to: "opencode:opencode-go/kimi-k3#max",
      inferred: true,
      via: "gpt-6-sol#medium",
    });
  });
});

describe("catherd profile set", () => {
  it("saves one field, prints the change and any warning, and relinks the agents", () => {
    withHome();
    const r = catherd(["set", "roles.verifier.access", "read-only"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "✓ roles.verifier.access: full → read-only",
        "! roles.verifier.access: verifier runs read-only; catherd's default for it is full",
        "new Claude Code session needed for: catherd-default-architect-claude-opus-5-5-high, catherd-default-verifier-claude-opus-5-5-low",
        "",
      ].join("\n"),
    );
    expect(getProfile("default").roles.verifier.access).toBe("read-only");
    expect(existsSync(join(claudeAgentsDir(), "catherd-default-verifier-claude-opus-5-5-low.md"))).toBe(true);
  });

  it("refuses an invalid result with exit 1 and saves nothing", () => {
    withHome();
    const r = catherd(["set", "roles.worker.enabled", "false"]);
    expect([r.code, r.err]).toEqual([
      1,
      "error E_CONFIG_INVALID: the profile was not saved: roles.worker.enabled: the worker cannot be disabled\nfix: catherd profile set roles.worker.enabled true\n",
    ]);
    expect(existsSync(join(profilesDir(), "default.json"))).toBe(false);
  });

  it("refuses an unknown path with exit 2", () => {
    withHome();
    const r = catherd(["set", "roles.worker.colour", "red"]);
    expect(r.code).toBe(2);
    expect(r.err).toStartWith(
      'error E_INPUT_INVALID: cannot set roles.worker.colour to red: ✖ Unrecognized key: "colour"',
    );
  });

  it("sets a failover whose rung holds dots, and removes it with null", () => {
    withHome();
    expect(
      catherd(["set", "failover.codex:gpt-5.6-sol#high", "opencode:opencode-go/gpt-5.6-luna#max"]).code,
    ).toBe(0);
    expect(getProfile("default").failover["codex:gpt-5.6-sol#high"]).toBe(
      "opencode:opencode-go/gpt-5.6-luna#max",
    );
    expect(catherd(["set", "failover.codex:gpt-5.6-sol#high", "null"]).code).toBe(0);
    expect(getProfile("default").failover["codex:gpt-5.6-sol#high"]).toBeUndefined();
  });
});

describe("catherd profile use, new, copy, rm, list, diff", () => {
  it("binds a profile to the repo it runs in, and refuses --repo outside one", () => {
    withHome();
    const repo = tempRepo();
    expect(catherd(["new", "fast"]).code).toBe(0);
    const r = catherd(["use", "fast", "--repo"], repo);
    expect(r.out.split("\n")[0]).toMatch(/^✓ fast is bound to \/.+$/);
    expect(r.out).toContain(
      "new Claude Code session needed for: catherd-fast-architect-claude-opus-5-5-high",
    );
    const top = r.out.split("\n")[0]?.replace("✓ fast is bound to ", "") as string;
    expect(activeName(top)).toBe("fast");
    const outside = catherd(["use", "fast", "--repo"], "/");
    expect([outside.code, outside.err.split("\n")[0]]).toEqual([
      2,
      "error E_INPUT_INVALID: / is not inside a git repository",
    ]);
  });

  it("creates, copies, lists, diffs and deletes profiles", () => {
    withHome();
    catherd(["set", "budget.usd", "5"]);
    expect(catherd(["copy", "default", "team"]).out).toBe("✓ copied default to team\n");
    expect(catherd(["new", "fast"]).code).toBe(0);
    expect(catherd(["use", "team"]).out).toBe(
      "✓ team is active\nnew Claude Code session needed for: catherd-team-architect-claude-opus-5-5-high, catherd-team-verifier-claude-opus-5-5-low\n",
    );
    expect(catherd(["list"]).out).toBe("  default\n  fast\n* team\n");
    expect(catherd(["diff", "fast"]).out).toBe("budget.usd: 5 → none\n");
    expect(catherd(["diff", "team", "default"]).out).toBe("no differences\n");
    const busy = catherd(["rm", "team"]);
    expect([busy.code, busy.err.split("\n")[0]]).toEqual([
      2,
      'error E_INPUT_INVALID: "team" is the active profile',
    ]);
    expect(catherd(["rm", "fast"]).out).toBe("✓ deleted fast\n");
    expect(JSON.parse(catherd(["list", "--json"]).out)).toEqual([
      { name: "default", active: false, repos: [] },
      { name: "team", active: true, repos: [] },
    ]);
  });
});

describe("catherd profile validate", () => {
  it("prints errors and warnings, and exits 1 on an error", () => {
    withHome();
    expect(catherd(["validate"])).toEqual({ code: 0, out: "✓ valid\n", err: "" });
    mkdirSync(profilesDir(), { recursive: true });
    const doc = JSON.parse(readFileSync(join(SRC, "..", "test", "fixtures", "profiles", "bad.json"), "utf8"));
    writeFileSync(join(profilesDir(), "bad.json"), JSON.stringify(doc));
    const r = catherd(["validate", "bad"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ roles.reviewer.rungs: codex:gpt-6-sol#turbo is unscored\n");
    expect(r.out).toContain(
      "! roles.verifier.access: verifier runs read-only; catherd's default for it is full\n",
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/entry/profile-command.test.ts`
Expected: FAIL — every CLI call exits 2 with `error E_INPUT_INVALID: Unknown command profile`.

- [ ] **Step 3: Write the implementation**

`src/entry/profile-command.ts`:

```ts
import { defineCommand } from "citty";
import type { Catalog } from "../domain/catalog.ts";
import { rungInfo } from "../domain/catalog.ts";
import { CatherdError } from "../domain/errors.ts";
import { type Change, patchAt, type Profile } from "../domain/profile.ts";
import { inferredScores, type Issue } from "../domain/profile-rules.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { gitToplevel } from "../infra/git.ts";
import { loadCatalog } from "../services/catalog-service.ts";
import {
  activate,
  activeName,
  createProfile,
  deleteProfile,
  diffNamed,
  getProfile,
  listProfiles,
  patchProfile,
  readProjects,
  roleEnforcement,
  runnableBackends,
  type Synced,
  validateNamed,
} from "../services/profile-service.ts";
import { EXIT, mark, printJson } from "./cli-kit.ts";

const json = { json: { type: "boolean", description: "print JSON" } } as const;

export interface StandIn {
  from: string;
  to: string;
  inferred: boolean;
  via: string | null;
}

/** Spec §7.2: each stand-in, marked inferred when its scores are catherd's guess. */
export function standIns(p: Profile, c: Catalog): StandIn[] {
  return Object.entries(p.failover).map(([from, to]) => {
    try {
      return { from, to, ...inferredScores(c, rungInfo(c, to)) };
    } catch {
      return { from, to, inferred: false, via: null };
    }
  });
}

const value = (v: unknown) => (v === null ? "none" : typeof v === "string" ? v : JSON.stringify(v));
export const formatChange = (c: Change): string => `${c.path}: ${value(c.before)} → ${value(c.after)}`;
export const formatIssue = (i: Issue, glyph: string): string[] => [
  `${glyph} ${i.path}: ${i.message}`,
  ...(i.fix ? [`  fix: ${i.fix}`] : []),
];

/** `profile show`: every setting, each role with its access and how strongly its backend holds it (spec D10). */
export function formatProfile(
  p: Profile,
  o: {
    active: boolean;
    enforcement: Record<Role, "enforced" | "advisory">;
    standIns: StandIn[];
    /** the backends catherd can run: runnableBackends() */
    backends: string[];
  },
): string[] {
  const width = Math.max(...ROLES.map((r) => r.length));
  const lines = [
    `profile ${p.name}${o.active ? " (active)" : ""}`,
    `objective ${p.objective} · jev ${p.jev.use} · heavy slots ${p.lock.heavy} · notify ${p.notify.join(", ") || "none"}`,
    "roles",
  ];
  for (const role of ROLES) {
    const rc = p.roles[role];
    if (!rc.enabled) {
      lines.push(`  ${role.padEnd(width)}  off`);
      continue;
    }
    const ladder = rc.rungs.map((r) => (r === rc.defaultRung ? `${r} (default)` : r)).join(" → ");
    lines.push(
      `  ${role.padEnd(width)}  ${`${rc.access}, ${o.enforcement[role]}`.padEnd(27)}  ${ladder || "no rungs"}`,
    );
  }
  // only what catherd can run today: a backend without an adapter has nothing to bill or isolate
  const runs = ([key]: [string, unknown]) => o.backends.includes(key === "opencode-go" ? "opencode" : key);
  const billing = Object.entries(p.billing).filter(runs);
  lines.push(`billing ${billing.map(([k, m]) => `${k} ${m}`).join(" · ")}`);
  const harness = Object.entries(p.harness).filter(runs);
  lines.push(`harness ${harness.map(([k, h]) => `${k} ${h.isolated ? "isolated" : "native"}`).join(" · ")}`);
  lines.push(o.standIns.length ? "failover" : "failover none");
  for (const s of o.standIns)
    lines.push(
      `  ${s.from} → ${s.to}${s.inferred ? ` (inferred${s.via ? `: treated like ${s.via}` : ""})` : ""}`,
    );
  const budget = Object.entries(p.budget).map(([k, v]) => (k === "usd" ? `$${v}` : `${v} ${k}`));
  lines.push(`budget ${budget.join(" · ") || "no cap"}`);
  lines.push(`timeouts idle ${p.timeouts.idleMin} min · wall ${p.timeouts.wallMin} min`);
  lines.push(
    `preflight ${p.preflight.confirm ? "shows its commands and asks first" : "runs the checks without asking"}`,
  );
  return lines;
}

function printSynced(r: Pick<Synced, "newSessionNeededFor">): void {
  if (r.newSessionNeededFor.length)
    console.log(`new Claude Code session needed for: ${r.newSessionNeededFor.join(", ")}`);
}

function printIssues(errors: Issue[], warnings: Issue[]): void {
  for (const e of errors) for (const l of formatIssue(e, mark("fail"))) console.log(l);
  for (const w of warnings) for (const l of formatIssue(w, mark("warn"))) console.log(l);
}

const refused = (errors: Issue[]) =>
  new CatherdError(
    "E_CONFIG_INVALID",
    `the profile was not saved: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
    { fix: errors.find((e) => e.fix)?.fix ?? "catherd profile validate lists what to change" },
  );

async function repoHere(): Promise<string> {
  const top = await gitToplevel(process.cwd());
  if (!top)
    throw new CatherdError("E_INPUT_INVALID", `${process.cwd()} is not inside a git repository`, {
      fix: "run it inside the repo to bind, or leave out --repo",
    });
  return top;
}

const list = defineCommand({
  meta: { name: "list", description: "Every profile, which is active, and the repos bound to each" },
  args: json,
  run({ args }) {
    const active = activeName();
    const bindings = Object.entries(readProjects().bindings);
    const rows = listProfiles().map((name) => ({
      name,
      active: name === active,
      repos: bindings.filter(([, p]) => p === name).map(([r]) => r),
    }));
    if (args.json) return printJson(rows);
    for (const r of rows)
      console.log(
        `${r.active ? "*" : " "} ${r.name}${r.repos.length ? `  bound to ${r.repos.join(", ")}` : ""}`,
      );
  },
});

const show = defineCommand({
  meta: {
    name: "show",
    description: "A profile with every default filled in (the active one without a name)",
  },
  args: { name: { type: "positional", required: false, description: "profile name" }, ...json },
  run({ args }) {
    const name = args.name ?? activeName();
    const p = getProfile(name);
    const o = {
      active: name === activeName(),
      enforcement: roleEnforcement(p),
      standIns: standIns(p, loadCatalog({ timings: false })),
    };
    if (args.json) return printJson({ profile: p, ...o });
    for (const l of formatProfile(p, { ...o, backends: runnableBackends() })) console.log(l);
  },
});

const use = defineCommand({
  meta: { name: "use", description: "Make a profile active, or bind it to this repo with --repo" },
  args: {
    name: { type: "positional", required: true, description: "profile name" },
    repo: { type: "boolean", description: "bind it to the git repo you are in, instead of making it active" },
  },
  async run({ args }) {
    const r = activate(args.name, args.repo ? await repoHere() : null);
    console.log(`${mark("ok")} ${r.active} ${r.repo ? `is bound to ${r.repo}` : "is active"}`);
    printSynced(r);
  },
});

const create = defineCommand({
  meta: { name: "new", description: "A new profile from the default one, or from --from <profile>" },
  args: {
    name: { type: "positional", required: true, description: "new profile name" },
    from: { type: "string", description: "copy this profile instead of the default one" },
  },
  run({ args }) {
    const r = createProfile(args.name, args.from);
    console.log(`${mark("ok")} created ${args.name}${args.from ? ` from ${args.from}` : ""}`);
    printIssues(r.errors, r.warnings);
  },
});

const copy = defineCommand({
  meta: { name: "copy", description: "Copy a profile under a new name" },
  args: {
    from: { type: "positional", required: true, description: "profile to copy" },
    to: { type: "positional", required: true, description: "new profile name" },
  },
  run({ args }) {
    const r = createProfile(args.to, args.from);
    console.log(`${mark("ok")} copied ${args.from} to ${args.to}`);
    printIssues(r.errors, r.warnings);
  },
});

const rm = defineCommand({
  meta: { name: "rm", description: "Delete a profile and its agent files (never the active or a bound one)" },
  args: { name: { type: "positional", required: true, description: "profile name" } },
  run({ args }) {
    deleteProfile(args.name);
    console.log(`${mark("ok")} deleted ${args.name}`);
  },
});

const set = defineCommand({
  meta: {
    name: "set",
    description:
      "Set one field: e.g. roles.worker.access read-only, budget.usd 20, failover.<rung> <rung>, roles.worker.rungs a,b; null removes",
  },
  args: {
    path: { type: "positional", required: true, description: "dotted path, e.g. roles.verifier.access" },
    value: { type: "positional", required: true, description: "JSON, or a plain word; null removes the key" },
    profile: { type: "string", description: "the profile to change (default: the active one)" },
  },
  run({ args }) {
    const r = patchProfile(args.profile, patchAt(args.path, args.value));
    if (!r.saved) throw refused(r.errors);
    if (r.diff.length === 0) console.log("no change");
    for (const c of r.diff) console.log(`${mark("ok")} ${formatChange(c)}`);
    printIssues([], r.warnings);
    printSynced(r);
  },
});

const diff = defineCommand({
  meta: {
    name: "diff",
    description: "What differs between two profiles (the second defaults to the active one)",
  },
  args: {
    a: { type: "positional", required: true, description: "profile" },
    b: { type: "positional", required: false, description: "profile (default: the active one)" },
    ...json,
  },
  run({ args }) {
    const changes = diffNamed(args.b ?? activeName(), args.a);
    if (args.json) return printJson(changes);
    if (changes.length === 0) console.log("no differences");
    for (const c of changes) console.log(formatChange(c));
  },
});

const validate = defineCommand({
  meta: { name: "validate", description: "Errors that block a save, and warnings that do not" },
  args: { name: { type: "positional", required: false, description: "profile name" }, ...json },
  run({ args }) {
    const v = validateNamed(args.name);
    if (args.json) printJson({ valid: v.errors.length === 0, ...v });
    else if (v.errors.length === 0 && v.warnings.length === 0) console.log(`${mark("ok")} valid`);
    else printIssues(v.errors, v.warnings);
    if (v.errors.length) process.exitCode = EXIT.error;
  },
});

/** Spec §8: `catherd profile list|show|use [--repo]|new|copy|rm|set <path> <value>|diff|validate`. */
export const profileCommand = defineCommand({
  meta: { name: "profile", description: "Profiles: which models each role runs, and how" },
  subCommands: { list, show, use, new: create, copy, rm, set, diff, validate },
});
```

In `src/cli.ts`, add to `main`'s `subCommands`, before `catalog`:

```ts
    profile: () => import("./entry/profile-command.ts").then((m) => m.profileCommand),
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run format && bun test test/entry/profile-command.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint && bun run format:check`
Expected: clean.

```bash
git add src/entry/profile-command.ts src/cli.ts test/entry/profile-command.test.ts test/fixtures/profiles/bad.json
git commit -m "feat(cli): catherd profile list, show, use --repo, new, copy, rm, set, diff and validate"
```

---

### Task 10: `catherd status`, `watch` and `runs`

Spec §8's `status [run] [--json]`, `watch [--once]` (Ruling 15) and `runs list|show [--debug]|cancel`, over plan 2's `status`, `summarizeRun`, `listRuns`, `readRecords` and `cancel`. `runs show --debug` is spec §10.2's view: per dispatch, the record, `exit.json`, and the tails of stderr, `events.jsonl` and `supervisor.log`, redacted by Task 7's redactor. The 0.x TUI's `watch` command goes.

**Files:**
- Create: `src/services/run-debug.ts`, `src/entry/runs-command.ts`
- Modify: `src/cli.ts`, `src/tui/commands.ts`
- Test: `test/entry/runs-command.test.ts`

**Interfaces:**
- Consumes: Task 5 (`defaultDeps`), Task 7 (`redact`), Task 8 (`mark`, `printJson`); plan 2's `status`, `summarizeRun`, `RunSummary` (`src/services/summary.ts`), `listRuns`, `findRun`, `readRecords`, `appendRecord`, `runPaths` (`src/services/run-store.ts`), `listDispatches` (`src/services/dispatches.ts`), `dispatchPaths`, `readExit` (`src/infra/dispatch-dir.ts`), `cancel` (`src/services/dispatch-service.ts`); `formatBudget` (`src/domain/budget.ts`); test helpers `fakeDispatch`, `freshRun`, `makeRecord`.
- Produces: `TAIL_LINES = 20`, `interface DispatchDebug`, `runDebug(run, name?): DispatchDebug[]`; `formatRun(s, now?): string[]`, `statusCommand`, `watchCommand`, `runsCommand`.

- [ ] **Step 1: Write the failing test**

`test/entry/runs-command.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatRun } from "../../src/entry/runs-command.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { appendRecord, runPaths } from "../../src/services/run-store.ts";
import type { RunSummary } from "../../src/services/summary.ts";
import { snapshotEnv } from "../helpers.ts";
import { SRC } from "../import-graph.ts";
import { fakeDispatch, freshRun, makeRecord } from "../services/helpers.ts";

afterEach(snapshotEnv());

function catherd(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), ...args], {
    env: { ...process.env, NO_COLOR: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: "20260925-1200-app",
  title: "app",
  repo: "/r/app",
  createdAt: "2026-09-25T12:00:00.000Z",
  stateTail: ["Next: dispatch M1.L2"],
  live: [
    { name: "worker-M1.L1", rung: "codex:gpt-6-sol#medium", state: "running", secs: 42, dispatchId: "01J" },
  ],
  totals: {
    runs: 3,
    ok: 2,
    notOk: ["reviewer-M1 (failed)"],
    tokens: { input: 120_000, cached: 90_000, output: 8_000 },
    costUsd: 0.5,
    wallMinutes: 30,
  },
  agents: { runs: 1, totalTokens: 50_000, costUsd: 0 },
  jev: { decisions: 3, fallbacks: 1 },
  budget: { fraction: 0.5, minutes: { spent: 30, cap: 60 } },
  milestones: ["M1 | the parser | abc123 | 12 | bun test"],
  warnings: ["runs.jsonl: skipped 1 unreadable row(s)"],
  ...over,
});

describe("formatRun", () => {
  it("shows what is live, what finished, the spend, the budget and the landings", () => {
    expect(formatRun(summary(), Date.parse("2026-09-25T12:30:00Z"))).toEqual([
      "run 20260925-1200-app  app",
      "  repo /r/app · started 2026-09-25T12:00:00.000Z · 30 min",
      "  live worker-M1.L1  codex:gpt-6-sol#medium  running 42s",
      "  done 3 role run(s), 2 ok; not ok: reviewer-M1 (failed)",
      "  tokens 120,000 in (90,000 cached) · 8,000 out · $0.50 · native agents 1 run(s), 50,000 tokens (reported)",
      "  budget 30/60 min (50%)",
      "  jev 3 decision(s), 1 fallback(s)",
      "  landed M1 | the parser | abc123 | 12 | bun test",
      "  | Next: dispatch M1.L2",
      "  ! runs.jsonl: skipped 1 unreadable row(s)",
    ]);
  });
});

describe("catherd status and watch --once", () => {
  it("prints the run with a live role, as text or JSON", async () => {
    const { run } = freshRun("parser");
    await fakeDispatch(run, {}, { proc: "self" });
    await appendRecord(run, makeRecord({ runId: run.id, name: "reviewer-M1", role: "reviewer", lane: null }));
    const text = catherd(["status"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain(`run ${run.id}  parser\n`);
    expect(text.out).toContain("  live worker-M1.L1  codex:gpt-6-sol#medium  running");
    expect(text.out).toContain("  done 1 role run(s), 1 ok\n");
    const j = JSON.parse(catherd(["watch", "--once", "--json"]).out);
    expect(j.runs.map((r: { id: string }) => r.id)).toEqual([run.id]);
    expect(catherd(["watch", "--once"]).out).toBe(text.out);
  });

  it("names an unknown run with exit 1", () => {
    freshRun();
    const r = catherd(["status", "nope"]);
    expect([r.code, r.err]).toEqual([
      1,
      'error E_RUN_NOT_FOUND: no run "nope"\nfix: status() lists the runs\n',
    ]);
  });

  it("keeps redrawing until Ctrl-C, then exits 130", async () => {
    freshRun();
    const p = Bun.spawn([process.execPath, join(SRC, "cli.ts"), "watch", "--interval", "1"], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = p.stdout.getReader();
    let seen = "";
    while (!seen.includes("updated")) seen += new TextDecoder().decode((await reader.read()).value);
    p.kill("SIGINT");
    expect(await p.exited).toBe(130);
  });
});

describe("catherd runs", () => {
  it("lists runs newest first, filters by repo, and warns about a run it cannot read", async () => {
    const { run } = freshRun("parser");
    await fakeDispatch(run, {}, { proc: "self" });
    mkdirSync(join(runPaths(run.dir).meta, "..", "..", "broken"), { recursive: true });
    const r = catherd(["runs", "list"]);
    expect(r.out).toContain(`${run.id}  1 live  0 role run(s)  parser  ${run.meta.repo}\n`);
    expect(r.out).toContain("! skipped run broken:");
    expect(JSON.parse(catherd(["runs", "list", "--repo", "/", "--json"]).out).runs).toEqual([]);
  });

  it("shows a run's records, and with --debug each dispatch's exit and tails, secrets redacted", async () => {
    const { run } = freshRun("parser");
    const d = await fakeDispatch(
      run,
      {},
      {
        exit: { code: 1, signal: null, reason: "exited", endedAt: "2026-09-25T12:01:00.000Z" },
        events: '{"type":"turn.failed"}\n',
      },
    );
    writeFileSync(dispatchPaths(d.dir).stderr, "boom\nauth failed for sk-live-0123456789abc\n");
    await appendRecord(run, makeRecord({ runId: run.id, dispatchId: d.admit.dispatchId, status: "failed" }));
    const r = catherd(["runs", "show", run.id, "--debug"], { OPENAI_API_KEY: "sk-live-0123456789abc" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("  worker-M1.L1  codex:gpt-6-sol#medium  failed/complete  60s  110 tokens\n");
    expect(r.out).toContain(`--- worker-M1.L1 ${d.admit.dispatchId} (codex:gpt-6-sol#medium`);
    expect(r.out).toContain(
      'exit.json: {"code":1,"signal":null,"reason":"exited","endedAt":"2026-09-25T12:01:00.000Z"}',
    );
    expect(r.out).toContain("stderr (last 2 lines):\n  boom\n  auth failed for [redacted]\n");
    expect(r.out).toContain('events (last 1 lines):\n  {"type":"turn.failed"}\n');
    expect(r.out).not.toContain("sk-live-0123456789abc");
  });

  it("refuses to cancel a role that is not live, with exit 1", () => {
    const { run } = freshRun();
    const r = catherd(["runs", "cancel", run.id, "worker-M1.L1"]);
    expect([r.code, r.err.split("\n")[0]]).toEqual([
      1,
      "error E_RUN_NOT_LIVE: worker-M1.L1 has no live dispatch",
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/entry/runs-command.test.ts`
Expected: FAIL — `Cannot find module '../../src/entry/runs-command.ts'`.

- [ ] **Step 3: Write the implementation**

`src/services/run-debug.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import type { ExitInfo, RunRecord } from "../domain/record.ts";
import { dispatchPaths, readExit } from "../infra/dispatch-dir.ts";
import { redact } from "../infra/log.ts";
import { listDispatches } from "./dispatches.ts";
import { readRecords, type Run } from "./run-store.ts";

/** How many trailing lines of stderr, events and the supervisor log `runs show --debug` prints. */
export const TAIL_LINES = 20;

export interface DispatchDebug {
  name: string;
  dispatchId: string;
  rung: string;
  admittedAt: string;
  record: RunRecord | null;
  exit: ExitInfo | null;
  stderrTail: string[];
  eventsTail: string[];
  supervisorTail: string[];
}

function tail(file: string, n = TAIL_LINES): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .slice(-n);
}

/**
 * Spec §10.2 `runs show <id> --debug`: per dispatch, oldest first, its record, exit.json and the tails of
 * stderr, events.jsonl and supervisor.log, with every known secret redacted. Reads only.
 */
export function runDebug(run: Run, name?: string): DispatchDebug[] {
  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
  return listDispatches(run)
    .filter((d) => name === undefined || d.admit.name === name)
    .sort((a, b) => a.admit.dispatchId.localeCompare(b.admit.dispatchId))
    .map((d) => {
      const p = dispatchPaths(d.dir);
      return redact({
        name: d.admit.name,
        dispatchId: d.admit.dispatchId,
        rung: d.admit.rung,
        admittedAt: d.admit.admittedAt,
        record: records.get(d.admit.dispatchId) ?? null,
        exit: readExit(d.dir),
        stderrTail: tail(p.stderr),
        eventsTail: tail(p.events),
        supervisorTail: tail(p.supervisorLog),
      });
    });
}
```

`src/entry/runs-command.ts`:

```ts
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { formatBudget } from "../domain/budget.ts";
import { gitToplevel } from "../infra/git.ts";
import { cancel } from "../services/dispatch-service.ts";
import { runDebug } from "../services/run-debug.ts";
import { findRun, listRuns, readRecords } from "../services/run-store.ts";
import { type RunSummary, status, summarizeRun } from "../services/summary.ts";
import { mark, printJson } from "./cli-kit.ts";
import { defaultDeps } from "./deps.ts";

const json = { json: { type: "boolean", description: "print JSON" } } as const;
const n = (x: number) => x.toLocaleString("en-US");

/** One run at a glance: what is live, what finished, spend against the budget, landed milestones. */
export function formatRun(s: RunSummary, now: number = Date.now()): string[] {
  const t = s.totals;
  const lines = [
    `run ${s.id}  ${s.title}`,
    `  repo ${s.repo} · started ${s.createdAt} · ${Math.round((now - Date.parse(s.createdAt)) / 60_000)} min`,
  ];
  for (const l of s.live) lines.push(`  live ${l.name}  ${l.rung}  ${l.state} ${l.secs}s`);
  lines.push(
    `  done ${t.runs} role run(s), ${t.ok} ok${t.notOk.length ? `; not ok: ${t.notOk.join(", ")}` : ""}`,
    `  tokens ${n(t.tokens.input)} in (${n(t.tokens.cached)} cached) · ${n(t.tokens.output)} out · $${t.costUsd.toFixed(2)}` +
      (s.agents.runs
        ? ` · native agents ${s.agents.runs} run(s), ${n(s.agents.totalTokens)} tokens (reported)`
        : ""),
  );
  if (s.budget) lines.push(`  budget ${formatBudget(s.budget)}`);
  if (s.jev.decisions) lines.push(`  jev ${s.jev.decisions} decision(s), ${s.jev.fallbacks} fallback(s)`);
  for (const m of s.milestones) lines.push(`  landed ${m}`);
  for (const l of s.stateTail) lines.push(`  | ${l}`);
  for (const w of s.warnings) lines.push(`  ${mark("warn")} ${w}`);
  return lines;
}

function printStatus(runId: string | undefined, asJson: boolean): void {
  const r = status(defaultDeps(), runId);
  if (asJson) return printJson(r);
  if (r.runs.length === 0) console.log("no runs yet");
  for (const s of r.runs) for (const l of formatRun(s)) console.log(l);
  for (const w of r.warnings) console.log(`${mark("warn")} ${w}`);
}

/** Spec §8 `catherd status [run] [--json]`: that run, else every run with a live role, else the newest. */
export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "A run at a glance (default: runs with a live role, else the newest)",
  },
  args: { run: { type: "positional", required: false, description: "run id" }, ...json },
  run({ args }) {
    printStatus(args.run, args.json === true);
  },
});

/** Spec §8 `catherd watch [--once]`. The live view here is plain text; plan 6's Runs tab replaces it. */
export const watchCommand = defineCommand({
  meta: {
    name: "watch",
    description: "Status of the live runs, redrawn until Ctrl-C (--once: print it once)",
  },
  args: {
    once: { type: "boolean", description: "print one snapshot and exit" },
    interval: { type: "string", description: "seconds between redraws (default 2)" },
    ...json,
  },
  async run({ args }) {
    if (args.once || args.json) return printStatus(undefined, args.json === true);
    const every = Math.max(1, Number(args.interval) || 2) * 1000;
    for (;;) {
      if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
      printStatus(undefined, false);
      console.log(`updated ${new Date().toLocaleTimeString()} · Ctrl-C to stop`);
      await Bun.sleep(every);
    }
  },
});

const list = defineCommand({
  meta: { name: "list", description: "Every run, newest first" },
  args: { repo: { type: "string", description: "only the runs of the git repo at this path" }, ...json },
  async run({ args }) {
    const top = args.repo ? await gitToplevel(resolve(args.repo)) : null;
    const { runs, corrupt } = listRuns();
    const rows = runs
      .filter((r) => !args.repo || r.meta.repo === top)
      .map((r) => {
        const s = summarizeRun(defaultDeps(), r);
        return {
          id: r.id,
          title: r.meta.title,
          repo: r.meta.repo,
          createdAt: r.meta.createdAt,
          live: s.live.length,
          roleRuns: s.totals.runs,
        };
      });
    if (args.json) return printJson({ runs: rows, corrupt });
    if (rows.length === 0) console.log("no runs yet");
    for (const r of rows)
      console.log(
        `${r.id}  ${r.live ? `${r.live} live` : "idle"}  ${r.roleRuns} role run(s)  ${r.title}  ${r.repo}`,
      );
    for (const c of corrupt) console.log(`${mark("warn")} skipped run ${c.id}: ${c.reason}`);
  },
});

const show = defineCommand({
  meta: {
    name: "show",
    description: "One run and its role runs; --debug adds exit.json and the stderr and event tails",
  },
  args: {
    id: { type: "positional", required: true, description: "run id" },
    debug: {
      type: "boolean",
      description: "per dispatch: the record, exit.json, and the stderr, event and supervisor tails",
    },
    name: { type: "string", description: "with --debug: only this role name" },
    ...json,
  },
  run({ args }) {
    const run = findRun(args.id);
    const summary = summarizeRun(defaultDeps(), run);
    const records = readRecords(run).records;
    const debug = args.debug ? runDebug(run, args.name) : undefined;
    if (args.json) return printJson({ summary, records, ...(debug ? { dispatches: debug } : {}) });
    for (const l of formatRun(summary)) console.log(l);
    for (const r of records)
      console.log(
        `  ${r.name}  ${r.rung}  ${r.status}${r.replyStatus ? `/${r.replyStatus}` : ""}  ${r.secs}s  ${n(r.tokens.input + r.tokens.output)} tokens`,
      );
    for (const d of debug ?? []) {
      console.log(`\n--- ${d.name} ${d.dispatchId} (${d.rung}, admitted ${d.admittedAt})`);
      console.log(`record: ${d.record ? JSON.stringify(d.record) : "none yet"}`);
      console.log(`exit.json: ${d.exit ? JSON.stringify(d.exit) : "none yet"}`);
      for (const [label, lines] of [
        ["stderr", d.stderrTail],
        ["events", d.eventsTail],
        ["supervisor.log", d.supervisorTail],
      ] as const) {
        console.log(`${label} (last ${lines.length} lines):`);
        for (const l of lines) console.log(`  ${l}`);
      }
    }
  },
});

const cancelCmd = defineCommand({
  meta: {
    name: "cancel",
    description: "Stop a live role (interrupt, SIGTERM, SIGKILL) and record it cancelled",
  },
  args: {
    id: { type: "positional", required: true, description: "run id" },
    name: { type: "positional", required: true, description: "the role's name, as status lists it" },
  },
  async run({ args }) {
    const r = await cancel(defaultDeps(), args.id, args.name);
    console.log(`${mark("ok")} ${r.record.name} ${r.record.status}`);
    for (const h of r.hints) console.log(`  ${h}`);
  },
});

/** Spec §8 `catherd runs list|show [--debug]|cancel`. */
export const runsCommand = defineCommand({
  meta: { name: "runs", description: "Runs: list them, show one, cancel a live role" },
  subCommands: { list, show, cancel: cancelCmd },
});
```

In `src/cli.ts`, replace the `watch` subcommand line (the 0.x TUI) with three:

```ts
    status: () => import("./entry/runs-command.ts").then((m) => m.statusCommand),
    watch: () => import("./entry/runs-command.ts").then((m) => m.watchCommand),
    runs: () => import("./entry/runs-command.ts").then((m) => m.runsCommand),
```

In `src/tui/commands.ts`, delete the `watchCommand` export and the now unused `import { Watch } from "./watch.tsx";` (the dashboard still opens the 0.x watch screen itself).

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run format && bun test test/entry/runs-command.test.ts test/tui/commands.test.ts`
Expected: PASS (7 tests in the new file).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint && bun run format:check`
Expected: clean.

```bash
git add src/services/run-debug.ts src/entry/runs-command.ts src/cli.ts src/tui/commands.ts test/entry/runs-command.test.ts
git commit -m "feat(cli): catherd status, watch and runs list, show --debug and cancel"
```

---

### Task 11: `catherd lock`: signals to the whole group, and a fallback that says so

Plan-2 review m10. The command runs in its own process group (`detached`, so a terminal's Ctrl-C reaches catherd only) and catherd forwards SIGINT, SIGTERM and SIGHUP to the whole group once; a second Ctrl-C within 2 s kills the group. The slot count reads the profile of the repo `lock` runs in, and falling back to half the cores prints why. The command gets its env explicitly, so `--verbose` reaches it.

**Files:**
- Modify: `src/entry/lock.ts` (replace)
- Test: `test/entry/lock.test.ts` (replace)

**Interfaces:**
- Consumes: Task 4 (`profileFor`), Task 8 (`printError`); `gitToplevel`; `heavySlots`, `withHeavySlot`; `killGroup` (`src/infra/proc.ts`).
- Produces: `resolveSlots(flag, profile, warn?)`, `DOUBLE_INTERRUPT_MS = 2_000`, `runForwarding(argv): Promise<number>`, `lockCommand`.

- [ ] **Step 1: Write the failing test**

`test/entry/lock.test.ts` (replace the file; the first two tests are the existing ones):

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSlots } from "../../src/entry/lock.ts";
import { heavySlots } from "../../src/infra/heavy-lock.ts";
import { isAlive } from "../../src/infra/proc.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { waitFor } from "../services/helpers.ts";

afterEach(snapshotEnv());

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

describe("catherd lock", () => {
  it("takes --slots, then CATHERD_LOCK_SLOTS, then the profile, then half the cores", () => {
    delete process.env.CATHERD_LOCK_SLOTS;
    expect(resolveSlots("3", () => 1)).toBe(3);
    process.env.CATHERD_LOCK_SLOTS = "2";
    expect(resolveSlots(undefined, () => 1)).toBe(2);
    delete process.env.CATHERD_LOCK_SLOTS;
    expect(resolveSlots(undefined, () => 4)).toBe(4);
    expect(
      resolveSlots(undefined, () => {
        throw new Error("no profile");
      }),
    ).toBe(heavySlots("cpus/2"));
    expect(() => resolveSlots("zero", () => 1)).toThrow(/slots/);
  });

  it("runs the command behind a slot and passes its exit code through", () => {
    const home = withHome();
    const p = Bun.spawnSync([process.execPath, CLI, "lock", "--slots", "1", "--", "sh", "-c", "exit 7"], {
      env: { ...process.env, CATHERD_HOME: home },
    });
    expect(p.exitCode).toBe(7);
  });

  it("warns when it falls back to half the cores because the profile cannot be read", () => {
    const warned: string[] = [];
    const slots = resolveSlots(
      undefined,
      () => {
        throw new Error("config.json is from catherd 0.x");
      },
      (m) => warned.push(m),
    );
    expect(warned).toEqual([
      `catherd lock: no profile to read lock.heavy from (config.json is from catherd 0.x); using ${slots} slots`,
    ]);
  });

  it("refuses a bad --slots as a usage error", () => {
    withHome();
    const p = Bun.spawnSync([process.execPath, CLI, "lock", "--slots", "zero", "--", "true"], {
      stderr: "pipe",
    });
    expect([p.exitCode, p.stderr.toString().split("\n")[0]]).toEqual([
      2,
      'error E_INPUT_INVALID: slots must be a number ≥ 1 or cpus/2, not "zero"',
    ]);
  });

  it("passes catherd's --verbose to the command as CATHERD_LOG", () => {
    withHome();
    const p = Bun.spawnSync(
      [process.execPath, CLI, "--verbose", "lock", "--slots", "1", "--", "sh", "-c", "echo $CATHERD_LOG"],
      { env: process.env, stdout: "pipe" },
    );
    expect(p.stdout.toString()).toBe("debug\n");
  });
});

describe("catherd lock signals (plan-2 review m10)", () => {
  /** Starts `catherd lock -- sh -c <script>` and waits for the script to write its background child's pid. */
  async function locked(script: string) {
    const home = withHome();
    const pidFile = join(mkdtempSync(join(tmpdir(), "catherd-lockpid-")), "pid");
    const p = Bun.spawn(
      [process.execPath, CLI, "lock", "--slots", "1", "--", "sh", "-c", script.replace("PIDFILE", pidFile)],
      {
        env: { ...process.env, CATHERD_HOME: home },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim());
    return { p, grandchild: Number(readFileSync(pidFile, "utf8")) };
  }

  for (const sig of ["SIGTERM", "SIGHUP"] as const)
    it(`forwards ${sig} to the command's whole process group`, async () => {
      const { p, grandchild } = await locked("sleep 30 & echo $! > PIDFILE; wait");
      p.kill(sig);
      expect(await p.exited).toBe(128 + (sig === "SIGTERM" ? 15 : 1));
      await waitFor(() => !isAlive(grandchild, null));
    });

  it("kills a command that ignores Ctrl-C on the second Ctrl-C", async () => {
    const { p } = await locked("trap '' INT; echo $$ > PIDFILE; while :; do sleep 0.1; done");
    p.kill("SIGINT");
    await Bun.sleep(200);
    p.kill("SIGINT");
    expect(await p.exited).toBe(137);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/entry/lock.test.ts`
Expected: FAIL — the fallback test hears no warning, the `--verbose` test's command sees no `CATHERD_LOG` (the old command spawned without `env`), and the SIGTERM test times out waiting for the background `sleep`, which the old command never signalled.

- [ ] **Step 3: Write the implementation**

`src/entry/lock.ts` (replace the file):

```ts
import { defineCommand } from "citty";
import { CatherdError } from "../domain/errors.ts";
import { gitToplevel } from "../infra/git.ts";
import { heavySlots, withHeavySlot } from "../infra/heavy-lock.ts";
import { killGroup } from "../infra/proc.ts";
import { profileFor } from "../services/profile-service.ts";
import { printError } from "./cli-kit.ts";

/**
 * --slots, then CATHERD_LOCK_SLOTS, then the profile's lock.heavy, then half the cores. `warn` hears why
 * the profile could not say, so the fallback is never silent (plan-2 review m10).
 */
export function resolveSlots(
  flag: string | undefined,
  profile: () => number | "cpus/2",
  warn: (message: string) => void = () => {},
): number {
  const raw = flag ?? process.env.CATHERD_LOCK_SLOTS;
  if (raw) {
    if (raw === "cpus/2") return heavySlots("cpus/2");
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1)
      throw new CatherdError("E_INPUT_INVALID", `slots must be a number ≥ 1 or cpus/2, not "${raw}"`, {
        fix: "catherd lock --slots 2 -- <command>",
      });
    return heavySlots(n);
  }
  try {
    return heavySlots(profile());
  } catch (e) {
    const slots = heavySlots("cpus/2");
    warn(`catherd lock: no profile to read lock.heavy from (${(e as Error).message}); using ${slots} slots`);
    return slots;
  }
}

/** How long a second Ctrl-C has to follow the first to kill the command outright. */
export const DOUBLE_INTERRUPT_MS = 2_000;

/**
 * Runs `argv` in its own process group and forwards SIGINT, SIGTERM and SIGHUP to the whole group once:
 * a terminal's Ctrl-C reaches catherd only, so the command sees it exactly once, and so does every
 * process it started. A second Ctrl-C within 2 s kills the group. Resolves to the command's exit code.
 */
export async function runForwarding(argv: string[]): Promise<number> {
  const child = Bun.spawn(argv, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
    detached: true,
  });
  let lastInt = 0;
  const handlers: [NodeJS.Signals, () => void][] = [
    [
      "SIGINT",
      () => {
        const now = Date.now();
        killGroup(child.pid, now - lastInt < DOUBLE_INTERRUPT_MS ? "SIGKILL" : "SIGINT");
        lastInt = now;
      },
    ],
    ["SIGTERM", () => killGroup(child.pid, "SIGTERM")],
    ["SIGHUP", () => killGroup(child.pid, "SIGHUP")],
  ];
  for (const [sig, h] of handlers) process.on(sig, h);
  try {
    return await child.exited;
  } finally {
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}

export const lockCommand = defineCommand({
  meta: { name: "lock", description: "Run a heavy command behind the machine-wide semaphore" },
  args: {
    slots: {
      type: "string",
      description: "Slots (default: CATHERD_LOCK_SLOTS, else the profile's lock.heavy, else half the cores)",
    },
  },
  async run({ args, rawArgs }) {
    const sep = rawArgs.indexOf("--");
    const argv = sep < 0 ? [] : rawArgs.slice(sep + 1);
    if (argv.length === 0) {
      printError(
        new CatherdError("E_INPUT_INVALID", "no command to run", {
          fix: "catherd lock [--slots N] -- <command> [args...]",
        }),
      );
      process.exitCode = 2;
      return;
    }
    const repo = await gitToplevel(process.cwd());
    const slots = resolveSlots(
      args.slots,
      () => profileFor(repo).lock.heavy,
      (m) => console.error(m),
    );
    process.exitCode = await withHeavySlot(slots, () => runForwarding(argv));
  },
});
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run format && bun test test/entry/lock.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint && bun run format:check`
Expected: clean.

```bash
git add src/entry/lock.ts test/entry/lock.test.ts
git commit -m "fix(cli): catherd lock signals the command's whole group once, kills it on a second Ctrl-C, and says when it guesses slots"
```

---

### Task 12: `catherd doctor`

Spec §10.3's readiness report, as a service with its probes injected, and a command that prints one row per check (`✓ ready  Bun — 1.4.2`, the fix on its own line) or JSON and exits 3 when not ready (Ruling 12). The MCP check really starts `catherd mcp` over stdio and asks for `tools/list`. The Codex sandbox check is the adapter's new `canWrite` hook; the simulator learns `codex sandbox`.

**Files:**
- Create: `src/services/doctor.ts`, `src/entry/mcp/handshake.ts`, `src/entry/doctor-command.ts`
- Modify: `src/adapters/backend.ts`, `src/adapters/codex/index.ts`, `src/cli.ts`, `test/sim/codex`, `test/sim/scenario.ts`
- Test: `test/services/doctor.test.ts`, `test/entry/doctor-command.test.ts`

**Interfaces:**
- Consumes: Task 4 (`activeName`, `agentLinkState`, `enforcementOf`, `getProfile`, `linkedProfiles`, `readConfig`, `readProjects`, `validateNamed`, `patchProfile`, `configFile`), Task 8 (`EXIT`, `mark`, `printJson`), `bunTooOld`/`MIN_BUN` (Task 8); plan 4's `refreshDiscovery`, `jevKey`, `testJevKey`, `credentialsPath`, `saveJevKey`; `ADAPTER_IDS`, `Probe`, `adapterFor`; `claudeHome`, `locksDir`; `listRuns`; `VERSION`.
- Produces: `BackendAdapter.canWrite?(dir): Promise<{ ok: boolean; fix?: string } | null>`, `BackendAdapter.isolationNote?: string`; `type CheckState = "ok" | "warn" | "fail" | "skip"`, `interface Check { id; label; state; word; detail; fix? }`, `interface DoctorReport { ready; version; checks }`, `interface Handshake { ok; tools; error? }`, `interface DoctorDeps { bunVersion; version; handshake; jev? }`, `PLUGIN_INSTALL`, `PLUGIN_UPDATE`, `doctor(d): Promise<DoctorReport>`; `mcpHandshake(timeoutMs?): Promise<Handshake>`; `formatCheck(c, plain?)`, `formatReport(r, plain?)`, `doctorCommand`.

- [ ] **Step 1: Write the failing tests**

`test/services/doctor.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { locksDir } from "../../src/infra/paths.ts";
import { VERSION } from "../../src/infra/version.ts";
import {
  type Check,
  type DoctorReport,
  doctor,
  type Handshake,
  PLUGIN_INSTALL,
} from "../../src/services/doctor.ts";
import { credentialsPath, saveJevKey } from "../../src/services/jev-service.ts";
import { configFile, patchProfile } from "../../src/services/profile-service.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { type CodexScenario, withScenario } from "../sim/scenario.ts";
import { type OpencodeScenario, withClaudeScenario, withOpencodeScenario } from "../sim/sim-scenarios.ts";

afterEach(snapshotEnv());

const FX = join(import.meta.dir, "..", "fixtures", "adapters");
const SIM = join(import.meta.dir, "..", "sim");
const fx = (p: string) => JSON.parse(readFileSync(join(FX, p), "utf8"));

/** A machine with the simulated CLIs `bins` on PATH (all three by default), the codex sandbox allowing writes. */
function machine(o: { codex?: CodexScenario; opencode?: OpencodeScenario; bins?: string[] } = {}): string {
  const home = withHome();
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  delete process.env.TYPESAFE_API_KEY;
  const bin = mkdtempSync(join(tmpdir(), "catherd-bin-"));
  for (const b of o.bins ?? ["codex", "claude", "opencode"]) symlinkSync(join(SIM, b), join(bin, b));
  process.env.PATH = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  Object.assign(
    process.env,
    withScenario({ models: fx("codex/models.json"), sandbox: "allow", ...o.codex }).env,
    withClaudeScenario({}).env,
    withOpencodeScenario({ models: fx("opencode/models.json").data, ...o.opencode }).env,
  );
  return home;
}

function installPlugin(version: string): void {
  const dir = join(process.env.CLAUDE_CONFIG_DIR as string, "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "catherd@catherd": [{ scope: "user", version }] } }),
  );
}

const answers = async (): Promise<Handshake> => ({ ok: true, tools: ["status", "dispatch"] });
const run = (over: Partial<Parameters<typeof doctor>[0]> = {}) =>
  doctor({ bunVersion: "1.4.2", version: VERSION, handshake: answers, ...over });
const check = (r: DoctorReport, id: string): Check | undefined => r.checks.find((c) => c.id === id);
const states = (r: DoctorReport) => Object.fromEntries(r.checks.map((c) => [c.id, `${c.state} ${c.word}`]));

/** A machine where everything the default profile needs works, and the agents are linked. */
function ready(): string {
  const home = machine();
  installPlugin(VERSION);
  patchProfile("default", {});
  return home;
}

describe("doctor", () => {
  it("is ready when everything the active profile needs works, warning only on what is optional", async () => {
    ready();
    const r = await run();
    expect(r.ready).toBe(true);
    expect(states(r)).toEqual({
      bun: "ok ready",
      config: "ok ready",
      profile: "ok ready",
      "backend:codex": "ok ready",
      "backend:claude-code": "ok ready",
      "backend:opencode": "ok ready",
      jev: "warn no key",
      plugin: "ok ready",
      agents: "ok ready",
      mcp: "ok ready",
      locks: "ok ready",
      "sandbox:codex": "ok ready",
      "access:full": "warn warning",
      "access:advisory": "warn warning",
    });
    expect(check(r, "backend:codex")?.detail).toMatch(/^0\.157\.0 · \d+ models$/);
    expect(check(r, "agents")?.detail).toBe("2 linked");
    expect(check(r, "access:full")?.detail).toBe("no sandbox for: verifier (default), ui-reviewer (default)");
  });

  it("fails on a backend a role runs on, but only warns on one a failover stand-in alone uses", async () => {
    ready();
    process.env.PATH = process.env.PATH?.replace(/^[^:]+/, (bin) => {
      const only = mkdtempSync(join(tmpdir(), "catherd-bin-"));
      symlinkSync(join(bin, "claude"), join(only, "claude"));
      return only;
    });
    const r = await run();
    expect(r.ready).toBe(false);
    expect(check(r, "backend:codex")).toMatchObject({
      state: "fail",
      word: "missing",
      fix: "npm i -g @openai/codex",
    });
    expect(check(r, "backend:opencode")).toMatchObject({
      state: "warn",
      word: "missing",
      detail: "opencode is not on PATH (a failover stand-in uses it)",
    });
  });

  it("names the login a backend needs", async () => {
    machine({ codex: { loggedIn: false } });
    installPlugin(VERSION);
    patchProfile("default", {});
    expect(check(await run(), "backend:codex")).toMatchObject({
      state: "fail",
      word: "not logged in",
      fix: "codex login",
    });
  });

  it("fails without the plugin, or with a plugin of another version", async () => {
    machine();
    patchProfile("default", {});
    expect(check(await run(), "plugin")).toMatchObject({
      state: "fail",
      word: "missing",
      fix: PLUGIN_INSTALL,
    });
    installPlugin("0.9.0");
    expect(check(await run(), "plugin")).toMatchObject({
      state: "fail",
      word: "stale",
      detail: `plugin 0.9.0, catherd ${VERSION}`,
    });
  });

  it("fails on missing agent links, with the command that relinks them", async () => {
    machine();
    installPlugin(VERSION);
    expect(check(await run(), "agents")).toMatchObject({
      state: "fail",
      word: "missing",
      fix: "catherd profile use default",
    });
  });

  it("fails when the MCP server does not answer tools/list", async () => {
    ready();
    const r = await run({
      handshake: async () => ({ ok: false, tools: [], error: "no answer within 20 s" }),
    });
    expect([r.ready, check(r, "mcp")?.detail]).toEqual([false, "no answer within 20 s"]);
  });

  it("warns, with the fix, when a Codex workspace-write sandbox cannot write the lock dir; skips when it cannot test", async () => {
    machine({ codex: { sandbox: "deny" } });
    installPlugin(VERSION);
    patchProfile("default", {});
    const denied = check(await run(), "sandbox:codex");
    expect(denied).toMatchObject({ state: "warn", word: "not writable" });
    expect(denied?.fix).toBe(
      `add "${locksDir()}" to writable_roots under [sandbox_workspace_write] in ~/.codex/config.toml`,
    );
    machine({ codex: { sandbox: undefined } });
    installPlugin(VERSION);
    patchProfile("default", {});
    expect(check(await run(), "sandbox:codex")).toMatchObject({ state: "skip", word: "not tested" });
  });

  it("tests a Jev key, and skips Jev when the profile turns it off", async () => {
    ready();
    saveJevKey("tsk-test-key-0123456789");
    const good = fakeFetch({ status: 200, body: { data: [] } });
    expect(check(await run({ jev: { fetchImpl: good.impl } }), "jev")).toMatchObject({
      state: "ok",
      word: "ready",
    });
    const bad = fakeFetch({ status: 401, body: { error: "bad key" } });
    expect(check(await run({ jev: { fetchImpl: bad.impl } }), "jev")).toMatchObject({
      state: "warn",
      word: "no answer",
    });
    patchProfile("default", { jev: { use: "off" } });
    expect(check(await run(), "jev")).toMatchObject({ state: "skip", word: "off" });
  });

  it("fails on a credentials file others can read", async () => {
    ready();
    saveJevKey("tsk-test-key-0123456789");
    chmodSync(credentialsPath(), 0o644);
    expect(check(await run(), "credentials")).toMatchObject({
      state: "fail",
      word: "readable by others",
      fix: `chmod 600 ${credentialsPath()}`,
    });
  });

  it("fails on an old Bun, an invalid profile, and a 0.x config", async () => {
    ready();
    expect(check(await run({ bunVersion: "1.3.11" }), "bun")).toMatchObject({
      state: "fail",
      word: "too old",
      fix: "bun upgrade",
    });
    const doc = JSON.parse(readFileSync(join(dirname(configFile()), "profiles", "default.json"), "utf8"));
    writeFileSync(
      join(dirname(configFile()), "profiles", "default.json"),
      JSON.stringify({ ...doc, roles: { ...doc.roles, worker: { ...doc.roles.worker, enabled: false } } }),
    );
    expect(check(await run(), "profile")).toMatchObject({ state: "fail", word: "invalid" });
    writeFileSync(configFile(), JSON.stringify({ activeProfile: "default" }));
    expect(check(await run(), "config")).toMatchObject({
      state: "fail",
      fix: "run catherd init, which moves 0.x files aside and writes 1.0 ones",
    });
  });
});
```

`test/entry/doctor-command.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatCheck } from "../../src/entry/doctor-command.ts";
import { VERSION } from "../../src/infra/version.ts";
import { patchProfile } from "../../src/services/profile-service.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { SRC } from "../import-graph.ts";
import { withScenario } from "../sim/scenario.ts";
import { withClaudeScenario, withOpencodeScenario } from "../sim/sim-scenarios.ts";

afterEach(snapshotEnv());

const FX = join(import.meta.dir, "..", "fixtures", "adapters");
const fx = (p: string) => JSON.parse(readFileSync(join(FX, p), "utf8"));

function machine(): void {
  const home = withHome();
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  delete process.env.TYPESAFE_API_KEY;
  process.env.PATH = `${join(import.meta.dir, "..", "sim")}:${dirname(process.execPath)}:/usr/bin:/bin`;
  Object.assign(
    process.env,
    withScenario({ models: fx("codex/models.json"), sandbox: "allow" }).env,
    withClaudeScenario({}).env,
    withOpencodeScenario({ models: fx("opencode/models.json").data }).env,
  );
}

function doctor(...args: string[]) {
  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), "doctor", ...args], {
    // Bun hands a child its own start-up env unless told otherwise; the test's CATHERD_HOME must reach it
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString() };
}

describe("formatCheck", () => {
  it("prints the glyph, the word, the check and its detail, and the full fix on its own line", () => {
    expect(
      formatCheck({
        id: "backend:codex",
        label: "codex",
        state: "fail",
        word: "not logged in",
        detail: "codex is not logged in",
        fix: "codex login",
      }),
    ).toEqual(["✗ not logged in      codex — codex is not logged in", "    fix: codex login"]);
    expect(
      formatCheck({ id: "bun", label: "Bun", state: "ok", word: "ready", detail: "1.4.2" }, true),
    ).toEqual(["+ ready              Bun — 1.4.2"]);
  });
});

describe("catherd doctor", () => {
  it("exits 3 when not ready, and its JSON shows the real MCP server answering over stdio", () => {
    machine();
    const r = doctor("--json");
    expect(r.code).toBe(3);
    const j = JSON.parse(r.out);
    expect(j.ready).toBe(false);
    expect(j.checks.find((c: { id: string }) => c.id === "plugin")).toMatchObject({
      state: "fail",
      word: "missing",
    });
    expect(j.checks.find((c: { id: string }) => c.id === "mcp")).toMatchObject({
      state: "ok",
      detail: "answers tools/list with 20 tools",
    });
  }, 60_000);

  it("exits 0 and says ready once the plugin is installed and the agents are linked", () => {
    machine();
    const plugins = join(process.env.CLAUDE_CONFIG_DIR as string, "plugins");
    mkdirSync(plugins, { recursive: true });
    writeFileSync(
      join(plugins, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "catherd@catherd": [{ version: VERSION }] } }),
    );
    patchProfile("default", {});
    const r = doctor("--plain");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n").at(-1)).toBe("+ ready");
    expect(r.out).toContain(
      "! no key             Jev — optional: routing uses each lane's Kind and Difficulty instead\n",
    );
  }, 60_000);
});
```

The Codex simulator learns `codex sandbox`. In `test/sim/codex`, before the `if (args[0] !== "exec") {` line, add:

```ts
// `codex sandbox <os> --full-auto -- <cmd…>`: "allow" runs the command, "deny" lets only `true` through
// (as a workspace-write sandbox refuses a write outside the cwd); unset, the subcommand is unknown.
if (args[0] === "sandbox" && s.sandbox) {
  const cmd = args.slice(args.indexOf("--") + 1);
  if (s.sandbox === "deny" && cmd.join(" ") !== "sh -c true") {
    process.stderr.write("sh: 1: cannot create: Permission denied\n");
    process.exit(1);
  }
  const r = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  process.exit(r.exitCode ?? 1);
}
```

and in `CodexScenario` (`test/sim/scenario.ts`), before `byRung`, add:

```ts
  /** `codex sandbox`: "allow" runs the command, "deny" refuses any write; unset, codex has no such command */
  sandbox?: "allow" | "deny";
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/services/doctor.test.ts test/entry/doctor-command.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/doctor.ts'`.

- [ ] **Step 3: Write the implementation**

In `src/adapters/backend.ts`, after the `failoverFor?(rung: Rung, repo?: string): Rung | null;` member of `BackendAdapter`, add:

```ts
  /**
   * Spec §10.3: whether a workspace-write worker of this backend can write `dir` (the heavy-lock dir, so
   * `catherd lock` works inside it); null when it cannot be tested on this machine.
   */
  canWrite?(dir: string): Promise<{ ok: boolean; fix?: string } | null>;
  /** Spec §10.3: why this backend's isolation is weak; doctor warns when a profile uses it. */
  isolationNote?: string;
```

In `src/adapters/codex/index.ts`: add the imports

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

give `sh` a working directory — replace `async function sh(args: string[]): Promise<{ ok: boolean; out: string; err: string } | null> {` with `async function sh(args: string[], cwd?: string): Promise<{ ok: boolean; out: string; err: string } | null> {` and add `cwd,` as the first option of its `Bun.spawn(["codex", ...args], {`; before `export const codexAdapter` add

```ts
/**
 * Spec §10.3: runs a write into `dir` under `codex sandbox <os> --full-auto`, the workspace-write sandbox,
 * from a scratch folder. null when this machine has no Codex sandbox to test with (the control fails).
 */
async function canWrite(dir: string): Promise<{ ok: boolean; fix?: string } | null> {
  const os = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : null;
  if (!os) return null;
  const cwd = mkdtempSync(join(tmpdir(), "catherd-sandbox-"));
  try {
    const run = (script: string) => sh(["sandbox", os, "--full-auto", "--", "sh", "-c", script], cwd);
    if (!(await run("true"))?.ok) return null;
    const probe = join(dir, `.doctor-${process.pid}`);
    const r = await run(`touch '${probe}' && rm -f '${probe}'`);
    if (!r) return null;
    return r.ok
      ? { ok: true }
      : {
          ok: false,
          fix: `add "${dir}" to writable_roots under [sandbox_workspace_write] in ~/.codex/config.toml`,
        };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
```

and add `canWrite,` as the last member of `codexAdapter`.

`src/services/doctor.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTER_IDS, type Probe } from "../adapters/backend.ts";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import { isCatherdError } from "../domain/errors.ts";
import { parseRung } from "../domain/ids.ts";
import type { Profile } from "../domain/profile.ts";
import { ROLES } from "../domain/roles.ts";
import { bunTooOld, MIN_BUN } from "../domain/runtime.ts";
import type { JevTransport } from "../infra/jev-client.ts";
import { claudeHome, locksDir } from "../infra/paths.ts";
import { refreshDiscovery } from "./catalog-service.ts";
import { credentialsPath, jevKey, testJevKey } from "./jev-service.ts";
import {
  activeName,
  agentLinkState,
  enforcementOf,
  getProfile,
  linkedProfiles,
  readConfig,
  readProjects,
  validateNamed,
} from "./profile-service.ts";
import { listRuns } from "./run-store.ts";

export type CheckState = "ok" | "warn" | "fail" | "skip";

/** One row of `catherd doctor` (spec §10.3): its state, one word, the detail and the full fix. */
export interface Check {
  id: string;
  label: string;
  state: CheckState;
  word: string;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  /** false when any check failed: `catherd doctor` exits 3 */
  ready: boolean;
  version: string;
  checks: Check[];
}

export interface Handshake {
  ok: boolean;
  tools: string[];
  error?: string;
}

export interface DoctorDeps {
  bunVersion: string;
  /** the package version, which the Claude Code plugin must pin */
  version: string;
  /** starts `catherd mcp` over stdio and asks it for tools/list */
  handshake: () => Promise<Handshake>;
  jev?: JevTransport;
}

export const PLUGIN_INSTALL =
  "claude plugin marketplace add 47vigen/catherd && claude plugin install catherd@catherd";
export const PLUGIN_UPDATE =
  "claude plugin marketplace update catherd && claude plugin update catherd@catherd";

const errText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e)) as string;
const fixOf = (e: unknown) => (isCatherdError(e) ? e.fix : undefined);

/** Every backend a linked profile runs a role on ("role"), or only fails over to ("failover"). */
function usedBackends(profiles: Profile[]): Map<string, "role" | "failover"> {
  const used = new Map<string, "role" | "failover">();
  const note = (rung: string, how: "role" | "failover") => {
    try {
      const b = parseRung(rung).backend;
      if (used.get(b) !== "role") used.set(b, how);
    } catch {
      // validate reports a bad rung
    }
  };
  for (const p of profiles) {
    for (const role of ROLES) if (p.roles[role].enabled) for (const r of p.roles[role].rungs) note(r, "role");
    for (const to of Object.values(p.failover)) note(to, "failover");
  }
  return used;
}

const PROBLEM_WORD: Record<string, string> = {
  E_BACKEND_MISSING: "missing",
  E_BACKEND_TOO_OLD: "too old",
  E_BACKEND_NOT_LOGGED_IN: "not logged in",
};

async function backendChecks(used: Map<string, "role" | "failover">): Promise<Check[]> {
  const checks: Check[] = [];
  const ready: string[] = [];
  for (const id of ADAPTER_IDS) {
    const a = adapterFor(id);
    if (!a) continue;
    const probe: Probe = await a.probe().catch((e: unknown) => ({
      installed: false,
      version: null,
      versionOk: false,
      loggedIn: null,
      problems: [
        { code: "E_IO_UNEXPECTED" as const, message: errText(e), fix: `run ${id} --version to see why` },
      ],
    }));
    const problem = probe.problems[0];
    const use = used.get(id);
    if (!problem) {
      ready.push(id);
      checks.push({
        id: `backend:${id}`,
        label: id,
        state: "ok",
        word: "ready",
        detail: probe.version ?? "",
      });
      continue;
    }
    checks.push({
      id: `backend:${id}`,
      label: id,
      state: use === "role" ? "fail" : use === "failover" ? "warn" : "skip",
      word: PROBLEM_WORD[problem.code] ?? "not ready",
      detail: `${problem.message}${use === "failover" ? " (a failover stand-in uses it)" : use ? "" : " (no profile uses it)"}`,
      fix: problem.fix,
    });
  }
  // spec §5.2: doctor refreshes discovery; a listing that fails keeps the last one
  for (const r of await refreshDiscovery({ backends: ready })) {
    const c = checks.find((x) => x.id === `backend:${r.backend}`);
    if (!c) continue;
    if (r.error)
      Object.assign(c, {
        state: "warn",
        word: "no listing",
        detail: `${c.detail} · ${r.error}`,
        fix: "catherd catalog refresh",
      });
    else c.detail = `${c.detail} · ${r.models} models`;
  }
  return checks;
}

function pluginCheck(version: string): Check {
  const base = { id: "plugin", label: "Claude Code plugin" };
  const file = join(claudeHome(), "plugins", "installed_plugins.json");
  let installed: string | null = null;
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { plugins?: Record<string, { version?: string }[]> };
    const entry = Object.entries(j.plugins ?? {}).find(([k]) => k.startsWith("catherd@"))?.[1]?.[0];
    installed = entry ? (entry.version ?? "unknown") : null;
  } catch {
    installed = null;
  }
  if (installed === null)
    return {
      ...base,
      state: "fail",
      word: "missing",
      detail: "not installed in Claude Code",
      fix: PLUGIN_INSTALL,
    };
  if (installed !== version)
    return {
      ...base,
      state: "fail",
      word: "stale",
      detail: `plugin ${installed}, catherd ${version}`,
      fix: PLUGIN_UPDATE,
    };
  return { ...base, state: "ok", word: "ready", detail: installed };
}

function locksCheck(): Check {
  const base = { id: "locks", label: "heavy-lock dir" };
  try {
    mkdirSync(locksDir(), { recursive: true });
    const probe = join(locksDir(), `.doctor-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return { ...base, state: "ok", word: "ready", detail: locksDir() };
  } catch (e) {
    return {
      ...base,
      state: "fail",
      word: "not writable",
      detail: `${locksDir()}: ${errText(e)}`,
      fix: `chmod -R u+w ${locksDir()}`,
    };
  }
}

function agentsCheck(): Check {
  const base = { id: "agents", label: "Claude agents" };
  const links = agentLinkState();
  const broken = [...links.missing, ...links.stale];
  if (broken.length)
    return {
      ...base,
      state: "fail",
      word: links.missing.length ? "missing" : "stale",
      detail: broken.join(", "),
      fix: `catherd profile use ${activeName()}`,
    };
  return links.ok.length
    ? { ...base, state: "ok", word: "ready", detail: `${links.ok.length} linked` }
    : { ...base, state: "skip", word: "none", detail: "no profile uses a native Claude rung" };
}

/** Spec §10.3: the readiness report. Reads and probes; its only writes are discovery and a lock probe. */
export async function doctor(d: DoctorDeps): Promise<DoctorReport> {
  const checks: Check[] = [];
  checks.push(
    bunTooOld(d.bunVersion)
      ? {
          id: "bun",
          label: "Bun",
          state: "fail",
          word: "too old",
          detail: `${d.bunVersion}, needs ${MIN_BUN}`,
          fix: "bun upgrade",
        }
      : { id: "bun", label: "Bun", state: "ok", word: "ready", detail: d.bunVersion },
  );

  let profiles: Profile[] = [];
  let active: Profile | null = null;
  try {
    readConfig();
    readProjects();
    active = getProfile(activeName());
    profiles = linkedProfiles().map(getProfile);
    checks.push({
      id: "config",
      label: "config",
      state: "ok",
      word: "ready",
      detail: `active profile ${active.name}`,
    });
  } catch (e) {
    checks.push({
      id: "config",
      label: "config",
      state: "fail",
      word: "invalid",
      detail: errText(e),
      fix: fixOf(e) ?? "catherd init",
    });
  }
  if (active) {
    const v = validateNamed(active.name);
    const first = v.errors[0] ?? v.warnings[0];
    checks.push({
      id: "profile",
      label: `profile ${active.name}`,
      state: v.errors.length ? "fail" : v.warnings.length ? "warn" : "ok",
      word: v.errors.length ? "invalid" : v.warnings.length ? "warning" : "ready",
      detail: first
        ? `${first.path}: ${first.message}${v.errors.length + v.warnings.length > 1 ? " (and more)" : ""}`
        : "valid",
      ...(first ? { fix: first.fix ?? "catherd profile validate" } : {}),
    });
  }

  const used = usedBackends(profiles);
  checks.push(...(await backendChecks(used)));

  if (active?.jev.use === "off")
    checks.push({ id: "jev", label: "Jev", state: "skip", word: "off", detail: "off in the profile" });
  else {
    const key = jevKey();
    if (!key)
      checks.push({
        id: "jev",
        label: "Jev",
        state: "warn",
        word: "no key",
        detail: "optional: routing uses each lane's Kind and Difficulty instead",
        fix: "catherd init, or export TYPESAFE_API_KEY=<key>",
      });
    else {
      const ok = await testJevKey(key, d.jev).catch(() => false);
      checks.push(
        ok
          ? { id: "jev", label: "Jev", state: "ok", word: "ready", detail: "the key answers" }
          : {
              id: "jev",
              label: "Jev",
              state: "warn",
              word: "no answer",
              detail: "the key did not answer; routing falls back to the lanes",
              fix: "catherd init to enter a new key",
            },
      );
    }
  }

  checks.push(pluginCheck(d.version));

  checks.push(
    active
      ? agentsCheck()
      : {
          id: "agents",
          label: "Claude agents",
          state: "skip",
          word: "not checked",
          detail: "the config cannot be read",
        },
  );

  const h = await d
    .handshake()
    .catch((e: unknown): Handshake => ({ ok: false, tools: [], error: errText(e) }));
  checks.push(
    h.ok && h.tools.includes("status")
      ? {
          id: "mcp",
          label: "MCP server",
          state: "ok",
          word: "ready",
          detail: `answers tools/list with ${h.tools.length} tools`,
        }
      : {
          id: "mcp",
          label: "MCP server",
          state: "fail",
          word: "no answer",
          detail: h.error ?? "tools/list has no status tool",
          fix: "run catherd mcp to see why it does not start",
        },
  );

  checks.push(locksCheck());
  for (const id of used.keys()) {
    const a = adapterFor(id);
    if (!a?.canWrite) continue;
    const r = await a.canWrite(locksDir()).catch(() => null);
    const base = { id: `sandbox:${id}`, label: `heavy-lock dir from ${id}'s sandbox` };
    checks.push(
      r === null
        ? {
            ...base,
            state: "skip",
            word: "not tested",
            detail: `no ${id} sandbox to test with on this machine`,
          }
        : r.ok
          ? {
              ...base,
              state: "ok",
              word: "ready",
              detail: "a workspace-write worker can take the heavy lock",
            }
          : {
              ...base,
              state: "warn",
              word: "not writable",
              detail: `a workspace-write ${id} worker cannot write ${locksDir()}, so catherd lock fails inside it`,
              ...(r.fix ? { fix: r.fix } : {}),
            },
    );
  }

  const full: string[] = [];
  const advisory: string[] = [];
  for (const p of profiles)
    for (const role of ROLES) {
      const rc = p.roles[role];
      if (!rc.enabled) continue;
      if (rc.access === "full") full.push(`${role} (${p.name})`);
      const soft = [
        ...new Set(
          rc.rungs
            .filter((r) => enforcementOf(r, rc.access) === "advisory")
            .map((r) => r.slice(0, r.indexOf(":"))),
        ),
      ];
      if (soft.length) advisory.push(`${role} on ${soft.join(", ")} (${p.name})`);
    }
  if (full.length)
    checks.push({
      id: "access:full",
      label: "full access",
      state: "warn",
      word: "warning",
      detail: `no sandbox for: ${full.join(", ")}`,
    });
  if (advisory.length)
    checks.push({
      id: "access:advisory",
      label: "advisory access",
      state: "warn",
      word: "warning",
      detail: `the backend asks but cannot force: ${advisory.join(", ")}`,
    });
  for (const id of used.keys()) {
    const note = adapterFor(id)?.isolationNote;
    if (note)
      checks.push({
        id: `isolation:${id}`,
        label: `${id} isolation`,
        state: "warn",
        word: "weak",
        detail: note,
      });
  }

  const creds = credentialsPath();
  if (existsSync(creds)) {
    const mode = statSync(creds).mode & 0o777;
    checks.push(
      mode & 0o077
        ? {
            id: "credentials",
            label: "credentials.json",
            state: "fail",
            word: "readable by others",
            detail: `mode ${mode.toString(8)}`,
            fix: `chmod 600 ${creds}`,
          }
        : { id: "credentials", label: "credentials.json", state: "ok", word: "ready", detail: "mode 600" },
    );
  }

  if (!Bun.which("bunx", { PATH: process.env.PATH ?? "" }))
    checks.push({
      id: "bunx",
      label: "bunx",
      state: "warn",
      word: "missing",
      detail: "the plugin starts the MCP server with bunx",
      fix: "put Bun's bin folder (~/.bun/bin) on PATH",
    });
  const corrupt = listRuns().corrupt;
  if (corrupt.length)
    checks.push({
      id: "runs",
      label: "run data",
      state: "warn",
      word: "unreadable",
      detail: corrupt.map((c) => `${c.id}: ${c.reason}`).join("; "),
      fix: `fix or delete ${corrupt[0]?.dir}`,
    });

  return { ready: !checks.some((c) => c.state === "fail"), version: d.version, checks };
}
```

`src/entry/mcp/handshake.ts`:

```ts
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "../../infra/version.ts";
import type { Handshake } from "../../services/doctor.ts";

const CLI = fileURLToPath(new URL("../../cli.ts", import.meta.url));

/** Spec §10.3: starts `catherd mcp` over stdio, as Claude Code would, and asks it for tools/list. */
export async function mcpHandshake(timeoutMs = 20_000): Promise<Handshake> {
  const client = new Client({ name: "catherd-doctor", version: VERSION });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    env: Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    ),
    stderr: "ignore",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Handshake>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, tools: [], error: `no answer within ${timeoutMs / 1000} s` }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      (async (): Promise<Handshake> => {
        await client.connect(transport);
        const r = await client.listTools();
        return { ok: true, tools: r.tools.map((t) => t.name) };
      })(),
      late,
    ]);
  } catch (e) {
    return { ok: false, tools: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
```

`src/entry/doctor-command.ts`:

```ts
import { defineCommand } from "citty";
import { VERSION } from "../infra/version.ts";
import { type Check, type DoctorReport, doctor } from "../services/doctor.ts";
import { EXIT, mark, printJson } from "./cli-kit.ts";
import { mcpHandshake } from "./mcp/handshake.ts";

/** One row per check: `✓ ready  Bun — 1.4.2`, then the full fix command on its own line. */
export function formatCheck(c: Check, plain = false): string[] {
  return [
    `${mark(c.state, plain)} ${c.word.padEnd(18)} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`,
    ...(c.fix ? [`    fix: ${c.fix}`] : []),
  ];
}

export function formatReport(r: DoctorReport, plain = false): string[] {
  return [
    ...r.checks.flatMap((c) => formatCheck(c, plain)),
    "",
    r.ready
      ? `${mark("ok", plain)} ready`
      : `${mark("fail", plain)} not ready: fix the rows marked ${mark("fail", plain)} above`,
  ];
}

/** Spec §8, §10.3: `catherd doctor [--json]`, exit 3 when not ready. */
export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Readiness report: Bun, backends, Jev, the plugin, agents, the MCP server, locks",
  },
  args: {
    json: { type: "boolean", description: "print JSON" },
    plain: { type: "boolean", description: "ASCII glyphs" },
  },
  async run({ args }) {
    const r = await doctor({ bunVersion: Bun.version, version: VERSION, handshake: () => mcpHandshake() });
    if (args.json) printJson(r);
    else for (const l of formatReport(r, args.plain === true || !!process.env.NO_COLOR)) console.log(l);
    process.exitCode = r.ready ? EXIT.ok : EXIT.notReady;
  },
});
```

In `src/cli.ts`, add to `main`'s `subCommands`, before `profile`:

```ts
    doctor: () => import("./entry/doctor-command.ts").then((m) => m.doctorCommand),
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun run format && bun test test/services/doctor.test.ts test/entry/doctor-command.test.ts test/adapters test/sim`
Expected: PASS (10 and 3 tests; the adapter contract suite and the simulator tests still pass).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint && bun run format:check`
Expected: clean.

```bash
git add -A src test
git commit -m "feat(cli): catherd doctor, with the MCP stdio handshake, the lock dir from a Codex sandbox, and exit 3"
```

---

### Task 13: `catherd init` without the TUI

Spec §8's `init [--no-input]` as plain prompts (Ruling 11); plan 6 adds the TUI wizard. The service half (`src/services/setup.ts`) moves 0.x files aside, writes the default profile unless a 1.0 one should be kept, activates it, links its agents and lists every backend's models; the command asks the questions, then prints the doctor report and the plugin install commands. The 0.x TUI's `init` command goes (the dashboard's Setup still opens the 0.x screen).

**Files:**
- Create: `src/services/setup.ts`, `src/entry/prompt.ts`, `src/entry/init-command.ts`
- Modify: `src/cli.ts`, `src/tui/commands.ts` (replace)
- Test: `test/services/setup.test.ts`, `test/entry/init-command.test.ts`

**Interfaces:**
- Consumes: Task 4 (`activate`, `configFile`, `profilesDir`, `projectsFile`, `resetProfile`, `profileExists`, `Synced`), Task 12 (`doctor`, `formatReport`, `mcpHandshake`), Task 8 (`mark`, `EXIT`); Task 1 (`assertProfileName`); plan 4's `refreshDiscovery`, `Refreshed`, `formatRefreshed` (`src/entry/catalog-command.ts`), `jevKey`, `saveJevKey`, `testJevKey`.
- Produces: `moveLegacy(now?): string[]`, `interface InitResult { moved; profile; created; synced; refreshed }`, `initSetup(o?: { profile?; overwrite?; now? }): Promise<InitResult>`; `interface Prompter { ask; secret; close }`, `prompter(): Promise<Prompter>`; `PLUGIN_STEPS`, `initCommand`.

- [ ] **Step 1: Write the failing tests**

`test/services/setup.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  configFile,
  getProfile,
  patchProfile,
  profilesDir,
  projectsFile,
} from "../../src/services/profile-service.ts";
import { initSetup, moveLegacy } from "../../src/services/setup.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

function legacyFiles(): void {
  mkdirSync(profilesDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify({ activeProfile: "fast" }));
  writeFileSync(projectsFile(), JSON.stringify({ "/r/app": "fast" }));
  writeFileSync(
    join(profilesDir(), "fast.json"),
    JSON.stringify({ name: "fast", objective: "speed", roles: {} }),
  );
}

describe("moveLegacy", () => {
  it("moves every 0.x file to a dated backup and leaves 1.0 files alone", () => {
    withHome();
    legacyFiles();
    writeFileSync(join(profilesDir(), "team.json"), JSON.stringify({ schema: 1, name: "team" }));
    const moved = moveLegacy(new Date("2026-09-25T12:00:00Z"));
    expect(moved.map((f) => f.slice(dirname(configFile()).length + 1)).sort()).toEqual([
      "0.x-backup-2026-09-25T12-00-00-000Z/config.json",
      "0.x-backup-2026-09-25T12-00-00-000Z/profiles/fast.json",
      "0.x-backup-2026-09-25T12-00-00-000Z/projects.json",
    ]);
    expect([existsSync(configFile()), existsSync(join(profilesDir(), "team.json"))]).toEqual([false, true]);
    expect(moveLegacy()).toEqual([]);
  });
});

describe("initSetup", () => {
  it("writes the default profile, makes it active and links its agents, after moving 0.x files", async () => {
    withHome();
    process.env.PATH = "/nonexistent";
    legacyFiles();
    const r = await initSetup();
    expect([r.profile, r.created, r.moved.length]).toEqual(["default", true, 3]);
    expect(r.synced.linked).toEqual([
      "catherd-default-architect-claude-opus-5-5-high",
      "catherd-default-verifier-claude-opus-5-5-low",
    ]);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ schema: 1, activeProfile: "default" });
    expect(r.refreshed.map((x) => x.backend)).toContain("codex");
  });

  it("keeps a 1.0 profile unless asked to replace it", async () => {
    withHome();
    process.env.PATH = "/nonexistent";
    patchProfile("team", { budget: { usd: 3 } });
    expect((await initSetup({ profile: "team" })).created).toBe(false);
    expect(getProfile("team").budget).toEqual({ usd: 3 });
    expect((await initSetup({ profile: "team", overwrite: true })).created).toBe(true);
    expect(getProfile("team").budget).toEqual({});
    expect(basename(join(profilesDir(), "team.json"))).toBe("team.json");
  });
});
```

`test/entry/init-command.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { PLUGIN_STEPS } from "../../src/entry/init-command.ts";
import { activeName, getProfile, patchProfile } from "../../src/services/profile-service.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { SRC } from "../import-graph.ts";

afterEach(snapshotEnv());

function init(args: string[], stdin = "") {
  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), "init", ...args], {
    // no backend CLI and no Jev key: nothing reaches the network or the user's own CLIs
    env: {
      ...process.env,
      PATH: `/nonexistent:${join(process.execPath, "..")}:/usr/bin:/bin`,
      TYPESAFE_API_KEY: "",
    },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("catherd init", () => {
  it("--no-input writes and activates the default profile, reports readiness, and ends with the plugin steps", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    const r = init(["--no-input"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("✓ profile default written from the defaults, and active\n");
    expect(r.out).toContain("✓ ready              MCP server — answers tools/list with 20 tools\n");
    expect(r.out).toContain("✗ missing            Claude Code plugin — not installed in Claude Code\n");
    expect(r.out.trimEnd().split("\n").slice(-4)).toEqual(PLUGIN_STEPS);
    expect(activeName()).toBe("default");
  }, 60_000);

  it("--no-input keeps a profile it finds", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    patchProfile("default", { budget: { usd: 9 } });
    expect(init(["--no-input"]).out).toContain("✓ profile default kept as it was, and active\n");
    expect(getProfile("default").budget).toEqual({ usd: 9 });
  }, 60_000);

  it("reads piped answers: an empty key skips Jev, a name picks the profile, y replaces it", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    patchProfile("team", { budget: { usd: 9 } });
    const r = init([], "\nteam\ny\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain("TypeSafe API key for Jev (optional; Enter skips): \n- Jev: no key;");
    expect(r.out).toContain("✓ profile team written from the defaults, and active\n");
    expect([activeName(), getProfile("team").budget]).toEqual(["team", {}]);
  }, 60_000);

  it("refuses a bad profile name as a usage error", () => {
    withHome();
    const r = init(["--no-input", "--profile", "Team"]);
    expect([r.code, r.err.split("\n")[0]]).toEqual([2, 'error E_INPUT_INVALID: bad profile name "Team"']);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/services/setup.test.ts test/entry/init-command.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/setup.ts'`.

- [ ] **Step 3: Write the implementation**

`src/services/setup.ts`:

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { configDir } from "../infra/paths.ts";
import { type Refreshed, refreshDiscovery } from "./catalog-service.ts";
import {
  activate,
  configFile,
  profilesDir,
  projectsFile,
  resetProfile,
  type Synced,
} from "./profile-service.ts";

/** A JSON file written by catherd 0.x: readable JSON with no `schema` field. */
function isLegacy(file: string): boolean {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { schema?: unknown } | null;
    return typeof v === "object" && v !== null && v.schema === undefined;
  } catch {
    return false;
  }
}

/**
 * Spec D2, a clean break: 1.0 never reads a 0.x config.json, projects.json or profile, so `init` moves
 * them to `<config>/0.x-backup-<stamp>/`. Returns the files moved.
 */
export function moveLegacy(now: Date = new Date()): string[] {
  const candidates = [
    configFile(),
    projectsFile(),
    ...(existsSync(profilesDir())
      ? readdirSync(profilesDir())
          .filter((f) => f.endsWith(".json"))
          .map((f) => join(profilesDir(), f))
      : []),
  ].filter((f) => existsSync(f) && isLegacy(f));
  if (candidates.length === 0) return [];
  const backup = join(configDir(), `0.x-backup-${now.toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(join(backup, "profiles"), { recursive: true });
  return candidates.map((f) => {
    const to = join(backup, f.startsWith(profilesDir()) ? join("profiles", basename(f)) : basename(f));
    renameSync(f, to);
    return to;
  });
}

export interface InitResult {
  moved: string[];
  profile: string;
  /** false when a 1.0 profile of that name was kept as it was */
  created: boolean;
  synced: Synced;
  refreshed: Refreshed[];
}

/**
 * Spec §8 `catherd init`, the setup half: moves 0.x files aside, writes the default profile (spec §7.2)
 * unless a 1.0 one exists and `overwrite` is not set, makes it active and links its agents, and lists
 * every backend's models.
 */
export async function initSetup(
  o: { profile?: string; overwrite?: boolean; now?: Date } = {},
): Promise<InitResult> {
  const moved = moveLegacy(o.now);
  const profile = o.profile ?? "default";
  const created = !existsSync(join(profilesDir(), `${profile}.json`)) || o.overwrite === true;
  if (created) resetProfile(profile);
  const synced = activate(profile);
  const refreshed = await refreshDiscovery();
  return { moved, profile, created, synced, refreshed };
}
```

`src/entry/prompt.ts`:

```ts
import { createInterface, type Interface } from "node:readline/promises";
import { EXIT } from "./cli-kit.ts";

/** Plain questions on stdin; `secret` does not echo what is typed. */
export interface Prompter {
  ask(question: string): Promise<string>;
  secret(question: string): Promise<string>;
  close(): void;
}

/** A terminal's hidden input, one character at a time; Ctrl-C exits 130 (spec §8). */
function readSecret(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  return new Promise((resolve) => {
    let value = "";
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.exit(EXIT.interrupted);
        }
        if (ch === "\u007f") {
          if (value) process.stdout.write("\b \b");
          value = value.slice(0, -1);
        } else {
          value += ch;
          process.stdout.write("*");
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/**
 * Questions for `catherd init`. On a terminal they are asked one by one; piped, stdin is read once and each
 * question takes the next line (an empty or missing line takes the default), so scripts can answer them.
 */
export async function prompter(): Promise<Prompter> {
  if (!process.stdin.isTTY) {
    const lines = (await Bun.stdin.text()).split("\n");
    const next = async (q: string) => {
      const answer = (lines.shift() ?? "").trim();
      process.stdout.write(`${q}\n`);
      return answer;
    };
    return { ask: next, secret: next, close() {} };
  }
  let rl: Interface | null = null;
  return {
    async ask(q) {
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      return (await rl.question(q)).trim();
    },
    secret: (q) => readSecret(q),
    close() {
      rl?.close();
    },
  };
}
```

`src/entry/init-command.ts`:

```ts
import { defineCommand } from "citty";
import { assertProfileName } from "../domain/profile.ts";
import { configDir } from "../infra/paths.ts";
import { VERSION } from "../infra/version.ts";
import { doctor } from "../services/doctor.ts";
import { jevKey, saveJevKey, testJevKey } from "../services/jev-service.ts";
import { profileExists } from "../services/profile-service.ts";
import { initSetup } from "../services/setup.ts";
import { formatRefreshed } from "./catalog-command.ts";
import { mark } from "./cli-kit.ts";
import { formatReport } from "./doctor-command.ts";
import { mcpHandshake } from "./mcp/handshake.ts";
import { type Prompter, prompter } from "./prompt.ts";

/** What `init` prints last (spec §9.1): the plugin install commands, to paste into a terminal. */
export const PLUGIN_STEPS = [
  "Install the Claude Code plugin:",
  "  claude plugin marketplace add 47vigen/catherd",
  "  claude plugin install catherd@catherd",
  "Then start a new Claude Code session, so it loads the plugin and the catherd agents.",
];

async function jevStep(ask: Prompter | null): Promise<void> {
  if (process.env.TYPESAFE_API_KEY?.trim()) return console.log(`${mark("ok")} Jev: using TYPESAFE_API_KEY`);
  if (jevKey()) return console.log(`${mark("ok")} Jev: using the saved key`);
  const key = ask ? await ask.secret("TypeSafe API key for Jev (optional; Enter skips): ") : "";
  if (!key)
    return console.log(
      `- Jev: no key; routing uses each lane's Kind and Difficulty (add one later with catherd init)`,
    );
  if (await testJevKey(key).catch(() => false)) {
    saveJevKey(key);
    console.log(`${mark("ok")} Jev: the key answers; saved with mode 600`);
  } else console.log(`${mark("warn")} Jev: the key did not answer, so it was not saved`);
}

/** Spec §8 `catherd init [--no-input]`: first-run setup without the TUI (plan 6 adds the TUI wizard). */
export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "First run: the Jev key, the default profile, its agents, and a readiness report",
  },
  args: {
    // citty reads --no-input as input: false
    input: {
      type: "boolean",
      default: true,
      description: "ask questions (piped answers are read to the end of stdin)",
      negativeDescription: "ask nothing: keep what exists, else write the defaults",
    },
    profile: { type: "string", description: "the profile to set up and make active (default: default)" },
  },
  async run({ args }) {
    const ask = args.input === false ? null : await prompter();
    try {
      console.log(`catherd ${VERSION}: setting up in ${configDir()}`);
      await jevStep(ask);
      let name =
        args.profile ?? (ask ? (await ask.ask("Profile to set up [default]: ")) || "default" : "default");
      name = assertProfileName(name);
      const overwrite =
        ask !== null &&
        profileExists(name) &&
        /^y(es)?$/i.test(await ask.ask(`Replace profile ${name} with the default profile? [y/N] `));
      const r = await initSetup({ profile: name, overwrite });
      for (const f of r.moved) console.log(`${mark("ok")} moved a 0.x file aside: ${f}`);
      console.log(
        `${mark("ok")} profile ${r.profile} ${r.created ? "written from the defaults" : "kept as it was"}, and active`,
      );
      if (r.synced.linked.length)
        console.log(`${mark("ok")} Claude agents linked: ${r.synced.linked.join(", ")}`);
      for (const x of r.refreshed) console.log(formatRefreshed(x));
      console.log("");
      const report = await doctor({
        bunVersion: Bun.version,
        version: VERSION,
        handshake: () => mcpHandshake(),
      });
      for (const l of formatReport(report)) console.log(l);
      console.log("");
      for (const l of PLUGIN_STEPS) console.log(l);
    } finally {
      ask?.close();
    }
  },
});
```

In `src/cli.ts`, replace the `init` subcommand line (the 0.x TUI) with:

```ts
    init: () => import("./entry/init-command.ts").then((m) => m.initCommand),
```

`src/tui/commands.ts` (replace the file: only the bare `catherd` dashboard is left in it):

```ts
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createElement, type ReactNode } from "react";
import { Dashboard } from "./dashboard.tsx";
import { detectUi } from "./theme.ts";

export const isBare = (rawArgs: string[]): boolean => rawArgs.every((a) => a.startsWith("-"));

export async function mount(el: ReactNode, stdin: { isTTY?: boolean } = process.stdin): Promise<number> {
  if (!stdin.isTTY) {
    console.error(
      "catherd: this screen needs an interactive terminal. Scripts can use the MCP tools (status, profile_get).",
    );
    return 1;
  }
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  createRoot(renderer).render(el);
  await new Promise<void>((resolve) => renderer.once("destroy", () => resolve()));
  return Number(process.exitCode ?? 0);
}

/** The main command's run. citty runs it after any subcommand too, hence the isBare check.
 * Bare `catherd` opens the dashboard; Profile/Watch/Setup from there render Editor/Watch/Init
 * inline, in the same mounted tree — see dashboard.tsx. */
export async function editorRun({ rawArgs }: { rawArgs: string[] }): Promise<void> {
  if (!isBare(rawArgs)) return;
  process.exitCode = await mount(createElement(Dashboard, { ui: detectUi(rawArgs) }));
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun run format && bun test test/services/setup.test.ts test/entry/init-command.test.ts test/tui`
Expected: PASS (3 and 4 tests; the 0.x TUI tests still pass).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint && bun run format:check`
Expected: clean.

```bash
git add -A src test
git commit -m "feat(cli): catherd init with plain prompts and --no-input: 0.x files aside, the default profile, a readiness report"
```

---

### Task 14: The skills, `set_next`'s hints, and the README

The `/catherd-setup` skill moves to the 1.0 profile: every field `profile_set` stores, access with its enforcement, errors versus warnings, `newSessionNeededFor`, and the treat-like command now that no TUI step is needed. `set_next` returns `{ state, hints? }` like every other tool (plan-2 m8), and the orchestrator skill says so. The README lists the 1.0 commands and exit codes.

**Files:**
- Modify: `plugin/skills/catherd-setup/SKILL.md` (replace), `plugin/skills/catherd/SKILL.md`, `src/services/run-service.ts`, `src/entry/mcp/run-tools.ts`, `README.md`
- Test: `test/skills.test.ts`, `test/entry/mcp.test.ts`, `test/services/lanes-run.test.ts`

**Interfaces:**
- Consumes: Task 5's `profile_set`, `profile_get` and `profile_validate` shapes; plan 2's `refreshState`.
- Produces: `setNext(i): Promise<{ state: string | null; hints?: string[] }>`.

- [ ] **Step 1: Write the failing tests**

In `test/skills.test.ts`, in `describe("setup skill")`, before the test `"keeps spec §11's conversation rules and offers the isolation toggle"`, add:

```ts
  it("covers every profile field profile_set stores, access with its enforcement, and the treat-like command", () => {
    const md = skill("catherd-setup");
    for (const field of [
      "`objective`",
      "`jev.use`",
      "`billing`",
      "`rungs`",
      "`defaultRung`",
      "`access`",
      "`failover`",
      "`budget`",
      "`timeouts.idleMin`",
      "`preflight.confirm`",
      "`harness.<name>.isolated`",
      "`lock.heavy`",
      "`notify`",
    ])
      expect(md).toContain(field);
    for (const word of ["`enforced`", "`advisory`", "`newSessionNeededFor`", "`warnings`", "`null` removes"])
      expect(md).toContain(word);
    expect(md).toContain("catherd catalog treat-like <rung> <scored rung>");
    expect(md).not.toContain("the TUI edits");
  });
```

In `test/entry/mcp.test.ts`, replace

```ts
    const set = await call(c, "set_next", { run: run.id, next: "paused: lunch" });
    expect(set.raw.trimEnd().split("\n").at(-1)).toBe("Next: paused: lunch");
```

with

```ts
    const set = await call(c, "set_next", { run: run.id, next: "paused: lunch" });
    expect(set.data.state.trimEnd().split("\n").at(-1)).toBe("Next: paused: lunch");
    expect(set.data.hints).toBeUndefined();
```

and

```ts
    expect(set.isError).toBe(false);
    expect(set.raw).toMatch(/^state\.md not refreshed: /);
```

with

```ts
    expect(set.isError).toBe(false);
    expect(set.data).toEqual({ state: null, hints: [expect.stringMatching(/^state\.md not refreshed: /)] });
```

In `test/services/lanes-run.test.ts`, replace `expect(await setNext({ run: run.id, next: "paused: lunch" })).toBe(hint);` with `expect(await setNext({ run: run.id, next: "paused: lunch" })).toEqual({ state: null, hints: [hint] });`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/skills.test.ts test/entry/mcp.test.ts test/services/lanes-run.test.ts`
Expected: FAIL — the setup skill lacks `` `jev.use` ``, and `set_next` still returns plain text.

- [ ] **Step 3: Write the implementation**

In `src/services/run-service.ts`, replace `setNext`:

```ts
/** state.md's new text, or the hint `state.md not refreshed: <message>` (the note is kept in state.json). */
export async function setNext(i: { run: string; next: string }): Promise<string> {
  const { text, hints } = await refreshState(findRun(i.run), { next: i.next });
  return text ?? hints.join("\n");
}
```

with:

```ts
/**
 * `set_next`: state.md's new text, and, as every tool gives them, `hints`: `state.md not refreshed: <message>`
 * when git fails, with `state` null (the note is kept in state.json either way).
 */
export async function setNext(i: {
  run: string;
  next: string;
}): Promise<{ state: string | null; hints?: string[] }> {
  const { text, hints } = await refreshState(findRun(i.run), { next: i.next });
  return { state: text ?? null, ...(hints.length ? { hints } : {}) };
}
```

In `src/entry/mcp/run-tools.ts`, the `set_next` description becomes: `"Record the run's next step, the last line of state.md: when pausing, or when the plan changes. dispatch, climb and land write state.md themselves. Returns { state } (state.md's text), and hints ['state.md not refreshed: …'] with state null when git fails (the step is still recorded)."`

In `plugin/skills/catherd/SKILL.md`'s tool table, the `set_next(run, next)` row's text becomes `The next step, when you pause or the plan changes. Returns \`state\` and, when git fails, \`hints\``, and the `profile_get()` row's text becomes `The active profile: each role's access, rungs and enforcement, failover, budget, timeouts, and the moments to push` (keep the table's column padding; `bun run format` realigns it).

`plugin/skills/catherd-setup/SKILL.md` (replace the file):

```markdown
---
name: catherd-setup
description: Use when the user wants to tune catherd — which models and efforts each role may use, how much each role may touch, cost versus speed, which subscriptions to lean on, failover, budget, harness isolation — /catherd-setup, "set up catherd", "tune my catherd profile". Not for running a task; that is the catherd skill.
---

# catherd setup

You tune the user's catherd profile in conversation. A profile says, per role, which rungs it may run on (`backend:model#effort`, in ladder order) and what it may touch (its access mode); whether routing favours cost or speed; how each backend is billed; whether Jev picks the rung; which rung stands in when a backend hits its usage limit; the run budget and timeouts; whether each vendor harness runs with the user's customizations or isolated; how many heavy commands run at once; and when to push.

**You never edit a file by hand.** `profile_set` is the only writer, so this conversation, the `catherd profile` commands and the TUI cannot drift apart.

## Rules

- **One question at a time.** Each question carries your recommended answer and one line on why, so the user can simply say yes.
- **The user steers.** When they reverse a proposal, take the reversal and never re-argue it.
- **Talk in their terms:** minutes, their subscriptions, how often a rung climbed on their own runs, tokens per run. Benchmark names only when they ask.
- **Every number you quote comes from a tool result in this conversation.** When there is no data yet, say so instead of estimating.

## 1. Learn the goals

Ask these, one at a time, each with its recommended answer:

1. **Their order of speed, cost and quality.** Recommend cost first, the default `objective`: catherd climbs a rung when a cheap one cannot do the work, so the lanes that need speed get it anyway, and the reviewer and the verifier hold quality either way.
2. **The subscriptions they hold:** a ChatGPT plan (Codex), a Claude plan, OpenCode Go, Zen credit or API keys. They set `billing` per key (`codex`, `claude`, `claude-code`, `opencode-go`, `opencode`): `chatgpt-plan`, `claude-plan`, `subscription` or `metered`. Recommend leaning on subscriptions before metered spend, and on Claude last among the workers, since it spends the same quota as this conversation.
3. **The kind of work they orchestrate:** front-end screens, back-end services, terminal and ops work, docs. Recommend from their own runs when `runs_summary` has any.

## 2. Read the facts before proposing

In one message, call:

- `catalog_query({ role: "<role>" })` for each role you will discuss: the models that can fill it, their scored rungs, any "treat like", each rung's cost under their billing, and whether their backend's last listing offers it (`listed: false` means their account does not);
- `runs_summary({})`: how each rung has done on their own runs (runs, refusals, climbs, time) and the harness cost line;
- `profile_get()`: where they stand now, with each role's `access` and `enforcement`.

## 3. Propose one decision at a time

Go through these in order, and skip any the user does not care about:

1. `objective`, and `jev.use` (`auto` asks Jev when a key exists; `off` routes on each lane's `Kind:` and `Difficulty:` lines);
2. `billing`, from step 1;
3. the worker's `rungs` and its `defaultRung`;
4. the reviewer and the UI reviewer;
5. the architect and the verifier, which spend Claude quota. A `claude:` rung runs as a native subagent in this session; a `claude-code:` rung runs headless through `dispatch`. Recommend native for these two;
6. the writer, the researcher and the artist;
7. each role's `access` (below);
8. `failover` (below);
9. `budget`, `timeouts` and `preflight.confirm`;
10. harness isolation, per harness (below);
11. `lock.heavy` and `notify`.

Each proposal has three parts: the change, a worked example from their facts, and the tradeoff in their terms. For instance: "Luna high on build lanes: about 5 min slower than Sol medium, no Claude quota, climbs on 1 in 5 of your runs so far."

- Offer only the rungs `catalog_query` lists as capable for the role, written `backend:model#effort`.
- An unscored model can be enabled only once it has a "treat like <scored rung>". There is no tool for that: give the user the command to run in a terminal, `catherd catalog treat-like <rung> <scored rung>`, then come back and propose again.

**Access.** Each role runs `read-only`, `workspace-write` or `full`. The defaults: architect, reviewer and researcher `read-only`; worker, writer and artist `workspace-write`; verifier and UI reviewer `full`. `profile_get` says per role whether its backend holds it to that mode (`enforced`: Codex's sandbox) or only asks (`advisory`: claude-code, opencode and native subagents, where the model can still reach past it). Recommend the defaults; when the user wants a role tighter or looser, say what it can no longer do (a read-only reviewer on claude-code or opencode has no shell, so it cannot run `git diff`) and that `profile_validate` will warn about it.

**Failover.** `failover` maps a rung to its stand-in when that rung's backend hits a usage limit. A stand-in must be scored and on another quota (Go and Zen bill apart; native `claude` and `claude-code` share the Claude plan). The default profile fails each Codex rung over to OpenCode Go, marked inferred: Go's GPT-6 Luna for Luna, and Kimi K3, treated like Sol medium, for Sol. Say so, and offer to change it when they have no Go subscription. `null` removes an entry.

**Budget and timeouts.** `budget` (`minutes`, `tokens`, `usd`) is a soft cap: from 80 % routing starts at the cheapest rung that clears the bar, and at 100 % no new role starts. `timeouts.idleMin` (15) stops a role that has gone quiet, `timeouts.wallMin` (90) one that runs too long. `preflight.confirm: true` makes `preflight` show its commands for the user to approve first.

**Harness isolation.** For each harness they use (`codex`, `claude-code`, `opencode`), offer `harness.<name>.isolated` with its harness line from `runs_summary` and this tradeoff: "native keeps your hooks, skills and AGENTS.md; isolated saves ~N tokens per run, but the role loses them." Recommend native. When they have no isolated runs yet, the number is the median first-turn input of their native runs: say that isolation would save some part of it, not all of it. When there are no runs at all, say there is no number yet, and recommend native until there is.

## 4. Write it

- Call `profile_set({ patch })` with only what changed; pass `name` only to edit a profile other than the active one. Lists (`rungs`, `notify`) replace, maps (`billing`, `failover`, `budget`) merge, and `null` removes a key. A key it does not know is refused with `E_INPUT_INVALID`. It validates before it writes:
  - `saved: false` comes with `errors`, each with a `path`, a `message` and often a `fix`. Explain each in their terms, fix the patch, and propose again.
  - `saved: true` comes with the `diff` (`path`, `before`, `after`) and any `warnings`. Read the diff back to the user, one line per change, and each warning with it.
- Then call `profile_validate()`. `errors` block a save: the worker disabled, an enabled role with no usable rung, an unscored rung without a "treat like", a failover stand-in unscored or on the same quota, a backend catherd cannot run. `warnings` do not: an access mode other than the role's default, a model the backend's listing lacks, a stand-in that never runs.

## 5. Say what applies when

- Codex, claude-code and opencode changes, access and isolation included, apply at the next dispatch, even in a run already under way.
- An agent listed in `newSessionNeededFor` applies from the next Claude Code session: Claude Code reads agent files when a session starts. Other Claude changes apply now.
- Editing a profile that is not the active one writes its agent files but links none; they apply once it becomes active (`catherd profile use <name>`), or in a repo it is bound to (`catherd profile use <name> --repo`).
```

In `README.md`:
- Requirements: replace `- A TypeSafe API key for Jev, in \`TYPESAFE_API_KEY\` or \`~/.config/typesafe/api_key\`` with `- Optional: a TypeSafe API key for Jev, in \`TYPESAFE_API_KEY\` or saved by \`catherd init\``.
- Install: replace the sentence starting ``The npm package is `catherd-cli` `` through ``Then add the\nplugin to Claude Code:`` with:

```markdown
The npm package is `catherd-cli`; the command it installs is `catherd`. `init` asks for the optional Jev key,
writes the default profile and links its Claude agents, lists your backends' models, and ends with a readiness
report (`--no-input` asks nothing and keeps what exists). Then add the plugin to Claude Code:
```

  and the line `Start a new Claude Code session so the plugin, its MCP server and the agent files load.` with:

```markdown
Start a new Claude Code session so the plugin, its MCP server and the agent files load, then check with
`bunx catherd-cli doctor`.
```

- Use: replace the terminal command table and the `--plain` line after it with:

```markdown
| Command                                                                   | What it does                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `catherd`                                                                 | The TUI                                                                  |
| `catherd init [--no-input]`                                               | First-run setup                                                          |
| `catherd doctor [--json]`                                                 | Readiness report, one row per check with its fix; exits 3 when not ready |
| `catherd profile list\|show\|use [--repo]\|new\|copy\|rm\|diff\|validate` | Profiles; `use --repo` binds one to the repo you are in                  |
| `catherd profile set <path> <value>`                                      | One field, e.g. `roles.verifier.access read-only`, `budget.usd 20`       |
| `catherd status [run]`, `catherd watch [--once]`                          | Where runs stand                                                         |
| `catherd runs list\|show <id> [--debug]\|cancel <id> <role>`              | Past runs; `--debug` adds exit.json and the stderr and event tails       |
| `catherd catalog refresh\|list\|treat-like <rung> <like>`                 | The models catherd can place                                             |
| `catherd lock [--slots N] -- <cmd>`                                       | Runs a heavy command behind the machine-wide semaphore                   |

Run them as `bunx catherd-cli <command>` when catherd is not installed globally. Every read command takes
`--json`. Exit codes: 0 ok, 1 error, 2 usage, 3 not ready, 130 interrupted; an error prints
`error E_CODE: message` and a `fix:` line. `--verbose` (or `CATHERD_LOG=debug`) logs more to
`~/.local/share/catherd/logs/`, kept for 7 days with secrets redacted.
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun run format && bun test test/skills.test.ts test/entry/mcp.test.ts test/services/lanes-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Run everything, typecheck, lint, commit**

Run: `bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: clean; the full suite passes; `ls ~/.local/share/catherd/logs` shows nothing written by the tests.

```bash
git add -A plugin src test README.md
git commit -m "docs(plugin): the setup skill on the 1.0 profile and tools; set_next returns hints; the README's 1.0 commands"
```

---

## Self-review

- **Spec coverage.** §7.1 schema, optional roles, unknown fields, access defaults, errors and warnings: Tasks 1, 2 (and 4 through the service). §7.2 the default profile and its inferred Go stand-ins: Tasks 1, 2, 9 (`show`). §7.3 ProfileService operations, agent names, the link union, relink on save and activate, catherd-only links, new sessions: Task 4, used by Tasks 5, 6, 9, 13. D3 per-role native or headless: Ruling 1, Task 1. D10 access with enforcement: Tasks 4 (`roleEnforcement`), 5 (`profile_get`), 9 (`show`), 12 (warnings). §4.8 `profile_set` with every field: Tasks 1, 5. §8 every command: `init` 13, `doctor` 12, `profile` 9, `status`/`watch`/`runs` 10, `catalog` (plan 4), `lock` 11, `capture-fixtures` (plan 3), `mcp` and `_supervise` 8; exit codes and error lines 8; `--json` on every read command 9, 10, 12. §10.2: Tasks 7, 10. §10.3: Task 12. §3.1: Task 8. §3.4's lock and schema rules: Task 4. The deferred items: bridge saves unlocked (4), `profile_set` stripping unknown keys and flag-shaped rungs (1, 5), the Bun guard (8), failover keys for native roles (1, 5), the researcher prompt (3), `set_next` (14), `lock` signals and its silent fallback (11), `_supervise` hidden (8), claude-code isolation never settable (1, 5), `catalog_query` billing (5).
- **Placeholders.** None: every step has its code or its exact edit.
- **Types.** `ProfilePort.agentFor(repo, role, rung)` everywhere (Task 5 and `test/services/helpers.ts`); `Saved`/`ProfileSaved` have the same members; `Issue` is Task 2's in the port, the CLI and the shim; `Check`/`DoctorReport` are Task 12's in `init`; `EXIT` and `mark` are Task 8's in every command.
- **Review Focus.** Each of the five lines names the test that pins it, in its owning task.

## After this plan

- Plan 6 replaces the 0.x TUI: its profile screens call the ProfileService directly and `src/tui/profile-shim.ts`, `src/core`, `src/routing/{catalog,select,jev}.ts`, `catalog/catalog.json` and `src/types.ts` go with it; its `init` wizard reuses `initSetup`, and its Runs tab replaces the plain `watch`.
- Plan 7: check `codex sandbox <os> --full-auto` against a real Codex CLI and, once verified, have the Codex adapter add the lock dir to `writable_roots` for workspace-write runs itself; the hidden Jev-key prompt on a real terminal; a `doctor` MCP tool if the skill needs one (the audit's suggestion; spec §4.8 does not list it).
