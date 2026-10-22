# Contributing to catherd

Thanks for helping. This file covers the development setup, the checks every change must pass, and how releases
work. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues
privately, as [SECURITY.md](SECURITY.md) describes, not in an issue.

## Setup

You need [Bun](https://bun.sh) 1.4 or newer (`bun --version`) and git. catherd has no build step: Bun runs
`src/cli.ts` directly.

```sh
git clone https://github.com/47vigen/catherd && cd catherd
bun install --frozen-lockfile
bunx lefthook install   # the git hooks: lint and format on commit, commitlint on the message
bun src/cli.ts doctor --host codex   # select your actual orchestration host; sends nothing
```

Do not commit a `bun.lock` rewritten by a Bun older than 1.4. The hooks are not installed by `bun install`
(there is no `prepare` script), so run `bunx lefthook install` once per clone.

## The checks

Run the appropriate gate locally. Native Codex feature acceptance is local only and its release is held; do not request, trigger or re-enable CI for this work. The historical CI/release descriptions below document existing tooling, not authorization to run it.

```sh
bun run format        # oxfmt rewrites; then check nothing is left
bun run typecheck     # tsc --noEmit
bun run lint          # oxlint --deny-warnings src test
bun run format:check
bun test
```

The existing historical CI configuration runs them once, on the pull request, and only when it touches code (`src/`, `test/`, `catalog/`, `plugin/`,
`scripts/`, `.github/`, `package.json`, `bun.lock` or the tool configs): on Linux with Bun 1.4.0 and the latest Bun,
and on macOS with the latest Bun. A nightly run on `main` adds macOS with Bun 1.4.0. A docs-only pull request runs
only `format:check`. The required check is the `ci` job, which passes when every job that ran passed. One job also
checks the coverage floor over `src/`:

```sh
bun test --coverage --coverage-reporter=text --coverage-reporter=lcov
bun test/coverage-floor.ts coverage/lcov.info
```

Other CI jobs run `bun audit --audit-level=high` and a package smoke test (`bun test/pack-smoke.ts`).

- **Tests** use `bun test`. Tests that spawn processes pass `env` explicitly; `withHome()` in `test/helpers.ts`
  gives a test its own `CATHERD_HOME`. No network, and no wall-clock sleeps for correctness. The backend CLIs are
  simulated by the scripts in `test/sim/`, and the adapters' contract tests replay the streams in
  `test/fixtures/adapters/`.
- **The panel.** `web/` is remora's console copied (THIRD_PARTY_NOTICES.md), its own package with its own gate
  (`cd web && bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun run test`)
  and e2e (`bun run build && bun run e2e`). After an API change: `bun run panel:openapi`, then `cd web && bun run gen`.
  One build at a time, no dev server per agent.

## Architecture

The binding design is [`docs/specs/2026-09-25-catherd-1.0-design.md`](docs/specs/2026-09-25-catherd-1.0-design.md).
`src/` is layered, and each layer imports only from itself and the layers before it:

```
domain -> infra -> adapters -> services -> entry
```

`test/architecture.test.ts` enforces it. `src/cli.ts` is the entry point; each backend (Codex, Claude Code,
opencode) is an adapter under `src/adapters/`. Each CLI subcommand file is named `src/entry/<name>-command.ts`
(`status` and `watch` share `runs-command.ts`; the MCP server's is `src/entry/mcp/command.ts`).

## Commits and pull requests

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org), checked by commitlint with
  `@commitlint/config-conventional` (for example `fix(opencode): …`, `docs: …`; the subject does not start with a capital, and the
  header at most 100 characters).
- Keep a pull request to one change, with tests for it, and the gate green.
- A change users will notice needs a changeset: run `bunx changeset`, pick the bump (patch, minor or major) and
  write one or two sentences for the changelog. Changes to tests, CI or docs alone need none.

## Releases

Releases go through [Changesets](https://github.com/changesets/changesets) and `.github/workflows/release.yml`, the
workflow npm's trusted publisher is bound to (OIDC, no npm token). A commit that a pull request merged with its `ci`
check green, while up to date with its base, is not tested again. Any other commit, a direct push, first runs CI in the release workflow, sized by its
diff (a docs-only push runs only the format check).

A major ships on `beta` first. It becomes `latest` when its beta passes the scorecard
([`docs/dev/scorecard.md`](docs/dev/scorecard.md), "Release gate") and the owner says so; merging the "chore: release
catherd" pull request is that step.

1. A pull request with a changeset merges into `main`.
2. The release workflow opens or updates the "chore: release catherd" pull request, which bumps the version, writes
   `CHANGELOG.md` and stamps both plugin manifests, the shared launcher and shared skill pins from the package version (`bun run version-packages`). Its CI is short: it checks the
   format and runs the npm pack smoke on the new version, and skips the test matrix.
3. Merging it publishes `catherd-cli` to npm under `latest` (after the pack smoke, about a minute), pushes the
   `v<version>` tag, which the plugin marketplace serves, and creates a GitHub release.

## Beta channel

`beta` is a long-lived branch. A push to it publishes a snapshot, `x.y.z-beta.<datetime>` (for example
`1.3.0-beta.20260929095202`), under npm's `beta` dist-tag, in a few minutes. There is no release pull request, and
`latest` never moves. Publishing is latest-only: pushes that land while a beta publish runs collapse into one
snapshot of the newest commit. `x.y.z` is the version the branch's changesets would release, so a beta needs at least one
changeset; a push with none publishes nothing.

Why snapshots and not changesets pre mode: pre mode needs a version pull request on `beta` and a `changeset pre
exit` before promotion, and it commits `pre.json` and prerelease changelog entries that then conflict with `main`.
A snapshot changes only the release runner's copy, so `beta` keeps its changesets and promotes to `main` as a plain
merge.

Cut a beta:

```sh
git switch -c my-change origin/beta
bunx changeset                      # the bump the stable release will get
git push -u origin my-change        # open the pull request against beta; merge it when ci is green
```

A direct push to `beta` also publishes, after CI passes in the release workflow. After the publish,
`npm view catherd-cli dist-tags` shows it.

Use a beta:

- The CLI: `bunx catherd-cli@beta`, or `bun add -g catherd-cli@beta`.
- The plugin: each beta publish also force-pushes the `plugin-beta` branch, whose marketplace is named
  `catherd-beta` and pins the plugin to that beta. In Claude Code, uninstall the stable `catherd@catherd` first
  (both would start an MCP server named catherd), then:

  ```
  /plugin marketplace add https://github.com/47vigen/catherd.git#plugin-beta
  /plugin install catherd@catherd-beta
  ```

  After the next beta, run `/plugin marketplace update catherd-beta` and restart Claude Code. To go back,
  uninstall `catherd@catherd-beta` and install `catherd@catherd` again.

Promote beta to stable:

1. Open a pull request from `beta` to `main` and merge it **with a merge commit** (not squash), so `beta` stays an
   ancestor of `main`. Its changesets come along.
2. Merge the "chore: release catherd" pull request as usual; that publishes `latest`.
3. Bring `beta` up to date: `git push origin origin/main:beta` (a fast-forward). It publishes nothing, because the
   release consumed the changesets.

A fix that lands on `main` while a beta is open reaches `beta` by merging `main` into it.

## Maintenance line (1.x)

`1.x` is a long-lived branch cut from `v1.5.0`. It receives bug fixes only, so its changesets are `patch`; a stray
`minor` would release 1.6.0. This is a written rule, not a CI check.

- **A fix for code both lines have** lands on `main` first, then is cherry-picked onto a branch from `origin/1.x`,
  with its changeset:

  ```sh
  git switch -c fix-x origin/1.x && git cherry-pick -x <sha>   # open the pull request against 1.x
  ```

- **A fix for code 2.0 deleted** (the TUI, Grok Build, the benchmark sync) lands on `1.x` alone.
- **Release:** `ci.yml` and `release.yml` run on `1.x` like on `main`, in the same concurrency group, and the
  Release workflow opens "chore: release catherd 1.x". Merging it publishes the patch.
- **Dist-tag:** a 1.x publish goes to `latest` while npm's `latest` is a 1.x version, and to `v1-latest` once 2.x
  holds `latest`. (`v1` and `1.x` are semver ranges, which npm refuses as tags.) Users install `catherd-cli@1`; npm
  resolves it by range whatever the tags. After a 2.0 promotion, check `npm view catherd-cli dist-tags` once.
- **Plugin:** the `1.x` branch has its own marketplace, `https://github.com/47vigen/catherd.git#1.x`, stamped by its
  release pull request. The marketplace on `main` pins `v1.5.0` until 2.0.0 is released, because the plugin launcher
  pins the CLI version (`scripts/stamp-plugin-version.mjs`); before that, a 1.5.x fix reaches a plugin user only
  through `#1.x`.
- **Protection:** the owner sets branch protection for `1.x` (the required `ci` check) in the repository settings.
  Without it, a 1.x push is still tested by `release.yml`.

Runs started on 1.5 finish on 1.5 and are not migrated.

## Live tests and fixture capture

What CI cannot check, because it needs real accounts, is in
[`docs/dev/live-verification.md`](docs/dev/live-verification.md), with the exact commands. In short:

```sh
CATHERD_LIVE=1 bun test test/live/codex.live.test.ts          # also claude-code, opencode
CATHERD_LIVE=1 TYPESAFE_API_KEY=<key> bun test test/live/jev.live.test.ts
bun src/cli.ts capture-fixtures [--backend codex|claude-code|opencode] [--out <dir>]
```

Without `CATHERD_LIVE=1` the live tests are skipped. `capture-fixtures` records one cheap, isolated real run per
ready backend into `test/fixtures/adapters/<backend>/<cli-version>/`, with secrets, e-mail addresses and home paths
stripped; outside a source checkout it needs `--out`. Check the result for anything personal before you commit it.
The checks that need a human in Claude Code (plugin loading, long MCP calls) are in
[`docs/dev/manual-tests.md`](docs/dev/manual-tests.md).

`bun src/cli.ts scorecard prepare|record|compare` measures a catherd version on four fixed tasks against the 1.5.0
baseline, the gate for 2.0. It runs from a source checkout only (`scorecard/` is not in the npm package) and spends
real subscriptions, so it is never part of the tests. The protocol is in
[`docs/dev/scorecard.md`](docs/dev/scorecard.md).

Native packaging uses the same launcher/core and two shared skills with small host-specific declarations. The installed Codex CLI 0.159.2 proved relative plugin cwd resolution, including paths with spaces, without a root macro or synthetic session ID. `CATHERD_TEST_NATIVE_PLUGIN=1 bun test test/entry/plugin-packaging.test.ts` reproduces isolated parser/launcher feasibility only; `bun test/pack-smoke.ts` installs the real tarball and checks its inventory, core fingerprint and no-Claude-write contract. Follow section 14 for conversation acceptance; do not substitute those checks for actual idle/busy generation and `result` collection.

Verify the exact omitted Codex model ID `gpt-6.1-sol` against native catalog discovery and validation. If spelling differs, report the mismatch and resolve it explicitly with the owner; never silently normalize or substitute a model. Retain architect high and verifier low effort.

Read both packaged skills end to end for each host. `route` is authoritative for all roles: native `claude:` Agent/accounting is Claude Code only, while process architect/verifier use `dispatch`/`result` on either host. Pass actual project `repo` to repo-aware MCP profile/setup/catalog calls because native server cwd is the plugin root. Keep explicit profiles intact and use only the reviewed `reset-host-defaults --preview --json` / `--expect <file>` CLI path to remove architect/verifier `rungs` and `defaultRung`. Ordinary doctor sends nothing; `--test-push` is explicit. Inspect queue acceptance, observed processing and collection separately, preserve every event ID and the independent reviewer/verifier landing gate, and never turn duplicate input into a dispatch or second landing.

Development-only environment variables: `CATHERD_LIVE` (live tests), `CATHERD_PANEL_DIST` (another build of the
panel), and the simulators' `CATHERD_SIM_*`. The user-facing ones
are in the README.

## Where things live

- `docs/dev/`: maintainer docs: live verification, manual tests, [dependencies](docs/dev/dependencies.md) (why each
  one) and the [1.x ideas list](docs/dev/ideas.md).
- `docs/specs/`: the design specs (the 1.0 spec is binding). `docs/plans/`: the implementation plans.
  `docs/handoff/`: the handoff, ledgers and review records. catherd is built with coding agents; the contracts they
  work under are in `docs/handoff/process/`.
- `docs/research/`: the dated research behind the design decisions.
- `docs/archive/0.x/`: the 0.x design and plans, kept for history.
