# catherd 1.1, plan 12: failover, install and launch, docs, release — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish catherd 1.1: failover stand-ins that clear the same bars and the three new `validate` warnings (§11), a plugin that installs without SSH and a MCP launcher that survives macOS's `$TMPDIR` cleaning (§12), the small non-skill items (§13), the user docs (README, MIGRATION 1.0 → 1.1, live verification) and the 1.1.0 changeset.

**Architecture:** Failover rules become a small pure module, `src/domain/failover.ts` (bar dims, downgrade dims, stand-in ranking, the catalog's rungs), which `DEFAULT_FAILOVER` (pinned by a test that derives it), `validateProfile` and the labels read. The plugin starts its server through `plugin/bin/catherd-mcp`, a stamped POSIX `sh` launcher (global `catherd` at the plugin's version, else `bunx` with its cache under `~/.cache/catherd/bunx`); `doctor`'s handshake goes through the same launcher so its `mcp` row sees what Claude Code sees, and `init` installs the global CLI so the launcher rarely needs `bunx`. Everything else is text.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod, citty, `@modelcontextprotocol/sdk` (client stdio transport), `@opentui/react` (Status tab), POSIX `sh`, Changesets.

**Spec:** `docs/specs/2026-09-28-catherd-1.1-design.md` (§11, §12 install and launch, §13 non-skill items, §15 live checks), on top of `docs/specs/2026-09-25-catherd-1.0-design.md`.

**Pre-validated on scratch `a2e6aa4..4616b54` (worktree branch `worktree-agent-ad7eb81689f313c06`, head `4616b54`): 1214 pass / 0 fail / 10 skip; typecheck, lint and format:check green; `bun test/pack-smoke.ts` green; `bun run version-packages` stamps 1.1.0 and `test/plugin.test.ts` passes on it.** The code below is that scratch build, commit by commit. It was built on `main` (`a2e6aa4`), before plans 10 and 11: see "Assumes from earlier plans" for what to re-check.

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`); `src/domain/failover.ts` imports only domain.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`. Tests that spawn processes pass an explicit `env`; tests that could reach the network delete `ANTHROPIC_API_KEY` (in-process) or pass `ANTHROPIC_API_KEY: ""` (spawned). No test may reach the npm registry: spawned `doctor`/`init`/TUI runs put `test/bin` on PATH so the launcher never runs `bunx` (Task 5).
- No wall-clock sleeps for correctness.
- Commits: conventional, subject ≤ 100 characters, lower-case first word; check `git log` after each commit (a failed hook leaves the changes uncommitted).
- Spec 1.1 §11: stand-ins "clear the same bars as the rung"; "a rung with no such stand-in has none"; "Claude-billed rungs rank last as stand-ins"; `validate` **warns (never errors)**: "downgrade: X stands in for Y", "spends Claude quota", "the ladder goes down at X"; labels "scores borrowed from X", shown "only when the stand-in's own scores are missing".
- Spec 1.1 §12: marketplace `"url": "https://github.com/47vigen/catherd.git"`, keeping `path` and the stamped `ref`; `plugin/.mcp.json` runs `plugin/bin/catherd-mcp`, a POSIX `sh` script stamped with the version: `catherd --version` = stamped → `exec catherd mcp`, else `exec bunx catherd-cli@<version> mcp` with `TMPDIR` = `${XDG_CACHE_HOME:-$HOME/.cache}/catherd/bunx`; `init` runs `bun add -g catherd-cli@<version>`, skippable with `--no-global`, and says "installing catherd…" before any resolve; doctor's `mcp` row "starts the server the way the plugin does and reports "reinstall: <command>" when a module is missing".
- Spec 1.1 §13: doctor's shipped-default access rows as info (`i`), warnings only when the profile departs; the Status tab shows "…" before the first profiles read; README; MIGRATION.md 1.0 → 1.1 ("`wait` is gone, `peek` and `result` replace it") and the changelog (the changeset feeds it).
- Plan 12 ends with the only 1.1 changeset: `.changeset/*.md`, `"catherd-cli": minor`.
- Plan scope boundary: the §5/§12 doctor probes, `sandbox:codex` and the `push` row belong to plans 10 and 11; this plan only reads them in docs.

## Review Focus

1. **A 1.0 profile on disk keeps `sol#high/#xhigh → kimi-k3#max`.** Upgrading changes only the defaults; the saved map downgrades a climbed lane. Expected: `validate` (and doctor's `profile` row) warn `downgrade: …` with a fix that removes the entry. Pinned in Task 2 ("warns, never errs, on a stand-in that scores below its rung").
2. **A global `catherd` of another version on PATH** (the user upgraded the plugin, not the CLI). Expected: the launcher falls back to `bunx catherd-cli@<plugin version>` rather than starting a mismatched server. Pinned in Task 4 ("falls back to bunx at the stamped version").
3. **No `TMPDIR` in the user's env** (Linux desktops). Expected: the launcher still sets the bunx cache and the server gets TMPDIR unset again, not the cache dir. Pinned in Task 4 (`USER_TMPDIR=` and `restoreTmpdir` "unsets TMPDIR when the user had none").
4. **`doctor` from a plain terminal with neither `catherd` nor `bunx` on PATH.** Expected: the `mcp` row says `missing … reinstall: bun add -g catherd-cli@<v>`, not a bare "no answer". Pinned in Task 5 ("says to install catherd when the launcher finds neither it nor bunx").
5. **`init` on a machine whose registry is down or blocked.** Expected: one `!` line with the retry command, and `init` goes on to the profile and the report. Pinned in Task 6 ("goes on after a failed install, with the command to retry").

## Assumes from earlier plans

Plan 10 (`docs/plans/2026-09-28-10-push-sessions.md`) and plan 11 (`docs/plans/2026-09-28-11-access-protocol.md`) merge before this plan executes. The executor re-checks each item and the diff anchors against `main`:

- **MCP tools: 25** — `wait` removed, `peek`, `gate_check`, `gate_pass`, `park`, `answer` added; `result` consumes the `collect` marker. This plan adds no tool. Task 5's handshake test asserts only that `status` is listed.
- **doctor (plan 10, 11):** a `push` row; `access:<backend>` probe rows (`access:codex`, `access:opencode`, `access:claude-code`) and `sandbox:codex` in the new `codex sandbox [--config …] -- <cmd>` form. Task 7's rows keep the ids `access:full` and `access:advisory` (no clash with a backend id). Tasks 5 and 7 edit `src/services/doctor.ts` at the `mcp` handshake block, the `full`/`advisory` loop and the `bunx` row: plan 11 rewrites the sandbox block between them, so re-find the hunks by their text. `test/services/doctor.test.ts`'s "is ready when everything…" `states` map will carry plan 10/11's new rows too: change only `access:full`/`access:advisory` to `"info default"`.
- **`startMcpServer` (plan 10)** reads the session env at start. Task 4 calls `restoreTmpdir(process.env)` before it; order does not matter to plan 10.
- **The catherd skill (plan 11 rewrite)** still pins `catherd-cli@<version>` at least once (the lock command); Task 4's stamp test requires ≥ 1 pin and all equal. If plan 11 dropped every pin, drop that assertion and say so in the ledger.
- **`roles.<role>.network` (plan 11)** exists; Tasks 8–10 name it in docs only.
- **Runs page by session (plan 10):** `catherd runs list`/`status` `--json` gain `session`; docs only here.
- **README (plans 10, 11)** may already have lost the `CATHERD_TICK_MS` sentence or gained 1.1 lines; Task 8's generator-style edits are content, not anchors: keep what they already say, add what is missing, never state a thing twice.
- **`test/entry/tui/pty.test.ts`, `test/entry/init-command.test.ts`, `test/entry/doctor-command.test.ts`** keep the PATH lines Task 5 edits (plans 10/11 may add env entries next to them).
- On `main` (`a2e6aa4`) none of plan 10/11's interfaces exist; the scratch build needed no stub, since this plan's code reads none of them.

## Rulings on the spec

1. **"Clears the same bars" = no downgrade on the rung's bar dims.** A stand-in fits a rung when, on every dim used by a routing bar the rung clears, it scores at least the rung's score (a missing score counts as below). This implies it clears every bar the rung clears. — The shipped defaults must validate with no warning (1.0.0 fresh-install finding "warnings on the defaults"), and the evidence behind §11 is a climbed lane silently dropping back a tier; a bars-only reading keeps `sol#xhigh → kimi` and then warns on the defaults. — Cost if wrong: Sol high and xhigh lose their default stand-in (a limit there pauses the lane: "paused: no stand-in").
2. **Default stand-ins are paid from a plan or subscription only** (cost tier 0 under the profile's billing): no metered Zen, no Fable on the Claude plan. — A stand-in nobody chose must not spend money. — Cost if wrong: a user with Zen credit gets no automatic Sol stand-in (`opencode:opencode/gpt-6-sol#<same effort>` would fit; they can set it).
3. **`DEFAULT_FAILOVER` stays a constant**, pinned by a test that derives it with `rankStandIns` over `catalogRungs(shipped catalog)`. — The domain has no catalog loader at import time; the test keeps constant and rule in step. — Cost if wrong: a catalog edit fails that test until the constant is updated (intended).
4. **"Claude-billed rungs rank last"** is the first sort key of `rankStandIns` (then cost, then name), used for the derivation and for `validate`'s fixes; the TUI failover picker keeps its order. — YAGNI. — Cost if wrong: the picker may list a Claude rung first.
5. **`catalogRungs`** = each shipped family's model on each backend at each shipped effort, each listed model at each listed effort, and each treat-like whose model is an opencode id (the shipped Kimi K3). — Kimi exists only as a treat-like until opencode is listed. — Cost if wrong: a stand-in named only in a user's non-opencode treat-like is not considered for fixes.
6. **Warning texts:** `downgrade: <to> stands in for <from>, scoring below it on <dims>` (fix: `catherd profile set failover.<from> <best|null>`); `stand-in <to> spends Claude quota, while <other> could stand in on another plan` (fix: set `<other>`); `the ladder goes down at <rung>: it scores below <prev> on <dims>` (fix: `order roles.<role>.rungs weakest first`). — The spec quotes the key phrase; the rest says what to do. — Cost if wrong: text only.
7. **"Another backend could stand in"** = a non-Claude rung that fits (Ruling 1), on a backend catherd can run, paid from a plan under this profile's billing. — Same money rule as Ruling 2. — Cost if wrong: a Zen user misses a "spends Claude quota" warning.
8. **"The ladder goes down"** = the later rung scores below the earlier on at least one dim both are scored on and above it on none. — The default worker ladder trades repo_code for honesty at Luna high → Sol medium and must stay clean. With the shipped scores, Opus xhigh → Opus max (terminal 66.4 → 64.8) now warns; that is the published data. — Cost if wrong: a mixed trade-down is not flagged.
9. **Labels:** "scores borrowed from X" only when the stand-in has no scores of its own (`via` from a treat-like); stand-ins with their own `inferred` scores get no label; the model/effort marks in the TUI's role trees keep "inferred" (they describe confidence, not stand-ins); `profile show --json` `standIns` keep `{ from, to, inferred, via }`. — The spec speaks of stand-ins. — Cost if wrong: one more label to change.
10. **The launcher runs as `sh ${CLAUDE_PLUGIN_ROOT}/bin/catherd-mcp`** and is also committed 755. — No reliance on the exec bit surviving a marketplace clone or `npm pack`. — Cost if wrong: none known.
11. **The user's TMPDIR travels as `CATHERD_USER_TMPDIR`** (empty when unset); `catherd mcp` restores it before starting the server. — Otherwise every worker writes temp files into the bunx cache, and plan 11's writable roots point there. — Cost if wrong: one env var.
12. **Version match is exact string equality** of `catherd --version` with the stamped `VERSION`. — `--version` prints the bare version. — Cost if wrong: a prerelease suffix mismatch falls back to bunx (still correct).
13. **The marketplace keeps `"source": "git-subdir"`**, now with the HTTPS URL; README keeps `claude plugin marketplace add 47vigen/catherd` (the marketplace clone worked; only the plugin source needed SSH). — Smallest change the spec names. — Cost if wrong: re-add instructions if the marketplace clone also needs a URL.
14. **doctor's handshake runs the launcher with the user's env** (faithful to the plugin), with a 60 s timeout (a cold bunx resolve took ~30 s). Tests put `test/bin/catherd` (this checkout) on PATH. — The row is only useful if it sees what Claude Code sees. — Cost if wrong: `doctor` on a dev checkout at an unpublished version, without a global catherd, tries to fetch that version and fails the row.
15. **`mcp` row wording:** a missing module (`Cannot find module|package`) → `broken install`, detail `cannot load <module>; reinstall: <cmd>`; `bunx: not found` → `missing`, detail `no catherd <v> on PATH and no bunx to fetch it; reinstall: <cmd>`; `<cmd>` = `bun add -g catherd-cli@<v>`, also the row's `fix` (so `y` copies a runnable command). — Spec: "reinstall: <command>". — Cost if wrong: text only.
16. **The `bunx` row shows only when neither `bunx` nor `catherd` is on PATH.** — The launcher needs bunx only without a global install. — Cost if wrong: a stale global catherd plus no bunx is reported by the `mcp` row instead.
17. **`init`'s global step runs first** (before the Jev key); it is skipped when `catherd --version` already prints this version; a failed install is a `!` line with its fix and never stops `init`; `--no-global` is declared as `no-global` and read as `global === false` (citty's `--no-` handling, as `--no-input`). — "before any resolve it triggers". — Cost if wrong: order of lines only.
18. **`info` state:** glyph `i` (ASCII `i`), colour token `info`; one row per kind: `info default` when all entries are as shipped, else `warn warning` listing the changed entries then `as shipped: …`. An advisory entry is "as shipped" when the role's access is its default and the backend is one of the built-in role's rung backends. — Spec 1.1 §13. — Cost if wrong: row wording.
19. **The Status tab shows "…" until a profiles read succeeds** (also when the first read fails). — Same frame bug either way. — Cost if wrong: none.
20. **MIGRATION.md becomes "# Upgrading catherd"** with "From 1.0 to 1.1" first and the 0.x text under "From 0.x to 1.0" (headings demoted one level). — One file, newest first. — Cost if wrong: anchors in old links (`#upgrading-from-catherd-0x-to-10`) break.
21. **live-verification:** new §7 push, §8 worker access, §9 the 1.1 acceptance (spec §15 owner steps 1 and 2, exact commands); §4's old sandbox text is plan 11's to update. — Plan split. — Cost if wrong: §4 stays stale if plan 11 skipped it.
22. **The changeset is `.changeset/catherd-1-1.md`**, one minor bump summarising all of 1.1. — The brief. — Cost if wrong: none.

## Owner questions (provisional defaults chosen)

1. **Sol high and xhigh have no default stand-in** (Ruling 1–2): a usage limit on them pauses the lane. The alternative is Zen's own Sol at the same effort (`opencode:opencode/gpt-6-sol#high|#xhigh`), which fits exactly but is metered. Provisional: none.
2. **The real acceptance run's prompt** (spec §15.2): provisional `/catherd auth plan 5, MR B (kit clean-up)` in the `sanitell/platform` checkout after `glab mr merge 54`; the owner may prefer to paste the plan path.

## Verified facts (scratch build, 2026-09-28)

- Shipped scores (`catalog/scores.json`): Luna high repo_code 59.3 / honesty 71.3; Sol medium 56.6 / 95.1; Sol high 65.3 / 95.1; Sol xhigh 66.6 / 95.1; Kimi K3 max borrows Sol medium (treat-like); Opus rungs below max borrow xhigh (terminal 66.4 only). Bars use repo_code ≥ 55 and honesty ≥ 90 (terminal bars: honesty only). So Luna high's bar dims are `[repo_code]`, Sol's are `[repo_code, honesty]`, Opus high's are `[]`.
- Deriving the defaults with Rulings 1–2 gives exactly `{ luna#high → opencode-go/gpt-6-luna#high, sol#medium → opencode-go/kimi-k3#max }`; the default profile then validates with `{ errors: [], warnings: [] }`.
- `validateProfile` iterates `p.failover` in insertion order; changing the defaults reorders warnings in "warns on a stand-in that never runs" (the test is updated).
- `catherd --version` prints the bare version; citty reads `--no-<x>` as `<x>: false`.
- oxfmt formats the root `*.md` (README, MIGRATION, CHANGELOG, `.changeset/`) with `printWidth` 110; it ignores `docs/**`.
- `StdioClientTransport({ stderr: "pipe" })` exposes `transport.stderr` before `connect`.
- Run folders are `<data>/repos/<repo key>/runs/<run id>/`; `runs show --json` is `{ summary, records }`; `status --json` is `{ runs: RunSummary[], warnings }`; `record_agent_run` rows carry `durationMs`.
- `bun test/pack-smoke.ts` passes with the launcher once the installed `node_modules/.bin` is on the smoke's PATH.
- Full suite: about 3 minutes.

## File Structure

| File | Task | Responsibility |
| --- | --- | --- |
| `src/domain/failover.ts` (new) | 1, 2 | quota, bar dims, downgrade dims, ladder drops, stand-in ranking, the catalog's rungs |
| `src/domain/profile.ts` | 1 | `DEFAULT_FAILOVER` |
| `src/domain/profile-rules.ts` | 1, 2 | `quotaOf` re-export; the three new warnings |
| `src/entry/profile-command.ts`, `src/entry/tui/profile-tree.ts`, `src/entry/tui/profile-edits.ts` | 3 | "scores borrowed from X" |
| `plugin/bin/catherd-mcp` (new), `plugin/.mcp.json`, `.claude-plugin/marketplace.json`, `scripts/stamp-plugin-version.mjs` | 4 | install and launch |
| `src/infra/env.ts`, `src/entry/mcp/command.ts` | 4 | `restoreTmpdir` at server start |
| `src/entry/mcp/handshake.ts`, `src/services/doctor-checks.ts`, `src/services/doctor.ts` | 5, 7 | the `mcp` row, the `bunx` row, access rows, the `info` state |
| `src/services/global-install.ts` (new), `src/entry/init-command.ts` | 6 | the global install step |
| `src/entry/glyphs.ts`, `src/entry/tui/theme.ts`, `src/entry/tui/views/status.tsx` | 7 | `info` glyph and colour; "…" |
| `test/bin/catherd` (new) | 5 | a test shim: the launcher's "global catherd" is this checkout |
| `README.md`, `MIGRATION.md`, `docs/dev/live-verification.md`, `plugin/skills/catherd-setup/SKILL.md` | 1, 2, 6, 8, 9 | docs |
| `.changeset/catherd-1-1.md` (new) | 10 | the 1.1.0 release note |

## Parallelism

| Wave | Tasks (parallel worktrees) | Depends on | Why disjoint |
| --- | --- | --- | --- |
| A | 1, 4 | — | domain/profile files and the setup skill vs plugin/, env, mcp command, plugin tests |
| B | 2, 3, 5 | 2 and 3 on 1; 5 on 4 | profile-rules + failover.ts + setup skill (2) vs profile-command/TUI profile files (3) vs doctor, handshake, test PATH lines (5) |
| C | 6, 7 | 5 | init-command, global-install, help-text test, README row (6) vs glyphs, theme, status tab, doctor.ts, doctor-checks.ts (7) |
| D | 8, 9 | 6 (README), 1 (live-verification §6.4) | README + MIGRATION vs live-verification |
| E | 10 | all | the changeset |

Tasks 1–3 share `test/entry/tui/profile-tree.test.ts` (1 and 3) and `plugin/skills/catherd-setup/SKILL.md` (1 and 2): hence 1 before 2 and 3. Tasks 5, 6 and 7 share `test/entry/init-command.test.ts` (5, 6), `src/services/doctor.ts`, `doctor-checks.ts` and their tests (5, 7): hence 5 first. Batching for one agent: {1, 2}, {3}, {4, 5}, {6}, {7}, {8, 9, 10}.

---

### Task 1: Failover stand-ins that clear the same bars (spec 1.1 §11)

**Files:**
- Create: `src/domain/failover.ts` (quota, bar dims, downgrade dims, stand-in ranking, catalog rungs)
- Modify: `src/domain/profile-rules.ts` (`quotaOf` moves to failover.ts and is re-exported), `src/domain/profile.ts` (`DEFAULT_FAILOVER`)
- Modify: `plugin/skills/catherd-setup/SKILL.md` (the failover paragraph), `docs/dev/live-verification.md` (§6.4's "default failover map")
- Test: `test/domain/failover.test.ts` (new), `test/domain/profile.test.ts`, `test/domain/profile-rules.test.ts`, `test/entry/tui/profile-tree.test.ts`

**Interfaces:**
- Consumes: `scoresOf`, `rungInfo`, `billingKeyOf`, `DIMS` (catalog.ts); `costOf`, `compareCost`, `DEFAULT_BILLING` (cost.ts); `KINDS`, `DIFFICULTIES` (lane.ts).
- Produces (all in `src/domain/failover.ts`): `quotaOf(r: Rung): string`; `claudeBilled(rung: string): boolean`; `barDims(c: Catalog, rung: string): Dim[]`; `downgradeDims(c: Catalog, rung: string, standIn: string): Dim[]`; `rankStandIns(c: Catalog, billing: Partial<Record<string, BillingMode>>, rung: string, pool: readonly string[]): string[]` (best first, Claude-billed last); `catalogRungs(c: Catalog): string[]`. `profile-rules.ts` still exports `quotaOf` (re-export) for `src/entry/tui/profile-edits.ts`. `DEFAULT_FAILOVER` becomes `{ "codex:gpt-6-luna#high": "opencode:opencode-go/gpt-6-luna#high", "codex:gpt-6-sol#medium": "opencode:opencode-go/kimi-k3#max" }`.

- [ ] **Step 1: Write the failing tests**

Create `test/domain/failover.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { DEFAULT_BILLING } from "../../src/domain/cost.ts";
import {
  barDims,
  catalogRungs,
  claudeBilled,
  downgradeDims,
  rankStandIns,
} from "../../src/domain/failover.ts";
import { BUILTIN_ROLES, DEFAULT_FAILOVER } from "../../src/domain/profile.ts";
import { shipped } from "./shipped.ts";

const LUNA = "codex:gpt-6-luna#high";
const SOL = (e: string) => `codex:gpt-6-sol#${e}`;
const KIMI = "opencode:opencode-go/kimi-k3#max";
const GO_LUNA = "opencode:opencode-go/gpt-6-luna#high";

describe("the dims a rung's bars use (spec 1.1 §11)", () => {
  it("are the dims of every bar the rung clears", () => {
    const c = shipped();
    // Luna high: repo_code 59.3, honesty 71.3 → clears the repo_code-only copy/build bars
    expect(barDims(c, LUNA)).toEqual(["repo_code"]);
    // Sol medium clears every bar, which use repo_code and honesty
    expect(barDims(c, SOL("medium"))).toEqual(["repo_code", "honesty"]);
    // Opus high borrows xhigh's terminal score only and clears no bar
    expect(barDims(c, "claude-code:claude-opus-5-5#high")).toEqual([]);
    expect(barDims(c, "codex:not-a-model#high")).toEqual([]);
  });
});

describe("downgradeDims", () => {
  it("names each bar dim the stand-in scores below the rung on, a missing score counting as below", () => {
    const c = shipped();
    expect(downgradeDims(c, SOL("medium"), KIMI)).toEqual([]);
    expect(downgradeDims(c, SOL("xhigh"), KIMI)).toEqual(["repo_code"]);
    expect(downgradeDims(c, SOL("high"), GO_LUNA)).toEqual(["repo_code", "honesty"]);
    expect(downgradeDims(c, SOL("medium"), "claude-code:claude-opus-5-5#high")).toEqual([
      "repo_code",
      "honesty",
    ]);
    expect(downgradeDims(c, "claude-code:claude-opus-5-5#high", GO_LUNA)).toEqual([]);
  });
});

describe("rankStandIns", () => {
  it("keeps stand-ins on another quota, scored, paid from a plan and no downgrade; Claude-billed last", () => {
    const c = shipped();
    const pool = [
      "codex:gpt-6-luna#max", // same quota as Luna high
      "opencode:opencode/gpt-6-luna#high", // Zen: metered
      "claude:claude-opus-5-5#high", // native: dispatch cannot start it
      "claude-code:claude-opus-5-5#high", // no score on repo_code, the bar dim Luna high uses
      "claude-code:claude-opus-5-5#max", // repo_code 74.2: fits, but on the Claude plan
      "opencode:opencode-go/gpt-5.6-luna#max",
      GO_LUNA,
      "opencode:opencode-go/nope#high", // unscored
    ];
    expect(rankStandIns(c, DEFAULT_BILLING, LUNA, pool)).toEqual([
      GO_LUNA,
      "opencode:opencode-go/gpt-5.6-luna#max",
      "claude-code:claude-opus-5-5#max",
    ]);
    expect(rankStandIns(c, DEFAULT_BILLING, "not a rung", pool)).toEqual([]);
  });

  it("takes a Zen stand-in when the profile bills Zen on a subscription", () => {
    const c = shipped();
    const zen = "opencode:opencode/gpt-6-sol#high";
    expect(rankStandIns(c, DEFAULT_BILLING, SOL("high"), [zen])).toEqual([]);
    expect(rankStandIns(c, { ...DEFAULT_BILLING, opencode: "subscription" }, SOL("high"), [zen])).toEqual([
      zen,
    ]);
  });

  it("marks the rungs that draw on the Claude plan", () => {
    expect(claudeBilled("claude:claude-opus-5-5#high")).toBe(true);
    expect(claudeBilled("claude-code:claude-sonnet-5#high")).toBe(true);
    expect(claudeBilled(KIMI)).toBe(false);
    expect(claudeBilled("nope")).toBe(false);
  });
});

describe("catalogRungs", () => {
  it("lists every shipped family rung, every listed model's efforts, and opencode treat-likes", () => {
    const c = shipped({
      listed: {
        opencode: {
          fetchedAt: "2026-09-28T00:00:00.000Z",
          models: [{ id: "opencode-go/glm-5.3", efforts: ["high"], context: 1, imageIn: false }],
        },
      },
    });
    const all = catalogRungs(c);
    expect(all).toContain("codex:gpt-6-sol#xhigh");
    expect(all).toContain("claude-code:claude-opus-5-5#max");
    expect(all).toContain("opencode:opencode-go/gpt-6-luna#high");
    expect(all).toContain("opencode:opencode/claude-opus-5-5#high");
    expect(all).toContain("opencode:opencode-go/glm-5.3#high");
    expect(all).toContain(KIMI);
    expect(all.some((r) => r.startsWith("opencode:claude-opus-5-5#"))).toBe(false);
    expect(all).toEqual([...new Set(all)].sort());
  });
});

describe("DEFAULT_FAILOVER (spec 1.1 §11)", () => {
  it("is, for each shipped worker rung, the best stand-in the shipped catalog offers, and none without one", () => {
    const c = shipped();
    const expected: Record<string, string> = {};
    for (const rung of new Set(BUILTIN_ROLES.worker.rungs)) {
      const best = rankStandIns(c, DEFAULT_BILLING, rung, catalogRungs(c))[0];
      if (best) expected[rung] = best;
    }
    expect(DEFAULT_FAILOVER).toEqual(expected);
    expect(DEFAULT_FAILOVER).toEqual({ [LUNA]: GO_LUNA, [SOL("medium")]: KIMI });
  });
});
```

Edit `test/domain/profile-rules.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/domain/profile-rules.test.ts b/test/domain/profile-rules.test.ts
index 9c3a7d6..6342c7b 100644
--- a/test/domain/profile-rules.test.ts
+++ b/test/domain/profile-rules.test.ts
@@ -119,12 +119,12 @@ describe("validateProfile", () => {
         "codex:gpt-6-sol#high": "claude:claude-opus-5-5#high",
       },
     });
     expect(v.errors).toEqual([]);
     expect(messages(v.warnings)).toEqual([
-      "stand-in claude:claude-opus-5-5#high is a native subagent: the orchestrator must start it, dispatch cannot",
       "codex:gpt-6-astra#high is on no enabled role's ladder, so this never runs",
+      "stand-in claude:claude-opus-5-5#high is a native subagent: the orchestrator must start it, dispatch cannot",
     ]);
   });
 
   it("warns when the backend's last listing lacks a model, and when an unlisted model's effort cannot be checked", () => {
     const listed = shipped({
```

Edit `test/domain/profile.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/domain/profile.test.ts b/test/domain/profile.test.ts
index a5f7009..6dde6c4 100644
--- a/test/domain/profile.test.ts
+++ b/test/domain/profile.test.ts
@@ -49,13 +49,13 @@ describe("the default profile (spec §7.2)", () => {
       writer: "workspace-write",
       researcher: "read-only",
     });
   });
 
-  it("fails every Codex rung over to OpenCode Go, and writes out every field", () => {
+  it("fails the worker rungs that have a fitting stand-in over to OpenCode Go, and writes out every field", () => {
     expect(p.failover).toEqual(DEFAULT_FAILOVER);
-    expect(Object.keys(DEFAULT_FAILOVER).sort()).toEqual([...new Set(p.roles.worker.rungs)].sort());
+    for (const from of Object.keys(DEFAULT_FAILOVER)) expect(p.roles.worker.rungs).toContain(from);
     expect(Object.keys(defaultProfileDoc())).toEqual([
       "schema",
       "name",
       "objective",
       "jev",
@@ -295,18 +295,18 @@ describe("patchBetween", () => {
   it("is the patch that turns one document into the other, and nothing else", () => {
     const a = { ...defaultProfileDoc(), theme: "ginger" } as ReturnType<typeof defaultProfileDoc>;
     const b = applyPatch(a, {
       budget: { usd: 5 },
       roles: { worker: { rungs: ["codex:gpt-6-sol#high"], defaultRung: null } },
-      failover: { "codex:gpt-6-sol#high": null },
+      failover: { "codex:gpt-6-sol#medium": null },
       notify: ["finish"],
     });
     const p = patchBetween(a, b);
     expect(p).toEqual({
       budget: { usd: 5 },
       roles: { worker: { rungs: ["codex:gpt-6-sol#high"], defaultRung: null } },
-      failover: { "codex:gpt-6-sol#high": null },
+      failover: { "codex:gpt-6-sol#medium": null },
       notify: ["finish"],
     });
     expect(applyPatch(a, p)).toEqual(b);
     expect(patchBetween(a, a)).toEqual({});
   });
```

Edit `test/entry/tui/profile-tree.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/entry/tui/profile-tree.test.ts b/test/entry/tui/profile-tree.test.ts
index d2fb76d..0201a4a 100644
--- a/test/entry/tui/profile-tree.test.ts
+++ b/test/entry/tui/profile-tree.test.ts
@@ -127,11 +127,12 @@ describe("the Profiles tree (spec §9.1)", () => {
     });
   });
 
   it("marks both default stand-ins inferred, as plan 5 Ruling 2 says (spec §7.2)", () => {
     const rows = buildRows(input());
-    expect(row(rows, "failover:codex:gpt-6-sol#high").value).toBe("→ kimi-k3#max (inferred)");
+    expect(row(rows, "failover:codex:gpt-6-sol#medium").value).toBe("→ kimi-k3#max (inferred)");
+    expect(row(rows, "failover:codex:gpt-6-sol#high").value).toBe("none");
     expect(row(rows, "failover:codex:gpt-6-luna#high").value).toBe("→ gpt-6-luna#high (inferred)");
   });
 
   it("puts a validation issue on the row it is about", () => {
     const profile = resolveProfile(
@@ -215,11 +216,11 @@ describe("edits", () => {
       ["codex:gpt-6-sol#xhigh", false],
     ]);
     withHome();
     const c = loadCatalog({ timings: false });
     const models = catalogQuery({ scoredOnly: false, limit: 1000 }, p.billing).models;
-    const standIns = failoverOptions(p, models, c, "codex:gpt-6-sol#high");
+    const standIns = failoverOptions(p, models, c, "codex:gpt-6-sol#medium");
     expect(standIns[0]).toEqual({ value: "", title: "none", current: false });
     expect(standIns.some((o) => o.value.startsWith("codex:"))).toBe(false);
     expect(standIns.some((o) => o.value === "claude-code:claude-opus-5-5#xhigh")).toBe(true);
     const likes = treatLikeOptions(c);
     expect(likes.map((o) => o.value)).toContain("gpt-6-sol#medium");
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/domain/failover.test.ts`
Expected: FAIL: `Cannot find module "../../src/domain/failover.ts"`.

- [ ] **Step 3: Implement**

Edit `docs/dev/live-verification.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/docs/dev/live-verification.md b/docs/dev/live-verification.md
index 0dfc8e3..f585c60 100644
--- a/docs/dev/live-verification.md
+++ b/docs/dev/live-verification.md
@@ -191,11 +191,11 @@ runs show <run id> --json` holds the records; write down what you saw.
    EOF
    chmod +x /tmp/fake-codex/codex
    PATH="/tmp/fake-codex:$PATH" claude
    ```
 
-   Keep the default failover map (each Codex rung to OpenCode Go), or without Go point the Codex rung
+   Keep the default failover map (Luna high and Sol medium to OpenCode Go; Sol high and xhigh have no default stand-in), or without Go point the Codex rung
    `route` picks for the lane at a stand-in you have, for example: `profile set failover.codex:gpt-6-luna#high claude-code:claude-sonnet-5#high`.
    Run a one-lane task. Look for: a record with status `limit` on the Codex rung, and a second record on the
    stand-in rung whose `failoverFrom` names the Codex rung; the lane finishes on the stand-in. Afterwards
    `rm -rf /tmp/fake-codex` and start Claude Code again from a normal shell.
 5. **A budget stop.** `profile set budget.tokens 1000`, then a run with two milestones. Look for: the first
````

Edit `plugin/skills/catherd-setup/SKILL.md` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/plugin/skills/catherd-setup/SKILL.md b/plugin/skills/catherd-setup/SKILL.md
index e99f09d..0f670b2 100644
--- a/plugin/skills/catherd-setup/SKILL.md
+++ b/plugin/skills/catherd-setup/SKILL.md
@@ -53,11 +53,11 @@ Each proposal has three parts: the change, a worked example from their facts, an
 - Offer only the rungs `catalog_query` lists as capable for the role, written `backend:model#effort`.
 - An unscored model can be enabled only once it has a "treat like <scored rung>". There is no tool for that: give the user the command to run in a terminal, `catherd catalog treat-like <rung> <scored rung>`, then come back and propose again.
 
 **Access.** Each role runs `read-only`, `workspace-write` or `full`. The defaults: architect, reviewer and researcher `read-only`; worker, writer and artist `workspace-write`; verifier and UI reviewer `full`. `profile_get` says per role whether its backend holds it to that mode (`enforced`: Codex's sandbox) or only asks (`advisory`: claude-code, opencode and native subagents, where the model can still reach past it). Recommend the defaults; when the user wants a role tighter or looser, say what it can no longer do (a read-only reviewer on claude-code or opencode has no shell, so it cannot run `git diff`) and that `profile_validate` will warn about it.
 
-**Failover.** `failover` maps a rung to its stand-in when that rung's backend hits a usage limit. A stand-in must be scored and on another quota (Go and Zen bill apart; native `claude` and `claude-code` share the Claude plan). The default profile fails each Codex rung over to OpenCode Go, marked inferred: Go's GPT-6 Luna for Luna, and Kimi K3, treated like Sol medium, for Sol. Say so, and offer to change it when they have no Go subscription. `null` removes an entry.
+**Failover.** `failover` maps a rung to its stand-in when that rung's backend hits a usage limit. A stand-in must be scored and on another quota (Go and Zen bill apart; native `claude` and `claude-code` share the Claude plan). The default profile fails a Codex rung over only to a stand-in that clears the same bars at least as well: Go's GPT-6 Luna for Luna high, and Kimi K3 (its scores borrowed from Sol medium) for Sol medium. Sol high and xhigh have none, so a limit there pauses the lane rather than dropping it a tier. Say so, and offer to change it when they have no Go subscription. `null` removes an entry.
 
 **Budget and timeouts.** `budget` (`minutes`, `tokens`, `usd`) is a soft cap: from 80 % routing starts at the cheapest rung that clears the bar, and at 100 % no new role starts. `timeouts.idleMin` (15) stops a role that has gone quiet, `timeouts.wallMin` (90) one that runs too long. `preflight.confirm: true` makes `preflight` show its commands for the user to approve first.
 
 **Harness isolation.** For each harness they use (`codex`, `claude-code`, `opencode`), offer `harness.<name>.isolated` with its harness line from `runs_summary` (Codex has none: it reports no per-request input, so say there is no figure for it instead of offering one) and this tradeoff: "native keeps your hooks, skills and AGENTS.md; isolated saves ~N tokens per run, but the role loses them." Recommend native. When they have no isolated runs yet, the number is the median first-turn input of their native runs: say that isolation would save some part of it, not all of it. When there are no runs at all, say there is no number yet, and recommend native until there is.
```

Create `src/domain/failover.ts`:

```ts
import { billingKeyOf, type Catalog, DIMS, type Dim, rungInfo, scoresOf } from "./catalog.ts";
import { type BillingMode, compareCost, type Cost, costOf, DEFAULT_BILLING } from "./cost.ts";
import { type Rung, tryParseRung } from "./ids.ts";
import { DIFFICULTIES, KINDS } from "./lane.ts";

/**
 * Spec §7.1 and §4.5: a stand-in on the same quota would be out of quota too. The billing key names the
 * quota, except that the native `claude` path and headless `claude-code` both draw on the Claude plan.
 */
export const quotaOf = (r: Rung): string => (billingKeyOf(r) === "claude" ? "claude-code" : billingKeyOf(r));

/** Whether a rung draws on the Claude plan (native `claude:` or headless `claude-code:`). */
export function claudeBilled(rung: string): boolean {
  const r = tryParseRung(rung);
  return r !== null && quotaOf(r) === "claude-code";
}

/** A rung's scores by dim, its own or borrowed through a treat-like; null when unscored or not a rung. */
function valuesOf(c: Catalog, rung: string): Partial<Record<Dim, number>> | null {
  try {
    return scoresOf(c, rungInfo(c, rung).canonical)?.values ?? null;
  } catch {
    return null;
  }
}

/** The dims used by the routing bars (kind × difficulty) the rung clears: what makes it fit its lanes. */
export function barDims(c: Catalog, rung: string): Dim[] {
  const v = valuesOf(c, rung);
  if (!v) return [];
  const used = new Set<Dim>();
  for (const kind of KINDS)
    for (const d of DIFFICULTIES) {
      const bar = Object.entries(c.bars[kind][d]).filter(([, min]) => min !== undefined) as [Dim, number][];
      if (bar.every(([dim, min]) => (v[dim] ?? Number.NEGATIVE_INFINITY) >= min))
        for (const [dim] of bar) used.add(dim);
    }
  return DIMS.filter((d) => used.has(d));
}

/**
 * Spec 1.1 §11: the dims, among those the rung's bars use, on which `standIn` scores below `rung` (a
 * missing score counts as below). Empty means the stand-in clears every bar the rung clears, at least as
 * well: no downgrade.
 */
export function downgradeDims(c: Catalog, rung: string, standIn: string): Dim[] {
  const a = valuesOf(c, rung);
  if (!a) return [];
  const b = valuesOf(c, standIn) ?? {};
  return barDims(c, rung).filter((d) => (b[d] ?? Number.NEGATIVE_INFINITY) < (a[d] as number));
}

const costFor = (c: Catalog, billing: Partial<Record<string, BillingMode>>, rung: string): Cost => {
  const info = rungInfo(c, rung);
  return costOf(info.family, info.parsed.effort, billing[info.key] ?? DEFAULT_BILLING[info.key]);
};

/**
 * Spec 1.1 §11: the rungs of `pool` that can stand in for `rung`, best first. A stand-in is on another
 * quota, scored, paid from a plan or subscription under `billing` (a metered one spends money nobody chose
 * to), startable by `dispatch` (not a native `claude:` subagent), and no downgrade on the rung's bar dims.
 * Claude-billed stand-ins rank last, then the cheapest first.
 */
export function rankStandIns(
  c: Catalog,
  billing: Partial<Record<string, BillingMode>>,
  rung: string,
  pool: readonly string[],
): string[] {
  const from = tryParseRung(rung);
  if (!from) return [];
  const fits = [...new Set(pool)].filter((x) => {
    const r = tryParseRung(x);
    if (!r || r.backend === "claude" || quotaOf(r) === quotaOf(from) || !valuesOf(c, x)) return false;
    if (costFor(c, billing, x).tier === 1) return false;
    return downgradeDims(c, rung, x).length === 0;
  });
  return fits.sort(
    (a, b) =>
      Number(claudeBilled(a)) - Number(claudeBilled(b)) ||
      compareCost(costFor(c, billing, a), costFor(c, billing, b)) ||
      a.localeCompare(b),
  );
}

/** How a family's `on` key or a model id's prefix maps to the backend that runs it. */
const BACKEND_OF_KEY: Record<string, string> = { "opencode-go": "opencode" };

/**
 * Every rung the catalog knows how to name: each shipped family's model on each backend at each effort,
 * each listed model at each effort, and each treat-like whose model is an opencode id (`opencode-go/…`,
 * `opencode/…`), such as the shipped Kimi K3 stand-in. Sorted, without duplicates.
 */
export function catalogRungs(c: Catalog): string[] {
  const out = new Set<string>();
  for (const f of c.families)
    for (const [key, m] of Object.entries(f.on)) {
      if (!m) continue;
      for (const e of m.efforts) out.add(`${BACKEND_OF_KEY[key] ?? key}:${m.id}#${e}`);
    }
  for (const [backend, l] of Object.entries(c.listed))
    for (const m of l.models) for (const e of m.efforts) out.add(`${backend}:${m.id}#${e}`);
  for (const canonical of Object.keys(c.treatLike))
    if (/^opencode(-go)?\//.test(canonical)) out.add(`opencode:${canonical}`);
  return [...out].sort();
}
```

Edit `src/domain/profile-rules.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/domain/profile-rules.ts b/src/domain/profile-rules.ts
index c429d0e..91a6b39 100644
--- a/src/domain/profile-rules.ts
+++ b/src/domain/profile-rules.ts
@@ -1,21 +1,23 @@
 import {
-  billingKeyOf,
   type Catalog,
   capableFor,
   effortOffered,
   ROLE_NEEDS,
   type RungInfo,
   rungInfo,
   scoresOf,
 } from "./catalog.ts";
-import { type Rung, tryParseRung } from "./ids.ts";
+import { quotaOf } from "./failover.ts";
+import { tryParseRung } from "./ids.ts";
 import { DIFFICULTIES, KINDS } from "./lane.ts";
 import { type Profile, type ProfileDoc, unknownValues } from "./profile.ts";
 import { DEFAULT_ACCESS, ROLES, type Role } from "./roles.ts";
 import { candidates, clearsBar, type RoutingProfile } from "./select.ts";
 
+export { quotaOf };
+
 /** One finding of `validate`: where in the profile, what is wrong, and the action that fixes it. */
 export interface Issue {
   path: string;
   message: string;
   fix?: string;
@@ -33,16 +35,10 @@ export const routingProfileOf = (p: Profile, role: Role): RoutingProfile => ({
   objective: p.objective,
   billing: p.billing,
   role: p.roles[role],
 });
 
-/**
- * Spec §7.1 and §4.5: a stand-in on the same quota would be out of quota too. The billing key names the
- * quota, except that the native `claude` path and headless `claude-code` both draw on the Claude plan.
- */
-export const quotaOf = (r: Rung): string => (billingKeyOf(r) === "claude" ? "claude-code" : billingKeyOf(r));
-
 /** Whether a rung's scores are catherd's guess: borrowed through a treat-like, or only `inferred` ones. */
 export function inferredScores(c: Catalog, info: RungInfo): { inferred: boolean; via: string | null } {
   const s = scoresOf(c, info.canonical);
   if (!s) return { inferred: false, via: null };
   const records = Object.values(s.records);
```

Edit `src/domain/profile.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/domain/profile.ts b/src/domain/profile.ts
index 19eb355..f850896 100644
--- a/src/domain/profile.ts
+++ b/src/domain/profile.ts
@@ -153,19 +153,19 @@ export const BUILTIN_ROLES: Record<Role, RoleConfig> = {
   writer: { enabled: true, access: DEFAULT_ACCESS.writer, rungs: [LUNA_HIGH] },
   researcher: { enabled: true, access: DEFAULT_ACCESS.researcher, rungs: [LUNA_HIGH] },
 };
 
 /**
- * Spec §7.2: each Codex rung fails over to the best-matching OpenCode Go model. Go serves GPT-6 Luna
- * itself; for Sol it has no GPT model, so Kimi K3 stands in through a shipped treat-like (scores.json),
- * which `profile show` marks inferred.
+ * Spec 1.1 §11: each shipped worker rung fails over to the best stand-in the shipped catalog offers
+ * (`rankStandIns` over `catalogRungs`, pinned by test/domain/failover.test.ts): on another quota, paid
+ * from a plan, and no downgrade on the dims the rung's bars use. Go serves GPT-6 Luna itself; Kimi K3
+ * borrows Sol medium's scores (a shipped treat-like). Sol high and xhigh have no such stand-in on the
+ * owner's plans, so they have none: a limit on them pauses the lane instead of dropping it a tier.
  */
 export const DEFAULT_FAILOVER: Record<string, string> = {
   [LUNA_HIGH]: "opencode:opencode-go/gpt-6-luna#high",
   [SOL("medium")]: "opencode:opencode-go/kimi-k3#max",
-  [SOL("high")]: "opencode:opencode-go/kimi-k3#max",
-  [SOL("xhigh")]: "opencode:opencode-go/kimi-k3#max",
 };
 
 /** The five billing keys spec §7.1 writes out; cursor and grok arrive with their backends. */
 const WRITTEN_BILLING: BillingKey[] = ["codex", "claude", "claude-code", "opencode-go", "opencode"];
```

- [ ] **Step 4: Run them and see them pass**

Run: `bun test test/domain test/entry/tui/profile-tree.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 5: Run the gate**

Run: `bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: all green (`bun run format` first if format:check complains; the suite takes about 3 minutes).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(profile): default failover only to stand-ins that clear the same bars"
```


### Task 2: validate: downgrade, Claude quota and descending-ladder warnings (spec 1.1 §11)

**Files:**
- Modify: `src/domain/failover.ts` (export `valuesOf`, add `ladderDropDims`), `src/domain/profile-rules.ts` (three warnings)
- Modify: `plugin/skills/catherd-setup/SKILL.md` (the warnings list)
- Test: `test/domain/profile-rules.test.ts`

**Interfaces:**
- Consumes: Task 1's `catalogRungs`, `claudeBilled`, `downgradeDims`, `rankStandIns`, `quotaOf`.
- Produces: `ladderDropDims(c: Catalog, lower: string, upper: string): Dim[]` and `valuesOf(c: Catalog, rung: string): Partial<Record<Dim, number>> | null` exported from failover.ts. New `validateProfile` warnings (never errors), exact wording:
  - `{ path: "failover.<from>", message: "downgrade: <to> stands in for <from>, scoring below it on <dims>", fix: "catherd profile set failover.<from> <best stand-in or null>" }`
  - `{ path: "failover.<from>", message: "stand-in <to> spends Claude quota, while <other> could stand in on another plan", fix: "catherd profile set failover.<from> <other>" }`
  - `{ path: "roles.<role>.rungs", message: "the ladder goes down at <rung>: it scores below <prev> on <dims>", fix: "order roles.<role>.rungs weakest first" }`

- [ ] **Step 1: Write the failing tests**

Edit `test/domain/profile-rules.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/domain/profile-rules.test.ts b/test/domain/profile-rules.test.ts
index 6342c7b..d22640d 100644
--- a/test/domain/profile-rules.test.ts
+++ b/test/domain/profile-rules.test.ts
@@ -120,10 +120,11 @@ describe("validateProfile", () => {
       },
     });
     expect(v.errors).toEqual([]);
     expect(messages(v.warnings)).toEqual([
       "codex:gpt-6-astra#high is on no enabled role's ladder, so this never runs",
+      "downgrade: claude:claude-opus-5-5#high stands in for codex:gpt-6-sol#high, scoring below it on repo_code, honesty",
       "stand-in claude:claude-opus-5-5#high is a native subagent: the orchestrator must start it, dispatch cannot",
     ]);
   });
 
   it("warns when the backend's last listing lacks a model, and when an unlisted model's effort cannot be checked", () => {
@@ -154,11 +155,11 @@ describe("validateProfile", () => {
       "claude:claude-opus-5-5#high",
       "claude-code:claude-opus-5-5#max",
     ];
     const v = check({ roles: { worker: { rungs: worker, defaultRung: null } } });
     expect(v.errors).toEqual([]);
-    expect(v.warnings.filter((w) => w.path.startsWith("roles."))).toEqual(
+    expect(v.warnings.filter((w) => w.message.includes("clears no routing bar"))).toEqual(
       ["claude-code:claude-opus-5-5#high", "claude:claude-opus-5-5#high"].map((rung) => ({
         path: "roles.worker.rungs",
         message: `${rung} clears no routing bar, so a lane starts on it only as the role's default rung and never climbs onto it`,
       })),
     );
@@ -167,10 +168,70 @@ describe("validateProfile", () => {
       warnings: [],
     });
   });
 });
 
+describe("validateProfile: failover and ladder warnings (spec 1.1 §11)", () => {
+  const XHIGH = "codex:gpt-6-sol#xhigh";
+  const LUNA = "codex:gpt-6-luna#high";
+  const KIMI = "opencode:opencode-go/kimi-k3#max";
+  const GO_LUNA = "opencode:opencode-go/gpt-6-luna#high";
+  const OPUS_MAX = "claude-code:claude-opus-5-5#max";
+
+  it("warns, never errs, on a stand-in that scores below its rung on a dim the rung's bars use", () => {
+    const v = check({ failover: { [XHIGH]: KIMI } });
+    expect(v.errors).toEqual([]);
+    expect(v.warnings).toEqual([
+      {
+        path: `failover.${XHIGH}`,
+        message: `downgrade: ${KIMI} stands in for ${XHIGH}, scoring below it on repo_code`,
+        fix: `catherd profile set failover.${XHIGH} null`,
+      },
+    ]);
+  });
+
+  it("names the best stand-in in a downgrade's fix when there is one", () => {
+    const v = check({ failover: { [LUNA]: KIMI } });
+    expect(v.warnings).toEqual([
+      {
+        path: `failover.${LUNA}`,
+        message: `downgrade: ${KIMI} stands in for ${LUNA}, scoring below it on repo_code`,
+        fix: `catherd profile set failover.${LUNA} ${GO_LUNA}`,
+      },
+    ]);
+  });
+
+  it("warns when a stand-in spends Claude quota while another backend could stand in", () => {
+    const v = check({ failover: { [LUNA]: OPUS_MAX } });
+    expect(v.errors).toEqual([]);
+    expect(v.warnings).toEqual([
+      {
+        path: `failover.${LUNA}`,
+        message: `stand-in ${OPUS_MAX} spends Claude quota, while ${GO_LUNA} could stand in on another plan`,
+        fix: `catherd profile set failover.${LUNA} ${GO_LUNA}`,
+      },
+    ]);
+    // with Go metered, nothing else is paid from a plan: the Claude stand-in is the only one
+    expect(check({ billing: { "opencode-go": "metered" }, failover: { [LUNA]: OPUS_MAX } }).warnings).toEqual(
+      [],
+    );
+  });
+
+  it("warns where a ladder goes down: a rung scoring below the one before it and above it nowhere", () => {
+    const worker = ["codex:gpt-6-sol#medium", XHIGH, LUNA];
+    const v = check({ roles: { worker: { rungs: worker, defaultRung: null } } });
+    expect(v.errors).toEqual([]);
+    expect(v.warnings).toContainEqual({
+      path: "roles.worker.rungs",
+      message: `the ladder goes down at ${LUNA}: it scores below ${XHIGH} on repo_code, honesty`,
+      fix: "order roles.worker.rungs weakest first",
+    });
+    // Luna high → Sol medium: lower on repo_code but higher on honesty, so not down (the default ladder)
+    expect(check().warnings).toEqual([]);
+  });
+});
+
 describe("inferredScores", () => {
   it("marks both of the default profile's Go stand-ins inferred, and Sol not", () => {
     const c = shipped();
     expect(inferredScores(c, rungInfo(c, "opencode:opencode-go/kimi-k3#max"))).toEqual({
       inferred: true,
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/domain/profile-rules.test.ts`
Expected: FAIL: the four new tests (no such warnings yet) and the updated "warns on a stand-in that never runs" test (its downgrade line is missing).

- [ ] **Step 3: Implement**

Edit `plugin/skills/catherd-setup/SKILL.md` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/plugin/skills/catherd-setup/SKILL.md b/plugin/skills/catherd-setup/SKILL.md
index 0f670b2..122c43b 100644
--- a/plugin/skills/catherd-setup/SKILL.md
+++ b/plugin/skills/catherd-setup/SKILL.md
@@ -64,11 +64,11 @@ Each proposal has three parts: the change, a worked example from their facts, an
 ## 4. Write it
 
 - Call `profile_set({ repo, patch })` with only what changed; pass `name` only to edit a profile other than the one this repo runs on (a name that does not exist yet starts a new profile from the default one). Lists (`rungs`, `notify`) replace, maps (`billing`, `failover`, `budget`) merge, and `null` removes a key. A key it does not know is refused with `E_INPUT_INVALID`. It validates before it writes:
   - `saved: false` comes with `errors`, each with a `path`, a `message` and often a `fix`. Explain each in their terms, fix the patch, and propose again.
   - `saved: true` comes with the `diff` (`path`, `before`, `after`) and any `warnings`. Read the diff back to the user, one line per change, and each warning with it.
-- Then call `profile_validate({ repo })`. `errors` block a save: the worker disabled, an enabled role with no usable rung, an unscored rung without a "treat like", a failover stand-in unscored or on the same quota, a backend catherd cannot run. `warnings` do not: an access mode other than the role's default, a model the backend's listing lacks, a stand-in that never runs.
+- Then call `profile_validate({ repo })`. `errors` block a save: the worker disabled, an enabled role with no usable rung, an unscored rung without a "treat like", a failover stand-in unscored or on the same quota, a backend catherd cannot run. `warnings` do not: an access mode other than the role's default, a model the backend's listing lacks, a stand-in that never runs, a stand-in that scores below its rung ("downgrade"), a Claude stand-in while another plan could stand in ("spends Claude quota"), a ladder whose rung scores below the one before it ("the ladder goes down"). Each has a `fix`; offer it.
 
 ## 5. Say what applies when
 
 - Codex, claude-code and opencode changes, access and isolation included, apply at the next dispatch, even in a run already under way.
 - An agent listed in `newSessionNeededFor` applies from the next Claude Code session: Claude Code reads agent files when a session starts. Other Claude changes apply now.
```

Edit `src/domain/failover.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/domain/failover.ts b/src/domain/failover.ts
index e126e2a..0c516e9 100644
--- a/src/domain/failover.ts
+++ b/src/domain/failover.ts
@@ -14,11 +14,11 @@ export function claudeBilled(rung: string): boolean {
   const r = tryParseRung(rung);
   return r !== null && quotaOf(r) === "claude-code";
 }
 
 /** A rung's scores by dim, its own or borrowed through a treat-like; null when unscored or not a rung. */
-function valuesOf(c: Catalog, rung: string): Partial<Record<Dim, number>> | null {
+export function valuesOf(c: Catalog, rung: string): Partial<Record<Dim, number>> | null {
   try {
     return scoresOf(c, rungInfo(c, rung).canonical)?.values ?? null;
   } catch {
     return null;
   }
@@ -48,10 +48,23 @@ export function downgradeDims(c: Catalog, rung: string, standIn: string): Dim[]
   if (!a) return [];
   const b = valuesOf(c, standIn) ?? {};
   return barDims(c, rung).filter((d) => (b[d] ?? Number.NEGATIVE_INFINITY) < (a[d] as number));
 }
 
+/**
+ * Spec 1.1 §11 "the ladder goes down": the dims both rungs are scored on where `upper` (the later rung)
+ * scores below `lower`, when it scores above it on none of them. Empty when it does not go down.
+ */
+export function ladderDropDims(c: Catalog, lower: string, upper: string): Dim[] {
+  const a = valuesOf(c, lower);
+  const b = valuesOf(c, upper);
+  if (!a || !b) return [];
+  const shared = DIMS.filter((d) => a[d] !== undefined && b[d] !== undefined);
+  if (shared.some((d) => (b[d] as number) > (a[d] as number))) return [];
+  return shared.filter((d) => (b[d] as number) < (a[d] as number));
+}
+
 const costFor = (c: Catalog, billing: Partial<Record<string, BillingMode>>, rung: string): Cost => {
   const info = rungInfo(c, rung);
   return costOf(info.family, info.parsed.effort, billing[info.key] ?? DEFAULT_BILLING[info.key]);
 };
```

Edit `src/domain/profile-rules.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/domain/profile-rules.ts b/src/domain/profile-rules.ts
index 91a6b39..fa86095 100644
--- a/src/domain/profile-rules.ts
+++ b/src/domain/profile-rules.ts
@@ -5,11 +5,18 @@ import {
   ROLE_NEEDS,
   type RungInfo,
   rungInfo,
   scoresOf,
 } from "./catalog.ts";
-import { quotaOf } from "./failover.ts";
+import {
+  catalogRungs,
+  claudeBilled,
+  downgradeDims,
+  ladderDropDims,
+  quotaOf,
+  rankStandIns,
+} from "./failover.ts";
 import { tryParseRung } from "./ids.ts";
 import { DIFFICULTIES, KINDS } from "./lane.ts";
 import { type Profile, type ProfileDoc, unknownValues } from "./profile.ts";
 import { DEFAULT_ACCESS, ROLES, type Role } from "./roles.ts";
 import { candidates, clearsBar, type RoutingProfile } from "./select.ts";
@@ -48,11 +55,12 @@ export function inferredScores(c: Catalog, info: RungInfo): { inferred: boolean;
 /**
  * Spec §7.1. Errors: the worker disabled; an enabled role with no usable rung; an unscored rung without a
  * treat-like; a failover stand-in unscored or on the same quota; a rung whose backend catherd cannot run
  * (`backends` lists those it can, `claude` included). Everything else worth knowing is a warning: an access
  * mode other than the role's default, an effort or model the last listing does not offer, a stand-in
- * that never runs. With the stored `doc` `p` came from, a value this catherd does not know is also a
+ * that never runs, and (spec 1.1 §11) a stand-in that downgrades its rung, one that spends Claude quota
+ * while another plan could stand in, and a ladder that goes down. With the stored `doc` `p` came from, a value this catherd does not know is also a
  * warning, one that says how the value is read.
  */
 export function validateProfile(
   p: Profile,
   c: Catalog,
@@ -125,10 +133,20 @@ export function validateProfile(
           message: `${r.backend}'s last listing does not offer ${r.model}; routing skips it`,
         });
       if (!scoresOf(c, info.canonical))
         errors.push({ path: `${at}.rungs`, message: `${rung} is unscored`, fix: TREAT_LIKE_FIX(rung) });
     }
+    rc.rungs.forEach((rung, i) => {
+      const prev = rc.rungs[i - 1];
+      const down = prev === undefined ? [] : ladderDropDims(c, prev, rung);
+      if (down.length)
+        warnings.push({
+          path: `${at}.rungs`,
+          message: `the ladder goes down at ${rung}: it scores below ${prev} on ${down.join(", ")}`,
+          fix: `order ${at}.rungs weakest first`,
+        });
+    });
     if (rc.defaultRung !== undefined && !rc.rungs.includes(rc.defaultRung))
       errors.push({
         path: `${at}.defaultRung`,
         message: `${rc.defaultRung} is not one of the ${role}'s rungs`,
         fix: `catherd profile set ${at}.defaultRung null, or add it to ${at}.rungs`,
@@ -163,10 +181,15 @@ export function validateProfile(
         });
     }
   }
 
   const ladders = new Set(ROLES.filter((r) => p.roles[r].enabled).flatMap((r) => p.roles[r].rungs));
+  // the stand-ins catherd could run here, for the fixes below
+  const pool = catalogRungs(c).filter((x) => {
+    const r = tryParseRung(x);
+    return r !== null && backends.includes(r.backend);
+  });
   for (const [from, to] of Object.entries(p.failover)) {
     const at = `failover.${from}`;
     const a = tryParseRung(from);
     const b = tryParseRung(to);
     if (!a || !b) {
@@ -187,10 +210,25 @@ export function validateProfile(
       errors.push({
         path: at,
         message: `stand-in ${to} draws on the same quota as ${from}, which is out when ${from} hits its limit`,
         fix: "name a stand-in on another backend or plan",
       });
+    const ranked = rankStandIns(c, p.billing, from, pool);
+    const down = downgradeDims(c, from, to);
+    if (down.length)
+      warnings.push({
+        path: at,
+        message: `downgrade: ${to} stands in for ${from}, scoring below it on ${down.join(", ")}`,
+        fix: `catherd profile set failover.${from} ${ranked[0] ?? "null"}`,
+      });
+    const other = ranked.find((x) => !claudeBilled(x));
+    if (claudeBilled(to) && other)
+      warnings.push({
+        path: at,
+        message: `stand-in ${to} spends Claude quota, while ${other} could stand in on another plan`,
+        fix: `catherd profile set failover.${from} ${other}`,
+      });
     if (b.backend === "claude")
       warnings.push({
         path: at,
         message: `stand-in ${to} is a native subagent: the orchestrator must start it, dispatch cannot`,
       });
```

- [ ] **Step 4: Run them and see them pass**

Run: `bun test test/domain`
Expected: PASS, 0 fail.

- [ ] **Step 5: Run the gate**

Run: `bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: all green (`bun run format` first if format:check complains; the suite takes about 3 minutes).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(profile): validate warns on a downgrade, a Claude stand-in, a ladder that goes down"
```


### Task 3: "scores borrowed from X" labels (spec 1.1 §11)

**Files:**
- Modify: `src/entry/profile-command.ts` (`formatProfile`'s failover lines), `src/entry/tui/profile-tree.ts` (the FAILOVER rows), `src/entry/tui/profile-edits.ts` (`failoverOptions` detail)
- Test: `test/entry/profile-command.test.ts`, `test/entry/tui/profile-tree.test.ts`

**Interfaces:**
- Consumes: `inferredScores(c, info): { inferred: boolean; via: string | null }` (unchanged; `via` is the treat-like target).
- Produces: the label ` (scores borrowed from <via>)` only when `via !== null`; no label when the stand-in has scores of its own, even `inferred` ones. `profile show --json`'s `standIns` keep `{ from, to, inferred, via }`.

- [ ] **Step 1: Write the failing tests**

Edit `test/entry/profile-command.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/entry/profile-command.test.ts b/test/entry/profile-command.test.ts
index 0eab687..1926b29 100644
--- a/test/entry/profile-command.test.ts
+++ b/test/entry/profile-command.test.ts
@@ -17,24 +17,26 @@ function catherd(args: string[], cwd?: string) {
   });
   return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
 }
 
 describe("catherd profile show", () => {
-  it("shows each role's access and enforcement, and marks the Go stand-ins inferred", () => {
+  it("shows each role's access and enforcement, and says whose scores a stand-in borrows", () => {
     withHome();
     const r = catherd(["show"]);
     expect(r.code).toBe(0);
     const lines = r.out.split("\n");
     expect(lines[0]).toBe("profile default (active)");
     expect(lines.find((l) => l.startsWith("  reviewer"))).toBe(
       "  reviewer     read-only, enforced          codex:gpt-6-sol#high",
     );
     expect(lines.find((l) => l.startsWith("  architect"))).toContain("read-only, advisory");
-    expect(r.out).toContain("  codex:gpt-6-luna#high → opencode:opencode-go/gpt-6-luna#high (inferred)\n");
+    // Go's Luna has scores of its own (inferred ones): no label; Kimi K3 has none, so it borrows Sol medium's
+    expect(r.out).toContain("  codex:gpt-6-luna#high → opencode:opencode-go/gpt-6-luna#high\n");
     expect(r.out).toContain(
-      "  codex:gpt-6-sol#medium → opencode:opencode-go/kimi-k3#max (inferred: treated like gpt-6-sol#medium)\n",
+      "  codex:gpt-6-sol#medium → opencode:opencode-go/kimi-k3#max (scores borrowed from gpt-6-sol#medium)\n",
     );
+    expect(r.out).not.toContain("treated like");
     expect(r.out).not.toContain("cursor");
   });
 
   it("prints JSON with every default filled in", () => {
     withHome();
```

Edit `test/entry/tui/profile-tree.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/entry/tui/profile-tree.test.ts b/test/entry/tui/profile-tree.test.ts
index 0201a4a..70af53a 100644
--- a/test/entry/tui/profile-tree.test.ts
+++ b/test/entry/tui/profile-tree.test.ts
@@ -125,15 +125,17 @@ describe("the Profiles tree (spec §9.1)", () => {
       dim: false,
       action: { type: "rung", scored: true },
     });
   });
 
-  it("marks both default stand-ins inferred, as plan 5 Ruling 2 says (spec §7.2)", () => {
+  it("says whose scores a stand-in borrows, only when it has none of its own (spec 1.1 §11)", () => {
     const rows = buildRows(input());
-    expect(row(rows, "failover:codex:gpt-6-sol#medium").value).toBe("→ kimi-k3#max (inferred)");
+    expect(row(rows, "failover:codex:gpt-6-sol#medium").value).toBe(
+      "→ kimi-k3#max (scores borrowed from gpt-6-sol#medium)",
+    );
     expect(row(rows, "failover:codex:gpt-6-sol#high").value).toBe("none");
-    expect(row(rows, "failover:codex:gpt-6-luna#high").value).toBe("→ gpt-6-luna#high (inferred)");
+    expect(row(rows, "failover:codex:gpt-6-luna#high").value).toBe("→ gpt-6-luna#high");
   });
 
   it("puts a validation issue on the row it is about", () => {
     const profile = resolveProfile(
       applyPatch(defaultProfileDoc(), { roles: { worker: { enabled: false } } }),
@@ -220,10 +222,15 @@ describe("edits", () => {
     const models = catalogQuery({ scoredOnly: false, limit: 1000 }, p.billing).models;
     const standIns = failoverOptions(p, models, c, "codex:gpt-6-sol#medium");
     expect(standIns[0]).toEqual({ value: "", title: "none", current: false });
     expect(standIns.some((o) => o.value.startsWith("codex:"))).toBe(false);
     expect(standIns.some((o) => o.value === "claude-code:claude-opus-5-5#xhigh")).toBe(true);
+    expect(standIns.find((o) => o.value === "claude-code:claude-opus-5-5#high")?.detail).toBe(
+      "scores borrowed from claude-opus-5-5#xhigh",
+    );
+    expect(standIns.find((o) => o.value === "claude-code:claude-opus-5-5#xhigh")?.detail).toBe("");
+    expect(standIns.find((o) => o.value === "opencode:opencode-go/gpt-6-luna#high")?.detail).toBe("");
     const likes = treatLikeOptions(c);
     expect(likes.map((o) => o.value)).toContain("gpt-6-sol#medium");
     expect(likes.map((o) => o.value)).not.toContain("claude-opus-5-5#high");
   });
 });
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/entry/profile-command.test.ts test/entry/tui/profile-tree.test.ts`
Expected: FAIL: `profile show` still prints `(inferred: treated like gpt-6-sol#medium)`; the tree still prints `(inferred)`; the picker detail is `inferred`.

- [ ] **Step 3: Implement**

Edit `src/entry/profile-command.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/entry/profile-command.ts b/src/entry/profile-command.ts
index 260a644..87bc465 100644
--- a/src/entry/profile-command.ts
+++ b/src/entry/profile-command.ts
@@ -38,11 +38,11 @@ export interface StandIn {
   to: string;
   inferred: boolean;
   via: string | null;
 }
 
-/** Spec §7.2: each stand-in, marked inferred when its scores are catherd's guess. */
+/** Spec §7.2: each stand-in; `via` names the rung whose scores it borrows (spec 1.1 §11). */
 export function standIns(p: Profile, c: Catalog): StandIn[] {
   return Object.entries(p.failover).map(([from, to]) => {
     try {
       return { from, to, ...inferredScores(c, rungInfo(c, to)) };
     } catch {
@@ -92,13 +92,11 @@ export function formatProfile(
   lines.push(`billing ${billing.map(([k, m]) => `${k} ${m}`).join(" · ")}`);
   const harness = Object.entries(p.harness).filter(runs);
   lines.push(`harness ${harness.map(([k, h]) => `${k} ${h.isolated ? "isolated" : "native"}`).join(" · ")}`);
   lines.push(o.standIns.length ? "failover" : "failover none");
   for (const s of o.standIns)
-    lines.push(
-      `  ${s.from} → ${s.to}${s.inferred ? ` (inferred${s.via ? `: treated like ${s.via}` : ""})` : ""}`,
-    );
+    lines.push(`  ${s.from} → ${s.to}${s.via ? ` (scores borrowed from ${s.via})` : ""}`);
   const budget = Object.entries(p.budget).map(([k, v]) => (k === "usd" ? `$${v}` : `${v} ${k}`));
   lines.push(`budget ${budget.join(" · ") || "no cap"}`);
   lines.push(`timeouts idle ${p.timeouts.idleMin} min · wall ${p.timeouts.wallMin} min`);
   lines.push(
     `preflight ${p.preflight.confirm ? "shows its commands and asks first" : "runs the checks without asking"}`,
```

Edit `src/entry/tui/profile-edits.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/entry/tui/profile-edits.ts b/src/entry/tui/profile-edits.ts
index 0b18f62..afb5ce0 100644
--- a/src/entry/tui/profile-edits.ts
+++ b/src/entry/tui/profile-edits.ts
@@ -111,16 +111,16 @@ export function failoverOptions(
   for (const m of models)
     for (const r of m.rungs) {
       if (!(r.enabled || usable(r.rung)) || r.rung.startsWith("claude:")) continue;
       const q = quotaOf(parseRung(r.rung));
       if (q === quota) continue;
-      const inferred = inferredScores(c, rungInfo(c, r.rung)).inferred;
+      const via = inferredScores(c, rungInfo(c, r.rung)).via;
       out.push({
         value: r.rung,
         title: shortRung(r.rung),
         group: m.billing,
-        detail: inferred ? "inferred" : "",
+        detail: via ? `scores borrowed from ${via}` : "",
         current: r.rung === cur,
       });
     }
   return out;
 }
```

Edit `src/entry/tui/profile-tree.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/entry/tui/profile-tree.ts b/src/entry/tui/profile-tree.ts
index 13259c1..4f0700a 100644
--- a/src/entry/tui/profile-tree.ts
+++ b/src/entry/tui/profile-tree.ts
@@ -348,11 +348,12 @@ export function buildRows(i: TreeInput): Row[] {
   for (const rung of fromRungs) {
     const to = i.profile.failover[rung];
     let mark = "";
     if (to) {
       try {
-        mark = inferredScores(i.catalog, rungInfo(i.catalog, to)).inferred ? " (inferred)" : "";
+        const via = inferredScores(i.catalog, rungInfo(i.catalog, to)).via;
+        mark = via ? ` (scores borrowed from ${via})` : "";
       } catch {
         mark = "";
       }
     }
     add({
```

- [ ] **Step 4: Run them and see them pass**

Run: `bun test test/entry/profile-command.test.ts test/entry/tui`
Expected: PASS, 0 fail.

- [ ] **Step 5: Run the gate**

Run: `bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: all green (`bun run format` first if format:check complains; the suite takes about 3 minutes).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(profile): say "scores borrowed from X" only for a stand-in with no scores of its own"
```


### Task 4: Plugin source over HTTPS and the stamped MCP launcher (spec 1.1 §12)

**Files:**
- Create: `plugin/bin/catherd-mcp` (POSIX sh, mode 755, `VERSION="<package version>"` line)
- Modify: `plugin/.mcp.json`, `.claude-plugin/marketplace.json`, `scripts/stamp-plugin-version.mjs`, `src/infra/env.ts` (`restoreTmpdir`), `src/entry/mcp/command.ts`, `test/pack-smoke.ts`
- Test: `test/plugin.test.ts` (rewritten: marketplace URL, launcher, stamp, launcher behaviour), `test/infra/env.test.ts`

**Interfaces:**
- Produces: `restoreTmpdir(env: Record<string, string | undefined>): void` in `src/infra/env.ts`; the launcher contract: `sh plugin/bin/catherd-mcp` execs `catherd mcp` when `catherd --version` prints the stamped `VERSION`, else `bunx catherd-cli@$VERSION mcp` with `TMPDIR=${XDG_CACHE_HOME:-$HOME/.cache}/catherd/bunx` (created) and `CATHERD_USER_TMPDIR` = the user's TMPDIR ("" when unset). `plugin/.mcp.json` = `{"mcpServers":{"catherd":{"command":"sh","args":["${CLAUDE_PLUGIN_ROOT}/bin/catherd-mcp"]}}}`. The stamp script stamps the launcher's `VERSION` line (no longer `.mcp.json`).

- [ ] **Step 1: Write the failing tests**

Edit `test/infra/env.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/infra/env.test.ts b/test/infra/env.test.ts
index fa5c8ea..f566a72 100644
--- a/test/infra/env.test.ts
+++ b/test/infra/env.test.ts
@@ -1,7 +1,7 @@
 import { describe, expect, it } from "bun:test";
-import { checkEnv, scrubSecrets, workerEnv } from "../../src/infra/env.ts";
+import { checkEnv, restoreTmpdir, scrubSecrets, workerEnv } from "../../src/infra/env.ts";
 
 describe("workerEnv", () => {
   it("drops catherd's own secrets, keeps the user's backend credentials, and sets PWD", () => {
     const env = workerEnv(
       {
@@ -35,10 +35,33 @@ describe("scrubSecrets", () => {
       OPENAI_API_KEY: "mine",
     });
   });
 });
 
+describe("restoreTmpdir (spec 1.1 §12)", () => {
+  it("gives the server the TMPDIR the user had before the launcher pointed it at bunx's cache", () => {
+    const env: Record<string, string | undefined> = {
+      TMPDIR: "/c/catherd/bunx",
+      CATHERD_USER_TMPDIR: "/mine",
+    };
+    restoreTmpdir(env);
+    expect(env).toEqual({ TMPDIR: "/mine" });
+  });
+
+  it("unsets TMPDIR when the user had none", () => {
+    const env: Record<string, string | undefined> = { TMPDIR: "/c/catherd/bunx", CATHERD_USER_TMPDIR: "" };
+    restoreTmpdir(env);
+    expect(env).toEqual({});
+  });
+
+  it("leaves TMPDIR alone when the launcher did not set it", () => {
+    const env: Record<string, string | undefined> = { TMPDIR: "/mine" };
+    restoreTmpdir(env);
+    expect(env).toEqual({ TMPDIR: "/mine" });
+  });
+});
+
 describe("checkEnv", () => {
   it("keeps only the allowlisted keys, and sets PWD", () => {
     expect(
       checkEnv(
         {
```

Edit `test/pack-smoke.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/pack-smoke.ts b/test/pack-smoke.ts
index cebefb1..43f8d8c 100644
--- a/test/pack-smoke.ts
+++ b/test/pack-smoke.ts
@@ -23,10 +23,11 @@ const SHIPPED = [
   "catalog/models.json",
   "catalog/scores.json",
   "catalog/jev.json",
   "plugin/.claude-plugin/plugin.json",
   "plugin/.mcp.json",
+  "plugin/bin/catherd-mcp",
 ];
 
 function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
   const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
   return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
@@ -59,11 +60,14 @@ const added = run([process.execPath, "add", tgz], app);
 must(added.code === 0, "bun add <tarball>", added.err);
 
 // 3. it runs in a fresh home, with no backend login and no Jev key needed
 const bin = join(app, "node_modules", ".bin", "catherd");
 const home = join(work, "home");
+// the installed bin on PATH, as after `bun add -g`: doctor's `mcp` row starts the server through the
+// plugin's launcher, which runs this catherd because it prints the launcher's version
 const env = {
+  PATH: `${join(app, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
   CATHERD_HOME: home,
   CLAUDE_CONFIG_DIR: join(home, "claude"),
   CATHERD_CLAUDE_AGENTS_DIR: join(home, "claude-agents"),
   TYPESAFE_API_KEY: "",
   ANTHROPIC_API_KEY: "",
```

Replace the whole of `test/plugin.test.ts`:

```ts
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const root = join(import.meta.dir, "..");
const readJson = (base: string, p: string) => JSON.parse(readFileSync(join(base, p), "utf8"));
const LAUNCHER = join(root, "plugin", "bin", "catherd-mcp");
const stampedIn = (text: string) => /^VERSION="([^"]+)"$/m.exec(text)?.[1];

describe("plugin", () => {
  it("the marketplace serves the plugin folder over HTTPS from the package version's release tag", () => {
    const m = readJson(root, ".claude-plugin/marketplace.json");
    const { version } = readJson(root, "package.json");
    expect(m.name).toBe("catherd");
    expect(m.owner.name).toBeTruthy();
    const entry = m.plugins.find((p: { name: string }) => p.name === "catherd");
    // a full HTTPS URL: the `owner/repo` shorthand clones over SSH, which fails without a GitHub SSH key
    expect(entry.source).toEqual({
      source: "git-subdir",
      url: "https://github.com/47vigen/catherd.git",
      path: "plugin",
      ref: `v${version}`,
    });
    expect(entry.version).toBeUndefined();
    expect(existsSync(join(root, entry.source.path, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("pins the package version in the manifest, and starts the MCP server through the stamped launcher", () => {
    const { version } = readJson(root, "package.json");
    expect(readJson(root, "plugin/.claude-plugin/plugin.json")).toMatchObject({ name: "catherd", version });
    expect(readJson(root, "plugin/.mcp.json")).toEqual({
      mcpServers: { catherd: { command: "sh", args: ["${CLAUDE_PLUGIN_ROOT}/bin/catherd-mcp"] } },
    });
    const launcher = readFileSync(LAUNCHER, "utf8");
    expect(launcher.startsWith("#!/bin/sh\n")).toBe(true);
    expect(stampedIn(launcher)).toBe(version);
    expect(statSync(LAUNCHER).mode & 0o111).not.toBe(0);
  });

  it("the stamp script writes a new version into every pinned file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "catherd-stamp-"));
    for (const p of ["package.json", "plugin", "scripts", ".claude-plugin"]) {
      cpSync(join(root, p), join(tmp, p), { recursive: true });
    }
    const pkg = readJson(tmp, "package.json");
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ ...pkg, version: "9.9.9" }));
    const proc = Bun.spawnSync(["bun", join(tmp, "scripts", "stamp-plugin-version.mjs")], {
      env: { PATH: process.env.PATH ?? "", HOME: tmp },
    });
    expect(proc.success).toBe(true);
    expect(readJson(tmp, "plugin/.claude-plugin/plugin.json").version).toBe("9.9.9");
    expect(stampedIn(readFileSync(join(tmp, "plugin", "bin", "catherd-mcp"), "utf8"))).toBe("9.9.9");
    expect(readJson(tmp, "plugin/.mcp.json")).toEqual(readJson(root, "plugin/.mcp.json"));
    expect(readJson(tmp, ".claude-plugin/marketplace.json").plugins[0].source.ref).toBe("v9.9.9");
    const skill = readFileSync(join(tmp, "plugin", "skills", "catherd", "SKILL.md"), "utf8");
    const pins = [...skill.matchAll(/catherd-cli@([^\s`)"]+)/g)].map((m) => m[1]);
    expect(pins.length).toBeGreaterThan(0);
    expect(new Set(pins)).toEqual(new Set(["9.9.9"]));
  });

  it("each command hands its arguments to its skill", () => {
    for (const [cmd, skill] of [
      ["catherd", "catherd"],
      ["catherd-setup", "catherd-setup"],
    ] as const) {
      const md = readFileSync(join(root, "plugin", "commands", `${cmd}.md`), "utf8");
      expect(md).toMatch(/^---\ndescription: .+\nargument-hint: .+\n---\n/);
      expect(md).toContain(`\`${skill}\` skill`);
      expect(md).toContain("$ARGUMENTS");
    }
  });
});

describe("the MCP launcher, plugin/bin/catherd-mcp (spec 1.1 §12)", () => {
  const version = stampedIn(readFileSync(LAUNCHER, "utf8")) as string;

  /** A folder of fake `catherd` and `bunx` that print what they were run with instead of starting anything. */
  function fakes(catherdVersion: string | null): { bin: string; home: string } {
    const dir = mkdtempSync(join(tmpdir(), "catherd-launcher-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    if (catherdVersion !== null)
      script(
        "catherd",
        `if [ "$1" = --version ]; then echo "${catherdVersion}"; exit 0; fi\necho "catherd $*"\necho "TMPDIR=\${TMPDIR-unset}"`,
      );
    script(
      "bunx",
      'echo "bunx $*"\necho "TMPDIR=$TMPDIR"\necho "USER_TMPDIR=${CATHERD_USER_TMPDIR-unset}"\n[ -d "$TMPDIR" ] && echo "dir exists"',
    );
    return { bin, home: join(dir, "home") };
  }

  const launch = (bin: string, env: Record<string, string>) => {
    const p = Bun.spawnSync(["sh", LAUNCHER], {
      env: { PATH: `${bin}:/usr/bin:/bin`, ANTHROPIC_API_KEY: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString().trim().split("\n") };
  };

  it("runs the global catherd when it is the stamped version, and leaves TMPDIR alone", () => {
    const { bin, home } = fakes(version);
    expect(launch(bin, { HOME: home, TMPDIR: "/tmp/mine" })).toEqual({
      code: 0,
      out: ["catherd mcp", "TMPDIR=/tmp/mine"],
    });
  });

  it("falls back to bunx at the stamped version, with TMPDIR in catherd's cache and the user's own kept", () => {
    const { bin, home } = fakes("0.0.1");
    const cache = join(home, "xdg-cache");
    expect(launch(bin, { HOME: home, TMPDIR: "/tmp/mine", XDG_CACHE_HOME: cache })).toEqual({
      code: 0,
      out: [
        `bunx catherd-cli@${version} mcp`,
        `TMPDIR=${cache}/catherd/bunx`,
        "USER_TMPDIR=/tmp/mine",
        "dir exists",
      ],
    });
  });

  it("uses ~/.cache without XDG_CACHE_HOME, and falls back when no catherd is on PATH", () => {
    const { bin, home } = fakes(null);
    expect(launch(bin, { HOME: home })).toEqual({
      code: 0,
      out: [
        `bunx catherd-cli@${version} mcp`,
        `TMPDIR=${home}/.cache/catherd/bunx`,
        "USER_TMPDIR=",
        "dir exists",
      ],
    });
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/plugin.test.ts test/infra/env.test.ts`
Expected: FAIL: the marketplace source still has `url: "47vigen/catherd"`, `plugin/bin/catherd-mcp` does not exist, `restoreTmpdir` is not exported.

- [ ] **Step 3: Implement**

Edit `.claude-plugin/marketplace.json` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/.claude-plugin/marketplace.json b/.claude-plugin/marketplace.json
index b231029..03257ff 100644
--- a/.claude-plugin/marketplace.json
+++ b/.claude-plugin/marketplace.json
@@ -3,11 +3,16 @@
   "owner": { "name": "47vigen", "url": "https://github.com/47vigen" },
   "description": "catherd: autopilot builds from your own Claude Code session.",
   "plugins": [
     {
       "name": "catherd",
-      "source": { "source": "git-subdir", "url": "47vigen/catherd", "path": "plugin", "ref": "v1.0.0" },
+      "source": {
+        "source": "git-subdir",
+        "url": "https://github.com/47vigen/catherd.git",
+        "path": "plugin",
+        "ref": "v1.0.0"
+      },
       "description": "Herds coding agents: Claude plans and verifies, Codex, opencode or headless Claude Code workers write the code, and Jev picks the model and effort for each piece.",
       "license": "MIT",
       "repository": "https://github.com/47vigen/catherd",
       "keywords": ["orchestration", "codex", "opencode", "subagents", "mcp"]
     }
```

Edit `plugin/.mcp.json` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/plugin/.mcp.json b/plugin/.mcp.json
index 61dd0b1..737dfa3 100644
--- a/plugin/.mcp.json
+++ b/plugin/.mcp.json
@@ -1,8 +1,8 @@
 {
   "mcpServers": {
     "catherd": {
-      "command": "bunx",
-      "args": ["catherd-cli@1.0.0", "mcp"]
+      "command": "sh",
+      "args": ["${CLAUDE_PLUGIN_ROOT}/bin/catherd-mcp"]
     }
   }
 }
```

Create `plugin/bin/catherd-mcp` (mode 755: `chmod +x`):

```sh
#!/bin/sh
# catherd's MCP launcher (spec 1.1 §12): the plugin's .mcp.json runs it. The release stamps VERSION
# (scripts/stamp-plugin-version.mjs), so the plugin always starts the server it was released with.
VERSION="1.0.0"

# a global catherd at this version (catherd init installs one): start it, no resolve at all
if command -v catherd >/dev/null 2>&1 && [ "$(catherd --version 2>/dev/null)" = "$VERSION" ]; then
  exec catherd mcp
fi

# else bunx, with its cache out of $TMPDIR: macOS cleans old files there and leaves bunx a broken package.
# The server gets the user's own TMPDIR back from CATHERD_USER_TMPDIR (empty when it was unset).
CATHERD_USER_TMPDIR="${TMPDIR:-}"
TMPDIR="${XDG_CACHE_HOME:-$HOME/.cache}/catherd/bunx"
mkdir -p "$TMPDIR"
export CATHERD_USER_TMPDIR TMPDIR
exec bunx "catherd-cli@$VERSION" mcp
```

Edit `scripts/stamp-plugin-version.mjs` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/scripts/stamp-plugin-version.mjs b/scripts/stamp-plugin-version.mjs
index 72d4cf8..97e9cc6 100644
--- a/scripts/stamp-plugin-version.mjs
+++ b/scripts/stamp-plugin-version.mjs
@@ -5,13 +5,14 @@ const root = new URL("..", import.meta.url);
 const path = (p) => new URL(p, root);
 const read = (p) => readFileSync(path(p), "utf8");
 
 const { version } = JSON.parse(read("package.json"));
 
+// the MCP launcher starts this version (a global catherd at it, else bunx catherd-cli@<it>)
 writeFileSync(
-  path("plugin/.mcp.json"),
-  read("plugin/.mcp.json").replace(/catherd-cli@[^"]+/, `catherd-cli@${version}`),
+  path("plugin/bin/catherd-mcp"),
+  read("plugin/bin/catherd-mcp").replace(/^VERSION="[^"]*"$/m, `VERSION="${version}"`),
 );
 writeFileSync(
   path("plugin/skills/catherd/SKILL.md"),
   read("plugin/skills/catherd/SKILL.md").replace(/catherd-cli@\d[^\s`)"]*/g, `catherd-cli@${version}`),
 );
```

Edit `src/entry/mcp/command.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/entry/mcp/command.ts b/src/entry/mcp/command.ts
index 31b6aba..4834cbf 100644
--- a/src/entry/mcp/command.ts
+++ b/src/entry/mcp/command.ts
@@ -1,7 +1,11 @@
 import { defineCommand } from "citty";
+import { restoreTmpdir } from "../../infra/env.ts";
 import { startMcpServer } from "./server.ts";
 
 export const mcpCommand = defineCommand({
   meta: { name: "mcp", description: "Run the catherd MCP server over stdio" },
-  run: () => startMcpServer(),
+  run: () => {
+    restoreTmpdir(process.env);
+    return startMcpServer();
+  },
 });
```

Edit `src/infra/env.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/infra/env.ts b/src/infra/env.ts
index 5d23199..b2ccb2b 100644
--- a/src/infra/env.ts
+++ b/src/infra/env.ts
@@ -6,10 +6,23 @@ export function scrubSecrets(base: Record<string, string | undefined>): Record<s
   const env: Record<string, string> = {};
   for (const [k, v] of Object.entries(base)) if (v !== undefined && !SECRET_ENV.has(k)) env[k] = v;
   return env;
 }
 
+/**
+ * Spec 1.1 §12: the plugin's launcher runs `bunx` with TMPDIR in catherd's cache, so macOS never half-cleans
+ * the package, and passes the user's own TMPDIR in CATHERD_USER_TMPDIR (empty when unset). The server and
+ * every worker it starts get the user's TMPDIR back.
+ */
+export function restoreTmpdir(env: Record<string, string | undefined>): void {
+  const mine = env.CATHERD_USER_TMPDIR;
+  if (mine === undefined) return;
+  if (mine) env.TMPDIR = mine;
+  else delete env.TMPDIR;
+  delete env.CATHERD_USER_TMPDIR;
+}
+
 export function workerEnv(
   base: Record<string, string | undefined>,
   overrides: Record<string, string>,
   cwd: string,
 ): Record<string, string> {
```

- [ ] **Step 4: Run them and see them pass**

Run: `bun test test/plugin.test.ts test/infra/env.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 5: Run the npm pack smoke (needs the npm registry)**

Run: `bun test/pack-smoke.ts`
Expected: every line `ok`, including `the tarball has plugin/bin/catherd-mcp`. Check `git ls-files -s plugin/bin/catherd-mcp` shows mode `100755` after `git add`.

- [ ] **Step 6: Run the gate**

Run: `bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: all green (`bun run format` first if format:check complains; the suite takes about 3 minutes).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(plugin): https plugin source and a stamped sh launcher with bunx out of TMPDIR"
```


### Task 5: doctor's `mcp` row through the launcher, with the reinstall command (spec 1.1 §12)

**Files:**
- Create: `test/bin/catherd` (mode 755: the test shim the launcher takes for a global install), `test/entry/mcp-handshake.test.ts`
- Modify: `src/entry/mcp/handshake.ts` (rewritten: launcher, stderr tail, 60 s), `src/services/doctor-checks.ts` (`mcpCheck`, `reinstallCommand`), `src/services/doctor.ts` (`Handshake.stderr`, the `mcp` row, the `bunx` row)
- Test: `test/services/doctor.test.ts`; PATH lines in `test/entry/doctor-command.test.ts`, `test/entry/init-command.test.ts`, `test/entry/tui/pty.test.ts` gain `test/bin`

**Interfaces:**
- Consumes: Task 4's `plugin/bin/catherd-mcp`.
- Produces: `LAUNCHER: string` and `mcpHandshake(o?: { launcher?: string }): Promise<Handshake>` (handshake.ts); `Handshake` gains `stderr?: string`; `reinstallCommand(version: string): string` = `bun add -g catherd-cli@<version>` and `mcpCheck(h: Handshake, version: string): Check` (doctor-checks.ts). Row shapes: missing module → `{ state: "fail", word: "broken install", detail: "cannot load <module>; reinstall: <cmd>", fix: <cmd> }`; `bunx: not found` → `{ word: "missing", detail: "no catherd <v> on PATH and no bunx to fetch it; reinstall: <cmd>" }`.

- [ ] **Step 1: Write the failing tests**

Create `test/bin/catherd` (mode 755: `chmod +x`):

```sh
#!/bin/sh
# Tests put this folder on PATH so the plugin's MCP launcher (plugin/bin/catherd-mcp) finds "a global
# catherd" at its stamped version, this checkout, and never falls back to bunx and the network.
exec bun "$(dirname "$0")/../../src/cli.ts" "$@"
```

Edit `test/entry/doctor-command.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/entry/doctor-command.test.ts b/test/entry/doctor-command.test.ts
index 96c89e0..5b00de0 100644
--- a/test/entry/doctor-command.test.ts
+++ b/test/entry/doctor-command.test.ts
@@ -35,11 +35,12 @@ const allLogs = (): string =>
 function machine(): void {
   const home = withHome();
   process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
   delete process.env.TYPESAFE_API_KEY;
   delete process.env.ANTHROPIC_API_KEY;
-  process.env.PATH = `${join(import.meta.dir, "..", "sim")}:${dirname(process.execPath)}:/usr/bin:/bin`;
+  // test/bin: the MCP launcher's "global catherd" is this checkout, so doctor's handshake never runs bunx
+  process.env.PATH = `${join(import.meta.dir, "..", "sim")}:${join(import.meta.dir, "..", "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`;
   Object.assign(
     process.env,
     withScenario({ models: fx("codex/models.json"), sandbox: "allow" }).env,
     withClaudeScenario({}).env,
     withOpencodeScenario({ models: fx("opencode/models.json").data }).env,
```

Edit `test/entry/init-command.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/entry/init-command.test.ts b/test/entry/init-command.test.ts
index 1f217ce..d6b0a7f 100644
--- a/test/entry/init-command.test.ts
+++ b/test/entry/init-command.test.ts
@@ -15,11 +15,12 @@ afterEach(snapshotEnv());
 function init(args: string[], stdin = "") {
   const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), "init", ...args], {
     // no backend CLI, no Jev key and no Anthropic key: nothing reaches the network or the user's own CLIs
     env: {
       ...process.env,
-      PATH: `/nonexistent:${join(process.execPath, "..")}:/usr/bin:/bin`,
+      // test/bin: the MCP launcher's "global catherd" is this checkout, so doctor's handshake never runs bunx
+      PATH: `/nonexistent:${join(import.meta.dir, "..", "bin")}:${join(process.execPath, "..")}:/usr/bin:/bin`,
       TYPESAFE_API_KEY: "",
       ANTHROPIC_API_KEY: "",
     },
     stdin: new TextEncoder().encode(stdin),
     stdout: "pipe",
```

Create `test/entry/mcp-handshake.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCHER, mcpHandshake } from "../../src/entry/mcp/handshake.ts";
import { snapshotEnv } from "../helpers.ts";

afterEach(snapshotEnv());

const BIN = join(import.meta.dir, "..", "bin");

describe("doctor's MCP handshake (spec 1.1 §12)", () => {
  it("starts the server through the plugin's launcher", () => {
    expect(LAUNCHER).toBe(join(import.meta.dir, "..", "..", "plugin", "bin", "catherd-mcp"));
  });

  it("answers tools/list through the launcher, which runs the catherd on PATH at its version", async () => {
    // test/bin/catherd is this checkout: the launcher takes it for the global install
    process.env.PATH = `${BIN}:${join(process.execPath, "..")}:/usr/bin:/bin`;
    process.env.ANTHROPIC_API_KEY = "";
    const h = await mcpHandshake();
    expect(h.ok).toBe(true);
    expect(h.tools).toContain("status");
  }, 60_000);

  it("keeps what the server printed on stderr when it does not start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catherd-handshake-"));
    const broken = join(dir, "catherd-mcp");
    writeFileSync(
      broken,
      "#!/bin/sh\necho \"error: Cannot find module 'zod' from '/x/src/cli.ts'\" >&2\nexit 1\n",
    );
    chmodSync(broken, 0o755);
    const h = await mcpHandshake({ launcher: broken });
    expect(h.ok).toBe(false);
    expect(h.stderr).toContain("Cannot find module 'zod'");
  }, 60_000);
});
```

Edit `test/entry/tui/pty.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/entry/tui/pty.test.ts b/test/entry/tui/pty.test.ts
index 5c39ce4..c6b30a8 100644
--- a/test/entry/tui/pty.test.ts
+++ b/test/entry/tui/pty.test.ts
@@ -57,11 +57,12 @@ async function start(args: string) {
     `HOME=${home}`,
     `CATHERD_HOME=${home}`,
     `CATHERD_CLAUDE_AGENTS_DIR=${join(home, "agents")}`,
     `CLAUDE_CONFIG_DIR=${join(home, "claude")}`,
     // no backend CLI on PATH: doctor answers fast, and nothing real is touched
-    `PATH=${dirname(process.execPath)}:/usr/bin:/bin`,
+    // test/bin: the MCP launcher's "global catherd" is this checkout, so the handshake never runs bunx
+    `PATH=${join(import.meta.dir, "..", "..", "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
     "TERM=xterm-256color",
     "LANG=C.UTF-8",
     "LC_ALL=C.UTF-8",
     // no key: doctor's discovery never reaches the Models API
     "ANTHROPIC_API_KEY=",
```

Edit `test/services/doctor.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/services/doctor.test.ts b/test/services/doctor.test.ts
index 169e8fe..c70c811 100644
--- a/test/services/doctor.test.ts
+++ b/test/services/doctor.test.ts
@@ -287,10 +287,49 @@ describe("doctor", () => {
       handshake: async () => ({ ok: false, tools: [], error: "no answer within 20 s" }),
     });
     expect([r.ready, check(r, "mcp")?.detail]).toEqual([false, "no answer within 20 s"]);
   });
 
+  it("says to reinstall when the server cannot load a module (spec 1.1 §12)", async () => {
+    ready();
+    const r = await run({
+      handshake: async () => ({
+        ok: false,
+        tools: [],
+        error: "MCP error -32000: Connection closed",
+        stderr:
+          "error: Cannot find module '@modelcontextprotocol/sdk/server/mcp.js' from '/c/bunx/src/x.ts'\n",
+      }),
+    });
+    expect(check(r, "mcp")).toEqual({
+      id: "mcp",
+      label: "MCP server",
+      state: "fail",
+      word: "broken install",
+      detail: `cannot load @modelcontextprotocol/sdk/server/mcp.js; reinstall: bun add -g catherd-cli@${VERSION}`,
+      fix: `bun add -g catherd-cli@${VERSION}`,
+    });
+  });
+
+  it("says to install catherd when the launcher finds neither it nor bunx", async () => {
+    ready();
+    const r = await run({
+      handshake: async () => ({
+        ok: false,
+        tools: [],
+        error: "MCP error -32000: Connection closed",
+        stderr: "/p/bin/catherd-mcp: 17: exec: bunx: not found\n",
+      }),
+    });
+    expect(check(r, "mcp")).toMatchObject({
+      state: "fail",
+      word: "missing",
+      detail: `no catherd ${VERSION} on PATH and no bunx to fetch it; reinstall: bun add -g catherd-cli@${VERSION}`,
+      fix: `bun add -g catherd-cli@${VERSION}`,
+    });
+  });
+
   it("warns, with the fix, when a Codex workspace-write sandbox cannot write the lock dir; skips when it cannot test", async () => {
     machine({ codex: { sandbox: "deny" } });
     installPlugin(VERSION);
     patchProfile("default", {});
     const denied = check(await run(), "sandbox:codex");
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/doctor.test.ts test/entry/mcp-handshake.test.ts`
Expected: FAIL: the two new doctor tests (the row is still `no answer`), and `LAUNCHER` is not exported.

- [ ] **Step 3: Implement**

Replace the whole of `src/entry/mcp/handshake.ts`:

```ts
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { errorMessage } from "../../domain/errors.ts";
import { scrubSecrets } from "../../infra/env.ts";
import { VERSION } from "../../infra/version.ts";
import type { Handshake } from "../../services/doctor.ts";

/** The plugin's MCP launcher, shipped in the package beside src/ (spec 1.1 §12). */
export const LAUNCHER = fileURLToPath(new URL("../../../plugin/bin/catherd-mcp", import.meta.url));
/** A cold `bunx catherd-cli@<version>` resolve took about 30 s in the 1.0.0 fresh install. */
const TIMEOUT_MS = 60_000;
const STDERR_TAIL = 4_000;

/** The env the doctor's MCP server starts with: catherd's own secrets scrubbed, as for every process it starts. */
export const handshakeEnv = (
  base: Record<string, string | undefined> = process.env,
): Record<string, string> => scrubSecrets(base);

/**
 * Spec §10.3 and 1.1 §12: starts the MCP server the way the plugin does, `sh <launcher>` over stdio, and
 * asks it for tools/list. What it writes to stderr comes back too, so doctor can say what broke.
 */
export async function mcpHandshake(o: { launcher?: string } = {}): Promise<Handshake> {
  const client = new Client({ name: "catherd-doctor", version: VERSION });
  const transport = new StdioClientTransport({
    command: "sh",
    args: [o.launcher ?? LAUNCHER],
    env: handshakeEnv(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-STDERR_TAIL);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Handshake>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, tools: [], error: `no answer within ${TIMEOUT_MS / 1000} s`, stderr }),
      TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([
      (async (): Promise<Handshake> => {
        await client.connect(transport);
        const r = await client.listTools();
        return { ok: true, tools: r.tools.map((t) => t.name) };
      })(),
      late,
    ]);
  } catch (e) {
    return { ok: false, tools: [], error: errorMessage(e), stderr };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {}); // the answer (or the failure) is already in hand
  }
}
```

Edit `src/services/doctor-checks.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/services/doctor-checks.ts b/src/services/doctor-checks.ts
index 5410ba9..704ce50 100644
--- a/src/services/doctor-checks.ts
+++ b/src/services/doctor-checks.ts
@@ -2,10 +2,11 @@ import { readFileSync, rmSync, writeFileSync } from "node:fs";
 import { join } from "node:path";
 import { errorMessage, isCatherdError } from "../domain/errors.ts";
 import { claudeHome, locksDir } from "../infra/paths.ts";
 import { ensurePrivateDir, PRIVATE_FILE } from "../infra/store.ts";
 import { agentLinkState } from "./agent-links.ts";
+import type { Handshake } from "./doctor.ts";
 import { activeName } from "./profile-store.ts";
 
 // The rows of `catherd doctor` and the checks that stand alone; doctor.ts assembles the report.
 
 type CheckState = "ok" | "warn" | "fail" | "skip";
@@ -64,10 +65,53 @@ export function pluginCheck(version: string): Check {
       fix: PLUGIN_UPDATE,
     };
   return { ...base, state: "ok", word: "ready", detail: installed };
 }
 
+/** What makes the plugin's launcher run this catherd without a resolve: a global install at this version. */
+export const reinstallCommand = (version: string): string => `bun add -g catherd-cli@${version}`;
+
+const MISSING_MODULE = /Cannot find (?:module|package) ['"]?([^'"\s]+)/;
+const NO_BUNX = /bunx: (?:command )?not found/;
+
+/**
+ * Spec 1.1 §12: the `mcp` row. The handshake starts the server the way the plugin does; a module it cannot
+ * load (a half-cleaned bunx cache, a broken global install) and a launcher that finds neither catherd nor
+ * bunx both say "reinstall: <command>".
+ */
+export function mcpCheck(h: Handshake, version: string): Check {
+  const base = { id: "mcp", label: "MCP server" };
+  if (h.ok && h.tools.includes("status"))
+    return { ...base, state: "ok", word: "ready", detail: `answers tools/list with ${h.tools.length} tools` };
+  const said = `${h.error ?? ""}\n${h.stderr ?? ""}`;
+  const reinstall = reinstallCommand(version);
+  const missing = MISSING_MODULE.exec(said)?.[1];
+  if (missing)
+    return {
+      ...base,
+      state: "fail",
+      word: "broken install",
+      detail: `cannot load ${missing}; reinstall: ${reinstall}`,
+      fix: reinstall,
+    };
+  if (NO_BUNX.test(said))
+    return {
+      ...base,
+      state: "fail",
+      word: "missing",
+      detail: `no catherd ${version} on PATH and no bunx to fetch it; reinstall: ${reinstall}`,
+      fix: reinstall,
+    };
+  return {
+    ...base,
+    state: "fail",
+    word: "no answer",
+    detail: h.error ?? "tools/list has no status tool",
+    fix: "run catherd mcp to see why it does not start",
+  };
+}
+
 export function locksCheck(): Check {
   const base = { id: "locks", label: "heavy-lock dir" };
   try {
     ensurePrivateDir(locksDir());
     const probe = join(locksDir(), `.doctor-${process.pid}`);
```

Edit `src/services/doctor.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/services/doctor.ts b/src/services/doctor.ts
index 7394138..18f4656 100644
--- a/src/services/doctor.ts
+++ b/src/services/doctor.ts
@@ -13,10 +13,11 @@ import {
   type Check,
   errText,
   fixOf,
   guarded,
   locksCheck,
+  mcpCheck,
   pluginCheck,
 } from "./doctor-checks.ts";
 import { credentialsPath, jevKey, savedJevKey, testJevKey } from "./jev-service.ts";
 import {
   activeName,
@@ -38,17 +39,19 @@ export interface DoctorReport {
 
 export interface Handshake {
   ok: boolean;
   tools: string[];
   error?: string;
+  /** the tail of what the server (or its launcher) wrote to stderr */
+  stderr?: string;
 }
 
 export interface DoctorDeps {
   bunVersion: string;
   /** the package version, which the Claude Code plugin must pin */
   version: string;
-  /** starts `catherd mcp` over stdio and asks it for tools/list */
+  /** starts the MCP server as the plugin does (its launcher) over stdio and asks it for tools/list */
   handshake: () => Promise<Handshake>;
   jev?: JevTransport;
 }
 
 /**
@@ -198,28 +201,11 @@ export async function doctor(d: DoctorDeps): Promise<DoctorReport> {
   );
 
   const h = await d
     .handshake()
     .catch((e: unknown): Handshake => ({ ok: false, tools: [], error: errText(e) }));
-  checks.push(
-    h.ok && h.tools.includes("status")
-      ? {
-          id: "mcp",
-          label: "MCP server",
-          state: "ok",
-          word: "ready",
-          detail: `answers tools/list with ${h.tools.length} tools`,
-        }
-      : {
-          id: "mcp",
-          label: "MCP server",
-          state: "fail",
-          word: "no answer",
-          detail: h.error ?? "tools/list has no status tool",
-          fix: "run catherd mcp to see why it does not start",
-        },
-  );
+  checks.push(mcpCheck(h, d.version));
 
   checks.push(locksCheck());
   for (const id of workspaceWriteBackends(profiles)) {
     const a = adapterFor(id);
     if (!a?.canWrite) continue;
@@ -320,17 +306,19 @@ export async function doctor(d: DoctorDeps): Promise<DoctorReport> {
             }
           : { id: "credentials", label: "credentials.json", state: "ok", word: "ready", detail: "mode 600" },
     );
   }
 
-  if (!Bun.which("bunx", { PATH: process.env.PATH ?? "" }))
+  // the plugin's launcher needs bunx only when no global catherd is installed
+  const onPath = (bin: string) => Bun.which(bin, { PATH: process.env.PATH ?? "" });
+  if (!onPath("bunx") && !onPath("catherd"))
     checks.push({
       id: "bunx",
       label: "bunx",
       state: "warn",
       word: "missing",
-      detail: "the plugin starts the MCP server with bunx",
+      detail: "the plugin's MCP launcher runs bunx when no global catherd is installed",
       fix: "put Bun's bin folder (~/.bun/bin) on PATH",
     });
   let corrupt: ReturnType<typeof listRuns>["corrupt"] = [];
   try {
     corrupt = listRuns().corrupt;
```

- [ ] **Step 4: Run them and see them pass**

Run: `bun test test/services/doctor.test.ts test/entry/mcp-handshake.test.ts test/entry/doctor-command.test.ts test/entry/init-command.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 5: Run the npm pack smoke again**

Run: `bun test/pack-smoke.ts`
Expected: `ok  the installed MCP server answers initialize and tools/list` (doctor now goes through the installed package's launcher, which finds the installed `catherd` on the smoke's PATH).

- [ ] **Step 6: Run the gate**

Run: `bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: all green (`bun run format` first if format:check complains; the suite takes about 3 minutes).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(doctor): start the mcp server through the plugin launcher and say how to reinstall"
```


### Task 6: `init` installs the global CLI, saying "installing catherd…" first (spec 1.1 §12)

**Files:**
- Create: `src/services/global-install.ts`, `test/services/global-install.test.ts`
- Modify: `src/entry/init-command.ts` (`globalStep`, the `--no-global` flag, the description), `README.md` (the `init` row)
- Test: `test/entry/init-command.test.ts`, `test/entry/help-text.test.ts`

**Interfaces:**
- Consumes: Task 5's `reinstallCommand(version)`.
- Produces: `GlobalInstallDeps { installedVersion(): Promise<string | null>; install(version: string): Promise<{ ok: boolean; output: string }> }`, `realGlobalInstall: GlobalInstallDeps`, `ensureGlobal(version, deps, installing: () => void): Promise<{ state: "current" } | { state: "installed" } | { state: "failed"; reason: string }>` (global-install.ts); `globalStep(version: string, o: { skip: boolean; deps?: GlobalInstallDeps; plain?: boolean }): Promise<void>` (init-command.ts). Lines: `installing catherd… (bun add -g catherd-cli@<v>)`, `✓ catherd <v> installed globally; the plugin starts it without bunx`, `✓ catherd <v> is installed globally`, `! could not install catherd globally: <first output line>` + `    fix: <cmd>`, `- catherd: not installed globally (--no-global); the plugin starts it with bunx`.

- [ ] **Step 1: Write the failing tests**

Edit `test/entry/help-text.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/entry/help-text.test.ts b/test/entry/help-text.test.ts
index 021a3fa..a3f7b5f 100644
--- a/test/entry/help-text.test.ts
+++ b/test/entry/help-text.test.ts
@@ -54,10 +54,12 @@ describe("--help matches the CLI (audit S5, S6, N3)", () => {
 
   it("documents init's --no-input, not an --input that defaults to true", () => {
     const text = help("init");
     expect(text).toContain("--no-input ask nothing: keep what exists, else write the defaults");
     expect(text).not.toMatch(/(^|[^-])--input/);
+    expect(text).toContain("--no-global do not install the global catherd command");
+    expect(text).not.toMatch(/(^|[^-])--global/);
     expect(text).not.toContain("Default: true");
   });
 
   it("prints no colour codes when piped, even without NO_COLOR", () => {
     for (const args of [[], ["runs", "list"], ["lock"]]) expect(rawHelp(args, {})).not.toContain("\x1b[");
```

Edit `test/entry/init-command.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/entry/init-command.test.ts b/test/entry/init-command.test.ts
index d6b0a7f..af4cf57 100644
--- a/test/entry/init-command.test.ts
+++ b/test/entry/init-command.test.ts
@@ -1,11 +1,12 @@
 import { afterEach, describe, expect, it, spyOn } from "bun:test";
 import { existsSync, mkdirSync, writeFileSync } from "node:fs";
 import { writeDiscovery } from "../../src/adapters/discovery.ts";
 import { dirname, join } from "node:path";
-import { jevStep, PLUGIN_STEPS, welcomeLines } from "../../src/entry/init-command.ts";
+import { globalStep, jevStep, PLUGIN_STEPS, welcomeLines } from "../../src/entry/init-command.ts";
 import type { Prompter } from "../../src/entry/prompt.ts";
+import { VERSION } from "../../src/infra/version.ts";
 import { credentialsPath, saveJevKey } from "../../src/services/jev-service.ts";
 import { patchProfile } from "../../src/services/profile-service.ts";
 import { activeName, getProfile } from "../../src/services/profile-store.ts";
 import { noPosixModes, openModes, snapshotEnv, withHome } from "../helpers.ts";
 import { SRC } from "../import-graph.ts";
@@ -27,17 +28,72 @@ function init(args: string[], stdin = "") {
     stderr: "pipe",
   });
   return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
 }
 
+describe("globalStep (spec 1.1 §12)", () => {
+  const lines = async (f: () => Promise<void>) => {
+    const out: string[] = [];
+    const log = console.log;
+    console.log = (l: string) => out.push(l);
+    try {
+      await f();
+    } finally {
+      console.log = log;
+    }
+    return out;
+  };
+  const deps = (onPath: string | null, ok = true) => ({
+    installedVersion: async () => onPath,
+    install: async () => ({ ok, output: ok ? "" : "error: 503 from the registry\n" }),
+  });
+
+  it("says installing catherd… first, then that it is installed", async () => {
+    expect(await lines(() => globalStep("1.1.0", { skip: false, deps: deps("1.0.0") }))).toEqual([
+      "installing catherd… (bun add -g catherd-cli@1.1.0)",
+      "✓ catherd 1.1.0 installed globally; the plugin starts it without bunx",
+    ]);
+  });
+
+  it("says nothing about installing when this version is already global", async () => {
+    expect(await lines(() => globalStep("1.1.0", { skip: false, deps: deps("1.1.0") }))).toEqual([
+      "✓ catherd 1.1.0 is installed globally",
+    ]);
+  });
+
+  it("goes on after a failed install, with the command to retry", async () => {
+    expect(
+      await lines(() => globalStep("1.1.0", { skip: false, deps: deps(null, false), plain: true })),
+    ).toEqual([
+      "installing catherd… (bun add -g catherd-cli@1.1.0)",
+      "! could not install catherd globally: error: 503 from the registry",
+      "    fix: bun add -g catherd-cli@1.1.0",
+    ]);
+  });
+
+  it("skips the install with --no-global", async () => {
+    let asked = false;
+    const d = { ...deps(null), installedVersion: async () => ((asked = true), null) };
+    expect(await lines(() => globalStep("1.1.0", { skip: true, deps: d }))).toEqual([
+      "- catherd: not installed globally (--no-global); the plugin starts it with bunx",
+    ]);
+    expect(asked).toBe(false);
+  });
+});
+
 describe("catherd init", () => {
   it("--no-input writes and activates the default profile, reports readiness, and ends with the plugin steps", () => {
     const home = withHome();
     process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
     const r = init(["--no-input"]);
     expect(r.code).toBe(0);
     expect(r.out).not.toContain("(=^.^=)");
+    // test/bin/catherd prints this version: the global install is already there
+    expect(r.out).toContain(`✓ catherd ${VERSION} is installed globally\n`);
+    expect(init(["--no-input", "--no-global"]).out).toContain(
+      "- catherd: not installed globally (--no-global); the plugin starts it with bunx\n",
+    );
     expect(r.out).toContain("✓ profile default written from the defaults, and active\n");
     expect(r.out).toMatch(/✓ ready {14}MCP server — answers tools\/list with \d+ tools\n/);
     expect(r.out).toContain("✗ missing            Claude Code plugin — not installed in Claude Code\n");
     expect(r.out.trimEnd().split("\n").slice(-4)).toEqual(PLUGIN_STEPS);
     expect(activeName()).toBe("default");
```

Create `test/services/global-install.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { ensureGlobal, type GlobalInstallDeps } from "../../src/services/global-install.ts";

function deps(onPath: string | null, installs: { ok: boolean; output: string } = { ok: true, output: "" }) {
  const calls: string[] = [];
  const d: GlobalInstallDeps = {
    installedVersion: async () => {
      calls.push("version");
      return onPath;
    },
    install: async (v) => {
      calls.push(`install ${v}`);
      return installs;
    },
  };
  return { d, calls };
}

describe("ensureGlobal (spec 1.1 §12)", () => {
  it("does nothing when the catherd on PATH is this version", async () => {
    const { d, calls } = deps("1.1.0");
    const said: string[] = [];
    expect(await ensureGlobal("1.1.0", d, () => said.push("installing"))).toEqual({ state: "current" });
    expect(calls).toEqual(["version"]);
    expect(said).toEqual([]);
  });

  it("says it is installing before it resolves anything, then installs this version", async () => {
    const { d, calls } = deps("1.0.0");
    const order: string[] = [];
    d.install = async (v) => {
      order.push(`install ${v}`);
      return { ok: true, output: "" };
    };
    expect(await ensureGlobal("1.1.0", d, () => order.push("installing"))).toEqual({ state: "installed" });
    expect(order).toEqual(["installing", "install 1.1.0"]);
    expect(calls).toEqual(["version"]);
  });

  it("installs when no catherd is on PATH, and reports a failed install with its output", async () => {
    const { d } = deps(null, {
      ok: false,
      output: "error: GET https://registry.npmjs.org/catherd-cli - 503\n",
    });
    expect(await ensureGlobal("1.1.0", d, () => {})).toEqual({
      state: "failed",
      reason: "error: GET https://registry.npmjs.org/catherd-cli - 503",
    });
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/global-install.test.ts test/entry/init-command.test.ts test/entry/help-text.test.ts`
Expected: FAIL: `Cannot find module "../../src/services/global-install.ts"`; `globalStep` is not exported.

- [ ] **Step 3: Implement**

Edit `README.md` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/README.md b/README.md
index 3953389..968d68d 100644
--- a/README.md
+++ b/README.md
@@ -65,11 +65,11 @@ In Claude Code:
 In a terminal:
 
 | Command                                                                                   | What it does                                                                             |
 | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
 | `catherd`                                                                                 | The dashboard: Status, Profiles and Runs (below)                                         |
-| `catherd init [--no-input] [--profile <p>]`                                               | First-run setup                                                                          |
+| `catherd init [--no-input] [--no-global] [--profile <p>]`                                 | First-run setup; installs the global `catherd` at its own version unless `--no-global`   |
 | `catherd doctor [--json]`                                                                 | Readiness report, one row per check with its fix; exits 3 when not ready                 |
 | `catherd profile list\|show\|use [--repo]\|new [--from <p>]\|copy\|rm\|diff\|validate`    | Profiles; `use --repo` binds one to the repo you are in                                  |
 | `catherd profile use --repo --clear`                                                      | Unbinds the repo you are in; it runs on the active profile again                         |
 | `catherd profile set <path> <value> [--profile <p>]`                                      | One field, e.g. `roles.verifier.access read-only`, `budget.usd 20`                       |
 | `catherd status [run]`, `catherd watch [--once] [--interval <s>]`                         | Where runs stand                                                                         |
```

Edit `src/entry/init-command.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/entry/init-command.ts b/src/entry/init-command.ts
index 3bd5d0d..f712a67 100644
--- a/src/entry/init-command.ts
+++ b/src/entry/init-command.ts
@@ -3,10 +3,12 @@ import { assertProfileName } from "../domain/profile.ts";
 import { errorMessage, isCatherdError } from "../domain/errors.ts";
 import { configDir } from "../infra/paths.ts";
 import { VERSION } from "../infra/version.ts";
 import { doctor } from "../services/doctor.ts";
 import { jevKey, saveJevKey, testJevKey } from "../services/jev-service.ts";
+import { reinstallCommand } from "../services/doctor-checks.ts";
+import { ensureGlobal, type GlobalInstallDeps, realGlobalInstall } from "../services/global-install.ts";
 import { hasProfileFile, type InitResult, initSetup, moveLegacy } from "../services/setup.ts";
 import { formatRefreshed } from "./catalog-command.ts";
 import { mark as markOf } from "./cli-kit.ts";
 import { formatReport } from "./doctor-command.ts";
 import { mcpHandshake } from "./mcp/handshake.ts";
@@ -61,10 +63,33 @@ export async function jevStep(
     console.log(`${mark("warn")} Jev: could not save the key: ${message}`);
     if (isCatherdError(e) && e.fix) console.log(`    fix: ${e.fix}`);
   }
 }
 
+/**
+ * Spec 1.1 §12: installs the global CLI at this version (the plugin's launcher then needs no bunx), and
+ * says "installing catherd…" before the resolve. It never stops `init`: a failure is a `!` line and its fix.
+ */
+export async function globalStep(
+  version: string,
+  o: { skip: boolean; deps?: GlobalInstallDeps; plain?: boolean },
+): Promise<void> {
+  const mark = (state: State) => markOf(state, o.plain === true);
+  if (o.skip)
+    return console.log(`- catherd: not installed globally (--no-global); the plugin starts it with bunx`);
+  const r = await ensureGlobal(version, o.deps ?? realGlobalInstall, () =>
+    console.log(`installing catherd… (${reinstallCommand(version)})`),
+  );
+  if (r.state === "current") return console.log(`${mark("ok")} catherd ${version} is installed globally`);
+  if (r.state === "installed")
+    return console.log(
+      `${mark("ok")} catherd ${version} installed globally; the plugin starts it without bunx`,
+    );
+  console.log(`${mark("warn")} could not install catherd globally: ${r.reason}`);
+  console.log(`    fix: ${reinstallCommand(version)}`);
+}
+
 /** What happened to the profile: written, kept, or (when the defaults do not validate here) why not. */
 export function profileLines(r: InitResult, plain = false): string[] {
   const mark = (state: State) => markOf(state, plain);
   const out: string[] = [];
   if (r.errors.length) {
@@ -88,15 +113,20 @@ export function profileLines(r: InitResult, plain = false): string[] {
 /** Spec §8 `catherd init [--no-input]`: first-run setup without the TUI (plan 6 adds the TUI wizard). */
 export const initCommand = defineCommand({
   meta: {
     name: "init",
     description:
-      "First run: the Jev key, the default profile, its agents, and a readiness report. Piped, it reads the answers from stdin one per line, a line per question even when this machine skips it (the Jev key, the profile, whether to replace it), and waits for stdin to close; --no-input asks nothing",
+      "First run: the global catherd command, the Jev key, the default profile, its agents, and a readiness report. Piped, it reads the answers from stdin one per line, a line per question even when this machine skips it (the Jev key, the profile, whether to replace it), and waits for stdin to close; --no-input asks nothing",
   },
   args: {
     // citty reads --no-input as input: false, whatever the flag is named; naming it no-input shows it as is
     "no-input": { type: "boolean", description: "ask nothing: keep what exists, else write the defaults" },
+    // read as global: false, like no-input above
+    "no-global": {
+      type: "boolean",
+      description: "do not install the global catherd command (bun add -g catherd-cli@<this version>)",
+    },
     profile: { type: "string", description: "the profile to set up and make active (default: default)" },
     plain: { type: "boolean", description: "ASCII glyphs (NO_COLOR drops only colour)" },
   },
   async run({ args }) {
     // a bad --profile is refused before any question is asked
@@ -105,10 +135,11 @@ export const initCommand = defineCommand({
     const plain = args.plain === true;
     const mark = (state: State) => markOf(state, plain);
     try {
       if (process.stdout.isTTY) for (const line of welcomeLines(VERSION)) console.log(line);
       console.log(`catherd ${VERSION}: setting up in ${configDir()}`);
+      await globalStep(VERSION, { skip: (args as { global?: boolean }).global === false, plain });
       await jevStep(ask, {}, plain);
       if (args.profile !== undefined) ask?.skip?.();
       const name = assertProfileName(
         args.profile ?? (ask ? (await ask.ask("Profile to set up [default]: ")) || "default" : "default"),
       );
```

Create `src/services/global-install.ts`:

```ts
import { scrubSecrets } from "../infra/env.ts";

/** How `init` finds and installs the global `catherd` (injectable: tests never reach the registry). */
export interface GlobalInstallDeps {
  /** what the `catherd` on PATH prints for --version; null when there is none or it does not answer */
  installedVersion(): Promise<string | null>;
  /** `bun add -g catherd-cli@<version>`, with its output */
  install(version: string): Promise<{ ok: boolean; output: string }>;
}

export type GlobalInstall =
  | { state: "current" }
  | { state: "installed" }
  | { state: "failed"; reason: string };

async function run(cmd: string[]): Promise<{ ok: boolean; output: string }> {
  const p = Bun.spawn(cmd, {
    env: scrubSecrets(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { ok: code === 0, output: `${err}${out}` };
}

export const realGlobalInstall: GlobalInstallDeps = {
  async installedVersion() {
    const bin = Bun.which("catherd", { PATH: process.env.PATH ?? "" });
    if (!bin) return null;
    const r = await run([bin, "--version"]).catch(() => null);
    return r?.ok ? r.output.trim() : null;
  },
  install: (version) => run([process.execPath, "add", "-g", `catherd-cli@${version}`]),
};

/**
 * Spec 1.1 §12: the global CLI at `version`, so the plugin's launcher starts it without a bunx resolve.
 * `installing` runs before anything is resolved, so the user sees why the next seconds pass.
 */
export async function ensureGlobal(
  version: string,
  deps: GlobalInstallDeps,
  installing: () => void,
): Promise<GlobalInstall> {
  if ((await deps.installedVersion()) === version) return { state: "current" };
  installing();
  const r = await deps.install(version);
  if (r.ok) return { state: "installed" };
  const reason = r.output.split("\n").find((l) => l.trim()) ?? "bun add -g failed";
  return { state: "failed", reason: reason.trim() };
}
```

- [ ] **Step 4: Run them and see them pass**

Run: `bun test test/services/global-install.test.ts test/entry/init-command.test.ts test/entry/help-text.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 5: Run the gate**

Run: `bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: all green (`bun run format` first if format:check complains; the suite takes about 3 minutes).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(init): install the global catherd at its own version, saying so first; --no-global skips"
```


### Task 7: Access rows as info when default; the Status tab's "…" (spec 1.1 §13)

**Files:**
- Modify: `src/entry/glyphs.ts` (`info` glyph and state), `src/entry/tui/theme.ts` (`STATE_TOKEN.info`), `src/services/doctor-checks.ts` (`CheckState`), `src/services/doctor.ts` (the `access:full` / `access:advisory` rows), `src/entry/tui/views/status.tsx` (the profile count)
- Test: `test/services/doctor.test.ts`, `test/entry/doctor-command.test.ts`, `test/entry/tui/status.test.tsx`

**Interfaces:**
- Produces: `State` and `CheckState` gain `"info"` (glyph `i`, ASCII `i`, colour token `info`); `ready` still means "no fail". Access rows: `state: "info", word: "default"` when every entry is as shipped; else `state: "warn", word: "warning", detail: "<what>: <changed…>; as shipped: <shipped…>"`.

- [ ] **Step 1: Write the failing tests**

Edit `test/entry/doctor-command.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/entry/doctor-command.test.ts b/test/entry/doctor-command.test.ts
index 5b00de0..637fe5f 100644
--- a/test/entry/doctor-command.test.ts
+++ b/test/entry/doctor-command.test.ts
@@ -90,13 +90,22 @@ describe("formatCheck", () => {
       ),
     ).toEqual(["x missing            codex", "    fix: install", "         or run", "         a b"]);
   });
 });
 
+describe("an info row (spec 1.1 §13)", () => {
+  it("draws i, in both glyph sets", () => {
+    expect(
+      formatCheck({ id: "access:full", label: "full access", state: "info", word: "default", detail: "x" }),
+    ).toEqual(["i default            full access — x"]);
+    expect(mark("info", true)).toBe("i");
+  });
+});
+
 describe("mark", () => {
   it("draws the theme's glyphs, ASCII under --plain (audit N2)", () => {
-    for (const state of ["ok", "warn", "fail", "skip"] as const)
+    for (const state of ["ok", "warn", "fail", "skip", "info"] as const)
       for (const plain of [false, true]) expect(mark(state, plain)).toBe(glyph(state, plain));
   });
 });
 
 describe("catherd doctor", () => {
```

Edit `test/entry/tui/status.test.tsx` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/entry/tui/status.test.tsx b/test/entry/tui/status.test.tsx
index b1c8d04..0e0af24 100644
--- a/test/entry/tui/status.test.tsx
+++ b/test/entry/tui/status.test.tsx
@@ -25,10 +25,27 @@ async function status(effects = fixtureEffects()) {
   await h.advance(0);
   return effects;
 }
 
 describe("the Status tab (spec §9.1)", () => {
+  it("shows … for the profile count until a profiles read succeeds, never 0 profiles (spec 1.1 §13)", async () => {
+    const effects = fixtureEffects();
+    const read = effects.profiles;
+    let broken = true;
+    effects.profiles = () => {
+      if (broken) throw new CatherdError("E_CONFIG_INVALID", "config.json is not valid JSON");
+      return read();
+    };
+    await status(effects);
+    expect(h!.s.frame()).toContain("active · …");
+    expect(h!.s.frame()).not.toContain("0 profiles");
+    broken = false;
+    await h!.advance(RUNS_EVERY_MS);
+    expect(h!.s.frame()).not.toContain("active · …");
+    expect(h!.s.frame()).toContain("active · 1 profile");
+  });
+
   it("shows each check as glyph, word and detail, with its whole fix command wrapped under it", async () => {
     await status();
     const f = h!.s.frame();
     expect(f).toContain("✓ ready         codex — 0.156.1, logged in, 14 models");
     expect(f).toContain("! not logged in opencode");
```

Edit `test/services/doctor.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/test/services/doctor.test.ts b/test/services/doctor.test.ts
index c70c811..7922800 100644
--- a/test/services/doctor.test.ts
+++ b/test/services/doctor.test.ts
@@ -89,12 +89,12 @@ describe("doctor", () => {
       plugin: "ok ready",
       agents: "ok ready",
       mcp: "ok ready",
       locks: "ok ready",
       "sandbox:codex": "ok ready",
-      "access:full": "warn warning",
-      "access:advisory": "warn warning",
+      "access:full": "info default",
+      "access:advisory": "info default",
     });
     expect(check(r, "backend:codex")?.detail).toMatch(/^0\.157\.0 · ChatGPT login · \d+ models$/);
     expect(check(r, "agents")?.detail).toBe("2 linked");
     expect(check(r, "access:full")?.detail).toBe("no sandbox for: verifier (default), ui-reviewer (default)");
   });
@@ -279,10 +279,35 @@ describe("doctor", () => {
       word: "missing",
       fix: "catherd profile use default",
     });
   });
 
+  it("shows the shipped defaults' access as info, and warns only on what a profile changed (spec 1.1 §13)", async () => {
+    ready();
+    patchProfile("default", {
+      roles: {
+        reviewer: { access: "full" },
+        worker: { rungs: ["codex:gpt-6-sol#medium", "opencode:opencode-go/gpt-6-luna#high"] },
+      },
+    });
+    const r = await run();
+    expect(check(r, "access:full")).toEqual({
+      id: "access:full",
+      label: "full access",
+      state: "warn",
+      word: "warning",
+      detail: "no sandbox for: reviewer (default); as shipped: verifier (default), ui-reviewer (default)",
+    });
+    expect(check(r, "access:advisory")).toMatchObject({
+      state: "warn",
+      word: "warning",
+      detail: expect.stringMatching(
+        /^the backend asks but cannot force: worker on opencode \(default\); as shipped: /,
+      ),
+    });
+  });
+
   it("fails when the MCP server does not answer tools/list", async () => {
     ready();
     const r = await run({
       handshake: async () => ({ ok: false, tools: [], error: "no answer within 20 s" }),
     });
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/doctor.test.ts test/entry/doctor-command.test.ts test/entry/tui/status.test.tsx`
Expected: FAIL: the access rows are still `warn warning`; `mark("info")` is undefined; the Status tab shows `0 profiles` while no profiles read has succeeded.

- [ ] **Step 3: Implement**

Edit `src/entry/glyphs.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/entry/glyphs.ts b/src/entry/glyphs.ts
index 990e0b1..2567977 100644
--- a/src/entry/glyphs.ts
+++ b/src/entry/glyphs.ts
@@ -5,10 +5,11 @@
 const GLYPHS = {
   ok: ["✓", "+"],
   warn: ["!", "!"],
   fail: ["✗", "x"],
   skip: ["-", "-"],
+  info: ["i", "i"],
   live: ["●", "*"],
   waiting: ["◌", "."],
   on: ["[x]", "[x]"],
   off: ["[ ]", "[ ]"],
   open: ["▾", "v"],
@@ -28,6 +29,6 @@ export type Glyph = keyof typeof GLYPHS;
 export const GLYPH_NAMES = Object.keys(GLYPHS) as Glyph[];
 
 export const glyph = (g: Glyph, plain: boolean): string => GLYPHS[g][plain ? 1 : 0];
 
 /** The words state always travels with (spec §9.3: green/amber/red only for state, always with a word). */
-export type State = "ok" | "warn" | "fail" | "skip";
+export type State = "ok" | "warn" | "fail" | "skip" | "info";
```

Edit `src/entry/tui/theme.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/entry/tui/theme.ts b/src/entry/tui/theme.ts
index 49d2cfe..64ea444 100644
--- a/src/entry/tui/theme.ts
+++ b/src/entry/tui/theme.ts
@@ -107,10 +107,11 @@ export { glyph, GLYPH_NAMES, type Glyph, type State } from "../glyphs.ts";
 export const STATE_TOKEN: Record<State, Token> = {
   ok: "success",
   warn: "warning",
   fail: "error",
   skip: "muted",
+  info: "info",
 };
 
 export type Mood = "good" | "working" | "waiting" | "failed";
 export const FACES: Record<Mood, string> = {
   good: "=^.^=",
```

Edit `src/entry/tui/views/status.tsx` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/entry/tui/views/status.tsx b/src/entry/tui/views/status.tsx
index 820212a..e8074da 100644
--- a/src/entry/tui/views/status.tsx
+++ b/src/entry/tui/views/status.tsx
@@ -125,11 +125,12 @@ export function StatusView(props: { width: number; height: number }) {
         width={w}
         selected={sel}
         parts={[
           { text: `   ${profiles.here}`, bold: true },
           {
-            text: `  ${hereWord(profiles)} · ${plural(profiles.names.length, "profile")}`,
+            // "…" until the first read: never "0 profiles" on the first frame (spec 1.1 §13)
+            text: `  ${hereWord(profiles)} · ${data.profiles.value ? plural(profiles.names.length, "profile") : "…"}`,
             tone: "muted",
           },
         ]}
       />
     ),
```

Edit `src/services/doctor-checks.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/services/doctor-checks.ts b/src/services/doctor-checks.ts
index 704ce50..f4b734d 100644
--- a/src/services/doctor-checks.ts
+++ b/src/services/doctor-checks.ts
@@ -7,11 +7,12 @@ import { agentLinkState } from "./agent-links.ts";
 import type { Handshake } from "./doctor.ts";
 import { activeName } from "./profile-store.ts";
 
 // The rows of `catherd doctor` and the checks that stand alone; doctor.ts assembles the report.
 
-type CheckState = "ok" | "warn" | "fail" | "skip";
+/** `info`: worth knowing, nothing to fix (spec 1.1 §13: the shipped defaults' access) */
+type CheckState = "ok" | "warn" | "fail" | "skip" | "info";
 
 /** One row of `catherd doctor` (spec §10.3): its state, one word, the detail and the full fix. */
 export interface Check {
   id: string;
   label: string;
```

Edit `src/services/doctor.ts` (diff; re-find each hunk by its context, line numbers may have moved):

```diff
diff --git a/src/services/doctor.ts b/src/services/doctor.ts
index 18f4656..1f3c30d 100644
--- a/src/services/doctor.ts
+++ b/src/services/doctor.ts
@@ -1,10 +1,10 @@
 import { existsSync, statSync } from "node:fs";
 import { adapterFor } from "../adapters/registry.ts";
 import "../adapters/all.ts";
-import type { Profile } from "../domain/profile.ts";
-import { ROLES } from "../domain/roles.ts";
+import { BUILTIN_ROLES, type Profile } from "../domain/profile.ts";
+import { DEFAULT_ACCESS, ROLES } from "../domain/roles.ts";
 import { bunTooOld, MIN_BUN } from "../domain/runtime.ts";
 import type { JevTransport } from "../infra/jev-client.ts";
 import { locksDir } from "../infra/paths.ts";
 import { linkedProfiles } from "./agent-links.ts";
 import { backendChecks, usedBackends, workspaceWriteBackends } from "./doctor-backends.ts";
@@ -234,42 +234,52 @@ export async function doctor(d: DoctorDeps): Promise<DoctorReport> {
               ...(r.fix ? { fix: r.fix } : {}),
             },
     );
   }
 
-  const full: string[] = [];
-  const advisory: string[] = [];
+  // spec 1.1 §13: what the shipped defaults do is info; a warning only for what a profile changed
+  const full = { changed: [] as string[], shipped: [] as string[] };
+  const advisory = { changed: [] as string[], shipped: [] as string[] };
+  const backendOf = (r: string) => r.slice(0, r.indexOf(":"));
   for (const p of profiles)
     for (const role of ROLES) {
       const rc = p.roles[role];
       if (!rc.enabled) continue;
-      if (rc.access === "full") full.push(`${role} (${p.name})`);
+      const asShipped = rc.access === DEFAULT_ACCESS[role];
+      if (rc.access === "full") (asShipped ? full.shipped : full.changed).push(`${role} (${p.name})`);
       const soft = [
-        ...new Set(
-          rc.rungs
-            .filter((r) => enforcementOf(r, rc.access) === "advisory")
-            .map((r) => r.slice(0, r.indexOf(":"))),
-        ),
+        ...new Set(rc.rungs.filter((r) => enforcementOf(r, rc.access) === "advisory").map(backendOf)),
       ];
-      if (soft.length) advisory.push(`${role} on ${soft.join(", ")} (${p.name})`);
+      const shippedOn = new Set(BUILTIN_ROLES[role].rungs.map(backendOf));
+      const ours = soft.filter((b) => asShipped && shippedOn.has(b));
+      const theirs = soft.filter((b) => !ours.includes(b));
+      if (ours.length) advisory.shipped.push(`${role} on ${ours.join(", ")} (${p.name})`);
+      if (theirs.length) advisory.changed.push(`${role} on ${theirs.join(", ")} (${p.name})`);
     }
-  if (full.length)
-    checks.push({
-      id: "access:full",
-      label: "full access",
-      state: "warn",
-      word: "warning",
-      detail: `no sandbox for: ${full.join(", ")}`,
-    });
-  if (advisory.length)
-    checks.push({
-      id: "access:advisory",
-      label: "advisory access",
-      state: "warn",
-      word: "warning",
-      detail: `the backend asks but cannot force: ${advisory.join(", ")}`,
-    });
+  const accessRow = (
+    id: string,
+    label: string,
+    rows: { changed: string[]; shipped: string[] },
+    what: string,
+  ): Check | null => {
+    if (!rows.changed.length && !rows.shipped.length) return null;
+    const shipped = rows.shipped.join(", ");
+    return rows.changed.length
+      ? {
+          id,
+          label,
+          state: "warn",
+          word: "warning",
+          detail: `${what}: ${rows.changed.join(", ")}${shipped ? `; as shipped: ${shipped}` : ""}`,
+        }
+      : { id, label, state: "info", word: "default", detail: `${what}: ${shipped}` };
+  };
+  for (const row of [
+    accessRow("access:full", "full access", full, "no sandbox for"),
+    accessRow("access:advisory", "advisory access", advisory, "the backend asks but cannot force"),
+  ])
+    if (row) checks.push(row);
   for (const id of used.keys()) {
     const note = adapterFor(id)?.isolationNote;
     if (note)
       checks.push({
         id: `isolation:${id}`,
```

- [ ] **Step 4: Run them and see them pass**

Run: `bun test test/services/doctor.test.ts test/entry/doctor-command.test.ts test/entry/tui`
Expected: PASS, 0 fail.

- [ ] **Step 5: Run the gate**

Run: `bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: all green (`bun run format` first if format:check complains; the suite takes about 3 minutes).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(doctor): the shipped defaults' access rows as info; the status tab shows … before profiles load"
```


### Task 8: README and MIGRATION.md for 1.1 (spec 1.1 §13)

**Files:**
- Modify: `README.md` (feature bullets, Install, Use, Upgrading, dev env line, Docs table), `MIGRATION.md` (a "From 1.0 to 1.1" section first; the 0.x text becomes "From 0.x to 1.0")

**Interfaces:**
- Consumes: the user-visible behaviour of plans 10–12 as the spec states it (see "Assumes from earlier plans"). Before writing, check each claim against the merged code: tool names, error codes, the `push` row, `roles.<role>.network`, the runs page. Where plan 10 already removed the README's `CATHERD_TICK_MS` sentence, skip that hunk.

- [ ] **Step 1: Write the text**

Edit `MIGRATION.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/MIGRATION.md b/MIGRATION.md
index 26ecb90..a73b01f 100644
--- a/MIGRATION.md
+++ b/MIGRATION.md
@@ -1,14 +1,113 @@
-# Upgrading from catherd 0.x to 1.0
+# Upgrading catherd
+
+- [From 1.0 to 1.1](#from-10-to-11)
+- [From 0.x to 1.0](#from-0x-to-10)
+
+## From 1.0 to 1.1
+
+1.1 reads 1.0's profiles, runs and settings as they are; nothing is moved or converted. Three steps:
+
+```sh
+catherd init            # installs the global catherd 1.1 (bun add -g catherd-cli@1.1.0) and checks everything
+claude plugin marketplace update catherd && claude plugin update catherd@catherd
+```
+
+Then start a new Claude Code session: it loads the new plugin, its MCP server and the rewritten skills.
+
+### `wait` is gone: results come to you, `peek` and `result` read them
+
+1.0's orchestrator called `wait` after dispatching, and the whole session froze until the roles finished. In 1.1
+`dispatch` returns at once, the orchestrator ends its turn, and each finished role arrives in the session as a
+message from catherd (`<cross-session-message from-name="catherd">`), the way a native subagent's notice does.
+You can keep talking to Claude meanwhile.
+
+| 1.0                                           | 1.1                                                                                                                                             |
+| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
+| `wait(run, names?)` blocks until roles end    | removed; the notice arrives by itself                                                                                                           |
+| `wait` returned the records                   | `result(run, name)` returns one record and marks it read                                                                                        |
+| `status(run)` to see where a run stands       | still works; `peek(run?, name?)` answers at once: live roles with their last event, unread records, parked questions and the next protocol step |
+| `CATHERD_TICK_MS` (how often `wait` reported) | removed                                                                                                                                         |
+
+`peek` never waits and never marks anything read. A record stays unread until `result` reads it, so a notice that
+never arrives (Claude Code closed, an old Claude Code) loses nothing: `peek` or the next `run_start` shows it.
+`catherd doctor` has a `push` row: run it from a Claude Code session (its Bash tool) to test the notices. On
+Linux, where Claude Code cannot tell that catherd's messages come from its own MCP server, the row says whether
+to set `crossSessionInbound`; `init` never changes that setting.
+
+### The MCP tools: 25
+
+Removed `wait`. Added `peek`, `gate_check`, `gate_pass`, `park` and `answer`. Changed:
+
+- `dispatch` refuses a lane whose `Kind:` or `Difficulty:` is not one catherd knows (`E_LANE_INVALID`, with the
+  allowed values), routes a lane that was never routed, and appends the role's reply contract (the `STATUS:` line)
+  to every brief. Briefs no longer need to carry it.
+- `land` refuses a milestone without a reviewer record and a verifier verdict since its lanes started
+  (`E_LAND_GATE`); `skip: "docs-only"` and `skip: "no-code"` cover milestones that change no code.
+- `climb` refuses a plan or ownership problem (`E_CLIMB_DESIGN`): that goes to the architect, not up the ladder.
+- `result` consumes the record (see above); `run_start` returns the run's next protocol step and the milestone
+  checklist, and `state.md` ends with `Protocol next: <step>`.
+- `park(run, milestone, question)` and `answer(run, milestone, answer)`: one owner question no longer stops the
+  run; the other milestones go on.
+- `gate_check` and `gate_pass`: the verifier carries over a gate item whose command and inputs have not changed
+  (the ledger is `<data>/repos/<repo>/gates.jsonl`).
+
+The plugin's skills use all of this; update the plugin with catherd, as above.
+
+### Workers can run their own checks
+
+A `workspace-write` role (worker, writer, artist by default) may now reach the network, bind a loopback port,
+write catherd's lock dir and the temp dir, and talk to a local Docker socket. Codex gets
+`sandbox_workspace_write.network_access` and `writable_roots` for it. To keep a role off the network:
+
+```sh
+catherd profile set roles.worker.network false
+```
+
+`catherd doctor` runs five probes for each backend a `workspace-write` role uses (lock dir, temp dir, loopback,
+HTTPS, Docker) and names the fix for each that fails.
+
+### Failover and validation
+
+- The default failover now uses only a stand-in that clears the same bars as its rung at least as well: Luna high
+  to OpenCode Go's Luna, Sol medium to Kimi K3. Sol high and xhigh have none, so a usage limit there pauses the
+  lane instead of dropping it to the medium tier. **A profile written by 1.0 keeps its own map**, which sends Sol
+  high and xhigh to Kimi K3; `catherd profile validate` now warns about it (`downgrade: …`) and its fix removes the
+  entry, or run `catherd profile set failover.codex:gpt-6-sol#high null` (and the same for `#xhigh`).
+- `validate` also warns when a stand-in spends Claude quota while another plan could stand in, and when a
+  ladder's rung scores below the one before it. Warnings never block a save.
+- `profile show` and the dashboard say "scores borrowed from X" for a stand-in with no scores of its own, instead
+  of "inferred: treated like X".
+
+### Install and launch
+
+- The marketplace fetches the plugin over HTTPS, so installing it no longer needs a GitHub SSH key.
+- The plugin starts its MCP server through `plugin/bin/catherd-mcp`: the global `catherd` when it is the plugin's
+  version, else `bunx catherd-cli@<version>` with its cache in `~/.cache/catherd/bunx` (or
+  `$XDG_CACHE_HOME/catherd/bunx`) instead of `$TMPDIR`, which macOS cleans. Workers still get your own `TMPDIR`.
+- `catherd init` installs the global command at its own version and says `installing catherd…` first;
+  `--no-global` skips it.
+- `catherd doctor`'s `mcp` row starts the server the way the plugin does; a broken install says
+  `reinstall: bun add -g catherd-cli@<version>`. The shipped defaults' access rows (full access for the verifier
+  and ui-reviewer, advisory access for the Claude roles) are info rows (`i`) now, and warnings only when a
+  profile changes them.
+
+### The runs page, by session
+
+`catherd`'s Runs tab lists the Claude Code sessions that drove runs, newest first; open one to watch its runs,
+milestones and roles live. Runs started by 1.0 are under "earlier runs". `catherd runs list` and `status` group
+the same way, and their `--json` gains `session`.
+
+## From 0.x to 1.0
 
 1.0 is a clean break: it reads none of 0.x's files and converts nothing. One command sets it up:
 
 ```sh
 bunx catherd-cli init
 ```
 
-## What `init` does to a 0.x install
+### What `init` does to a 0.x install
 
 - **Moves your 0.x settings aside.** `config.json`, `projects.json` and every profile in `profiles/` that
   0.x wrote (the ones without a `"schema"` field) go from your config folder (`~/.config/catherd/`,
   `$XDG_CONFIG_HOME/catherd/` or `$CATHERD_HOME/config/`) into `0.x-backup-<date and time>/` inside it.
   Nothing is deleted, and 1.0 never reads that folder again.
@@ -24,11 +123,11 @@ bunx catherd-cli init
   `credentials.json`, so if your key lived only in that file, `init` asks for it once: paste it there.
 - Lists your backends' models and ends with `catherd doctor`'s readiness report and the plugin commands.
 
 `init --no-input` does the same without asking anything.
 
-## What it leaves alone
+### What it leaves alone
 
 0.x run data. Your data folder is `~/.local/share/catherd/` (or `$XDG_DATA_HOME/catherd/`, or
 `$CATHERD_HOME/data/`). 1.0 keeps its runs in `repos/` there and does not read what 0.x left beside it:
 
 - **0.x runs**: one folder per repository, named after the repository's path with the leading `/` dropped
@@ -43,11 +142,11 @@ Delete those when you no longer need them. Keep everything else, because 1.0 use
 - `locks/`: the heavy-command slots (`catherd lock`).
 - `discovery/`: each backend's last model listing.
 - `codex-home/`: the isolated Codex home, with the sessions an isolated Codex thread resumes from.
 - `opencode-home/`: the isolated opencode config.
 
-## Then
+### Then
 
 1. Update the Claude Code plugin, and start a new session:
 
    ```sh
    claude plugin marketplace update catherd && claude plugin update catherd@catherd
@@ -56,11 +155,11 @@ Delete those when you no longer need them. Keep everything else, because 1.0 use
 2. opencode must be v2 (2.0.16 or newer); 0.x's install hint installed v1:
    `curl -fsSL https://opencode.ai/v2/install | bash`.
 3. Check everything with `bunx catherd-cli doctor`: it exits 0 when catherd is ready, and prints the fix
    for every row that is not.
 
-## What else changed
+### What else changed
 
 - Bun 1.4 or newer; catherd refuses to start on an older one and says how to upgrade.
 - `catherd watch` and the dashboard show 1.0 runs only.
 - The MCP server has 21 tools (0.x had 18), and every error is `{ code, message, fix }`. `dispatch` now returns
   as soon as its role starts, and the new `wait` returns the records; the plugin's skills
````

Edit `README.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/README.md b/README.md
index 968d68d..1b60cdc 100644
--- a/README.md
+++ b/README.md
@@ -15,12 +15,17 @@ of work, climbing a ladder only when a cheaper rung falls short.
   you'd rather save the tokens your customizations cost.
 - **Claude roles stay native.** `claude:` rungs run as ordinary Claude Code subagents; Codex,
   opencode and headless `claude-code:` rungs run through catherd's MCP server.
 - **Survives restarts.** Workers are detached processes writing straight to disk, so a dropped
   MCP server never loses a run.
-- **Guard rails for autopilot.** Quota failover to a rung on another quota, a preflight check before any
-  worker starts, per-repo knowledge carried between runs, and a run budget.
+- **Results come to you.** Roles run side by side while you keep talking to Claude; each one that finishes
+  arrives in the session as a message, like a native subagent's notice, and `peek` shows how a run stands.
+- **A protocol the tools enforce.** Every lane is routed, every brief ends with the reply contract, and a
+  milestone lands only after a reviewer and a verifier passed it. Workers can run their own checks (network,
+  loopback, Docker, the lock dir); an owner question parks one milestone, not the run.
+- **Guard rails for autopilot.** Quota failover to a stand-in that clears the same bars, a preflight check
+  before any worker starts, per-repo knowledge carried between runs, and a run budget.
 
 ## Requirements
 
 - [Bun](https://bun.sh) ≥ 1.4
 - [Claude Code](https://claude.com/claude-code) (desktop app or CLI)
@@ -36,31 +41,36 @@ profile runs its workers on Codex; without Codex, doctor's fix also names how to
 you have (`/catherd-setup` in Claude Code, or `catherd profile set roles.<role>.rungs <rung>`).
 
 ## Install
 
 ```sh
-bunx catherd-cli init
+bun add -g catherd-cli
+catherd init
 ```
 
-The npm package is `catherd-cli`; the command it installs is `catherd`. `init` asks for the optional Jev key,
+The npm package is `catherd-cli`; the command it installs is `catherd`. `bunx catherd-cli init` works too: `init`
+installs the global command at its own version (`--no-global` skips it) and says `installing catherd…` before
+it does, though the first `bunx` resolve itself prints nothing for up to half a minute. `init` asks for the optional Jev key,
 writes the default profile and links its Claude agents, lists your backends' models, and ends with a readiness
 report (`--no-input` asks nothing and keeps what exists; `--profile <name>` sets up and activates that profile
 instead of `default`; piped, it reads one answer per line once stdin closes: the Jev key, the profile, whether to replace it, each on its own line even when a question is skipped). Then add the plugin to Claude Code:
 
 ```sh
 claude plugin marketplace add 47vigen/catherd
 claude plugin install catherd@catherd
 ```
 
 Start a new Claude Code session so the plugin, its MCP server and the agent files load, then check with
-`bunx catherd-cli doctor`.
+`catherd doctor`. Run it once from inside that session too (ask Claude to run `catherd doctor`): its `push` row
+then checks that finished roles can reach the session.
 
 ## Use
 
 In Claude Code:
 
-- `/catherd <task>` runs a task on autopilot; `/catherd` alone resumes the latest run.
+- `/catherd <task>` runs a task on autopilot; `/catherd` alone resumes the latest run. While it runs, keep
+  talking: each finished role arrives as a message from catherd, and "how is it going?" gets a `peek`.
 - `/catherd-setup` tunes your profile in conversation: which models and efforts each role may
   use, cost or speed, isolation, budget and failover.
 
 In a terminal:
 
@@ -101,12 +111,11 @@ Run data lives in `~/.local/share/catherd/`, config in `~/.config/catherd/` (bot
 | `CATHERD_REDUCED_MOTION`    | Any value: the dashboard's `--reduced-motion`                                                         |
 | `CATHERD_NO_KITTY`          | Any value: turns off the kitty keyboard protocol in the dashboard, for terminals it breaks            |
 | `CATHERD_CLAUDE_AGENTS_DIR` | Where catherd links its Claude agents (default: `$CLAUDE_CONFIG_DIR/agents`, else `~/.claude/agents`) |
 | `NO_COLOR`                  | Drops colour (the dashboard's and `--help`'s; piped `--help` has none either)                         |
 
-For development only: `CATHERD_STORY=1` opens the dashboard's storybook, `CATHERD_TICK_MS` sets how often a blocked
-`wait` reports progress (default 30000), and `CATHERD_LIVE=1` enables the live tests
+For development only: `CATHERD_STORY=1` opens the dashboard's storybook, and `CATHERD_LIVE=1` enables the live tests
 (CONTRIBUTING.md has the rest).
 
 ### The dashboard
 
 `catherd` opens three tabs: **1 Status** (every check with its fix; `y` copies the fix, `r` checks again),
@@ -129,11 +138,19 @@ milestones; `p` pauses). `catherd watch` opens it on Runs.
 - `--plain` draws ASCII without colour, `NO_COLOR` drops the colour, `--reduced-motion` stops the spinner.
 - Rebind a key in `~/.config/catherd/config.json`: `"keybinds": { "profile.save": "ctrl+w", "app.help": "none" }`
   (the palette shows each command by title; the ids are listed in
   [`src/entry/tui/commands.ts`](src/entry/tui/commands.ts)).
 
-## Upgrading from 0.x
+## Upgrading
+
+From 1.0: run `catherd init` (it installs catherd 1.1 globally), update the plugin
+(`claude plugin marketplace update catherd && claude plugin update catherd@catherd`) and start a new Claude Code
+session. `wait` is gone: results arrive as messages, `peek` shows a run, `result` reads a record. A profile saved
+by 1.0 keeps its failover map; `catherd profile validate` says what to change. The details are in
+[MIGRATION.md](MIGRATION.md).
+
+### From 0.x
 
 1.0 is a clean break: run `bunx catherd-cli init` once. It moves your 0.x `config.json`, `projects.json` and
 profiles into a `0.x-backup-<time>/` folder next to them (it never reads or deletes them), writes the 1.0
 default profile, replaces the 0.x Claude agent links with 1.0 ones and keeps your saved Jev key; 0.x run
 folders stay where they are, unread. Then update the plugin
@@ -142,15 +159,16 @@ Code session. The details are in [MIGRATION.md](MIGRATION.md).
 
 ## Docs
 
 | Where                                                                                              | What                                                                  |
 | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
-| [MIGRATION.md](MIGRATION.md)                                                                       | Upgrading from 0.x                                                    |
+| [MIGRATION.md](MIGRATION.md)                                                                       | Upgrading from 1.0 and from 0.x                                       |
 | [CHANGELOG.md](CHANGELOG.md)                                                                       | Releases                                                              |
 | [CONTRIBUTING.md](CONTRIBUTING.md)                                                                 | Development setup, the checks, commits, changesets, live tests        |
 | [SECURITY.md](SECURITY.md)                                                                         | Reporting a vulnerability; what catherd stores and how                |
-| [`docs/specs/2026-09-25-catherd-1.0-design.md`](docs/specs/2026-09-25-catherd-1.0-design.md)       | The 1.0 design (binding)                                              |
+| [`docs/specs/2026-09-28-catherd-1.1-design.md`](docs/specs/2026-09-28-catherd-1.1-design.md)       | The 1.1 design (binding; builds on 1.0's)                             |
+| [`docs/specs/2026-09-25-catherd-1.0-design.md`](docs/specs/2026-09-25-catherd-1.0-design.md)       | The 1.0 design                                                        |
 | [`docs/dev/`](docs/dev/)                                                                           | Maintainer docs: live verification, manual tests, dependencies, ideas |
 | [`docs/dev/live-verification.md`](docs/dev/live-verification.md)                                   | What CI cannot run: live tests, fixture capture, the Codex sandbox    |
 | [`docs/tui-frames.md`](docs/tui-frames.md)                                                         | Every dashboard screen as text (generated, checked in CI)             |
 | [`docs/plans/`](docs/plans/), [`docs/handoff/`](docs/handoff/), [`docs/research/`](docs/research/) | How 1.0 was designed and built: plans, reviews, research              |
 | [`docs/archive/0.x/`](docs/archive/0.x/)                                                           | The 0.x design and plans, for history                                 |
````

- [ ] **Step 2: Run the gate**

Run: `bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: all green (`bun run format` first if format:check complains; the suite takes about 3 minutes).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: readme and migration for catherd 1.1"
```


### Task 9: live-verification: push, access and the 1.1 acceptance runs (spec 1.1 §15)

**Files:**
- Modify: `docs/dev/live-verification.md` (intro sentence, new §7 Push notices, §8 Worker access, §9 The 1.1 acceptance with owner steps 1 and 2)

**Interfaces:**
- Consumes: plan 10's `push` doctor row and notice format; plan 11's `access:<backend>` rows, `codex sandbox [--config …] -- <cmd>` form and `roles.<role>.network`. Re-check the row ids and words against the merged doctor before writing them into §7 and §8.

- [ ] **Step 1: Write the text**

Edit `docs/dev/live-verification.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/docs/dev/live-verification.md b/docs/dev/live-verification.md
index f585c60..61575e8 100644
--- a/docs/dev/live-verification.md
+++ b/docs/dev/live-verification.md
@@ -1,9 +1,10 @@
 # Live verification
 
 What CI cannot check, because it needs real accounts: the backends' real streams, the Codex sandbox, and
-the Jev key prompt on a real terminal (spec D7, §11.7, §11.8). Run it on your own machine before a
+the Jev key prompt on a real terminal (spec D7, §11.7, §11.8); since 1.1 also the push notices, the worker
+access probes and the release acceptance runs (spec 1.1 §15, sections 7 to 9). Run it on your own machine before a
 release, and again after a backend CLI's minor release. Every step says what to look for; write down
 anything that differs and file it with the step's name.
 
 You need: Bun ≥ 1.4, a catherd checkout (`git clone https://github.com/47vigen/catherd && cd catherd &&
 bun install`), and the three backends logged in: Codex with your ChatGPT account (`codex login`), Claude
@@ -203,5 +204,130 @@ runs show <run id> --json` holds the records; write down what you saw.
    `fix`, the orchestrator pausing (`set_next` with "paused: …"), and `status(run)` showing the budget
    spent past its cap. Remove it with `profile set budget.tokens null`.
 
 Clean up with `bun <catherd checkout>/src/cli.ts profile use --repo --clear` and
 `bun <catherd checkout>/src/cli.ts profile rm live-kit`.
+
+## 7. Push notices (1.1)
+
+Finished roles reach the Claude Code session that drove them as messages on its peer inbox (spec 1.1 §3). The
+protocol is Claude Code's own and undocumented, so check it after every Claude Code update.
+
+From a plain terminal first, then from inside a Claude Code session (ask Claude to run it with its Bash tool):
+
+```sh
+bun src/cli.ts doctor
+```
+
+Look for: from the terminal, the `push` row `- no session` with "run catherd doctor from a Claude Code session
+to test push". From the session, `✓ ready` on `push`, and the message `catherd doctor: push test, no action
+needed` showing up in the session once its turn ends. `! held` means a `crossSessionInbound` setting (or, on
+Linux, a permission-mode mismatch) holds the message: apply the row's fix and run it again. `✗ failed` means this
+Claude Code changed the protocol: record the Claude Code version (`claude --version`); `peek` still works.
+
+Then a run: in the session, ask `/catherd` for two changes to files that share nothing, and once it has
+dispatched both, ask it something unrelated ("what is 17 × 23?"). Look for: the answer comes at once, while the
+roles run; a `<cross-session-message from-name="catherd">` per role (or one message naming both, when they end
+within 3 s), each starting `catherd · <run title> · <name> <role> · <rung> · <status>`; and the orchestrator
+calling `result` for each record, never `sleep` or `peek` in a loop. Asking "how is it going?" mid-run gets a
+`peek` answer with each live role's last event. Then quit Claude Code while a role still runs, start it again
+in the same folder with `claude --continue`, and look for: the finished role reported once (by the restart scan
+or by `peek`), never twice.
+
+## 8. Worker access (1.1)
+
+A `workspace-write` worker may reach the network, bind a loopback port, write the lock dir and the temp dir, and
+use a local Docker socket (spec 1.1 §5). `doctor` probes each backend a `workspace-write` role uses:
+
+```sh
+bun src/cli.ts doctor
+```
+
+Look for: an `access:<backend>` row per such backend (`access:codex`, and `access:opencode` or
+`access:claude-code` when a role uses them), `✓ ready` or a list of the probes that failed with each fix; and
+the `sandbox:codex` row `✓ ready`. Docker is probed only when `docker` is installed: with OrbStack or Docker
+Desktop running, the Docker probe must pass too.
+
+Then the same five by hand in Codex's sandbox, with the flags a worker gets (use the old form,
+`codex sandbox macos --full-auto -c … -- <cmd>`, if `codex sandbox --help` lists `macos` and `linux`):
+
+```sh
+locks="$HOME/.local/share/catherd/locks"; mkdir -p "$locks"
+tmp="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
+roots="sandbox_workspace_write.writable_roots=[\"$locks\",\"$tmp\"]"
+net="sandbox_workspace_write.network_access=true"
+cd "$(mktemp -d)"
+codex sandbox -c "$net" -c "$roots" -- sh -c "touch '$locks/.p' && rm '$locks/.p'"; echo "lock dir: $?"
+codex sandbox -c "$net" -c "$roots" -- sh -c "touch '$tmp/.p' && rm '$tmp/.p'"; echo "temp: $?"
+codex sandbox -c "$net" -c "$roots" -- python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0))'; echo "loopback: $?"
+codex sandbox -c "$net" -c "$roots" -- curl -fsSI https://registry.npmjs.org/; echo "https: $?"
+codex sandbox -c "$net" -c "$roots" -- docker version; echo "docker: $?"
+cd -
+```
+
+Look for: `0` after every line (the Docker line only with Docker running). Record any that is not, with
+`codex --version`. Last, with §6's `live-kit` profile (before its clean-up):
+`profile set roles.worker.network false --profile live-kit`, then a one-lane `/catherd` run whose brief asks the
+worker to `curl -fsSI https://registry.npmjs.org/`. Look for: the worker's reply saying the network is closed,
+and `doctor` probing no network or loopback for that role. Put it back with
+`profile set roles.worker.network null --profile live-kit`.
+
+## 9. The 1.1 acceptance (the release PR waits for it)
+
+Spec 1.1 §15. Both runs use the published release candidate: `bun add -g catherd-cli@<version>` from the release
+PR, and the plugin updated to it (`claude plugin marketplace update catherd && claude plugin update
+catherd@catherd`).
+
+**1. A headless run on a scratch Bun repository.**
+
+```sh
+scratch="$(mktemp -d)/acceptance" && mkdir -p "$scratch" && cd "$scratch"
+git init -q && bun init -y >/dev/null && git add -A && git commit -qm init
+catherd profile new acceptance && catherd profile use acceptance --repo
+claude -p --permission-mode bypassPermissions --output-format stream-json --verbose \
+  "/catherd:catherd In one milestone, three lanes that share no file: src/slug.ts (slugify a string), src/clamp.ts (clamp a number to a range) and src/chunk.ts (split an array into chunks), each with its own bun test that the worker runs. In a second milestone, src/index.ts re-exports all three. While the first milestone runs, call peek once and tell me how it stands." \
+  > run.jsonl
+run="$(ls -dt ~/.local/share/catherd/repos/*/runs/*/ | head -1)"
+session="$(jq -r 'select(.type == "system" and .subtype == "init") | .session_id' run.jsonl | head -1)"
+```
+
+Look for, one at a time:
+
+1. Notices arrived while the session made other calls:
+   `grep -c 'from-name=\\"catherd\\"' ~/.claude/projects/*/"$session".jsonl` prints 3 or more, and in `run.jsonl`
+   other tool calls sit between the three `dispatch` calls and the first notice.
+2. `peek` answered during the run: `grep -o '"name":"mcp__[a-z_]*catherd__peek"' run.jsonl | head -1` prints a
+   line, before the last worker's record.
+3. Every lane was routed with valid headers: `wc -l < "$run/routes.jsonl"` is at least 4, and
+   `grep -hE '^(Kind|Difficulty):' "$run"/lanes/*.md | sort | uniq -c` shows only the catalog's values.
+4. A reviewer and a verifier ran before each `land`:
+   `catherd runs show "$(basename "$run")" --json | jq -r '.records[] | "\(.startedAt) \(.name) \(.status)"'`
+   lists a `reviewer-M1…` and a `reviewer-M2…` record with status `ok`, and
+   `jq -r '"\(.role) \(.name) \(.status)"' "$run/agents.jsonl"` a verifier row naming each milestone.
+5. A worker ran `bun install` and its tests itself:
+   `grep -l 'bun test' "$run"/roles/*/events.jsonl` names the three workers, and no `bun test` appears in the
+   orchestrator's own tool calls in `run.jsonl`.
+6. Replies carry STATUS: `catherd runs show "$(basename "$run")" --json | jq -r '.records[].replyStatus'` prints
+   no `null`.
+
+Clean up with `catherd profile use --repo --clear && catherd profile rm acceptance`.
+
+**2. The real run.** In the `sanitell/platform` checkout:
+
+```sh
+glab mr merge 54 --yes && git checkout main && git pull
+```
+
+Then open a fresh Claude Code Desktop session on that checkout and send `/catherd auth plan 5, MR B (kit
+clean-up)`. Keep using the session while it runs (ask it questions; answer a parked question when one comes).
+When it has landed, compare with MR A (100 min in all, the verifier about 85 of them):
+
+```sh
+run="$(catherd runs list --json | jq -r '.runs[0].id')"
+catherd status "$run" --json | jq '.runs[0] | {wallMinutes: .totals.wallMinutes, notOk: .totals.notOk, milestones}'
+jq -r 'select(.role == "verifier") | "\(.name) \(.status) \((.durationMs // 0) / 60000 | floor) min"' \
+  "$(ls -dt ~/.local/share/catherd/repos/*/runs/"$run"/ | head -1)agents.jsonl"
+```
+
+Write down: the total minutes, the verifier's minutes and how many gate items it carried over (`carried over
+from <commit>` in its verdict), how many worker replies were `partial` or `blocked`, how many test commands the
+main thread ran itself (MR A: 156), and whether any notice was missing or doubled.
````

- [ ] **Step 2: Run the gate**

Run: `bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: all green (`bun run format` first if format:check complains; the suite takes about 3 minutes).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs(dev): live checks for push notices, worker access and the 1.1 acceptance runs"
```


### Task 10: The 1.1.0 changeset

**Files:**
- Create: `.changeset/catherd-1-1.md` (minor bump of `catherd-cli`)

**Interfaces:**
- Consumes: everything above. Adjust a bullet only if a merged plan changed what it names.

- [ ] **Step 1: Write the text**

Create `.changeset/catherd-1-1.md`:

```markdown
---
"catherd-cli": minor
---

catherd 1.1: results come to you, the protocol is enforced, and workers run their own checks. Run `catherd init` after upgrading, then update the plugin and start a new Claude Code session (see MIGRATION.md, "From 1.0 to 1.1").

- **Push, not `wait`.** A finished role reaches the Claude Code session that drove it as a message on its peer inbox, like a native subagent's notice, so the session stays free while roles run. `wait` is removed; `peek` shows a run at once (live roles with their last event, unread records, parked questions, the next protocol step) and `result` reads a record and marks it read. A lost message loses nothing: records wait on disk. `doctor` has a `push` row.
- **Sessions.** Runs remember the Claude Code session that started and continued them; the Runs tab lists sessions and opens one live, and `runs list`/`status` group by session.
- **Workers can run their checks.** `workspace-write` roles get the network, loopback, the lock and temp dirs and a local Docker socket (Codex through `network_access` and `writable_roots`); `roles.<role>.network: false` closes the network for a role. `doctor` probes each of the five per backend (`access:<backend>`), and its Codex sandbox probe uses the current `codex sandbox` form.
- **An enforced protocol.** `dispatch` refuses unknown `Kind:`/`Difficulty:` values (`E_LANE_INVALID`), routes an unrouted lane and appends the reply contract to every brief; `land` needs a reviewer record and a verifier verdict (`E_LAND_GATE`, with `skip: "docs-only" | "no-code"`); `climb` sends plan and ownership problems to the architect (`E_CLIMB_DESIGN`); `state.md` ends with `Protocol next:` and `land` writes a milestone digest.
- **A faster verifier.** A per-repo gate ledger (`gate_check`, `gate_pass`) carries over unchanged gate items; the verifier runs independent items side by side and reports each step.
- **Owner questions park one milestone** (`park`, `answer`), not the run.
- **Failover and validation.** The default failover uses only stand-ins that clear the same bars as their rung (Sol high and xhigh have none); `validate` warns on a downgrading stand-in, a Claude stand-in while another plan could stand in, and a ladder that goes down; stand-ins say "scores borrowed from X".
- **Install and launch.** The marketplace fetches the plugin over HTTPS (no GitHub SSH key needed); the plugin starts its server through a stamped launcher that runs the global `catherd` or `bunx` with its cache out of `$TMPDIR`; `init` installs the global command (`--no-global` skips it); `doctor`'s `mcp` row starts the server as the plugin does and names the reinstall command; the shipped defaults' access rows are info, not warnings.
- **25 MCP tools:** `wait` removed; `peek`, `gate_check`, `gate_pass`, `park` and `answer` added.
```

- [ ] **Step 2: Check the release it produces, then throw that away**

Run: `bunx changeset status` → `minor: catherd-cli`. Then, only in a scratch worktree: `bun run version-packages && grep '^VERSION=' plugin/bin/catherd-mcp && bun test test/plugin.test.ts` → `VERSION="1.1.0"` and 7 pass; `git reset --hard` afterwards (the Release workflow does the real bump).

- [ ] **Step 3: Run the gate**

Run: `bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: all green (`bun run format` first if format:check complains; the suite takes about 3 minutes).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: changeset for catherd 1.1.0"
```
