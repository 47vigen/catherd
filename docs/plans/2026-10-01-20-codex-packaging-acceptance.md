# Codex packaging and live acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the same catherd core and portable skills through native Codex and existing Claude plugins, with release held for actual packaged live acceptance.

**Architecture:** Add the native Codex manifest beside the Claude manifest inside the existing shipped `plugin/` directory. Reuse its versioned launcher, shared skills, pack smoke and release stamping; packaging never implements a second orchestrator or completion transport.

**Tech Stack:** Bun ≥ 1.4, TypeScript/Bun tests, shell launcher, native Codex plugin schema, Changesets and existing local gate.

**Spec:** `docs/specs/2026-10-01-catherd-codex-entry-design.md`; `docs/research/2026-10-01-codex-messaging.md`; depends on `docs/plans/2026-10-01-18-host-context-profiles.md` and `docs/plans/2026-10-01-19-codex-completion-delivery.md` on their combined feature head.

## Global Constraints

- **Source-validated only, not built.** Owner reviews all three plans before any implementation, installation, execution or scratch build. Execute 18 → 19 → 20 on the dependent feature head.
- Preserve `domain → infra → adapters → services → entry`, ProfileService single-writer, existing Claude manifest/macros, locked atomic stores, detached supervision and reviewer/verifier landing gate.
- Exact omitted Codex defaults are `codex:gpt-6.1-sol#high` and `codex:gpt-6.1-sol#low`. A catalog spelling mismatch needs explicit resolution; never silently normalize or substitute.
- Native packaging must prove MCP path expansion in the actual native schema/runtime. Hook `PLUGIN_ROOT` expansion and Claude compatibility alone are insufficient evidence.
- Preserve HOME, CODEX_HOME, vendor configuration and credentials; scrub parent host/session identity at subprocess boundaries. Codex-only operations write nothing under `~/.claude`.
- No provider auto-install, hosted MCP server, public plugin submission, private IPC fallback, second app-server, competing rollout writer, direct SQLite writes or model polling.
- No CI jobs, workflow rewrites, CI check requests, pushes, beta publication, release merge or manual version stamping. Inspect existing workflow triggers before any later push; honor the owner's no-CI policy.
- One eventual feature release: add one `catherd-cli` minor Changeset for plans 18–20; existing release tooling chooses the version and stamps both integrations. Hold publication until owner accepts packaged evidence.
- Configured native Codex implementation model stays unchanged at low/medium effort; at most three workers plus coordinator, coordinator verifies personally, no delegated verifier. English artifacts; serialize heavy commands on the 18 GB host.

## Review Focus

1. Native plugin installed under a path containing spaces: MCP argument root expansion reaches its own launcher — Task 1 `native_root_with_spaces`.
2. Global CLI differs from packaged plugin: the launcher starts the pinned core and both manifests match — Task 1 `shared_version_pin`.
3. Shared skill runs from Codex with explicit native-Claude role: clear rejection and unchanged profile, never a fabricated native agent — Task 2 `portable_role_protocol`.
4. Receipt arrives but host is interrupted/unloaded: unread result survives and receipt never becomes processing/collection evidence — Task 3 `retained_queue_input`.
5. Ownership moves between hosts while completion is submitted: origin survives and old receipt cannot suppress the new owner's event — Task 3 `packaged_owner_transition`.

---

## Source preflight

Graph-first discovery used the existing `Users-vigen-agora-lab-catherd` index. `package.json.files` already ships `plugin/`; `test/pack-smoke.ts` inventories the Claude manifest/MCP config/shared launcher and installs the tarball. `scripts/stamp-plugin-version.mjs` stamps the launcher, skill, Claude manifest and marketplace release tag. Extend these existing boundaries.

The installed native Superpowers manifest at `~/.codex/plugins/cache/openai-curated-remote/superpowers/6.4.2/.codex-plugin/plugin.json` supplies `skills: "./skills/"`. Installed catherd currently supplies only `.claude-plugin` and `.mcp.json`. [Official native plugin documentation](https://developers.openai.com/plugins/build/plugins) supports `.codex-plugin/plugin.json` and an MCP declaration; Task 1 must validate the exact installed MCP declaration and expansion contract before choosing its launch args. No portable metadata schema is needed.

### Task 1: Supported native manifest and shared versioned launcher

**Files:** Create `plugin/.codex-plugin/plugin.json`, `plugin/.mcp-codex.json`, `test/entry/plugin-packaging.test.ts`; modify `test/pack-smoke.ts`, `scripts/stamp-plugin-version.mjs`. Keep `plugin/.claude-plugin/plugin.json`, `plugin/.mcp.json` and `plugin/bin/catherd-mcp` semantics unchanged unless the proven native contract requires a narrowly documented launcher change.

**Interfaces:** Consumes plan 18 `CATHERD_ORCHESTRATION_HOST=codex` launcher discriminator, never a synthetic session ID. Produces native manifest `skills: "./skills/"`, `mcpServers: "./.mcp-codex.json"` only when the installed schema supports that path declaration, and MCP server key `catherd` launching the same `bin/catherd-mcp`; exact root token comes from the evidence gate below. Package version remains the sole version source.

- [ ] **Pre-edit evidence gate:** Inspect the actual installed native manifest schema/runtime and official source/docs for MCP `command`/`args` expansion, plugin-root resolution and `env`; record source/version and exact supported token in `docs/handoff/plan20-ledger.md`. Validate a path with spaces without shell interpolation. Do not infer MCP expansion from hooks. If the native contract cannot launch this integration, stop this packaging task and present the owner the documented CLI plus native MCP configuration alternative; only their explicit choice authorizes that fallback.
- [ ] **RED:** Add static manifest/stamping assertions and a native-runtime launcher case `native_root_with_spaces`. Capture installed runtime output showing the resolved launcher path, validated host and initialize/tools-list success; a literal unresolved token fails. `shared_version_pin` checks the existing global-version mismatch fallback against a fake CLI, with no registry/network request. Assertion core:

```ts
expect(native.skills).toBe("./skills/");
expect(native.mcpServers).toBe("./.mcp-codex.json");
expect(native.version).toBe(pkg.version);
expect(claude.version).toBe(pkg.version);
expect(launcher).toContain(`VERSION="${pkg.version}"`);
expect(codexMcp.mcpServers.catherd.env.CATHERD_ORCHESTRATION_HOST).toBe("codex");
expect(codexMcp.mcpServers.catherd.env.CODEX_THREAD_ID).toBeUndefined();
expect(resolvedLauncher).toBe(join(installedPluginRoot, "bin/catherd-mcp"));
expect(handshake.tools.some((t: { name: string }) => t.name === "status")).toBe(true);
```

- [ ] Run `rtk proxy bun test test/entry/plugin-packaging.test.ts`; expect FAIL because native package files/stamping are absent. The runtime case is opt-in to actual native installation; never label a skipped runtime case proof of root expansion.
- [ ] **GREEN:** Add only proven supported native fields, separate Codex MCP config and discriminator; preserve Claude's `${CLAUDE_PLUGIN_ROOT}` config. Extend the existing stamp script for the new manifest and pack smoke inventory for both manifests/configs and both shared skills. No new dependency or invented launcher macro. Pack smoke uses explicit host selection and scrubbed identities for no-send doctor; no native configuration/login required for its offline handshake.
- [ ] Re-run the RED command; expect PASS. After implementation is authorized, run `rtk proxy bun test/pack-smoke.ts` locally and record installed version/handshake success. Coordinator personally checks tarball contents and actual native launcher resolution, including spaces.
- [ ] Commit task files with `feat(plugin): package native Codex integration`; verify the last commit. Do not run release stamping against the real feature tree or publish.

### Task 2: Portable shared skill and setup guidance

**Files:** Modify `plugin/skills/catherd/SKILL.md`, `plugin/skills/catherd-setup/SKILL.md`, `README.md`, `CONTRIBUTING.md`, `docs/dev/live-verification.md`.

**Interfaces:** Consumes plans 18/19 effective host/defaults, `route`, `dispatch`, `result`, `record_agent_run`, `doctor --host codex|claude-code|auto` and explicit `doctor --test-push`. Produces one shared protocol: native Claude `Agent` only for `backend:"claude"` on a Claude host; process roles on either host through existing dispatch; pushed notice followed by durable result collection.

- [ ] **Review current mismatch:** Read both shared skills and installation guidance end to end. Record the current unconditional Claude-native role instructions and compare them against plans 18/19's host/default/queue contracts. This task changes documentation only; no substring tests that merely mirror the copy are added.
- [ ] **Update portable protocol:** Correct the existing role table, host/session assumptions, deferred-tool naming guidance and restart/version text. Document Codex dispatch/headless architect/verifier and retained Claude native accounting; preserve role disabling, explicit rungs, isolation choices and landing gate. State explicitly that native Claude agents require a Claude Code host, Codex architect/verifier use dispatch/result, receipts do not collect results, and only omitted architect/verifier choices follow the host. Include owner-selected default strings, catalog mismatch resolution and reviewed reset of only two role override fields. Never instruct `await_results` as completion, fabricate native Codex agents or silently convert `claude:` to `claude-code:`.
- [ ] Document the verified native install path, prerequisite checks and actual live cases in Task 3; default doctor sends nothing. Explain accepted/ambiguous/collected, ordered busy follow-up, unloaded/interrupted limits, `peek`/`result` recovery and explicit duplicate-risk retry. Keep manual MCP installation conditional on the Task 1 owner decision. Retain existing release tooling and add the feature's owner acceptance hold; no hosted-server or public submission instructions.
- [ ] **Verify documentation:** Coordinator personally reads both skills end to end against the spec and checks every install command against Task 1 runtime evidence. Confirm host role tables match the effective profiles tested in plan 18 and that completion/retry instructions match plan 19. The actual installed skill flow is exercised in Task 3, not inferred from matching text.
- [ ] Commit with `docs(plugin): make orchestration and setup host-aware`; verify the last commit.

### Task 3: Actual packaged acceptance and one held release

**Files:** Create `.changeset/codex-entry.md`, `docs/dev/reports/2026-10-01-codex-entry-acceptance.md`, `docs/handoff/plan20-ledger.md`; modify `docs/dev/live-verification.md`, `docs/handoff/HANDOFF.md`. Extend `test/entry/plugin-packaging.test.ts` only if packaged testing exposes a missing regression assertion; fix implementation defects in the owning plan's files with their RED/GREEN check.

**Interfaces:** Consumes the installed tarball/plugin from Task 1, shared protocol from Task 2 and plan 19 DeliveryState/receipt/current-owner contracts. Produces an evidence report keyed by package version, native host version, real host/session, run/dispatch/event IDs, receipt ID, native user-input/continuation evidence and separate collection/verifier evidence; exclude credentials and messaging tokens.

- [ ] **RED:** Write the report with every case below `unverified`; no research smoke or simulator result can mark a case passed. Use this assertion core when checking a captured packaged run; `before` is observed before explicit `result`, `after` after it:

```ts
expect(before.delivery).toBe("enqueue-accepted");
expect(before.receipt.target).toEqual(originalOwner);
expect(before.unread).toBe(true);
expect(nativeInput.eventIds).toContain(eventId);
expect(nativeContinuation.threadId).toBe(originalOwner.sessionId);
expect(after.collected).toBe(true);
expect(landingWithoutVerifier.code).toBe("E_LAND_GATE");
expect(codexOnlyClaudeWrites).toEqual([]);
```

- [ ] **GREEN, local gate:** After execution authorization, verify Bun ≥ 1.4 and run serially: `rtk proxy bun install --frozen-lockfile`, `rtk proxy bun run typecheck`, `rtk proxy bun run lint`, `rtk proxy bun run format:check`, `rtk proxy bun test`, then `rtk proxy bun test/pack-smoke.ts`. Expect exit 0 throughout; no older-Bun lock rewrite, no CI check. Coordinator reads combined 18–20 diffs and durable delivery artifacts personally.
- [ ] Install the actual packaged integration through Task 1's supported path in owner-authorized acceptance repositories/conversations, preserving real native HOME/CODEX_HOME/configuration/login. In both native CLI and Desktop, run a Codex-only profile without Claude availability: initialize, verify exact architect/verifier high/low routing, dispatch a real role, observe original idle conversation wake, then collect the record. Hash/inventory `~/.claude` before/after setup/profile/MCP activity: no creates, edits or pruning. Unrelated broken Claude profiles do not block selected readiness.
- [ ] Repeat each Codex surface while demonstrably busy. Use an explicit tool/worker barrier and native active-state evidence before the role completes; receipt arrives during the barrier and native input/assistant continuation follows the active turn in order after release. No wall-clock sleep establishes busy state. Record native user-input processing, not echoed command/tool/assistant markers; receipt alone leaves the case unverified. Keep verifier gate refusal before a real verdict and successful collection separate.
- [ ] Run packaged explicit `claude-code:` roles from Codex with their unchanged model/effort; test missing CLI/login diagnostics. Explicit native `claude:` and native-Claude failover from Codex reject without profile rewrite and name exact headless equivalent/reset. Unknown/conflicting evidence neither claims nor sends; terminal `--host codex` configures setup without inventing a session. Perform legacy Claude regression: existing plugin/launcher, native defaults/agent accounting, peer inbox priorities, collection and registry target after `/clear`.
- [ ] Run `packaged_owner_transition`: continue one real run using existing run_start/peek/dispatch transitions across hosts, preserving origin/journal; change owner during a barrier-held send and prove old receipt does not suppress the new owner's event. Exercise concurrent MCP claims/coalescing and duplicate input: every event ID retained, no extra role dispatch or landing. Check startup/restart/unloaded/interrupted `retained_queue_input`: unread survives, accepted/ambiguous events are not blindly resent and status never claims processing without native evidence.
- [ ] Exercise queue unavailable, explicit refusal, timeout/missing receipt and ambiguous restart through packaged entry with controlled native capability/failure fixtures. Durable results remain accessible through peek/result; no competing server or polling fallback starts. Ordinary doctor sends no marker; explicit smoke separates acceptance from processing and a terminal reports no session. Record all cases as passed/failed/unverified with evidence; any failure or unverified required case retains the release hold.
- [ ] Add `.changeset/codex-entry.md` with frontmatter `"catherd-cli": minor` and the combined feature summary. Verify both manifests/launcher still match current package version; leave automatic next-version selection/stamping to existing Changesets release flow. Update HANDOFF with the dependent head, evidence paths, limitations and **release held for owner packaged acceptance**. Commit with `test(plugin): record packaged acceptance and hold feature release`; verify last commit. No push, beta or release merge is authorized here.

## Parallelism and handoff

Wave 1: one worker owns Task 1 after its native evidence gate. Wave 2: one worker owns Task 2, which depends on supported installation commands. Wave 3: coordinator owns Task 3's actual installed live acceptance and final verification; no verifier subagent. Keep one task in progress, bundle by locality, serialize heavy commands and never execute before owner plan review. Plans 18/19 remain unreleased prerequisites; HANDOFF records one held feature release and the owner's final acceptance decision.
