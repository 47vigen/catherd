# Source fixtures (spec 1.2 §3, §11)

One recorded answer per source, cut to the rows the tests read. Each keeps the source's own structure and values;
only whole rows, whole models and a few long unused fields (descriptions, OpenRouter's parameter lists, models.dev's
`experimental` block and cost tiers) were cut. No test reaches the network: the parsers read these files, and the
sync tests serve them through an injected fetch.

Recorded on 2026-09-28 from the sandbox, through its proxy:

| File | Recorded with | Cut to |
| --- | --- | --- |
| `models-dev.json` | `curl -sS https://models.dev/api.json` | providers `openai`, `anthropic`, `opencode`, `opencode-go`; 9 models |
| `openrouter-models.json` | `curl -sS https://openrouter.ai/api/v1/models` | 6 models; the fields id, canonical_slug, name, created, context_length, pricing, top_provider, reasoning |
| `openrouter-endpoints.json` | `curl -sS https://openrouter.ai/api/v1/models/openai/gpt-6-sol/endpoints` and `…/anthropic/claude-opus-5.5/endpoints` | the first two endpoints of each, keyed by the model's OpenRouter id (the shape catherd caches) |
| `litellm.json` | `curl -sS https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` | 6 entries, the price, context, provider and effort fields |
| `arena-<config>.json` | `curl -sS 'https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=<config>&split=latest&length=100'` for `agent`, `agent_task_outcome_explicit`, `agent_bash_recovery_steps`, `agent_steerability`, `agent_tool_hallucination`, `webdev` | 12 rows (14 for `webdev`); `features` dropped |
| `vectara-README.md` | `curl -sS https://raw.githubusercontent.com/vectara/hallucination-leaderboard/main/README.md` | the text up to the table, 6 of its rows |
| `epoch/*.csv`, `epoch.zip` | `curl -sS -o epoch.zip https://epoch.ai/data/benchmark_data.zip` | `frontiercode_external.csv` (9 rows), `terminalbench_external.csv` (14), `webdev_arena_external.csv` (11), zipped again with deflate (`epoch.zip`) |

On 2026-09-28 no keyless source above has a `repo_code` or `terminal` value for Claude Opus 5.5: Arena's agent
boards have "Claude Opus 5.5 (High)" (agentic, steer, honesty), Arena WebDev has `claude-opus-5.5-max` (frontend),
and Epoch's FrontierCode and Terminal-Bench tables have no Opus 5.5 row. Plan 14's stand-in test relies on it.

## Artificial Analysis: synthetic, re-record with a key

The sandbox has no Artificial Analysis key (both paths answer 401), so these two files are **synthetic**: built from
the fields `docs/dev/ideas.md` documents (one row per effort, the bare slug meaning `max`), with made-up values.
Re-record them with a key and adjust the tests' expected values:

| File | Record with |
| --- | --- |
| `artificial-analysis-models.json` | `curl -sS -H "x-api-key: $ARTIFICIAL_ANALYSIS_API_KEY" https://artificialanalysis.ai/api/v2/data/llms/models` |
| `artificial-analysis-free-1.json`, `artificial-analysis-free-2.json` | `curl -sS -H "x-api-key: $ARTIFICIAL_ANALYSIS_API_KEY" 'https://artificialanalysis.ai/api/v2/language/models/free?page=1'` (and `page=2`) |
