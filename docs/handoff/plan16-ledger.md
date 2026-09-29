# Plan 16 — docs/plans/2026-09-29-16-grok.md (ledger)

- Executed by replaying `plan16-scratch` (the writer's pre-validated task commits) onto main 767307a (plan 15 merged), minus f0f3cee (Task 9, the network grant on resume), which plan 15 already carries as e14b601. Clean cherry-pick of 8 commits.
- Gate on the combined head (FORCE_COLOR unset): typecheck, lint, format clean; 1767 pass, 20 skip, 0 fail (1787 tests, 165 files).
- Final review (opus): 0 Critical, 2 Important, 5 Minor. Fixed in d823f77/d84258b: a linked `~/.grok/sandbox.toml` stays a link (written at its real path); a run killed before `end` records catherd's `-s` session (`sessionFor`, derived from the dispatch dir; none when grok never started a session); Minor 1 `withHome` pins `GROK_HOME` (and `withGrokScenario` puts the sim's login there). Other minors → ideas.md.
- Codex round (PR #31), 3 P2: `#default` grok pairs fixed (d823f77); isolated discovery identity and doctor's paired-stand-in accounting tracked in ideas.md, replied and resolved.
- Scoped re-review of the fix wave (it touched > 3 files): clean; 3 Minors → ideas.md.
- Gate: 1769 pass, 20 skip, 0 fail (1789 tests, 165 files).
