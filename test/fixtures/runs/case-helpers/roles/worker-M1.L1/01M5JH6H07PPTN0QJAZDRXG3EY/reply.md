Fixed the finding: `capitalize` now uppercases the first Unicode code point and slices by its length ([src/text.ts:5](/home/user/smoke/src/text.ts:5)). Added regressions for both helpers at [src/text.test.ts:12](/home/user/smoke/src/text.test.ts:12) and [src/text.test.ts:18](/home/user/smoke/src/text.test.ts:18). Reference followed: `src/text.ts`.

Fast check passed (5 tests): `/home/user/.local/share/catherd/repos/home-user-smoke-7b9131bc/runs/20261022-192138-case-helpers/scratch/worker-M1.L1/fast-check.log`

Full `bun test` gate passed (5 tests): `/home/user/.local/share/catherd/repos/home-user-smoke-7b9131bc/runs/20261022-192138-case-helpers/scratch/worker-M1.L1/full-check.log`

Skipped grapheme-cluster handling beyond the reported code-point case; no known risk for this finding.

STATUS: complete — finding fixed and checks passed.