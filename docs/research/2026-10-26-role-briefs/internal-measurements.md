# catherd briefs: internal measurement (179 dispatches, 7 runs)

Scripts and raw tables: scratchpad/{measure.py,ctx.py,dup.py,dup2.py,calls.py,rows.json,calls.json}. Bytes are UTF-8 bytes of brief.md. "full" = brief carries role/team/context sections; "resumed" = thread resumed, only <task>+<reply_contract> (src/domain/brief.ts:110).
Code refs: src/domain/brief.ts (composeBrief :85, laneBlock :51, roleNotes :61), src/domain/role-prompts.ts, src/services/run-briefs.ts, src/services/plan-input.ts (planContext :110), src/services/admission.ts (:368-377 builds context and calls composeBrief).

## 0. How a brief is built (code)
- `briefFor` (run-briefs.ts:457) makes the daemon text per role (workerBrief :218, reviewBrief :306, verifyBrief :387, architectBrief, judgeBrief :494) and appends every "owner answered" note (:460-465).
- admission.ts:368-372: `context = planContext(run, role, milestoneOfName(lane ?? name)) + rulesBlock(standing rules)`; admission.ts:374 `composeBrief(task, ctx)`.
- composeBrief (brief.ts:104-111): `<task>` = daemon text + inlined lane file (laneBlock) + roleNotes; roleSections (role-prompts.ts:261) wraps it in `<context><role><team><task><done_when><reply_contract>`. Resumed => only task + reply_contract; but the lane file sits inside <task>, so it is re-sent on every resumed fix round.
- Static text per brief: role ~2.9 KB (worker) / 5.3 KB (verifier), team 1.6 KB (same for all roles, names all 9 roles), done_when 0.1-0.3 KB, reply_contract 1.0-1.8 KB.

## 1. Size per role (all 179 dispatches) and block shares

| role | n | min | median | max | notes |
|---|---|---|---|---|---|
| worker | 78 | 6,192 | 42,158 | 144,342 | full n=46: min 13.5K, median 73.7K; resumed n=32: median 11.9K |
| writer | 9 | 5,309 | 6,444 | 102,744 | full n=4 median 35K |
| reviewer | 31 | 2,690 | 4,115 | 187,138 | full n=12 median 71K (60% context); resumed recheck n=19 median 3.3K |
| ui-reviewer | 8 | 2,087 | 2,132 | 110,238 | full n=3: 57-110K (91% context); resumed n=5 = 2.1K |
| verifier | 14 | 5,612 | 65,305 | 479,873 | full n=13 median 66.6K |
| architect | 10 | 9,516 | 16,854 | 236,192 | first calls 14-19K; the 236K one is a call-back with findings |
| judge | 29 | 5,279 | 13,432 | 2,474,396 | 4 briefs of 2.47 MB, 3 of ~370 KB (section 4.13) |

Block share (aggregate bytes, full briefs only):
- worker (n=46): context 73.7%, task 17.9% (plan-task 7.0, lane-file 4.1, A-lines 4.5, rest ~2.3), role 3.6, reply_contract 2.2, team 2.0, done_when 0.3.
- reviewer: context 60.2, task 33.9 (plan-task 23.1, A-lines 4.4), role 2.5, team 1.9.
- verifier: context 35.6, task 57.8 (dominated by two findings-bloated outliers; in the M40 case context is 89%), role 4.3.
- writer: context 75.2, task 18.9. ui-reviewer: context 91.5.
- architect: task 81.6 (A-lines + findings), role 12.6, context ~0.7 (planContext returns null for architect and judge, plan-input.ts:111).
- judge: task 99% (JUDGE input.context + findings).
- Over all non-judge briefs: 7.85 MB total, 4.31 MB (55%) is `<context>`.
- Worked example, worker-M40.L1 (139,567 B): context 101,382 (72.6%), plan-task 19,667 (14.1%), lane-file 5,658 (4.1%), A-lines 4,313 (3.1%), role 2,944 (2.1%), reply_contract 1,758 (1.3%), team 1,599 (1.1%). The lane file is 4% of the brief.
- Full-worker medians per run: credit p5 73.7K (max 144K), credit p7 126.7K, platform-u 106.6K, platform-p 43K, platform-m 39.6K, platform-i 35.9K.

Fix/recheck re-send:
- Worker fix round on a resumed thread: small (median 11.9K, 6-46K), `fixLines` only (run-briefs.ts:221-229, early return :228). The lane file is still inlined (brief.ts:104): 17.3% of resumed worker bytes (~83 KB over 32 briefs). 31 of 33 worker fix rounds were resumed.
- Whole brief re-sent in 2 fix rounds: worker-M40.L1 a2 (144,342 B) and worker-M1.L5 a2 in platform-u (114,919 B). Cause: run-machine.ts:379 `thread: failoverFrom || l.cheapFirst ? null : l.thread`; both fix rounds went to a cheap opencode rung and got a fresh thread. worker-M1.L8 failed twice on opencode (exit 130; 1,762 s and 3,325 s, 5.9M input) with identical 104,576 B briefs; attempt 3 on codex got 105 KB again.
- Reviewer recheck: resumed = 2.7-4.7K (finding list). Thread null (second reviewer or new session): full brief again (9 of the 12 full reviewer briefs are rechecks; reviewPlan re-sent only when thread null, run-briefs.ts:334).
- Fix-round bodies can be big because of the finding text: worker-M45.L1 a3-a5 (resumed) are 44.5-45.8 KB: one 32,816 B finding line (a whole failing check command plus log) and `failingCheck` (run-briefs.ts:138, 40 log lines) repeats the same log tail.

## 2. What `<context>` contains, by which rule, and what the lane cites

Rule (plan-input.ts:110-147, planContext), every role except architect and judge, daemon runs only:
1. `tasks = milestoneTasks(run, milestone)` (:173): the union of plan tasks of ALL lanes of the milestone, not the dispatched lane.
2. Per plan file: a file with tasks => its whole preamble (all before the first `## M<n>` / `### Task`) when any milestone task comes from it (:127-130). A file without tasks => the whole `## ` sections that a task cites by `§<n>` or whose heading words (>=4 chars) occur in a task text (`citedSections`, :90-103). No milestone tasks => whole files / all preambles (:115-120).
3. Cap `PLAN_CONTEXT_MAX = 100,000` chars (:24), parts kept in plan-file order; later parts are replaced by "[… N characters of plan-input/X cut: read it with read_run_file]" (:141-143).
4. Plus standing rules (rulesBlock, domain/rules.ts). Nothing is role-specific: worker, reviewer, verifier, ui-reviewer, writer of one milestone get the identical block (101,382 B for all M40 roles).

Measured on M40.L1 (run 20261025-224929-credit-p5-eligibility):
- Context 101,382 B (cap hit): p5 preamble 11,225 B; contract file "the sections these tasks cite" 89,854 B; three cut markers (9,286 + 23,856 + 23,466 chars = 56.6K chars dropped, naming two more plan files).
- M40.L1's own tasks (4001, 4002) cite C1 §1, §3, §4.1, §4.2, §4.3, §4.8, §6.3, §11. Whole `##` sections cited by L1: §1 2.7K, §3 19.5K, §4 36.7K (of which §4.1/4.2/4.3/4.8 = 17.3K), §6 2.7K, §11 1.3K = 62.9K; subsection-tight about 42K.
- Included although L1 does not cite them: §5 Platform client surfaces 8.7K, §7 API surfaces 13.0K, §12 Panel 5.5K (truncated; its tail and §13 are in the 9,286 cut) = 27.1K, pulled in by sibling lanes M40.L3/L4/L5 (milestone-wide union; 99.1K of contract sections uncapped, 158K with the preamble).
- The `§<n>` numbers are matched against EVERY taskless plan file, so credit-completion.md (the spec, "wins over everything" per A1) and credit.md were selected by number collision (their `## 3`, `## 4` are other content). The 100K cap cut both fully: the spec is effectively absent and workers read docs/specs/2026-10-25-credit-completion.md from the repo (M40.L1 `sed -n 100,235p`, M45.L1 `sed -n 100,330p`).
- Preamble content (11.2K): "For agentic workers: REQUIRED SUB-SKILL ... superpowers:subagent-driven-development", Goal, Ordering, Global Constraints (3.5K), Review Focus (1.7K, reviewer-facing), Milestones ASCII graph.
- Context bytes by role (full briefs): median worker 53K (max 101.7K), reviewer 52K, verifier 51K (max 101.4K), ui-reviewer 101K, writer 23K. Other runs: platform-u 86.9K, platform-p 25.5K, platform-i 18.0K, platform-m 21.2K.
- Cut markers appear in 14 briefs (workers M40.L1/L3/L4/L5 and M60.L1/L3/L4/L5, plus the reviewer/ui-reviewer/verifier of M40/M60); 794K chars cut in total.

## 3. Duplication (bytes)
Verbatim overlap is ~0 (6-word shingles, M40.L1): plan-task found in context 124 B of 19,668; lane in plan-task 71 of 5,658; lane in context 20; A-lines in other blocks 0-73 B. M60.L1: plan-task in context 1,255 of 17,547 B. The cost is semantic restatement:
- Lane file `## Rules` (1,280 B of 5,658) restates A1 (precedence, code wins), A2/A4 (conventions file, ZWNJ, `catherd lock`), A3 (read-only references), A13 (platform), A14 (red then green), A15 (no /root or /Users): 7 of 8 rules are A-lines. `## Decisions` (1,123 B) repeats task text.
- Plan task text (17.9K) restates contract sections that are also in the context (C1 §3 migration, §4.2 types): the task says "verbatim", the context holds the source.
- "Do not commit": role 1, team 1, task 2, reply_contract 2, A-line 1, lane file 1 = 8 statements. `catherd lock` forms: role says `bunx catherd-cli@VER lock`; lane fast check, A4, A7-A11 say `catherd lock` (9 mentions in task, 6 in A-lines).
- EXTRA:/DESIGN:/REJECTED: each defined in role and again in reply_contract; DESIGN: a third time in the task header. READ_RULES (CLAUDE.md/AGENTS.md) in role and task.
- Team paragraph (1.6K, same in all roles) describes nine roles incl. artist, researcher, judge that this role never meets.
- A-lines: 4.3K per worker brief; run-wide list (`ALINES(run)`, run-briefs.ts:233 worker, :359 reviewer); milestone-filtered only for ui-reviewer, verifier, judge (`milestoneALinesText`, :35, :352, :405). A7-A12 (integrated-head gates, ~1.05 KB) are in every worker and reviewer brief.
- The same finding is embedded repeatedly (4.13): judge-331 holds one 32.8 KB finding 11 times (328 KB of 380 KB); verifier-M45 holds "dismissed by the judge: ..." 12 times (295 KB of 353 KB).

## 4. Contradictions and dead instructions, each with its harm

1. Role "Read your lane file first ... read_run_file" (role-prompts.ts:104) vs lane inlined (brief.ts:51). 51 worker dispatches (45 of 49 codex, 4 opencode) call `run-file read lanes/...` for a file already in the brief. Harm: one wasted call each; no stop.
2. "never in /tmp" (brief.ts:66) vs opencode: roleScratch gives opencode no scratch (admission.ts:80/266), so its 38 briefs have no scratch line and spec.json has no TMPDIR; models wrote `/tmp/opencode/...` (48 hits in M40.L4 events; worker-M60.L5 `> /tmp/opencode/m60l5-plan.md`). The rule exists for 141 codex/claude briefs and is absent for opencode, so it is an inconsistency across backends, not inside one brief. Harm: temp files outside the run's cleanup; no failure seen.
3. Worker role "Implement them as written ... on conflict reply DESIGN: and STATUS: blocked needs_user" (role-prompts.ts:110) vs A1 and lane Rules "where the plan and the code disagree, the code wins, intent kept, say so in the report". Harm: worker-M44.L2 a1 stopped at 718 s with two DESIGN lines (needs_user); judge-192 answered "Neither conflict needs the owner ... The lane brief says ... code wins". worker-M41.L3 a2 needs_user (45 s) -> judge-114 ask_owner.
4. Worker role "Run the full suite only if the brief says so" and reply_contract "Acceptance items that build from HEAD belong to the verifier: do not run them" vs A7-A11 and lane M45.L1 "Red before green (A14) ... `task acceptance` builds ... run one acceptance command at a time under catherd lock". Harm: worker-M45.L1 a1 blocked check_broken "tooling/acceptance.sh:82 archives HEAD; the brief reserves those checks for the verifier" (313 s); a3 (89 s) and a4 (557 s, flaky) are the same family.
5. Verifier-only A-lines in worker briefs (A10 acceptance, A11 docker, A12 browser check). A12 "Every panel screen task has its browser check done on the dev server" led M44.L2 a2/a3 (186 s, 91 s) and M44.L3 a1/a2 (1,054 s, 245 s) to blocked no_access (no API/auth config, identity down): 1,576 s over four rounds, plus judge and owner turns. Both lanes passed only after the owner allowed the fake API (M44.L2 a4 396 s, M44.L3 a3 343 s). Reviewers also spend text on it: "I ran no tests and did not check A8-A11, which are the verifier's" (reviewer-M44, M45).
6. Role "When a check cannot pass for a reason outside your lane, stop and reply blocked" (role-prompts.ts:112) with team text "side by side in one checkout" and a fast check that lints sibling packages. 9 worker rounds ended check_broken on sibling-lane or pre-existing lint/format noise (M41.L1-L4 a1: 341-624 s each; M44.L1 a1 500 s; platform-u M1.L4 159 s, M1.L5 243 s; platform-m M1.L4 284 s). No brief line says what to do with files the lane does not own.
7. Verifier brief (checkedLines, run-briefs.ts:376-384) says "catherd ran this milestone's Check ... and it passed: do not run it again" while its own "owner accepted these" list (m.knownIssues, :426) says the Check "exits 127 with no failing line catherd can compare" (events: milestone.checked M40, missing=[... exits 127]). checkedOn is set by the waive/accept path, so "passed" is false. Harm: verifier-M40 returned VERDICT: PASS: "I did not rerun the Check (the owner accepted its exit 127) ... I did not run the Go or panel tests myself". The 127 itself is a bare `catherd lock` in the Check command (role text says `bunx catherd-cli@VERSION lock`).
8. Bare owner notes appended to the brief tail (briefFor :460-465): "The owner answered: retry" / "accept" with no referent; in judge-331 one note repeats 11 times.
9. Plan preamble "REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development" inside <context> vs EVERY_ROLE "only this brief tells you what to do". All 25 full codex-worker dispatches read `.../using-superpowers/SKILL.md` (cannot be separated from codex harness defaults); worker-M41.L1: "I'll use the executing-plans and test-driven-development skills for this task".
10. Role text lists MCP tool names (`mcp__catherd_role__read_run_file`, gate_check ...) in every brief although roleNotes for opencode says "from your shell" (roleServer false): dead text in 38 opencode briefs.
11. Lane "put the failing output in your report" / "name both commit messages" vs reply_contract "at most 15 lines ... evidence as a log path, not the log". Replies follow the contract (median 8 lines, max 14), so the lane line is dead; red/green evidence sits in scratch logs removed with the run.
12. Verifier role "Run only what your acceptance lines need", "judged from the tree" sentence (role-prompts.ts:86) and the checked brief "Judge only these acceptance lines, which the Check does not show": see section 6.
13. Unbounded finding text: `text: \`${item}\` fails: ${line} — in ${files.join(", ")}` (run-effects.ts:821) made findings of ~123-130 KB (a `files[line]` list of hundreds of paths); `knownIssues.push("dismissed by the judge: "+f.text)` (run-state.ts:1226) feeds them back into verifier briefs. Harm, hard failure: 4 judge dispatches (judge-57 x2, judge-66 x2, platform-m part-a, briefs of 2,474,396 B) failed in 25-27 s with 0 tokens: "Prompt is too long: ~1,346,591 tokens (limit 1,000,000)". judge-331/308/318 (367-381 KB) ran at ~239K input tokens each; verifier-M45 353 KB; platform-m finish-i verifier 480 KB (466 KB findings); architect-M43-2 236 KB (224 KB findings).

## 5. Did roles use the big context? Did cut markers pull reads?
- Reply text: 15 of 175 replies contain a `§n` (reviewer 4, worker 3, verifier 3, writer 2, ui-reviewer 2, architect 1). Every worker citation is a section its own tasks cite (worker-M40.L1 'C1 §4.3', worker-M40.L4 'C1 §7.6', platform-p L1 'C1 §5.1'); none cites a section that arrived only via a sibling lane. Replies are capped at 15 lines, so absence is weak evidence.
- Tool calls (3,815 parsed): workers re-opened the contract from the repo checkout (`docs/plans/2026-10-26-credit-completion-contract.md`, 11 worker reads: `sed -n 110,265p`, `420,690p`, a python script splitting `### 00008_eligibility.sql`) although the same text (89.9K) was in the brief. Reviewers grep the same file 5 times each.
- Cut markers: 0 of 14 briefs with a marker led to a read of the cut file through read_run_file. Workers read OTHER plan tasks from plan-input instead: worker-M40.L4 `awk '/^### Task 4201/,...'` for tasks 4201, 4005, 4202, 4104, 4103 (other lanes' signatures it needed), worker-M60.L5 `catherd run-file read plan-input/...p7...md`. The cut spec and credit.md were never read from plan-input; the repo copies were.
- Verifiers/reviewers: 13 verifiers and 12 reviewers received 50-100K context; verifier calls 2-34 (median ~10), mostly git diff/grep; none opened a cited section.
- Architect read plan-input (11 reads) as designed.

## 6. Reviewer and verifier briefs
Reviewer (first, thread null): 10-187K; full median 71K = context 60%, milestone plan tasks (`reviewPlan`, run-briefs.ts:264-286, all tasks of all lanes) 23%, whole-run A-lines (:359) 4.4%, role 2.5K, team 1.5K. Resumed recheck 2.7-4.7K (finding lines). All 31 reviewer dispatches ended complete; replies repeatedly disclaim A-lines they were handed ("A7-A11 ... are the verifier's").
Verifier (n=14; 13 full): 30-126K typical, M40 113K (context 89%), outliers 353K and 480K (findings). A typical post-Check brief (verifier-M40): role 5.3K gate procedure; task 3.8K = "Check passed: do not run it again. Judge only these lines which the Check does not show: A1 precedence, A2 paths, A3 references read-only, A4 machine rules, A5 no pin bump, A13 submodule, A14 tests red before code, A15 no secrets" + "owner accepted" + two bare "owner answered" lines; then 101K of plan context that holds no commands.
What invites "judged from the tree": (a) checkedLines (run-briefs.ts:376-384) drops the gate steps and leaves only `uncovered` lines, which are mostly process lines (A1-A5, A13-A15) with no command; (b) role step 3 and "an acceptance line about commit history ... is judged from the tree" (role-prompts.ts:86); (c) role step 1 "Run only what your acceptance lines need"; (d) the Check is called passed even when waived with exit 127; (e) the context is plan prose. Result: 11 of 14 verifier replies say "judged from the tree/diff" or "did not run the tests"; test/build commands issued: 0 in 7 of 14 dispatches, 1-3 in the rest; secs median 75 (M40 55, M41 30, M42 32, M43 27 and 23). One verifier ended with no verdict: platform-i a1 "The repository gate is still running. I'm waiting on the monitor" (turn ended on a Monitor).

## 7. Correlation: brief size vs secs / attempts / tokens.input (input includes cached reads)
Workers, full briefs: codex gpt-6.1-sol n=25, median brief 72.7K, 459 s, 3.47M input, r(size,secs)=0.42, r(size,input)=0.48, input/size median 51x. opencode deepseek-v4.1-flash n=21, median 104.6K, 397 s, 1.0M input, r(size,secs)=0.42, r(size,input)=0.47. Resumed fix rounds: codex n=24, median brief 9.5K, 166 s, 2.08M input (r(size,input)=0.09: the thread carries the earlier context); opencode n=8, 12K, 815 s, 3.36M input.
Attempt-1 buckets: codex <50K 250 s / 1.46M; 50-100K 490 s / 4.45M; 100-200K 243 s / 2.27M. opencode <50K 97 s / 0.58M; 100-200K (n=10) 751 s / 5.15M. Size is confounded with task weight (the large briefs are the credit p5/p7 contract-heavy lanes), so r~0.4 is an upper bound for the pure brief effect.
opencode M40.L4 (133,678 B brief, 1,623 s, input 38,825,611 of which cached 35,438,847, output 100,566, $0.33): 224 model steps (163 shell, 59 edit, 12 write); step 1 had 49.7K prompt tokens (brief about 35-38K tokens), growing to 240K by step 220, mean 173K per step. The brief alone is re-read ~224 times, about 8-9M tokens (~22% of 38.8M); the rest is accumulated tool output. Others: M60.L4 (131K brief) 27.2M; M40.L5 (123K) 9.9M; M40.L3 (120K) 4.4M in 319 s; codex M40.L1 (139.6K) 10.7M in 1,021 s.
Role totals (tokens.input / secs / cost): worker 304M (74%) / 43.9K s (74%) / $44.4; reviewer 25M; architect 24M; ui-reviewer 21M; writer 15.5M; verifier 14M; judge 9M; total 412M. Reviewer r(size,secs)=0.83, r(size,input)=0.88 (full 71K: 114 s, 1.24M; resumed 3.3K: 17 s, 0.26M). Verifier r=0.29 / 0.08 (flat ~75 s). Judge: the 2.47 MB briefs failed with 0 tokens.
Attempts: credit p5 lanes ran 1-6 attempts (M44.L2 6, M44.L3 4, M45.L1 5). Outcomes: 17 worker + 2 writer rounds `blocked` (check_broken 11, no_access 4, needs_user 4), 6 `flaky`, 2 `failed` (M1.L8 opencode exit 130 x2, 5,080 s together).

## One-line findings
- 73% of a worker brief is plan context chosen per milestone (union of all lanes' citations, whole `##` sections, number collisions across files, 100K cap); select by the lane's own tasks and subsections.
- Resumed fix rounds are lean, except cheapFirst/failover (full brief again, run-machine.ts:379) and the lane file re-sent on every resume (brief.ts:104).
- Finding and known-issue text is unbounded and duplicated (run-effects.ts:821, run-state.ts:1226); it killed four judge dispatches and bloated three verifier/architect briefs.
- Workers and reviewers get the whole run's A-lines incl. verifier-only A7-A12, which caused four no_access stops and an acceptance-from-HEAD stop.
- The DESIGN-vs-"code wins" rule and "acceptance builds from HEAD belong to the verifier" vs A10/A11 conflict across role text, A-lines and lane files.
- Dead lines: read lane via read_run_file, MCP tool names for opencode, "put output in your report", the nine-role team paragraph, the plan's REQUIRED SUB-SKILL header.
- The verifier is told the Check passed when it was waived with exit 127, and is left with process-only A-lines, so it judges from the tree.
