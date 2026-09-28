# Attribution for the shipped catalog data

`catalog/scores.json` carries model scores from public sources. Each value names its source (`source`), the page
it came from (`url`), its date and its confidence. The weekly `catalog-refresh` workflow rebuilds the values that
come from the keyless sources below; the hand-typed values (no `source`) cite their own vendor or benchmark page in
their `url`.

## Sources whose values are shipped

### Arena (LMArena)

- Data: `lmarena-ai/leaderboard-dataset` on Hugging Face, configs `agent`, `agent_task_outcome_explicit`,
  `agent_bash_recovery_steps`, `agent_steerability`, `agent_tool_hallucination`, `webdev`
- License: CC BY 4.0
- Attribution: Leaderboard data by LMArena, CC BY 4.0, https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset

### Epoch AI benchmarks

- Data: https://epoch.ai/data/benchmark_data.zip (FrontierCode, Terminal-Bench and WebDev Arena tables)
- License: CC BY 4.0; external tables keep their own license
- Attribution: Epoch AI, 'Capabilities & benchmarking'. Published online at epoch.ai. Retrieved from 'https://epoch.ai/benchmarks' (CC BY 4.0)

### Vectara hallucination leaderboard

- Data: the README table of https://github.com/vectara/hallucination-leaderboard
- License: Apache License 2.0
- Attribution: Hallucination Leaderboard by Vectara (Apache License 2.0), https://github.com/vectara/hallucination-leaderboard

## Sources read at run time only

catherd reads these on the user's machine and ships none of their data: models.dev (MIT License,
https://models.dev), the OpenRouter API (https://openrouter.ai) and LiteLLM's
`model_prices_and_context_window.json` (MIT License, https://github.com/BerriAI/litellm).

Artificial Analysis (https://artificialanalysis.ai) is read only with the user's own key, and its values are never
shipped.
