# Grok Build fixtures (spec 1.3 §5, §10): synthetic

No grok was signed in when these were written (research `docs/research/2026-09-29-cursor-grok-antigravity.md` §0),
so every stream here is **synthetic**: built from the 1.0.44 user guide (`$GROK_HOME/docs/user-guide/14-headless-mode`,
cited "doc 14") and the binary, as the research cites them. `catherd capture-fixtures --backend grok` on a signed-in
machine records real ones under `<cli-version>/` (`docs/dev/live-verification.md` §12); compare them with these and
correct what differs.

| File | Follows | What is not verified |
| --- | --- | --- |
| `ok.jsonl` | §3.3 [doc 14 § streaming-json]: `available_commands`, `thought`, `text`, `tool_call` / `tool_call_update` by `toolCallId`, one `usage` per model response, and a last `end` with `stopReason`, `sessionId`, `usage` (`input_tokens` uncached only), `total_cost_usd` (API-key traffic) | the payload fields: `data` on `text`, `toolName` / `kind` / `rawInput` on `tool_call`, `status` on `tool_call_update` |
| `login-ok.jsonl` | §3.3: a subscription login's `end` has no `total_cost_usd` ("absence means unreported or incomplete, never free") | the whole stream |
| `resume.jsonl` | §3.5: a resumed session keeps its `sessionId`; the cache counts sum into input | the whole stream |
| `max-turns.jsonl` | §3.3: `max_turns_reached`, then `end` with `stopReason: max_turn_requests` | the `max_turns_reached` payload |
| `no-end.jsonl` | a run cut before its `end` (a timeout or a crash) | — |
| `not-signed-in.jsonl` | §3.3 [run]: the one `error` line a logged-out run prints, exit 1, no `end` (the research quotes it cut short after `grok login --device-code`) | the text after the device-code line |
| `rate-limit.jsonl`, `free-limit.jsonl`, `subscription.jsonl` | §3.10 [bin]: "rate limit for your plan", "free Grok Build usage limit" and "requires a Grok subscription" are strings of the 1.0.44 binary; the full sentences are the 2026-09-25 research's, from the source at f0e3be11, with U+2019 apostrophes | that a limit arrives as an `error` event at all |
| `empty.jsonl` | §3.3 [run]: an unknown flag prints nothing on stdout (clap's error on stderr, exit 2) | — |
| `models-logged-out.txt` | §3.4 [run]: `grok models` logged out, scratch `GROK_HOME`, exit 0, verbatim | — |
| `models.txt` | §3.4: the same layout under a login | the login line after "You are logged in with", and the list (whether `grok-4.7` is there) |
