# catherd 1.6, plan 32: knowledge, lanes and the digest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the repo's knowledge becomes standing rules that reach each role's brief by role tag, and the architect can propose retiring them after a run; a finished research lane's answer reaches the lanes that wait for it; preflight lints the plan's shape; and each milestone digest carries the known issues word for word, the review rounds with what they fixed, and the gate's own record.

**Architecture:** Tag parsing and the plan lint are pure domain code (`src/domain/rules.ts`, `src/domain/plan-lint.ts`, both new). `knowledge.md` stays the one per-repo store, now with two locked writers (append and remove) in `src/services/run-store.ts`. Rules and research answers enter the brief through plan 28's `context` section, filled in `src/services/admission.ts`; research answers come from a new `src/services/lane-context.ts`. The digest stays in `src/services/protocol.ts` `writeDigest`.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, citty, `@modelcontextprotocol/sdk`. No new dependency.

**Spec:** `docs/specs/2026-10-12-catherd-1.6-design.md`, "Plan 32: knowledge, lanes and the digest", "Owner rulings needed" (2) and "Not in 1.6". t3herd sources (read-only, `/Users/vigen/agora/lab/t3herd`): `src/brief.ts:27-38` `rulesFor` and commit d33dce4 (the skill's constraints review); `src/step.ts:178-183` `answer`/`top` and `:349-359`, commit 5b9090e; `src/step.ts:927-982` `mrBody`, commit 7eec821; `src/plan.ts:122-205` `lintPlan`/`lintMilestones`.

**Pre-validation:** spiked `rulesFor`'s tag regex and `lintLanes` (cycles, research exclusion, critical path) against the worktree's `parseLaneHeader`/`headerBlock` in `.superpowers/plan32-spike/`, targeted tests only; the full gate runs at execution.

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`): `rules.ts` and `plan-lint.ts` are domain and import only domain; `lane-context.ts` is a service.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`. Tests that could reach the network delete `ANTHROPIC_API_KEY` (in-process) or pass `ANTHROPIC_API_KEY: ""` (spawned). No wall-clock sleep for correctness.
- Commits: conventional, subject ≤ 100 characters, lower-case first word after the scope; check `git log` after each commit.
- Every knowledge.md write holds `withFileLock(<knowledge.md>)` (`src/infra/filelock.ts:96`); the lock is not reentrant, so `knowledgeFor` (which takes it while migrating) is called before, never inside, the locked section.
- Nothing this plan adds may make `land` or `preflight` throw: a digest part or a lint that cannot read its input says so in its line and moves on.
- Line numbers below are at `2061e6e`; plans 28–31 land first and move them. Find each anchor by its name.

## Review Focus

1. **A knowledge line with brackets that are not a tag** (`- … by hand: [x] done`, `use arr[i]`). Expected: it reaches every role unchanged; `catherd knowledge add "[x] done"` is refused, naming the roles. Pinned in Task 1, "leaves a bracket group that names no role as text for every role" and the CLI test.
2. **A repo with no knowledge.md, or one with only another role's rules.** Expected: the brief has no standing-rules block at all, never the "no knowledge recorded yet" sentence. Pinned in Task 2, "adds no rules block when the role has none".
3. **A research lane whose reply is gone, was blocked, or that was climbed and re-run.** Expected: only its latest ok, not blocked or refused, reply is pasted; a missing reply file adds nothing and admission still succeeds. Pinned in Task 2, "pastes only the latest ok research reply, and nothing when its file is gone".
4. **A lane file preflight cannot parse into a sane graph** (an `After:` to itself, to no file, a cycle; a research lane that owns nothing). Expected: lint names it and never throws; research lanes never get "shares no file" or "only points elsewhere". Pinned in Task 3, "names an After: that cannot finish" and "leaves research lanes out of the file and body checks".
5. **A milestone reviewed and verified only by native subagents, or landed before plan 29's gate record.** Expected: the digest says `Rounds: 1 review round(s)`, `Known issues: none` and `Gate: not recorded`; `land` succeeds. Pinned in Task 4, "lands a natively reviewed milestone with no known issues", and Task 5, "says not recorded without a gate run".

## Rulings

Items dropped as already in 1.5:

1. Ruling: lane `After:` ordering is not re-planned — 1.5 plan 25 Task 8 (commit 0d356a6) parses `After:` (`src/domain/lane.ts:14-15, 90`), holds the lane in `protocolNext` (`src/services/protocol.ts:105-166`) and refuses it with `E_ADMIT_ORDER` (`src/services/admission.ts:223-229`) — none; only the research-answer half is planned (Task 2).
2. Ruling: the digest's commits, the review's BLOCKER and BUG lines and the open owner questions are not re-planned — 1.5 plan 25 Task 13 (0d356a6, `writeDigest` `src/services/protocol.ts:223-306`) — none; this plan adds NITs, rounds and the gate line.

Decisions:

3. Ruling: catherd's standing rules are the lines of the repo's `knowledge.md` (keyed by git origin since 1.5); there is no second constraints file — one per-repo store, already read by every run — every knowledge line now costs tokens in every brief of its roles; the rules review (ruling 8) is the pressure valve.
4. Ruling: a tag is `[role, role]` right after `- <date> <source>: `, or at the start of a hand-edited line; a bracket group with any name outside `ROLES` (`src/domain/roles.ts`) is not a tag and the line reaches every role; `catherd knowledge add` refuses such a group. There is no `fixer` tag: catherd's fix rounds run as `worker` — t3herd's d33dce4 semantics, made safe for prose brackets — a typo'd tag in a hand-edited file reaches everyone instead of no one.
5. Ruling: the role server's `read_knowledge` (`src/entry/mcp/role-server.ts:52-62`) stays unfiltered, since the dossier researcher and architect plan from all of it; the main server's `read_knowledge` takes an optional `role` for a native brief — smallest change — none.
6. Ruling: retiring a rule is `catherd knowledge rm "<text>"`, matching exactly one line by substring; `appendKnowledge` stops being the single writer, and both writers take the file lock — the review needs removals, and a line number shifts under a concurrent `land` — a substring that matches two lines is refused, not guessed.
7. Ruling: a research answer is the reply of a headless dispatch whose `lane` is the research lane (record `status: ok`, `replyStatus` not `blocked`/`refused`, latest by `endedAt`), its closing `STATUS:` line cut, its first 4000 characters kept; a native researcher's reply is not kept by catherd, so the skill tells the orchestrator to put its reply path in the dependant's brief — t3herd 5b9090e — a native research answer depends on the orchestrator.
8. Ruling: the after-run rules review is skill text only (an architect dispatched read-only with the report and `catherd knowledge show`, at most five changes, each approved by the user, applied with `catherd knowledge add`/`rm`) — t3herd d33dce4 is skill text too — none.
9. Ruling: plan lint goes in a new `lint: string[]` on both preflight report shapes, beside plan 23's `warnings`, and never sets `blocked` — keeps the lint-step warning (and its test, `test/services/preflight.test.ts:276-287`) apart — an orchestrator that reads only `warnings` misses lint until the skill says so (Task 6).
10. Ruling: lint is lane-level only. "Milestones that can run together but share files", milestone `After:` without a shared file and the milestone critical path go to plan 33, since 1.5 runs milestones one at a time and has no milestone `After:`; this plan's critical path is the longest lane `After:` chain within a milestone, as an `info:` line — spec "Not in 1.6" leaves parallel milestones to plan 33 — none.
11. Ruling: "more than 5 lanes" is not linted — owner ruling 2's default keeps the architect's "more small lanes beat one long one"; a lint against it would contradict the architect — if the owner rules yes, it is one more line in `lintLanes`.
12. Ruling: lint also names an `After:` that names its own lane, a lane with no file, or a cycle; this is the "name them in a status warning" fix of `docs/dev/ideas.md` "A bad `After:` blocks a lane forever", which Task 6 removes; nothing is refused — none.
13. Ruling: research lanes are exempt from "shares no file" and "only points elsewhere": their output is the answer, and their body is the question — none.
14. Ruling: known issues are the NIT lines, word for word (a leading bullet or number stripped, duplicates dropped), of the milestone's latest full headless reviewer, its latest `ui-reviewer` record that names it, and its latest headless `verifier-<M>` record; native replies are not kept, the same limit as `Findings:` — t3herd `mrBody` — a native-only milestone lists none.
15. Ruling: review rounds are the milestone's full reviewer attempts since its lanes started (dispatch and native, `reviewerAttempts`); "fixed" is the BLOCKER and BUG lines of every earlier headless attempt that the latest one does not repeat, at most 15 — t3herd `mrBody` — none.
16. Ruling: catherd builds no MR body before plan 33; the writer's MR-body brief copies each digest's `Known issues` block verbatim (skill), and `knownIssues` is exported for plan 33 — none.

Owner questions: none beyond the spec's ruling 2 (ruling 11).

## Cross-plan interfaces

- **X1, from plan 28 (consumed by Task 2), checked against `docs/plans/2026-10-12-28-role-briefs.md`.** Plan 28 adds `BriefContext.context: string | null` to `src/domain/brief.ts` (its Task 3), rendered as the `<context>` section between `<team>` and `<task>`, and admission passes `context: null` (its Ruling 10: "filled by nobody in this plan … standing rules scoped to roles are plan 32's"). Plan 32 replaces that `null` in `src/services/admission.ts` with the non-empty blocks joined by a blank line, or `null` when there are none: first `rulesBlock(await standingRules(run.meta.repo, i.role), i.role)` (Task 1), then, for a lane dispatch, each of `researchAnswers(run, i.lane)` (Task 2). Native Claude roles do not get admission's brief (plan 28 Ruling 12), so they get the rules through `read_knowledge(repo, role)` in the skill (Task 6).
- **X2, from plan 28 (consumed by Task 4).** Plan 28's verifier text: "A problem you would call minor or non-blocking is a NIT line, never a FAIL." Task 4 reads those lines from a headless verifier reply. Plan 28 Task 4 also adds `MilestoneVerifier.record`; Task 4 may read the verifier's reply through it instead of scanning `readRecords`.
- **X3, from plan 29 (consumed by Task 5).** Plan 29's `src/services/milestone-check.ts` exports `readChecks(toplevel: string): CheckRecord[]` with `CheckRecord = { run, milestone, command, head, exit, durationMs, fails, log, baseline?, rerunOf?, secrets? }` (`secrets`: `clean` | `found` | `skipped: <why>`). The gate line reads this run's latest non-baseline record of the milestone: `readChecks(toplevel).filter(r => r.run === run.id && r.milestone === m && !r.baseline).at(-1) ?? null`.
- **X4, to plan 33.** `knownIssues(run, m)` (Task 4) for an MR body; milestone-level lint (ruling 10) extends `lintLanes` or adds a sibling in `src/domain/plan-lint.ts`.

## Spec coverage

| Spec bullet (plan 32) | Task |
| --- | --- |
| Standing rules scoped to roles; every brief gets its role's rules | 1, 2 |
| After a run the architect proposes up to five rules to add or retire; the user approves each | 1 (`rm`), 6 (skill) |
| Lane `After:` ordering | ruling 1 (1.5) |
| A finished research lane's answer in its dependants' briefs | 2 |
| Known issues word for word in the digest and the MR body | 4, 6 |
| Digest: gate exit code, duration, secret scan; rounds fixed | 5, 4 |
| Plan lint as preflight warnings | 3 (lane level), plan 33 (milestone level, ruling 10) |

## Parallelism

| Wave | Tasks | Files |
| --- | --- | --- |
| 1 | 1 ∥ 3 ∥ 4 | 1: `src/domain/rules.ts` (new), `src/services/run-store.ts`, `src/services/run-service.ts`, `src/entry/knowledge-command.ts`, `src/entry/mcp/run-tools.ts`, `test/domain/rules.test.ts` (new), `test/entry/knowledge-command.test.ts` · 3: `src/domain/plan-lint.ts` (new), `src/services/preflight.ts`, `test/domain/plan-lint.test.ts` (new), `test/services/preflight.test.ts` · 4: `src/services/milestones.ts`, `src/services/protocol.ts`, `test/services/protocol.test.ts` |
| 2 | 2 ∥ 5 | 2: `src/services/lane-context.ts` (new), `src/services/admission.ts`, `test/services/admission.test.ts` · 5: `src/services/protocol.ts`, `test/services/protocol.test.ts` |
| 3 | 6 | `plugin/skills/catherd/SKILL.md`, `src/entry/mcp/lane-tools.ts`, `README.md`, `docs/dev/ideas.md`, `.changeset/knowledge-lanes-digest.md` (new) |

Files other 1.6 plans also touch: `src/services/admission.ts` (28: the `composeBrief` call this plan's Task 2 edits), `src/services/protocol.ts` and `src/services/milestones.ts` (28 exports `laneIds` and adds `MilestoneVerifier.record`; 29, 30, 33), `src/services/gate-service.ts` (29), `src/services/preflight.ts` (30's sibling-file check), `src/entry/mcp/lane-tools.ts` (29, 33), `src/entry/mcp/run-tools.ts` (28), `plugin/skills/catherd/SKILL.md`, `README.md`, `docs/dev/ideas.md` (all).

---

### Task 1: Role-tagged standing rules, and removing one

**Files:**
- Create: `src/domain/rules.ts`, `test/domain/rules.test.ts`
- Modify: `src/services/run-store.ts:351-363` (`appendKnowledge`), `src/services/run-service.ts:330-359` (`readKnowledge` … `addKnowledge`), `src/entry/knowledge-command.ts:14-37, 118-125`, `src/entry/mcp/run-tools.ts:140-148`
- Test: `test/entry/knowledge-command.test.ts`

**Interfaces:**
- Produces (domain, `src/domain/rules.ts`):
  - `tagNames(line: string): string[] | null` — the names of a tag-shaped leading group (`[a, b]` after `- <date> <source>: `, or at the line's start), whatever they are; null when there is none.
  - `ruleRoles(line: string): Role[] | null` — `tagNames` when every name is in `ROLES`, else null (not a tag).
  - `rulesFor(text: string, role: Role): string` — untagged lines kept, tagged lines kept only for their roles with the tag removed, joined by `\n`, trimmed.
  - `rulesBlock(rules: string, role: Role): string` — `""` for blank `rules`, else `Standing rules for a ${role} in this repo (its knowledge.md):\n${rules}`.
- Produces (services): `standingRules(repo: string, role: Role): Promise<string>` (run-service; `rulesFor` of the file, `""` when missing or blank — never the "no knowledge recorded" sentence); `removeKnowledge(repo: string, match: string): Promise<string>` (run-service; returns the removed line); `removeKnowledgeLine(toplevel: string, match: string): Promise<string>` (run-store, the locked rewrite).
- Produces (entry): `catherd knowledge show --role <role>`, `catherd knowledge rm "<text>"`; MCP `read_knowledge` gains `role?: Role`.

- [ ] **Step 1: Write the failing domain tests** in `test/domain/rules.test.ts`:

```ts
const L = [
  "- 2026-10-12 by hand: always A",
  "- 2026-10-12 shop: M3 x: [worker, reviewer] only B",
  "[verifier] only C",
  "- 2026-10-12 by hand: [x] done list",
  "- 2026-10-12 t M1: use arr[i] here",
];
it("gives a tagged rule only to its roles, without the tag, and an untagged one to every role", () => {
  expect(rulesFor(L.join("\n"), "worker")).toBe([L[0], "- 2026-10-12 shop: M3 x: only B", L[3], L[4]].join("\n"));
  expect(rulesFor(L.join("\n"), "verifier")).toBe([L[0], "only C", L[3], L[4]].join("\n"));
  expect(rulesFor(L.join("\n"), "writer")).toBe([L[0], L[3], L[4]].join("\n"));
});
it("leaves a bracket group that names no role as text for every role", () => {
  expect(tagNames("- 2026-10-12 by hand: [worker, revewer] x")).toEqual(["worker", "revewer"]);
  expect(ruleRoles("- 2026-10-12 by hand: [worker, revewer] x")).toBeNull();
  expect(ruleRoles(L[4])).toBeNull();
  expect(rulesBlock("", "worker")).toBe("");
});
```

- [ ] **Step 2: Run** `bun test test/domain/rules.test.ts` — FAIL (module not found).
- [ ] **Step 3: Implement `src/domain/rules.ts`.** The spiked tag regex: `/^(\s*(?:[-*]\s+)?(?:\d{4}-\d{2}-\d{2}\s+[^\n]*?:\s+)?)\[([a-z-]+(?:\s*,\s*[a-z-]+)*)\]\s*/`; group 1 is kept when the tag is removed.
- [ ] **Step 4: Run** `bun test test/domain/rules.test.ts` — PASS.
- [ ] **Step 5: Write the failing CLI tests** in `test/entry/knowledge-command.test.ts` (its `catherd()` helper):
  - "adds a rule tagged with roles, and shows each role only its rules": `add "[worker, reviewer] run bun test <file>"` exits 0 and prints `- <date> by hand: [worker, reviewer] run bun test <file>`; `show --role worker` prints `- <date> by hand: run bun test <file>`; `show --role verifier` prints `catherd: no knowledge recorded yet for this repo` (an empty filter); `show --role nobody` exits non-zero.
  - "refuses a tag that names something other than a role": `add "[worker, revewer] x"` exits non-zero, stderr contains `"revewer" is not a role`, and the file is unchanged.
  - "removes the one line a text matches, and refuses none or several": two lines added by hand; `rm "zzz"` exits non-zero with `no line of knowledge.md contains "zzz"`; `rm "by hand"` exits non-zero with `2 lines contain "by hand"`; `rm "bun test <file>"` exits 0 and prints the removed line, and `show` no longer has it.
- [ ] **Step 6: Run** `bun test test/entry/knowledge-command.test.ts` — the three new tests FAIL.
- [ ] **Step 7: Implement.**
  - `appendKnowledge`: resolve `knowledgeFor` first, then append inside `withFileLock(file, …)`.
  - `removeKnowledgeLine(toplevel, match)`: `knowledgeFor`, then under the lock read non-blank lines, find those whose text contains `match.trim()`; 0 → `E_INPUT_INVALID` `no line of knowledge.md contains "<match>"` (fix: `catherd knowledge show`); >1 → `E_INPUT_INVALID` `<n> lines contain "<match>": quote more of the one to remove`; else `writeTextAtomic(file, rest + "\n", { mode: PRIVATE_FILE })` (`""` when none is left) and return the line.
  - `addKnowledge`: before appending, `tagNames(text)` names outside `ROLES` → `E_INPUT_INVALID` `"<name>" is not a role: tag a rule with <ROLES joined by ", ">` (fix: `catherd knowledge add "[worker, reviewer] <rule>"`). `land`'s `learned` is not validated (a wrong tag then reaches every role, ruling 4).
  - `standingRules`, `removeKnowledge` (`repoTop`, then `removeKnowledgeLine`).
  - CLI: `show` gains `role: { type: "string" }`; a role outside `ROLES` is `E_INPUT_INVALID`; with a role it prints `standingRules`, or the placeholder sentence when that is `""`. `rm` has a required positional `text`, calls `refuseInRole(process.env, "catherd knowledge rm")`, prints the removed line. The command description names `rm`.
  - MCP `read_knowledge`: `inputSchema: { repo: z.string().min(1), role: z.enum(ROLES).optional() }`; with a role, `standingRules` or the placeholder; the description adds "with role, only the standing rules that reach that role, for a native role's brief".
- [ ] **Step 8: Run** `bun test test/domain/rules.test.ts test/entry/knowledge-command.test.ts test/services/knowledge-origin.test.ts` — PASS; `bun run typecheck && bun run lint`.
- [ ] **Step 9: Commit** `feat(knowledge): role-tagged standing rules, and knowledge rm`.

### Task 2: Standing rules and research answers reach the brief

**Files:**
- Create: `src/services/lane-context.ts`
- Modify: `src/services/admission.ts` (the `composeBrief` call, `:336-349` at 2061e6e, where plan 28 passes `context: null`)
- Test: `test/services/admission.test.ts`

**Interfaces:**
- Consumes: X1 (`BriefContext.context`, plan 28); `standingRules`, `rulesBlock` (Task 1); `readRecords`, `runPaths` (`run-store.ts`); `parseLaneHeader` (`domain/lane.ts`).
- Produces: `researchAnswers(run: Run, lane: string): string[]` in `src/services/lane-context.ts` — one block per `After:` lane whose header says `Kind: research` and that has an answer (ruling 7): `${title ?? id} (research) answered:\n${answer}`, where `answer` is the reply with a trailing `STATUS:` line removed (`/\s*STATUS:[^\n]*\s*$/i`), cut to 4000 characters plus `\n[… <n> more characters cut]`. A lane file or reply that cannot be read gives no block.

- [ ] **Step 1: Write the failing tests** in `test/services/admission.test.ts`, using `setup`, `input`, `writeLane`, `admit`, `appendRecord`, `makeRecord`, and `appendKnowledge(repo, new Date(), "by hand", …)`:
  - "puts the role's standing rules and a finished research lane's answer in the brief (plan 32)": knowledge has `always A`, `[worker] only W`, `[reviewer] only R`; lane `M1.R1` (`Owns: docs/notes.md`, `Kind: research`) is admitted as `researcher-M1.R1` and recorded ok with a reply `The API is v2.\nSTATUS: complete — answered` at its `dispatchPaths(d.dir).reply` (`replyPath` relative to `run.dir`); `M1.L2` (`After: M1.R1`) is admitted. Its brief contains `Standing rules for a worker in this repo (its knowledge.md):`, `always A` and `only W`, not `only R`; contains `M1.R1 — test lane (research) answered:\nThe API is v2.`; and does not contain `STATUS: complete — answered`.
  - "adds no rules block when the role has none": no knowledge.md; the brief does not contain `Standing rules` nor `no knowledge recorded`.
  - "pastes only the latest ok research reply, and nothing when its file is gone": `M1.R1` admitted once and recorded ok (`old answer`); then two records appended for it without admission, so the lane's own try (what `E_ADMIT_ORDER` reads) stays that first one: `new answer` at a later `endedAt`, and a still later one with `replyStatus: "blocked"` (`blocked answer`); the brief has `new answer` only. Then the `new answer` reply file is deleted: admission still succeeds and the brief has no `(research) answered` block.
- [ ] **Step 2: Run** `bun test test/services/admission.test.ts` — the new tests FAIL.
- [ ] **Step 3: Implement `researchAnswers`**, then in admission set `context` (X1): the rules block for every role, the research blocks only when `i.lane !== null`, `null` when both are empty. `test/services/helpers.ts` `briefFor` keeps `context: null`; the new tests read `brief.md` directly.
- [ ] **Step 4: Run** `bun test test/services/admission.test.ts test/services/dispatch-protocol.test.ts` — PASS; `bun run typecheck && bun run lint`.
- [ ] **Step 5: Commit** `feat(brief): standing rules by role and research answers in the context`.

### Task 3: Plan lint in preflight

**Files:**
- Create: `src/domain/plan-lint.ts`, `test/domain/plan-lint.test.ts`
- Modify: `src/services/preflight.ts:18-36` (`PreflightReport`), `:51-91` (`laneChecks` keeps the text), `:267-355` (`preflight`)
- Test: `test/services/preflight.test.ts`

**Interfaces:**
- Consumes: `parseLaneHeader`, `headerBlock` (`src/domain/lane.ts`).
- Produces: `lintLanes(lanes: { id: string; text: string }[], known: string[]): string[]` in `src/domain/plan-lint.ts` — `known` is every lane id of the run (landed milestones' too). `PreflightReport` gains `lint: string[]` on both shapes; `blocked` ignores it.

Exact lines, in this order (per lane in input order, then cycles, then `info:` per milestone):

| Condition | Line |
| --- | --- |
| an `Owns:` entry ends in `/` | `<id>: Owns names whole folders (<dirs, ", ">): name the files, unless the lane creates the folder` |
| not research, body (the text after `headerBlock`, trimmed) under 200 characters or matching `/^implement task \d+ of /im` | `<id>: the lane file only points elsewhere: copy what the worker needs into it` |
| `After:` names the lane | `<id>: After: names the lane itself` |
| `After:` names an id not in `known` | `<id>: After: <a> has no lane file` |
| `After: a` in scope, `a` not research, both Owns non-empty and without folders, no shared entry | `<id>: After: <a> shares no file with it: drop it unless <id> needs <a>'s output` |
| a cycle among the lanes in scope | `After: cycle <a> → <b> → <a>: these lanes never start` |
| a milestone with ≥ 2 lanes and an `After:` among them | `info: <M> critical path <k> of <n> lanes` + `: fully serial` when `k === n` |

- [ ] **Step 1: Write the failing domain tests** in `test/domain/plan-lint.test.ts` (a `lane(id, owns, after?, kind?, body?)` helper building the header and a 250-character body, as in the spike):
  - "names lanes chained without a shared file, whole folders and lane files that point elsewhere": `M1.L1` (`a.ts`), `M1.L2` (`b.ts`, after `M1.L1`), `M1.L3` (`src/`, body `implement task 3 of plan`) → exactly `M1.L2: After: M1.L1 shares no file with it: …`, `M1.L3: Owns names whole folders (src/): …`, `M1.L3: the lane file only points elsewhere: …`, `info: M1 critical path 2 of 3 lanes`.
  - "names an After: that cannot finish": `M1.L3` after `M1.L3, M1.L9`; `M1.L4` ↔ `M1.L5` → the self line, `M1.L3: After: M1.L9 has no lane file`, `After: cycle M1.L4 → M1.L5 → M1.L4: these lanes never start`.
  - "leaves research lanes out of the file and body checks": research `M1.R1` (no Owns, body `Which API version?`), `M1.L1` (`a.ts`, after `M1.R1`) → only `info: M1 critical path 2 of 2 lanes: fully serial`.
  - "says nothing for a plan with no After: and named files": `[]`.
- [ ] **Step 2: Run** `bun test test/domain/plan-lint.test.ts` — FAIL.
- [ ] **Step 3: Implement `lintLanes`.** Cycle search: depth-first over in-scope `After:` edges with a visiting/done mark, each cycle reported once from the first lane that closes it. Depth for the critical path counts a lane in a cycle once (`depth.set(id, 1)` before recursing), and follows only edges inside the same milestone.
- [ ] **Step 4: Run** `bun test test/domain/plan-lint.test.ts` — PASS.
- [ ] **Step 5: Write the failing preflight test** "returns the plan's lint beside its results, and lint never blocks (plan 32)": `M1.L1` (`src/a.ts`, check `true`), `M1.L2` (`src/b.ts`, `After: M1.L1`); `preflight(…)` returns `blocked: false` and `lint` containing `M1.L2: After: M1.L1 shares no file with it: drop it unless M1.L2 needs M1.L1's output`; with `profile.preflight.confirm` on, the first (needs-confirmation) report carries the same `lint`.
- [ ] **Step 6: Run** `bun test test/services/preflight.test.ts` — the new test FAILS.
- [ ] **Step 7: Implement.** `LaneCheck` gains `text: string | null` (null when the file cannot be read); `lint = lintLanes(<in-scope lanes with text>, laneChecks(run).map((l) => l.lane))`, computed after the invalid-header refusal.
- [ ] **Step 8: Run** `bun test test/domain/plan-lint.test.ts test/services/preflight.test.ts` — PASS; `bun run typecheck && bun run lint`.
- [ ] **Step 9: Commit** `feat(preflight): lint the plan's lanes: chains, folders, pointers, cycles`.

### Task 4: Known issues and review rounds in the digest

**Files:**
- Modify: `src/services/milestones.ts:53-70` (export the full attempts), `src/services/protocol.ts:198-306` (`findingLines`, `writeDigest`)
- Test: `test/services/protocol.test.ts` ("the milestone digest")

**Interfaces:**
- Produces: `reviewerRounds(run: Run, m: string, start?: string | null): MilestoneReviewer[]` in `milestones.ts` (the non-partial `reviewerAttempts`, oldest first; `start` defaults to `milestoneStart(run, m)`). `knownIssues(run: Run, m: string, start?: string | null): string[]` exported from `protocol.ts` (ruling 14; NIT line regex `/^\s*(?:[-*]|\d+[.)])?\s*\**NIT\**\b.*$/gim`, bullet stripped with `/^\s*(?:[-*]|\d+[.)])\s*/`).
- Digest lines added after `Findings:`, in this order:
  - `Rounds: <n> review round(s)` + (` · fixed: <line> · <line>` when any, ruling 15);
  - `Known issues: none`, or `Known issues:` followed by one `- <line>` per issue.

- [ ] **Step 1: Write the failing tests** in "the milestone digest":
  - "lists every NIT the last reviewer and verifier left, word for word, and what earlier rounds fixed (plan 32)": route `M1.L1`; `passGate(r, "M1", t(1))`; a headless `reviewer-M1` record at `t(2)` replying `BUG src/a.ts:3 — x — y\n- NIT src/a.ts:9 — old — z`; another at `t(3)` replying `1. **NIT** src/b.ts:4 — later — z\nSTATUS: complete — ok`; a headless `verifier-M1` record at `t(4)` replying `VERDICT: PASS\nNIT src/v.ts:1 — v — w` (`t(s)` = now + s seconds). After `land`, the digest contains `Rounds: 3 review round(s) · fixed: BUG src/a.ts:3 — x — y`, `Known issues:`, `- **NIT** src/b.ts:4 — later — z`, `- NIT src/v.ts:1 — v — w`, and not `old — z`.
  - "lands a natively reviewed milestone with no known issues": `passGate` only → `Rounds: 1 review round(s)` and `Known issues: none`.
- [ ] **Step 2: Run** `bun test test/services/protocol.test.ts` — the new tests FAIL.
- [ ] **Step 3: Implement** `reviewerRounds`, `knownIssues` and the two digest parts. The latest verifier record is the last `readRecords` row with `role === "verifier"`, `name === verifierName(m)` and `endedAt` since `start`; the `ui-reviewer` one is the last with `role === "ui-reviewer"`, `namesMilestone(name, m)`, `status === "ok"`, since `start`. A reply file that is missing gives no lines.
- [ ] **Step 4: Run** `bun test test/services/protocol.test.ts test/services/land-gate.test.ts` — PASS; `bun run typecheck && bun run lint`.
- [ ] **Step 5: Commit** `feat(digest): known issues word for word, and the review rounds with what they fixed`.

### Task 5: The gate's record in the digest

**Files:**
- Modify: `src/services/protocol.ts` (`writeDigest`)
- Test: `test/services/protocol.test.ts`

**Interfaces:**
- Consumes: X3, `readChecks` and `CheckRecord` (plan 29, `src/services/milestone-check.ts`).
- Produces: the digest line after `Verifier:` — `Gate: \`<command>\` exit <exit> on <head first 12> · <round(durationMs / 1000)> s · secret scan: <secrets>`, or `Gate: not recorded` when there is none.

- [ ] **Step 1: Write the failing tests**: "carries the gate's exit code, duration and secret scan (plan 32)" — record a gate run for `M1` the way plan 29's tests do (its recording function), land, and expect the `Gate:` line with those values; "says not recorded without a gate run" — the existing first digest test's setup gives `Gate: not recorded`.
- [ ] **Step 2: Run** `bun test test/services/protocol.test.ts` — FAIL.
- [ ] **Step 3: Implement** the line from the latest record X3 names (none: no gate line).
- [ ] **Step 4: Run** `bun test test/services/protocol.test.ts` — PASS; `bun run typecheck && bun run lint`.
- [ ] **Step 5: Commit** `feat(digest): the gate run's exit, duration and secret scan`.

### Task 6: Skill, tool descriptions, README, ideas and the changeset

**Files:**
- Modify: `plugin/skills/catherd/SKILL.md`, `src/entry/mcp/lane-tools.ts` (the `preflight` description `:73`, the `land` description `:117`), `README.md:209`, `docs/dev/ideas.md:131-134`
- Create: `.changeset/knowledge-lanes-digest.md`
- Test: `test/skills.test.ts`, `test/plugin.test.ts` (unchanged; they must stay green)

- [ ] **Step 1: Skill text** (each a sentence or two, in the skill's voice):
  - the tool table row: `read_knowledge(repo, role?)` — with `role`, the standing rules that reach that role;
  - the run files list, the `knowledge.md` bullet: a line tagged `[worker, reviewer]` after its source reaches only those roles' briefs, an untagged one every role's; `dispatch` adds them to the brief;
  - the lane header bullet: a lane whose `After:` names a `Kind: research` lane gets that lane's finished answer pasted into its brief by `dispatch`; for a native Claude worker, put the research reply's path (from `result`) in its brief;
  - step 4 (preflight): `lint` names lanes chained without a shared file, whole-folder `Owns:`, lane files that only point elsewhere, and `After:` lines that cannot finish; send it to the architect as a delta before dispatching; an `info:` line is for the report;
  - step 10 (land) and "Finish": the digest carries `Known issues` word for word, the review rounds and the gate; the writer's MR-body brief copies each digest's `Known issues` block verbatim;
  - "Brief for a role" item 9: standing rules are added by `dispatch`; a native Claude role's brief includes `read_knowledge(repo, role: "<role>")`;
  - a new **Rules review** after the report: `route(run, role: "architect")`, then dispatch it read-only as `architect-rules`, brief: "Rules review: read the report below, this run's digests and its review findings, fixes and climbs. Propose at most five changes to the repo's standing rules, each with the event it comes from: a one-line rule that would have prevented a round or a climb (tagged `[role, …]` when it is not for every role), or a rule to remove or merge because it is stale, covers one past incident only, or repeats another. Write nothing; reply with the changes only." plus the report and `catherd knowledge show`. Show the user each change in one line; apply only those they agree to, with `catherd knowledge add "<[roles]> rule"` and `catherd knowledge rm "<text of the line>"`.
- [ ] **Step 2: Tool descriptions.** `preflight`: add "lint names the plan's shape problems (lanes chained without a shared file, whole-folder Owns, lane files that only point elsewhere, After: lines that cannot finish) and never blocks." `land`: the digest list adds "the review rounds and what they fixed, the gate's exit code, duration and secret scan, and every NIT left as known issues".
- [ ] **Step 3: README** row 209: `catherd knowledge show [--role <role>]|add "<line>"|rm "<text>"|path`, and in its description "a `[role, …]` tag after the source scopes a line to those roles' briefs; `rm` removes the one line the text matches".
- [ ] **Step 4: ideas.md.** Remove the entry "A bad `After:` blocks a lane forever" (`docs/dev/ideas.md:131-134`; ruling 12).
- [ ] **Step 5: Changeset** `.changeset/knowledge-lanes-digest.md`:

```md
---
"catherd-cli": minor
---

Standing rules: a knowledge.md line tagged `[worker, reviewer]` reaches only those roles' briefs, `catherd knowledge rm` retires a line, and the skill ends a run with a rules review. A finished research lane's answer is pasted into the briefs of the lanes after it. Preflight returns `lint` on the plan's lanes. Milestone digests list the known issues word for word, the review rounds and what they fixed, and the gate's exit code, duration and secret scan.
```

- [ ] **Step 6: Run** `bun test test/skills.test.ts test/plugin.test.ts test/entry/mcp-sync.test.ts`, `bun run format:check` — PASS.
- [ ] **Step 7: Commit** `docs(skill): standing rules, research answers, plan lint and the richer digest`.
