plan 31: the panel (docs/plans/2026-10-21-31-panel.md)

Ruling: `watch --plain` is silently ignored, not "unknown option" — citty ignores unknown flags on subcommands (only a bare `catherd` checks) and ignoring never breaks a script; Task 1's test asserts a normal text view instead — a script passing it gets no error — none.

Ruling: Setup resolves the profile under the panel's host (`deps.host.host`), not "unknown" — a profile without explicit architect/verifier rungs does not resolve under host unknown (ProfileService raises "needs an orchestration host"); the plan's `profileFor(repo, "unknown")` would throw — `catherd panel` and a bare `catherd` take `--host` like every host-aware command (Task 3); tests use a codex host — a panel started with no host and no explicit rungs shows that error and its fix.

Ruling: `panelServer` has a second member, `untilStopped()` (SIGINT/SIGTERM), beside `serve` — an in-process test of a bare `catherd` would otherwise wait on Ctrl-C forever — one more seam than the plan's — none.
Ruling: `catherd panel` and a bare `catherd` take `--host` (HOST_ARG) and pass it to `defaultDeps(terminalHost(host))` — see Task 2's host ruling — a script passing nothing gets host unknown as before.
Ruling: "a port in use" exits 2 (E_INPUT_INVALID is a usage error everywhere in catherd) — the plan fixed the code, not the exit — none.
Ruling: the traversal test sends `/..%2fpackage.json` (404 from the path guard) and checks `/%2e%2e/package.json` serves no package.json — Bun folds a `%2e%2e` segment away before the handler runs, so the plan's "raw /%2e%2e/ is 404" cannot be observed; the guard still holds for the encoded slash — none.
Ruling: the socket frame uses `describeEvent(e)` without a `rungOf`, as Ruling 16 says; a dispatch line read live omits the rung a refetched timeline shows — cosmetic.

Ruling: `web/.oxfmtrc.json` also ignores `openapi.json` (the one change to a "verbatim" file) — the root freshness test needs `JSON.stringify(doc, null, 2)` byte for byte and oxfmt reflows short arrays — none.
Ruling: the "copy is English" rule is `/[؀-ۿ]/` with escapes, not literal Arabic-block characters — the conventions test scans itself, and a literal range would flag its own source — none.
Ruling: `useLiveLogs{,.test}.ts` were copied in Task 4 (renamed `useLiveRun`) and then held back to Task 5, where the plan puts them: they import generated types a Task-4 tree has not got — none.

Ruling: a socket opened without `?from=` starts at the end of the run's events (last seq + 1) — the hook's URL is exactly `…/live` (the plan's test pins it) and a default of 1 would replay the whole history into page 1 of the timeline; the page loads history over HTTP — an event appended between the timeline fetch and the socket's start shows on the next refetch (10 s) — cosmetic.
Ruling: the run page's `getRun` also refetches every 10 s — a restarted panel must send an open run page to /login even when no frame arrives (the socket's 401 on reconnect cannot) — one more request per 10 s per open run page.

Ruling: `StatusChip` takes an optional `label` that replaces the status word — a check row reads its own word ("missing") in the chip's colour, and the plan's "StatusChip of state with word" had no way to say it — none.
Ruling: the run page's "Live" output carries `data-connected` — the e2e must append an event only after the socket is open (its start is fixed at upgrade), and a visible label cannot say that — none.
Ruling: Playwright's `outputDir` is `test-results/pw`, apart from `test-results/e2e-state.json` — Playwright cleans its output dir on start and would delete the state file the seeded server writes — none.

## Review fixes

Final review: 0 Critical, 2 Important, 2 Minor, all fixed on the branch after rebasing onto main (626489a, plan 30b's fixes).

Ruling: the sign-in token no longer rides the browser opener's argv — the opener gets a 0600 redirect page in a fresh 0700 `mkdtemp` dir, deleted after the first sign-in and on stop; the printed link still carries the token for the owner's own terminal — if the page is deleted before the browser reads it, the tab stays blank and the printed link still works.
Ruling: the live socket opens only on page 1 once the timeline is fetched, with `from=<newest fetched seq + 1>`, and a reconnect asks from the last frame it got + 1 — this replaces the "history over HTTP, tail from now" ruling above, so the fetch-to-upgrade gap and a reconnect gap are replayed by the server (`tailEvents` already took `from`); live entries are deduped by seq and a refetched page drops the ones it now holds — the socket closes on pages 2+ and reopens on return, replaying from the cached newest seq.
Ruling: a malformed `%` escape in an API path or a socket path answers 400 `E_INPUT_INVALID` with the security headers (static paths already answered 404) — none.
Ruling: stale TUI mentions were reworded to "the panel" (plugin skill, service and entry comments, `launch.ts`, ideas.md) — none.
Ruling: CSP `connect-src 'self'` may not cover `ws:` in old Safari; the e2e is Chromium only — tracked in `docs/dev/ideas.md` — a dead "Live" dot there.
