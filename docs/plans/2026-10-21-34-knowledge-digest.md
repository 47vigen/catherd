# catherd 2.0, plan 34: knowledge, lanes and the digest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `knowledge.md` lines become standing rules that reach each role's brief by role tag, and every finished run ends with a rules review (a `judge` proposes at most five changes, the owner approves them as a parked question); a research lane's answer reaches the lanes after it; preflight lints the plan's lanes; and the run report (the MR body) quotes every known issue word for word, with the review rounds, what they fixed and the gate's record.

**Architecture:** Domain: tag parsing (`src/domain/rules.ts`, new), the plan lint (`src/domain/plan-lint.ts`, new), a `rules` judge kind (`judge.ts`), the NITs a milestone lands with and the rules-review state (`run-state.ts`), the review's transitions (`run-machine.ts`). Services: two locked `knowledge.md` writers (`run-store.ts`), standing rules in plan 32's `<context>` section of every brief (`admission.ts`, since the knowledge path needs an async git call), research answers in `briefFor` (`run-briefs.ts`), lint in `preflight` and on `preflight.done`, the applied rules in plan 30's `finish` effect, and the report's new parts in `writeRunReport` (`run-report.ts`). Entry: `catherd knowledge show --role`, `catherd knowledge rm`.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, citty, `@modelcontextprotocol/sdk`. No new dependency.

**Spec:** `docs/specs/2026-10-12-catherd-2.0-design.md`, decision 20 (with 3, 5 and 7 for the judge, the parked question and the known issues). Input: `docs/plans/drafts-1.6/2026-10-12-32-knowledge-digest.md` (its rulings 1–16, re-shaped below). Plan 30 (`docs/plans/2026-10-21-30-run-daemon.md`) and 30b (`docs/plans/2026-10-21-30b-unattended.md`) bind this one through their Produces blocks. t3herd sources (read-only, `<the t3herd clone>`): `src/brief.ts:27-38` `rulesFor` and commit d33dce4 (the constraints review); `src/step.ts:202-211` `findingKey`; `src/step.ts:927-982` `mrBody`; `src/plan.ts:122-205` `lintPlan`.

**Pre-validation: spiked the tag regex (`rulesFor`, bracket prose, a colon inside the source), the `After:` cycle search over the worktree's `parseLaneHeader`/`headerBlock` and the `ADD`/`REMOVE` line parser in a scratch folder since deleted, targeted tests only; the full gate runs at execution.** Written against `main` at 2061e6e (1.5.0); plans 28–33 merge first, so every line number below is 1.5's: re-find each hunk by its name.

## Global Constraints

- Everything in plan 30's Global Constraints, unchanged (layers, the gate, no live model, no wall-clock sleep, stores, commits).
- Layers (`test/architecture.test.ts`): `rules.ts` and `plan-lint.ts` are domain and import only domain; `run-briefs.ts`, `run-report.ts`, `run-effects.ts` stay services.
- Every `knowledge.md` write holds `withFileLock(<knowledge.md>)` (`src/infra/filelock.ts:96`). The lock is not reentrant and `knowledgeFor` (`src/services/run-store.ts:334`) takes it while migrating, so `knowledgeFor` is called before, never inside, the locked section.
- Nothing this plan adds may make admission, `preflight`, an effect or `writeRunReport` throw: a knowledge file, reply file or check record that cannot be read adds nothing and the call goes on.
- No new event type and no new action type. This plan adds fields to plan 30's types (`preflight.done.lint`, `finish.rules`, `MilestoneState.nits`, `RunState.rulesReview`), one judge kind (`rules`); each is listed under Produces.
- Spec values, verbatim: "standing rules are tagged per role and reviewed after each run. A research lane's answer reaches the lanes that wait on it. Known issues are quoted word for word. Plan lint runs as preflight warnings." · "Past the cap the milestone lands with every remaining finding listed under Known issues in the MR." · "Each call is a short headless `judge` dispatch … Every judge decision is an event and appears in the MR's audit section." · "A question parks one unit."

## Review Focus

1. **A knowledge line with brackets that are not a tag** (`- … by hand: [x] done`, `use arr[i]`). Expected: it reaches every role unchanged; `catherd knowledge add "[x] done"` is refused, naming the bad name. Task 1: "leaves a bracket group that names no role as text for every role", "refuses a tag that names something other than a role".
2. **A repo with no `knowledge.md`, or one with only another role's rules.** Expected: no standing-rules block, never the "no knowledge recorded" sentence; the brief is byte-identical to plan 32's. Task 2: "puts the role's standing rules in every brief, and no block when the role has none".
3. **A research lane whose reply file is gone, whose last reply was blocked, or that ran twice.** Expected: only its latest ok, unblocked reply is pasted; a missing file adds nothing. Task 2: "pastes only the latest ok research reply, and nothing when its file is gone".
4. **The owner answers the rules question in prose ("yes to the first"), or with a number past the list.** Expected: nothing applied, the same question parked again; a finish re-run after a crash adds no line twice. Task 6: "parks again on an answer that names no change"; Task 7: "a finish re-run after a crash adds no line twice".
5. **A milestone whose last review round had no BUG but NITs, and a verifier PASS that adds NITs, or says `NIT: none`.** Expected: the landing's known issues are those NIT lines, word for word; a `none` line is no issue. Task 4: "keeps only the latest round's NITs, and adds them and the verifier's to the known issues on a PASS".

## Rulings

Dropped as already built:

1. Ruling: lane `After:` ordering is not re-planned — 1.5 parses `After:` (`src/domain/lane.ts:14-15,90`) and plan 30's machine dispatches a `pending` lane only once its `after` lanes are `done` — none; only the research-answer half is planned (Task 2).
2. Ruling: fix-round convergence and the open BLOCKER/BUG lines it lands with are plan 30's (D8, `milestone.landed.knownIssues`, the report's `## Known issues`) — none; this plan adds the NITs (Task 4) and pins "word for word" (Task 5).

Decisions:

3. Ruling: the standing rules are the lines of the repo's `knowledge.md`; no second constraints file — one per-repo store every run already reads — each line costs tokens in every brief of its roles; the rules review is the valve.
4. Ruling: a tag is `[role, role]` right after `- <date> <source>: `, or at the start of a hand-edited line; a bracket group with any name outside `ROLES` is not a tag and the line reaches every role; `catherd knowledge add` (and the rules review's `ADD`) refuses such a group. `judge` is a role (plan 30), so `[judge]` works; there is no `fixer` tag, since fix rounds run as `worker` — t3herd d33dce4, made safe for prose brackets — a typo'd tag in a hand-edited file reaches everyone instead of no one.
5. Ruling: the role server's `read_knowledge` (`src/entry/mcp/role-server.ts:52-62`) stays unfiltered (the rules judge reads all of it); the session's is gone (plan 30 D7), so no tool gains a `role`; the filtered view is `catherd knowledge show --role` — none.
6. Ruling: retiring a rule is `catherd knowledge rm "<text>"` (and the review's `REMOVE`), matching exactly one line by substring; `appendKnowledge` stops being the single writer, and both writers take the file lock — the review needs removals, and a line number shifts under a concurrent write — a substring that matches two lines is refused, not guessed.
7. Ruling: standing rules enter the brief in admission, appended to plan 32's `BriefContext.context` after the plan preamble, for every role, not in `briefFor` — plan 32's Produces names this slot for plan 34; `briefFor` is synchronous and the knowledge path needs `gitOrigin` (async) — the architect and the judge, whom plan 32 gives no preamble, still get their rules.
8. Ruling: a research answer is the reply of the latest record whose `lane` is the research lane, `status: ok`, `replyStatus` not `blocked`/`refused`, its closing `STATUS:` line cut and its first 4000 characters kept; `briefFor` pastes it into the `lane` and `fix` briefs of each lane whose `after` names a `Kind: research` lane — t3herd 5b9090e — a 4000-character cut can drop the end of a long answer (the brief says how much was cut).
9. Ruling: known issues at landing are plan 30's open lines plus the NIT lines of the milestone's latest review round (every reviewer and UI reviewer since its latest `commit.made`) plus the NIT lines of the verifier's PASS, verbatim, duplicates dropped — decision 7 "every remaining finding"; a NIT is never a fix-round finding (D8 counts BLOCKER and BUG), so it remains — a NIT an earlier round named and the latest one did not repeat is not listed.
10. Ruling: the report's new parts (`Rounds:`, `Gate:`, `## Plan lint`, `## Rules review`) live in `report.md` only; `digests/<M>.md` keeps its 1.5 shape — `land()` writes it and never sees the events — a reader of a digest file alone misses them.
11. Ruling: "fixed" is the BLOCKER and BUG lines of every earlier round whose `findingKey` the last round does not repeat, at most 15; a round is the reviewer ends (`reviewer`, `ui-reviewer`, the partial pass `reviewer-<M>-2`) between two `commit.made` events of the milestone — t3herd `mrBody` — none.
12. Ruling: the `Gate:` lines are 30b's check records: per command, the latest non-baseline `CheckRecord` of this run and milestone (`readChecks(run.meta.repo)`); none gives `Gate: not recorded` — draft 29 Ruling 6 judges the latest record of each command — none.
13. Ruling: lint is lane-level only; milestone-level lint (milestones that run together but share files) goes to plan 35, which owns parallel milestones; the critical path is the longest `After:` chain within one milestone, as an `info:` line — none.
14. Ruling: two draft lints are dropped: "the lane file only points elsewhere" (decision 22 makes lanes map to plan tasks, and plan 32 inlines a `Tasks:` lane's task, so the lint would warn on every lane) and "more than 5 lanes" (the architect's "more small lanes beat one long one") — none.
15. Ruling: an `After:` that can never finish (it names its own lane, a lane with no file, or closes a cycle) is not a warning: preflight returns it as a `cannot-start` result, so plan 30 parks the milestone (reason `preflight`) — under the daemon such a lane would wait forever with nothing live and no question asked — the owner fixes the lane file and answers once. This closes `docs/dev/ideas.md` "A bad `After:` blocks a lane forever".
16. Ruling: lint travels as `preflight.done.lint` (default `[]`, so older lines parse) into the timeline and the report's `## Plan lint` — no new event type — an owner who never reads the report misses a warning.
17. Ruling: the rules review is a `judge` dispatch of a new kind `rules`, named `judge-rules`, on unit `run`, once every milestone has landed (or merged) and the run is not cancelling; it reads the run's files and the whole `knowledge.md` itself (read-only, `read_run_file`, `read_knowledge`) — decision 3 makes judgment a role; t3herd ran it as an architect — one more short Opus call per finished run.
18. Ruling: the proposals never park the run. `finish{ done, proposals }` carries them and the `finish` effect lists each one in the report with its `catherd knowledge add|rm` command, applying none. The owner applies them later by hand, or from the panel through those same commands. — autonomy first: the run's end never waits on the owner (controller ruling, 2026-10-21) — cost if wrong: a useful rule waits until the owner reads the report.
19. Ruling: a rules judge that fails twice (`judge.failed`) finishes the run without a review, never parks it; the report says so — the review is advisory — a run whose judge cannot answer learns nothing.
20. Ruling: the report's `add` command uses the same tag check as `catherd knowledge add`, so a proposal with a bad tag is refused when the owner runs it, not by the run — the run never writes knowledge.md — cost if wrong: none.

## Cross-plan interfaces

- **X1, from plan 30's Produces (exact names).** `RunEvent` (`dispatch.started{ role, unit, name }`, `dispatch.ended{ dispatchId, name, unit, status, verdict, findings, replyPath }`, `commit.made{ milestone, round }`, `preflight.done{ milestone, blocking, confirm }`, `judge.decided{ id, unit, kind, decision }`, `judge.failed`, `question.answered{ unit, answer }`, `milestone.landed{ knownIssues }`), `Finding`, `describeEvent`; `RunState` (`milestones`, `lanes`, `dispatches`, `judges`, `phase`, `cancelling`), `MilestoneState.knownIssues`, `LaneState.{ kind, after }`, `DispatchView.{ role, unit, name }`, `reduce`, `replay`, `findingKey`; `Action` (`judge`, `park`, `land`, `finish`), `next`; `JUDGE_KINDS`, `JudgeKind`, `JudgeInput`, `JudgeDecisionSchema`, `JUDGE_CONTRACT`, `parseJudgeReply`, `judgeName`; `briefFor(run, s, a)`, `judgeBrief(run, input)`, `endedEvent`, `realEffects`, `writeRunReport`; `ROLES` with `judge`. The rules question shows up in `RunView.parked` and `parkedQuestions()` with plan 30's `command` (`catherd answer <run> run "<answer>"`), and in `runTimeline` through `describeEvent`; this plan adds nothing to `run-read.ts`.
- **X2, from 30b.** `writeRunReport(run, s, events, audits: Record<string, string[]> = {})` (30b Task 7); `readChecks(toplevel)`, `appendCheckRecord`, `CheckRecord = { at, run, milestone, command, head, exit, durationMs, fails, log, baseline?, rerunOf?, secrets? }` in `src/services/milestone-check.ts` (30b Task 5, draft 29 Task 3).
- **X3, an assumption about plan 30's `Finding.text`.** Plan 30's D8 test asserts the known issues equal the reviewer's open lines verbatim, so `text` holds the reviewer's line. This plan reads it through `issueLine(f)` (Task 4), which puts the label back only when `text` lost it, so either shape gives a verbatim line.
- **X4, from plan 32 (its "Produces for plan 34", and its `answerUnit` rule for an `approval` question, Ruling 18).** `BriefContext.context: string | null`, rendered by `composeBrief` as the `<context>` section between `<team>` and `<task>`; admission passes `context: planContext(run, i.role)` (`src/services/plan-input.ts`, plan 32 Task 4). Plan 32 rewrites `briefFor`'s bodies, so Task 2 re-finds the `lane` and `fix` bodies by name and appends the research blocks at their end.
- **X5, to plan 35.** Milestone-level lint (Ruling 13) extends `lintLanes` or adds a sibling in `src/domain/plan-lint.ts`.
- **X6, to plan 36.** `.changeset/knowledge-digest.md`, part of 2.0.0.

## Spec coverage

| Decision 20 | Task |
| --- | --- |
| Standing rules tagged per role | 1, 2 |
| … reviewed after each run | 6, 7 |
| A research lane's answer reaches the lanes that wait on it | 2 |
| Known issues quoted word for word | 4, 5 |
| Plan lint runs as preflight warnings | 3, 5 |
| The 1.6 digest items (rounds and fixes, the gate's exit, duration and scan), now in the report | 5 |

## Parallelism

| Wave | Tasks | Files |
| --- | --- | --- |
| 1 | 1 ∥ 3 ∥ 4 | 1: `src/domain/rules.ts` (new), `src/services/{run-store,run-service}.ts`, `src/entry/knowledge-command.ts`, `test/domain/rules.test.ts` (new), `test/entry/knowledge-command.test.ts` · 3: `src/domain/plan-lint.ts` (new), `src/services/preflight.ts`, `src/domain/run-events.ts`, `src/services/run-effects.ts` (the `route` effect), tests · 4: `src/domain/run-state.ts` (`MilestoneState`), `src/domain/run-events.ts` (`issueLine`, appended at the end), `src/services/run-effects.ts` (`endedEvent`), tests |
| 2 | 2 ∥ 5 ∥ 6 | 2: `src/services/{admission,run-briefs}.ts`, tests · 5: `src/services/run-report.ts`, `test/services/run-report.test.ts` (new) · 6: `src/domain/{judge,run-events,run-state,run-machine}.ts`, tests |
| 3 | 7 | `src/services/{run-briefs,run-effects,run-report}.ts`, tests |
| 4 | 8 | `plugin/skills/catherd/SKILL.md`, `README.md`, `MIGRATION.md`, `docs/dev/ideas.md`, `test/skills.test.ts`, `.changeset/knowledge-digest.md` (new) |

Tasks 3 and 4 both edit `run-events.ts` and `run-effects.ts` in different hunks (3: the `preflight.done` schema and the `route` effect; 4: a new export at the end, and `endedEvent`); cherry-pick 3 first.

---

### Task 1: role-tagged standing rules, and removing one

**Files:**
- Create: `src/domain/rules.ts`, `test/domain/rules.test.ts`
- Modify: `src/services/run-store.ts:351-363` (`appendKnowledge`), `src/services/run-service.ts:330-361` (`readKnowledge` … `addKnowledge`), `src/entry/knowledge-command.ts:14-37,118-125`
- Test: `test/entry/knowledge-command.test.ts`, `test/services/knowledge-origin.test.ts` (unchanged; stays green)

**Interfaces:**
- Produces (domain, `src/domain/rules.ts`):
  - `export const RULE_TAG = /^(\s*(?:[-*]\s+)?(?:\d{4}-\d{2}-\d{2}\s+[^\n]*?:\s+)?)\[([a-z-]+(?:\s*,\s*[a-z-]+)*)\]\s*/;` (spiked; group 1 is kept when the tag is removed)
  - `tagNames(line: string): string[] | null` — the names of a tag-shaped group, whatever they are; null when there is none.
  - `ruleRoles(line: string): Role[] | null` — `tagNames` when every name is in `ROLES`, else null (not a tag).
  - `rulesFor(text: string, role: Role): string` — untagged lines kept, tagged lines kept only for their roles with the tag removed, joined by `\n`, trimmed.
  - `rulesBlock(rules: string, role: Role): string` — `""` for blank `rules`, else `` `Standing rules for the ${role} role in this repo (its knowledge.md):\n${rules}` ``.
- Produces (services): `removeKnowledgeLine(toplevel: string, match: string): Promise<string>` (run-store; the locked rewrite, returns the removed line); `standingRules(repo: string, role: Role): Promise<string>` (run-service; `rulesFor` of the file, `""` when it is missing or blank); `removeKnowledge(repo: string, match: string): Promise<string>`; `addKnowledge(repo: string, text: string, now: Date = new Date(), source = BY_HAND): Promise<string>` (a `source` parameter added for Task 7).
- Produces (entry): `catherd knowledge show [--role <role>]`, `catherd knowledge rm "<text>"`.

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
  expect(rulesFor("- 2026-10-21 rules review r1: [judge] J", "judge")).toBe("- 2026-10-21 rules review r1: J");
});
it("leaves a bracket group that names no role as text for every role", () => {
  expect(tagNames("- 2026-10-12 by hand: [worker, revewer] x")).toEqual(["worker", "revewer"]);
  expect(ruleRoles("- 2026-10-12 by hand: [worker, revewer] x")).toBeNull();
  expect(ruleRoles(L[4])).toBeNull();
  expect(rulesBlock("", "worker")).toBe("");
  expect(rulesBlock("always A", "worker")).toBe("Standing rules for the worker role in this repo (its knowledge.md):\nalways A");
});
```

- [ ] **Step 2: Run** `bun test test/domain/rules.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `src/domain/rules.ts`** with `RULE_TAG` as given.
- [ ] **Step 4: Run** `bun test test/domain/rules.test.ts`. Expected: PASS.
- [ ] **Step 5: Write the failing CLI tests** in `test/entry/knowledge-command.test.ts` (its `catherd()` helper, `withHome`, `tempRepo`):
  - "adds a rule tagged with roles, and shows each role only its rules": `add "[worker, reviewer] run bun test <file>"` exits 0 and prints `- <date> by hand: [worker, reviewer] run bun test <file>`; `show --role worker` prints `- <date> by hand: run bun test <file>`; `show --role verifier` prints `EMPTY`; `show --role nobody` exits non-zero with `"nobody" is not a role` in stderr.
  - "refuses a tag that names something other than a role": `add "[worker, revewer] x"` exits non-zero, stderr contains `"revewer" is not a role`, and `knowledgeFile(repo)` does not exist.
  - "removes the one line a text matches, and refuses none or several": two lines added; `rm "zzz"` exits non-zero with `no line of knowledge.md contains "zzz"`; `rm "by hand"` exits non-zero with `2 lines contain "by hand"`; `rm "bun test <file>"` exits 0, prints the removed line, and `show` no longer has it.
- [ ] **Step 6: Run** `bun test test/entry/knowledge-command.test.ts`. Expected: the three new tests FAIL.
- [ ] **Step 7: Implement.**
  - `appendKnowledge`: `const file = await knowledgeFor(toplevel)`, then `await withFileLock(file, () => appendPrivate(file, …))`.
  - `removeKnowledgeLine`: `knowledgeFor`, then under the lock: the non-blank lines (`nonBlankLines`) containing `match.trim()`; 0 → `E_INPUT_INVALID` `no line of knowledge.md contains "<match>"` (fix: `catherd knowledge show`); more than 1 → `E_INPUT_INVALID` `<n> lines contain "<match>": quote more of the one to remove`; else `writeTextAtomic(file, rest.length ? `${rest.join("\n")}\n` : "", { mode: PRIVATE_FILE })` and return the line. A missing file is the 0 case.
  - `addKnowledge`: after the empty check, any `tagNames(text)` name outside `ROLES` → `E_INPUT_INVALID` `"<name>" is not a role: tag a rule with <ROLES joined by ", ">` (fix: `catherd knowledge add "[worker, reviewer] <rule>"`). `land`'s `learned` is not checked (Ruling 4: a wrong tag reaches every role).
  - CLI: `show` gains `role: { type: "string", description: "only the rules that reach this role" }`; a role outside `ROLES` is `E_INPUT_INVALID`; with a role it prints `standingRules`, or the placeholder sentence when that is `""`; `--json` with a role prints `{ repo, path, role, rules }`. `rm`: required positional `text`, `refuseInRole(process.env, "catherd knowledge rm")`, prints the removed line. The command description becomes "show, add, rm or path, and its gate environment (env)".
- [ ] **Step 8: Run** `bun test test/domain/rules.test.ts test/entry/knowledge-command.test.ts test/services/knowledge-origin.test.ts`, then `bun run typecheck && bun run lint`. Expected: PASS.
- [ ] **Step 9: Commit** — `git commit -m "feat(knowledge): role-tagged standing rules, and knowledge rm"`

### Task 2: standing rules and research answers reach the brief

**Files:**
- Modify: `src/services/admission.ts:336-345` (the `composeBrief` call, where plan 32 passes `context: planContext(run, i.role)`); `src/services/run-briefs.ts` (`briefFor`'s `lane` and `fix` bodies)
- Test: `test/services/admission.test.ts`, `test/services/run-briefs.test.ts`

**Interfaces:**
- Consumes: `standingRules`, `rulesBlock` (Task 1); `BriefContext.context`, `planContext` (X4); `readRecords` (`src/services/run-store.ts:214`); `RunState`, `LaneState` (X1).
- Produces: admission's `context` = the non-empty of `planContext(run, i.role)` and `rulesBlock(rules, i.role)`, joined by a blank line, else `null`. `export const RESEARCH_ANSWER_CHARS = 4000` and `export function researchAnswers(run: Run, s: RunState, lane: string): string[]` in `src/services/run-briefs.ts`: one block per `after` lane of `s.lanes[lane]` whose `kind` is `research` and that has an answer (Ruling 8), `` `${id} (research) answered:\n${answer}` ``; `answer` is the reply with a trailing `/\s*STATUS:[^\n]*\s*$/i` removed, and past 4000 characters `` `${first 4000}\n[… ${n} more characters cut]` ``.

- [ ] **Step 1: Write the failing tests.**
  - `test/services/admission.test.ts`, "puts the role's standing rules in every brief, and no block when the role has none (plan 34)": `addKnowledge(repo, "always A")`, `addKnowledge(repo, "[worker] only W")`, `addKnowledge(repo, "[reviewer] only R")`; `admit(…, input())`; `dispatchPaths(d.dir).brief` contains, inside its `<context>` section, `Standing rules for the worker role in this repo (its knowledge.md):`, `always A` and `only W`, not `only R`; with a plan file also given (plan 32's fixture), the preamble comes first and the rules after it. A second `setup()` with no knowledge: the brief equals `briefFor(run, "Read lanes/M1.L1.md")` (the test helper, `context: null`) and contains neither `<context>`, `Standing rules` nor `no knowledge recorded`.
  - `test/services/run-briefs.test.ts` (state from `replay` of `run.started` and a `plan.ready` with `M1.R1` `kind: "research"` and `M1.L2` `after: ["M1.R1"]`; records through `appendRecord(run, makeRecord({ lane: "M1.R1", name: "researcher-M1.R1", replyPath, endedAt }))`, reply files written under `run.dir`):
    - "pastes a finished research lane's answer into the lanes after it": reply `The API is v2.\nSTATUS: complete — answered`; `briefFor(run, s, dispatchOf("M1.L2"))` contains `M1.R1 (research) answered:\nThe API is v2.` and not `STATUS: complete — answered`; the brief of a lane with no `After:` has no `(research) answered`.
    - "pastes only the latest ok research reply, and nothing when its file is gone": records `old answer` (ok, t1), `new answer` (ok, t2), `blocked answer` (ok, `replyStatus: "blocked"`, t3) → the brief has `new answer` only; after deleting `new answer`'s reply file the brief is built and has no `(research) answered` block.
    - "cuts a long answer at 4000 characters and says how much": a 4100-character reply → the block ends with `[… 100 more characters cut]`.
- [ ] **Step 2: Run** `bun test test/services/admission.test.ts test/services/run-briefs.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** In admission, `rules = await standingRules(run.meta.repo, i.role).catch(() => "")`, then `context` as Produces says. `researchAnswers` reads each record's reply with `existsSync`/`readFileSync` inside a `try`, a failure giving no block; `briefFor`'s `lane` and `fix` bodies end with the blocks, each after a blank line.
- [ ] **Step 4: Run** the Step 2 command and `bun test test/domain/brief.test.ts test/services/dispatch-protocol.test.ts test/services/verifier-brief.test.ts`, then `bun run typecheck && bun run lint`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(brief): standing rules by role, and research answers for the lanes after them"`

### Task 3: plan lint in preflight

**Files:**
- Create: `src/domain/plan-lint.ts`, `test/domain/plan-lint.test.ts`
- Modify: `src/services/preflight.ts:27-36` (`PreflightReport`), `:51-91` (`LaneCheck` keeps the text), `:267-355` (`preflight`); `src/domain/run-events.ts` (`preflight.done.lint`, `describeEvent`); `src/services/run-effects.ts` (the `route` effect)
- Test: `test/services/preflight.test.ts`, `test/domain/run-events.test.ts`, `test/services/run-effects.test.ts`

**Interfaces:**
- Consumes: `parseLaneHeader` (`src/domain/lane.ts:79`).
- Produces: in `src/domain/plan-lint.ts`, `export interface PlanLint { warnings: string[]; stuck: { lane: string; note: string }[] }` and `export function lintLanes(lanes: { id: string; text: string }[], known: string[]): PlanLint` — `lanes` are the lanes in scope, `known` every lane id of the run (landed milestones' too); never throws. `PreflightReport` gains `lint: string[]` on both shapes (the warnings), and each `stuck` entry becomes a result `{ lane, check, outcome: "cannot-start", exitCode: null, tail: [], note }` (Ruling 15). `preflight.done` gains `lint: z.array(z.string()).default([])`; `describeEvent` of a `preflight.done` with lint appends ` · <n> lint warning(s)`.

Exact lines, in this order (per lane in input order, then cycles, then one `info:` per milestone):

| Condition | Goes to | Line |
| --- | --- | --- |
| an `Owns:` entry ends in `/` | warnings | `<id>: Owns names whole folders (<dirs, ", ">): name the files, unless the lane creates the folder` |
| `After:` names the lane | stuck | `<id>: After: names the lane itself` |
| `After:` names an id not in `known` | stuck | `<id>: After: <a> has no lane file` |
| `After: a` in scope, neither lane `Kind: research`, both `Owns:` non-empty and without folders, no shared entry | warnings | `<id>: After: <a> shares no file with it: drop it unless <id> needs <a>'s output` |
| a cycle among the lanes in scope (lane: the first lane of the cycle) | stuck | `After: cycle <a> → <b> → <a>: these lanes never start` |
| a milestone with ≥ 2 lanes in scope and an `After:` among them | warnings | `info: <M> critical path <k> of <n> lanes`, plus `: fully serial` when `k === n` |

- [ ] **Step 1: Write the failing domain tests** in `test/domain/plan-lint.test.ts` (a `lane(id, owns, after?, kind?)` helper building `# <id> — t`, `Owns:`, `Fast check: true`, `Kind:`, `Difficulty: build`, `After:` and a 250-character body):
  - "names lanes chained without a shared file and whole folders, with the critical path": `M1.L1` (`a.ts`), `M1.L2` (`b.ts`, after `M1.L1`), `M1.L3` (`src/`) → `{ warnings: ["M1.L2: After: M1.L1 shares no file with it: drop it unless M1.L2 needs M1.L1's output", "M1.L3: Owns names whole folders (src/): name the files, unless the lane creates the folder", "info: M1 critical path 2 of 3 lanes"], stuck: [] }`.
  - "names an After: that can never finish as stuck": `M1.L3` after `M1.L3, M1.L9`; `M1.L4` ↔ `M1.L5` → `stuck` equals `[{ lane: "M1.L3", note: "M1.L3: After: names the lane itself" }, { lane: "M1.L3", note: "M1.L3: After: M1.L9 has no lane file" }, { lane: "M1.L4", note: "After: cycle M1.L4 → M1.L5 → M1.L4: these lanes never start" }]`.
  - "leaves research lanes out of the file checks": research `M1.R1` (no Owns), `M1.L1` (`a.ts`, after `M1.R1`) → `{ warnings: ["info: M1 critical path 2 of 2 lanes: fully serial"], stuck: [] }`.
  - "says nothing for lanes with no After: and named files, and never throws on a file with no header": `{ warnings: [], stuck: [] }` for both.
- [ ] **Step 2: Run** `bun test test/domain/plan-lint.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `lintLanes`.** Cycle search: depth-first over in-scope `After:` edges (self edges and unknown ids skipped) with a visiting/done mark, each cycle reported once, from the stack entry it closes on. Critical-path depth follows only edges inside the same milestone (the id's part before the first `.`) and counts a lane in a cycle once (`depth.set(id, 1)` before recursing).
- [ ] **Step 4: Run** `bun test test/domain/plan-lint.test.ts`. Expected: PASS.
- [ ] **Step 5: Write the failing service tests:**
  - `test/services/preflight.test.ts`, "returns the plan's lint beside its results, and lint never blocks (plan 34)": `M1.L1` (`src/a.ts`, check `true`), `M1.L2` (`src/b.ts`, `After: M1.L1`) → `blocked: false`, `lint` contains `M1.L2: After: M1.L1 shares no file with it: drop it unless M1.L2 needs M1.L1's output`; with `profile.preflight.confirm` on, the needs-confirmation report carries the same `lint`.
  - same file, "blocks a lane whose After: can never finish, naming why (plan 34)": `M1.L1` with `After: M1.L9` → `blocked: true` and a result `{ lane: "M1.L1", outcome: "cannot-start", note: "M1.L1: After: M1.L9 has no lane file" }`.
  - `test/domain/run-events.test.ts`, "reads a preflight.done without lint as no lint, and counts lint in its line": a fixture without `lint` parses to `lint: []`; one with two lines describes with ` · 2 lint warning(s)`.
  - `test/services/run-effects.test.ts`, "copies preflight's lint onto preflight.done": the `route` effect over the first preflight test's lanes appends a `preflight.done` whose `lint` is the report's.
- [ ] **Step 6: Run** `bun test test/services/preflight.test.ts test/domain/run-events.test.ts test/services/run-effects.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 7: Implement.** `LaneCheck` gains `text: string | null` (null when the file cannot be read); after the invalid-header refusal, `const { warnings: lint, stuck } = lintLanes(<in-scope lanes with text>, laneChecks(run).map((l) => l.lane))`; `stuck` results are pushed after the checks ran; both report shapes carry `lint`. The `route` effect passes `lint: report.lint` (the needs-confirmation report included).
- [ ] **Step 8: Run** the Step 6 command and `bun test test/domain/plan-lint.test.ts`, then `bun run typecheck && bun run lint`. Expected: PASS.
- [ ] **Step 9: Commit** — `git commit -m "feat(preflight): lint the plan's lanes, and stop on an after: that can never finish"`

### Task 4: a milestone lands with its NITs as known issues

**Files:**
- Modify: `src/domain/run-events.ts` (`issueLine`), `src/domain/run-state.ts` (`MilestoneState.nits`, `reduce`), `src/services/run-effects.ts` (`endedEvent` reads a verifier reply's findings)
- Test: `test/domain/run-state.test.ts`, `test/domain/run-machine.test.ts`, `test/services/run-effects.test.ts`

**Interfaces:**
- Consumes: X1, X3.
- Produces: `export function issueLine(f: Finding): string` in `run-events.ts` — `f.text` when it starts with its label after any `-`, `*`, number or emphasis, else `` `${f.label} ${f.text}` ``. `MilestoneState.nits: string[]` (`[]` when a milestone is created). Reduce (Ruling 9):
  - `commit.made{ milestone: M }` → `M.nits = []`;
  - `dispatch.ended` of a dispatch whose `DispatchView.role` is `reviewer` or `ui-reviewer` and whose `unit` is M, `status: "ok"` → `M.nits` gains `issueLine` of each NIT finding;
  - `dispatch.ended` of M's verifier with `verdict: "pass"` → `M.knownIssues = unique([...M.knownIssues, ...M.nits, ...<its NIT issue lines>])`, order kept.
  The machine's `land{ knownIssues }` reads `M.knownIssues`, so every landing carries them.

- [ ] **Step 1: Write the failing tests:**

```ts
// test/domain/run-state.test.ts
it("keeps only the latest round's NITs, and adds them and the verifier's to the known issues on a PASS", () => {
  const s = replay([...m1Running(),
    reviewerEnded("M1", [nit("NIT src/a.ts:9 — old — z")]),
    commitMade("M1", 1),
    reviewerEnded("M1", [nit("**NIT** src/b.ts:4 — later — z")]),
    verifierEnded("M1", "pass", [nit("NIT src/v.ts:1 — v — w"), nit("**NIT** src/b.ts:4 — later — z")]),
  ]);
  expect(s.milestones[0]?.knownIssues).toEqual(["**NIT** src/b.ts:4 — later — z", "NIT src/v.ts:1 — v — w"]);
});
it("a finding's issue line is its text, with its label put back when the text lost it", () => {
  expect(issueLine({ label: "NIT", text: "- **NIT** a.ts — x", file: "a.ts" })).toBe("- **NIT** a.ts — x");
  expect(issueLine({ label: "NIT", text: "a.ts — x", file: "a.ts" })).toBe("NIT a.ts — x");
});
```

  `m1Running`, `reviewerEnded`, `verifierEnded`, `commitMade` and `nit` are small builders over plan 30's `ev` (a `dispatch.started` with the role, then its `dispatch.ended`). Plus:
  - `test/domain/run-machine.test.ts`, "lands with the round's NITs and its open lines as known issues, word for word": feed a milestone through a review round with one BUG and one NIT that the next round leaves open past the soft cap, then a verifier PASS → the `land` action's `knownIssues` holds the BUG line and the NIT line verbatim.
  - `test/services/run-effects.test.ts`, "reads a verifier PASS reply's NIT lines into dispatch.ended, and no line from NIT: none": a `verifier-M1` record replying `VERDICT: PASS\nNIT src/v.ts:1 — v — w\nNIT: none\nHEAD: <sha>\nSTATUS: complete — ok` → `findings` is one NIT with file `src/v.ts` (this may already pass on plan 30's `endedEvent`).
- [ ] **Step 2: Run** `bun test test/domain/run-state.test.ts test/domain/run-machine.test.ts test/services/run-effects.test.ts`. Expected: the new tests FAIL (the effects test may pass).
- [ ] **Step 3: Implement** `issueLine`, the field and the three reduce rules; `endedEvent` parses findings for a `verifier` record as it does for a reviewer's.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): a milestone lands with its last round's and its verifier's nits as known issues"`

### Task 5: the report quotes known issues and names rounds, fixes, gate and lint

**Files:**
- Modify: `src/services/run-report.ts` (`writeRunReport`)
- Test: `test/services/run-report.test.ts` (new; `freshRun`, events through `appendEvent`, the state through `replayRun`)

**Interfaces:**
- Consumes: X1 (`findingKey`, `issueLine` of Task 4), X2 (`readChecks`).
- Produces, in `src/services/run-report.ts`:
  - `export const FIXED_LINES = 15`;
  - `export function reviewRounds(events: RunEvent[], m: string): Finding[][]` — Ruling 11: walking `events`, each `commit.made{ milestone: m }` opens a round; each ok `dispatch.ended` whose `dispatch.started.role` is `reviewer` or `ui-reviewer` and `unit` is `m` adds its findings to the open round; rounds without a reviewer end are left out;
  - `export function roundsLine(events: RunEvent[], m: string): string` — `` `Rounds: ${n} review round(s)` `` plus `` ` · fixed: ${lines.join(" · ")}` `` when any;
  - `export function gateLines(run: Run, m: string): string[]` — per command, its latest record with `run === run.id`, `milestone === m` and no `baseline`, as `` `Gate: \`${command}\` exit ${exit} on ${head.slice(0, 12)} · ${Math.round(durationMs / 1000)} s · secret scan: ${secrets ?? "not run"}` ``; `["Gate: not recorded"]` when none; a store that cannot be read gives `["Gate: not recorded"]`.
  - In `report.md`: after each landed milestone's inlined digest, its `roundsLine` and `gateLines`; after `## Known issues`, a `## Plan lint` section with `- <M>: <line>` for each line of each milestone's latest `preflight.done.lint`, left out when there is none.

- [ ] **Step 1: Write the failing tests:**
  - "says how many review rounds a milestone took and which findings they fixed (plan 34)": round 0 `[BUG "BUG src/a.ts:3 — x — y", NIT "NIT n — z"]`, `commit.made` 1, round 1 `[BUG "BUG src/c.ts:1 — still broken"]`, `commit.made` 2, round 2 `[BUG "BUG src/c.ts:9 — still broken"]` → `roundsLine` is `Rounds: 3 review round(s) · fixed: BUG src/a.ts:3 — x — y`.
  - "counts a partial review and its second pass as one round": `reviewer-M1` (`partial`) then `reviewer-M1-2` with no `commit.made` between → `Rounds: 1 review round(s)`.
  - "carries the gate's exit, duration and secret scan, per command (plan 34)": `appendCheckRecord(run.meta.repo, { run: run.id, milestone: "M1", command: "bun test", head: "0123456789abcdef0123456789abcdef01234567", exit: 0, durationMs: 41_400, fails: [], log: "", secrets: "clean", at })`, and a baseline record of the same command with exit 1 → `gateLines(run, "M1")` is ``["Gate: `bun test` exit 0 on 0123456789ab · 41 s · secret scan: clean"]``; for `M2`, `["Gate: not recorded"]`.
  - "quotes every known issue word for word": a `milestone.landed{ knownIssues: ["**NIT** src/b.ts:4 — later — z", "BUG src/c.ts:9 — still broken | x"] }` → `report.md` contains both strings unchanged, and its `M1` section contains `Rounds:` and `Gate:` lines.
  - "lists plan lint per milestone, and no section without any": `preflight.done{ milestone: "M1", lint: ["M1.L2: After: M1.L1 shares no file with it: …"] }` → `## Plan lint` and `- M1: M1.L2: After: M1.L1 shares no file with it: …`; a run with no lint has no `## Plan lint`.
- [ ] **Step 2: Run** `bun test test/services/run-report.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** "fixed": the BLOCKER and BUG findings of every round before the last whose `findingKey(issueLine(f))` the last round's findings do not share, first per key, at most `FIXED_LINES`, each `issueLine(f)`.
- [ ] **Step 4: Run** `bun test test/services/run-report.test.ts test/services/run-effects.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(report): known issues word for word, review rounds, fixes, the gate and plan lint"`

### Task 6: the rules review in the machine

**Files:**
- Modify: `src/domain/judge.ts`, `src/domain/run-events.ts` (`PARK_REASONS` gains `"rules"`), `src/domain/run-state.ts` (`RunState.rulesReview`, `reduce`), `src/domain/run-machine.ts` (advance and three reactions)
- Test: `test/domain/judge.test.ts`, `test/domain/run-state.test.ts`, `test/domain/run-machine.test.ts`

**Interfaces:**
- Consumes: X1.
- Produces, in `src/domain/judge.ts`:
  - `JUDGE_KINDS` gains `"rules"` (verbs: `rules`); `export const MAX_RULE_CHANGES = 5`;
  - `export const RuleChangeSchema = z.object({ op: z.enum(["add", "remove"]), text: z.string().min(1), why: z.string() })`; `export type RuleChange = z.infer<typeof RuleChangeSchema>`;
  - `JudgeDecisionSchema` gains `{ verb: "rules", changes: RuleChange[] }`;
  - `JUDGE_CONTRACT` gains, after the `retry, climb or skip` line, exactly: `- rules: up to five lines, ADD <a one-line rule, with a [role, …] tag when it is not for every role> — <the event it comes from>, or REMOVE <the text of one line of knowledge.md> — <why>; no line when nothing should change`;
  - `parseJudgeReply(reply, "rules")`: `DECISION: rules`, then each line matching `/^\s*(?:[-*]|\d+[.)])?\s*\**(ADD|REMOVE)\**:?\s+(.+)$/i`, split at its last ` — ` into `text` and `why` (`why` `""` without one), the first `MAX_RULE_CHANGES` kept; no such line → `changes: []`;
  - `export function rulesQuestion(changes: RuleChange[]): string` — the report's "Standing rules to review" section: `Rules review: apply any of these with the command under it.` then one line per change, `` `${i}. ${op === "add" ? "ADD" : "REMOVE"} ${text}${why ? ` — ${why}` : ""}` ``.
- Produces, in `src/domain/run-state.ts`: `RunState.rulesReview: { changes: RuleChange[]; failed: boolean } | null` (`null` in `emptyState`). Reduce: `judge.decided` of kind `rules` → `{ changes, failed: false }`; `judge.failed` of the `rules` judge whose tries reach 2 → `{ changes: [], failed: true }`.
- Produces, in `src/domain/run-machine.ts` (Rulings 17–19); the `finish` action gains `proposals?: RuleChange[]`. The run never parks for this review:

| Event or state | Actions |
| --- | --- |
| every milestone `landed`/`merged`, not `cancelling`, `rulesReview` null, no dispatch named `judge-rules` | `judge{ input: { id: "rules", kind: "rules", unit: "run", context: <per milestone: "<M> <title>: <counts.length> review round(s), <knownIssues.length> known issue(s)">, findings: [], lanes: [] } }` (replaces plan 30's `finish{ done }` there) |
| `rulesReview` not null | `finish{ outcome: "done", proposals: rulesReview.changes }` |
| `judge.failed` of the `rules` judge at 2 tries | no `park` (plan 30's park for a failed judge skips kind `rules`); finishes with no proposals |

  The `finish` effect writes the proposals into the report under "Standing rules to review", each followed by its exact `catherd knowledge add '<text>'` or `catherd knowledge rm '<text>'` command; it applies none.

- [ ] **Step 1: Write the failing tests:**

```ts
// test/domain/judge.test.ts
it("reads a rules review's changes, at most five, and none", () => {
  expect(parseJudgeReply("DECISION: rules\n1. ADD [worker] run bun test <file> — M1 round 2\n- **REMOVE** use the v1 client — stale since M2\nSTATUS: complete — ok", "rules"))
    .toEqual({ verb: "rules", changes: [
      { op: "add", text: "[worker] run bun test <file>", why: "M1 round 2" },
      { op: "remove", text: "use the v1 client", why: "stale since M2" } ] });
  expect(parseJudgeReply("DECISION: rules\nSTATUS: complete — nothing to change", "rules")).toEqual({ verb: "rules", changes: [] });
  expect((parseJudgeReply(`DECISION: rules\n${"ADD x — y\n".repeat(7)}`, "rules") as { changes: unknown[] }).changes).toHaveLength(5);
  expect(parseJudgeReply("DECISION: retry\nWHY: x", "rules")).toBeNull();
});
it("asks the owner with one numbered line per change", () =>
  expect(rulesQuestion([{ op: "remove", text: "use the v1 client", why: "stale" }]))
    .toBe("Rules review: answer with the numbers of the changes to apply (1 3), all, or none.\n1. REMOVE use the v1 client — stale"));
```

  And in `test/domain/run-machine.test.ts` (plan 30's `feed`, `names`, a `landedAll()` fixture of a two-milestone run whose milestones both landed):
  - "reviews the rules once every milestone landed, before it finishes": the last actions hold one `judge` with `input.kind === "rules"`, `input.unit === "run"` and no `finish`; a following `dispatch.started{ name: "judge-rules" }` and a `tick` give no second `judge`.
  - "finishes at once when the judge proposes no change": `judge.decided{ kind: "rules", decision: { verb: "rules", changes: [] } }` → `finish{ outcome: "done", rules: [] }`.
  - "finishes at once with the proposals, applying none": two changes → no `park`; `finish{ outcome: "done", rules: [], proposals: changes }`. The report lists each proposal as one numbered line followed by the exact `catherd knowledge add '<text>'` or `catherd knowledge rm '<text>'` command, under "Standing rules to review", and the "finished" phone notice says how many proposals wait. (Owner ruling 2026-10-21, autonomy first: the run's end never waits on the owner.)
  - "finishes without a review when the rules judge fails twice": two `judge.failed` for `rules` → no `park`; `finish{ outcome: "done", rules: [] }`.
  - "a cancelled run gets no rules review": `cancel.requested` before the last landing → no `judge` of kind `rules`.
- [ ] **Step 2: Run** `bun test test/domain/judge.test.ts test/domain/run-state.test.ts test/domain/run-machine.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** as above; plan 30's existing judge and finish tests keep passing (a run whose milestones landed now ends through the review: update plan 30's "finishes once every milestone landed" test to feed `judge.decided` with no change before it expects `finish`).
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): a finished run asks a judge to review its standing rules, and the owner approves"`

### Task 7: the review's brief, the applied rules and the report

**Files:**
- Modify: `src/services/run-briefs.ts` (`judgeBrief` for kind `rules`), `src/services/run-effects.ts` (the `finish` effect), `src/services/run-report.ts` (`writeRunReport` gains `rules: string[] = []`, the `## Rules review` section)
- Test: `test/services/run-briefs.test.ts`, `test/services/run-effects.test.ts`, `test/services/run-report.test.ts`

**Interfaces:**
- Consumes: Task 1 (`addKnowledge(repo, text, now, source)`, `removeKnowledge`, `knowledgeLines`), Task 6 (`RuleChange`, `RunState.rulesReview`), X1, X2.
- Produces:
  - `export const RULES_REVIEW_BRIEF` in `run-briefs.ts`, exact copy:

```
Rules review: this run is over. Read its events.jsonl, digests/ and lanes/ with read_run_file, and the repo's standing rules with read_knowledge (one rule per line; a [role, …] tag after the source scopes a line to those roles). Propose at most five changes, each with the event it comes from: a one-line rule that would have prevented a review round, a failed check, a climb or a question (tagged [role, …] when it is not for every role), or the removal of a line that is stale, covers one past incident only, or repeats another. Propose no change when none would have helped. Write nothing.
```

    `judgeBrief(run, input)` for kind `rules` is `RULES_REVIEW_BRIEF`, a blank line, then `input.context`, then plan 30's verbs line for the kind.
  - `## Rules review` in `report.md`, after `## Audit`: `failed` → `No rules review: the judge gave no readable answer.`; no change → `The judge proposed no change to the standing rules.`; else the `rulesQuestion` lines, each change followed by its command, `catherd knowledge add '<text>'` for an ADD and `catherd knowledge rm '<text>'` for a REMOVE (single quotes inside the text escaped as `'\''`). A run with `rulesReview` null (cancelled, failed) has no section. The `finish` effect writes `knowledge.md` never.

- [ ] **Step 1: Write the failing tests:**
  - `test/services/run-briefs.test.ts`, "gives the rules judge the review brief, its context and nothing of a lane": `judgeBrief(run, { id: "rules", kind: "rules", unit: "run", context: "M1 t: 2 review round(s), 1 known issue(s)", findings: [], lanes: [] })` starts with `RULES_REVIEW_BRIEF`, contains the context, and contains no `lanes/` file text.
  - `test/services/run-report.test.ts`, "lists each proposal with its command and applies none": `finish{ outcome: "done", proposals: [{ op: "add", text: "[worker] run bun test <file>", why: "M1 round 2" }, { op: "remove", text: "use the v1 client", why: "stale" }] }` → `report.md`'s `## Rules review` holds both lines and `catherd knowledge add '[worker] run bun test <file>'` and `catherd knowledge rm 'use the v1 client'`; `knowledge.md` is byte-identical before and after; `run.ended{ outcome: "done" }` follows.
  - `test/services/run-report.test.ts`, "says when the judge proposed nothing or gave no answer, and has no section for a cancelled run".
- [ ] **Step 2: Run** `bun test test/services/run-briefs.test.ts test/services/run-effects.test.ts test/services/run-report.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** as above; `finish` never throws on a proposal.
- [ ] **Step 4: Run** the Step 2 command and `bun test test/services/run-daemon.test.ts`, then `bun run typecheck && bun run lint`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): the rules review's brief, the approved rules applied, and the review in the report"`

### Task 8: skill, README, migration, ideas and the changeset

**Files:**
- Modify: `plugin/skills/catherd/SKILL.md` (as plan 30 Task 10 left it), `README.md:209` (the `catherd knowledge` row), `MIGRATION.md` ("From 1.5 to 2.0", which plan 30 added), `docs/dev/ideas.md:131-134`, `test/skills.test.ts`
- Create: `.changeset/knowledge-digest.md`
- Test: `test/skills.test.ts`, `test/entry/plugin-packaging.test.ts` (unchanged; stays green)

- [ ] **Step 1: Update the test:** `expect(skill("catherd")).toContain("rules review")`.
- [ ] **Step 2: Run** `bun test test/skills.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the text.**
  - SKILL.md, two sentences in its voice, where it handles a parked unit: a finished run's last question is its rules review, on unit `run`: give the owner each numbered change in one line, then pass the numbers they agree to, `all` or `none` (`answer(run, "run", "1 3")`); a rule for some roles only is written `catherd knowledge add "[worker, reviewer] <rule>"`.
  - README row 209: `` `catherd knowledge show [--role <role>]\|add "<line>"\|rm "<text>"\|path [--repo <path>]` ``, its description adding "a `[role, …]` tag after the source scopes a line to those roles' briefs; `rm` removes the one line the text matches".
  - MIGRATION, "From 1.5 to 2.0", one bullet each: `knowledge.md` lines are standing rules in every brief, a `[role, …]` tag scopes one; a finished run asks you to approve its rules review before it ends; a lane whose `After:` can never finish now stops preflight.
  - `docs/dev/ideas.md`: remove "A bad `After:` blocks a lane forever" (Ruling 15).
  - `.changeset/knowledge-digest.md`:

```md
---
"catherd-cli": major
---

2.0.0 (part of): knowledge.md lines are standing rules in every role's brief, and a `[worker, reviewer]` tag scopes one to those roles; `catherd knowledge rm` retires a line; a finished run ends with a rules review the owner approves. A finished research lane's answer reaches the lanes after it. Preflight lints the plan's lanes, and stops on an After: that can never finish. The run report quotes every known issue word for word, NITs included, with the review rounds, what they fixed and the gate's record.
```

- [ ] **Step 4: Run** `bun test test/skills.test.ts test/entry/plugin-packaging.test.ts`, `bun run format:check`, `bunx changeset status`. Expected: PASS; `catherd-cli` major.
- [ ] **Step 5: Commit** — `git commit -m "docs(skill): standing rules, the rules review and the richer report"`

---

Owner questions (each built as recommended):

1. Resolved by the controller (2026-10-21): the run never waits on the rules review. It ends at once; the proposals go into the report with their `catherd knowledge add|rm` commands, and the owner applies them later. The `rules` park reason, `rulesQuestion` as a park question and `pickChanges` on an answer are therefore not built; `finish` gains `proposals` instead. Task 7's implementer drops the parts of Produces that only served the park.