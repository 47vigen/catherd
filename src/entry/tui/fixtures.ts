import { isDeepStrictEqual } from "node:util";
import {
  applyPatch,
  defaultProfileDoc,
  diffProfiles,
  type ProfileDoc,
  resolveProfile,
} from "../../domain/profile.ts";
import { validateProfile } from "../../domain/profile-rules.ts";
import { catalogQuery, loadCatalog } from "../../services/catalog-service.ts";
import type { RunRecord } from "../../domain/record.ts";
import type { DoctorReport } from "../../services/doctor.ts";
import type { RunSummary } from "../../services/summary.ts";
import {
  CHANGED_ON_DISK,
  type Effects,
  type RoleDetail,
  type RoleRow,
  rowOf,
  type SessionRow,
  type SessionRun,
} from "./effects.ts";
import { withStaged } from "./profile-tree.ts";

/**
 * Fixed data for the storybook (CATHERD_STORY=1), the frame snapshots and the view tests: a setup with
 * one backend missing and one not logged in, two runs (one live), and profiles kept in memory. Only
 * the catalog is the shipped one, read through the catalog service.
 */
export const FIXTURE_REPORT: DoctorReport = {
  ready: false,
  version: "1.0.0",
  checks: [
    { id: "bun", label: "Bun", state: "ok", word: "ready", detail: "1.4.2" },
    { id: "config", label: "config", state: "ok", word: "ready", detail: "active profile default" },
    { id: "profile", label: "profile default", state: "ok", word: "ready", detail: "valid" },
    {
      id: "backend:codex",
      label: "codex",
      state: "ok",
      word: "ready",
      detail: "0.156.1, logged in, 14 models",
    },
    {
      id: "backend:claude-code",
      label: "claude-code",
      state: "ok",
      word: "ready",
      detail: "2.1.282, logged in, 6 models",
    },
    {
      id: "backend:opencode",
      label: "opencode",
      state: "warn",
      word: "not logged in",
      detail: "2.0.16 (a failover stand-in uses it)",
      fix: "opencode auth login",
    },
    {
      id: "jev",
      label: "Jev",
      state: "skip",
      word: "no key",
      detail: "optional: routing uses the lane files",
    },
    {
      id: "plugin",
      label: "Claude Code plugin",
      state: "fail",
      word: "missing",
      detail: "not installed",
      fix: "claude plugin marketplace add 47vigen/catherd && claude plugin install catherd@catherd",
    },
    { id: "agents", label: "Claude agents", state: "ok", word: "ready", detail: "2 linked" },
    { id: "mcp", label: "MCP server", state: "ok", word: "ready", detail: "21 tools" },
  ],
};

const summary = (o: Partial<RunSummary> & Pick<RunSummary, "id" | "title">): RunSummary => ({
  repo: "/home/me/app",
  createdAt: "2026-09-26T11:48:00.000Z",
  session: null,
  continuedIn: null,
  stateTail: [],
  live: [],
  totals: {
    runs: 0,
    ok: 0,
    notOk: [],
    tokens: { input: 0, cached: 0, output: 0 },
    costUsd: 0,
    wallMinutes: 12,
  },
  agents: { runs: 0, totalTokens: 0, costUsd: 0 },
  jev: { decisions: 0, fallbacks: 0 },
  harness: [],
  budget: null,
  milestones: [],
  verifier: null,
  questions: [],
  warnings: [],
  ...o,
});

const JOBS = "20260926-114800-jobs-screen";
const AUTH = "20260925-090000-auth-refactor";
const PLAN4 = "20260924-080000-auth-plan-4";

const FIXTURE_RUNS: RunSummary[] = [
  summary({
    id: JOBS,
    title: "Jobs screen",
    session: { sessionId: "s-jobs", hostSessionId: null, name: "jobs screen", live: true },
    stateTail: ["M1 in review", "Next: fix round for M1.L2"],
    live: [
      {
        name: "worker-M1.L2",
        rung: "codex:gpt-6-sol#medium",
        state: "running",
        secs: 252,
        dispatchId: "d2",
      },
      { name: "reviewer-M1", rung: "codex:gpt-6-sol#high", state: "starting", secs: 4, dispatchId: "d3" },
    ],
    totals: {
      runs: 3,
      ok: 3,
      notOk: [],
      tokens: { input: 812_000, cached: 640_000, output: 41_000 },
      costUsd: 0,
      wallMinutes: 12,
    },
    jev: { decisions: 2, fallbacks: 0 },
    budget: { fraction: 0.52, minutes: { spent: 31, cap: 60 } },
    milestones: ["M0 | scaffold the jobs screen | 3f2a9c1 | 9 | bun test test/jobs"],
  }),
  summary({
    id: AUTH,
    title: "Auth refactor",
    repo: "/home/me/api",
    createdAt: "2026-09-25T09:00:00.000Z",
    session: { sessionId: "s-auth", hostSessionId: null, name: "auth build", live: false },
    continuedIn: "kit follow-up",
    stateTail: ["Next: done"],
    totals: {
      runs: 9,
      ok: 8,
      notOk: ["worker-M2.L1 (limit)"],
      tokens: { input: 3_100_000, cached: 2_400_000, output: 160_000 },
      costUsd: 1.84,
      wallMinutes: 96,
    },
    milestones: ["M1 | tokens | a1 | 30 | ok", "M2 | sessions | b2 | 41 | ok", "M3 | cleanup | c3 | 25 | ok"],
  }),
];

/** A role of the fixtures; `since` minutes before the fixed clock (2026-09-26 12:00 UTC) for a live one. */
const role = (o: Partial<RoleRow> & Pick<RoleRow, "run" | "dispatchId" | "name" | "rung">): RoleRow => ({
  role: o.name.split("-")[0] ?? "worker",
  status: "ok",
  live: false,
  since: "2026-09-26T11:48:10.000Z",
  secs: null,
  lastEvent: null,
  replyStatus: "complete",
  ...o,
});

const auth = (continued: SessionRun["continued"]): SessionRun => ({
  id: AUTH,
  title: "Auth refactor",
  repo: "/home/me/api",
  createdAt: "2026-09-25T09:00:00.000Z",
  continued,
  continuedIn: continued === "elsewhere" ? "kit follow-up" : null,
  budget: null,
  milestones: [
    { name: "M1", landed: true, what: "tokens" },
    { name: "M2", landed: true, what: "sessions" },
    { name: "M3", landed: true, what: "cleanup" },
  ],
  roles: [
    role({ run: AUTH, dispatchId: "a3", name: "reviewer-M3", rung: "codex:gpt-6-sol#high", secs: 188 }),
    role({ run: AUTH, dispatchId: "a2", name: "worker-M3.L1", rung: "codex:gpt-6-luna#high", secs: 402 }),
    role({
      run: AUTH,
      dispatchId: "a1",
      name: "worker-M2.L1",
      rung: "codex:gpt-6-sol#medium",
      status: "limit",
      secs: 95,
      replyStatus: null,
    }),
  ],
});

/** The Runs tab's sessions: a live one with three live roles, one whose run another session continued, and it. */
export const FIXTURE_SESSIONS: { row: SessionRow; runs: SessionRun[] }[] = [
  {
    row: {
      key: "s-jobs",
      name: "jobs screen",
      live: true,
      runs: 1,
      liveRoles: 3,
      landed: 1,
      lastActivity: "2026-09-26T11:59:40.000Z",
    },
    runs: [
      {
        id: JOBS,
        title: "Jobs screen",
        repo: "/home/me/app",
        createdAt: "2026-09-26T11:48:00.000Z",
        continued: null,
        continuedIn: null,
        budget: 0.52,
        milestones: [
          { name: "M0", landed: true, what: "scaffold the jobs screen" },
          { name: "M1", landed: false, what: "" },
        ],
        roles: [
          role({
            run: JOBS,
            dispatchId: "d2",
            name: "worker-M1.L2",
            rung: "codex:gpt-6-sol#medium",
            status: "running",
            live: true,
            since: "2026-09-26T11:55:48.000Z",
            lastEvent: "$ bun test test/jobs --bail",
            replyStatus: null,
          }),
          role({
            run: JOBS,
            dispatchId: "d4",
            name: "worker-M1.L3",
            rung: "codex:gpt-6-luna#high",
            status: "running",
            live: true,
            since: "2026-09-26T11:57:00.000Z",
            lastEvent: "edit src/jobs/list.tsx",
            replyStatus: null,
          }),
          role({
            run: JOBS,
            dispatchId: "d3",
            name: "reviewer-M1",
            rung: "codex:gpt-6-sol#high",
            status: "starting",
            live: true,
            since: "2026-09-26T11:59:56.000Z",
            replyStatus: null,
          }),
          role({
            run: JOBS,
            dispatchId: "d1",
            name: "worker-M1.L1",
            rung: "codex:gpt-6-luna#high",
            secs: 312,
          }),
        ],
      },
    ],
  },
  {
    row: {
      key: "s-kit",
      name: "kit follow-up",
      live: false,
      runs: 1,
      liveRoles: 0,
      landed: 3,
      lastActivity: "2026-09-25T11:20:00.000Z",
    },
    runs: [auth("here")],
  },
  {
    row: {
      key: "s-auth",
      name: "auth build",
      live: false,
      runs: 2,
      liveRoles: 0,
      landed: 5,
      lastActivity: "2026-09-25T10:36:00.000Z",
    },
    runs: [
      auth("elsewhere"),
      {
        id: PLAN4,
        title: "Auth plan 4",
        repo: "/home/me/api",
        createdAt: "2026-09-24T08:00:00.000Z",
        continued: null,
        continuedIn: null,
        budget: null,
        milestones: [
          { name: "M1", landed: true, what: "schema" },
          { name: "M2", landed: true, what: "handlers" },
        ],
        roles: [
          role({
            run: PLAN4,
            dispatchId: "p2",
            name: "reviewer-M2",
            rung: "codex:gpt-6-sol#high",
            secs: 140,
          }),
          role({
            run: PLAN4,
            dispatchId: "p1",
            name: "worker-M2.L1",
            rung: "codex:gpt-6-sol#medium",
            secs: 610,
          }),
        ],
      },
    ],
  },
];

/** The role screen's text: the brief, the reply and the record behind worker-M1.L1 of the jobs screen. */
const FIXTURE_ROLE: Omit<RoleDetail, "run" | "runTitle" | "dispatchId" | "name" | "role" | "rung" | "state"> =
  {
    brief:
      "Read /home/me/.local/share/catherd/runs/jobs-screen/lanes/M1.L1.md\nFast check: bun test test/jobs/list",
    reply:
      "Done: the list renders every job with its state.\nsrc/jobs/list.tsx:12 — the list\nsrc/jobs/list.test.tsx:4 — its test\nSTATUS: complete — list in place, fast check green",
    record: null,
  };

/** The record a finished fixture role would have: what the role screen shows under RECORD. */
function fixtureRecord(r: SessionRun, x: RoleRow): RunRecord {
  const start = Date.parse(x.since);
  return {
    schema: 1,
    runId: r.id,
    dispatchId: x.dispatchId,
    name: x.name,
    role: x.role,
    lane: x.name.includes("-M") && x.name.includes(".") ? x.name.slice(x.name.indexOf("-") + 1) : null,
    backend: x.rung.slice(0, x.rung.indexOf(":")),
    rung: x.rung,
    attempt: 1,
    failoverFrom: null,
    thread: "01a0d0d4-d0a6-71a1-983c-82a9169200b4",
    status: x.status as RunRecord["status"],
    startedAt: x.since,
    endedAt: new Date(start + (x.secs ?? 0) * 1000).toISOString(),
    secs: x.secs ?? 0,
    exitCode: 0,
    signal: null,
    cliVersion: "0.157.0",
    tokens: { input: 812_000, cached: 640_000, output: 41_000 },
    costUsd: null,
    changedOwned: ["src/jobs/list.tsx", "src/jobs/list.test.tsx"],
    violations: [],
    replyStatus: x.replyStatus as RunRecord["replyStatus"],
    replyWhy: x.replyStatus ? "list in place, fast check green" : null,
    threadHeavy: false,
    access: "workspace-write",
    isolated: false,
    images: [],
    error: null,
    replyPath: `roles/${x.name}/${x.dispatchId}/reply.md`,
  };
}

const BACKENDS = ["claude", "codex", "claude-code", "opencode"];

/**
 * Effects over the fixtures; profile writes stay in memory and are recorded in `writes`. `repo` is the
 * directory the TUI stands in and `bindings` the repo bindings, as `liveEffects(repo)` reads them.
 */
export interface FixtureOptions {
  runs?: RunSummary[];
  sessions?: { row: SessionRow; runs: SessionRun[] }[];
  report?: DoctorReport;
  repo?: string;
  bindings?: Record<string, string>;
  /** false: the run folders cannot be watched here, as on a platform without fs.watch */
  watchable?: boolean;
}

export function fixtureEffects(o: FixtureOptions = {}): Effects & {
  writes: string[];
  /** what a change to a watched run file does: every open watch hears of it */
  touch(): void;
  /** the run folders watched now */
  watched: string[][];
} {
  const runs = o.runs ?? FIXTURE_RUNS;
  const sessions = o.sessions ?? FIXTURE_SESSIONS;
  const listeners = new Set<() => void>();
  const watched: string[][] = [];
  const docs = new Map<string, ProfileDoc>([["default", defaultProfileDoc()]]);
  let active = "default";
  const bindings = new Map(Object.entries(o.bindings ?? {}));
  const bound = () => (o.repo && bindings.has(o.repo) ? o.repo : null);
  const writes: string[] = [];
  /** what the ProfileService returns for writing `after` over `before` */
  const result = (
    name: string,
    before: ProfileDoc,
    after: ProfileDoc,
    staged: Record<string, string> = {},
  ) => {
    const p = resolveProfile(after, name);
    const v = validateProfile(p, withStaged(loadCatalog({ timings: false }), staged), BACKENDS);
    return {
      saved: v.errors.length === 0,
      ...v,
      diff: diffProfiles(resolveProfile(before, name), p),
      linked: [],
      pruned: [],
      newSessionNeededFor: [],
    };
  };
  return {
    writes,
    watched,
    touch: () => {
      for (const l of listeners) l();
    },
    version: "1.0.0",
    doctor: async () => o.report ?? FIXTURE_REPORT,
    runs: () => ({ rows: runs.map(rowOf), warnings: [] }),
    sessions: () => ({ rows: sessions.map((x) => x.row), warnings: [] }),
    session(key) {
      const x = sessions.find((y) => y.row.key === key);
      if (!x) throw new Error(`no session "${key}"`);
      return { session: x.row, runs: x.runs, dirs: x.runs.map((r) => `/runs/${r.id}`) };
    },
    role(run, dispatchId) {
      for (const x of sessions)
        for (const r of x.runs) {
          const role = r.id === run ? r.roles.find((y) => y.dispatchId === dispatchId) : undefined;
          if (!role) continue;
          return {
            run,
            runTitle: r.title,
            dispatchId,
            name: role.name,
            role: role.role,
            rung: role.rung,
            state: role.live ? role.status : "finished",
            brief: FIXTURE_ROLE.brief,
            reply: role.live ? "" : FIXTURE_ROLE.reply,
            record: role.live ? null : fixtureRecord(r, role),
          };
        }
      throw new Error(`no dispatch ${dispatchId} in run ${run}`);
    },
    watch(dirs, onChange) {
      if (o.watchable === false) return null;
      watched.push(dirs);
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
        watched.splice(watched.indexOf(dirs), 1);
      };
    },
    async cancel(run, name) {
      writes.push(`cancel ${run} ${name}`);
      return `${name} cancelled`;
    },
    profiles: () => ({
      names: [...docs.keys()].sort(),
      active,
      here: bindings.get(o.repo ?? "") ?? active,
      repo: bound(),
    }),
    readProfile(name) {
      const d = docs.get(name);
      if (!d) throw new Error(`no profile named "${name}"`);
      return d;
    },
    catalog: (billing) => ({
      catalog: loadCatalog({ timings: false }),
      models: catalogQuery({ scoredOnly: false, limit: Number.MAX_SAFE_INTEGER }, billing).models,
    }),
    validate: (p, c) => validateProfile(p, c, BACKENDS),
    enforcement: (rung) => (rung.startsWith("codex:") ? "enforced" : "advisory"),
    harnesses: ["codex", "claude-code", "opencode"],
    agents: (p) =>
      (["architect", "verifier"] as const)
        .filter((r) => p.roles[r].enabled)
        .flatMap((r) =>
          p.roles[r].rungs
            .filter((x) => x.startsWith("claude:"))
            .map((x) => `catherd-${p.name}-${r}-${x.slice(7).replace("#", "-")}`),
        ),
    async save(name, patch, treatLikes, shown) {
      const before = docs.get(name) ?? defaultProfileDoc(name);
      // the ProfileService's compare-and-swap: nothing is written over a profile the preview did not show
      if (shown !== undefined && !isDeepStrictEqual(before, shown))
        return {
          saved: false,
          errors: [
            {
              path: CHANGED_ON_DISK,
              message: `profile "${name}" changed on disk since it was shown`,
              fix: "check the changes and save again",
            },
          ],
          warnings: [],
          diff: [],
          linked: [],
          pruned: [],
          newSessionNeededFor: [],
        };
      const after = applyPatch(before, patch);
      const r = result(name, before, after, treatLikes);
      if (r.saved) {
        docs.set(name, after);
        const tl = Object.keys(treatLikes).length ? ` ${JSON.stringify(treatLikes)}` : "";
        writes.push(`save ${name} ${JSON.stringify(patch)}${tl}`);
      }
      return r;
    },
    activate(name, repo) {
      if (repo !== null) {
        bindings.set(repo, name);
        writes.push(`bind ${name} ${repo}`);
      } else {
        active = name;
        writes.push(`activate ${name}`);
      }
      return {
        linked: [],
        pruned: [],
        newSessionNeededFor: [`catherd-${name}-architect-claude-opus-5-5-high`],
      };
    },
    create(name, from) {
      const doc = { ...(from ? (docs.get(from) as ProfileDoc) : defaultProfileDoc(name)), name };
      const r = result(name, doc, doc);
      if (r.saved) {
        docs.set(name, doc);
        writes.push(`create ${name}${from ? ` from ${from}` : ""}`);
      }
      return r;
    },
    remove(name) {
      if (name === active) throw new Error(`"${name}" is the active profile`);
      const at = [...bindings].find(([, p]) => p === name);
      if (at) throw new Error(`"${name}" is bound to ${at[0]}`);
      docs.delete(name);
      writes.push(`remove ${name}`);
      return { linked: [], pruned: [], newSessionNeededFor: [] };
    },
    async refreshCatalog() {
      writes.push("refresh");
      return [{ backend: "codex", models: 14, fetchedAt: "2026-09-26T12:00:00.000Z" }];
    },
  };
}
