# Two review-gate misreads

One milestone, two independent lanes: they own different files and can run together.

## Lane 1: a finding line that says none is no finding

`src/services/milestones.ts:100` (`FINDING`). A line whose text after the label and an optional colon is `none`,
`n/a` or `-`, in any case, is no finding. `countFindings` and the digest's `findingLines`
(`src/services/protocol.ts:205-214`) read `FINDING` and need no other change.

Test in `test/services/protocol.test.ts`, "reads BLOCKER: none, BUG: n/a and NIT: - as no finding":
`countFindings` of the reply

```
BLOCKER: none
BUG: n/a
- NIT: -
BUG: the parser drops a field
STATUS: complete — reviewed
```

is `{ BLOCKER: 0, BUG: 1, NIT: 0 }`.

## Lane 2: a `./path` hit matches its `Allow:` entry

`src/domain/lane.ts:143-158` (`onlyAllowedHits`). The hit's path and the entry's path are compared after
`normalizeOwned`; a hit path that does not normalize (`../x.md`) is not allowed.

Test in `test/domain/lane.test.ts`, `describe("onlyAllowedHits")`: `./docs/a.md:3:x` is allowed by `docs/a.md`;
`../docs/a.md:3:x` is not.

## Both lanes

Both entries leave `docs/dev/ideas.md`. Add `.changeset/review-gate-misreads.md`, `"catherd-cli": patch`.
