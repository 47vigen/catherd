# Role briefs: what is wrong and what to do — research, 2026-10-26

The owner said catherd prompts badly and asked for briefs that are "much more optimized and targeted". This
document combines three studies, kept beside it as evidence:

- [internal-measurements.md](2026-10-26-role-briefs/internal-measurements.md): all 179 dispatches of seven
  the shared run host runs (P5 eligibility, P7 merchants, MR-P, MR-I, MR-U, MR-M part-a and finish-i), measured block by
  block and tied to the code that builds them.
- [vendor-and-papers.md](2026-10-26-role-briefs/vendor-and-papers.md): Anthropic, OpenAI and DeepSeek
  guidance, context-rot and instruction-following studies, and verification-failure taxonomies. A URL backs
  every claim.
- [peer-orchestrators.md](2026-10-26-role-briefs/peer-orchestrators.md): ten orchestrators read from their
  code and prompts: oh-my-openagent, superpowers, claw-orchestrator, fable-advisor, Astra-Ares, Agent
  Orchestrator, mini-swe-agent, BMAD, Claude Code subagents and teams, and Goose.

## 1. What our briefs are today (measured)

| role | median | max | what fills it |
|---|---|---|---|
| worker (full) | 105 KB on opencode, 73 KB on codex | 144 KB | `<context>` is 74%, the lane file 4% |
| reviewer (full) | 71 KB | 187 KB | 60% context, 23% the whole milestone's plan tasks |
| verifier | 65 KB | 480 KB | 89% plan prose, no commands (M40) |
| judge | 13 KB | 2.47 MB | unbounded finding text, re-injected as known issues |

- **The context rule is wrong at the root.** `plan-input.ts:110-147` builds one `<context>` per milestone:
  - the union of every lane's plan tasks;
  - every whole `##` section any of them cites by `§n`;
  - whole preambles.

  `§n` also matches other plan files, so the spec and `credit.md` were pulled in by number collision and then
  cut at the 100 K cap. Every role of the milestone gets the same block.
  - **M40.L1:** its own tasks needed about 42 KB of subsections. It got 101 KB, including 27 KB of sibling
    lanes' sections.
- **Roles did not use it.**
  - 0 of 14 cut markers led to a read of the cut file.
  - Workers re-opened the contract from the repo 11 times, though 90 KB of it was inlined.
  - 51 workers re-read the lane file through `run-file`, though it was inlined.
- **Duties leak across roles, and that caused harm:**
  - A12, the verifier's browser check, sat in worker briefs and caused 4 `no_access` stops (1,576 s).
  - A10 and A11 caused M45.L1's `check_broken`.
  - "Stop if a check fails outside your lane" caused 9 `check_broken` stops on sibling lint.
  - "DESIGN then stop" in the role text against "code wins" in A1 made M44.L2 stop (718 s), and the judge
    then ruled no owner was needed.
- **Verifiers are invited to read instead of run.** The role text says commit-history lines are "judged from
  the tree". 11 of 14 verifier replies say they judged from the tree or did not run tests, and 7 of 14 ran no
  test or build command. One verifier brief said the Check passed while its own known-issues list said it
  exited 127, and that milestone passed.
- **Restatement, not copying.** 7 of 8 lane Rules restate A-lines, "do not commit" appears 8 times, and
  EXTRA/DESIGN/REJECTED are defined twice. The nine-role `<team>` paragraph sits in every brief.
- **Unbounded text kills roles.** Findings reach 130 KB (`run-effects.ts:821`) and come back as known issues
  (`run-state.ts:1226`). 4 judge dispatches failed outright with "Prompt is too long".
- **Where the tokens go.** Workers are 74% of all input tokens (304 M of 412 M). On opencode M40.L4 (224
  steps, 38.8 M input) the brief is only about 22%; the rest is tool output piling up, so an output clamp
  matters as much as a short brief.
- **Environment leaks into briefs.** opencode gets no scratch folder or `TMPDIR`, so it writes to
  `/tmp/opencode` in 38 briefs. MCP tool names are listed to opencode roles that have no role server.

## 2. What the outside evidence says

The strongest principles, with their sources in `vendor-and-papers.md`:

1. **Each role gets only its own duties.** Agents carry out the extra instructions they are given. The
   AGENTS.md study (arXiv 2602.11988) found no gain in success and a cost rise of more than 20%. IFScale
   shows accuracy falling as instruction count grows. *We measured exactly this harm above.*
2. **A worker gets one lane, plus the interfaces and decisions it needs and a report contract.** That is
   superpowers' task-brief, Cursor's and Factory's fresh narrow sessions, and Anthropic's "smallest set of
   high-signal tokens". The counterweight is Cognition: a sub-agent with too little context makes
   conflicting assumptions. Cut the noise, keep the decisions.
3. **Verification is enforced by the harness, not asked for in prose.** Sources: MAST (no or incorrect
   verification is 17% of multi-agent failures), Anthropic's long-running harness ("done" after only unit
   tests or curl), and the Vercel gate lesson. Every check needs a command, an exit code and key output. A
   check that was not run is `NOT RUN`, never `PASS`.
4. **Stable prefix first, lane text last.** Prompt caching on Anthropic, OpenAI and DeepSeek needs a
   byte-identical prefix. Reads cost 0.1× (0.05× on Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol). Effort, tools and
   timestamps must not change inside the prefix.
5. **Reference by path, fetch on demand.** Inline only what the role cannot start without.
6. **Destination, not route.** OpenAI's Goal / Context / Constraints / Done-when skeleton. MAST counts
   unclear termination at 12.4% of failures.
7. **Hard guards for cheap models:** step caps, an output clamp and lower effort for mechanical work. This
   is not measured on our lanes yet.

## 3. What the peers do that we should take

From `peer-orchestrators.md`, with the problem each one fixes:

| idea | from | fixes |
|---|---|---|
| The daemon runs the declared checks itself and writes an evidence bundle. A verifier reply without executed commands is rejected | claw-orchestrator, oh-my-openagent (`DoneClaim` with exact command and result) | verifiers that pass by reading |
| Hash the test files at lane start and refuse a run where they changed, unless the task owns them | claw-orchestrator | weakened tests |
| `failure_class: product \| harness`. A harness failure gets a free repair dispatch and is not a review round. Stop when the same failure signature repeats | oh-my-openagent | M45 and finish-i: 6 rounds each on environment |
| Task-only brief file, long report to a file, 5-line reply | superpowers | bloat |
| Strip ambient context (CLAUDE.md, memory, plugins) from narrow roles | Claude Code `omitClaudeMd`, oh-my-openagent | bloat, Honcho pollution, wrong duties |
| "You must not" fences per role. The daemon writes the canonical contract and roles never edit it | oh-my-openagent | wrong duties |
| The reviewer reads the worker's claims last, has a list of what does not count as a test, drops findings without file:line, re-reviews only the fix diff, and keys review state by head SHA | BMAD, superpowers, Agent Orchestrator | shallow and repeated reviews |
| A global slot cap for heavy commands, a reaper keyed by lane label, an output clamp (head plus tail, about 5 K), a per-engine circuit breaker | Agent Orchestrator, mini-swe-agent, claw-orchestrator | shared machine, flakes, 38 M-token lanes |
| A small decider holds its choice for N steps on a capped view and re-decides on failure | Astra-Ares | matches our decision-model spec |

Two things we should *not* copy. Superpowers tells its reviewer not to re-run tests, the opposite of what
we need. No peer has a real flake-versus-defect classifier beyond `failure_class`, so that part is ours to
design.

## 4. Proposal

### 4.1 One brief shape for every role

The order serves the cache: the stable prefix comes first, and the most specific text comes last.

```
1. role contract      (static per role, byte-identical across runs; cached)
     purpose · you must · you must not · done when · reply format (≤ 5 lines + report file)
2. run facts          (static per run; cached)
     paths, scratch dir, machine rules that apply to THIS role only
3. unit context       (per lane / milestone)
     the plan tasks this unit owns, verbatim
     the decisions and interfaces those tasks cite, at subsection level, resolved per file (no §n collision)
     "read on demand": paths to the spec, contract and siblings' tasks, never inlined
4. this round         (per dispatch)
     findings to fix (capped, each with file:line), previous attempt's outcome, floor rung
```

- **Each role's A-lines are filtered by owner.** The architect tags every A-line `worker`, `reviewer`,
  `verifier` or `run`, and a role only sees its own. A worker never sees A10, A11 or A12.
- **No `<team>` paragraph.** One line names who comes after you and what they check.
- **Lane Rules that restate an A-line are removed** at lane-write time. The architect prompt forbids
  restating.
- **Hard caps.**
  - Unit context: about 20 KB.
  - A finding: 2 KB.
  - Known issues: titles only, with the text in a file.
  - The judge gets references, never pasted findings.

  When a cap is hit, the brief says which file holds the rest.
- **Fix rounds** send only part 4 plus a pointer to the lane file. They never re-send the full brief unless
  the thread is new, and then as the same shape.

### 4.2 The harness enforces, so the prompt need not plead

- **Verifier.** The brief lists the exact commands from the plan's checks. The reply must carry, per
  command, the command, its exit code and a log path. catherd re-reads the logs. A missing or `NOT RUN` item
  is a FAIL, never a PASS. "Judged from the tree" stays allowed only for the lines that are about the tree
  (A13, A15).
- **Failure class.** Every failed check and stop is classified `product` or `harness`. A harness failure
  gets one repair dispatch outside the round count. The same harness signature twice parks to the
  coordinator with the evidence. This uses the decision model's `stop` question, which the spec makes
  mandatory.
- **Test-file hash** at lane start, refused on change unless the lane owns the file.
- **Clamp tool output** for opencode and codex where the CLI allows it (head plus tail), and give opencode a
  `TMPDIR`.
- **Strip ambient context** for headless roles: no CLAUDE.md beyond the repo's own, no memory plugins (the
  Honcho pollution), and no MCP tool names a role cannot call.

### 4.3 Measure before and after

The scorecard on the next run, per role:

- brief bytes, input tokens and cache-hit share;
- wall time and rounds per lane;
- stops by reason;
- executed commands per verifier reply.

Target: worker brief median under 20 KB, no verifier PASS without executed commands, and zero stops caused by
a duty that belongs to another role.

## 5. How this meets the decision-model spec

The decision model judges the brief ([decision-model design](../specs/2026-10-26-decision-model-design.md),
O2). With today's 100–145 KB briefs that state is both expensive to judge and mostly noise. A 20 KB brief
of the shape above is what the decision model should see, so this work comes before or together with it.
The spec's open probe of the decider's context limit then becomes much less risky.

## Not covered

- The brief-length effect specific to DeepSeek flash, and XML versus markdown for GPT-6.1 Sol: no source
  was found.
- Several peers were read from docs only: Claude Code teams, Spec Kit, Taskmaster, Factory and Codex cloud.
- The brief-size versus wall-time correlation (r ≈ 0.4) is confounded with lane weight. It is not proof that
  shorter briefs are faster. Only the scorecard run can show that.
