# dsh vs opencode as a headless catherd worker — pilot, 2026-10-25

Owner: Vigen. Box: codekesh (8 vCPU, 9 GB RAM). Everything lives under `/root/scratch/dsh-ab/` on the box.

## Setup

| | version |
|---|---|
| dsh | `@deepseek-ai/dsh@0.2.1-rc.3` (npm global, install scripts allowed for its own native deps) |
| opencode | 2.1.4 |
| node / bun | v24.22.1 / 1.4.4 |
| model | `deepseek/deepseek-v4.1-flash` on OpenScale (`https://api.openscale.so/v1`), max reasoning, both harnesses |
| repo | catherd `8b2f969`, one fresh clone and `bun install --frozen-lockfile` per run |

Arms:

- **A, opencode.** `opencode run --standalone --auto --model "openscale/deepseek/deepseek-v4.1-flash#max" --format json "<task>"`. It ran with the box's own opencode config, as catherd's lanes do. That config adds the global AGENTS.md (codebase-memory), the rtk, ponytail and cbm-augment plugins, and webfetch. The default agent was used, not a catherd agent file.
- **B, dsh with native tools.** `dsh --profile headless --patch openscale.patch.yml --json "<task>"`, with `DSH_HOME=/root/scratch/dsh-ab/dshhome` (an isolated home), `DSH_PERMISSION_MODE=danger-full-access` (approval then resolves to `never`), `DSH_TELEMETRY_DISABLED=1`, a dead `DSH_TELEMETRY_OTLP_URL`, and `OPENSCALE_API_KEY`, which is read at runtime from opencode.json and never printed. rc.3 has no `--permission-mode` or `--approval-policy` flags. The environment variable is the switch.
- **C, dsh with PTC.** Arm B plus the overlay `- id: tools / config: { mode: ptc }`. The model then sees only `run_code`.

The dsh patch (`/root/scratch/dsh-ab/openscale.patch.yml`). It contains no secret, because the key is resolved through `apiKeyEnv`:

```yaml
# dsh A/B pilot overlay: route the default agent to DeepSeek V4.1 Flash on OpenScale.
- id: llm-pi-ai
  config:
    providers:
      openscale:
        apiKeyEnv: OPENSCALE_API_KEY
        api: openai-completions
        baseURL: https://api.openscale.so/v1
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        models:
          - id: deepseek/deepseek-v4.1-flash
            contextWindow: 1048568
            maxTokens: 131072
            compat:
              thinkingFormat: deepseek
            reasoningEfforts:
              off:
              high: high
              max: max

- id: agent-default-model
  config:
    provider: openscale
    model: deepseek/deepseek-v4.1-flash
    reasoningEffort: max

# Web tools call the official DeepSeek API: off.
- id: tool-web
  disabled: true
- id: web-search-deepseek
  disabled: true
- id: web-deepseek-api
  disabled: true

# No extra LLM call for session titles.
- id: session-title-llm
  disabled: true

# Foreground bash budget: 5 min default, 10 min cap (bun test ~3 min).
- id: bash-sandbox
  config:
    timeoutMs: 300000
    maxTimeoutMs: 600000

# Telemetry off in config too, on top of DSH_TELEMETRY_DISABLED=1.
- id: session-telemetry-otel
  disabled: true
```

The smoke test ("print the repo's package name") passed on the first try. It took 8 s, and the stream gave `final.reason.kind=completed`, exit 0 and `step_end.usage` with input, output and cacheRead. The session log records `provider: openscale`, `model: deepseek/deepseek-v4.1-flash` and `reasoningEffort: max`. The gateway accepted the model id as written.

## Tasks and method

Three items from `docs/dev/ideas.md` at `8b2f969`. Every arm got the same prompt: the bullet text, then "Fix it with a focused test; run only the focused tests and `bun run typecheck`; do not commit." The leading `- ` of each bullet was stripped, because opencode reads a message that starts with `-` as a flag.

- **T1:** the plan lint warns twice for one A-line (`lintPlan`).
- **T2:** a missing `STATUS:` line reads as clean. The hidden test is at the reducer level: a worker ends `ok` with `replyStatus: null`, then `stop.classified` comes with reason null (Jev off or unsure), and the lane must not be `checking`. A fix that lives only in `finalize` would fail this test. No arm took that route.
- **T3:** `coveredDir` and sourced files. The hidden test asks for null on `source f`, `. f` and `(cd web && source …)`, and for a folder to still be named for plain items. Those include `cd a/b && bun test ./src/a.test.ts` and `cd web && npx tsc -p .`. The last case is strict: an ordinary `.` argument must not count as sourcing.

The hidden tests (`/root/scratch/dsh-ab/hidden/`) were red on the untouched clone and are kept out of the clones. Each was copied into `test/hidden/` after its run. Runs went two at a time, with a 30-minute cap. The runner (`run_one.sh`) recorded wall time, exit code, the raw stream (`raw.jsonl`), `diff.patch` (with untracked files included through `git add -N`), the changed files, the hidden-test result, and `bun run typecheck` and `bun run lint` (oxlint `--deny-warnings`).

Measurement notes:

- **Cost.** For dsh, cost = input×0.06 + output×0.24 + cacheRead×0.003 per M tokens. dsh's `inputTokens` excludes cache reads, as the per-step totals confirm. For opencode, cost is its own figure from `opencode session export`. The `--format json` stream leaves out the last step's `step_finish`, so the stream alone undercounts. opencode's own figure is about 10–40 % above the same formula; it probably also counts the title request.
- **Reasoning tokens.** dsh does not report reasoning tokens separately, so its reasoning column reads 0. The thinking is included in `outputTokens`. opencode reports output and reasoning apart. Compare A's output plus reasoning with B's output.
- **Tool calls in arm C.** C counts `run_code` calls. The tool calls inside each program are not in the `--json` stream.
- **Blind grading.** An Opus subagent per task got the prompt and the shuffled diffs, labelled X1..X5, and scored each 0–10. The labels were unblinded afterwards (`grade/mapping.json`).

## Results

### T1

| run | wall s | exit / final | tools | failed | input | output | cache read | reasoning | cost $ | files | hidden | typecheck | lint | blind |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| T1-A-1 | 113 | 0 / stop | 23 | 0 | 87,652 | 3,053 | 685,762 | 5,308 | 0.0093 | 2 | pass | pass | pass | 9 |
| T1-A-2 | 32 | 0 / stop | 10 | 0 | 33,092 | 1,352 | 165,261 | 1,180 | 0.0031 | 2 | pass | pass | pass | 6 |
| T1-B-1 | 38 | 0 / completed | 12 | 0 | 31,966 | 2,539 | 150,780 | 0 | 0.0030 | 2 | pass | pass | pass | 6 |
| T1-B-2 | 54 | 0 / completed | 15 | 0 | 37,767 | 3,992 | 220,185 | 0 | 0.0039 | 2 | pass | pass | pass | 6 |
| T1-C-1 | 71 | 0 / completed | 15 | 0 | 73,124 | 5,510 | 354,837 | 0 | 0.0068 | 2 | pass | pass | pass | 7 |

### T2

| run | wall s | exit / final | tools | failed | input | output | cache read | reasoning | cost $ | files | hidden | typecheck | lint | blind |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| T2-A-1 | 224 | 0 / stop | 61 | 0 | 351,387 | 7,248 | 2,848,910 | 11,863 | 0.0342 | 2 | pass | pass | pass | 5 |
| T2-A-2 | 504 | 0 / stop | 138 | 0 | 818,374 | 14,976 | 8,476,065 | 23,505 | 0.0838 | 6 | pass | pass | pass | 8 |
| T2-B-1 | 403 | 0 / completed | 81 | 2 | 565,356 | 33,993 | 6,087,598 | 0 | 0.0603 | 2 | pass | pass | pass | 6 |
| T2-B-2 | 280 | 0 / completed | 84 | 2 | 490,693 | 17,189 | 4,320,676 | 0 | 0.0465 | 2 | pass | pass | pass | 6 |
| T2-C-1 | 310 | 0 / completed | 60 | 0 | 475,964 | 21,357 | 4,336,650 | 0 | 0.0467 | 2 | pass | pass | pass | 7 |

### T3

| run | wall s | exit / final | tools | failed | input | output | cache read | reasoning | cost $ | files | hidden | typecheck | lint | blind |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| T3-A-1 | 177 | 0 / stop | 27 | 0 | 86,387 | 3,773 | 690,805 | 16,764 | 0.0122 | 3 | pass | pass | pass | 8 |
| T3-A-2 | 66 | 0 / stop | 11 | 0 | 39,043 | 2,144 | 185,489 | 5,054 | 0.0046 | 2 | pass | pass | pass | 6 |
| T3-B-1 | 175 | 0 / completed | 25 | 0 | 94,715 | 20,738 | 403,359 | 0 | 0.0119 | 2 | pass | pass | pass | 4 |
| T3-B-2 | 131 | 0 / completed | 25 | 0 | 63,406 | 13,748 | 409,726 | 0 | 0.0083 | 2 | FAIL | pass | pass | 3 |
| T3-C-1 | 124 | 0 / completed | 15 | 0 | 59,021 | 13,051 | 436,914 | 0 | 0.0080 | 2 | FAIL | pass | pass | 4 |

### Per-arm medians

| arm | runs | wall s | tool calls | failed calls | input | output | cache read | cost $ | hidden pass | typecheck+lint | blind (median) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A opencode | 6 | 145 | 25.0 | 0.0 | 87,020 | 3,413 | 688,284 | 0.0107 | 6/6 | 6/6 | 7.0 |
| B dsh native | 6 | 153 | 25.0 | 0.0 | 79,060 | 15,468 | 406,542 | 0.0101 | 5/6 | 6/6 | 6.0 |
| C dsh PTC | 3 | 124 | 15 | 0 | 73,124 | 13,051 | 436,914 | 0.0080 | 2/3 | 3/3 | 7 |

Totals over all runs: A $0.147, 1,116 s over 6 runs; B $0.134, 1,082 s over 6 runs; C $0.061, 505 s over 3 runs. Mean blind score: A 7.0, B 5.2, C 6.0.

All 15 runs exited 0 with a clean final (dsh `completed`, opencode `stop`/`succeeded`). No run hit the 30-minute cap.

## Notable behaviours

- **dsh refuses to edit a file it has not read** ("file has not been read — read the file, then retry"). In T2 the model read files through `bash` (`cat`/`sed`) and then called `edit`, so dsh refused it. This happened 2× in T2-B-1 and 2× in T2-B-2, and each time the model recovered. T2-B-2 made 74 bash calls and only 2 `read` calls. In arm B the model leans on bash for reading, and that guard costs a round trip each time it fires.
- **T3, the hardest one to get right, separated the arms.** Both dsh arms and one opencode run (B-1, B-2, C-1, A-2) treated a bare `.` as `source`, so `tsc -p .` or `eslint . --fix` turn whole-tree. That is the conservative direction, so it wastes check time but loses no coverage. Blind scores were 3–4 for B and C, and 6 and 8 for A. T3-A-1 placed `.`/`source` correctly in command position. It was also the only run to fetch the upstream file from GitHub (opencode's webfetch) and to delete the ideas.md entry (scope creep). T3-B-1 passed the hidden test only because its `tsc -p .` case ended the line.
- **T2 is a design-open task.** The best diff (8) was T2-A-2: a dedicated reask brief, a bounded climb, and the cheap-try branch fixed, across 6 files, 138 tool calls and $0.084. The two other opencode and dsh diffs scored 5–7. Most missed the cheap-try branch, where a null reply on the cheap try still counts as success. No arm took the finalize-level route.
- **T1:** three of five diffs share the same subtle flaw: the first copy of an A-line wins, so a warning can be lost when the history words sit only in the later copy. Only T1-A-1 grouped the lines by id (scored 9).
- **PTC (C)** was the cheapest and fastest in each task: about 40 % fewer model turns than B on T1 and T3, and the same quality as B or slightly better. It made no failed calls. The edit-before-read guard did not fire, because the programs read and then edited.
- **Output tokens.** dsh spends more output tokens than opencode's output plus reasoning on T3 (13–21k against 6–21k) and less on T1. Its cache reads are lower than opencode's (about 400k against 690k at the median), because its system prompt and tool catalog are smaller. That shows as a lower input bill but not a lower total, because dsh writes more output.
- There were no loops, no timeouts, no stuck approvals, and no telemetry egress in config (the otel row is disabled). Lint and typecheck passed on all 15 runs.

## Verdict

On this model and these three tasks, dsh is a working and cheaper-or-equal headless backend, but not a better one. dsh native (B) matched opencode on time (median 153 s against 145 s) and cost ($0.0101 against $0.0107). It scored lower blind (median 6 against 7, mean 5.2 against 7.0) and passed fewer hidden tests (5/6 against 6/6). dsh with PTC (C) was the cheapest, at about $0.008 median, about 25 % less than A. Its quality sat between the two (median 7, 2/3 hidden). With only 15 runs, the quality gap is noise-sized, except on T3, where opencode was clearly better. My reading: dsh is worth a trial as a catherd backend for **cheap DeepSeek lanes in PTC mode**, but not as a replacement for opencode on lanes where quality matters.

Integration would need these pieces:

1. **A catherd adapter.** It spawns `dsh --profile headless --json` with an isolated `DSH_HOME`, the patch above (provider, model and effort come from the patch, because there is no `--model` flag), `DSH_PERMISSION_MODE` set per access level, and `DSH_TELEMETRY_DISABLED=1`.
2. **A stream parser.** It reads `tool_call`/`tool_result`/`step_end.usage`/`turn_end.reason`/`final`, and success means exit 0 AND `completed`. Cost comes from the catalog prices, because dsh reports none, and reasoning is not split from output.
3. **Thread resume** through `--session-id`, which works only from the same cwd.
4. **Read-only access mapped to `DSH_PERMISSION_MODE=read-only`.** Note that `$HOME` is read-only under workspace-write.
5. **The web tools kept off,** because they call the DeepSeek API directly.
6. **A version pin and a re-probe on each rc,** because the CLI surface is still moving: the flags named in the docs are absent in rc.3.

## Files

- `runs/<id>/`: `raw.jsonl`, `stderr.txt`, `diff.patch`, `files.txt`, `hidden.log`, `typecheck.log`, `lint.log`, `metrics.json` (arm A also has `export.json`).
- `prompts/T*.txt`, `hidden/T*.hidden.test.ts`, `openscale.patch.yml`, `ptc.patch.yml`, `dsh-run.sh`, `run_one.sh`, `metrics.py`, `oc_export.py`, `aggregate.py`, `grades.json`.
- Blind-grading bundles and the unblinding map: `grade/` (also copied to the box).
