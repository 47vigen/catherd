# Host context and profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the orchestration host before using host defaults, namespace session ownership, and make Claude optional for Codex-only profiles.

**Architecture:** Extend the current dependency ports, profile resolver and versioned stores; keep one orchestration engine. Entry establishes host context at MCP initialization, services consume it lazily, and only the existing explicit ownership operations transfer runs.

**Tech Stack:** Bun ≥ 1.4, TypeScript, Zod, existing MCP SDK 1.30.1, existing file locks and Bun tests.

**Spec:** `docs/specs/2026-10-01-catherd-codex-entry-design.md`; delivery evidence: `docs/research/2026-10-01-codex-messaging.md`.

## Global Constraints

- Owner review of all three plans precedes ANY implementation, including scratch implementations. This plan is **source-validated only, not built**; source/test feasibility checks do not establish a green gate.
- Execute **18 → 19 → 20** on the same dependent feature head. These are locally testable increments, not independently releasable features. Do not release a predecessor or push `beta`; plan 20 holds publication for actual packaged both-host acceptance and owner production approval.
- Preserve `domain → infra → adapters → services → entry`, ProfileService as sole writer, locked atomic schema-versioned stores, detached supervisors, routing, failover and verifier gate.
- Omitted Codex architect/verifier defaults are EXACTLY `codex:gpt-6.1-sol#high` / `codex:gpt-6.1-sol#low`. Validate that exact user spelling in the native catalog; report a mismatch for an explicit owner resolution. No silent model substitution or unrelated default upgrade.
- Existing native Claude defaults remain `claude:claude-opus-5-5#high` / `claude:claude-opus-5-5#low`; every explicit ladder, default rung and other profile setting stays authoritative.
- No automatic profile migration, provider installation, second engine, Codex native-subagent subsystem, network discovery on MCP initialization, model polling or CI checks. Before implementation pushes, inspect existing workflows and hold a push that would run prohibited checks until the owner supplies a policy decision; do not rewrite workflows as feature scope.
- Ordinary implementation workers use configured native Codex model unchanged, low/medium effort; at most three workers plus coordinator. Coordinator reads diffs and runs verification personally, with no verifier subagent. Product verifier role defaults above are separate from the implementation process.
- English artifacts; explicit subprocess environments; never serialize messaging tokens. Preserve credentials, user configuration and `CODEX_HOME`; preserve preflight's stricter credential allowlist.

## Review Focus

1. Both vendors expose the same session ID: ownership and run groups remain distinct — Task 2 `same_id_different_hosts`.
2. Initialization contradicts environment, or reconnect changes identity: claims and sends stop without blocking read-only retrieval — Task 1 `conflicting_initialized_host`.
3. A legacy materialized profile is read from Codex: bytes remain unchanged and native Claude fails clearly — Task 3 `legacy_bytes_and_native_rejection`.
4. A repo-bound Codex profile coexists with a broken linked Claude profile: readiness remains selected-profile scoped and there are zero Claude writes — Task 4 `codex_ready_other_profile_broken`.
5. TUI preview and save use different defaults, or a child inherits parent identity: effective preview matches save and no child can claim the parent — Task 3 `tui_host_preview_save`, Task 4 `scrub_every_boundary`.

---

## Source preflight and shared interfaces

Read `CLAUDE.md` and `docs/handoff/HANDOFF.md`; newer owner instructions above override the old scratch-build/reviewer/CI/release procedure. Graph discovery used `Users-vigen-agora-lab-catherd`, then source reads in this worktree. Existing tests listed below exist. No tests, installs, scratch builds or live sends were run during planning.

The main checkout's installed SDK declarations expose `Server.oninitialized?: () => void` and `Server.getClientVersion(): Implementation | undefined`; `McpServer.server` is the low-level server. Bind these actual APIs before connect, rather than equating transport connection with initialization.

Create `src/domain/host.ts` with the following shared signatures; plans 19–20 consume them unchanged:

```ts
type OrchestrationHost = "claude-code" | "codex" | "unknown";
type KnownHost = Exclude<OrchestrationHost, "unknown">;
interface HostSessionRef { host: KnownHost; sessionId: string; hostSessionId: string | null; name: string | null }
interface HostContext { host: OrchestrationHost; session: HostSessionRef | null; conflict: string | null }
function sessionKey(s: Pick<HostSessionRef, "host" | "sessionId">): string;
```

`sessionKey` returns `JSON.stringify([s.host, s.sessionId])`, avoiding delimiter collisions. Add `host: HostContext` to `Deps`; retain `session: SessionEnv | null` solely for Claude transport credentials and registry refresh, with no token in HostContext. `profileService(host: () => HostContext): ProfilePort` resolves the callback per operation; defaultDeps builds unknown context and the callback reads the current `deps.host`, not a captured pre-initialization value.

### Task 1: Resolve host at the real initialization boundary

**Files:** Create `src/infra/host-context.ts`, `src/domain/host.ts`, `test/infra/host-context.test.ts`; modify `src/services/ports.ts`, `src/entry/deps.ts`, `src/entry/mcp/server.ts`, `src/entry/mcp/handshake.ts`, `test/services/helpers.ts`; extend `test/entry/mcp-handshake-env.test.ts`, `test/entry/mcp-handshake.test.ts`, `test/integration/mcp-stdio.test.ts`.

**Interfaces:** Produces `resolveHost(e: { clientName?: string; env: Record<string,string|undefined>; terminalHost?: OrchestrationHost }): HostContext` and `defaultDeps(host?: HostContext): Deps`. Recognized launcher variable is `CATHERD_ORCHESTRATION_HOST=codex|claude-code`; it identifies integration, never invents a session. Read Codex IDs from `CODEX_THREAD_ID` / `CODEX_SESSION_ID`; if both exist they must agree and be UUIDs. Preserve current Claude `readSessionEnv` and live registry selection.

- [ ] **RED:** Add `consistent_host`, `path_is_not_host`, `conflicting_initialized_host`, `unknown_readonly`, `terminal_override_no_owner` and `initialize_before_scan`: assert unknown with only binaries; contradiction yields `conflict !== null` and `session === null`; `--host codex` without actual host evidence has `host === "codex"` and `session === null`; contradictory evidence cannot be overridden. An initialized Codex client with validated UUID routes to Codex; two differing Codex IDs conflict. Unknown/conflicting servers still list tools, read status and collect an existing result without owner changes or sends.

```ts
expect(resolveHost({ env: {} })).toEqual({ host: "unknown", session: null, conflict: null });
expect(resolveHost({ env: {}, terminalHost: "codex" })).toEqual({ host: "codex", session: null, conflict: null });
```
- [ ] Run `rtk proxy bun test test/infra/host-context.test.ts test/entry/mcp-handshake-env.test.ts test/entry/mcp-handshake.test.ts test/integration/mcp-stdio.test.ts`; expect failures for missing resolver and premature scan.
- [ ] **GREEN:** Bind `server.server.oninitialized` and inspect `getClientVersion()?.name` before host-dependent tools, claims, reconcile ownership and notification scan. Recognize actual installed client names established by the task's injected initialize fixtures and plan 20 live acceptance; generic/unknown names alone do not guess. Resolve consistent environment/launcher evidence independently; contradictory recognized evidence yields `host: "unknown"`, `session: null` and actionable conflict. Start startup recovery once initialized; no discovery/smoke await. On close/reinitialization invalidate context and stop the old notifier before replacing it. The doctor handshake supplies no owner identity; terminal override affects setup checks only.
- [ ] Re-run the RED command; expect PASS, including no scan/send/claim before initialized and after conflict. Read callback registration and every Deps construction personally.
- [ ] Commit only this task's files: `rtk git add <the files above>` then `rtk git commit -m "feat(host): resolve orchestration context at initialization"`; inspect `rtk git log -1` after hooks.

### Task 2: Namespace persisted origins, owners and session views

**Files:** Modify `src/services/sessions.ts`, `src/services/run-store.ts`, `src/services/run-service.ts`, `src/services/admission.ts`, `src/services/dispatches.ts`, `src/services/dispatch-service.ts`, `src/services/peek.ts`, `src/services/session-view.ts`, `src/services/runs-page.ts`, `src/entry/tui/views/runs.tsx`; extend `test/services/sessions.test.ts`, `test/services/run-store.test.ts`, `test/services/admission.test.ts`, `test/services/session-view.test.ts`, `test/services/runs-page.test.ts`, `test/services/peek.test.ts`, `test/entry/tui/runs.test.tsx`.

**Interfaces:** `currentSession(deps: Deps): HostSessionRef | null`; `SessionRef` aliases HostSessionRef. Owner is `{host: KnownHost; sessionId: string; since: string}`; SessionRow extends HostSessionRef with `at: string`. New startedBy and dispatch origin carry host beside existing IDs. `ownsRun` / `claimRun` keep existing signatures, compare `sessionKey`. RunSession gains `host: KnownHost`; group keys use `sessionKey` rather than raw ID. Preserve PeekRun.owner for existing clients and add `ownerHost: KnownHost | null`.

- [ ] **RED:** Add `same_id_different_hosts`, `legacy_host_decode`, `cross_host_claim`, `readonly_never_claim`, `clear_refresh`: assert missing host with an ID decodes Claude, no owner stays null; `run_start`, explicit `peek(run)` and `dispatch` journal the new host; status/result/profile writes/second-server initialization do not transfer ownership; dispatch origin survives transfer; identical IDs form two groups; Claude `/clear` uses registry ID and keeps hostSessionId's outer-session meaning.

```ts
expect(sessionKey({ host: "codex", sessionId: "same" })).not.toBe(
  sessionKey({ host: "claude-code", sessionId: "same" }),
);
```
- [ ] Run `rtk proxy bun test test/services/sessions.test.ts test/services/run-store.test.ts test/services/admission.test.ts test/services/session-view.test.ts test/services/runs-page.test.ts test/services/peek.test.ts test/entry/tui/runs.test.tsx`; expect namespace assertions FAIL.
- [ ] **GREEN:** Extend existing loose schemas with legacy host defaulting on decode only. Write explicit host on new rows under existing locks; preserve unknown stored fields and IDs. Use compound keys in every ownership/filter/group path, including peek's no-run filter; use Claude registry only for Claude groups. Keep store versions compatible with optional fields; any incompatible change needs explicit migration and a fixture, never data disposal.
- [ ] Re-run the RED command; expect PASS; coordinator inspects JSON fixtures and grouped TUI identities.
- [ ] Commit task paths with `feat(sessions): namespace run ownership by host` and verify last commit.

### Task 3: Host-dependent omitted defaults and explicit reset

**Files:** Modify `src/domain/profile.ts`, `src/domain/profile-rules.ts`, `src/services/profile-store.ts`, `src/services/profile-service.ts`, `src/services/agent-links.ts`, `src/services/backends.ts`, `src/services/routing-service.ts`, `src/entry/profile-command.ts`, `src/entry/mcp/setup-tools.ts`, `src/entry/tui/state.ts`, `src/entry/tui/effects.ts`, `src/entry/tui/fixtures.ts`, `src/entry/tui/views/profiles.tsx`, `src/entry/tui/views/save-dialog.tsx`; extend `test/domain/profile.test.ts`, `test/domain/profile-rules.test.ts`, `test/services/profile-service.test.ts`, `test/services/routing-service.test.ts`, `test/services/failover-cancel.test.ts`, `test/entry/profile-command.test.ts`, `test/entry/mcp-profile.test.ts`, `test/entry/tui/state.test.ts`, `test/entry/tui/profiles.test.tsx`, `test/entry/tui/effects.test.ts`.

**Interfaces:** `resolveProfile(doc: ProfileDoc, name: string, host: OrchestrationHost): Profile`; `getProfile(name: string, host: OrchestrationHost): Profile`; `profileFor(repo: string|null, host: OrchestrationHost): Profile`; `validateNamed(name: string|undefined, repo: string|null, host: OrchestrationHost): Validation`. Add required host to write options/final arguments of existing profile writers while preserving current arguments/expect checks. `hostDefaultsDoc(doc: ProfileDoc): ProfileDoc` removes ONLY architect/verifier rungs/defaultRung; `resetHostDefaults(name: string, host: OrchestrationHost, opts: {preview:true;expect?:ProfileDoc}|{preview:false;expect:ProfileDoc}): Saved & {expect:ProfileDoc}`. Preview returns effective diff and the original document in `expect`, without write; save compares that document under the existing lock before validating/writing. No new persistence writer or preview store.

- [ ] **RED:** Pin architect/verifier arrays to exact SOL high/low or existing Claude high/low; assert defaultProfileDoc omits only their `rungs`/`defaultRung`. Assert explicit ladder order and no unrelated inherited defaultRung; all other BUILTIN_ROLES unchanged. `legacy_bytes_and_native_rejection` reads identical bytes before/after Codex reads, rejects selected `claude:` role/failover with exact `claude-code:<same model>#<same effort>` suggestion, accepts explicit headless roles. `narrow_reset_and_stale_preview` checks only four fields disappear, unrelated and future fields survive, disk change rejects save. `tui_host_preview_save` pins effective preview/dirty count/save to one host, including unknown failure with no Claude fallback.

```ts
const p = resolveProfile(defaultProfileDoc("default"), "default", "codex");
expect(p.roles.architect.rungs).toEqual(["codex:gpt-6.1-sol#high"]);
expect(p.roles.verifier.rungs).toEqual(["codex:gpt-6.1-sol#low"]);
```
- [ ] Run `rtk proxy bun test test/domain/profile.test.ts test/domain/profile-rules.test.ts test/services/profile-service.test.ts test/services/routing-service.test.ts test/services/failover-cancel.test.ts test/entry/profile-command.test.ts test/entry/mcp-profile.test.ts test/entry/tui/state.test.ts test/entry/tui/profiles.test.tsx test/entry/tui/effects.test.ts`; expect FAIL for missing host argument/default values.
- [ ] **GREEN:** Thread explicit host through every resolveProfile caller discovered by graph/source, including TUI dirtyCount/isStaged/save preview/fixtures. Unknown omitted enabled architect/verifier defaults raise actionable host-required validation; status/result/list/raw document reads remain available. Add `profile show --raw` using existing readProfileDoc for unknown-context inspection. Add `profile reset-host-defaults [name] --host codex|claude-code --preview --json`; its JSON includes `expect`. Saving requires `--expect <reviewed-preview-json-file>` without `--preview`; validate file shape, pass its `expect` to the service, and refuse missing/stale expectations without writes. Do not invoke reset automatically. Validate native-Claude compatibility at routing and selected failover execution as well as profile validation; raw inspection remains available. Do not convert backend IDs. Existing explicit native agent accounting remains unchanged.
- [ ] Inspect native Codex catalog via existing catalog discovery/listModels/validation before accepting defaults; assert exact `gpt-6.1-sol` is available or report the actual catalog spelling for an explicit owner decision. Existing treat-like aliases retain their scoring semantics; no alias becomes a silent execution-model replacement. Re-run RED command; expect PASS after any owner-resolved mismatch is recorded.
- [ ] Commit with `feat(profiles): resolve omitted roles from orchestration host`; coordinator reads all default/explicit/reset diffs.

### Task 4: Selected-profile setup, doctor and subprocess boundary

**Files:** Modify `src/cli.ts`, `src/entry/tui/run.tsx`, `src/services/setup.ts`, `src/services/doctor.ts`, `src/services/doctor-backends.ts`, `src/services/doctor-checks.ts`, `src/services/doctor-access.ts`, `src/services/profile-service.ts`, `src/services/agent-links.ts`, `src/entry/init-command.ts`, `src/entry/doctor-command.ts`, `src/entry/mcp/handshake.ts`, `src/infra/env.ts`; audit existing callers in `src/adapters/cli.ts`, `src/infra/git.ts`, `src/infra/proc.ts`, `src/infra/launch.ts`, `src/services/global-install.ts`, `src/services/preflight.ts`, `src/services/capture.ts`, `src/entry/supervise-command.ts`, `src/entry/lock-command.ts`, `src/adapters/backend.ts`. Extend `test/entry/cli.test.ts`, `test/services/setup.test.ts`, `test/services/doctor.test.ts`, `test/services/profile-service.test.ts`, `test/entry/init-command.test.ts`, `test/entry/doctor-command.test.ts`, `test/infra/env.test.ts`, `test/infra/launch.test.ts`, `test/infra/supervisor.test.ts`, `test/entry/mcp-handshake-env.test.ts`.

**Interfaces:** `initSetup(o: {profile?: string; overwrite?: boolean; now?: Date; host: HostContext}): Promise<InitResult>`; DoctorDeps gains `host: HostContext`, `repo: string|null`. `usedBackends(profiles: Profile[]): Map<string,"role"|"failover">` keeps signature but includes failover only for reachable enabled selected rungs. `scrubSecrets`, `workerEnv`, `checkEnv`, `handshakeEnv` keep signatures. Expose `--host codex|claude-code|auto` on init, doctor, profile commands, lock and the default TUI launch; route the parsed value through `resolveHost({env,terminalHost})` before effective profile resolution. Auto uses actual evidence or remains unknown; explicit host without a session never invents ownership. Unknown raw profile/status/result reads need no override.

- [ ] **RED:** `codex_ready_other_profile_broken` binds current repo to Codex-only profile with unrelated broken Claude links; asserts selected readiness true, diagnostic-only other-profile rows, no `.claude` file creation/change/pruning. Native Claude host requires plugin; selected enabled headless role requires Claude CLI/login; failover-only deficiency warns; disabled/unreachable Claude choices do not block. `scrub_every_boundary` asserts CODEX_THREAD_ID, CODEX_SESSION_ID, CATHERD_ORCHESTRATION_HOST and existing Claude identity/token absent in worker/supervisor/check/doctor spawned env; HOME/CODEX_HOME/vendor configuration/credentials survive non-check children, while checkEnv stays strict. Overrides cannot reinsert host identity into workerEnv. Add a CLI case asserting bare `catherd --host codex` reaches TUI startup rather than being mistaken for a subcommand; inherited `--host` reaches profile preview/lock and an invalid value is a usage error.

```ts
const clean = scrubSecrets({ CODEX_THREAD_ID: "parent", CODEX_SESSION_ID: "parent", CODEX_HOME: "/native" });
expect(clean.CODEX_THREAD_ID).toBeUndefined();
expect(clean.CODEX_SESSION_ID).toBeUndefined();
expect(clean.CODEX_HOME).toBe("/native");
```
- [ ] Run `rtk proxy bun test test/entry/cli.test.ts test/services/setup.test.ts test/services/doctor.test.ts test/services/profile-service.test.ts test/entry/init-command.test.ts test/entry/doctor-command.test.ts test/infra/env.test.ts test/infra/launch.test.ts test/infra/supervisor.test.ts test/entry/mcp-handshake-env.test.ts`; expect FAIL on unconditional linking/plugin checks and leaked identities.
- [ ] **GREEN:** Parse root TUI command presence using citty command/argument metadata, rather than the current rawArgs.every(startsWith("-")) guard that rejects a flag value such as codex. Compute dependency severity from selected repo profile and relevant failover; keep other linked diagnostics outside readiness. ProfileService plans/applies Claude links only for deliberately used native-Claude roles; Codex-only operations skip agent filesystem work entirely. Preserve managed-link collision/pruning/rollback rules for deliberate Claude-dependent writes. Extend existing scrub set, scrub merged worker overrides, and patch only execution boundaries missing the shared helper. Host override selects terminal setup with null session, never an owner. Preserve CODEX_HOME and all vendor native configuration; no provider auto-install.
- [ ] Re-run RED command; expect PASS. Coordinator reads all subprocess env construction and personally runs local typecheck/lint and changed tests after the combined wave; no CI checks.
- [ ] Commit with `feat(setup): scope dependencies and child identity to host` and verify last commit. Record source-derived limitations in `docs/handoff/plan18-ledger.md` during execution; do not mark release-ready.

## Parallelism and handoff

Wave 1: one worker owns Task 1. Wave 2: one worker owns Task 2. Wave 3: one worker owns Task 3. Wave 4: one worker owns Task 4, because profile writer/setup overlap. Bundle these by locality if context permits; do not parallelize shared profile/ports files. Coordinator runs changed tests and reads combined diffs personally, serializes heavy commands, retains configured Codex model at low/medium effort, and hands the unreleased feature head plus exact host contracts to plan 19. No delegated verifier and no plan execution before owner review.
