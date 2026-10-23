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
  paused: null,
  totals: {
    dispatches: 3,
    tokens: { input: 30_000, cached: 0, cacheWrite: 0, output: 4_000 },
    costUsd: 1.5,
    unpriced: 0,
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
  expect(await screen.findByText("Live runs, open questions and the last 30 days.")).toBeInTheDocument();
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

test("the range reads as one sheet of figures and four tiles", async () => {
  renderRoute("/", serve(overview()));
  const runs = (await screen.findByText("Runs", { selector: "dt" })).closest("dl")!;
  for (const [label, value] of [
    ["Runs", "5"],
    ["Finished alone", "75%"],
    ["Median time", "42 min"],
    ["Interventions", "2"],
    ["Cost", "$12.40"],
    ["Tokens", "1.2M"],
  ] as const) {
    const cell = within(runs).getByText(label, { selector: "dt" }).parentElement!;
    expect(within(cell).getByText(value)).toBeInTheDocument();
  }
  expect(within(runs).getByText("3 of 4 without you")).toBeInTheDocument();
  expect(runs.querySelectorAll("[data-slot='sparkline']")).toHaveLength(0);

  const models = screen.getByRole("list", { name: "Tokens by model" });
  expect(within(models).getByText("GPT-6 Sol")).toBeInTheDocument();
  expect(within(models).getByText("900k")).toBeInTheDocument();
  const roles = screen.getByRole("list", { name: "Time by role" });
  expect(within(roles).getByText("Worker")).toBeInTheDocument();
  expect(within(roles).getByText("1h 20m")).toBeInTheDocument();
  const recoveries = screen.getByText("Recoveries").closest("section")!;
  expect(within(recoveries).getByText("Failovers")).toBeInTheDocument();
  expect(within(recoveries).getByText("1")).toBeInTheDocument();
  expect(within(recoveries).getByText("2")).toBeInTheDocument();
  const perDay = screen.getByText("Cost per day").closest("section")!;
  expect(within(perDay).getByRole("list", { name: "Backends" })).toHaveTextContent("Codex");
  expect(within(perDay).getByText("$2.00")).toBeInTheDocument();
});

test("spend and tokens carry their daily line once there are days to draw", async () => {
  const two = [
    { day: "2026-10-22", backends: [{ backend: "codex", tokens: 50, costUsd: 1 }] },
    { day: "2026-10-23", backends: [{ backend: "codex", tokens: 100, costUsd: 2 }] },
  ];
  renderRoute("/", serve(overview({ daily: two })));
  const sheet = (await screen.findByText("Runs", { selector: "dt" })).closest("dl")!;
  expect(sheet.querySelectorAll("[data-slot='sparkline']")).toHaveLength(2);
});

test("nothing live and nothing waiting each say so in one line", async () => {
  renderRoute("/", serve(overview({ live: [], questions: { total: 0, first: [] } })));
  expect(
    await screen.findByText("Nothing is running. Start a run from Claude Code or Codex with /catherd."),
  ).toBeInTheDocument();
  expect(screen.getByText("Nothing is waiting for you.")).toBeInTheDocument();
});

test("recent runs list each run with its status and open the run", async () => {
  renderRoute("/", serve(overview()));
  const recent = await screen.findByRole("grid", { name: "Recent runs" });
  expect(within(recent).getByRole("link", { name: "older run" })).toHaveAttribute("href", "/runs/r0");
  const row = within(recent).getAllByRole("row")[1]!;
  expect(within(row).getByText("Done")).toBeInTheDocument();
  for (const figure of ["30 min", "34k", "$1.50", "1/4"]) expect(within(row).getByText(figure)).toBeInTheDocument();
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
  await userEvent.click(within(waiting).getByRole("button", { name: "Answer" }));
  await userEvent.type(within(waiting).getByRole("textbox", { name: "Your answer" }), "keep it");
  await userEvent.click(within(waiting).getByRole("button", { name: "Send answer" }));
  const post = await vi.waitFor(() => {
    const r = requests.find((x) => describeRequest(x) === "POST /api/runs/r1/answers");
    if (!r) throw new Error("not yet");
    return r;
  });
  expect(await post.clone().json()).toEqual({ unit: "M1.L2", answer: "keep it" });
});

test("unknown costs and unpriced runs appear across dashboard cards", async () => {
  const data = overview();
  data.kpis.costUsd = null;
  const unknown = card({ totals: { ...card().totals, costUsd: null, unpriced: 2 } });
  data.live = [{ run: unknown, now: [] }];
  data.recent = [unknown];
  renderRoute("/", serve(data));
  expect(await screen.findAllByText("—")).toHaveLength(3);
  expect(screen.getAllByText("2 unpriced")).toHaveLength(2);
});
