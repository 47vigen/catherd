import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Overview, RunCard } from "../../client";
import { client } from "../../client/client.gen";
import { describeRequest, renderRoute } from "../../test/render-route";

afterEach(() => client.setConfig({ baseUrl: "", fetch: undefined }));

const card = (over: Partial<RunCard> = {}): RunCard => ({
  id: "r1",
  title: "wallet split",
  repo: "/home/user/code/shop",
  engine: "2.0",
  phase: "running",
  outcome: null,
  startedAt: new Date(Date.now() - 90_000).toISOString(),
  endedAt: null,
  wallMinutes: null,
  milestones: { total: 4, landed: 1 },
  live: [],
  openQuestions: 0,
  totals: {
    dispatches: 3,
    tokens: { input: 30_000, cached: 0, output: 4_000 },
    costUsd: 1.5,
    interventions: 0,
    failovers: 0,
    climbs: 0,
    rounds: 1,
  },
  byBackend: [{ backend: "codex", tokens: 34_000, costUsd: 1.5 }],
  byModel: [],
  byRole: [],
  ...over,
});

const parked = {
  run: "r1",
  runTitle: "wallet split",
  unit: "M1.L2",
  question: "Keep the old wallet id?",
  reason: "needs_user" as const,
  at: new Date().toISOString(),
  command: 'catherd answer r1 M1.L2 "<answer>"',
};

const overview = (over: Partial<Overview> = {}): Overview => ({
  from: "2026-10-17T00:00:00.000Z",
  to: "2026-10-23T23:59:59.999Z",
  repo: null,
  repos: ["/home/user/code/shop"],
  kpis: {
    runs: 5,
    ended: 4,
    clean: 3,
    cleanPct: 75,
    medianWallMinutes: 42,
    interventions: 2,
    costUsd: 12.4,
    tokens: 1_240_000,
  },
  daily: [{ day: "2026-10-23", backends: [{ backend: "codex", tokens: 100, costUsd: 2 }] }],
  tokensByModel: [{ model: "gpt-6-sol", tokens: 900_000 }],
  secsByRole: [{ role: "worker", secs: 4800 }],
  failovers: 1,
  climbs: 2,
  live: [
    {
      run: card({ openQuestions: 1 }),
      now: [
        { node: "M1.L1.work", title: "Build lane L1", text: "Writing the wallet module", rung: "codex:gpt-6-sol#high" },
      ],
    },
  ],
  questions: { total: 1, first: [parked] },
  recent: [
    card({
      id: "r0",
      title: "older run",
      phase: "ended",
      outcome: "done",
      endedAt: new Date().toISOString(),
      wallMinutes: 30,
    }),
  ],
  ...over,
});

const serve = (data: Overview) => (_req: Request, url: URL) =>
  url.pathname === "/api/overview" ? Response.json(data) : undefined;

test("the range and the repo reach the overview query", async () => {
  const { requests } = renderRoute("/?days=30&repo=%2Ftmp%2Fmy%20repo", serve(overview()));
  expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
  const asked = requests.map(describeRequest).find((r) => r.startsWith("GET /api/overview"))!;
  const q = new URL(asked, "http://x").searchParams;
  expect(q.get("repo")).toBe("/tmp/my repo");
  expect(asked).toContain("repo=%2Ftmp%2Fmy%20repo");
  expect(Date.parse(q.get("to")!) + 1 - Date.parse(q.get("from")!)).toBe(30 * 86_400_000);
  expect(await screen.findByText("The last 30 days")).toBeInTheDocument();
});

test("a live run shows its now line, its provider, its milestones and opens the run", async () => {
  renderRoute("/", serve(overview()));
  const live = (await screen.findByText("Running now")).closest("section")!;
  const run = within(live).getByRole("link", { name: "wallet split" });
  expect(run).toHaveAttribute("href", "/runs/r1");
  expect(within(live).getByText("Build lane L1")).toBeInTheDocument();
  expect(within(live).getByText(/Writing the wallet module · Codex/)).toBeInTheDocument();
  expect(within(live).getByText("shop")).toHaveAttribute("title", "/home/user/code/shop");
  const bar = within(live).getByRole("progressbar", { name: "Milestones landed" });
  expect(bar).toHaveAttribute("aria-valuenow", "1");
  expect(bar).toHaveAttribute("aria-valuemax", "4");
  expect(within(live).getByText("1/4")).toBeInTheDocument();
  expect(within(live).getByText(/^\d+m \d\ds$|^\d+s$/)).toBeInTheDocument();
});

test("every KPI and chart carries its meaning", async () => {
  renderRoute("/", serve(overview()));
  await screen.findByText("The last 7 days");
  for (const text of [
    "Runs started in this range.",
    "Runs that ended done with no answer, approval or cancel from you.",
    "Half the finished runs took less than this.",
    "Times a run needed you: answers, approvals, cancels and pauses.",
    "Dollars the backends reported; subscription plans report none.",
    "Input and output tokens over every dispatch.",
    "Cost and tokens per day by backend: which backends your runs lean on.",
    "Tokens by model: where the tokens go.",
    "Time by role: which roles take the hours.",
    "Failovers and climbs: how often a rung ran out or was too weak.",
  ])
    expect(screen.getByText(text)).toBeInTheDocument();
  expect(screen.getByText("75%")).toBeInTheDocument();
  expect(screen.getByText("42 min")).toBeInTheDocument();
  expect(screen.getByText("$12.40")).toBeInTheDocument();
  expect(screen.getByText("1.2M")).toBeInTheDocument();
});

test("recent runs list each run with its status and open the run", async () => {
  renderRoute("/", serve(overview()));
  const recent = (await screen.findByText("Recent runs")).closest("section")!;
  expect(within(recent).getByRole("link", { name: "older run" })).toHaveAttribute("href", "/runs/r0");
  expect(within(recent).getByText("Done")).toBeInTheDocument();
});

test("with no run the page says what catherd is and how to start", async () => {
  renderRoute("/", serve(overview({ repos: [], live: [], recent: [], questions: { total: 0, first: [] } })));
  expect(
    await screen.findByText(
      "catherd runs a coding task for you: it plans it, has agents write and review the code, and checks the result.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("Start a run from Claude Code or Codex with /catherd.")).toBeInTheDocument();
  expect(screen.queryByText("Running now")).not.toBeInTheDocument();
});

test("a waiting question is answered inline", async () => {
  const { requests } = renderRoute("/", (req, url) =>
    url.pathname === "/api/runs/r1/answers"
      ? Response.json({ unit: "M1.L2", parked: [] })
      : serve(overview())(req, url),
  );
  const waiting = (await screen.findByText("Waiting for you")).closest("section")!;
  expect(within(waiting).getByText("Keep the old wallet id?")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "All questions" })).toHaveAttribute("href", "/questions");
  await userEvent.type(within(waiting).getByRole("textbox", { name: "Your answer" }), "keep it");
  await userEvent.click(within(waiting).getByRole("button", { name: "Send answer" }));
  const post = await vi.waitFor(() => {
    const r = requests.find((x) => describeRequest(x) === "POST /api/runs/r1/answers");
    if (!r) throw new Error("not yet");
    return r;
  });
  expect(await post.clone().json()).toEqual({ unit: "M1.L2", answer: "keep it" });
});
