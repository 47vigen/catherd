BUG src/text.ts:6, src/text.ts:10 — `charAt(0)` reads half a surrogate pair: `capitalize("𐐨a")` and `titleCase("𐐨a")` return `"𐐨a"` instead of `"𐐀a"` — uppercase the first Unicode code point, slice by its length, and add regression coverage.
Evidence: /home/user/.local/share/catherd/repos/home-user-smoke-7b9131bc/runs/20261022-192138-case-helpers/scratch/reviewer-M1/unicode-capitalize.log
Full suites skipped as requested; A3 remains for the verifier.
STATUS: complete — entire diff reviewed; project unchanged; no background commands started.