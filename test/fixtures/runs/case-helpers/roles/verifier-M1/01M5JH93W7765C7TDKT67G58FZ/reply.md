VERDICT: PASS
HEAD: 7c024b3cb213e01f49f07082cd5157564a1f31af

**Acceptance lines**
- A1 PASS: I ran `bun -e` with `capitalize("hello")` and `capitalize("")`. Output was `"Hello"` and `""`.
- A2 PASS: I ran `bun -e` with `titleCase("  a  b ")`. Output was `"A B"`.
- A3 PASS: I ran `catherd gate run 20261022-192138-case-helpers --milestone M1 --command "bun test"` at 7c024b3. It exited 0 with no failures, in 62 ms.

**Gate items**
- M1 full check `bun test` PASS. catherd recorded the result in `checks/M1-7c024b3cb213-1792697243781.log`.
- No lane has a separate fast check. `bun test` is the only check the plan names.

**Bugs outside the acceptance lines**
None. `capitalize` walks the string by code point, so it handles surrogate pairs and empty strings. `titleCase` reuses the existing `words`, so it also trims and collapses whitespace. The diff has no dead code and nothing left over.

**What I could not check**
The secret scan did not run because gitleaks is not installed on this machine. catherd recorded this in its audit as "skipped".

STATUS: complete — the gate passed at 7c024b3 and A1–A3 passed when run through Bun.