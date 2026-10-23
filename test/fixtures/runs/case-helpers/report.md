# case helpers

## M1: capitalize and titleCase

Commit 7c024b3cb213e01f49f07082cd5157564a1f31af · 6 min · landed 2026-10-22T19:27:34.449Z
Commits: 7c024b3 fix: capitalize and titleCase, review round 1
A-lines: not mapped to this milestone (none cited as A<n>): A1 `capitalize("hello")` is "Hello" and `capitalize("")` is ""; A2 `titleCase("  a  b ")` is "A B"; A3 `bun test` passes

Lanes:
- M1.L1 · codex:gpt-6-luna#high

Reviewer: reviewer-M1 · 0 finding(s): 0 BLOCKER, 0 BUG, 0 NIT
Verifier: PASS (verifier-M1, headless)
Findings: no BLOCKER or BUG lines
Open: none
Evidence: verifier-M1 PASS on 7c024b3cb213
Tokens: 3167k in (2871k cached) · 24k out · Claude subagents 0 (reported)

Rounds: 2 review round(s) · fixed: BUG src/text.ts:6, src/text.ts:10 — `charAt(0)` reads half a surrogate pair: `capitalize("𐐨a")` and `titleCase("𐐨a")` return `"𐐨a"` instead of `"𐐀a"` — uppercase the first Unicode code point, slice by its length, and add regression coverage.
Gate: `bun test` exit 0 on 7c024b3cb213 · 0 s · secret scan: skipped: gitleaks is not installed

## Known issues

None.

## Audit

- run (rules): rules: 1 change(s) proposed
- M1 (check): secret scan skipped: gitleaks is not installed

## Rules review

Standing rules to review: apply any of these with the command under it.
1. ADD In src/text.ts, string helpers work on Unicode code points, not UTF-16 code units: take the first character with `[...s][0]` or `codePointAt`, never `charAt(0)`, `s[0]` or `slice(1)`, and add a test with an astral character such as "𐐨a". [worker, architect] — seq 14: the reviewer-M1 BUG at src/text.ts:6,10 was that `charAt(0)` split a surrogate pair in `capitalize`/`titleCase`, which cost review round 1. The lane brief listed "éa" as the non-ASCII edge case but had no astral case.
   `catherd knowledge add 'In src/text.ts, string helpers work on Unicode code points, not UTF-16 code units: take the first character with `[...s][0]` or `codePointAt`, never `charAt(0)`, `s[0]` or `slice(1)`, and add a test with an astral character such as "𐐨a". [worker, architect]'`
