# Myanmar locale plugin

One milestone, one task. Add `raqam/locales/my`, the Myanmar digit plugin, beside the Thai one.

## What exists

- `src/locales/th.ts` registers the Thai digits with `registerLocale({ digitBlocks: [[0x0e50, 0x0e59]] })` and
  exports `export const LOCALE_CODES = ["th", "th-TH"] as const`.
- `src/locales/index.ts` re-exports each plugin's codes as `<XX>_LOCALE_CODES`.
- `tsup.config.ts` (lines 37-41) lists the locale entries.
- `package.json` exports `./locales/*` by wildcard, so it needs no change.
- `src/locales/locale-integration.test.tsx` imports every plugin.

## Task 1: the Myanmar plugin

- [ ] `src/locales/my.ts` registers `[[0x1040, 0x1049]]` (Myanmar ၀–၉) and exports
      `LOCALE_CODES = ["my", "my-MM"] as const`, with a doc comment shaped like th.ts's.
- [ ] `src/locales/index.ts` adds `export { LOCALE_CODES as MY_LOCALE_CODES } from "./my.js";` and names Myanmar
      in its comment.
- [ ] `tsup.config.ts` adds `"locales/my": "src/locales/my.ts"`.
- [ ] `README.md` (line 127) and the table in `docs/content/docs/guides/locales.mdx` (line 39) add Myanmar `my`.
- [ ] `.changeset/myanmar-locale.md`: `"raqam": minor`, "Adds the Myanmar locale plugin, `raqam/locales/my`.".

## Tests

In `src/locales/locale-integration.test.tsx`: `import "./my.js"`; `normalizeDigits("၁၂၃၄")` is `"1234"`;
`MY_LOCALE_CODES` equals `["my", "my-MM"]`.
