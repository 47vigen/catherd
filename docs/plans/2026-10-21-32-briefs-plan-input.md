# catherd 2.0, plan 32: role briefs, the reply contract and the plan as input — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every role the daemon dispatches gets its role text, its team and its done-when as labelled sections, with the rules t3herd's runs taught; replies gain `EXTRA:`, `REJECTED:` and `DESIGN:` beside 30b's `HEAD:` and blocked reasons; and a run starts from a reviewed plan: `run_start` takes `plan:`, each lane names the plan tasks it implements and its worker gets them verbatim, a run without a plan waits for the owner's approval of the architect's deep plan before its first lane (and again when a later architect change edits an approved decision line), and preflight refuses a lane with no task behind it or a task with neither a signature nor a test.

**Architecture:** Domain: `role-prompts.ts` holds each role's parts and renders them (`roleSections`); `brief.ts`'s `composeBrief` wraps the daemon's brief as `<task>` between them; `record.ts` gains three reply parsers; a new pure `plan-doc.ts` parses plan files into a preamble and tasks and judges coverage and depth; `lane.ts` reads a `Tasks:` header line. Services: a new `plan-input.ts` resolves, copies and reads the run's plan files; plan 30's `run-client.ts` (`runStart`, `answerUnit`), `run-briefs.ts` (`briefFor`'s bodies), `run-report.ts` and `run-effects.ts` (`readPlan`), and `preflight.ts` use it. The approval stop is plan 30's machine (`run-state.ts`, `run-machine.ts`): `plan.ready` with no plan input enters phase `approval` and parks the run; the client turns an approving answer into `plan.approved{ by: "owner" }` and keeps the approved text as `<run>/plan-approved.md`; after that, `readPlan` parks the run in `approval` again when plan.md's `D<n>` lines differ from it.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, `@modelcontextprotocol/sdk`. No new dependency.

**Spec:** `docs/specs/2026-10-12-catherd-2.0-design.md`, decisions 17 and 22. Binding earlier plans: `docs/plans/2026-10-21-30-run-daemon.md` (Design, Produces, Rulings), `docs/plans/2026-10-21-30b-unattended.md` (its "Produces for plan 32"). Input draft (not binding): `docs/plans/drafts-1.6/2026-10-12-28-role-briefs.md`. t3herd 71cbb6a: `prompts/_brief.md`, `_team.md`, `_contract.md`, `role/{reviewer,fixer,worker,verifier,architect}.md`. The depth checklist is grounded in sanitell/platform's `docs/plans/2026-09-28-payment-6-ledger.md` and `…-payment-0-contracts.md` (read-only, in <your clone>).

**Pre-validation: spiked the plan-task parser (Task 2's task heading, its section end and its signature and test markers) against the payment ledger plan (10 tasks, all with both), its contracts file (no task: its whole text is preamble, 50 KB) and catherd plans 23, 30 and 30b (34 tasks, every one with a signature or a test), and against a prose-only task (neither), targeted tests only; the full gate runs at execution.** Written against `main` at 2061e6e; it executes after plans 28, 29, 30, 30b and 31 merge, so re-find every hunk by context, and every plan-30 file by its Produces name.


Owner answers of 2026-10-21 are folded into Tasks 2, 4, 7–9 and Rulings 12 and 16.

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`): `role-prompts.ts`, `brief.ts`, `record.ts`, `lane.ts`, `plan-doc.ts` are domain (no `node:fs`); `plan-input.ts` is a service and imports neither `admission.ts` nor `run-effects.ts`.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`; executors run each task's targeted files, the full gate once per wave.
- Everything in plan 30's Global Constraints: no live model, no wall-clock sleep, tests delete `ANTHROPIC_API_KEY` and `TYPESAFE_API_KEY`, events appended only by effects and clients.
- **No new event or action type, and no new field on an event.** This plan uses plan 30's `run.started.plan`, `plan.ready`, `plan.approved{ by }`, `question.parked`/`question.answered`, `effect.failed`, the `dispatch`, `park` and `readPlan` actions, `RUN_UNIT`, the `approval` phase and park reason. New data lives on `RunRecord` (optional fields) and in run files.
- `docs/plans/drafts-1.6/` stays on the branch: Task 3 cites draft 28's copy by line (no plan deletes the drafts).
- Keep 30b's `parseReplyHead`, `RunRecord.head`, the verifier's `HEAD:` sentence and `BLOCKED_LINE` in every contract, unchanged.
- Commits: conventional, subject ≤ 100 characters, lower-case first word after the scope, no plan ids; check `git log` after each.
- The reply lines, verbatim (separator `—`, `–` or `-` with whitespace around it, as `STATUS:` accepts):
  - worker: `EXTRA: <path> — <why>`, one per file outside its lane it had to change;
  - worker in a fix round: `REJECTED: <the finding's first words> — <why>`, one per finding it rejects;
  - worker: `DESIGN: <task> — <the conflict> — <the change you propose>`, then `STATUS: blocked — needs_user: <one line>`.
- Section order, fixed: `role`, `team`, `context`, `task`, `done_when`, `reply_contract`; a section with no text is left out.
- Spec, verbatim: "each headless role gets its role text, its team and its done-when rules in its brief. The reviewer, fixer, worker and verifier get the rules the 1.6 plan 28 lists. New reply lines: `HEAD:`, `EXTRA:` and `REJECTED:`." · "`run_start` takes `plan: <path>[, <path>…]`. Every lane maps to plan tasks and is told to implement them as written, with a `DESIGN:` reply on any conflict." · "Without a plan, the architect first writes one to that depth: exact signatures and data shapes, an inventory of existing code with paths, a contracts section for shared names, decisions with rejected alternatives, and a test per task. The run waits for the owner's approval of that plan before the first lane. This is the run's one planned stop." · "Preflight refuses a lane that has no plan task behind it, or a plan task with neither a signature nor a test."

## Review Focus

1. **The owner answers the approval question with changes, then approves.** Expected: no lane is routed before `plan.approved{ by: "owner" }`; a change request resumes the architect's thread with the answer and parks again on the new plan; only a bare approving word approves. Task 7: "waits in approval for the owner, revises on a change request and routes only after the approval", Task 4: "turns an approving answer into plan.approved, and any other into a change request".
2. **A lane's `Tasks:` names a task in no plan file, or a number two plan files share.** Expected: refused with the lane, the ref and the fix (`write <file>#<n>`); never resolved to the wrong task. Task 2: "resolves a task ref, refusing a missing task and a number two files share".
3. **`plan:` is relative, outside the repo, missing or a directory.** Expected: a relative path resolves against the repo; an absolute path outside it is accepted; a missing one or a directory is refused with `E_INPUT_INVALID` before any run folder exists. Task 4: "refuses a missing plan file before creating the run".
4. **The owner fixes the plan file after preflight parked a milestone.** Expected: the answer re-copies the plan files, the milestone re-routes and preflight passes on the fixed text. Task 4: "copies the plan files again on every answer", Task 8: "refuses a lane with no task and a task with neither a signature nor a test, naming each".
5. **A failover stand-in reruns an already composed brief.** Expected: one `<role>`, one `<task>`, one lane file, one notes block; the lane file as it stands now. Task 5: "writes each section once when a failover stand-in reruns an earlier brief".

## Rulings

1. Ruling: `HEAD:` (parser, record field, contract sentence) is 30b's; this plan adds only the verifier body's "record HEAD first" step — 30b Produces it for 32 — none.
2. Ruling: the draft's fix-brief routing (`fix-brief.ts`, the "confirm first" marker) is not built — plan 30's machine routes findings (owner lane, else the judge) and 30b adds the log tail — none.
3. Ruling: `EXTRA:` is stored on the record and listed in the reviewer's brief beside undeclared out-of-lane files; `dispatchHints` is unchanged — no 2.0 session reads hints, and plan 30's commit already stages `violations` — none.
4. Ruling: a `DESIGN:` reply ends `blocked — needs_user`, so 30b sends it to the judge (`question`), told to answer only what the plan settles and to `ask_owner` otherwise — decisions 3 and 5, no new transition — a judge answer that bends the plan costs one lane attempt, and is audited.
5. Ruling: plan files are copied to `<run>/plan-input/` at `run_start` and on every owner answer; catherd and roles read only the copies — isolated roles cannot read outside the repo, and an answer is when the owner has fixed the plan — an edit without an answer waits for the next one.
6. Ruling: a lane names its tasks on a `Tasks: <ref>, …` header line, `<ref>` = `<n>` or `<plan file basename>#<n>` — catherd reads lanes by their header — a lane doing half a task names the whole task.
7. Ruling: catherd inlines a lane's tasks verbatim into its worker's and fix worker's brief, and the milestone's into the reviewer's; lane files copy no task text — copies drift; the ledger run's workers implemented the written task — a long task costs input tokens per dispatch.
8. Ruling: `<context>` holds each plan file's preamble (before its first `## M<n>` or task heading; a file with no task is all preamble), for every role but the architect and the judge; past `PLAN_CONTEXT_MAX = 100_000` characters it names the copies — the ledger preamble (16 KB) plus contracts (50 KB) is the evidence — a bigger plan's isolated workers see only names.
9. Ruling: the signature and test markers are Task 2's regexes — spiked on 44 real tasks — a task whose only test is an `Expected:` line passes (ideas.md follow-up).
10. Ruling: preflight's refusal applies to daemon runs only, to the milestone it checks, before the confirm list and before any check, as `cannot-start` results, which plan 30 parks (reason `preflight`) — 1.5 runs never reach 2.0 — none.
11. Ruling: `readPlan` checks coverage over every lane and, with no plan input, plan.md's depth; a problem is `effect.failed{ action: "readPlan" }`, which re-dispatches the architect on its thread with it, twice, and parks the run (`effect`) on the third — the architect can fix it; plan 30 re-ran `readPlan`, which fixes nothing — an owner's task lacking both still meets preflight's refusal.
12. Ruling: the architect's plan is `<run>/plan.md`, never committed — roles never commit and the approval is the review; owner answer, 2026-10-21 — none.
13. Ruling: an approving answer is `approve`, `approved`, `yes`, `ok` or `lgtm` alone (case, a trailing `.`/`!` ignored); anything else asks for changes — "ok but rename X" must not approve — an owner typing "sure" gets one revision round.
14. Ruling: an approval appends `plan.approved{ by: "owner" }` and no `question.answered`; `reduce` closes the question on it — plan 36 Ruling 12 would count both — none.
15. Ruling: with plan input `runStart` appends `plan.approved{ by: "input" }` after `run.started`; a `plan:` A-line is plan input too and stays an A-line — plan 36 reads `by: "input"`; plan 30 and the 1.5 skill used the A-line — none.
16. Ruling: an architect change after approval (a judge `architect` route) parks for a second approval only when it edits a decision line of the approved plan: `readPlan` compares `decisionLines` of plan.md with `<run>/plan-approved.md` (written by `answerUnit` on each owner approval) and, on any added, removed or changed `D<n>`, appends `question.parked{ unit: RUN_UNIT, question: reapprovalQuestion(run, ids), reason: "approval" }` before `plan.ready`, reusing the approval park, `answerUnit`'s approval answer and `plan.approved{ by: "owner" }`; any other change needs none — owner answer, 2026-10-21 — a decision restated in other words parks once more.
17. Ruling: no lane kind is exempt from `Tasks:` and the signature-or-test rule — the spec names none — a plan with a test-less docs task parks at that milestone's preflight.
18. Ruling: the draft's commit-style skill text is dropped (the daemon commits, plan 30 Ruling 11); its MR-title line stays — the session still opens the MR — none.
19. Ruling: a task behind two lanes is not refused — not asked; the lanes' shared files are caught by Owns — none.
20. Ruling: `write_run_file` refuses `plan-input/` and `plan-approved.md` — the approved design is the owner's — none.
21. Ruling: `withReplyContract` is deleted with its test — no caller — none.
22. Ruling: no `docs/dev/ideas.md` entry is closed (grep: none is about briefs or plan input); Task 9 adds one — none.

## Cross-plan interfaces

- **Consumes from plan 30** (exact names): `RunState` (`phase`, `plan`, `questions`, `dispatches`, `failedEffects`), `reduce`, `next`, the `dispatch`/`park`/`readPlan` actions, `RUN_UNIT`, `run.started`, `plan.ready`, `plan.approved`, `question.parked`/`question.answered`, `effect.failed`, `BriefKind`, `briefFor`, `judgeBrief`, `planOf`, `writeRunReport`, `endedEvent`, `realEffects`' `readPlan` and `route` effects, `isDaemonRun`, `replayRun`, `appendEvent`, `runStart`, `answerUnit`, the `run_start` session tool. Assumed: the `route` effect turns preflight's `cannot-start` results into `preflight.done.blocking` (`{ lane, note }`).
- **Consumes from 30b:** `BLOCKED_LINE`, `parseReplyHead`, `RunRecord.head`, the `needs_user` → judge `question` transition, `CHECK_LOG_TAIL_LINES` in the `fix` body.
- **Produces for plan 31 (already merged):** none new; the panel's answer box reaches the approval through `answerUnit`, and `RunView.phase` shows `approval`.
- **Produces for plan 33:** nothing. Spec decision 22's "Coding workers never run below medium effort, and routing does not put cost ahead of that floor" is routing: plan 33 owns it.
- **Produces for plan 34:** `BriefContext.context: string | null` (34 appends the role's standing rules after the plan preamble); `planDocs(run)` and `PlanDoc` for its plan lint, which must not warn that a lane "only points at another plan" when it has a `Tasks:` line (catherd inlines the task).
- **Produces for plan 36:** `plan.approved{ by: "owner" | "input" }` exactly as Rulings 14–15; the scorecard prompts ("implement the plan at {plan}") become `plan:` through the skill (Task 9).

## Parallelism

| Wave | Tasks | Files |
| --- | --- | --- |
| 1 | 1 ∥ 2 ∥ 3 | 1: `src/domain/record.ts`, `src/services/finalize.ts`, tests · 2: `src/domain/{plan-doc,lane}.ts`, tests · 3: `src/domain/role-prompts.ts`, tests |
| 2 | 4 ∥ 7 | 4: `src/services/{plan-input,run-client,run-service}.ts`, `src/entry/mcp/session-tools.ts`, tests · 7: `src/domain/{run-state,run-machine}.ts`, tests |
| 3 | 5 ∥ 6 ∥ 8 | 5: `src/domain/brief.ts`, `src/services/admission.ts`, brief tests · 6: `src/services/{run-briefs,run-report}.ts`, tests · 8: `src/services/{run-effects,preflight}.ts`, tests |
| 4 | 9, then 10 | skill, README, MIGRATION, ideas, `test/skills.test.ts` · `.changeset/briefs-plan-input.md` |

---

### Task 1: the EXTRA, REJECTED and DESIGN lines on the record

**Files:**
- Modify: `src/domain/record.ts:44-85` (schema), `:87-103` (parsers)
- Modify: `src/services/finalize.ts:203-231` (beside `parseReplyEnvironment` and 30b's `head`)
- Test: `test/domain/record.test.ts`, `test/services/dispatch.test.ts`

**Interfaces:**
- Produces, `src/domain/record.ts`:
  - `parseReplyExtras(reply: string): { path: string; why: string }[]` — every `EXTRA: <path> — <why>` line (optional `- `/`* ` bullet, backticks stripped from the path, `why` "" when absent).
  - `parseReplyRejections(reply: string): { finding: string; why: string }[]` — every `REJECTED:` line, split at the first separator.
  - `parseReplyDesign(reply: string): string[]` — the trimmed value of every `DESIGN:` line.
  - `RunRecordSchema` gains `extras: z.array(z.object({ path: z.string(), why: z.string() })).optional()`, `rejected: z.array(z.object({ finding: z.string(), why: z.string() })).optional()`, `design: z.array(z.string()).optional()`.
- One line regex for EXTRA and REJECTED (draft-spiked): `^[ \t]*(?:[-*][ \t]*)?<LABEL>:[ \t]*(\S.*?)(?:[ \t]+(?:—|–|-)[ \t]+(.*?))?[ \t]*$`, flags `gm`.

- [ ] **Step 1: Write the failing tests.** In `test/domain/record.test.ts`, `it("reads EXTRA:, REJECTED: and DESIGN: lines as loosely as STATUS")`:

```ts
const reply = ["did it", "EXTRA: src/a-b.ts — the type moved there", "- EXTRA: `go.sum` - a new module", "EXTRA: lone.ts",
  "EXTRA:   ", "REJECTED: BUG src/a.ts:3 — the caller never passes an empty list – see src/b.ts:9",
  "DESIGN: Task 3 — Post(ctx, s, e) clashes with ledger.Post(ctx, e) — take the store first",
  "STATUS: blocked — needs_user: Task 3's signature clashes"].join("\n");
expect(parseReplyExtras(reply)).toEqual([{ path: "src/a-b.ts", why: "the type moved there" }, { path: "go.sum", why: "a new module" }, { path: "lone.ts", why: "" }]);
expect(parseReplyRejections(reply)).toEqual([{ finding: "BUG src/a.ts:3", why: "the caller never passes an empty list – see src/b.ts:9" }]);
expect(parseReplyDesign(reply)).toEqual(["Task 3 — Post(ctx, s, e) clashes with ledger.Post(ctx, e) — take the store first"]);
expect(parseReplyExtras("none\nSTATUS: complete — x")).toEqual([]);
```

  In `test/services/dispatch.test.ts`, beside "records a reply's ENV: line…", `it("records a reply's EXTRA:, REJECTED: and DESIGN: lines")`: a reply with one of each → the record matches `{ extras: [{ path: "src/other.ts", why: "needed" }], rejected: [{ finding: "BUG a", why: "stale diff" }], design: ["Task 2 — x — y"] }`; the existing "flags an ok run…" record has none of the three keys (`"extras" in record` is false).
- [ ] **Step 2: Run** `bun test test/domain/record.test.ts test/services/dispatch.test.ts`. Expected: FAIL (missing exports).
- [ ] **Step 3: Implement** the parsers and fields; finalize sets `...(extras.length ? { extras } : {})` and the same for `rejected` and `design`.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(reply): parse EXTRA, REJECTED and DESIGN lines onto the record"`

### Task 2: plan files as a preamble and tasks, and a lane's Tasks: line

**Files:**
- Create: `src/domain/plan-doc.ts`; Test: `test/domain/plan-doc.test.ts`
- Modify: `src/domain/lane.ts:8-18` (`LaneHeader.tasks`), `:79-93` (`parseLaneHeader`), `:96-109` (`orderProblems`); Test: `test/domain/lane.test.ts`

**Interfaces:**
- Produces, `src/domain/plan-doc.ts`:

```ts
export interface PlanTask { doc: string; id: string; title: string; text: string; signature: boolean; test: boolean }
export interface PlanDoc { name: string; preamble: string; tasks: PlanTask[] }
export const TASK_HEADING = /^#{2,4}[ \t]+Task[ \t]+(\d+[a-z]?)\b[ \t]*[:.—–-]?[ \t]*(.*)$/gim;   // spiked
export function parsePlanDoc(name: string, text: string): PlanDoc;
export const TASK_REF = /^(?:([^\s#,]+)#)?(\d+[a-z]?)$/;
export function resolveTask(docs: PlanDoc[], ref: string): PlanTask | string;              // string: why not
export function coverageProblems(docs: PlanDoc[], lanes: { id: string; tasks: string[] }[]): { lane: string; note: string }[];
export const DEPTH_SECTIONS = ["What already exists", "Contracts", "Decisions"] as const;
export function depthProblems(doc: PlanDoc): string[];
export const APPROVE_WORDS = ["approve", "approved", "yes", "ok", "lgtm"] as const;
export function isApproval(answer: string): boolean;
export function approvalQuestion(runId: string): string;
export function decisionLines(text: string): Map<string, string>;                          // D<n> → its line, trimmed, from the Decisions section
export function changedDecisions(approved: string, now: string): string[];                 // D<n> ids added, removed or edited, in number order
export function reapprovalQuestion(runId: string, ids: string[]): string;
export function planInputNames(paths: string[]): string[];                                  // basenames; a repeat gets -2 before its extension
```

- `parsePlanDoc`: a task runs from its heading to the next task heading, or to the next `## ` heading after its own line, whichever is first (the spiked rule: `body.slice(firstNewline).search(/^##[ \t]+(?!#)/m)`); `preamble` is the text before the first `## M<n>` heading or the first task, whichever is first, and the whole text when there is neither. `signature` and `test` per Ruling 9, as regexes: signature `/^[ \t]*(?:[-*][ \t]*)?\**(?:Interfaces|Produces|Signatures?)\**[ \t]*:/im`, `/^[ \t]*```/m`, `` /`[^`\n]*\w\([^`\n]*\)[^`\n]*`/ ``; test `/^[ \t]*(?:[-*][ \t]*)?\**Tests?\**[ \t]*:/im`, `/[\w./-]*(?:\.test\.|_test\.|\.spec\.|\btest_)[\w.]*/`, `` /\b(?:it|test|describe)\(\s*["'`]|\bfunc Test\w+|\bdef test_\w+|#\[test\]/ ``, `/^[ \t]*(?:[-*][ \t]*)?\**Expected\**[ \t]*:/im`.
- `resolveTask` whys, exact: `no plan file <x>` · `no task <n> in <names joined ", ">` · `task <n> is in <a> and <b>: write <a>#<n>`.
- `coverageProblems` notes, exact: `lanes/<id>.md has no Tasks: line: name the plan tasks it implements` · `lanes/<id>.md: Tasks: <ref> — <why>` · `<doc> Task <n> has neither a signature nor a test: add its signatures (a code block or an Interfaces: line) or a Test: line`.
- `depthProblems` (a `## <section>` heading, case-insensitive prefix): `plan.md has no "## <section>" section` per missing one · `plan.md has no "### Task <n>:" heading` · `plan.md Task <n> has no test: add a Test: line naming its test file and case` · `plan.md D<n> names no rejected alternative: write D<n> — <choice> — rejected: <alternative> — <why>` (each line of Decisions starting `D<n>` with no `rejected`) · `plan.md's What already exists lists no path` (no backticked token with a `/` or a `.ext`).
- `approvalQuestion(id)`, exact: ``The architect's plan is ready for your review: catherd run-file read ${id} plan.md. Answer approve, or say what to change.``
- `reapprovalQuestion(id, ids)`, exact: ``The architect changed approved decisions ${ids.join(", ")} of plan.md: catherd run-file read ${id} plan.md. Answer approve, or say what to change.``
- `decisionLines`: each line of the `## Decisions` section starting `D<n>` (after an optional `-`/`*` and `**`), keyed by `D<n>`, whitespace collapsed.
- `lane.ts`: `LaneHeader.tasks: string[]` (`list("tasks")`); `orderProblems` adds `Tasks "<ref>" is not a task number like 3 or plan.md#3` for a ref failing `TASK_REF`. `assertLaneHeader` does not require the line (Ruling 10: preflight does).

- [ ] **Step 1: Write the failing tests** in `test/domain/plan-doc.test.ts`:

```ts
it("splits a plan into its preamble and its tasks, each ending at the next ## heading", () => {
  const d = parsePlanDoc("p.md", "# P\nGoal: x\n\n## M1 — one\n\n### Task 1: add login\nAdd a login page.\n\n### Task 2: store\n**Interfaces:** `saveUser(u: User): Promise<void>`\n\n### Task 3: tests\nTest: `src/a.test.ts` — \"refuses a bad token\"\n\n## Contracts\nnames\n");
  expect(d.preamble).toBe("# P\nGoal: x\n\n");
  expect(d.tasks.map((t) => [t.id, t.title, t.signature, t.test])).toEqual([["1", "add login", false, false], ["2", "store", true, false], ["3", "tests", false, true]]);
  expect(d.tasks[2]?.text).not.toContain("## Contracts");
});
it("reads a plan with no task as all preamble", …);                               // contracts-style file
it("resolves a task ref, refusing a missing task and a number two files share", () => {
  const docs = [parsePlanDoc("a.md", "### Task 3: x\n```\n```\n"), parsePlanDoc("b.md", "### Task 3: y\nTest: t.test.ts\n")];
  expect(resolveTask(docs, "b.md#3")).toMatchObject({ doc: "b.md", title: "y" });
  expect(resolveTask(docs, "3")).toBe("task 3 is in a.md and b.md: write a.md#3");
  expect(resolveTask(docs, "9")).toBe("no task 9 in a.md, b.md");
  expect(resolveTask(docs, "c.md#3")).toBe("no plan file c.md");
});
it("names a lane with no Tasks: line, an unresolved ref and a task with neither a signature nor a test", …);   // the three notes, exact
it("asks a written plan for the three sections, a test per task and a rejected alternative per decision", …);  // each note once; a full fixture → []
it("approves only on a bare approving word", () => {
  expect(["approve", " Approved. ", "LGTM!", "ok", "yes"].every(isApproval)).toBe(true);
  expect(["ok but rename X", "approve after Task 2 changes", "", "no"].some(isApproval)).toBe(false);
});
it("names the decisions a revised plan added, removed or edited, and none for other edits", () => {
  const a = "## Decisions\nD1 — x — rejected: y — z\nD2 — p — rejected: q — r\n\n### Task 1: t\nTest: a.test.ts\n";
  expect(changedDecisions(a, a.replace("### Task 1: t", "### Task 1: renamed"))).toEqual([]);
  expect(changedDecisions(a, a.replace("D2 — p", "D2 — p2"))).toEqual(["D2"]);
  expect(changedDecisions(a, a.replace("D1 — x — rejected: y — z\n", ""))).toEqual(["D1"]);
});
it("names plan copies by basename, numbering a repeat", () =>
  expect(planInputNames(["/a/plan.md", "/b/plan.md", "/c/x.md"])).toEqual(["plan.md", "plan-2.md", "x.md"]));
```

  In `test/domain/lane.test.ts`: `it("reads a Tasks: line, and refuses a ref that is not a task number")`: `Tasks: 3, plan.md#4a` → `["3", "plan.md#4a"]`; `assertLaneValues` with `Tasks: three` throws `E_LANE_INVALID` containing `Tasks "three"`; no line → `tasks: []`.
- [ ] **Step 2: Run** `bun test test/domain/plan-doc.test.ts test/domain/lane.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `plan-doc.ts` and the lane changes.
- [ ] **Step 4: Run** the Step 2 command and `bun test test/services/lane-edit.test.ts test/services/preflight.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(plan): read plan files as tasks, and a lane's Tasks: line"`

### Task 3: every role's text in sections, with what t3herd's runs taught

**Files:**
- Modify: `src/domain/role-prompts.ts` (every role's text, `CONTRACTS`, `rolePrompt`; delete `withReplyContract`)
- Test: `test/domain/agents.test.ts`, `test/domain/verifier-prompt.test.ts`, `test/services/dispatch-protocol.test.ts`

**Interfaces:**
- Produces:
  - `export const SECTIONS = ["role", "team", "context", "task", "done_when", "reply_contract"] as const;`
  - `export function roleSections(role: Role, version: string, o?: { context?: string | null; task?: string }): string` — each section with text as `<name>\n<text>\n</name>`, joined by a blank line, in `SECTIONS` order, no trailing newline. `role` = the role's body without its reply paragraph, plus `EVERY_ROLE`; `team` = `TEAM`, a blank line and `TEAM_LINE[role]`; `done_when` = `DONE_WHEN[role]`; `reply_contract` = `CONTRACTS[role]` (30b's `BLOCKED_LINE` and `HEAD:` sentence included).
  - `rolePrompt(role, version)` = `roleSections(role, version)`; `replyContract(role)` unchanged.
- Every role of plan 30's `ROLES`, the judge included (its body and `JUDGE_CONTRACT` are plan 30's, kept).
- Exact copy: **draft 28 Task 2's "Exact new copy" (`docs/plans/drafts-1.6/2026-10-12-28-role-briefs.md:169-178`), verbatim**, with "the orchestrator" read as "catherd" throughout, minus its `CONTRACTS.verifier` item (30b's), and with these changes (tests pin each with `toContain`; keep every sentence today's tests, plan 30's and 30b's pin):
  - `TEAM`, replacing the draft's: "A catherd run turns an approved plan into landed milestones. Each role is a separate model, often from another vendor, with no memory of the others: they share only the plan, the run's files, the repository and what catherd passes on. catherd runs the loop: it briefs every role, reads every reply, reruns each lane's fast check and commits; roles never commit. The architect turns the plan into milestones and lanes, or, with no plan given, writes the plan the owner approves. Workers implement the plan tasks behind their lanes, side by side in one checkout; in a fix round a worker fixes the review's findings in its lane's files. A writer writes the docs, a researcher maps the code or answers a question, an artist makes images. The reviewer reads the milestone's diff against its plan tasks for unmet acceptance lines, bugs, missed edge cases, code nobody needs, tests that assert nothing and patterns done differently from sibling code; the ui-reviewer screenshots the changed screens. The verifier runs the milestone's full check and exercises the acceptance lines through the real entry point. The judge makes the one decision no rule covers. A milestone lands only when its verifier passes on the commit that lands."
  - `TEAM_LINE.worker` begins "Before you: the approved plan's tasks and the architect's lane file." (the draft's rest kept); `TEAM_LINE.judge`: "You are the judge. Before you: catherd's loop met a case no rule decides: a finding no lane owns, a worker's question or design conflict, an unexpected stop. After you: catherd acts on your decision at once, and lists it in the merge request's audit."
  - Reviewer: its BUG bullet adds "a change that departs from its plan task with no DESIGN: answer behind it".
  - Worker, first after "Change only the files you own…": "Your brief holds the plan tasks behind your lane, verbatim. Implement them as written: their files, signatures, names, data shapes and tests. A task's commit steps are not yours: catherd commits." · "When a task conflicts with the code (a signature that cannot compile against what exists, a name the code already uses for something else, a test the design cannot pass), do not redesign it: leave that part, and reply DESIGN: <task> — <the conflict> — <the change you propose>, then STATUS: blocked — needs_user: <the conflict in one line>." In the draft's weakened-check sentence "unless your lane asks" reads "unless your task asks"; its fix-round sentence reads "check each finding against the code and your tasks".
  - Architect, replacing today's "When the acceptance lines include plan:" paragraph and "Write plan.md with exactly these parts" list (the draft's `Reference:` addition kept):
    - "When your brief lists the owner's plan files, the design is written and approved, and there is no dossier. Translate it, do not design: each plan task goes to exactly one lane, whole, and each merge request or phase becomes a milestone with its full check. A lane's Tasks: line names its tasks; catherd puts each task's text, verbatim, into its worker's brief, so a lane file carries its header and only what the plan leaves undecided. When the acceptance lines name only some tasks, lane only those. Write plan.md as its milestones (`## M<n> — <title>`, its acceptance lines and `Check:`), and put a decision the plan leaves open under `## Decisions`."
    - "With no plan given, you write the design, to the depth of a plan the owner reviews before any code exists: the run waits for the owner's approval of your plan.md, its one planned stop; after that, a change to a decision line (D<n>) waits for the owner's approval again, so change one only when the code forces it. Write plan.md with exactly these parts, in this order:" 1 `## What already exists`: "every file, type and function the work calls or changes, as `path` — `signature` — what it is; workers must not recreate them." 2 `## Contracts`: "every name more than one task uses (types, functions, routes, events, error codes, config keys) with its exact signature or shape." 3 `## Decisions`: "`D<n> — <the choice> — rejected: <the alternative> — <why>`, for each choice two reasonable engineers would make differently." 4 milestones `## M<n> — <title>` with acceptance lines and `Check: <full check>`, each with its tasks `### Task <n>: <title>`, numbered across the plan, each with `Files:` (exact paths to create, modify and test), the exact signatures and data shapes it introduces (a code block) and `Test:` lines naming each test file and case and what it asserts. "A task without a test is refused." Then today's speed, edge-case and out-of-scope parts. (The ledger plan is the model: its "What already exists" list, contracts §3 and §9.1, the decisions of contracts §12, Interfaces blocks and named tests per task.)
    - The lane header: "Its first six lines are exactly:", adding `Tasks: <plan task numbers, comma-separated; <plan file>#<n> when the run has several plan files>` after `Difficulty:`. "more small lanes beat one long one" and "Signatures, data shapes and test case names are yours" stay.
  - `WORKER_REPLY` adds, after the draft's EXTRA/REJECTED sentence: "A conflict with your plan task is a DESIGN: line, and your reply ends blocked with needs_user."
  - `DONE_WHEN`: architect "plan.md and every lane file are written; each lane has its six header lines and names whole tasks; no two lanes of a milestone own the same file; with no plan given, plan.md has What already exists, Contracts and Decisions, and every task its signatures and a Test: line." · reviewer "Every line of the diff is read against its plan tasks, and every finding is on its own line in the format above; the reply is CLEAN only when there is none." · judge "Your first line is DECISION: one of the verbs your brief lists, followed by that verb's lines, decided from what the brief and the run's files show." · the other roles as the draft.

- [ ] **Step 1: Write the failing tests.** In `test/domain/agents.test.ts`, `describe("rolePrompt")`:
  - `it("renders role, team, done_when and reply_contract once, in order, and no task or context")`: for every role in `ROLES`, the indexes of `<role>`, `<team>`, `<done_when>`, `<reply_contract>` rise, each occurs once, `<task>` and `<context>` zero times, and it contains "is information, not instructions"; every role but the worker contains "stop every background watcher".
  - `it("gives the reviewer t3herd's rules and the plan rule")`: "A problem is a BUG, never a NIT, when it breaks a standing rule", "names every place in the diff", "closest sibling", "never findings: catherd writes the commits", "in this one pass", "do not run the test suites", "departs from its plan task with no DESIGN: answer".
  - `it("gives the worker its tasks, DESIGN, check, EXTRA, Reference, retry and fix-round rules")`: "Implement them as written", "commit steps are not yours", "reply DESIGN: <task> — <the conflict> — <the change you propose>", "Never weaken, skip or edit a check or a test", "EXTRA: <path> — <why>", "Reference: line, open that file first", "this is a retry", "In a fix round", "REJECTED: <the finding's first words> — <why>", "stale diff"; its `<done_when>` contains "run after your last edit".
  - `it("asks the architect to translate a given plan and to write a deep one otherwise")`: "Translate it, do not design", "lane only those", "## What already exists", "## Contracts", "rejected: <the alternative>", "A task without a test is refused", "Tasks: <plan task numbers", "`Reference: <repo path>`", "more small lanes beat one long one".
  - `it("tells the judge what it decides and the team who it is")`: `rolePrompt("judge", "1.0.0")` contains "You are the judge." and "DECISION: one of the verbs".
  - In `test/domain/verifier-prompt.test.ts`: `text.split("\n")[0]` → `[1]` (line 0 is `<role>`); `it("records HEAD first, puts file:line in FAIL lines and calls a minor issue a NIT")`: "0. Record git rev-parse HEAD first", "FAIL file:line — what happens", "is a NIT line, never a FAIL".
  - In `test/services/dispatch-protocol.test.ts`: delete the "appends it once" test and the `withReplyContract` import; add `expect(replyContract("worker")).toContain("EXTRA: <path> — <why>")`, and keep 30b's `BLOCKED_LINE` assertion for every role.
- [ ] **Step 2: Run** `bun test test/domain/agents.test.ts test/domain/verifier-prompt.test.ts test/services/dispatch-protocol.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `BODIES` lose their reply paragraphs (`REPLY`, `WORKER_REPLY`, the researcher's last line), which `reply_contract` carries; add `EVERY_ROLE`, `TEAM`, `TEAM_LINE: Record<Role, string>`, `DONE_WHEN: Record<Role, string>`, `roleSections`; delete `withReplyContract`.
- [ ] **Step 4: Run** the Step 2 command and `bun test test/services/verifier-brief.test.ts test/domain/judge.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(prompts): role text in sections, with the rules from real runs and the plan's"`

### Task 4: the run's plan files: run_start, the copies, the context and the approval answer

**Files:**
- Create: `src/services/plan-input.ts`; Test: `test/services/plan-input.test.ts`
- Modify: plan 30's `src/services/run-client.ts` (`runStart`, `answerUnit`), `src/entry/mcp/session-tools.ts` (`run_start`), `src/services/run-service.ts:161-172` (`writeRunFile`)
- Test: `test/services/run-client.test.ts`, `test/entry/session-tools.test.ts`, `test/services/lanes-run.test.ts` (it pins `writeRunFile`'s lane check today)

**Interfaces:**
- Consumes: Task 2's `parsePlanDoc`, `resolveTask`, `coverageProblems`, `depthProblems`, `isApproval`, `planInputNames`, `parseLaneHeader`; plan 30's `replayRun`, `isDaemonRun`, `appendEvent`, `RUN_UNIT`.
- Produces, `src/services/plan-input.ts`:

```ts
export const PLAN_INPUT_DIR = "plan-input";
export const PLAN_CONTEXT_MAX = 100_000;
export function resolvePlanInputs(repo: string, paths: string[]): string[];   // absolute, deduped, in order; E_INPUT_INVALID otherwise
export function planInputPaths(aLines: string[]): string[];                   // from A-lines `plan: a, b` (case-insensitive label)
export function copyPlanInputs(run: Run, paths: string[]): void;               // <run>/plan-input/<planInputNames(paths)>, 0600
export function planDocs(run: Run): PlanDoc[];      // the copies, in run.started.plan order; else plan.md; [] when neither
export function planContext(run: Run, role: Role): string | null;              // Ruling 8
export function laneTasks(run: Run, lane: string): PlanTask[];                 // lanes/<lane>.md's resolved Tasks:, unresolved left out
export function milestoneTasks(run: Run, milestone: string): PlanTask[];       // its lanes' tasks, numeric lane order, deduped
export function planProblems(run: Run): string[];                              // Ruling 11: coverage of every lane, depth of plan.md with no input
export const taskBlock = (t: PlanTask): string;                                // `<plan-task file="${t.doc}" id="${t.id}">\n${t.text.trimEnd()}\n</plan-task>`
```

- `resolvePlanInputs` refusals (`E_INPUT_INVALID`), exact: `plan file <p> does not exist` · `plan <p> is not a file` · `none of the plan files has a "### Task <n>:" heading: <paths>` (fix: `pass the reviewed plan, or no plan and the architect writes one`). A relative path resolves against `repo`.
- `planContext` text per doc: `The plan's preamble (<name>), which applies to every task:\n\n<preamble trimmed>` (a doc with no task: `The plan file <name>, which every task follows:\n\n<text>`), joined by a blank line; over `PLAN_CONTEXT_MAX`: `The run's plan files are too long to repeat here; read them before you start, with read_run_file: <plan-input/... joined ", ">`. Null for `architect` and `judge`, for a run that is not a daemon run, and when `planDocs` is empty.
- `runStart(deps, i: { repo; title; aLines; plan?: string[] })`: `plan = resolvePlanInputs(top, [...(i.plan ?? []), ...planInputPaths(i.aLines)])` before `createRun`; after it, `copyPlanInputs`, `run.started{ plan, … }`, then `plan.approved{ by: "input" }` when `plan` is non-empty. The result gains `plan: string[]`; `next` with a plan: `the run implements <n> plan file(s) as written: status(run) shows it`; without: `the architect writes a plan first, and the run waits for your approval (answer approve): status(run) shows it`.
- `answerUnit`: first `copyPlanInputs(run, replayRun(run).plan)` when it is non-empty; then, when the open question of `RUN_UNIT` has reason `approval` (the first approval or a re-approval, Ruling 16) and `isApproval(answer)`, write plan.md's text to `<run>/plan-approved.md` (0600) and append `plan.approved{ by: "owner" }` only (Ruling 14); else as plan 30.
- `run_start` gains `plan: z.array(z.string().min(1)).max(20).optional()`, described: "The reviewed plan files the run implements as written (paths, relative to repo or absolute). Without one, the architect writes a plan and the run waits for your approval."
- `writeRunFile`: a path under `plan-input/`, or `plan-approved.md` → `E_INPUT_INVALID` `<path> holds the owner's approved plan; roles never write it` (fix: `write plan.md or a lane file`).

- [ ] **Step 1: Write the failing tests** (`freshRun`, `withHome()`, `tempRepo()`, `daemonLauncher` faked as in plan 30's client tests):

```ts
it("starts a run on its plan files: copies them, records them and approves them as input", async () => {
  const r = await runStart(deps, { repo, title: "t", aLines: ["A1 x"], plan: ["docs/p.md", outside] });
  expect(r.plan).toEqual([join(repo, "docs/p.md"), outside]);
  expect(readEvents(run).map((e) => e.type).slice(0, 2)).toEqual(["run.started", "plan.approved"]);
  expect(readEvents(run)[1]).toMatchObject({ by: "input" });
  expect(readFileSync(join(run.dir, "plan-input/p.md"), "utf8")).toBe(planText);
});
it("reads an A-line plan: as plan input too", …);
it("refuses a missing plan file before creating the run", async () => {
  const e = await refusal(runStart(deps, { repo, title: "t", aLines: [], plan: ["nope.md"] }));
  expect([e.code, e.message]).toEqual(["E_INPUT_INVALID", `plan file ${join(repo, "nope.md")} does not exist`]);
  expect(listRuns([repo]).runs).toHaveLength(0);
});
it("refuses plan files none of which has a task, and a directory", …);
it("starts a run with no plan and no approval event", …);                        // next names the approval
it("turns an approving answer into plan.approved, and any other into a change request", …);   // "LGTM" → plan.approved{ owner }, no question.answered, plan-approved.md = plan.md; "rename X" → question.answered, no plan-approved.md
it("copies the plan files again on every answer", …);                           // edit the original, answer M1 → the copy has the edit
it("gives every role but the architect and the judge the plan's preamble, and names the copies past the cap", …);
it("reads a lane's tasks from its Tasks: line, and a milestone's in lane order", …);
it("lists every lane's coverage problem, and plan.md's depth only with no plan input", …);
it("refuses a role's write under plan-input/ and to plan-approved.md", …);
```

  In `test/entry/session-tools.test.ts`: `it("passes run_start's plan to the client")`.
- [ ] **Step 2: Run** `bun test test/services/plan-input.test.ts test/services/run-client.test.ts test/entry/session-tools.test.ts` `test/services/lanes-run.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as the Interfaces say.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(run): run_start takes the reviewed plan, and an answer approves it or asks for changes"`

### Task 5: every brief is the role's sections around its task, with the plan as context

**Files:**
- Modify: `src/domain/brief.ts:6-16` (`BriefContext`), `:74-91` (`composeBrief`); `src/services/admission.ts:338-349`
- Modify: `test/services/helpers.ts:35-54` (the test helper `briefFor`)
- Test: `test/domain/brief.test.ts`, `test/services/admission.test.ts`, `test/services/failover-cancel.test.ts`, `test/services/verifier-brief.test.ts`

**Interfaces:**
- Consumes: Task 3's `roleSections`; Task 4's `planContext`.
- Produces: `BriefContext` gains `version: string` and `context: string | null`. `composeBrief(brief: string, c: BriefContext): string` = `roleSections(c.role, c.version, { context: c.context, task })` + `"\n"`, where `task` is today's composition (the daemon's text, the lane block, the role notes) without the contract. Admission passes `version: deps.version, context: planContext(run, i.role)`; the test helper passes `version: "0.0.0-test", context: null`.
- Idempotent: when `brief` holds `<task>\n…\n</task>`, the text between the first `<task>\n` and the last `\n</task>` is the daemon's text, then the lane block and the notes are stripped as today; today's strip of a trailing contract stays (a 1.5-era brief rerun).

- [ ] **Step 1: Write the failing tests.** In `test/domain/brief.test.ts` (draft Task 3 Step 1, verbatim in substance): the first test becomes `it("wraps the daemon's text, the lane file and the role's notes as the task, between the role's sections")` — starts `<role>\n`, contains `<team>\n`, then `<task>\nDo lane M4.L1.\n\nYour lane file, lanes/M4.L1.md, …` to the tools line, then `\n</task>\n\n<done_when>\n`, ends `<reply_contract>\n${replyContract("worker")}\n</reply_contract>\n`, contains `bunx catherd-cli@0.0.0-test lock` and no `<context>`; `it("writes each section once when a failover stand-in reruns an earlier brief")` with `again.match(/<role>/g)` and `/<task>/g` of length 1; `it("puts the plan's preamble between team and task when one is given")`: `composeBrief("x", { ...worker, context: "The plan's preamble (p.md)…" })` contains `</team>\n\n<context>\nThe plan's preamble (p.md)…\n</context>\n\n<task>\n`. The `toEndWith` assertions in `admission.test.ts`, `failover-cancel.test.ts`, `verifier-brief.test.ts` take the `<reply_contract>…</reply_contract>\n` form; in `admission.test.ts`, `it("admits a daemon run's worker with its plan's preamble as context")`.
- [ ] **Step 2: Run** `bun test test/domain/brief.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `BriefContext`, `composeBrief`, the admission arguments and the helper.
- [ ] **Step 4: Run** `bun test test/domain/brief.test.ts test/services/admission.test.ts test/services/failover-cancel.test.ts test/services/verifier-brief.test.ts test/services/dispatch-protocol.test.ts test/services/run-effects.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(dispatch): every brief carries its role's sections and the plan's preamble"`

### Task 6: briefFor's bodies carry the plan tasks, the out-of-lane files and the rejected findings

**Files:**
- Modify: plan 30's `src/services/run-briefs.ts` (`briefFor`'s `architect`, `lane`, `fix`, `review`, `recheck` bodies; `judgeBrief`), `src/services/run-report.ts` (`## Audit`)
- Test: `test/services/run-briefs.test.ts`

**Interfaces:**
- Consumes: Task 1's record fields; Task 4's `laneTasks`, `milestoneTasks`, `taskBlock`, `planDocs`, `PLAN_INPUT_DIR`; `readRecords` (`src/services/run-store.ts:214`); plan 30's `RunState.plan`, `RunState.dispatches`, `planOf`.
- Produces, by body (each body keeps plan 30's and 30b's lines and the action's `notes`):
  - `architect`: with `s.plan` non-empty, `The owner's approved plan: <PLAN_INPUT_DIR/name joined ", "> (read each with read_run_file). Lane the tasks the acceptance lines name, or every task when they name none.`; else `No plan was given: write plan.md to the depth your role text sets. The run waits for the owner's approval of it before any lane runs.`; the notes follow under `What to change:`.
  - `lane` and `fix`: `Your plan tasks. Implement them as written; where one conflicts with the code, reply DESIGN: as your role text says.` then each `taskBlock(t)` of `laneTasks(run, lane)`; `fix` adds `The fast checks of <M>'s lanes; run the ones whose files you change:` and ``- <id> (<owns joined ", ">): `<fastCheck>` `` per lane with one.
  - `review` and `recheck`: `The plan tasks this milestone implements:` and each `taskBlock` of `milestoneTasks`; then, from each lane's latest record, `Files changed outside their lane:` with `- <path> — declared by <name>: <why>` per `extras` entry and `- <path> — not declared by <name>` per other `violations` entry (left out when none).
  - `recheck` also: `A fix round rejected these findings instead of changing the code. Judge each reason: a finding whose reason holds is closed; one whose reason does not hold stands, with your answer to the reason.` and `- <name>: REJECTED: <finding> — <why>` per `rejected` row of a record of a lane of `<M>` that ended after the latest ended `reviewer-<M>` or `reviewer-<M>-2` dispatch (`s.dispatches`); left out when none.
  - `judgeBrief`, kind `question`, when `input.context` has a line starting `DESIGN:`: `The worker's DESIGN: line says the approved plan conflicts with the code. Answer only when the plan itself settles it (another task, its contracts, its decisions); a change to what the plan decided is the owner's: ask_owner.` and, for a lane unit, its `laneTasks` blocks.
  - `writeRunReport`: under `## Audit`, `- <name> DESIGN: <line>` per `design` entry of the run's records, in record order.

- [ ] **Step 1: Write the failing tests** (`freshRun` as a daemon run with `run.started{ plan }`, `writeLane` with `Tasks:`, `appendRecord`/`makeRecord`):

```ts
it("gives a lane's worker its plan tasks verbatim, and a fix worker every lane's fast check too", …);   // taskBlock text equals the task's; fix: "- M1.L2 (src/b.ts): `bun test b`"
it("tells the architect the owner's plan copies, or to write a deep plan for approval, with what to change", …);
it("gives the reviewer the milestone's tasks and every out-of-lane file, declared or not", …);   // "- src/x.ts — declared by worker-M1.L1: the type lives there", "- b.md — not declared by worker-M1.L1"
it("hands a fix round's REJECTED lines to the re-check, and none recorded before the review", …);
it("tells the judge how to treat a DESIGN line, with the lane's tasks", …);
it("lists each DESIGN line under the report's audit", …);
```

- [ ] **Step 2: Run** `bun test test/services/run-briefs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the bodies.
- [ ] **Step 4: Run** the Step 2 command and `bun test test/services/run-effects.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): briefs carry the plan tasks, out-of-lane files and rejected findings"`

### Task 7: the run waits for the owner's approval of the architect's plan

**Files:**
- Modify: plan 30's `src/domain/run-state.ts` (`reduce` on `plan.ready`, `plan.approved`), `src/domain/run-machine.ts` (the `plan.ready`, `question.answered`, `effect.failed` reactions; `advance` in phase `approval`)
- Test: `test/domain/run-state.test.ts`, `test/domain/run-machine.test.ts`

**Interfaces:**
- Consumes: Task 2's `approvalQuestion`; plan 30's types.
- Produces, as transitions (Rulings 11, 13–16):

| Event or state | Effect |
| --- | --- |
| `plan.ready`, phase `planning`/`approval`, `s.plan` empty | reduce: phase `approval` (milestones merged as plan 30 does); next: `park{ unit: RUN_UNIT, question: approvalQuestion(s.run), reason: "approval" }`, unless an `approval` question of `RUN_UNIT` is already open (a re-approval: no second park) |
| `question.parked{ unit: RUN_UNIT, reason: "approval" }`, phase `running` | reduce: phase `approval` (Ruling 16's re-approval); live lanes run on, no new lane or route |
| `plan.ready` otherwise | plan 30 (phase `running`) |
| phase `approval` | `advance` returns nothing: no route, no lane |
| `question.answered{ unit: RUN_UNIT }`, phase `approval` | `dispatch architect` (`brief: "architect"`, `thread`: the latest `architect` dispatch's, notes `[The owner asked for these changes to plan.md: <answer>]`) |
| `plan.approved` | reduce: phase `approval` → `running`, the `approval` question of `RUN_UNIT` removed; `by: "input"` changes nothing; next: advance |
| `effect.failed{ action: "readPlan" }`, phase `planning`/`approval` | while plan 30's `failedEffects` count for the `readPlan` key is ≤ 2: `dispatch architect` on its thread, notes `[<message>]`; on the third, `park{ RUN_UNIT, <message>, "effect" }` |

- [ ] **Step 1: Write the failing tests** (plan 30's `feed`, `started()`, `ev()` helpers):

```ts
it("waits in approval for the owner, revises on a change request and routes only after the approval", () => {
  const f = feed([started(), architectOk(), planReady()]);
  expect(f.state.phase).toBe("approval");
  expect(f.last).toContainEqual({ type: "park", unit: "run", question: approvalQuestion(f.state.run), reason: "approval" });
  const g = feed([...f.events, answered("run", "rename Ledger to Book")]);
  expect(g.last).toEqual([expect.objectContaining({ type: "dispatch", name: "architect", thread: "t-arch",
    notes: ["The owner asked for these changes to plan.md: rename Ledger to Book"] })]);
  expect(feed([...g.events, architectOk(), planReady()]).last.some((a) => a.type === "route")).toBe(false);
  const h = feed([...g.events, architectOk(), planReady(), ev("plan.approved", { by: "owner" })]);
  expect(h.state.phase).toBe("running");
  expect(h.state.questions.run).toBeUndefined();
  expect(h.last).toContainEqual({ type: "route", milestone: "M1", confirmed: false });
});
it("runs a plan given as input with no approval stop", …);            // run.started{ plan: ["/p.md"] }, plan.approved{ input }, architect, plan.ready → route M1
it("sends a plan the readPlan check refused back to the architect twice, then parks the run", …);
it("dispatches no lane and no route while the plan waits for approval, over every event", …);
it("stops new lanes on a re-approval park until the owner approves again", …);   // running, question.parked{ run, approval }, plan.ready → approval, one park only, no route; plan.approved{ owner } → running, route
it("keeps a mid-run architect change that edits no decision running, with no approval stop", …);   // plan.ready in phase running → running, no park
```

- [ ] **Step 2: Run** `bun test test/domain/run-state.test.ts test/domain/run-machine.test.ts`. Expected: FAIL (the new tests; plan 30's and 30b's still pass).
- [ ] **Step 3: Implement** the reduce cases and the reactions.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): a run with no plan waits for the owner's approval of the architect's"`

### Task 8: readPlan and preflight refuse lanes the plan does not back

**Files:**
- Modify: plan 30's `src/services/run-effects.ts` (the `readPlan` effect), `src/services/preflight.ts:51-95` (`LaneCheck.tasks`), `:267-284` (the refusal, before the confirm list)
- Test: `test/services/run-effects.test.ts`, `test/services/preflight.test.ts`

**Interfaces:**
- Consumes: Task 4's `planProblems`, `planDocs`; Task 2's `coverageProblems`, `changedDecisions`, `reapprovalQuestion`; plan 30's `isDaemonRun`.
- Produces: `readPlan`: `planProblems(run)` non-empty → `effect.failed{ action: "readPlan", unit: RUN_UNIT, message: "the plan needs: " + problems.join("; ") }`; else, when `<run>/plan-approved.md` exists and `ids = changedDecisions(<it>, plan.md)` is non-empty, `question.parked{ unit: RUN_UNIT, question: reapprovalQuestion(run.id, ids), reason: "approval" }` then plan 30's `plan.ready`; else plan 30's `plan.ready` alone (Ruling 16). `preflight`: for a daemon run, after the header check, `coverageProblems(planDocs(run), lanes)` non-empty → `{ needsConfirmation: false, commands, results: one { lane, check, outcome: "cannot-start", exitCode: null, tail: [], note } per problem, blocked: true, warnings: [] }`, with no check run, confirmed or not.

- [ ] **Step 1: Write the failing tests:**

```ts
// test/services/preflight.test.ts
it("refuses a lane with no task and a task with neither a signature nor a test, naming each", async () => {
  const r = await preflight(deps, { run: daemonRun.id, milestone: "M1" });
  expect(r).toMatchObject({ needsConfirmation: false, blocked: true });
  expect(r.results.map((x) => x.note)).toEqual([
    "lanes/M1.L1.md has no Tasks: line: name the plan tasks it implements",
    "p.md Task 2 has neither a signature nor a test: add its signatures (a code block or an Interfaces: line) or a Test: line"]);
  expect(ran).toEqual([]);                                            // no fast check started
});
it("refuses before the confirm list, and passes once the plan backs every lane", …);
it("leaves a run that is not a daemon run as 1.5 preflight", …);     // no Tasks: lines, no refusal
// test/services/run-effects.test.ts
it("fails readPlan with the plan's problems, and reads it once it is deep enough", …);   // message starts "the plan needs: "
it("parks again for approval when an architect change edits a decision, and not otherwise", …);   // plan-approved.md + D2 edited → question.parked{ run, reapprovalQuestion(id, ["D2"]), approval }, then plan.ready; a task text edited → plan.ready only; no plan-approved.md → plan.ready only
```

- [ ] **Step 2: Run** `bun test test/services/preflight.test.ts test/services/run-effects.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(preflight): refuse a lane the plan does not back; re-approve an edited decision"`

### Task 9: the skill, the README, MIGRATION and the backlog

**Files:**
- Modify: `plugin/skills/catherd/SKILL.md` (as plan 30 rewrote it), `README.md` (the "A protocol the tools enforce" line, `README.md:21` on 1.5), `MIGRATION.md` ("From 1.5 to 2.0"), `docs/dev/ideas.md`
- Test: `test/skills.test.ts`

- [ ] **Step 1: Write the failing test.** In `test/skills.test.ts`, `it("starts a run on the owner's plan, approves the architect's, and keeps MR titles short")`: the skill contains "`plan:`", "answer approve", "`catherd run-file read <run> plan.md`", "DESIGN:", "under 72 characters". Run it: FAIL.
- [ ] **Step 2: Write the text.**
  - SKILL.md: when the owner names a plan file ("implement the plan at …", a scorecard prompt), pass it as `run_start`'s `plan:` (several files, the contracts file included, as a list) and write only acceptance lines it does not already state; without one, say the architect writes a plan first and the run waits once for the owner's approval: relay the `catherd run-file read <run> plan.md` command, and pass `answer approve` on the owner's yes, or the owner's changes as the answer; the run asks again, the same way, only when a later architect change edits an approved `D<n>` decision; a parked lane whose question quotes a DESIGN: line is a conflict between the plan and the code, answered by the owner (the plan or the code changes); an MR title is the run's outcome, under 72 characters, never the branch name.
  - README: "Every lane is routed, every brief ends with the reply contract" → "Every lane implements its plan tasks as written, and every role, whatever vendor runs it, gets its role's text and ends with the reply contract".
  - MIGRATION "From 1.5 to 2.0", a `###` "The plan is the input": `run_start` takes `plan:` (a `plan:` A-line still works); lanes carry a `Tasks:` header line and preflight refuses a lane without one, or a task with neither a signature nor a test; without a plan the run stops once for the owner's approval (answer `approve`), and again only when a later architect change edits an approved decision line (`D<n>`); new reply lines `EXTRA:`, `REJECTED:`, `DESIGN:`; `plan-input/` in the run folder is read-only to roles; the medium-effort floor for coding workers is plan 33's.
  - `docs/dev/ideas.md`, under the 2.0 follow-ups (created by the first plan that adds one; else create `## 2.0 follow-ups` above "1.5 follow-ups"): "**A task's signature and test are found by pattern.** `parsePlanDoc` (`src/domain/plan-doc.ts`) calls any code block a signature and any `Expected:` line a test, so a task with only a shell command passes preflight. _Where:_ ask Jev, or the judge at `readPlan`, whether each task names what its worker must build."
- [ ] **Step 3: Run** `bun test test/skills.test.ts test/entry/plugin-packaging.test.ts` and `bun run format:check`. Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "docs(skill): a run starts from the owner's plan, or waits once for the architect's"`

### Task 10: changeset

- [ ] **Step 1:** Create `.changeset/briefs-plan-input.md`: `"catherd-cli": major`, "2.0.0 (part of): every role gets its role text, team and done-when as sections, with the reviewer, worker and verifier rules real runs taught; replies gain EXTRA:, REJECTED: and DESIGN: lines; run_start takes plan:, each lane names the plan tasks its worker implements as written, a run without a plan waits for the owner's approval of the architect's (again only when a later change edits an approved decision), and preflight refuses a lane the plan does not back."
- [ ] **Step 2: Run** `bunx changeset status`. Expected: `catherd-cli` major.
- [ ] **Step 3: Commit** — `git commit -m "chore(release): changeset for role briefs and the plan as input"`

## Spec coverage

| Spec item | Task |
| --- | --- |
| 17: role text, team, done-when in every headless role's brief, as sections | 3, 5 |
| 17: reviewer, fixer, worker and verifier rules of 1.6 plan 28 | 3 (fix-brief routing: plan 30, Ruling 2) |
| 17: `HEAD:` (30b), `EXTRA:`, `REJECTED:` | 1, 3, 6 (Ruling 1) |
| 22: `run_start` takes `plan:` | 4 |
| 22: every lane maps to plan tasks, implemented as written, `DESIGN:` on a conflict | 2, 3, 6 (Ruling 4) |
| 22: without a plan, the architect writes one to the five-point depth | 2 (`depthProblems`), 3, 8 |
| 22: the run waits for the owner's approval before the first lane (and on an edited decision, owner answer) | 4, 7, 8 |
| 22: preflight refuses a lane with no task, a task with neither signature nor test | 8 |
| 22: coding workers never below medium effort | plan 33 (Cross-plan interfaces) |
