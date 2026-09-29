# Antigravity fixtures (spec 1.3 §6, §10): synthetic

No `agy` was signed in when these were written (research `docs/research/2026-09-29-cursor-grok-antigravity.md` §0),
so every file here but `logged-out.jsonl` is **synthetic**: built from the Antigravity CLI docs (Wayback snapshots
2026-09-16..25) and `agy changelog` of 1.2.13, as research §4 cites them. `catherd capture-fixtures --backend
antigravity` on a machine with `GEMINI_API_KEY` records real ones under `<cli-version>/`
(`docs/dev/live-verification.md` §13); compare them with these and correct what differs.

| File | Follows | What is not verified |
| --- | --- | --- |
| `ok.jsonl` | §4.4 [doc HL]: one `init` (`cwd`, `tools`, `permission_mode`, `model`), `step_update` events (`conversation_id`, `step_index`, `state` ACTIVE/DONE, `step_type` `user_input`/`agent_response`/`tool`/`checkpoint`, `tool_name`, `text_delta`, `usage`, `tool_info`), exactly one `result`; the payload nested under the event's name as in the [run] `result` line | the nesting of `init` and `step_update`; `tool_info`'s fields (`path`, `command`); the tool names; whether `result.response` is the final message only; whether `input_tokens` includes the cache reads |
| `resume.jsonl` | §4.6: a resumed conversation keeps its id and prints only the new response | the whole stream; a resume's `usage` (here cache reads above the input, read as uncached) |
| `logged-out.jsonl` | §4.4 **[run]**: the exact line a logged-out `agy -p … --output-format stream-json` printed after its 60 s browser wait, exit 1 | — |
| `error.jsonl` | §4.4: a model failure mid-turn ends with an `ERROR` result, exit 3, and an `AGY_ERROR: {…}` line on stderr (changelog 1.2.6, 1.2.10) | the `AGY_ERROR` field names (the tests use `status`, `code`, `retryable`, `error_id`, `message`) |
| `partial.jsonl` | §4.4: an expired `--print-timeout` exits 0 with partial output and a stderr warning (changelog 1.1.28); catherd never passes one | the warning's text; whether a `result` follows |
| `empty.jsonl` | §4.4 [run]: an unknown flag prints the Go `flag` usage on stderr, exit 2, nothing on stdout | — |
| `models.txt` | §4.5 [run]: `Fetching available models...` first; slugs may embed the effort (`gemini-3.8-flash-high`, `gemini-3.1-pro-high`); the plans' models [doc models] | the whole listing format past its first line |

The stderr texts the tests pair with them: `flags provided but not defined` §4.4 [run], "Please sign in to view
available models" §4.5 [run], "authentication failed or timed out" §4.4 [run]; the quota texts (`RESOURCE_EXHAUSTED`,
quota, spend cap, credits) follow §4.8 and the changelog, and are a guess until a real quota stop is captured.
