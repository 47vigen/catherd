# Cursor fixtures (spec 1.3 §4, §10): synthetic

No Cursor CLI was signed in when these were written (research `docs/research/2026-09-29-cursor-grok-antigravity.md`
§0), so every file here is **synthetic**: built from Cursor's docs and the 2026.09.28-64d2043 bundle, as the research
cites them. `catherd capture-fixtures --backend cursor` on a signed-in machine records real ones under
`<cli-version>/` (`docs/dev/live-verification.md` §11); compare them with these and correct what differs.

| File | Follows | What is not verified |
| --- | --- | --- |
| `ok.jsonl` | §2.3 [doc output-format; bin `6949@565224`, `@571182`]: `system/init` (display-name `model`, `permissionMode: "default"`), `user`, `assistant`, `tool_call` started/completed by `call_id` (`readToolCall`, `writeToolCall`, other tools as `function`), the undocumented `thinking` and `retry` events, and `result` whose `result` runs every assistant text together; `usage` camelCase with `inputTokens` uncached only [bin `6949@564048`] | the `function` payload (`name`, `arguments` as a JSON string); whether one message comes as one `assistant` event |
| `resume.jsonl` | §2.5: a resumed chat keeps its `session_id` | the whole stream |
| `no-result.jsonl` | §2.3: a failure has no `result` event, its text on stderr, exit 1; `connection` [bin] | the `connection` payload |
| `empty.jsonl` | §2.2 [run]: no auth, an unknown option, a team policy: nothing on stdout, the text on stderr | — |
| `models.txt` | §2.4 [bin `9517@1021`]: `Available models`, `<id> - <Display Name>` lines with ` (current, default)` markers, a tip | the slugs: whether the account lists effort-suffixed slugs, and Cursor's ids for GPT-6, Claude, Grok and Gemini |

The stderr texts the tests pair with them are quoted from the research: "Authentication required" §2.2 [run], the
commander `unknown option` §2.2 [run], the team policies §2.3 [bin `6949@732783`], `ActionRequiredError` and the
server codes §2.3 [bin `index.js@4146371`] (the user-facing limit text comes from the server and is a guess).
