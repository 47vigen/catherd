# Lao digits out of the box

One milestone, one task. Lao digits become a built-in script, so no locale import is needed to read them.

## What exists

- `src/core/normalizer.ts:7-14` `BUILTIN_DIGIT_BLOCKS`: Thai `[0x0e50, 0x0e59]` is built in.
- `src/core/normalizer.test.ts` has one test per built-in script.

## Task 1: Lao digits

- [ ] Add `[0x0ed0, 0x0ed9], // Lao (laoo)` after Thai in `BUILTIN_DIGIT_BLOCKS`.
- [ ] Test "converts Lao digits": `normalizeDigits("໐໑໒໓໔໕໖໗໘໙")` is `"0123456789"`.
- [ ] `docs/content/docs/api/core-utilities.mdx:107` names Lao among the built-in scripts.
- [ ] `.changeset/lao-digits.md`: `"raqam": minor`, "Reads Lao digits with no locale import.".
