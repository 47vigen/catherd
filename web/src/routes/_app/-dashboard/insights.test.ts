import type { Overview, RunCard } from "../../../client";
import { rangeFindings } from "./insights";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const card = (id: string, over: Partial<RunCard> = {}, totals: Partial<RunCard["totals"]> = {}): RunCard => ({
  id,
  title: id,
  repo: "/r",
  engine: "2.0",
  phase: "ended",
  outcome: "done",
  startedAt: "2026-10-30T10:00:00Z",
  endedAt: "2026-10-30T11:00:00Z",
  wallMinutes: 20,
  milestones: { total: 0, landed: 0 },
  live: [],
  openQuestions: 0,
  paused: null,
  totals: {
    dispatches: 1,
    tokens: { input: 0, cached: 0, cacheWrite: 0, output: 0 },
    costUsd: 1,
    unpriced: 0,
    interventions: 0,
    failovers: 0,
    climbs: 0,
    rounds: 1,
    ...totals,
  },
  byBackend: [],
  byModel: [],
  byRole: [],
  ...over,
});
const overview = (recent: RunCard[], over: Partial<Overview> = {}) =>
  ({
    recent,
    questions: { total: 0, first: [] },
    failovers: 0,
    climbs: 0,
    kpis: { interventions: 0 },
    ...over,
  }) as Overview;

test("an ordinary week says nothing", () => {
  expect(rangeFindings(overview([card("a"), card("b"), card("c")]), NOW)).toEqual([]);
});

test("failures come first, then a long wait, then the outliers", () => {
  const runs = [
    card("a", { outcome: "failed" }),
    card("b", { wallMinutes: 90 }, { costUsd: 8 }),
    card("c"),
    card("d", {}, { interventions: 3 }),
  ];
  const waited = {
    run: "d",
    runTitle: "d",
    unit: "T1",
    question: "Keep it?",
    reason: "owner",
    at: "2026-10-31T10:00:00Z",
    command: "",
  };
  const f = rangeFindings(overview(runs, { questions: { total: 1, first: [waited as never] } }), NOW);
  expect(f.map((x) => x.id)).toEqual(["failed", "waiting", "cost", "long", "needy"]);
  expect(f.find((x) => x.id === "cost")?.title).toBe("b took 73% of the spend");
  expect(f.find((x) => x.id === "waiting")?.title).toBe("A question has waited 2h 00m");
});
