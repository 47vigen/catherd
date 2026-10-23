import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { RunModel } from "../../../client";
import { client } from "../../../client/client.gen";
import { configureClient } from "../../../lib/api";
import { getSocket, stopWebSocket } from "../../../lib/live-socket";
import { describeRequest, renderRoute } from "../../../test/render-route";
import { CASE_HELPERS } from "./-lib/case-helpers.fixture";
import { nowLine, STATUS_LABEL } from "./-lib/node-view";

class FakeSocket {
  static last: FakeSocket | undefined;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

// jsdom has no layout: say whether the window is a desktop one (the graph) or a phone (the list of steps).
const screenIs = (desktop: boolean) => {
  window.matchMedia = (query: string) =>
    ({
      matches: desktop,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
};

beforeEach(() => {
  FakeSocket.last = undefined;
  vi.stubGlobal("WebSocket", FakeSocket);
  screenIs(true);
});
afterEach(() => {
  stopWebSocket();
  vi.unstubAllGlobals();
  client.setConfig({ baseUrl: "", fetch: undefined });
});

const now = () => new Date().toISOString();
const run = (over: object = {}) => ({
  id: "r1",
  title: "wallet split",
  repo: "/work/wallet",
  engine: "2.0",
  phase: "running",
  outcome: null,
  daemon: { alive: true, pid: 99, beatAgeSec: 3 },
  milestones: [{ id: "M1", title: "Split the wallet", status: "lanes", round: 1, commit: null }],
  live: [{ name: "worker-M1.L1", role: "worker", rung: "codex:gpt-6-luna#high", unit: "M1.L1", since: now() }],
  parked: [],
  holds: [],
  last: "M1 routed",
  paused: null,
  startedAt: now(),
  updatedAt: now(),
  ...over,
});
const card = (over: object = {}) => ({
  id: "r1",
  title: "wallet split",
  repo: "/work/wallet",
  engine: "2.0",
  phase: "running",
  outcome: null,
  startedAt: now(),
  endedAt: null,
  wallMinutes: null,
  milestones: { total: 2, landed: 1 },
  live: [{ name: "worker-M2.L1", role: "worker", rung: "codex:gpt-6-sol#high", unit: "M2.L1" }],
  openQuestions: 1,
  totals: {
    dispatches: 3,
    tokens: { input: 0, cached: 0, output: 0 },
    costUsd: 0,
    interventions: 0,
    failovers: 0,
    climbs: 0,
    rounds: 1,
  },
  byBackend: [],
  byModel: [],
  byRole: [],
  ...over,
});
const entry = (seq: number, type: string, text: string) => ({ seq, at: now(), type, text });

const LANE = "M1/lane/M1.L1";
const LANE_DISPATCH = CASE_HELPERS.nodes.find((n) => n.id === LANE)!.attempts[0]!.dispatchId!;
const QUESTION = {
  unit: "M1.L1",
  reason: "needs_user" as const,
  question: "Keep the old wallet id?",
};

/** The real case-helpers run, moved to the moment its lane is being built and its review waits for the owner. */
const liveModel = (): RunModel => ({
  ...CASE_HELPERS,
  phase: "running",
  outcome: null,
  nodes: CASE_HELPERS.nodes.map((n) => {
    if (n.id === LANE)
      return {
        ...n,
        status: "running",
        now: "Codex is writing the code for M1.L1",
        endedAt: null,
        attempts: n.attempts.map((a, i) =>
          i === 0 ? { ...a, status: "running", endedAt: null, name: "worker-M1.L1" } : a,
        ),
      };
    if (n.id === "M1/review") return { ...n, status: "parked", now: "Waiting for your answer", question: QUESTION };
    return n;
  }),
});

const detail = (over: object = {}) => ({
  dispatchId: LANE_DISPATCH,
  name: "worker-M1.L1",
  role: "worker",
  unit: "M1.L1",
  lane: "M1.L1",
  rung: "codex:gpt-6-luna#high",
  startedAt: now(),
  endedAt: null,
  status: "running",
  replyStatus: null,
  why: null,
  record: null,
  route: { source: "routes.jsonl", decidedBy: "jev", why: "The cheapest rung that passed before", ladder: [] },
  brief: "# Build M1.L1\n\nSplit the wallet ids.",
  reply: "All three files moved.",
  stderr: null,
  findings: [
    { label: "BLOCKER", text: "Missing await", file: "src/wallet.ts" },
    { label: "NIT", text: "Rename x", file: null },
  ],
  aLines: [
    { id: "A1", pass: true, text: "the wallet splits" },
    { id: "A2", pass: false, text: "ids stay unique" },
  ],
  truncated: [],
  ...over,
});

let model: RunModel;
let runBody: object;
let dispatchBody: object;
beforeEach(() => {
  model = liveModel();
  runBody = run();
  dispatchBody = detail();
});

function api(_req: Request, url: URL) {
  const p = url.pathname;
  if (p === "/api/runs") return Response.json({ items: [card()], total: 1 });
  if (p === "/api/runs/r1") return Response.json(runBody);
  if (p === "/api/runs/r1/model") return Response.json(model);
  if (p === "/api/runs/r1/timeline") {
    const types = url.searchParams.get("types")?.split(",");
    const all = [
      entry(3, "dispatch.started", "worker-M1.L1 started"),
      entry(2, "plan.approved", "plan approved"),
      entry(1, "run.started", "run started"),
    ].filter((e) => !types || types.includes(e.type));
    return Response.json({ items: all, total: all.length });
  }
  if (p.startsWith("/api/runs/r1/dispatches/") && p.endsWith("/stream"))
    return Response.json({ items: [], raw: ['{"type":"system"}', '{"type":"assistant"}'], next: 2, ended: false });
  if (p.startsWith("/api/runs/r1/dispatches/")) return Response.json(dispatchBody);
  if (p === "/api/runs/r1/docs")
    return url.searchParams.get("name") === "plan.md"
      ? Response.json({ name: "plan.md", text: "# The plan\n\nSplit the wallet." })
      : Response.json({ error: { message: "no report", type: "not_found", code: "E_RUN_NOT_FOUND" } }, { status: 404 });
  if (p.startsWith("/api/runs/r1/commits/"))
    return Response.json({
      sha: "7c024b3",
      text: "diff --git a/wallet.ts b/wallet.ts\n+const added = 1;\n-const removed = 0;",
      truncated: false,
      paths: ["wallet.ts"],
    });
  if (p === "/api/runs/r1/checks/M1.L1")
    return Response.json({ lane: "M1.L1", name: "fast check", fast: "lint ok\ntypes ok", full: null, exit: 0 });
}

// A node names its status once: the now line joins only when it says more than the status word.
const nodeButton = (id: string) => {
  const n = model.nodes.find((x) => x.id === id)!;
  const name = [n.title, STATUS_LABEL[n.status], nowLine(n)].filter(Boolean).join(". ");
  return screen.findByRole("button", { name });
};

test("the list query carries the search, the phase and the page", async () => {
  const { requests } = renderRoute("/runs?q=wallet&phase=running&page=2&pageSize=25", api);
  await screen.findByRole("heading", { name: "Runs" });
  await waitFor(() =>
    expect(requests.map(describeRequest)).toContain("GET /api/runs?q=wallet&phase=running&limit=25&offset=25"),
  );
});

test("a row shows the run's repo, questions, milestones, wall time, tokens and cost, and opens the run", async () => {
  const { router } = renderRoute("/runs", (req, url) =>
    url.pathname === "/api/runs"
      ? Response.json({
          items: [
            card({
              wallMinutes: 6.75,
              totals: {
                ...card().totals,
                tokens: { input: 3_740_535, cached: 3_296_610, output: 26_970 },
                costUsd: 1.7259,
              },
              byBackend: [{ backend: "claude-code", tokens: 793_401, costUsd: 1.7259 }],
              byModel: [{ model: "claude-code:claude-opus-5-5", tokens: 793_401 }],
            }),
          ],
          total: 1,
        })
      : api(req, url),
  );
  const title = await screen.findByText("wallet split");
  const row = title.closest<HTMLElement>('[role="row"]')!;
  expect(within(row).getByText("wallet")).toBeInTheDocument();
  expect(within(row).getByText("1 question")).toBeInTheDocument();
  expect(within(row).getByText("1/2")).toBeInTheDocument();
  expect(within(row).getByText("6m 45s")).toBeInTheDocument();
  expect(within(row).getByText("3.8M")).toBeInTheDocument();
  expect(within(row).getByText("$1.73")).toBeInTheDocument();
  expect(within(row).getByLabelText("Models: claude-opus-5-5")).toBeInTheDocument();
  expect(router.state.location.href).toBe("/runs");
  await userEvent.click(row);
  await waitFor(() => expect(router.state.location.pathname).toBe("/runs/r1"));
  expect(router.state.location.href).toBe("/runs/r1");
});

test("an empty list says how a run starts", async () => {
  renderRoute("/runs", (_req, url) =>
    url.pathname === "/api/runs" ? Response.json({ items: [], total: 0 }) : undefined,
  );
  expect(await screen.findByText("No runs yet. Start one from your session with run_start.")).toBeInTheDocument();
});

test("the graph draws every node with its status and now line", async () => {
  renderRoute("/runs/r1", api);
  expect(await screen.findByRole("heading", { name: "wallet split" })).toBeInTheDocument();
  expect(screen.getByText("r1 · /work/wallet")).toBeInTheDocument();
  for (const n of model.nodes) expect(await nodeButton(n.id)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /M1\.L1 worker\. Running\. Codex is writing/ })).toHaveTextContent(
    "round 2",
  );
  expect(screen.getByRole("button", { name: /M1 review\. Waiting for you/ })).toHaveTextContent("Question");
  const list = await screen.findByRole("list", { name: "Timeline" });
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual([
    expect.stringContaining("worker-M1.L1 started"),
    expect.stringContaining("plan approved"),
    expect.stringContaining("run started"),
  ]);
});

test("the header sums tokens and cost and names the run's time", async () => {
  renderRoute("/runs/r1", api);
  await screen.findByRole("heading", { name: "wallet split" });
  await waitFor(() => expect(screen.getByText("Tokens").nextElementSibling?.textContent).toMatch(/M$/));
  expect(screen.getByText("Cost").nextElementSibling).toHaveTextContent("$1.73");
  expect(screen.getByText("Running for")).toBeInTheDocument();
  // one status word, the rounds of the busiest step in each milestone, and how far the steps have got
  expect(screen.getByText("Status").nextElementSibling).toHaveTextContent("Running");
  expect(screen.getByText("Rounds").nextElementSibling).toHaveTextContent("2");
  expect(
    screen.getByText(`${model.nodes.filter((n) => n.status === "done").length}/${model.nodes.length} done`),
  ).toBeInTheDocument();
});

test("the graph is drawn in the app's theme, not React Flow's light default", async () => {
  document.documentElement.classList.add("dark");
  try {
    renderRoute("/runs/r1", api);
    await nodeButton(LANE);
    expect(screen.getByLabelText("Graph of the run")).toHaveClass("dark");
    act(() => document.documentElement.classList.remove("dark"));
    await waitFor(() => expect(screen.getByLabelText("Graph of the run")).toHaveClass("light"));
  } finally {
    document.documentElement.classList.remove("dark");
  }
});

test("clicking a node opens its drawer and deep-links it", async () => {
  const { router } = renderRoute("/runs/r1", api);
  await userEvent.click(await nodeButton(LANE));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("heading", { name: "M1.L1 worker" })).toBeInTheDocument();
  expect(router.state.location.searchStr).toContain("node=M1%2Flane%2FM1.L1&tab=overview");
  // the overview explains the step, names the rung and says why it was chosen
  expect(await within(dialog).findByText("The cheapest rung that passed before")).toBeInTheDocument();
  expect(within(dialog).getByRole("list", { name: "Attempts" })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(router.state.location.searchStr).not.toContain("node="));
});

test("the drawer shows the prompt, the log, the output with findings and A-lines, and the changes", async () => {
  const { requests } = renderRoute(`/runs/r1?node=${encodeURIComponent(LANE)}&tab=prompt`, api);
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText("Split the wallet ids.")).toBeInTheDocument();

  await userEvent.click(within(dialog).getByRole("tab", { name: "Log" }));
  await waitFor(() =>
    expect(requests.map((r) => decodeURIComponent(describeRequest(r)))).toContain(
      `GET /api/runs/r1/dispatches/${LANE_DISPATCH}/stream?from=0&limit=500&raw=0`,
    ),
  );

  await userEvent.click(within(dialog).getByRole("tab", { name: "Output" }));
  const findings = await within(dialog).findByRole("list", { name: "Findings" });
  expect(within(findings).getByText("BLOCKER")).toBeInTheDocument();
  expect(within(findings).getByText("Missing await")).toBeInTheDocument();
  const lines = within(dialog).getByRole("list", { name: "A-lines" });
  expect(within(lines).getByText("PASS")).toBeInTheDocument();
  expect(within(lines).getByText("FAIL")).toBeInTheDocument();
  expect(within(dialog).getByText("All three files moved.")).toBeInTheDocument();

  await userEvent.click(within(dialog).getByRole("tab", { name: "Changes" }));
  expect(await within(dialog).findByText("+const added = 1;")).toBeInTheDocument();
  expect(within(dialog).getByText("The commit is per milestone; this shows this lane's files.")).toBeInTheDocument();
  // the lane's own files only: the lane goes with the request
  expect(
    requests.some((r) => describeRequest(r).includes("/diff?lane=M1.L1") && describeRequest(r).includes("7c024b3")),
  ).toBe(true);
});

test("a check node's drawer shows the check logs and the exit", async () => {
  renderRoute(`/runs/r1?node=${encodeURIComponent("M1/check/M1.L1")}&tab=checks`, api);
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText(/lint ok/)).toBeInTheDocument();
  expect(within(dialog).getByText("0")).toBeInTheDocument();
  expect(within(dialog).getByText("No full check log yet.")).toBeInTheDocument();
});

test("a node whose prompt is missing says so", async () => {
  dispatchBody = detail({ brief: null, reply: null });
  renderRoute(`/runs/r1?node=${encodeURIComponent(LANE)}&tab=prompt`, api);
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText("No prompt was recorded.")).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("tab", { name: "Output" }));
  expect(await within(dialog).findByText("No reply yet.")).toBeInTheDocument();
});

test("a parked node's drawer answers its question", async () => {
  const { requests } = renderRoute(`/runs/r1?node=${encodeURIComponent("M1/review")}&tab=overview`, (req, url) =>
    url.pathname === "/api/runs/r1/answers" ? Response.json({ unit: "M1.L1", parked: [] }) : api(req, url),
  );
  const dialog = await screen.findByRole("dialog");
  const question = within(dialog).getByRole("region", { name: "Question" });
  expect(within(question).getByText("Keep the old wallet id?")).toBeInTheDocument();
  await userEvent.type(within(question).getByRole("textbox", { name: "Your answer" }), "Yes, keep it");
  await userEvent.click(within(question).getByRole("button", { name: "Send answer" }));
  await waitFor(() => expect(requests.map(describeRequest)).toContain("POST /api/runs/r1/answers"));
  const sent = requests.find((r) => r.method === "POST" && r.url.endsWith("/answers"))!;
  expect(await sent.json()).toEqual({ unit: "M1.L1", answer: "Yes, keep it" });
});

test("Pause pauses and Resume resumes", async () => {
  const { requests } = renderRoute("/runs/r1", (req, url) =>
    url.pathname === "/api/runs/r1/pause"
      ? Response.json({ paused: true, since: now() })
      : url.pathname === "/api/runs/r1/resume"
        ? Response.json({ paused: false })
        : api(req, url),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Pause" }));
  await waitFor(() => expect(requests.map(describeRequest)).toContain("POST /api/runs/r1/pause"));
});

test("a paused run says paused and offers Resume", async () => {
  runBody = run({ paused: now() });
  const { requests } = renderRoute("/runs/r1", (req, url) =>
    url.pathname === "/api/runs/r1/resume" ? Response.json({ paused: false }) : api(req, url),
  );
  expect(await screen.findByText("Paused")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(requests.map(describeRequest)).toContain("POST /api/runs/r1/resume"));
});

test("Cancel this role asks first", async () => {
  const { requests } = renderRoute(`/runs/r1?node=${encodeURIComponent(LANE)}&tab=overview`, (req, url) =>
    url.pathname === "/api/runs/r1/roles/worker-M1.L1/cancel"
      ? Response.json({ name: "worker-M1.L1", status: "cancelled" })
      : api(req, url),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Cancel this role" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Cancel worker-M1.L1?" });
  expect(dialog).toHaveTextContent("The role stops now and the run decides what comes next.");
  expect(requests.map(describeRequest)).not.toContain("POST /api/runs/r1/roles/worker-M1.L1/cancel");
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel role" }));
  await waitFor(() => expect(requests.map(describeRequest)).toContain("POST /api/runs/r1/roles/worker-M1.L1/cancel"));
});

test("the plan opens on a running run", async () => {
  renderRoute("/runs/r1", api);
  expect(await screen.findByText("Split the wallet.")).toBeInTheDocument();
});

test("a phone gets the list of steps and no graph", async () => {
  screenIs(false);
  const { router } = renderRoute("/runs/r1", api);
  const steps = await screen.findByRole("list", { name: "Steps" });
  expect(screen.queryByLabelText("Graph of the run")).toBeNull();
  expect(within(steps).getAllByRole("listitem")).toHaveLength(model.nodes.length);
  await userEvent.click(within(steps).getByRole("button", { name: /M1\.L1 worker/ }));
  await waitFor(() => expect(router.state.location.searchStr).toContain("node=M1%2Flane%2FM1.L1"));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});

test("a live entry joins page 1 only, once, and refreshes the run", async () => {
  const { requests, router } = renderRoute("/runs/r1", api);
  const list = await screen.findByRole("list", { name: "Timeline" });
  await waitFor(() => expect(FakeSocket.last).toBeDefined());
  const ws = FakeSocket.last!;
  // the page holds seq 1..3, so the socket replays from 4: nothing between the fetch and the upgrade is lost
  expect(ws.url).toMatch(/\/api\/runs\/r1\/live\?from=4$/);
  act(() => {
    ws.readyState = 1;
    ws.onopen?.();
  });
  const before = requests.filter((r) => describeRequest(r) === "GET /api/runs/r1/model").length;
  const frame = JSON.stringify({ seq: 9, type: "report.posted", text: "M1 landed" });
  act(() => ws.onmessage?.({ data: frame }));
  act(() => ws.onmessage?.({ data: frame }));
  await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(4));
  expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("M1 landed");
  // the model is read again for the event
  await waitFor(() =>
    expect(requests.filter((r) => describeRequest(r) === "GET /api/runs/r1/model").length).toBeGreaterThan(before),
  );
  act(() => router.history.push("/runs/r1?page=2"));
  await waitFor(() => expect(screen.queryByText("M1 landed")).toBeNull());
});

test("the timeline filters by type", async () => {
  const { requests } = renderRoute("/runs/r1", api);
  await screen.findByRole("list", { name: "Timeline" });
  await userEvent.click(screen.getByRole("button", { name: /Type/ }));
  await userEvent.click(await screen.findByRole("option", { name: "Dispatches" }));
  await waitFor(() =>
    expect(requests.map((r) => decodeURIComponent(describeRequest(r)))).toContainEqual(
      expect.stringContaining("types=dispatch.started,dispatch.ended"),
    ),
  );
  const list = await screen.findByRole("list", { name: "Timeline" });
  await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
});

test("a 1.5 run shows its dispatches, report and timeline and no graph", async () => {
  runBody = run({ engine: "1.5", phase: null, parked: [], holds: [], live: [], paused: null });
  model = {
    run: "r1",
    engine: "1.5",
    seq: 0,
    phase: null,
    outcome: null,
    nodes: [],
    edges: [],
    dispatches: [CASE_HELPERS.dispatches[0]!],
  };
  const { requests } = renderRoute("/runs/r1", (req, url) =>
    url.pathname === "/api/runs/r1/docs"
      ? Response.json({ name: "report.md", text: "# Old report\n\nIt shipped." })
      : url.pathname === "/api/runs/r1/timeline"
        ? Response.json({ items: [], total: 0 })
        : api(req, url),
  );
  expect(await screen.findByText(/This run started on catherd 1.5/)).toBeInTheDocument();
  expect(await screen.findByRole("grid", { name: "Dispatches" })).toBeInTheDocument();
  expect(await screen.findByText("It shipped.")).toBeInTheDocument();
  expect(await screen.findByText("No events yet.")).toBeInTheDocument();
  expect(screen.queryByLabelText("Graph of the run")).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
  expect(requests.map(describeRequest).some((r) => r.includes("/live"))).toBe(false);
});

test("Cancel run asks first, then cancels", async () => {
  const { requests } = renderRoute("/runs/r1", (req, url) =>
    url.pathname === "/api/runs/r1/cancel" ? Response.json({ cancelling: true, live: [] }) : api(req, url),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Cancel wallet split?" });
  expect(dialog).toHaveTextContent("It cannot be resumed.");
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel run" }));
  await waitFor(() => expect(requests.map(describeRequest)).toContain("POST /api/runs/r1/cancel"));
});

test("a 401 sends the run page to login and closes its socket", async () => {
  let unauthorized = false;
  const { router, queryClient } = renderRoute("/runs/r1", (req, url) => {
    if (unauthorized && url.pathname === "/api/runs/r1")
      return Response.json(
        { error: { message: "sign in first", type: "unauthorized", code: "unauthorized" } },
        { status: 401 },
      );
    return api(req, url);
  });
  // wired as main.tsx does
  configureClient(() => {
    if (router.state.location.pathname === "/login") return;
    void router.navigate({ to: "/login", search: { redirect: location.pathname + location.search } });
  });
  client.setConfig({ baseUrl: "http://localhost" });
  await screen.findByRole("list", { name: "Timeline" });
  await waitFor(() => expect(getSocket()).not.toBeNull());
  unauthorized = true;
  await act(() => queryClient.invalidateQueries());
  await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  await waitFor(() => expect(getSocket()).toBeNull());
});
