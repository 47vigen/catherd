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
import type { DoctorReport } from "../../services/doctor.ts";
import type { RunSummary } from "../../services/summary.ts";
import { CHANGED_ON_DISK, type Effects, type RunDetail, type RunRow, rowOf } from "./effects.ts";
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
    { id: "mcp", label: "MCP server", state: "ok", word: "ready", detail: "20 tools" },
  ],
};

const summary = (o: Partial<RunSummary> & Pick<RunSummary, "id" | "title">): RunSummary => ({
  repo: "/home/me/app",
  createdAt: "2026-09-26T11:48:00.000Z",
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
  budget: null,
  milestones: [],
  warnings: [],
  ...o,
});

export const FIXTURE_RUNS: RunDetail[] = [
  {
    summary: summary({
      id: "20260926-114800-jobs-screen",
      title: "Jobs screen",
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
    climbs: [
      {
        lane: "M1.L2",
        from: "codex:gpt-6-luna#high",
        to: "codex:gpt-6-sol#medium",
        reason: "refused",
        env: false,
      },
    ],
    decisions: [
      {
        lane: "M1.L1",
        role: "worker",
        source: "lane",
        kind: "repo_code",
        difficulty: "copy",
        rung: "codex:gpt-6-luna#high",
      },
      {
        lane: "M1.L2",
        role: "worker",
        source: "lane",
        kind: "repo_code",
        difficulty: "build",
        rung: "codex:gpt-6-luna#high",
      },
    ],
  },
  {
    summary: summary({
      id: "20260925-090000-auth-refactor",
      title: "Auth refactor",
      repo: "/home/me/api",
      createdAt: "2026-09-25T09:00:00.000Z",
      stateTail: ["Next: done"],
      totals: {
        runs: 9,
        ok: 8,
        notOk: ["worker-M2.L1 (limit)"],
        tokens: { input: 3_100_000, cached: 2_400_000, output: 160_000 },
        costUsd: 1.84,
        wallMinutes: 96,
      },
      milestones: [
        "M1 | tokens | a1 | 30 | ok",
        "M2 | sessions | b2 | 41 | ok",
        "M3 | cleanup | c3 | 25 | ok",
      ],
    }),
    climbs: [],
    decisions: [],
  },
];

export const fixtureRow = (d: RunDetail): RunRow => rowOf(d.summary);

const BACKENDS = ["claude", "codex", "claude-code", "opencode"];

/**
 * Effects over the fixtures; profile writes stay in memory and are recorded in `writes`. `repo` is the
 * directory the TUI stands in and `bindings` the repo bindings, as `liveEffects(repo)` reads them.
 */
export function fixtureEffects(
  o: {
    runs?: RunDetail[];
    report?: DoctorReport;
    repo?: string;
    bindings?: Record<string, string>;
  } = {},
): Effects & { writes: string[] } {
  const runs = o.runs ?? FIXTURE_RUNS;
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
    version: "1.0.0",
    doctor: async () => o.report ?? FIXTURE_REPORT,
    runs: () => ({ rows: runs.map(fixtureRow), warnings: [] }),
    run(id) {
      const d = runs.find((r) => r.summary.id === id);
      if (!d) throw new Error(`no run "${id}"`);
      return d;
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
    activate(name) {
      const r = bound();
      if (r) {
        bindings.set(r, name);
        writes.push(`bind ${name} ${r}`);
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
