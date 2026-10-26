# Plan 44 — the decision model and role briefs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Never read the whole plan: take your task brief.

Setup: bun install --frozen-lockfile

**Goal:** every role gets a short, four-part brief that holds only its own duties, the harness enforces what the briefs used to plead for, and a decision model picks the rung of every dispatch of every role in every round from the exact brief that role receives.

**Architecture:** Part B first: briefs are composed by the daemon in four parts (role contract, run facts, unit context, this round), capped, backend-neutral and written once. Then the harness checks (verifier commands, failure class, test guard, clean role env). Then Part A: a `decide` step in the run machine before every `dispatch` and `judge`, whose effect renders the brief, asks the decision model on N levels (N = the role's rung levels above the floor) and appends `decision.made`; the dispatch sends that same file. Climb, the bars, the objective, the learned start, the cheap try and the start-rung rules go. Last, a per-role scorecard in the run report.

**Tech stack:** Bun ≥ 1.4, TypeScript, zod, the panel (`web/`, Vite + React).

**Spec:** `docs/specs/2026-10-26-decision-model-design.md` (binding: O1–O8, A1–A3, R1–R10, goals 1–16, the plan order, the probe results). Evidence: `docs/research/2026-10-26-role-briefs.md` and `docs/research/2026-10-26-role-briefs/`.

Source: the spec, owner-approved 2026-10-26, and its probe of `perplexity/pplx-decider-v1.2-20261016`. Plan order as the spec sets it: B8–B11 (M1), B12–B15 (M2), Part A (M3–M5), B16 (M6).

## Global Constraints

- catherd is a public repository (github.com/47vigen/catherd). No code default, test, fixture or doc names a personal host of the owner (a gateway, a server, a home path). The decision model's `url` and `model` have no built-in default; docs show `https://<your-gateway>/v1`. The one named endpoint is TypeSafe's public `https://api.typesafe.ai/v1`, and only as a migrated 1.5 profile's value (D24).
- Tests never reach the network: every decision call in a test goes through a fake `fetchImpl` or the fake routing port in test/services/helpers.ts. Tests that could reach the network delete `ANTHROPIC_API_KEY` and `CATHERD_DECISION_KEY` (in-process) or pass them as `""` (spawned).
- No real run brief, reply or plan text is committed. Brief fixtures are synthetic (test/fixtures/briefs/, test/fixtures/decision/).
- ProfileService (src/services/profile-service.ts) is the only writer of profiles; credentials.json is written only by src/services/credentials.ts. Old profiles (with `jev`, `bars`, `roles.*.bars`, `objective`) and old credentials (`typesafeApiKey`) load at every step of this plan.
- Old runs replay: every event type in today's schema stays parseable (`lane.climbed`, a `climb` `effect.failed`, `lanes.routed` with rungs).
- Layers `domain → infra → adapters → services → entry` (test/architecture.test.ts). New files: src/domain/decision.ts, src/domain/ran-lines.ts, src/domain/test-guard.ts, src/domain/harness.ts, src/infra/decision-client.ts, src/services/decision-service.ts, src/services/brief-cap.ts, src/services/run-scorecard.ts.
- Every lane leaves the root typecheck green: a signature change updates its callers in the same lane, or the change is split additive-first (M3, M4) and deleting-last (M5).
- A lane that changes what `bun run panel:openapi` writes (a schema in src/entry/panel/openapi.ts's reach: `PARK_REASONS`, `ProfilePatchSchema`, `RunNodeSchema`, the panel Settings) regenerates web/openapi.json and, with `cd web && bun run gen`, web/src/client/types.gen.ts, and owns both.
- Copy: English, plain words; "decision model", never "Jev", in every new or touched user-facing string from M5 on.
- Commits: conventional, subject ≤ 100 characters, lower-case first word. The full root suite takes about 180 s: `catherd lock -- bun test`.

## Review Focus

1. A daemon restart between `decision.made` and `dispatch.started`: the dispatch goes out on the recorded decision and the decision model is not asked again (M4 Task 15 and Task 16 tests).
2. A replan between a lane's decision and its dispatch (the architect edits the lane file): the decision is dropped and made again on the new brief, never sent stale (Task 15, "a replan drops a lane's unsent decision").
3. A 1.5 profile with `jev.use`, `bars`, `objective`, and `typesafeApiKey` in credentials.json: it loads, migrates once under the profiles lock, names TypeSafe's URL, and `profile set` and the panel save never fail on the old fields (Task 13).
4. The decision model down mid-run: three calls a minute apart, then one park per unit; a coordinator answer of a rung below the floor or off the role's list is refused and asked again (Task 15, Task 16).
5. A run that started before this plan (lanes with `climbReason`, a `lane.climbed` event, a `climb` `effect.failed`): it replays and its next dispatch is decided (Task 15, "an old run with climb events replays and decides").

## What already exists

- src/domain/run-machine.ts — `Action` (34–69: `dispatch` with `rung`, `cheap?`, `brief`, `notes`; `climb`; `judge { input }`), `ACTIONS_MATCH_EVENTS` (73), `actionKey` (76), `unitOf` (117), `confirms` (154), `roleDispatch` (226, rung null, a limit's `failoverFrom`), `laneActions` (332: `climbReason` → `climb`, else `dispatch` with `l.rung`, `cheap` from `l.cheapFirst`), `onLaneStopped` (394, the judge), `judgeRetries` (413), `fixActions` (419), `reviewActions` (440), `milestoneActions` (462), `architectAgain`, `planningActions`, `rulesReviewActions` (593), `PAUSED_STEPS` (709), `next` (727).
- src/domain/run-state.ts — `TOP_RUNG_JUDGES` (32), `MAX_TRIES` (36), `LaneState` (82: `rung`, `top`, `attempts`, `climbReason`, `tooHard`, `climbedAt`, `cheapFirst`, `cheapRan`, `cheapSpent`, `sameReason`), `RunState` (263), `emptyState` (308), `limitedRung` (403), `mergePlan` (436, `??=` defaults for old states), `laneDone` (601), `completeRound` (634), `ownersOf` (691), `fixRound` (704: `same-defect`, `cheapFirst = mechanicalFix`), `failRole` (753), `unexplained` (780), `laneStopped` (826: `too_hard` → `climbReason = "blocked"`), `siblingMayChange` (892, reads `climbedAt`), `laneEnded` (919: `attempts >= MAX_TRIES` → `climbReason = "unchanged"`), `onEnded` (1022), `onClimbed` (1143, top → judge `unexpected`, `TOP_RUNG_JUDGES` → owner), `onJudged` (1183, verb `climb` → `climbReason = "blocked"`), `onAnswered` (1283), `apply` cases `lanes.routed` (1388), `dispatch.started` (1417), `dispatch.refused` (1449), `check.ran` (1491: `check-failed-twice`, cheap try), `stop.classified` (1844), `effect.failed` `classify` (1788).
- src/domain/run-events.ts — `PARK_REASONS` (13), `ACTION_TYPES` (42, has `climb`), `RunEventSchema` (112), `describeEvent` (295).
- src/services/run-effects.ts — `endedEvent` (145: verifier verdict and findings), `rungFor` (380: `cheap` → `cheapestRung`, a lane's route, the judge's `rungs[0]`, `routeLanes` for a role), `settle` (422), `rerouteLane` (478, plan 43 D10), `start` (500: admission, `E_ADMIT_RUNG` reroute), `route` (654: `routeLanes` per role, `lanes.routed`, `preflight`), `classify` (853: `deps.routing.stopCause(…, jev.use)`), `perform` (1200: `dispatch` → `start(a, briefFor(...))`, `judge` → `start(…, judgeBrief(...))`, `climb` → lane-service `climb`).
- src/services/run-briefs.ts — `LANE_HEADER` (63), `architectBrief`, `failingCheck`, `planTasks`, `fastChecks`, `researchAnswers`, `workerBrief` (a resumed fix sends fix lines only), `integrateBrief`, `reviewBrief`, `verifyBrief` (known issues pasted whole), `researchBrief`, `branchLine`, `briefFor` (≈ 470: string), `judgeBrief` (≈ 510: findings pasted whole).
- src/domain/brief.ts — `BriefContext` (scratch, roleServer, context), `laneBlock`, `roleNotes` (lists `mcp__catherd_role__*` names), `composeBrief(brief, c)` (wraps `roleSections`). src/domain/role-prompts.ts — `REPLY` (15 lines), `WORKER_REPLY`, the role bodies, `TEAM`, `TEAM_LINE`, `DONE_WHEN`, `SECTIONS`, `roleSections` (261), `rolePrompt` (agent files, src/domain/agents.ts:33). src/services/admission.ts — `admit` composes at 359–377 (`planContext` + standing rules as `<context>`; `brief-full.md` for a resumed dispatch).
- src/services/plan-input.ts — `PLAN_CONTEXT_MAX` (24), `citedSections` (90, `§n` across every file), `planContext` (110–147), `laneTasks`, `milestoneTasks`, `numberedALines`, `milestoneALines`, `deliveredALines`, `deliveredALineTexts`, `uncoveredALines`, `planProblems` (256), `taskBlock`. src/domain/plan-doc.ts — `parsePlanDoc`, `milestoneSection` (211), `milestoneCheck` (220), `CHECK_COVERED`. src/domain/lane.ts — `parseLaneHeader`, `assertLaneValues` (146), called by src/services/run-service.ts:224 (`write_run_file` of a lane).
- src/services/routing-service.ts — `routingProfile` (objective, bars, 80 % budget switch), `cheapestRung` (190), `prepare`, `judge` (Jev route-v2, chore skip), `pickFor` (slack, learned start, critical-path floor), `decide`, `route`, `routeMany`, `verdict` (381: `use === "off"` → fallback), `routingService` (finding, sameDefect, stopCause, checkStart, catalog). src/services/ports.ts — `ProfileView` (jev, bars, objective), `RouteRequest`, `RouteAnswer`, `RoutingPort` (161). test/services/helpers.ts — `testView`, `fakeDeps` (a fake `RoutingPort`).
- src/services/jev-service.ts (`jevQuestions`, `jevKey` from `TYPESAFE_API_KEY` or credentials `typesafeApiKey`, `askJev` with a per-run cache in jev.jsonl, `logJev`), src/infra/jev-client.ts (`JEV_BASE` hard-coded, `retryingFetch`: 10 s per attempt, 25 s per call, `jevRequest`), src/domain/jev.ts (question schemas, `JevFileSchema` with sets `route-v2`, `finding`, `same-defect`, `stop`; `scrubSecrets`, `dropFences`, `BODY_MAX` 6 000; `parseReply`; `judgeRoute`; `judgeVerdict`), catalog/jev.json (`model: jev-1.13.0`). src/services/credentials.ts — `CredentialsSchema { typesafeApiKey }`, `savedCredential`, `saveCredential`.
- src/domain/select.ts — `candidates` (enabled, effort caps, indexed, listed, capable; cost or speed order), private `breakTie` (quota headroom), `ladderFrom`, `defaultLadder`, `startAt`, `cheapest`, `defaultDifficulty`, `select`. src/domain/bars.ts — `BAR_PERCENTILE`, `percentilesOf`, `barOf`. src/domain/track-record.ts — `learnedStart`, `CHORE_WHY`. src/domain/cheap-fix.ts — `mechanicalFix`. src/domain/slack.ts — `laneSlack`. src/domain/route.ts — `RouteRow`, `OutcomeRow`, `laneOutcome`, `RouteSource`.
- src/services/lane-service.ts — `route`, `routeLanes`, `refuseDesign`, `climb`, `land` (writes outcomes, 616), `ask`. src/services/dispatch-service.ts — the 1.x `dispatch` (414: routes an unrouted lane), used by tests as the adapter harness.
- src/domain/profile.ts — `ProfileDocSchema` (55, loose), `unknownValues` (126), `Profile` (182), `defaultProfileDoc` (261, `jev: { use: "auto" }`, `objective`), `resolveProfile` (299), `ProfilePatchSchema` (413). src/services/profile-service.ts — `withProfilesLock`, `patchProfile`, `viewOf` (330). src/services/panel-setup.ts — `SettingsSchema` (56: objective, bars), web/src/routes/_app/setup/-components/SettingsSections.tsx (`ObjectiveSection`, `JevSection`, `BarsSection`), web/src/routes/_app/runs/-lib/tabs.ts (`TABS`, `tabsFor`), web/src/routes/_app/runs/-components/drawer/NodeDrawer.tsx.
- src/services/doctor.ts (Jev check 203–240), src/entry/init-command.ts (`jevStep`), src/infra/env.ts (`TYPESAFE_API_KEY` in the secret list), src/infra/launch.ts (passes `TYPESAFE_API_KEY` to the daemon), src/services/run-service.ts:130 (`checkStart` at run start), src/domain/errors.ts (`E_JEV_*`).
- src/services/run-report.ts — `writeRunReport` (135). src/domain/record.ts — `RunRecord` (`violations`, `extras`, tokens, `secs`).
- Branch `roles-no-honcho` (ffdbb01, on origin, not merged): admission gives every role `HONCHO_ENABLED=false`.

## Contracts

```ts
// src/domain/brief.ts (M1)
export interface BriefParts { facts: string[]; unit: string[]; round: string[] } // parts 2–4; part 1 is the role's
export const BRIEF_PARTS = ["role-contract", "run-facts", "unit-context", "this-round"] as const; // the tags, in order
export interface BriefContext { run: string; name: string; role: Role; version: string; resumed: boolean; lane: { id: string; text: string } | null }
export function composeBrief(parts: BriefParts, c: BriefContext): string; // fresh: four tagged parts; resumed: <this-round> + a lane-file pointer

// src/domain/role-prompts.ts (M1)
export const NEXT_LINE: Record<Role, string>;              // who comes after you and what they check (replaces TEAM, TEAM_LINE)
export function roleContract(role: Role, version: string): string; // purpose · you must · you must not · done when · reply
export const rolePrompt: (role: Role, version: string) => string;  // = roleContract (agent files)

// src/domain/plan-doc.ts (M1)
export const A_LINE_OWNERS = ["worker", "reviewer", "verifier", "run"] as const;
export type ALineOwner = (typeof A_LINE_OWNERS)[number];
export function aLineOwner(line: string): ALineOwner | null;        // `A3 [verifier] — …` → "verifier"; untagged → null
export function readsALine(role: Role, owner: ALineOwner | null): boolean; // D4's role groups

// src/domain/lane.ts (M1)
export function restatedALine(laneText: string, aLines: readonly string[]): { line: string; id: string } | null;

// src/services/plan-input.ts (M1)
export const UNIT_CONTEXT_MAX = 20_000;
export function unitContext(run: Run, role: Role, unit: string): string[]; // part 3 minus the lane file
export function roleALines(run: Run, role: Role, unit: string): string[];

// src/services/brief-cap.ts (M1)
export const FINDING_MAX = 2_000;
export function capText(run: Run, text: string, max: number): string; // overflow → notes/<sha12>.md, named in the cut
export const issueTitle: (text: string) => string;                 // first line, ≤ 160 characters

// src/services/run-briefs.ts (M1) — every brief is BriefParts now
export function briefFor(run: Run, s: RunState, a: DispatchAction): BriefParts;
export function judgeBrief(run: Run, input: JudgeInput): BriefParts;
export function renderBrief(run: Run, s: RunState, a: DispatchAction | JudgeAction, resumed: boolean): string; // composeBrief(...) with the lane file as it stands

// src/services/admission.ts (M1) — AdmitInput += { composed?: true; fullBrief?: string }: a composed brief is written verbatim

// src/domain/ran-lines.ts (M2)
export function parseRunLines(brief: string): string[];            // `RUN: <command>` lines of a verifier brief
export function parseRanLines(reply: string): { command: string; exit: number | null; log: string | null }[]; // `RAN: <cmd> — exit <n> — <log>`
export function verifierShortfall(required: string[], ran: ReturnType<typeof parseRanLines>, logOk: (path: string) => boolean): string[]; // `FAIL <cmd>: NOT RUN …`

// src/domain/test-guard.ts (M2)
export const TEST_PATH: RegExp; // (^|/)(test|tests|__tests__|spec)/ or \.(test|spec)\.[cm]?[jt]sx?$ or _test\.(go|py)$ or (^|/)test_[^/]+\.py$
export function guardedEdits(changed: readonly string[], owns: readonly string[]): string[]; // test paths changed and not owned

// src/domain/harness.ts (M2)
export const FAILURE_CLASSES = ["product", "harness"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];
export function failureSignature(text: string): string;            // findingKey of the first fail line (checkFailLines), else of the first line
export const HARNESS_NOTE: string;

// src/domain/run-events.ts (M2) check.ran += { failureClass?: FailureClass }; stop.classified += { failureClass?: FailureClass };
//   dispatch.ended += { testEdits?: string[] }
// src/domain/run-state.ts (M2) LaneState += { harness: string | null } (the last harness signature)
// src/services/ports.ts (M2) RoutingPort += failureClass(runDir: string, text: string, use: "auto" | "off"): Promise<Verdict<FailureClass>> (M5 folds it into verdict)

// src/domain/decision.ts (M3)
export const DECISION_SOURCES = ["model", "floor", "failover", "coordinator"] as const;
export type DecisionSource = (typeof DECISION_SOURCES)[number];
export type Family = "code" | "review" | "plan";
export interface Level { level: number; rungs: string[]; intelligence: number }
export interface LevelPick { level: number; p: number | null; rule: string }
export interface NoulRule { floor: string[]; cap: string[]; noulMin: number }
export const DecisionFileSchema: z.ZodType<DecisionFile>;           // catalog/decision.json
export function familyOf(role: Role): Family;
export function levelsOf(cands: readonly { rung: string; intelligence: number }[]): Level[]; // weakest first; equal intelligence = one level
export function aboveFloor(levels: readonly Level[], floor: string | null, strict: boolean): Level[]; // renumbered from 0
export const sixIndex: (k: number, n: number) => number;          // round(k·5/(n−1))
export function levelTexts(six: readonly string[], n: number): string[];
export function difficultyQuestions(f: DecisionFile, role: Role, n: number): Record<string, DecisionQuestion>; // `difficulty` (score, n criteria) + the noul signals
export function pickLevel(probs: Readonly<Record<string, number>>, n: number, min: number, nouls?: Readonly<Record<string, number>>, rule?: NoulRule): LevelPick;
export interface DecisionState { role: Role; unit: string; round: number; isFix: boolean; floorRung: string | null;
  rungs: { level: number; rung: string; intelligence: number }[]; previous: { rung: string; outcome: string; stopReason: string | null }[];
  spentFraction: number; slack: number | null; brief: string }
export function decisionState(i: Omit<DecisionState, "brief"> & { brief: string }): DecisionState; // the brief scrubbed of secrets (R4), nothing cut
// plus, moved unchanged from jev.ts: question schemas, canonicalJson, sha256, requestKey, scrubSecrets, parseReply, judgeVerdict, VERDICT_OPTIONS (+ "failure-class")

// src/infra/decision-client.ts (M3) — git mv of jev-client.ts
export interface DecisionTransport { fetchImpl?; now?; sleep?; random?; attemptMs?; deadlineMs?; retries? }
export async function retryingFetch(…): Promise<FetchOutcome>;     // unchanged
export async function decisionRequest(url: string, method: "GET" | "POST", path: string, key: string | null, body: unknown, o?: DecisionTransport): Promise<DecisionResponse>;

// src/services/decision-service.ts (M3)
export const DECISION_KEY_ENV = "CATHERD_DECISION_KEY";
export function decisionKey(): string | null;                      // env, else credentials.json decisionKey
export function saveDecisionKey(key: string): void;
export const decisionQuestions: () => DecisionFile;
export interface DecisionConfig { url: string; model: string; minConfidence: number }
export async function askDecision(runDir: string | null, cfg: DecisionConfig, call: string, state: unknown, questions: Record<string, DecisionQuestion>, o?: DecisionTransport & { key?: string | null }): Promise<Asked>;
export async function probeDecision(cfg: DecisionConfig, o?: DecisionTransport & { key?: string | null }): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }>;
export function logDecision(runDir: string, row: DecisionRow): void; // decisions.jsonl, never the state, only its hash

// src/services/credentials.ts (M3) CredentialsSchema += decisionKey; export function migrateCredentials(): { moved: boolean }

// src/domain/profile.ts (M3)
export const DEFAULT_MIN_CONFIDENCE = 0.8;
export const LEGACY_DECISION = { url: "https://api.typesafe.ai/v1", model: "jev-1.13.0" } as const;
// ProfileDoc += decision?: { url?, model?, minConfidence? } (loose); Profile += decision: { url: string | null; model: string | null; minConfidence: number }
// ProfilePatch += decision?: { url?: string /* http(s) */ | null; model?: string | null; minConfidence?: number /* 0.5–1 */ }
export function migrateProfileDoc(doc: ProfileDoc, hadKey: boolean): { doc: ProfileDoc; notes: string[] };
// src/services/profile-service.ts (M3): export function migrateProfiles(): { profile: string; notes: string[] }[]
// src/services/ports.ts (M3): ProfileView += decision

// src/domain/run-events.ts (M4)
// PARK_REASONS += "decision"; ACTION_TYPES: "climb" → "decide"; export const LEGACY_ACTION_TYPES = ["climb"] as const;
// effect.failed.action: z.enum([...ACTION_TYPES, ...LEGACY_ACTION_TYPES]); dispatch.refused += { rung?: string }
ev("decision.made", { name, n: int ≥ 1, role, unit, level: int ≥ 0, levels: int ≥ 1, levelRungs: string[][], rung, floor: string | null,
  strict: boolean, briefFile: string, briefHash: string, p: number | null, probabilities: Record<string, number>, why: string, source: DecisionSource });
ev("decision.failed", { name, n, unit, code: string, error: string, rungs: string[] }); // E_DECISION (model), E_ALL_HELD (no stand-in)
ev("decision.exhausted", { name, n, unit, floor: string });          // a strict floor with no rung above it

// src/domain/run-machine.ts (M4)
export interface Decided { n: number; briefFile: string; briefHash: string }
export type DispatchAction = { type: "dispatch"; unit; name; role; lane; rung: string | null; thread; failoverFrom; brief: BriefKind; notes: string[]; decision: Decided | null };
export type JudgeAction = { type: "judge"; input: JudgeInput; rung: string | null; decision: Decided | null };
export type DecideAction = { type: "decide"; n: number; next: DispatchAction | JudgeAction; floor: string | null; strict: boolean; exclude: string[]; failoverFrom: string | null; pick: string | null };
export const decidedName: (a: DispatchAction | JudgeAction) => string;
export function decided(s: RunState, a: DispatchAction | JudgeAction): Action[]; // the action with its decision, else its decide (none while it waits)
// actionKey(decide) = `decide:${decidedName(a.next)}:${a.n}`; unitOf(decide) = the next action's unit; "decide" ∈ PAUSED_STEPS

// src/domain/run-state.ts (M4)
export const DECISION_TRIES = 3;
export const DECISION_RETRY_MS = 60_000;
export interface MadeDecision { n: number; rung: string; briefFile: string; briefHash: string; source: DecisionSource }
// RunState += { decisions: Record<name, MadeDecision>; decided: Record<name, number>; floors: Record<name, { rung: string; fails: number }>;
//   decisionFails: Record<name, number>; refusedRungs: Record<name, string[]>; picks: Record<name, string>; decisionParks: Record<unit, string> }
// LaneState −= climbReason, cheapFirst, cheapRan, cheapSpent; climbedAt → floorAt
export function failedOn(s: RunState, name: string, rung: string | null, at: string): void; // R1/R2
export function floorOf(s: RunState, name: string): { floor: string | null; strict: boolean }; // strict at MAX_TRIES fails on one rung

// src/services/ports.ts (M4) RoutingPort += decide, verdict, probe (old members removed in M5)
export interface DecideRequest { runDir: string; repo: string; profile: ProfileView; role: Role; name: string; unit: string;
  floor: string | null; strict: boolean; exclude: string[]; held: string[]; usage: Record<string, number>; state: DecisionState }
export type DecideAnswer =
  | { ok: true; rung: string; level: number; levels: number; levelRungs: string[][]; source: "model" | "floor"; p: number | null; probabilities: Record<string, number>; why: string }
  | { ok: false; exhausted: true; floor: string }
  | { ok: false; exhausted: false; error: string; rungs: string[] };
// decide(req): Promise<DecideAnswer>; verdict(runDir, profile, set: "finding" | "same-defect" | "stop" | "failure-class", state): Promise<{ ok: true; value: string; p: number } | { ok: false; error: string }>;
// probe(profile): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }>
// src/domain/select.ts (M4): export function decisionCandidates(c: Catalog, p: RoutingProfile, role: Role): Candidate[]; export function tieBreak(rungs: string[], usage): { rung: string; why: string | null }

// src/domain/route.ts (M4) RouteSource += "decision"; RouteRow += { level?: number; levels?: number; intelligence?: number }; OutcomeRow += { level: number | null; levels: number | null; intelligence: number | null }
// src/domain/run-graph.ts (M5) RunNode += decision: { n; rung; level; levels; levelRungs; p; source; why; probabilities } | null
// src/services/run-scorecard.ts (M6)
export interface RoleScore { role: Role; dispatches: number; briefBytes: { median: number; max: number }; inputTokens: number; cacheHit: number; wallSecs: number;
  roundsPerLane: number | null; stops: Record<string, number>; verifierRan: number | null }
export function roleScorecard(run: Run, events: RunEvent[], records: RunRecord[]): RoleScore[];
```

## Rulings

Each is `Ruling: <what> — <why> — <cost if wrong>`. They bind every task; the spec binds them.

- D1 — Ruling: a brief is four tagged parts, `<role-contract>`, `<run-facts>`, `<unit-context>`, `<this-round>`, in that order, and holds nothing backend-specific: no scratch path (the role is told to use `$TMPDIR`, which admission sets to its scratch), no `mcp__…` tool names (only the `catherd run-file`, `catherd knowledge`, `catherd gate` command forms, which every role can run). So the brief judged by the decision model and the brief sent on a fresh thread are the same bytes — the spec's "rendered once" needs one text before the rung is known — a native role loses the MCP name hint and calls the CLI form, a few seconds slower.
- D2 — Ruling: the daemon composes every brief (`renderBrief`) and admission writes a `composed: true` brief verbatim; only the 1.x `dispatch` path (tests and a 1.5 coordinator) still has admission compose, its task text as part 4 — the decision must see the exact text, which admission could never show before the rung — two composition paths until 1.x is removed.
- D3 — Ruling: the reply contract is "at most 5 lines of prose, the full report in `$TMPDIR/report.md`, named on a `REPORT:` line"; machine lines (STATUS, VERDICT, findings, EXTRA, REJECTED, DESIGN, ENV, RAN, REPORT) do not count toward the 5 — catherd parses those from the reply — a role that writes no report file loses nothing catherd reads.
- D4 — Ruling: an A-line owner tag is `A<n> [worker|reviewer|verifier|run]` right after the id in plan.md's milestone sections; an untagged line is `run`; `planProblems` refuses an A-line cited in plan.md without a tag (the architect fixes it, as any plan gap). Role groups: `worker` → worker, writer, artist, researcher; `reviewer` → reviewer, ui-reviewer; `verifier` → verifier; architect and judge read every line — the A-lines come from the owner untagged, and plan.md is where the architect already cites them — an owner plan that hand-writes plan.md must tag too.
- D5 — Ruling: a lane-file line restates an A-line when it contains the A-line's first 8 words after its id and tag, folded (lower case, punctuation as spaces, whitespace collapsed); `write_run_file` of the lane is refused (`E_LANE_INVALID`, fix "drop the line: the role reads A<n> already"). Lines under 8 words never match — 8 words cut the false positives a shorter overlap gives on "the root gate is green" — a looser paraphrase passes.
- D6 — Ruling: part 3 holds, in order: the unit's plan tasks verbatim (`taskBlock`), the sections they cite resolved per file — `§n`/`§n.m` resolve in the task's own file first, else in the one taskless plan file the same task line names (by file name); `§3.2` is the `###` subsection whose heading starts `3.2`, `§3` the `##` section's own text down to its first `###` — then the role's A-lines (D4), then "Read on demand:" with every other plan file's path. Past `UNIT_CONTEXT_MAX` (20 000 characters) the rest is replaced by "[… cut: read <path> with catherd run-file read]" per file — the measured collisions came from `§n` matching every file — a task citing a section of an unnamed spec gets the path, not the text.
- D7 — Ruling: caps are applied where the brief is rendered: a finding over `FINDING_MAX` (2 000) and a judge's finding over 200 characters are cut by `capText`, which writes the whole text once to `notes/<first 12 hex of sha256>.md` in the run folder and names it; known issues are `issueTitle`s; the judge's brief carries no reply tail text over 200 characters per finding and points at the reply path. State keeps full texts — one rule in one place covers findings from reviewers, verifiers, the Check and the owner — notes/ grows by one file per long finding.
- D8 — Ruling: a verifier brief has one `RUN: <command>` line per command it must run: the milestone's `Check:` command when catherd has not passed it on this commit, else none (catherd's Check record is the evidence). The reply carries `RAN: <command> — exit <n> — <log path>` per command; `endedEvent` turns a PASS into a FAIL with one finding per shortfall (`FAIL <command>: NOT RUN (no RAN line)`, `… exit <n>`, `… log <path> missing or empty`). A log path is read relative to the milestone's tree, else absolute — the spec's executed-command rule needs a machine check, not a sentence — a verifier that ran the command but wrote a log elsewhere fails once and is told the format.
- D9 — Ruling: the failure class is a new verdict set `failure-class` (one `choice` question `failure_class`: product, harness; rule `min` 0.8, fallback `product`), asked through the routing port. It classes lane fast-check failures (inside the `fastCheck` effect, on `check.ran.failureClass`) and lane stops (the `classify` action now runs for every lane stop, reason given or not, and `stop.classified` carries both). A milestone Check failure is not classed. Before M4 a profile with Jev off classes everything `product` (today's behaviour); from M4 it is mandatory (R6) — the spec makes it the stop question's, and M2 lands before the decision model exists — a harness red on the milestone Check still costs a fix round.
- D10 — Ruling: a `harness` failure gives the lane one repair dispatch on its thread with `HARNESS_NOTE` and the evidence, counted in no round, attempt or floor; its `failureSignature` is kept on `LaneState.harness`; the same signature again parks the lane (`environment`) with the evidence; any `product` end clears it — "outside the round count" read as no attempt and no floor — a repair that changes the error's first line gets one more repair.
- D11 — Ruling: the test guard uses admission's start snapshot (`before`) and finalize's `violations` as the lane-start hash: `guardedEdits(record.violations, owns)` becomes `dispatch.ended.testEdits`; a lane end with any is a failed attempt of its rung with the note "Restore these test files; you do not own them: …", whatever EXTRA lines say — the snapshot already hashes every path at lane start — a test file a sibling lane changed mid-run is attributed as today's violations are.
- D12 — Ruling: the clean harness: every role env gets `HONCHO_ENABLED=false` (cherry-pick ffdbb01 when `roles-no-honcho` has not merged, else only its test stays); claude-code gets `BASH_MAX_OUTPUT_LENGTH=30000`; codex gets `-c tool_output_token_limit=8000`; opencode and cursor get no clamp (no setting) and the plan says so in README; opencode always gets its scratch `TMPDIR` (`grantsScratch` true for opencode, isolated or not) — these are the documented knobs of each CLI — a CLI that renames its setting ignores it silently; the live-verification doc lists the check.
- D13 — Ruling: action `decide`, events `decision.made`, `decision.failed`, `decision.exhausted`, key `decide:<name>:<n>`, `n` = `decided[name] + 1` (a failed call retries the same `n`); `dispatch.started` deletes the name's decision, refused rungs and pick — the spec leaves the names to the builder — none.
- D14 — Ruling: R2's failures mark `failedOn(name, rung)`: a lane worker or writer on a failed fast check (`product`), a BLOCKER or BUG routed to it by `fixRound` from a review, a verifier or a Check (not from the owner's answer or a hook refusal), a stop (`blocked`, `refused`, `too_hard`, `flaky`), a failed or timed-out end, a STATUS-less second ask, and `testEdits`; a reviewer, ui-reviewer or verifier when `failRole` counts it or the judge overrules its verdict; an architect when `failRole` counts it; a judge on `judge.failed`. A name's floor is cleared when its dispatch is accepted (`laneDone`, a reviewer's findings taken, a verifier's verdict taken, the architect's plan read, a judge's decision). The judge verb `climb` sets the floor strict — the same failure points today's climbs and tries use — a reviewer that keeps failing on one rung still parks at `MAX_TRIES` by `failRole`, as today.
- D15 — Ruling: a strict floor with no rung above (`decision.exhausted`) is today's top of the ladder for a lane: parked, `top = true`, the `unexpected` judge, `TOP_RUNG_JUDGES` then the owner, a `too_hard` stop straight to the owner; for any other name it parks the unit (`effect`) — R1 keeps that path — none.
- D16 — Ruling: `decision.failed` with code `E_DECISION` waits `DECISION_RETRY_MS` (60 s) per try and parks the unit at `DECISION_TRIES` (3) with reason `decision`: "<name>: the decision model gave no usable answer (<error>). Answer with one of the <role>'s rungs at or above <floor>: <rungs>, or retry." An answer whose first word is a listed rung (at or above the floor) becomes `picks[name]`, and the next decide appends `decision.made` with `source: "coordinator"` without a call; `retry` clears the count; anything else parks the same question again. `E_ALL_HELD` waits like today's refusal. The transport's own retries (10 s, 25 s) stay inside each call — three calls a minute apart, as the spec says, without a sleep in an effect — a model down for an hour parks every unit about three minutes in.
- D17 — Ruling: a limit's failover runs inside `decide`: a `failoverFrom` names the stand-in with `failoverRung` and appends `decision.made` with `source: "failover"`, the brief rendered as always; no stand-in is `decision.failed` `E_ALL_HELD` — the spec keeps failover off the model and records it as a decision — none.
- D18 — Ruling: the dispatch effect sends the decision's `brief.md` verbatim on a fresh thread after checking its sha256 against `briefHash`; on a resumed thread it renders `<this-round>` only (R3) and keeps the decision file as `brief-full.md` for a stand-in. A mismatch is `dispatch.refused` `E_DECISION_STALE`; a decided rung on a quota held since is `E_RUNG_HELD`; an admission refusal of the rung is `E_ADMIT_RUNG` with `rung` (R10). Each of the three drops the decision (and adds the rung to `refusedRungs` for the last), and the next decide excludes held and refused rungs — the decided rung must be the dispatched rung — a quota that flaps re-decides once per flap.
- D19 — Ruling: catalog/decision.json holds, per family (code: worker, writer, artist, researcher; review: reviewer, ui-reviewer, verifier; plan: architect, judge), six level texts weakest to strongest, each "A model at this level does well: …", stretched from the four route-v2 descriptions (mechanical = 0, follows an example = 2, new stateful logic = 3, open cause or design = 5); N levels take `levelTexts` (indices `round(k·5/(N−1))`). The noul signals of route-v2 stay (`shared_state`, `unclear_cause`, `cross_boundary` floor at the first level whose six-index is ≥ 3; `mechanical` caps at the last level whose six-index is ≤ 2; the floor wins). The `kind` question goes. N = 1 asks nothing and records `source: "floor"` — six fixed texts keep the question stable for N = 2…6 and the cache key per N — the texts are hand-written, and the live probe is the only check of their wording.
- D20 — Ruling: within a level the rung is the one on the quota with the fewest dispatches in this run (today's `breakTie`, exported as `tieBreak`), the profile's ladder order breaking an equal count — R5 — none.
- D21 — Ruling: the decision state is the spec's JSON plus `spentFraction` and `slack` (R8); `previous` lists this name's ended dispatches (rung, `ok`/`failed`/`limit`/…, the stop reason); `round` is the count of this name's dispatches so far; `isFix` is a `fix` or `recheck` brief or non-empty notes — the spec lists the fields — none.
- D22 — Ruling: the `route` action stays the milestone's start: it appends `lanes.routed` with no lanes, then runs preflight as today; a lane's `rung` is set by `decision.made` and `dispatch.started` — `lanes.routed` moves a milestone to routing — the event's name outlives its meaning.
- D23 — Ruling: `lane.climbed` stays in the schema for old runs (the reducer still applies it); `climb` leaves `ACTION_TYPES` and is accepted only as a legacy `effect.failed` action; lane-service `climb`, `route`, `routeLanes`, `refuseDesign`, `ask` and the mechanical cheap try are deleted — R1, R8 — a 1.x coordinator session that calls those internals breaks; there is none (no MCP tool reaches them).
- D24 — Ruling: each `decision.made` of a lane appends a routes.jsonl row (`source: "route"`, `decidedBy: "decision"`, ladder = the level rungs, `level`, `levels`, `intelligence`); `laneOutcome` reads the first such row as the start and the last as the final rung, rung changes as `climbs` with reason `decision`; `OutcomeRow` gains `level`, `levels`, `intelligence` (R7); `learnedStart` is deleted, the outcome summary stays for display — outcomes keep their file and readers — an old run's outcome rows have null levels.
- D25 — Ruling: the profile names the decision model: `decision.url` and `decision.model` have no default, `minConfidence` defaults to 0.8. A profile without them validates with a warning ("the decision model is not set"), and `run_start`, preflight and `catherd doctor` refuse (`E_DECISION_UNSET`, fix `catherd profile set decision.url https://<your-gateway>/v1` and `decision.model`). `migrateProfileDoc` drops `jev`, `bars`, `roles.*.bars`, `objective`, and names `LEGACY_DECISION` only when the doc had `jev` and the user had a TypeSafe key and no `decision` block; `ProfileService.migrateProfiles()` applies it under the profiles lock at `catherd init`, `catherd doctor`, `run_start` and before every profile write, and logs each note; `resolveProfile` ignores the old fields until then — O5 forbids a run without one, and the public repo forbids a default — a user who never runs init or doctor learns it from `run_start`'s refusal.
- D26 — Ruling: the key is `CATHERD_DECISION_KEY`, else credentials.json `decisionKey`; `migrateCredentials` moves `typesafeApiKey` to `decisionKey` (same lock, mode 600). With no key the request goes without `Authorization` and the probe decides. `TYPESAFE_API_KEY` is no longer read; doctor names it when set — a gateway may need no key — a TypeSafe user who only exported the env var sees doctor's line.
- D27 — Ruling: the probe is one fixed request (`role: "worker"`, three rungs, a 200-character brief, the `difficulty` question at N = 3) sent by doctor and once per `run_start`; a non-ok answer refuses the run with `E_DECISION_PROBE` and its error — the spec's preflight probe — about 1–2 s on every run start.
- D28 — Ruling: decisions.jsonl replaces jev.jsonl (rows `call: "difficulty"` with name, n, role, level, levels, rung, floor, probabilities, source, briefHash, latencyMs, usage; verdict calls as `call: <set>`); the per-run request cache stays, keyed by model, state and questions — the spec's records — none.
- D29 — Ruling: run-state.ts, run-machine.ts and run-events.ts change in M2.L4 and M4.L2 only; run-effects.ts in M1.L4, M2.L5 and M4.L3 only; each in a lane of its own, after the lanes it consumes — the reducer cannot be edited side by side — the critical path runs through those lanes.
- D30 — Ruling: the dead fields and the old routing go in M5, after the new path is live in M4 (additive M3–M4, deleting M5) — every lane must compile and the panel's API moves once — one milestone more than a big bang.
- D31 — Ruling: the 1.x `dispatch` (dispatch-service) never decides: a lane without `rung` takes its current routes.jsonl row, else `E_INPUT_INVALID` "pass rung" — it is the adapters' test harness and a 1.5 coordinator's path, where the coordinator decides — a 1.5-style session must pass rungs.
- D32 — Ruling: the lane header's `Kind:` and `Difficulty:` stay required and are part of the brief (A2); `Chore: yes` still parses and does nothing; `LANE_HEADER` and the architect's text drop the chore paragraph and say Kind and Difficulty inform the decision model — A2, R8 — old lane files still validate.
- D33 — Ruling: the B16 scorecard is a "## Scorecard" table in the run report, one row per role, from events.jsonl, records.jsonl and the dispatch folders' brief.md sizes — the spec says written to the run report — the live targets are the owner's to read.
- D34 — Ruling: the changeset is `major`, "Part of 2.0.0", like the other unreleased 2.0 changesets (package.json is 1.5.0); MIGRATION.md "From 1.5 to 2.0" gains the decision model section — 2.0 is not released yet — none.

## Parallelism

- M1: L1 and L2 at once; L3 after L2; L4 after L1 and L3. Critical path L2 → L3 → L4.
- M2 (after M1): L1, L2, L3 at once; L4 after L1, L3; L5 after L1, L3, L4.
- M3 (after M2): L1 and L2 at once; L3 after both; L4 after L3.
- M4 (after M3): L1 and L2 at once; L3 after both.
- M5 (after M4): L1 and L3 at once; L2 after L1.
- M6 (after M5): L1, then L2.

## M1 — Briefs in four parts (B8–B11)

A1 — every role's brief is the four tagged parts in order, part 1 byte-identical for a role across runs and backend-neutral, no `<team>` paragraph and no `mcp__` name in any brief (Check).
A2 — a lane's unit context holds its own tasks and only the subsections they cite, resolved per file, under 20 000 characters with the rest named by path; a role sees only its own A-lines and the `run` ones; a lane line that restates an A-line is refused at write (Check).
A3 — a resumed fix round sends `<this-round>` only; a new thread gets the four parts; findings over 2 000 characters, known issues and judge findings are capped with a pointer to the file holding the rest (Check).
A4 — each change has a test that fails without it.
A5 — web/ is untouched, web/openapi.json unchanged.
A7 — the diff adds no home-directory path and no private host name; fixtures are synthetic.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 1: The role contract and the four-part composer

Files: src/domain/brief.ts, src/domain/role-prompts.ts, src/services/admission.ts, test/domain/brief.test.ts, test/domain/agents.test.ts, test/domain/verifier-prompt.test.ts, test/services/admission.test.ts, test/services/helpers.ts

`roleContract(role, version)` is the role body, `EVERY_ROLE`, `STOP_WATCHERS` (not the worker's), `NEXT_LINE[role]`, `DONE_WHEN[role]` and the reply contract, joined by blank lines. `TEAM`, `TEAM_LINE`, `SECTIONS` and `roleSections` go; `rolePrompt = roleContract`. `NEXT_LINE` examples: worker "After you: catherd reruns your fast check, then a reviewer and a verifier on other models judge the milestone; what they find comes back to you as a fix round."; reviewer "After you: your BLOCKER and BUG lines go, as written, to a worker with no memory of your review, and catherd counts them."; one line each for the nine roles. `runFiles` and every role body name only the CLI forms (`catherd run-file read <run> <path>`, `catherd run-file write <run> <path>`, `catherd knowledge show`, `catherd gate …`) and say "when your harness lists catherd tools with the same names, they do the same". `REPLY`/`WORKER_REPLY` follow D3 (`at most 5 lines`, `REPORT:`). `composeBrief(parts, c)` per Contracts; the lane file goes as `laneBlock` at the end of `<unit-context>`; part 2 always ends with `roleNotes(c)`, which now reads "catherd: you are <name> of run <run>. Put temporary files in $TMPDIR, never in /tmp." plus the CLI forms of `roleMcpTools(role)`; resumed: `<this-round>` and "Your lane file is lanes/<id>.md (catherd run-file read <run> lanes/<id>.md)." `AdmitInput` gains `composed?: true` (write `i.brief` verbatim) and `fullBrief?: string` (the resumed dispatch's `brief-full.md`); without `composed`, admission composes `{ facts: [], unit: [planContext + rules], round: [task] }` as the 1.x path. test/services/helpers.ts's brief helper follows the new signature.

Test: test/domain/brief.test.ts — "a fresh brief is the four parts in order" — `composeBrief({ facts: ["f"], unit: ["u"], round: ["r"] }, ctx)` → the tags' indexes increase in `BRIEF_PARTS` order; no `<team>`; no `mcp__`.
Test: test/domain/brief.test.ts — "part 1 is byte-identical for a role" — two `composeBrief` calls with different runs, names, lanes and parts → the `<role-contract>` blocks are equal; worker and verifier differ.
Test: test/domain/brief.test.ts — "a resumed brief is this round and a pointer" — `resumed: true` → only `<this-round>` and `lanes/M1.L1.md`.
Test: test/domain/agents.test.ts — "the agent file is the role contract" — `rolePrompt("worker", v)` equals `roleContract("worker", v)` and holds `at most 5 lines` and `REPORT:`.
Test: test/services/admission.test.ts — "a composed brief is written verbatim" — `admit(…, { brief: "<role-contract>\nX\n</role-contract>\n", composed: true })` → brief.md equals the input byte for byte.

### Task 2: A-line owner tags and restated lane lines

Files: src/domain/plan-doc.ts, src/domain/lane.ts, src/services/run-service.ts, test/domain/plan-doc.test.ts, test/domain/lane.test.ts, test/services/run-files.test.ts

`aLineOwner`, `readsALine` and `restatedALine` per Contracts and D4, D5. `write_run_file` of `lanes/<id>.md` (run-service.ts:224) also calls `restatedALine(content, run.meta.aLines)` and refuses a hit with `E_LANE_INVALID`: `lanes/<id>.md restates <A-id>: "<line>"`, fix `drop the line: the role reads <A-id> already`.

Test: test/domain/plan-doc.test.ts — "an A-line names its owner" — `A3 [verifier] — the build boots` → verifier; `- A2 [run] — x` → run; `A1 — y` → null; `A4 [judge] — z` → null.
Test: test/domain/plan-doc.test.ts — "a role reads its own lines and run's" — worker reads worker and run and null, not reviewer; writer reads worker; ui-reviewer reads reviewer; judge reads all.
Test: test/domain/lane.test.ts — "a lane line that restates an A-line is found" — A-line `A10 the panel boots in a browser and every screen renders without console errors`, lane line `- Rule: the panel boots in a browser and every screen renders.` → `{ id: "A10" }`; a 7-word overlap → null.
Test: test/services/run-files.test.ts — "a lane file that restates an A-line is refused" — `write_run_file lanes/M1.L1.md` with a restating line → `E_LANE_INVALID` naming A1; without it → written.

### Task 3: The unit context and the role's A-lines

Files: src/services/plan-input.ts, test/services/plan-input.test.ts, test/fixtures/briefs/plan.md, test/fixtures/briefs/spec.md, test/fixtures/briefs/credit.md

`unitContext(run, role, unit)` per D6; `roleALines(run, role, unit)` reads plan.md's section of the unit's milestone (`milestoneSection`) for the cited `A<n>` lines, keeps those `readsALine(role, aLineOwner(line))`, falls back to the run's own line text for a cited id with no plan.md line, and for a run unit returns every line. `planProblems` adds "A<n> in plan.md has no owner tag: write it A<n> [worker|reviewer|verifier|run]" for each untagged cited line. `planContext` stays exported until M2.L2 (the 1.x path uses it). The fixture is synthetic: plan.md (two milestones, Task 1 "Implement the ledger" citing `§3.2` and `spec.md §4`), spec.md (`## 3. Ledger` with `### 3.1`, `### 3.2`, `### 3.3` of about 6 KB each, `## 4. Fees` 2 KB, `## 9. History` 60 KB of filler), credit.md (`## 3. Credit` 30 KB, a second `§3`).

Test: test/services/plan-input.test.ts — "a task's §n resolves in its own files only" — the fixture as plan inputs, lane M1.L1 → the unit context holds `### 3.2` of plan.md and `## 4. Fees` of spec.md, not `### 3.1`, not credit.md's `## 3. Credit`, not `## 9. History`; it names spec.md and credit.md under `Read on demand:`.
Test: test/services/plan-input.test.ts — "the unit context is capped with a pointer" — a task citing `§9` → the total is ≤ 20 000 characters and holds `cut: read plan-input/spec.md`.
Test: test/services/plan-input.test.ts — "the slim lane and the bloated lane render the same unit context" — the same lane with and without a 100 KB irrelevant `## 12. Appendix` in spec.md → equal unit contexts (the decision-state fixture of the spec's probe).
Test: test/services/plan-input.test.ts — "a worker sees worker and run lines only" — plan.md M1 cites `A1 [worker] — x`, `A2 [verifier] — y`, `A3 — z` → worker: A1, A3; verifier: A2, A3.
Test: test/services/plan-input.test.ts — "an untagged plan.md A-line is a plan problem" — `A1 — x` under M1 → `planProblems` names A1.

### Task 4: Every brief in four parts, capped, and fix rounds

Files: src/services/run-briefs.ts, src/services/brief-cap.ts, src/services/run-effects.ts, test/services/run-briefs.test.ts, test/services/brief-cap.test.ts, test/services/verifier-brief.test.ts, test/services/run-effects.test.ts

`briefFor` and `judgeBrief` return `BriefParts`: part 2 the run id and title, the run folder, `branchLine`, `READ_RULES`, and for worker and verifier the `catherd lock` rule; part 3 `unitContext`, `researchAnswers`, a reviewer's `reviewPlan` and `rejections`; part 4 the notes (each `capText(run, n, FINDING_MAX)`), `failingCheck`, `fastChecks`, the previous verifier's lines, known issues as `issueTitle`s with "the full text is in the milestone's digest", the owner's answers. A worker's resumed fix sends part 4 only (B11); a new thread the four parts. `judgeBrief` numbers findings as `capText(run, f, 200)` and drops the reply tail for "reply: <path>". `renderBrief` = `composeBrief(parts, { …, resumed, lane: the lane file now })`. `perform` passes `renderBrief(...)` with `composed: true` (and `fullBrief` for a resumed thread) to admission. `LANE_HEADER` and the architect text drop the `Chore:` paragraph (D32).

Test: test/services/brief-cap.test.ts — "a long finding is cut and kept whole in notes/" — 5 000 characters → result ≤ 2 200 characters, names `notes/<12 hex>.md`, whose content is the whole text; the same text again writes the same file.
Test: test/services/run-briefs.test.ts — "a resumed fix round sends this round only" — lane with thread `t1`, notes `["BLOCKER src/a.ts:3 — x — y"]` → the rendered brief has `<this-round>` and no `<role-contract>`; thread null → all four parts.
Test: test/services/run-briefs.test.ts — "a worker brief stays under 20 KB on the bloated fixture" — Task 3's fixture with the 100 KB appendix → `renderBrief` length < 20 480 characters.
Test: test/services/run-briefs.test.ts — "the judge gets references, not pasted findings" — a 130 000-character finding → the judge brief is < 6 000 characters and names `notes/`.
Test: test/services/verifier-brief.test.ts — "known issues are titles" — a 3-line, 900-character known issue → its first line only, ≤ 160 characters.
Test: test/services/run-effects.test.ts — "a dispatch writes the daemon's composed brief" — `perform` a lane dispatch → the dispatch's brief.md equals `renderBrief(run, s, a, false)`.

### M1 lanes

- M1.L1 — Task 1 — owns src/domain/brief.ts, src/domain/role-prompts.ts, src/services/admission.ts, test/domain/brief.test.ts, test/domain/agents.test.ts, test/domain/verifier-prompt.test.ts, test/services/admission.test.ts, test/services/helpers.ts — fast check: `bun test test/domain/brief.test.ts test/domain/agents.test.ts test/domain/verifier-prompt.test.ts test/services/admission.test.ts && bun run typecheck && bun run lint`
- M1.L2 — Task 2 — owns src/domain/plan-doc.ts, src/domain/lane.ts, src/services/run-service.ts, test/domain/plan-doc.test.ts, test/domain/lane.test.ts, test/services/run-files.test.ts — fast check: `bun test test/domain/plan-doc.test.ts test/domain/lane.test.ts test/services/run-files.test.ts && bun run typecheck && bun run lint`
- M1.L3 — Task 3 — after M1.L2 — owns src/services/plan-input.ts, test/services/plan-input.test.ts, test/fixtures/briefs/ — fast check: `bun test test/services/plan-input.test.ts && bun run typecheck && bun run lint`
- M1.L4 — Task 4 — after M1.L1, M1.L3 — owns src/services/run-briefs.ts, src/services/brief-cap.ts, src/services/run-effects.ts, test/services/run-briefs.test.ts, test/services/brief-cap.test.ts, test/services/verifier-brief.test.ts, test/services/run-effects.test.ts — fast check: `bun test test/services/run-briefs.test.ts test/services/brief-cap.test.ts test/services/verifier-brief.test.ts test/services/run-effects.test.ts && bun run typecheck && bun run lint`

## M2 — The harness enforces (B12–B15)

After: M1

A1 — a verifier PASS without a RAN line and a readable log for each RUN command, or with a nonzero exit, lands as a FAIL naming the command (Check).
A2 — every lane fast-check failure and lane stop is classed product or harness; a harness failure gets one repair dispatch outside the round count, and the same signature twice parks with the evidence (Check).
A3 — a lane that changed a test file it does not own is refused and told to restore it (Check).
A4 — each change has a test that fails without it.
A5 — every role env has HONCHO_ENABLED=false; claude-code and codex roles get their output clamps; opencode gets a scratch TMPDIR (Check).
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 5: RAN lines, the test guard and failure signatures

Files: src/domain/ran-lines.ts, src/domain/test-guard.ts, src/domain/harness.ts, test/domain/ran-lines.test.ts, test/domain/test-guard.test.ts, test/domain/harness.test.ts

Per Contracts. `parseRanLines` accepts `RAN:` with an optional list marker and bold, `—`, `–` or `-` separators, `exit 0` or `exit: 0`; `NOT RUN` in place of the exit is `exit: null`. `verifierShortfall` matches a required command to a RAN line by whitespace-collapsed equality. `HARNESS_NOTE` = "This failure is the environment's, not the product's: repair what blocks the check (the tool, the service, the path), change no product code, and say what you fixed."

Test: test/domain/ran-lines.test.ts — "RAN lines parse with their exit and log" — `- **RAN:** bun test — exit 0 — /tmp/x/test.log` → `{ command: "bun test", exit: 0, log: "/tmp/x/test.log" }`; `RAN: make e2e — NOT RUN` → exit null.
Test: test/domain/ran-lines.test.ts — "a PASS short of a command is a FAIL" — required `["bun test"]`, no RAN → `["FAIL bun test: NOT RUN (no RAN line)"]`; exit 1 → `… exit 1`; log missing (`logOk` false) → `… log /x missing or empty`; all good → `[]`.
Test: test/domain/test-guard.test.ts — "a changed test file outside Owns is guarded" — changed `["test/a.test.ts", "src/a.ts", "pkg/x_test.go"]`, owns `["src/"]` → `["test/a.test.ts", "pkg/x_test.go"]`; owns `["test/"]` → `["pkg/x_test.go"]`.
Test: test/domain/harness.test.ts — "a failure's signature ignores line numbers and paths" — `(fail) db > connects [3.1ms]` and `(fail) db > connects [9.0ms]` → equal; another test name → different.

### Task 6: A clean harness for headless roles

Files: src/domain/role-tools.ts, src/services/admission.ts, src/services/plan-input.ts, src/adapters/codex/index.ts, src/adapters/claude-code/index.ts, test/services/admission.test.ts, test/services/plan-input.test.ts, test/adapters/codex.test.ts, test/adapters/claude-code.test.ts

D12. `grantsScratch("opencode", false)` is true. Admission's spec env adds `HONCHO_ENABLED: "false"` before the gate env and the adapter's env (ffdbb01's place and comment). The claude-code adapter's env adds `BASH_MAX_OUTPUT_LENGTH: "30000"`; the codex adapter's common args add `-c tool_output_token_limit=8000`. The 1.x composition's part 3 becomes `unitContext(run, role, unit)`; `planContext` and `PLAN_CONTEXT_MAX` are deleted.

Test: test/services/admission.test.ts — "a role runs with Honcho off" — spec env `HONCHO_ENABLED` is `"false"`; a gate env value `HONCHO_ENABLED=true` wins.
Test: test/services/admission.test.ts — "an opencode role gets its scratch TMPDIR" — opencode rung, not isolated → spec env `TMPDIR` is the role's scratch.
Test: test/adapters/codex.test.ts — "codex clamps tool output" — the plan's args contain `tool_output_token_limit=8000` after a `-c`, fresh and resumed.
Test: test/adapters/claude-code.test.ts — "claude-code clamps shell output" — the plan's env has `BASH_MAX_OUTPUT_LENGTH: "30000"`.

### Task 7: The failure-class question

Files: catalog/jev.json, src/domain/jev.ts, src/services/routing-service.ts, src/services/ports.ts, test/services/helpers.ts, test/domain/jev.test.ts, test/services/routing-service.test.ts, test/fixtures/jev/failure-class-harness.json

D9. catalog/jev.json gains set `failure-class`: question `failure_class` (`choice`; criteria `product`: "The product code or its tests are wrong: the failure is the work's to fix", `harness`: "The machine, a tool, a service, a path, a network or a credential stopped the check; the product code may be right"), rule `{ min: 0.8, fallback: "product" }`. `JevFileSchema.sets` and `VERDICT_OPTIONS` gain it. `RoutingPort.failureClass(runDir, text, use): Promise<Verdict<FailureClass>>` asks it with state `{ text: scrubFree(text.slice(-4000)) }`; the fake answers `product`.

Test: test/domain/jev.test.ts — "the failure-class set parses and its fallback is an option" — `JevFileSchema.parse(catalog)` succeeds; `VERDICT_OPTIONS["failure-class"]` holds the fallback.
Test: test/services/routing-service.test.ts — "a harness answer classes the failure" — fake fetch with test/fixtures/jev/failure-class-harness.json (`harness` p 0.9) → `{ value: "harness", source: "jev" }`; `use: "off"` → `product`, no request.

### Task 8: Harness repairs, test edits and every stop classed, in the reducer

Files: src/domain/run-events.ts, src/domain/run-state.ts, src/domain/run-machine.ts, test/domain/run-events.test.ts, test/domain/run-state.test.ts, test/domain/run-machine.test.ts, test/domain/run-fixtures.ts

The M2 fields of Contracts. `onEnded`: a lane end with a reason, or `unexplained`, sets `classify` (every lane stop now waits for its class). `stop.classified` with `failureClass: "harness"` → D10 (`harnessRepair(s, l, sig, evidence)`: `l.harness === sig` parks `environment` with the evidence; else `l.harness = sig`, notes `[HARNESS_NOTE, evidence]`, thread kept, pending, nothing counted); `product` or absent → `laneEnded` as today, `l.harness = null`. `check.ran` with `failureClass: "harness"` → the same with the tail. `dispatch.ended` of a lane with `testEdits` → before anything else: a failed attempt (`attempts += 1`, thread null, pending) with the note "Restore these test files; you do not own them: …". `effect.failed` `classify` stays today's fallback (laneEnded with the given reason).

Test: test/domain/run-state.test.ts — "a harness failure gets one repair outside the round count" — check.ran exit 1, `failureClass: "harness"`, tail `(fail) db > connects` → L1 pending, notes start with HARNESS_NOTE, `attempts` and `checkFails` 0, thread kept; the same tail again → `stuck["M1.L1"].reason` environment with the tail.
Test: test/domain/run-state.test.ts — "a product failure after a repair clears the signature" — harness, then a product check failure → `harness` null, `checkFails` 1.
Test: test/domain/run-state.test.ts — "a lane that edited a foreign test file is sent back" — ended ok with `testEdits: ["test/b.test.ts"]` → pending, attempts 1, the note names test/b.test.ts, no fast check owed.
Test: test/domain/run-machine.test.ts — "every lane stop is classed before it acts" — ended ok, STATUS blocked, reason `too_hard` → a `classify` action owed for it, no dispatch.
Test: test/domain/run-events.test.ts — "the M2 fields parse and old lines still do" — check.ran with and without `failureClass`, dispatch.ended with `testEdits`.

### Task 9: Verifier evidence, test edits and classes in the effects

Files: src/services/run-effects.ts, src/services/run-briefs.ts, src/domain/role-prompts.ts, test/services/run-effects.test.ts, test/services/verifier-brief.test.ts, test/domain/verifier-prompt.test.ts

D8: `verifyBrief` adds a `RUN: <command>` line per required command and "Report each as RAN: <command> — exit <n> — <log path>; a command you did not run is RAN: <command> — NOT RUN, which fails the milestone." The verifier body says "judged from the tree" only for lines about the tree itself (a submodule pin, the diff's contents, commit history) and that every other line needs a RAN line. `endedEvent` for a verifier PASS reads the dispatch's brief.md (`parseRunLines`) and the reply (`parseRanLines`), and with any `verifierShortfall` (log read relative to `treeOf(run, milestone)` or absolute, ok when it exists and is non-empty) returns `verdict: "fail"` and those findings as BLOCKERs. A lane's `endedEvent` adds `testEdits: guardedEdits(record.violations, laneOwns)` when non-empty. `fastCheck` asks `deps.routing.failureClass(run.dir, tail, profile.jev.use)` on a failure and puts it on `check.ran`; `classify` asks both `stopCause` (only when the end has no reason) and `failureClass`, and appends one `stop.classified`.

Test: test/services/run-effects.test.ts — "a verifier PASS with no RAN line fails" — brief.md with `RUN: bun test`, reply `VERDICT: PASS` → dispatch.ended verdict fail, a finding `FAIL bun test: NOT RUN (no RAN line)`.
Test: test/services/run-effects.test.ts — "a verifier PASS with its RAN line and log passes" — `RAN: bun test — exit 0 — <tree>/v.log`, the log written → verdict pass.
Test: test/services/run-effects.test.ts — "a lane end names its foreign test edits" — a record with `violations: ["test/b.test.ts"]` and owns `src/` → `testEdits: ["test/b.test.ts"]`.
Test: test/services/run-effects.test.ts — "a failed fast check carries its class" — the fake answers harness → check.ran `failureClass: "harness"`.
Test: test/services/verifier-brief.test.ts — "a verifier brief lists the commands to run" — milestone `Check: bun test` not passed by catherd → `RUN: bun test`; passed on this commit → no RUN line.

### M2 lanes

- M2.L1 — Task 5 — owns src/domain/ran-lines.ts, src/domain/test-guard.ts, src/domain/harness.ts, test/domain/ran-lines.test.ts, test/domain/test-guard.test.ts, test/domain/harness.test.ts — fast check: `bun test test/domain/ran-lines.test.ts test/domain/test-guard.test.ts test/domain/harness.test.ts && bun run typecheck && bun run lint`
- M2.L2 — Task 6 — owns src/domain/role-tools.ts, src/services/admission.ts, src/services/plan-input.ts, src/adapters/codex/index.ts, src/adapters/claude-code/index.ts, test/services/admission.test.ts, test/services/plan-input.test.ts, test/adapters/codex.test.ts, test/adapters/claude-code.test.ts — fast check: `bun test test/services/admission.test.ts test/services/plan-input.test.ts test/adapters/codex.test.ts test/adapters/claude-code.test.ts && bun run typecheck && bun run lint`
- M2.L3 — Task 7 — owns catalog/jev.json, src/domain/jev.ts, src/services/routing-service.ts, src/services/ports.ts, test/services/helpers.ts, test/domain/jev.test.ts, test/services/routing-service.test.ts, test/fixtures/jev/failure-class-harness.json — fast check: `bun test test/domain/jev.test.ts test/services/routing-service.test.ts && bun run typecheck && bun run lint`
- M2.L4 — Task 8 — after M2.L1, M2.L3 — owns src/domain/run-events.ts, src/domain/run-state.ts, src/domain/run-machine.ts, test/domain/run-events.test.ts, test/domain/run-state.test.ts, test/domain/run-machine.test.ts, test/domain/run-fixtures.ts — fast check: `bun test test/domain/run-events.test.ts test/domain/run-state.test.ts test/domain/run-machine.test.ts test/entry/panel-openapi.test.ts && bun run typecheck && bun run lint`
- M2.L5 — Task 9 — after M2.L1, M2.L3, M2.L4 — owns src/services/run-effects.ts, src/services/run-briefs.ts, src/domain/role-prompts.ts, test/services/run-effects.test.ts, test/services/verifier-brief.test.ts, test/domain/verifier-prompt.test.ts — fast check: `bun test test/services/run-effects.test.ts test/services/verifier-brief.test.ts test/domain/verifier-prompt.test.ts && bun run typecheck && bun run lint`

## M3 — The decision model, beside the router (Part A, additive)

After: M2

A1 — the level texts, the floor, the levels of equal intelligence and the pick rule follow the spec, and the four probe states of the spec are a fixture whose recorded answers give the expected picks (Check).
A2 — the decision client calls any `url` the profile names, with the key from CATHERD_DECISION_KEY or credentials.json `decisionKey`, and never reaches the network in a test (Check).
A3 — a profile names `decision.url`, `decision.model` and `decision.minConfidence`; a 1.5 profile and credentials file migrate once through ProfileService and credentials.ts, and still load before they do (Check).
A4 — each change has a test that fails without it.
A7 — the diff adds no home-directory path and no private host name; no default url or model.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 10: Levels, texts and the pick rule

Files: src/domain/decision.ts, catalog/decision.json, test/domain/decision.test.ts, test/fixtures/decision/probe-states.json, test/infra/assets.test.ts, test/pack-smoke.ts

Per Contracts, D19, D21. The question schemas, `canonicalJson`, `sha256`, `requestKey`, `scrubSecrets`, `parseReply`, `judgeVerdict` and `VERDICT_OPTIONS` are copied from jev.ts here (jev.ts goes in M5); `scrubFree` drops its 6 000-character cap and its fence dropping (R4: `scrubSecrets` only). catalog/decision.json: `{ schema: 1, sets: { difficulty: { levels: { code: [6], review: [6], plan: [6] }, nouls: { shared_state, unclear_cause, cross_boundary, outside_repo, mechanical } (route-v2's text), floor: ["shared_state", "unclear_cause", "cross_boundary"], cap: ["mechanical"], noulMin: <route-v2's> }, finding, "same-defect", stop, "failure-class" (from jev.json, unchanged) } }`. The `difficulty` score question's instructions: "Which level of model does the role in the state need to do this brief well? Each level names what a model at that level does well." probe-states.json holds the spec's four probe rows as synthetic states (a reviewer recheck, the slim new-logic lane, a follows-an-example lane, the same lane with a bloated context: synthetic text only) with recorded 5-level probabilities shaped to the table and the expected pick under `pickLevel(…, 0.8)`.

Test: test/domain/decision.test.ts — "levels group equal intelligence, weakest first" — rungs b 40, a 30, c 40, d 50 → `[[a], [b, c], [d]]`.
Test: test/domain/decision.test.ts — "the floor keeps its level, strict drops it" — floor c → `[[b, c], [d]]`; strict → `[[d]]` renumbered 0; strict on d → `[]`.
Test: test/domain/decision.test.ts — "N level texts are evenly spaced over six" — N 5 → indices 0, 1, 3, 4, 5; N 4 → 0, 2, 3, 5; N 2 → 0, 5; N 6 → all; N 1 → `[]`.
Test: test/domain/decision.test.ts — "a sure level wins, else the cumulative from the top" — `{3: 0.54, 4: 0.16, 2: 0.2, 1: 0.08, 0: 0.02}`, N 5 → level 2; `{0: 0.66, …}` → 0; `{1: 0.85}` N 3 → 1.
Test: test/domain/decision.test.ts — "a noul floors at new logic and caps at the example" — level 0 with `shared_state` 0.9 at N 5 → 2; level 4 with `mechanical` 0.9 → 1; both → the floor.
Test: test/domain/decision.test.ts — "the probe states pick as recorded" — each probe-states.json row through `pickLevel` → its `expected`; each state's `difficulty` question has 5 criteria.
Test: test/domain/decision.test.ts — "the state keeps the whole brief, secrets scrubbed" — a 150 000-character brief with `sk-ant-…` → length kept within the scrub's change, no `sk-ant-`.

### Task 11: The decision client

Files: src/infra/decision-client.ts (git mv of src/infra/jev-client.ts), src/infra/env.ts, src/infra/launch.ts, src/services/jev-service.ts, src/services/doctor.ts, test/infra/decision-client.test.ts (git mv of test/infra/jev-client.test.ts), test/infra/env.test.ts, test/infra/launch.test.ts

`JEV_BASE` leaves the client; `decisionRequest(url, method, path, key, body, o)` posts to `${url}${path}` with `authorization: Bearer <key>` only when `key` is non-null, `x-catherd-retry-count` on a retry, and reads `x-request-id` (else `x-typesafe-request-id`). jev-service and doctor import it with `"https://api.typesafe.ai/v1"` as their url until M5. env.ts adds `CATHERD_DECISION_KEY` to the secrets it scrubs and passes; launch.ts passes it to the daemon beside `TYPESAFE_API_KEY`.

Test: test/infra/decision-client.test.ts — every jev-client test, on a url argument — plus "the profile's url is the one called": url `https://gateway.test/v1`, path `/systemone` → the fake fetch saw `https://gateway.test/v1/systemone`; key null → no `authorization` header.
Test: test/infra/launch.test.ts — "the daemon gets the decision key" — `CATHERD_DECISION_KEY` in the launching env → in the daemon env.

### Task 12: The decision service and its key

Files: src/services/decision-service.ts, src/services/credentials.ts, test/services/decision-service.test.ts, test/services/credentials.test.ts

Per Contracts, D26, D27, D28. `askDecision` is `askJev`'s logic over `cfg.url`, `cfg.model` and catalog/decision.json, logging to `decisions.jsonl` (`ensureJsonlHeader(f, "decisions")`), the cache keyed by `requestKey(cfg.model, state, questions)`. `probeDecision` posts D27's fixed state and is ok when `parseReply` accepts the answer. `migrateCredentials` moves `typesafeApiKey` to `decisionKey` under the credentials lock when `decisionKey` is absent, and removes the old field.

Test: test/services/decision-service.test.ts — "a decision is asked of the profile's model at its url, and logged" — fake fetch → request body `model` is cfg.model, the url cfg.url; one decisions.jsonl row with the state hash, not the state.
Test: test/services/decision-service.test.ts — "the same request is answered from the log" — a second identical ask → no fetch, `cached: true`.
Test: test/services/decision-service.test.ts — "the probe needs a parsable answer" — 200 with a valid reply → ok; 200 with `{}` → `{ ok: false }`; a network error → `{ ok: false, error }`.
Test: test/services/decision-service.test.ts — "the key comes from the env, then credentials" — `CATHERD_DECISION_KEY=a` wins over a saved `b`; neither → null; `TYPESAFE_API_KEY` alone → null.
Test: test/services/credentials.test.ts — "a TypeSafe key moves to decisionKey once" — `{ schema: 1, typesafeApiKey: "k" }` → `{ schema: 1, decisionKey: "k" }`, mode 600, `moved: true`; again → `moved: false`.

### Task 13: The profile names the decision model, and old profiles migrate

Files: src/domain/profile.ts, src/domain/profile-rules.ts, src/services/profile-service.ts, src/services/ports.ts, test/services/helpers.ts, test/domain/profile.test.ts, test/domain/profile-rules.test.ts, test/services/profile-service.test.ts, test/fixtures/profiles/legacy-1.5.json, web/openapi.json, web/src/client/types.gen.ts

Per Contracts, D25. `ProfileDocSchema` gains `decision: z.looseObject({ url, model, minConfidence }).optional()`; `resolveProfile` fills `decision`; `viewOf` copies it; `ProfilePatchSchema` gains `decision` (url `http(s)://` only, `minConfidence` 0.5 to 1). Validation warns at `decision` when url or model is missing. `migrateProfiles()` reads every profile under `withProfilesLock`, applies `migrateProfileDoc(doc, savedCredential("typesafeApiKey").key !== null || decisionKey() !== null)` and writes only a changed doc (no relink: agents do not depend on these fields); `patchProfile` migrates the stored doc before it patches. `defaultProfileDoc` writes no `jev` and no `objective`. `jev`, `bars`, `objective` stay on `Profile` and `ProfileView` (with today's defaults) until M5. `testView` gains `decision: { url: "https://decision.test/v1", model: "test-decider", minConfidence: 0.8 }`. Regenerate web/openapi.json and types.gen.ts.

Test: test/domain/profile.test.ts — "a 1.5 profile migrates to the decision model" — legacy-1.5.json (`jev: { use: "auto" }`, `bars: { logic: 70 }`, `roles.worker.bars`, `objective: "speed"`), hadKey → no jev, bars, roles.worker.bars or objective; `decision` is LEGACY_DECISION; notes name each.
Test: test/domain/profile.test.ts — "no key, no TypeSafe url" — hadKey false → no `decision`; a doc with a `decision` block keeps its own.
Test: test/domain/profile.test.ts — "the decision block resolves with its default confidence" — `decision: { url, model }` → `minConfidence` 0.8; none → url and model null.
Test: test/domain/profile-rules.test.ts — "a profile without a decision model warns" — no `decision` → a warning at `decision`, no error.
Test: test/services/profile-service.test.ts — "old profiles migrate once, under the lock" — the legacy file saved as profile `old`, a TypeSafe key in credentials → after `migrateProfiles()` the file has `decision` and no `jev`; a second call writes nothing (mtime unchanged).
Test: test/services/profile-service.test.ts — "a patch over an old profile saves" — `set("old", { notify: ["finish"] })` on the legacy file → saved, no `bars` in the file.

### M3 lanes

- M3.L1 — Task 10 — owns src/domain/decision.ts, catalog/decision.json, test/domain/decision.test.ts, test/fixtures/decision/probe-states.json, test/infra/assets.test.ts, test/pack-smoke.ts — fast check: `bun test test/domain/decision.test.ts test/infra/assets.test.ts && bun run typecheck && bun run lint`
- M3.L2 — Task 11 — owns src/infra/decision-client.ts, src/infra/jev-client.ts, src/infra/env.ts, src/infra/launch.ts, src/services/jev-service.ts, src/services/doctor.ts, test/infra/decision-client.test.ts, test/infra/jev-client.test.ts, test/infra/env.test.ts, test/infra/launch.test.ts — fast check: `bun test test/infra/decision-client.test.ts test/infra/env.test.ts test/infra/launch.test.ts test/services/jev-service.test.ts && bun run typecheck && bun run lint`
- M3.L3 — Task 12 — after M3.L1, M3.L2 — owns src/services/decision-service.ts, src/services/credentials.ts, test/services/decision-service.test.ts, test/services/credentials.test.ts — fast check: `bun test test/services/decision-service.test.ts test/services/credentials.test.ts && bun run typecheck && bun run lint`
- M3.L4 — Task 13 — after M3.L3 — owns src/domain/profile.ts, src/domain/profile-rules.ts, src/services/profile-service.ts, src/services/ports.ts, test/services/helpers.ts, test/domain/profile.test.ts, test/domain/profile-rules.test.ts, test/services/profile-service.test.ts, test/fixtures/profiles/legacy-1.5.json, web/openapi.json, web/src/client/types.gen.ts — fast check: `bun test test/domain/profile.test.ts test/domain/profile-rules.test.ts test/services/profile-service.test.ts test/entry/panel-openapi.test.ts && bun run typecheck && bun run lint`

## M4 — Decide before every dispatch (Part A, live)

After: M3

A1 — every dispatch and judge call of every role, in every round, is preceded by a decision on the brief it sends; a restart between the decision and the dispatch asks nothing again (Check).
A2 — a fix round, retry or recheck after a failure of the same name never runs below the rung that failed; twice on one rung moves the floor above it; no rung above is the top-of-ladder path (Check).
A3 — a decision model that gives no usable answer is retried three times a minute apart, then parks the unit; the coordinator's answer of a rung at or above the floor runs it (Check).
A4 — a limit fails over without asking the model, an admission refusal or a held quota re-decides without that rung, and a stale brief is never sent (Check).
A5 — the failure class and the stop reason are asked of the decision model, mandatory: retried, then parked (Check).
A6 — each change has a test that fails without it.
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 14: `decide`, `verdict` and `probe` in the routing port

Files: src/services/routing-service.ts, src/services/ports.ts, src/domain/select.ts, test/services/helpers.ts, test/services/routing-decide.test.ts

Additive: the old members stay until M5. `decisionCandidates` is `candidates` in cost order whatever the objective; `tieBreak` is `breakTie` over rungs of one level. `decide(req)`: the catalog (`loadCatalog`, the discovery refresh budget as `prepare`), `decisionCandidates` minus rungs on `req.held` quotas and `req.exclude`, `levelsOf`, `aboveFloor(req.floor, req.strict)`; none → `{ ok: false, exhausted: true, floor }` when strict, else `{ ok: false, exhausted: false, error: "no rung", rungs: [] }`; one level → `source: "floor"`, no call; else `askDecision(runDir, profile.decision, "difficulty", req.state with its rungs, difficultyQuestions(…, N))`, `pickLevel(…, minConfidence, nouls, rule)`, `tieBreak` in the level, one decisions.jsonl row; an error or unparsable answer → `{ ok: false, exhausted: false, error, rungs }`. A profile with no url or model → that error, `E_DECISION_UNSET`'s text. `verdict(runDir, profile, set, state)` asks the set and returns `{ ok: false }` on an error or an unparsable answer, the fallback only for a parsed answer below the rule's `min`. `probe(profile)` is `probeDecision`. The fake in helpers.ts decides the role's first rung above the floor (`source: "floor"`), verdicts the rule's fallback, probes ok.

Test: test/services/routing-decide.test.ts — "N is the role's levels above the floor" — worker ladder of 4 distinct intelligences, floor the 2nd → the request's `difficulty` has 3 criteria; strict → 2.
Test: test/services/routing-decide.test.ts — "the picked level's rung runs, ties go to headroom" — answer level 1, level 1 holding two rungs on quotas with usage 3 and 0 → the 0 one.
Test: test/services/routing-decide.test.ts — "one level asks nothing" — floor at the strongest → no fetch, `source: "floor"`.
Test: test/services/routing-decide.test.ts — "held and refused rungs leave the list" — held quota of rung 1, exclude rung 2 → neither in `levelRungs`.
Test: test/services/routing-decide.test.ts — "an unparsable answer is a failure, not a fallback" — `{}` → `{ ok: false, exhausted: false }` with the rungs listed.
Test: test/services/routing-decide.test.ts — "the noul floor lifts a mechanical read" — level 0 with `shared_state` 0.95 → the first level of six-index ≥ 3.

### Task 15: The decide step in the machine

Files: src/domain/run-events.ts, src/domain/run-state.ts, src/domain/run-machine.ts, src/domain/run-graph.ts, src/domain/route.ts, test/domain/run-events.test.ts, test/domain/run-state.test.ts, test/domain/run-machine.test.ts, test/domain/run-pause.test.ts, test/domain/run-fixtures.ts, test/domain/run-graph.test.ts, web/openapi.json, web/src/client/types.gen.ts

The M4 Contracts of run-events, run-machine, run-state and route.ts, and D13–D18, D22, D23. Machine: `laneActions` and `roleDispatch` build a `DispatchAction` (`decision: null`) and push `decided(s, a)`; every `judge` push goes through `decided`; the `climb` branch and `cheap` go; `failoverFrom` as today. Reducer: `decision.made` sets `decisions[name]`, `decided[name] = n`, deletes `decisionFails[name]`, sets a lane's `rung`; `decision.failed` per D16; `decision.exhausted` per D15; `dispatch.started` per D13; `dispatch.refused` `E_DECISION_STALE`/`E_RUNG_HELD`/`E_ADMIT_RUNG` per D18; `question.answered` on a `decision` park per D16 (an answer is checked against the failed event's `rungs`); `failedOn` at D14's points and the floor cleared where it says; every `climbReason = …` becomes `failedOn(…)`; `fixRound` gains `blame: boolean` (false for the owner's answer and a hook refusal); `mergePlan` drops `decisions[name]` of a lane whose digest changed and fills the new `RunState` fields with `??=` for an old state; `siblingMayChange` reads `floorAt`; `lane.climbed` still applies its rung (old runs). `effect.failed` `classify` counts as a decision failure of `classify:<dispatchId>`: `laneActions` holds the classify while that name waits, and the third parks the lane (`decision`); the owner's answer ends the stop as today's fallback (`laneEnded` with the stop's own reason, class product). `onJudged` verb `climb` sets the floor strict. `RunNode` keeps its shape; the openapi files change by `decision` in `PARK_REASONS`. `ClimbReason`, `CLIMB_REASONS` stay for old routes.jsonl rows. Test helpers: `decide(log, name, rung, n?)` appends a `decision.made` in run-fixtures.ts; tests that expected a `dispatch` first see its `decide`, then the dispatch after `decide(...)`; tests that pinned climbs and cheap tries pin floors instead.

Test: test/domain/run-machine.test.ts — "a lane's first dispatch is a decide" — plan.ready, routed, preflight → `{ type: "decide", n: 1, next: { type: "dispatch", name: "worker-M1.L1", decision: null }, floor: null }`, no dispatch.
Test: test/domain/run-machine.test.ts — "a decision makes the dispatch, on its rung and brief" — after `decision.made` → a `dispatch` with `rung` and `decision.briefFile`; key `dispatch:worker-M1.L1`.
Test: test/domain/run-machine.test.ts — "a restart between decision and dispatch asks nothing again" — replay through `decision.made`, then `daemon.started` → a dispatch, no decide.
Test: test/domain/run-machine.test.ts — "every role is decided" — architect, researcher-dossier, reviewer, ui-reviewer, verifier, the integrate worker and a triage judge each owe a decide first.
Test: test/domain/run-state.test.ts — "a failed fast check is the floor of the fix round" — decided luna, check fails → the next decide has `floor: "codex:gpt-6-luna#high", strict: false`; it fails again on luna → `strict: true`.
Test: test/domain/run-state.test.ts — "a review BLOCKER floors only its lane" — BLOCKER on L2's file → L2's decide has L2's rung as floor, L1's none; the reviewer's recheck has no floor.
Test: test/domain/run-state.test.ts — "the owner's fix answer is no floor" — a blocker park answered with a fix → the lane's decide has no floor.
Test: test/domain/run-state.test.ts — "no rung above a strict floor goes to the judge" — `decision.exhausted` for L1 → parked, top, an `unexpected` judge owed; the third → stuck too_hard.
Test: test/domain/run-state.test.ts — "a decision model down parks after three tries" — three `decision.failed` E_DECISION a minute apart → waits 60 s after the first two, `stuck` reason `decision` after the third, its question lists the rungs.
Test: test/domain/run-state.test.ts — "the coordinator's rung is the decision" — answer `codex:gpt-6-sol#high` → the next decide has `pick` that rung; an answer below the floor → parked again with the same question.
Test: test/domain/run-state.test.ts — "a stale or refused rung is decided again" — `dispatch.refused` E_ADMIT_RUNG rung r → decision dropped, the next decide's `exclude` holds r; E_DECISION_STALE → dropped, `exclude` empty.
Test: test/domain/run-state.test.ts — "a replan drops a lane's unsent decision" — decision.made for L1, plan.ready with L1's digest changed → no `decisions["worker-M1.L1"]`.
Test: test/domain/run-state.test.ts — "an old run with climb events replays and decides" — events with `lane.climbed` and `effect.failed { action: "climb" }` → replay succeeds; L1's rung is the climbed one; its next action is a decide.
Test: test/domain/run-pause.test.ts — "a pause holds the decide step" — paused → no decide owed.
Test: test/domain/run-events.test.ts — "the decision events parse and describe" — the three events validate; `describeEvent` gives `worker-M1.L1 decided: … (level 1 of 3, model)`.

### Task 16: The decide effect and the dispatch of a decision

Files: src/services/run-effects.ts, src/services/run-store.ts, test/services/run-effects.test.ts, test/services/run-daemon.test.ts

D17, D18, D21, D24. `decide(a, s)`: a `pick` → validated against the role's candidates and the floor, `decision.made` `source: "coordinator"`; a `failoverFrom` → `failoverRung(deps, run, role, from, held)` and `source: "failover"`, else `decision.failed` E_ALL_HELD; else `renderBrief(run, s, a.next, false)` written to `decisions/<name>/<n>/brief.md` (`runPaths(run.dir).decisions`), `briefHash` its sha256, the state per D21 (`laneSlack` of the last plan.ready, the budget fraction), `deps.routing.decide(req)` → `decision.made` (and D24's routes.jsonl row for a lane) / `decision.exhausted` / `decision.failed` E_DECISION. `start` takes the action's `rung` and `decision`: fresh thread → the file, its hash checked; resumed → `renderBrief(…, true)` with `fullBrief` the file; a rung on a held quota → refuse E_RUNG_HELD; admission's E_ADMIT_RUNG → refuse with `rung`. `rungFor`, `rerouteLane`, `cheapestRung` and the `climb` case go; `route` appends `lanes.routed { lanes: [] }` before preflight (D22). `classify` and `fastCheck` call `deps.routing.verdict` and append `effect.failed` (`classify`) on `{ ok: false }` (Task 15 counts it). run-store.ts `runPaths` gains `decisions` and `decisionsLog`.

Test: test/services/run-effects.test.ts — "decide renders the brief and records the decision" — `perform(decide)` with the fake port → decisions/worker-M1.L1/1/brief.md exists, `decision.made.briefHash` is its sha256, a routes.jsonl row `decidedBy: "decision"`.
Test: test/services/run-effects.test.ts — "the dispatch sends the decided brief byte for byte" — then `perform(dispatch)` → the dispatch's brief.md equals the decision file.
Test: test/services/run-effects.test.ts — "a changed decision file is refused as stale" — edit the file → `dispatch.refused` E_DECISION_STALE, no admission.
Test: test/services/run-effects.test.ts — "a limit fails over without the model" — `failoverFrom` set → `decision.made` `source: "failover"`, the fake's `decide` not called.
Test: test/services/run-effects.test.ts — "the judge is decided and sent its rung" — a judge action with a decision → the dispatch runs on the decided rung, not `rungs[0]`.
Test: test/services/run-effects.test.ts — "a verdict failure is an effect failure" — the fake's verdict `{ ok: false }` → `effect.failed` classify.
Test: test/services/run-daemon.test.ts — "a daemon run decides, then dispatches, end to end" — the fake backend run of a one-lane plan → events in order `decision.made`, `dispatch.started` for every role, the run ends done.

### M4 lanes

- M4.L1 — Task 14 — owns src/services/routing-service.ts, src/services/ports.ts, src/domain/select.ts, test/services/helpers.ts, test/services/routing-decide.test.ts — fast check: `bun test test/services/routing-decide.test.ts test/services/routing-service.test.ts && bun run typecheck && bun run lint`
- M4.L2 — Task 15 — owns src/domain/run-events.ts, src/domain/run-state.ts, src/domain/run-machine.ts, src/domain/run-graph.ts, src/domain/route.ts, test/domain/run-events.test.ts, test/domain/run-state.test.ts, test/domain/run-machine.test.ts, test/domain/run-pause.test.ts, test/domain/run-fixtures.ts, test/domain/run-graph.test.ts, web/openapi.json, web/src/client/types.gen.ts — fast check: `bun test test/domain/run-events.test.ts test/domain/run-state.test.ts test/domain/run-machine.test.ts test/domain/run-pause.test.ts test/domain/run-graph.test.ts test/entry/panel-openapi.test.ts && bun run typecheck && bun run lint`
- M4.L3 — Task 16 — after M4.L1, M4.L2 — owns src/services/run-effects.ts, src/services/run-store.ts, test/services/run-effects.test.ts, test/services/run-daemon.test.ts — fast check: `bun test test/services/run-effects.test.ts test/services/run-daemon.test.ts && bun run typecheck && bun run lint`

## M5 — Jev, the ladder and the bars go; the panel shows the decision

After: M4

A1 — no Jev, TypeSafe default, bar, objective, climb, learned start, cheap try or chore start is left in src/, the CLI or the panel; "decision model" names it everywhere (Check).
A2 — `catherd doctor` and run start refuse until the profile names a decision model that answers the probe; `catherd init` asks for the url, model and key and migrates old profiles (Check).
A3 — the panel's Settings edit the decision model (url, model, minimum confidence) and have no Objective, Jev or Difficulty bars section; every role node has a Decision tab with the levels, the pick, its probability, its source and why (Check).
A4 — each change has a test that fails without it.
A5 — README, CONTRIBUTING, MIGRATION ("From 1.5 to 2.0"), AGENTS.md, CLAUDE.md and the plugin's setup skill describe the decision model with a generic `https://<your-gateway>/v1` example.
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test && cd web && bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun run test

### Task 17: Remove Jev, the ladder and the bars

Files: src/services/routing-service.ts, src/services/ports.ts, src/services/lane-service.ts, src/services/dispatch-service.ts, src/services/run-service.ts, src/services/jev-service.ts (delete), src/domain/jev.ts (delete), catalog/jev.json (delete), src/domain/select.ts, src/domain/bars.ts (delete), src/domain/track-record.ts, src/domain/cheap-fix.ts (delete), src/services/provenance.ts, src/services/outcome-summary.ts, src/services/summary.ts, src/services/doctor.ts, src/entry/init-command.ts, src/entry/doctor-command.ts, src/entry/profile-command.ts, src/entry/runs-command.ts, src/entry/catalog-command.ts, src/entry/mcp/session-tools.ts, src/services/run-debug.ts, src/infra/env.ts, src/infra/launch.ts, src/infra/log.ts, src/domain/errors.ts, src/domain/profile.ts, src/domain/profile-rules.ts, src/services/profile-service.ts, src/domain/secrets.ts, src/services/run-store.ts, test/services/helpers.ts, test/services/run-service.test.ts, test/pack-smoke.ts, test/infra/assets.test.ts, and the tests of every removed function (test/domain/jev.test.ts, test/services/jev-service.test.ts, test/services/climb-design.test.ts, test/domain/bars.test.ts, test/domain/select.test.ts, test/services/routing-service.test.ts, test/services/outcome-summary.test.ts, test/services/doctor.test.ts, test/entry/init-command.test.ts, test/entry/doctor-command.test.ts, test/domain/profile.test.ts, test/domain/profile-rules.test.ts, test/services/profile-service.test.ts, test/live/jev.live.test.ts → test/live/decision.live.test.ts, test/fixtures/jev/ → test/fixtures/decision/)

D23, D25–D27, D30, D31. `RoutingPort` keeps `decide`, `verdict`, `probe`, `checkStart`, `catalog`; `route`, `routeMany`, `finding`, `sameDefect`, `stopCause`, `failureClass` go (their callers use `verdict`). `Profile`, `ProfileView`, `ProfilePatchSchema`, `defaultProfileDoc` and `unknownValues` lose `jev`, `bars`, `roles.*.bars`, `objective`; `RoutingProfile`, `ProfileLike` and `candidates` lose `objective` and `bars`. select.ts keeps `effortAllowed`, `candidates`, `decisionCandidates`, `tieBreak`, `rolesWithoutRung`, `noRungCause`, `quotaUsage`, `CODING_FLOOR`. `run_start` (run-service.ts, beside `checkStart`) runs `migrateProfiles()`, refuses `E_DECISION_UNSET` without url or model and `E_DECISION_PROBE` when `deps.routing.probe(view)` fails. Doctor: one `decision` check (url and model named, key present or "none sent", the probe's latency or error, `TYPESAFE_API_KEY` set but not read); it runs `migrateProfiles()` and `migrateCredentials()` first. Init: the decision step asks "Decision model url (https://<your-gateway>/v1)", "model", "key (optional; Enter skips)", saves through `patchProfile` and `saveDecisionKey`, and probes. `E_JEV_*` become `E_DECISION_KEY`, `E_DECISION_UNSET`, `E_DECISION_PROBE`, `E_DECISION_RESPONSE`. summary.ts and runs-command count decisions.jsonl rows by `source`; run-store.ts drops its `jev` path (old runs keep the file). decision.live.test.ts reads `CATHERD_DECISION_LIVE_URL`, `CATHERD_DECISION_LIVE_MODEL` and `CATHERD_DECISION_KEY`, is skipped without them, and sends the four probe states. `grep -riE "jev|typesafe" src` finds only `LEGACY_DECISION`, the migration, its notes and the doctor line.

Test: test/services/run-service.test.ts — "a run without a decision model is refused" — view without `decision.url` → `E_DECISION_UNSET`; the fake probe failing → `E_DECISION_PROBE` with its error; both fine → the run starts.
Test: test/services/doctor.test.ts — "doctor checks the decision model" — no url → fail with the `profile set decision.url` fix; probe ok → ok with latency; `TYPESAFE_API_KEY` set → the not-read line.
Test: test/entry/init-command.test.ts — "init names the decision model and probes it" — piped answers url, model, key → the profile has `decision`, the key saved, the probe called once.
Test: test/domain/profile.test.ts — "a stored 1.5 profile still resolves" — the legacy file through `resolveProfile` → no throw, no `jev`/`bars`/`objective` on the result.

### Task 18: The panel edits and shows the decision model

Files: src/services/panel-setup.ts, src/domain/run-graph.ts, src/entry/panel/openapi.ts, web/openapi.json, web/src/client/types.gen.ts, web/src/routes/_app/setup/-components/SettingsSections.tsx, web/src/routes/_app/setup/-lib/patch.ts, web/src/routes/_app/setup/-lib/issues.ts, web/src/routes/_app/setup/index.tsx, web/src/lib/glossary.ts, web/src/routes/_app/runs/-lib/tabs.ts, web/src/routes/_app/runs/-components/drawer/DecisionTab.tsx, web/src/routes/_app/runs/-components/drawer/NodeDrawer.tsx, web/src/routes/_app/-dashboard/Recoveries.tsx, test/services/panel-setup.test.ts, test/domain/run-graph.test.ts, web/src/routes/_app/setup/-lib/patch.test.ts, web/src/routes/_app/setup/-route.test.tsx, web/src/routes/_app/runs/-route.test.tsx, web/src/routes/_app/runs/-lib/tabs.test.ts

`SettingsSchema` loses `objective`, `jev`, `bars` and gains `decision { url: string | null; model: string | null; minConfidence: number }`. `RunNodeSchema` gains `decision` (Contracts), the latest `decision.made` of the node's dispatch name (a lane node: `<role>-<lane>`; a milestone's role nodes: their own names). The web: `ObjectiveSection`, `JevSection`, `BarsSection` go; `DecisionSection` (three fields, its own `Section` with review and save as `PreflightSection` does, url placeholder `https://<your-gateway>/v1`); `TABS` gains `decision` ("Decision"), shown by `tabsFor` for every node with a role; `DecisionTab` lists the levels weakest first (the rungs of each, the picked one marked), the probability, the source and why, and "Not decided yet" without one. The glossary's Jev entry becomes "Decision model". Recoveries.tsx stops naming climbs. Regenerate the openapi files.

Test: test/services/panel-setup.test.ts — "settings carry the decision model, not the bars" — the settings of `testView` have `decision` and no `objective`, `jev` or `bars` key.
Test: test/domain/run-graph.test.ts — "a role node carries its latest decision" — two `decision.made` for worker-M1.L1 → the lane node's `decision.n` is 2, with its level rungs.
Test: web/src/routes/_app/runs/-lib/tabs.test.ts — "a role node has a Decision tab" — a lane node → tabs include `decision`; a check node → not.
Test: web/src/routes/_app/runs/-route.test.tsx — "the Decision tab shows the levels and the pick" — a node with level 1 of 3 → three level rows, the second marked, its probability and why.
Test: web/src/routes/_app/setup/-route.test.tsx — "settings edit the decision model" — the Decision section saves a patch `{ decision: { url, model, minConfidence } }`; no Objective, Jev or Difficulty bars heading.

### Task 19: The docs say decision model

Files: README.md, CONTRIBUTING.md, MIGRATION.md, AGENTS.md, CLAUDE.md, plugin/skills/catherd-setup/SKILL.md, plugin/.claude-plugin/plugin.json, .claude-plugin/marketplace.json, docs/dev/live-verification.md, test/skills.test.ts

Every "Jev"/TypeSafe line becomes the decision model: what it decides (every dispatch, on the role's brief, N levels, the floor in a fix round), how to set it (`catherd profile set decision.url https://<your-gateway>/v1`, `decision.model <model>`, `CATHERD_DECISION_KEY`), that a run refuses without one, the brief shape and its caps, the verifier's RUN/RAN lines, the failure class, the test guard, the harness clamps (and that opencode and cursor have none). MIGRATION.md "From 1.5 to 2.0" gains "The decision model": `jev`, `bars`, `objective` are migrated away, `typesafeApiKey` moves to `decisionKey`, `TYPESAFE_API_KEY` is not read, the profile names TypeSafe's URL only when it had a key. CLAUDE.md's first paragraph: "a decision model picks each dispatch's model and effort". live-verification.md gains the clamp and probe checks.

Test: test/skills.test.ts — "no shipped doc names Jev" — README.md, the plugin skill, plugin.json and marketplace.json have no `Jev`; README names `CATHERD_DECISION_KEY`.

### M5 lanes

- M5.L1 — Task 17 — owns the files of Task 17 — fast check: `bun run typecheck && bun run lint && bun test test/services/run-service.test.ts test/services/doctor.test.ts test/entry/init-command.test.ts test/domain/profile.test.ts test/services/routing-decide.test.ts test/services/run-effects.test.ts && ! grep -rliw jev src --include='*.ts' | grep -v profile`
- M5.L2 — Task 18 — after M5.L1 — owns the files of Task 18 — fast check: `bun test test/services/panel-setup.test.ts test/domain/run-graph.test.ts test/entry/panel-openapi.test.ts && bun run typecheck && cd web && bun run typecheck && bun run lint && bun run test`
- M5.L3 — Task 19 — chore — owns README.md, CONTRIBUTING.md, MIGRATION.md, AGENTS.md, CLAUDE.md, plugin/skills/catherd-setup/SKILL.md, plugin/.claude-plugin/plugin.json, .claude-plugin/marketplace.json, docs/dev/live-verification.md, test/skills.test.ts — fast check: `bun run format:check && bun test test/skills.test.ts`

## M6 — The scorecard on every run (B16), the backlog and the changeset

After: M5

A1 — every run report has a "## Scorecard" table: per role, dispatches, brief bytes (median, max), input tokens, cache-hit share, wall time, rounds per lane, stops by reason, and executed commands per verifier reply (Check).
A2 — docs/dev/ideas.md drops what this plan did and lists what it left out; a catherd-cli changeset describes the decision model and the briefs.
A4 — each change has a test that fails without it.
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 20: The per-role scorecard in the run report

Files: src/services/run-scorecard.ts, src/services/run-report.ts, test/services/run-scorecard.test.ts, test/services/run-report.test.ts

`roleScorecard` per Contracts: brief bytes from each record's dispatch folder `brief.md` (a missing file is skipped), input tokens and cache-hit share (`cached / input`, 0 for no input) from records, wall time the sum of `secs`, rounds per lane the median of dispatches per lane (null for a role with no lane), stops by `dispatch.ended.reason` (and `limit`, `failed`, `timeout` by status), `verifierRan` the median count of `RAN:` lines in verifier replies (null for other roles). `writeRunReport` adds the table after the milestones, roles in `ROLES` order, a role with no dispatch left out.

Test: test/services/run-scorecard.test.ts — "the scorecard counts what the run did" — records: two workers (briefs 10 KB and 30 KB, input 100/300, cached 50/150), one verifier with two RAN lines, a `too_hard` stop → worker `{ dispatches: 2, briefBytes: { median: 20480, max: 30720 }, cacheHit: 0.5, stops: { too_hard: 1 } }`, verifier `verifierRan: 2`.
Test: test/services/run-report.test.ts — "the report has a scorecard" — a finished run's report holds `## Scorecard` and a `worker` row.

### Task 21: ideas.md and the changeset

Files: docs/dev/ideas.md, .changeset/plan-44-decision-model.md

ideas.md: remove the entries this plan did (role briefs, verifier evidence, failure class, test guard, decision model, Honcho in roles); add under "From plan 44": the milestone Check's failure class (D9), several decision models voting (spec non-goal), a clamp for opencode and cursor when they gain a setting (D12), measuring the scorecard targets on a live run (B16: worker brief median under 20 KB, no verifier PASS without executed commands, zero stops from another role's duty). The changeset: `"catherd-cli": major`, "Part of 2.0.0. A decision model picks the rung of every dispatch …" with the four-part briefs, the verifier's RAN lines, the failure class, the test guard, the harness clamps, the migration, and the removed `jev`, `bars`, `objective`, climb and cheap try (D34).

Test: none (prose) — the lane's check runs the format check and asserts the changeset names catherd-cli.

### M6 lanes

- M6.L1 — Task 20 — owns src/services/run-scorecard.ts, src/services/run-report.ts, test/services/run-scorecard.test.ts, test/services/run-report.test.ts — fast check: `bun test test/services/run-scorecard.test.ts test/services/run-report.test.ts && bun run typecheck && bun run lint`
- M6.L2 — Task 21 — chore — after M6.L1 — owns docs/dev/ideas.md, .changeset/plan-44-decision-model.md — fast check: `bun run format:check && grep -q catherd-cli .changeset/plan-44-decision-model.md`

## Edge cases

- A role with one usable rung: N = 1, no call, `source: "floor"`, every round.
- A floor rung the profile no longer lists (edited mid-run): `aboveFloor` finds no level for it and keeps every level (no floor), the why says so.
- A floor on a held quota: the held rung leaves the list; the floor's level keeps its other rungs, else the next level up.
- Every rung of a role held: `decision.failed` E_ALL_HELD, waits until the first hold ends.
- A coordinator answer `codex:gpt-6-sol#high please` → the first word is the rung; `Sol high` (no rung) → parked again.
- A decision park on a milestone with two names failing (reviewer and ui-reviewer): one park names the first; the answer applies to it; the other decides again after.
- A daemon that dies after writing the decision brief and before `decision.made`: the key is forgotten, the next decide writes the same `n`'s file again and appends one event.
- A resumed thread whose decision file is gone (cleaned): `brief-full.md` falls back to `renderBrief(…, false)`; the hash check applies to fresh threads only.
- A verifier brief with no `RUN:` line (catherd's Check passed): a PASS needs no RAN line.
- A verifier RAN log path outside the tree and not absolute: read relative to the tree; missing → FAIL naming the path.
- A test file a lane owns by folder (`test/`): never guarded.
- A harness answer below 0.8: the rule's fallback, `product`.
- A brief with a secret-shaped string: scrubbed in the decision state only; the role's brief is the file as rendered (the role works in the repo that holds it).
- A lane file with `Chore: yes`: parsed, ignored.
- A 1.5 credentials file with both keys: `decisionKey` wins, `typesafeApiKey` is removed.
- A profile whose `decision.minConfidence` is 1: only a certain answer is "sure"; the cumulative rule decides the rest.
- An old run's routes.jsonl with `climb` rows: `laneOutcome` still counts them as climbs.

## Out of scope

- Several decision models voting, choosing a backend CLI inside the gateway (spec non-goals).
- Classing the milestone Check's failures (D9).
- Any change to how a vendor CLI is configured beyond D12's env and flags (native harness).
- The owner's own profile on the shared run host and the Mac: the coordinator sets `decision` there; no code or doc names it.
- The live scorecard run and its targets (B16's measurement is the owner's run; M6 writes the report).
- The 1.x `dispatch` path beyond D31.
