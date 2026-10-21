# catherd 1.6, plan 29: gate evidence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a landing rests on evidence about the commit it lands, not on a model's word. `land` requires the verifier's `HEAD:` to be the commit being landed; the milestone's full check is run by catherd itself (`gate_run`), detached, against HEAD, with its exit code and failing lines recorded, a failure with new lines rerun once, failures the base already has let through with an audit line, and a gitleaks scan of the run's commits; heavy commands wait while the machine is overloaded and each gets an emptied `TMPDIR`/`GOTMPDIR`.

**Architecture:** A new service `src/services/milestone-check.ts` owns the check ledger (`<data>/repos/<repo key>/checks.jsonl`, beside `gates.jsonl`), the in-process runner (`execMilestoneCheck`), the detached front (`runMilestoneCheck`, an in-flight file plus a thin `src/entry/check-bin.ts` launched like the supervisor) and the land-side reader (`machineGate`). The pure failing-line parser is `src/domain/fail-lines.ts`; a fix-round worker's brief gets the tail of the failing check's log through plan 28's fix notes. `land`'s `gate()` in `src/services/lane-service.ts` adds two refusals after the verdict checks: the HEAD match and the machine gate. `src/infra/heavy-lock.ts` gains the load wait and the per-slot temp dir. The verifier reaches the runner as `gate_run` (both MCP servers) and `catherd gate run` (any backend's shell).

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, citty, `@modelcontextprotocol/sdk`. No new dependency (gitleaks is an optional external binary).

**Spec:** `docs/specs/2026-10-12-catherd-1.6-design.md`, "Plan 29: gate evidence". Source behavior: t3herd at 71cbb6a, `src/check.ts` (`runCheck`, `execCheck`, `checkGate`, `baselineFor`, `failLines`, `secretScan`, `heavyRun`), `src/state.ts:92-93` (`headOf`) and `:301-306`, commit ff6cfd2.

**Pre-validation: spiked the logged `sh -c 'exec > "$1" 2>&1; eval "$2"'` runner (exit code and merged output kept), targeted tests only; the full gate runs at execution.** Written against `main` at 2061e6e (1.5.0); plan 28 runs first, so the executor re-finds hunks by context in files plan 28 changed.

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`): `fail-lines.ts` is domain; `heavy-lock.ts` and `launch.ts` are infra; `milestone-check.ts` is a service; `check-bin.ts`, the CLI and the MCP tools are entry.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`. Tests that could reach the network delete `ANTHROPIC_API_KEY`; spawned processes get an explicit `env`. No wall-clock sleep for correctness: the load wait (`heavyLimits`), the caller's wait budget (`checkLimits`) and gitleaks (`checkTools.gitleaks`) are seams the tests set; a test check that must stay running waits on a file the test creates.
- Commits: conventional, subject ≤ 100 characters, lower-case first word after the scope; check `git log` after each commit.
- Binding values from the spec, verbatim:
  - "`land`/`gate` require the verifier's `HEAD:` to equal the commit being landed. A PASS from before a later fix does not count."
  - "The gate runs the milestone check itself and records the exit code and failing lines against HEAD. It reuses a pass on the same HEAD and runs detached, so a tool timeout does not lose it."
  - "Failures the base already has do not block. If a failure has new lines, the gate reruns it once and records the rerun in the audit."
  - "gitleaks over `origin/<base>..HEAD`, with the base fetched first. A hit blocks. Without gitleaks the scan is skipped with an audit note."
  - "Heavy slots wait while the load is above twice the core count, for up to 15 minutes. Each command gets an emptied TMPDIR/GOTMPDIR."
- Numbers: load threshold `2 × availableParallelism()`, load wait 15 min (`heavyLimits.loadWaitMs = 900_000`), load poll 15 s; caller wait budget 10 min (`checkLimits.waitMs = 600_000`); in-flight grace for a worker that has not written its pid 30 s; `checkFailLines` keeps at most 60 lines of at most 300 characters.

## Cross-plan interfaces

- **Consumes from plan 28** (`docs/plans/2026-10-12-28-role-briefs.md`, "Cross-plan interfaces"): `parseReplyHead(reply: string): string | null` in `src/domain/record.ts`, stored by finalize as `RunRecord.head?: string` (lower-cased, 7–64 hex) on every record whose reply has a `HEAD:` line; the verifier contract line `HEAD: <the full sha>`; `MilestoneVerifier.record: RunRecord | null`; and `FixNotes`/`fixNotes(n: FixNotes): string | null` in `src/domain/fix-brief.ts` with `fixBrief(run, i, brief)` in `src/services/fix-brief.ts`, which this plan extends with the check log (Task 7). The native verifier's `head` argument of `record_agent_run` is this plan's (Task 6). Plan 28 also exports a `failLines(reply)` (verifier FAIL lines) from `src/domain/fix-brief.ts`; this plan's check-output parser is therefore named `checkFailLines`.
- **Produces for plan 33:** `checkBase(run: Run): Promise<string | null>` in `src/services/milestone-check.ts` is the one place the base commit is chosen (1.6 at plan 29: `run.meta.startHead`). Plan 33, which gives a run a base branch, makes it fetch `origin/<base>` and return the merge-base; the secret scan and the baseline follow.

## Review Focus

1. **The orchestrator commits after the verifier, as 1.5's skill said.** Expected: `land` refuses with the verifier's HEAD, the commit being landed, and a fix naming a fresh verifier on that commit (carried items stay carried). Pinned in Task 6: "refuses a PASS whose HEAD is not the commit being landed".
2. **A 40-minute full check outlives the verifier's tool call.** Expected: `gate_run` answers `running` after its wait budget; the check goes on and records; the next call waits for that same run and never starts a second. Pinned in Task 4: "answers running past the wait budget, and a later call waits for the same run".
3. **A suite flakes under load.** Expected: the failure has lines the base lacks, so it reruns once; a pass on the rerun lands, with `rerun` in the audit hints. Pinned in Task 3: "reruns a failure with new lines once, recording the first exit" and Task 6: "lands on a check whose failures the base has, with the audit as hints".
4. **The base is already red.** Expected: a failure whose every line the base has lands with an audit line; one new line blocks, naming it; an exit with no readable failing line blocks. Pinned in Task 3: the three `machineGate` failure tests.
5. **A verifier's `catherd lock` inside its scratch TMPDIR.** Expected: the slot's temp dir sits under the role's scratch, so `catherd gate pass` inside the lock is still the verifier's; elsewhere it is under catherd's locks dir. Pinned in Task 1: "keeps a role's scratch as the base of its slot temp dir".

## Rulings

Step 0 (what 1.5 already has, checked against 2061e6e):

1. Ruling: no spec item is fully covered by 1.5; partial cover is used, not redone — `withHeavySlot`/`withHeavySlotWithin` (plan 23) already give slots with a wait budget, and plan 21's per-role scratch is the role's TMPDIR, emptied only by `catherd runs clean`; the gate ledger (`gate_check`/`gate_pass`, content hashes) already carries per-item passes. This plan adds only the load wait, the per-command temp dir, the HEAD rule and the machine check — none.
2. Ruling: no `docs/dev/ideas.md` entry is closed by this plan — none of the five items came from ideas.md — none.

Design:

3. Ruling: the HEAD rule means the orchestrator commits the milestone **before** the verifier, not after (skill steps 9–10 swap) — workers do not commit, and a verdict on an uncommitted tree names a HEAD that is not the landed commit — a run upgraded mid-milestone re-runs its verifier once.
4. Ruling: the HEAD match is a prefix match of the full landed sha (`landed.startsWith(head)`, head 7–40 hex); a PASS with no HEAD is refused like a mismatched one — t3herd's rule — an old native verifier recorded without `head` must be recorded again.
5. Ruling: a native verifier's HEAD comes from a new `record_agent_run` argument `head`; a headless one's is plan 28's `RunRecord.head` — catherd keeps no native reply — a native verifier recorded without `head` cannot land (Ruling 4).
6. Ruling: "the milestone check" is the command the verifier passes to `gate_run(run, milestone, command)`; plan.md's full check stays free text and is not parsed. `land` requires, for the landed commit, at least one non-baseline record of the milestone in this run, and judges the latest record of each command — catherd has no structured milestone check; the architect already writes one per milestone — a verifier that skips `gate_run` cannot land without `skip`.
7. Ruling: `gate_run` reuses the latest record on the same run, milestone, command and HEAD whatever its exit, unless `force: true` — the commit is the same, and a flake was already rerun once inside — a verifier that wants a third run says `force`.
8. Ruling: `gate_run` refuses tracked uncommitted changes (`git status --porcelain --untracked-files=no`), as t3herd does — a record names a commit — untracked files the check reads are not caught.
9. Ruling: the base, for the baseline and the secret scan, is `checkBase(run)` = `run.meta.startHead` (null without one: no baseline, scan skipped with "no base commit to scan from") until plan 33 gives runs a base branch; no fetch is needed for a local commit — the spec's `origin/<base>` presumes plan 33's branch — a single-tree run scans from where it started.
10. Ruling: a baseline is recorded by the verifier calling `gate_run(..., at: <dir>)` on a checkout of the base it prepared (`git worktree add --detach`); catherd refuses an `at` whose HEAD is not `checkBase(run)`, and a failing `gate_run` with no baseline says how — t3herd's `--at`; a fresh worktree needs the repo's own setup, which only an agent can follow — a verifier that skips it blocks on pre-existing failures.
11. Ruling: the audit is returned as `land`'s hints (and in each record: `rerunOf`, `secrets`), not written into the ledger's five columns or the digest — the ledger format is fixed — the audit is in the land result and `checks.jsonl`, not in the digest.
12. Ruling: the caller of `gate_run` waits at most `checkLimits.waitMs` (10 min), then answers `{ running: true }`; the CLI form ticks the dispatch's lock activity while it waits — MCP and shell tool calls time out; the detached worker does not — a verifier must call again.
13. Ruling: the check runs in `checkEnvFor(repo)` (plan 23: login env, allowlist, gate env), under `withRoleLock("verifier", "run:<id>")` and a heavy slot, unless `CATHERD_LOCK_HELD=1` (already inside a lock), which moves from `src/entry/lock-command.ts` to `src/infra/heavy-lock.ts` as `LOCK_HELD_ENV` — a nested slot would deadlock at one slot — none.
14. Ruling: the slot temp dir is `<role scratch>/heavy-<slot>` when the caller's TMPDIR is a role's scratch (`roleScopeOfScratch`), else `<locks>/tmp/slot-<slot>`; it is removed and recreated before the command and removed after — Codex tells a role by its TMPDIR, so the slot dir must stay under it — none.
15. Ruling: the load wait runs inside `withHeavySlotWithin`, before the first slot try, for at most `min(heavyLimits.loadWaitMs, waitMs)`, and then the slot loop runs anyway — t3herd proceeds after 15 min; preflight's 60 s budget must still hold — an overloaded host runs the command late, not never.
16. Ruling: the secret scan is `gitleaks git --no-banner --redact --exit-code 1 --log-opts=<base>..HEAD` in the checked repo; exit 0 `clean`, 1 `found` (blocks), anything else `skipped: gitleaks exited <n>` (audit) — t3herd verbatim — none.
17. Ruling: the check log reaches a fix round as plan 28's `FixNotes.log` (the latest failing non-baseline record of the milestone in the run, its last 40 log lines); it joins notes that something already routed to the lane and never makes notes on its own — plan 28 hands "the tail of the check log" to this plan; routing a log to every lane would brief lanes with nothing to fix — a lane whose failure shows only in the log gets it through the verifier's FAIL lines, not the log.

Owner questions: none.

## Parallelism

Waves: **W1** Tasks 1, 2 · **W2** Task 3 · **W3** Tasks 4, 6, 7 · **W4** Task 5 · **W5** Tasks 8, 9. Tasks 6 and 7 need only Task 3's ledger (`machineGate`, `appendCheckRecord`, `readChecks`).

Files other 1.6 plans touch (re-find hunks by context; later plans rebase on this one): `plugin/skills/catherd/SKILL.md` (28, 30–33), `src/domain/gate-brief.ts` and `src/domain/role-prompts.ts` (28), `src/domain/reply.ts` (28, read only here), `src/services/lane-service.ts` `gate()`/`landRun` (30, 33), `src/services/milestones.ts` (28, 30), `src/domain/fix-brief.ts` and `src/services/fix-brief.ts` (28 creates them), `src/entry/mcp/run-tools.ts` and `src/services/run-store.ts` `AgentRunSchema` (30), `README.md`, `MIGRATION.md`, `test/services/helpers.ts`.

---

### Task 1: heavy slots wait out an overloaded host and empty a temp dir per command

**Files:**
- Modify: `src/infra/heavy-lock.ts:1-58` (imports, `withHeavySlot`, `withHeavySlotWithin`)
- Modify: `src/entry/lock-command.ts:141-142` (`LOCK_HELD_ENV` re-exported from infra), `:197-201` (`run` takes the slot)
- Modify: `src/services/preflight.ts:316-318` (the check gets its slot's temp dir)
- Test: `test/infra/heavy-lock.test.ts`, `test/entry/lock-command.test.ts`

**Interfaces:**
- Produces:
  - `export const LOCK_HELD_ENV = "CATHERD_LOCK_HELD"` (moved; `lock-command.ts` imports and re-exports it)
  - `export const heavyLimits: { loadWaitMs: number; loadPollMs: number; load: () => number; cores: () => number }` = `{ 900_000, 15_000, () => loadavg()[0] ?? 0, () => availableParallelism() }`
  - `export function slotTmpDir(slot: number, inherited?: string): string`
  - `withHeavySlot` / `withHeavySlotWithin`: `fn: (slot: number, tmp: string) => T | Promise<T>`; options gain `tmpBase?: string` (the caller's TMPDIR, for `slotTmpDir`)

- [ ] **Step 1: Write the failing tests** in `test/infra/heavy-lock.test.ts` (restore `heavyLimits` in `afterEach`):

```ts
it("waits while the load is above twice the cores, then runs", async () => {
  let reads = 0;
  Object.assign(heavyLimits, { cores: () => 4, load: () => (reads++ < 2 ? 9 : 1), loadPollMs: 1 });
  let waits = 0;
  expect(await withHeavySlot(1, () => "ran", { pollMs: 1, onWait: () => waits++ })).toBe("ran");
  expect(reads).toBeGreaterThanOrEqual(3);
  expect(waits).toBeGreaterThanOrEqual(2);
});
it("runs anyway once the load wait is spent", async () => {
  Object.assign(heavyLimits, { cores: () => 1, load: () => 99, loadPollMs: 1, loadWaitMs: 5 });
  expect(await withHeavySlot(1, () => "ran", { pollMs: 1 })).toBe("ran");
});
it("gives each command an emptied temp dir and removes it after", async () => {
  const first = await withHeavySlot(1, (_s, tmp) => (writeFileSync(join(tmp, "x"), "1"), tmp));
  expect(existsSync(first)).toBe(false);
  expect(await withHeavySlot(1, (_s, tmp) => readdirSync(tmp))).toEqual([]);
});
it("keeps a role's scratch as the base of its slot temp dir", () => {
  const scratch = "/d/runs/20261012-101010-r/scratch/verifier-M1";
  expect(slotTmpDir(0, scratch)).toBe(`${scratch}/heavy-0`);
  expect(roleScopeOfScratch(slotTmpDir(0, scratch))).toEqual({ run: "20261012-101010-r", name: "verifier-M1" });
  expect(slotTmpDir(1, "/tmp")).toBe(join(locksDir(), "tmp", "slot-1"));
});
```

In `test/entry/lock-command.test.ts`, the way that file already spawns `catherd lock`: "gives the command its slot's TMPDIR and GOTMPDIR" — run `catherd lock --slots 1 -- sh -c 'echo "$TMPDIR $GOTMPDIR"'` and expect both words equal and ending in `slot-0`.

- [ ] **Step 2: Run them** — `bun test test/infra/heavy-lock.test.ts test/entry/lock-command.test.ts`. Expected: FAIL (`heavyLimits`/`slotTmpDir` not exported; no TMPDIR set).
- [ ] **Step 3: Implement.** Load wait: before the slot loop, while `heavyLimits.load() > 2 * heavyLimits.cores()` and the load deadline (`min(loadWaitMs, waitMs)` from start) is ahead, call `onWait` and sleep `min(loadPollMs, left)`. Around `fn(i, tmp)`: `tmp = slotTmpDir(i, o.tmpBase)`, `rmSync(tmp, { recursive: true, force: true })`, `ensurePrivateDir(tmp)`, and `rmSync` again in the `finally` before `release()`. `lock-command.ts` passes `tmpBase: process.env.TMPDIR` and `extraEnv: { [LOCK_HELD_ENV]: "1", TMPDIR: tmp, GOTMPDIR: tmp }`; `preflight.ts` passes `{ ...checkEnvironment, TMPDIR: tmp, GOTMPDIR: tmp }` to `runCheck`.
- [ ] **Step 4: Run them** — same command. Expected: PASS; also `bun test test/services/preflight.test.ts`.
- [ ] **Step 5: Commit** — `git commit -m "feat(lock): heavy slots wait out an overloaded host and give each command an emptied temp dir"`

### Task 2: failing lines that compare across runs

**Files:**
- Create: `src/domain/fail-lines.ts`
- Test: `test/domain/fail-lines.test.ts`

**Interfaces:**
- Produces: `checkFailLines(out: string): string[]`; `newFails(fails: string[], base: string[] | null): string[]` (the lines of `fails` not in `base`; all of them when `base` is null)

- [ ] **Step 1: Write the failing tests:**

```ts
it("strips colour, timings and counters, so two runs compare equal", () => {
  const a = checkFailLines("\x1b[31mFAIL\x1b[0m src/a.test.ts > adds [12.3ms]\nok 1 fine\n");
  expect(a).toEqual(checkFailLines("FAIL src/a.test.ts > adds (40 ms)\n"));
  expect(a).toEqual(["FAIL src/a.test.ts > adds"]);
});
it("keeps a vulnerability by its id, and the usual failure markers", () => {
  expect(checkFailLines("Vulnerability #1: GO-2026-0042\n--- FAIL: TestX\nnot ok 3 y\npanic: boom\nerror: z\n(fail) w\n"))
    .toEqual(["vulnerability GO-2026-0042", "--- FAIL: TestX", "not ok 3 y", "panic: boom", "error: z", "(fail) w"]);
});
it("keeps at most 60 lines of at most 300 characters", () => {
  const out = Array.from({ length: 80 }, (_, i) => `FAIL t${i} ${"x".repeat(400)}`).join("\n");
  expect(checkFailLines(out)).toHaveLength(60);
  expect(checkFailLines(out)[0]).toHaveLength(300);
});
it("names the lines the base does not have", () => {
  expect(newFails(["FAIL a", "FAIL b"], ["FAIL a"])).toEqual(["FAIL b"]);
  expect(newFails(["FAIL a"], null)).toEqual(["FAIL a"]);
});
```

- [ ] **Step 2: Run** `bun test test/domain/fail-lines.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** by porting t3herd `src/check.ts:50-68` (`failLines`, renamed `checkFailLines`, its ANSI regex built with `String.fromCharCode(27)`) and the one-line `newFails`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(gate): failing lines that compare across runs"`

### Task 3: the milestone check ledger, its runner and the machine gate

**Files:**
- Create: `src/services/milestone-check.ts`
- Test: `test/services/milestone-check.test.ts`

**Interfaces:**
- Consumes: `checkFailLines`, `newFails` (Task 2); `withHeavySlot`, `heavySlots`, `withRoleLock`, `LOCK_HELD_ENV` (Task 1); `checkEnvFor` (`src/services/preflight.ts:226`); `readProfileDoc`, `activeName` (`src/services/profile-store.ts`); `repoDir` (`src/infra/paths.ts`); `appendJsonl`, `ensureJsonlHeader`, `readJsonl` (`src/infra/store.ts`).
- Produces:

```ts
export const CheckRecordSchema = z.looseObject({
  at: z.string(), run: z.string(), milestone: z.string(), command: z.string(),
  head: z.string(),            // full sha the check ran on
  exit: z.number(), durationMs: z.number(),
  fails: z.array(z.string()), log: z.string(),
  baseline: z.literal(true).optional(),
  rerunOf: z.number().optional(),  // the first run's exit, when a failure with new lines was rerun once
  secrets: z.string().optional(),  // "clean" | "found" | "skipped: <why>"; non-baseline records only
});
export type CheckRecord = z.infer<typeof CheckRecordSchema>;
export const checksFile = (toplevel: string): string;   // join(repoDir(toplevel), "checks.jsonl")
export const checkLogDir = (toplevel: string): string;  // join(repoDir(toplevel), "checks")
export function readChecks(toplevel: string): CheckRecord[];
export function appendCheckRecord(toplevel: string, rec: CheckRecord): void;  // header "checks"
export async function checkBase(run: Run): Promise<string | null>;            // run.meta.startHead ?? null
export function baselineFor(toplevel: string, command: string, base: string | null): CheckRecord | null;
export const checkTools: { gitleaks: () => string | null };                   // () => Bun.which("gitleaks")
export async function secretScan(cwd: string, base: string | null): Promise<string>;
export interface CheckJob { run: string; repo: string; cwd: string; milestone: string; command: string; head: string; base: string | null; baseline: boolean }
export async function execMilestoneCheck(job: CheckJob): Promise<CheckRecord>;
export async function machineGate(run: Run, m: string, head: string): Promise<{ missing: string[]; audit: string[] }>;
```

- [ ] **Step 1: Write the failing tests** (`freshRun()`/`createRun({ …, startHead })`, `withHome`, `tempRepo` from the existing helpers; a `job(over)` builder; `checkTools.gitleaks` restored in `afterEach`):

```ts
it("records the exit code and failing lines against HEAD, with its log", async () => {
  const r = await execMilestoneCheck(job({ command: "printf 'FAIL a.test > x [3ms]\\n'; exit 1" }));
  expect(r).toMatchObject({ exit: 1, fails: ["FAIL a.test > x"], head: HEAD, rerunOf: 1 });
  expect(readFileSync(r.log, "utf8")).toContain("FAIL a.test > x");
  expect(readChecks(repo).at(-1)).toEqual(r);
});
it("reruns a failure with new lines once, recording the first exit", async () => {
  const flag = join(tempDir("c-"), "once");
  const r = await execMilestoneCheck(job({ command: `test -f ${flag} || { touch ${flag}; echo 'FAIL flaky'; exit 1; }` }));
  expect(r).toMatchObject({ exit: 0, rerunOf: 1, fails: [] });
});
it("does not rerun a failure the base already has", async () => {
  appendCheckRecord(repo, { ...rec, baseline: true, head: BASE, fails: ["FAIL a.test > x"], exit: 1 });
  const r = await execMilestoneCheck(job({ command: "echo 'FAIL a.test > x'; exit 1", base: BASE }));
  expect(r.rerunOf).toBeUndefined();
});
it("scans base..HEAD with gitleaks: a hit is found, a clean scan clean, no gitleaks skipped", async () => {
  // fake gitleaks: writes "$@" to ARGS, exits $CODE
  expect(await secretScan(repo, BASE)).toBe("found");          // CODE=1
  expect(readFileSync(ARGS, "utf8")).toContain(`--log-opts=${BASE}..HEAD`);
  expect(await secretScan(repo, BASE)).toBe("clean");          // CODE=0
  expect(await secretScan(repo, BASE)).toBe("skipped: gitleaks exited 2");
  checkTools.gitleaks = () => null;
  expect(await secretScan(repo, BASE)).toBe("skipped: gitleaks is not installed");
  expect(await secretScan(repo, null)).toBe("skipped: no base commit to scan from");
});
describe("machineGate", () => {
  it("refuses a milestone with no check on the commit, naming gate_run", …  missing[0] contains `gate_run(run, "M1"`);
  it("passes an exit 0 with a clean scan", …  { missing: [], audit: [] });
  it("lets a failure through whose every line the base has, with an audit line", …  audit[0] contains "pre-existing");
  it("refuses failing lines the base does not have, naming them", …  missing[0] contains "FAIL new");
  it("refuses a failure with no line it can compare", …  missing[0] contains "no failing line");
  it("refuses a secret hit, and notes a skipped scan and a rerun in the audit", …);
  it("judges the latest record of each command, and only this milestone's on this commit", …);
});
```

- [ ] **Step 2: Run** `bun test test/services/milestone-check.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
  - The runner: one run is `Bun.spawn(["sh", "-c", 'exec > "$1" 2>&1; eval "$2"', "sh", log, job.command], { cwd: job.cwd, env: { ...(await checkEnvFor(job.repo)), TMPDIR: tmp, GOTMPDIR: tmp }, stdin: "ignore", detached: true })`, `exit = exitCode ?? 1`; log `<checkLogDir>/<milestone>-<head12>[-base]-<Date.now()>.log`. It runs inside `withRoleLock("verifier", \`run:${job.run}\`, () => withHeavySlot(slots, …))`, slots from `heavySlots(readProfileDoc(activeName(job.repo)).lock?.heavy ?? "cpus/2")` (any throw: `"cpus/2"`); with `process.env[LOCK_HELD_ENV] === "1"` it runs at once with the inherited TMPDIR.
  - Rerun and record: port t3herd `execCheck` (`src/check.ts:263-308`); `secrets: await secretScan(job.cwd, job.base)` on non-baseline records only.
  - `baselineFor`: baseline records with this command; the one whose `head === base`, else the newest.
  - `machineGate`: port t3herd `checkGate` (`src/check.ts:314-352`) over this run's non-baseline records of `m` on `head`, the latest per command; none is `no machine check of ${m} on ${head.slice(0, 12)}: the verifier runs its full check with gate_run(run, "${m}", <command>) on the committed HEAD`; the secret-hit line is `gitleaks found secrets in ${base12}..${head12}; see ${rec.log}`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(gate): catherd runs the milestone check and judges it against the base"`

### Task 4: the check runs detached and is reused on the same HEAD

**Files:**
- Modify: `src/services/milestone-check.ts`
- Modify: `src/infra/launch.ts` (a second entry beside `SUPERVISE_ENTRY`)
- Create: `src/entry/check-bin.ts` (mirrors `src/entry/supervise-bin.ts`)
- Modify: `test/pack-smoke.ts:24` (list `src/entry/check-bin.ts`), `test/infra/launch.test.ts:81` (its path)
- Test: `test/services/milestone-check-run.test.ts`

**Interfaces:**
- Consumes: Task 3's `execMilestoneCheck`, `readChecks`, `checkBase`, `baselineFor`, `machineGate`; `isAlive`, `processStartTime` (`src/infra/proc.ts`); `findRun` (`src/services/run-store.ts`); `gitHead`, `git` (`src/infra/git.ts`).
- Produces:

```ts
export const CHECK_ENTRY: string;                                   // infra/launch.ts
export function launchCheckWorker(flight: string): number;          // pid; stdout/stderr to <dir>/worker.log
export const checkLimits = { waitMs: 600_000, pollMs: 1_000, graceMs: 30_000 };
export type GateRunResult =
  | { running: true; log: string | null; hint: string }
  | { running: false; cached: boolean; record: CheckRecord; missing: string[]; audit: string[]; hints?: string[] };
export async function runMilestoneCheck(
  i: { run: string; milestone: string; command: string; at?: string; force?: boolean },
  o?: { onWait?: () => void },
): Promise<GateRunResult>;
export async function checkWorker(flight: string): Promise<void>;   // execMilestoneCheck, then removes the flight file
```

- [ ] **Step 1: Write the failing tests** (`withHome`, a run made with `createRun({ …, startHead })`; restore `checkLimits`):

```ts
it("runs the check in a detached worker and returns its record", async () => {
  const r = await runMilestoneCheck({ run: run.id, milestone: "M1", command: "echo ok" });
  expect(r).toMatchObject({ running: false, cached: false, record: { exit: 0, head: HEAD }, missing: [] });
});
it("reuses the record on the same HEAD, and runs again when forced", async () => {
  await runMilestoneCheck(i);
  expect(await runMilestoneCheck(i)).toMatchObject({ cached: true });
  expect(await runMilestoneCheck({ ...i, force: true })).toMatchObject({ cached: false });
  expect(readChecks(repo)).toHaveLength(2);
});
it("refuses tracked uncommitted changes: a record names a commit", async () => {
  writeFileSync(join(repo, "tracked.txt"), "edit");
  const e = await refusal(runMilestoneCheck(i));
  expect(e.code).toBe("E_INPUT_INVALID");
  expect(e.fix).toContain("commit the milestone first");
});
it("answers running past the wait budget, and a later call waits for the same run", async () => {
  const go = join(tempDir("go-"), "go");
  const cmd = `while [ ! -f ${go} ]; do sleep 0.05; done; echo done`;
  checkLimits.waitMs = 50;
  expect(await runMilestoneCheck({ ...i, command: cmd })).toMatchObject({ running: true });
  writeFileSync(go, "");
  checkLimits.waitMs = 60_000;
  expect(await runMilestoneCheck({ ...i, command: cmd })).toMatchObject({ running: false, record: { exit: 0 } });
  expect(readChecks(repo).filter((r) => r.command === cmd)).toHaveLength(1);
});
it("records a baseline from a checkout of the base, and refuses a checkout of another commit", …
  // git worktree add --detach <dir> <startHead>; { at: dir } → record.baseline true, head startHead;
  // a worktree at HEAD → E_INPUT_INVALID naming the base
);
it("says how to record a baseline when a failing check has none", …  hints[0] contains "git worktree add --detach");
```

- [ ] **Step 2: Run** `bun test test/services/milestone-check-run.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `runMilestoneCheck`: resolve `cwd` (`at`, else the run's repo), refuse a dirty tree (no `at`) or an `at` whose HEAD is not `checkBase(run)`; reuse per Ruling 7; else write `<checkLogDir>/inflight-<sha1 of [run, milestone, command, head, baseline]>.json` (`{ schema: 1, pid: -1, startTime: null, at, job }`, flag `"wx"`), `launchCheckWorker`, rewrite it with the pid and `processStartTime(pid)`; on `EEXIST` a live (or < `graceMs` old pid −1) flight is someone's run of this very check: wait for it; a stale one is removed and retried (≤ 3 tries). Wait while the flight file exists and its worker lives, calling `o.onWait` each `pollMs`; past `waitMs` answer `running` with the log dir and `hint: "the check is still running; call gate_run again with the same arguments to wait for it"`. Then the newest matching record written since the start, or `E_IO_UNEXPECTED` "the check worker stopped without a record". `missing`/`audit` from `machineGate` (empty for a baseline); the baseline hint per Ruling 10 when the record failed and `baselineFor` has none at the base. `check-bin.ts` calls `checkWorker(argv[2])` and exits 0.
- [ ] **Step 4: Run** `bun test test/services/milestone-check-run.test.ts test/infra/launch.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(gate): the milestone check runs detached, so a tool timeout does not lose it"`

### Task 5: `gate_run` and `catherd gate run`

**Files:**
- Modify: `src/entry/mcp/protocol-tools.ts:34-42` (register `gate_run` after `gate_pass`)
- Modify: `src/entry/mcp/role-server.ts:73-105` (same, run-bound)
- Modify: `src/entry/mcp/server.ts:49` (`RUN_BOUND_TOOLS` gets `gate_run`)
- Modify: `src/domain/role-tools.ts` (`roleMcpTools`: verifier gets `"gate_run"`)
- Modify: `src/domain/brief.ts:19-35` (`cliForm` case `gate_run`)
- Modify: `src/entry/role-cli-command.ts:112-115` (a `run` subcommand)
- Test: `test/entry/role-mcp.test.ts:44`, `test/services/role-server-harness.test.ts:50,67`, `test/entry/mcp.test.ts:40`, `test/entry/role-cli-command.test.ts`, `test/domain/role-scope.test.ts:78`

**Interfaces:**
- Consumes: `runMilestoneCheck` (Task 4); `activityReporter`, `DISPATCH_ID_ENV` (`src/infra/lock-activity.ts`).
- Produces: MCP tool `gate_run` with `inputSchema: { run, milestone: z.string().regex(ID_PATTERN), command: z.string().min(1), at: z.string().min(1).optional(), force: z.boolean().optional() }`; CLI `catherd gate run <run> --milestone <M> --command <c> [--at <dir>] [--force]`, printing the result as JSON and exiting 1 when `missing` is non-empty; `cliForm("gate_run", run)` = `` `catherd gate run ${run} --milestone <M> --command <command> [--at <base checkout>]` ``.

- [ ] **Step 1: Update the tool-list tests** to expect `gate_run` after `gate_pass` (verifier's list, the Codex `enabled_tools` line, `--allowedTools` containing `mcp__catherd_role__gate_run`, the full server's list, and `gate_run` not refused for a role on its own run), and add to `test/entry/role-cli-command.test.ts`, mirroring its `gate pass` refusal test: "refuses gate run to a worker's scope with E_ROLE_SCOPE".
- [ ] **Step 2: Run** `bun test test/entry/role-mcp.test.ts test/services/role-server-harness.test.ts test/entry/mcp.test.ts test/entry/role-cli-command.test.ts test/domain/role-scope.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The MCP description: "The verifier's full check of a milestone, run by catherd on the committed HEAD in a detached worker under the verifier lock and a heavy slot: { running: false, record (exit, failing lines, log, secrets, rerunOf), missing, audit } once done; land reads that record. The same run, milestone, command and HEAD answers the recorded result (force: true runs it again). Refused while tracked files are uncommitted. Past 10 minutes it answers { running: true }: call it again to wait for the same run. at: a checkout of the run's base you prepared, to record the base's own failures, which then do not block." The CLI passes `{ onWait: reporter.tick }` when `activityReporter(process.env[DISPATCH_ID_ENV])` is non-null and calls `reporter.done()` after.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(gate): the verifier runs the milestone check through gate_run and catherd gate run"`

### Task 6: `land` lands only the commit the evidence is about

**Files:**
- Modify: `src/services/run-store.ts:284-301` (`AgentRunSchema.head`)
- Modify: `src/services/run-service.ts:276-318` (`recordAgentRun` takes `head`)
- Modify: `src/entry/mcp/run-tools.ts:103-140` (`record_agent_run`'s `head`, description)
- Modify: `src/services/milestones.ts:179-239` (`MilestoneVerifier.head`)
- Modify: `src/services/lane-service.ts:342-436` (`gate()` returns the audit), `:511` and `:565` (`landRun` adds it to `hints`)
- Modify: `test/services/helpers.ts:317-346` (`passGate`)
- Test: `test/services/land-gate.test.ts`; then the files that call `passGate` or hand-write a verifier row: `test/services/{protocol,questions,outcomes,ledger,lanes-run,workspace-land}.test.ts`, `test/integration/mcp-stdio.test.ts`

**Interfaces:**
- Consumes: `RunRecord.head` (plan 28); `machineGate`, `appendCheckRecord` (Task 3); `fullCommit` (`src/services/milestones.ts:301`).
- Produces: `AgentRun.head?: string` (lower-case 7–40 hex); `recordAgentRun(deps, { …, head?: string })`, refusing a non-hex head with `E_INPUT_INVALID`; `record_agent_run` `head: z.string().regex(/^[0-9a-fA-F]{7,40}$/).optional()`; `MilestoneVerifier.head: string | null`; `passGate(run: Run, m: string, at?: string, head?: string): Promise<void>` (head defaults to the repo's HEAD; also appends a passing check record of `m` on it, command `"true"`, `secrets: "clean"`).

- [ ] **Step 1: Write the failing tests** in `test/services/land-gate.test.ts` (its `commitFiles`, `refusal`, `landing` helpers, plus a local `full(c)` = `git rev-parse c`):

```ts
it("refuses a PASS whose HEAD is not the commit being landed", async () => {
  const c1 = commitFiles(repo, ["src/a.ts"]);
  await passGate(run, "M1", undefined, full(c1));
  const c2 = commitFiles(repo, ["src/b.ts"]);
  const e = await refusal(land(fakeDeps(), landing(run.id, c2)));
  expect(e.message).toBe(`land M1: verifier-M1 checked ${full(c1).slice(0, 12)}, and the commit being landed is ${full(c2).slice(0, 12)}: a PASS from before a later commit does not count`);
  expect(e.fix).toContain(`a fresh verifier-M1 on ${c2.slice(0, 7)}`);
});
it("refuses a PASS that names no HEAD", …  message contains "names no HEAD"; fix contains "head:");
it("reads a headless verifier's HEAD from its record", …  a verifier-M1 record with head: <sha> and reply "VERDICT: PASS…" lands);
it("refuses without a machine check on the landed commit", …  message contains "gate_run(run, \"M1\"");
it("lands on a check whose failures the base has, with the audit as hints", …
  // a baseline record at startHead with fails ["FAIL x"], a record on HEAD exit 1 fails ["FAIL x"]
  // → ledger written; hints contain "pre-existing"
);
it("refuses a secret hit on the landed commit", …  message contains "gitleaks found secrets");
it("still lands a docs-only skip with neither", …);
```

- [ ] **Step 2: Run** `bun test test/services/land-gate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `gate()`, after the `missing` refusal: `landed = await fullCommit(run, commit)`; no `verdict.head` → `` `land ${m}: ${verdict.name}'s PASS names no HEAD, so it cannot be told to cover ${landed.slice(0, 12)}` `` (fix: a headless verifier's reply ends with `HEAD: <sha>`; a native one is recorded with `record_agent_run(…, head: <sha>)`; run a fresh verifier on the committed milestone); a mismatch → the message in the test, fix `` `run a fresh verifier-${m} on ${landed.slice(0, 7)}: what passed is carried over by gate_check` ``; then `machineGate(run, m, landed)`: missing → `` `land ${m}: the machine gate on ${landed.slice(0, 12)}: ${missing.join("; ")}` ``, fix `` `run the full check with gate_run(run, "${m}", <command>) on ${landed.slice(0, 7)}; fix what fails, commit, and verify again` ``; return `audit`. A `skip` returns `[]` as now. `milestoneVerifier`: native `head: a.head ?? null`; headless `head: r.head ?? null`.
- [ ] **Step 4: Run** `bun test test/services/land-gate.test.ts`. Expected: PASS.
- [ ] **Step 5: Repair the callers.** Run `bun test test/services/protocol.test.ts test/services/questions.test.ts test/services/outcomes.test.ts test/services/ledger.test.ts test/services/lanes-run.test.ts test/services/workspace-land.test.ts test/integration/mcp-stdio.test.ts test/services/land-gate.test.ts`; for each failure, call `passGate` after the commit it lands, or pass that commit as `head`, or add `head` and a check record to a hand-written verifier row. Never loosen a gate assertion. Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(land): a verdict covers the commit it lands, with catherd's own check on it"`

### Task 7: a fix round sees the end of the failing check's log

**Files:**
- Modify: `src/domain/fix-brief.ts` (plan 28's `FixNotes`, `fixNotes`)
- Modify: `src/services/fix-brief.ts` (plan 28's `fixBrief`)
- Test: `test/domain/fix-brief.test.ts`, `test/services/fix-brief.test.ts`

**Interfaces:**
- Consumes: `readChecks`, `CheckRecord` (Task 3); plan 28's `FixNotes`, `fixNotes`, `fixBrief`.
- Produces: `FixNotes.log: { command: string; exit: number; head: string; tail: string } | null`; `CHECK_LOG_TAIL_LINES = 40` in `src/domain/fix-brief.ts`.

- [ ] **Step 1: Write the failing tests.** Domain, `it("adds the failing check's log tail to notes that route to the lane, never on its own")`: with a routed finding and `log: { command: "bun test", exit: 1, head: "0123456789abcdef", tail: "FAIL a\nboom" }` the notes contain ``The milestone check `bun test` exited 1 on 0123456789ab; the end of its log:`` followed by the tail in a fenced block; with no finding or FAIL line routed and the same `log`, `fixNotes` is null. Service, `it("gives a fix-round worker the tail of the milestone's latest failing check")`: the plan 28 fix-round setup plus `appendCheckRecord(repo, …)` of `M1` with exit 1 and a log file of 50 lines `l1`…`l50`: the brief contains `l50` and `l11` and not `l10`; a later exit-0 record of `M1` removes the paragraph.
- [ ] **Step 2: Run** `bun test test/domain/fix-brief.test.ts test/services/fix-brief.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `fixBrief` sets `log` from this run's latest non-baseline `M` record when its exit is not 0 (an unreadable log file: `tail: "(log unreadable: <path>)"`), else null; `fixNotes` appends the paragraph only when it returns notes anyway.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(fix): a fix round sees the end of the failing check's log"`

### Task 8: the verifier's rules, the skill and the docs

**Files:**
- Modify: `src/domain/gate-brief.ts:9-14` (`VERIFIER_GATE_RULES`: a second rule)
- Modify: `plugin/skills/catherd/SKILL.md` (tool table near `:55-58`, the `E_LAND_GATE` line near `:80`, steps 9–10 near `:304-315`)
- Modify: `src/entry/mcp/lane-tools.ts:117` (`land`'s description)
- Modify: `README.md:182`, `:215` (roles' `gate check|pass|run`; the CLI table row)
- Modify: `MIGRATION.md` (a "From 1.5 to 1.6" section at the top if plan 28 has not added it; else append to it)
- Test: `test/services/verifier-brief.test.ts`, `test/skills.test.ts:47`

- [ ] **Step 1: Write the failing tests:** in `test/services/verifier-brief.test.ts`, "tells every verifier to run the full check through gate_run on the committed HEAD": `expect(VERIFIER_GATE_RULES.join("\n")).toContain("gate_run")` and `.toContain("committed HEAD")`; in `test/skills.test.ts` add `"gate_run"` to the core tools the skill must call.
- [ ] **Step 2: Run** `bun test test/services/verifier-brief.test.ts test/skills.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the text.**
  - Rule (after the root-gate rule): "Run the milestone's full check with gate_run (or catherd gate run), on the committed HEAD, never by hand: catherd runs it detached under the verifier lock, reruns a failure with new lines once, scans the run's commits for secrets and records the result, and land reads that record. If it answers running, call it again. When it fails and no baseline exists, it says how to record the base's own failures from a checkout of the base."
  - SKILL.md: step 9 starts "Commit the milestone path-scoped first (workers do not commit): the verifier checks that commit, and its reply's `HEAD:` must be the commit you land"; the native verifier is recorded with `head:`; the full check goes through `gate_run`. Step 10: "`land` that commit"; `land` refuses a PASS whose HEAD is another commit (a fresh verifier re-checks; carried items stay carried), and a commit with no `gate_run` record, a secret hit or failing lines the base lacks; the audit comes back as hints. Tool table: a `gate_run(run, milestone, command, at?, force?)` row; `record_agent_run` gains `head?`.
  - `land` description: add "and, for the commit being landed, the verifier's HEAD and a passing gate_run check of the milestone (failures the base has are let through; the audit returns as hints)".
  - MIGRATION.md: commit before the verifier; `land` needs the verifier's HEAD and a `gate_run` record; install gitleaks for the secret scan; heavy commands get their slot's `TMPDIR`.
- [ ] **Step 4: Run** the Step 2 command, then `bun run format:check`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "docs(gate): the verifier runs gate_run on the committed milestone, and land reads it"`

### Task 9: changeset

**Files:**
- Create: `.changeset/gate-evidence.md`

- [ ] **Step 1: Write it:**

```md
---
"catherd-cli": minor
---

Gate evidence: `land` lands only the commit the verifier's `HEAD:` names, and only with catherd's own run of the milestone's full check on it (`gate_run`, `catherd gate run`): detached, reused on the same HEAD, a failure with new lines rerun once, failures the base already has let through with an audit, and a gitleaks scan of the run's commits (skipped with a note when gitleaks is missing). Commit the milestone before its verifier. Heavy commands wait while the load is above twice the cores (up to 15 minutes) and get an emptied TMPDIR/GOTMPDIR per slot.
```

- [ ] **Step 2: Run** `bun run format:check`. Expected: PASS.
- [ ] **Step 3: Commit** — `git commit -m "chore(changeset): gate evidence"`
