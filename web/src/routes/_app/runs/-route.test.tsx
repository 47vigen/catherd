import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { RunModel } from "../../../client";
import { getRunModelQueryKey } from "../../../client/@tanstack/react-query.gen";
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
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(f: object) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

/** The page's socket once it is open. */
async function openSocket(): Promise<FakeSocket> {
  await waitFor(() => expect(FakeSocket.last).toBeDefined());
  const ws = FakeSocket.last!;
  act(() => ws.open());
  return ws;
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
  milestones: [{ id: "M1", title: "Split the wallet", status: "lanes", round: 1, reviews: 2, commit: null }],
  live: [{ name: "worker-M1.L1", role: "worker", rung: "codex:gpt-6-luna#high", unit: "M1.L1", since: now() }],
  parked: [],
  holds: [],
  last: "M1 routed",
  paused: null,
  startedAt: now(),
  updatedAt: now(),
  elapsedSec: 0,
  waitingSec: 0,
  countingSince: now(),
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
  paused: null,
  totals: {
    dispatches: 3,
    tokens: { input: 0, cached: 0, cacheWrite: 0, output: 0 },
    costUsd: 0,
    unpriced: 0,
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

test("a paused run's row says it is paused", async () => {
  renderRoute("/runs", (req, url) =>
    url.pathname === "/api/runs"
      ? Response.json({ items: [card({ paused: now(), openQuestions: 1 })], total: 1 })
      : api(req, url),
  );
  const row = (await screen.findByText("wallet split")).closest<HTMLElement>('[role="row"]')!;
  expect(within(row).getByText("Paused")).toBeInTheDocument();
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
  // The server supplies rounds; the graph supplies step outcomes.
  expect(screen.getByText("Status").nextElementSibling).toHaveTextContent("Running");
  expect(screen.getByText("Rounds").nextElementSibling).toHaveTextContent("2");
  expect(
    screen.getByText(
      `${model.nodes.filter((n) => n.status === "done").length} done · 0 skipped · 0 failed of ${model.nodes.length}`,
    ),
  ).toBeInTheDocument();
});

test("the header's time leaves pauses out and stands still while paused", async () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
  runBody = run({ startedAt: twoHoursAgo, paused: now(), elapsedSec: 600, countingSince: null });
  renderRoute("/runs/r1", api);
  await screen.findByRole("heading", { name: "wallet split" });
  expect(screen.getByText("Running for").nextElementSibling).toHaveTextContent("10m 00s");
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

const graphWidth = () => Number(document.querySelector("svg[aria-hidden='true'].block")?.getAttribute("width"));

test("Zoom in and Zoom out scale the graph and stop at the limits", async () => {
  renderRoute("/runs/r1", api);
  await nodeButton(LANE);
  await userEvent.click(screen.getByRole("button", { name: "Full screen" }));
  const dialog = await screen.findByRole("dialog", { name: "Steps of the run" });
  await within(dialog).findByLabelText("Graph of the run");
  const toolbar = within(dialog).getByRole("toolbar", { name: "Graph view" });
  const percent = () => within(toolbar).getByRole("status").textContent;
  const base = graphWidth();
  expect(percent()).toBe("100%");
  await userEvent.click(within(toolbar).getByRole("button", { name: "Zoom in" }));
  expect(graphWidth()).toBeCloseTo(base * 1.25);
  expect(percent()).toBe("125%");
  const zoomOut = within(toolbar).getByRole("button", { name: "Zoom out" });
  while (!zoomOut.hasAttribute("disabled")) await userEvent.click(zoomOut);
  expect(percent()).toBe("25%");
  const zoomIn = within(toolbar).getByRole("button", { name: "Zoom in" });
  while (!zoomIn.hasAttribute("disabled")) await userEvent.click(zoomIn);
  expect(percent()).toBe("200%");
});

test("Fit to view never zooms past 100%", async () => {
  renderRoute("/runs/r1", api);
  await nodeButton(LANE);
  await userEvent.click(screen.getByRole("button", { name: "Full screen" }));
  const dialog = await screen.findByRole("dialog", { name: "Steps of the run" });
  await within(dialog).findByLabelText("Graph of the run");
  const toolbar = within(dialog).getByRole("toolbar", { name: "Graph view" });
  const fit = () => userEvent.click(within(toolbar).getByRole("button", { name: "Fit to view" }));
  const frame = document.querySelector("svg[aria-hidden='true'].block")!.parentElement!.parentElement!;
  await userEvent.click(within(toolbar).getByRole("button", { name: "Zoom in" }));
  // a frame far larger than the graph: the fit is capped at 100%, not scaled up to fill it
  Object.defineProperty(frame, "clientWidth", { configurable: true, value: 100_000 });
  Object.defineProperty(frame, "clientHeight", { configurable: true, value: 100_000 });
  await fit();
  expect(within(toolbar).getByRole("status")).toHaveTextContent("100%");
  // jsdom has no layout, so an unstubbed frame measures 0 and the fit clamps to the smallest zoom
  Object.defineProperty(frame, "clientWidth", { configurable: true, value: 0 });
  Object.defineProperty(frame, "clientHeight", { configurable: true, value: 0 });
  await fit();
  expect(within(toolbar).getByRole("status")).toHaveTextContent("25%");
});

test("Full screen shows one graph in a dialog and closes back to the page", async () => {
  renderRoute("/runs/r1", api);
  await nodeButton(LANE);
  // zoom is a full-screen tool; the page shows only the way in
  expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Full screen" }));
  const dialog = await screen.findByRole("dialog", { name: "Steps of the run" });
  expect(await within(dialog).findByLabelText("Graph of the run")).toBeInTheDocument();
  expect(document.querySelectorAll("[aria-label='Graph of the run']")).toHaveLength(1);
  expect(within(dialog).queryByRole("button", { name: "Full screen" })).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: /close/i }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByRole("button", { name: "Full screen" })).toBeInTheDocument();
  expect(screen.getAllByLabelText("Graph of the run")).toHaveLength(1);
});

test("a node opened in full screen opens its drawer above it, and Escape closes the drawer first", async () => {
  const { router } = renderRoute("/runs/r1", api);
  await nodeButton(LANE);
  await userEvent.click(screen.getByRole("button", { name: "Full screen" }));
  await screen.findByRole("dialog", { name: "Steps of the run" });
  await userEvent.click(await nodeButton(LANE));
  await waitFor(() => expect(router.state.location.searchStr).toContain("node="));
  expect(await screen.findByRole("heading", { name: "M1.L1 worker" })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(router.state.location.searchStr).not.toContain("node="));
  expect(screen.queryByRole("heading", { name: "M1.L1 worker" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Steps of the run" })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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

test("the Decision tab shows the levels and the pick", async () => {
  model = {
    ...model,
    nodes: model.nodes.map((n) =>
      n.id === LANE
        ? {
            ...n,
            decision: {
              n: 1,
              rung: "codex:gpt-6-sol#medium",
              level: 1,
              levels: 3,
              levelRungs: [["codex:gpt-6-luna#low"], ["codex:gpt-6-sol#medium"], ["codex:gpt-6-sol#high"]],
              p: 0.9,
              source: "model",
              why: "A small rename",
              probabilities: {},
            },
          }
        : n,
    ),
  };
  renderRoute(`/runs/r1?node=${encodeURIComponent(LANE)}&tab=decision`, api);
  const dialog = await screen.findByRole("dialog");
  const levels = await within(dialog).findAllByRole("listitem");
  expect(levels).toHaveLength(3);
  expect(levels[0]).not.toHaveTextContent("Picked");
  expect(levels[1]).toHaveTextContent("Picked");
  expect(levels[2]).not.toHaveTextContent("Picked");
  expect(within(dialog).getByText("90%")).toBeInTheDocument();
  expect(within(dialog).getByText("A small rename")).toBeInTheDocument();
  expect(within(dialog).getByText("Decision model")).toBeInTheDocument();
});

test("a role node with no decision says it is not decided yet", async () => {
  renderRoute(`/runs/r1?node=${encodeURIComponent(LANE)}&tab=decision`, api);
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText("Not decided yet")).toBeInTheDocument();
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

test("with two roles live on one node, Cancel stops the selected attempt's role", async () => {
  const lane = model.nodes.find((n) => n.id === LANE)!;
  const first = lane.attempts[0]!;
  const second = { ...first, id: `${first.id}-ui`, name: "ui-reviewer-M1" };
  model = {
    ...model,
    nodes: model.nodes.map((n) => (n.id === LANE ? { ...n, attempts: [first, second, ...n.attempts.slice(1)] } : n)),
  };
  const { requests } = renderRoute(
    `/runs/r1?node=${encodeURIComponent(LANE)}&attempt=${encodeURIComponent(second.id)}&tab=overview`,
    (req, url) =>
      url.pathname === "/api/runs/r1/roles/ui-reviewer-M1/cancel"
        ? Response.json({ name: "ui-reviewer-M1", status: "cancelled" })
        : api(req, url),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Cancel this role" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Cancel ui-reviewer-M1?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel role" }));
  await waitFor(() => expect(requests.map(describeRequest)).toContain("POST /api/runs/r1/roles/ui-reviewer-M1/cancel"));
  expect(requests.map(describeRequest)).not.toContain("POST /api/runs/r1/roles/worker-M1.L1/cancel");
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
  expect(screen.queryByText("This document is long, so only its start is shown.")).toBeNull();
});

test("a cut document says so under it", async () => {
  renderRoute("/runs/r1", (req, url) =>
    url.pathname === "/api/runs/r1/docs" && url.searchParams.get("name") === "plan.md"
      ? Response.json({ name: "plan.md", text: "# The plan\n\nSplit the wallet.", cut: true })
      : api(req, url),
  );
  expect(await screen.findByText("Split the wallet.")).toBeInTheDocument();
  expect(screen.getByText("This document is long, so only its start is shown.")).toBeInTheDocument();
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
  const before = requests.filter((r) => describeRequest(r) === "GET /api/runs/r1").length;
  const patch = { seq: model.seq, phase: "running", outcome: null, nodes: [], removed: [], edges: null };
  const frame = JSON.stringify({ seq: 9, type: "report.posted", text: "M1 landed", patch });
  act(() => ws.onmessage?.({ data: frame }));
  act(() => ws.onmessage?.({ data: frame }));
  await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(4));
  const first = within(list).getAllByRole("listitem")[0]!;
  expect(first).toHaveTextContent("M1 landed");
  // it arrived live, so it is marked to fade in; the fetched rows are not
  expect(first).toHaveClass("row-arrive");
  expect(within(list).getAllByRole("listitem")[1]).not.toHaveClass("row-arrive");
  // the run (header, live roles) is read again for the event
  await waitFor(() =>
    expect(requests.filter((r) => describeRequest(r) === "GET /api/runs/r1").length).toBeGreaterThan(before),
  );
  act(() => router.history.push("/runs/r1?page=2"));
  await waitFor(() => expect(screen.queryByText("M1 landed")).toBeNull());
});

const modelReads = (requests: Request[]) =>
  requests.filter((r) => describeRequest(r) === "GET /api/runs/r1/model").length;

test("an event frame patches the graph without a refetch", async () => {
  const { requests } = renderRoute("/runs/r1", api);
  await nodeButton(LANE);
  const ws = await openSocket();
  const lane = model.nodes.find((n) => n.id === LANE)!;
  const done = { ...lane, status: "done" as const, now: "Done in 4 min", endedAt: now() };
  act(() =>
    ws.frame({
      kind: "event",
      seq: model.seq + 1,
      at: now(),
      type: "dispatch.ended",
      text: "worker-M1.L1 ended",
      event: {},
      patch: { seq: model.seq + 1, phase: "running", outcome: null, nodes: [done], removed: [], edges: null },
    }),
  );
  model = { ...model, nodes: model.nodes.map((n) => (n.id === LANE ? done : n)) };
  expect(await nodeButton(LANE)).toBeInTheDocument();
  expect(modelReads(requests)).toBe(1);
  // a patch the model already holds (a replay) changes nothing
  act(() =>
    ws.frame({
      kind: "event",
      seq: model.seq,
      at: now(),
      type: "dispatch.started",
      text: "replayed",
      event: {},
      patch: { seq: model.seq, phase: "running", outcome: null, nodes: [lane], removed: [], edges: null },
    }),
  );
  expect(await nodeButton(LANE)).toBeInTheDocument();
  expect(modelReads(requests)).toBe(1);
});

test("a failed background read of the model keeps the graph and the socket", async () => {
  const { requests } = renderRoute("/runs/r1", (req, url) =>
    url.pathname === "/api/runs/r1/model" && modelReads(requests) > 1
      ? Response.json({ error: { message: "boom", type: "internal", code: "internal" } }, { status: 500 })
      : api(req, url),
  );
  await nodeButton(LANE);
  const ws = await openSocket();
  // a null patch: the server could not diff, so the model is read again, and that read fails
  act(() => ws.frame({ kind: "event", seq: 40, at: now(), type: "report.posted", text: "M1 landed", patch: null }));
  await waitFor(() => expect(modelReads(requests)).toBe(2));
  expect(await screen.findByText("M1 landed")).toBeInTheDocument();
  expect(screen.queryByText("Could not load the graph of this run")).toBeNull();
  expect(await nodeButton(LANE)).toBeInTheDocument();
  expect(ws.readyState).toBe(1);
});

test("only a page of live entries is kept, newest first", async () => {
  renderRoute("/runs/r1", api);
  const list = await screen.findByRole("list", { name: "Timeline" });
  const ws = await openSocket();
  act(() => {
    for (let seq = 10; seq < 50; seq++) ws.frame({ seq, at: now(), type: "report.posted", text: `live ${seq}` });
  });
  await waitFor(() => expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("live 49"));
  const rows = within(list).getAllByRole("listitem");
  expect(rows.filter((r) => r.classList.contains("row-arrive"))).toHaveLength(25);
  expect(rows[24]).toHaveTextContent("live 25");
  expect(screen.queryByText("live 24")).toBeNull();
});

test("a reconnect refetches the model once", async () => {
  const { requests } = renderRoute("/runs/r1", api);
  await nodeButton(LANE);
  const first = await openSocket();
  expect(modelReads(requests)).toBe(1);
  act(() => first.close());
  // the reconnect waits a second
  await waitFor(() => expect(FakeSocket.last).not.toBe(first));
  act(() => FakeSocket.last!.open());
  await waitFor(() => expect(modelReads(requests)).toBe(2));
  act(() => FakeSocket.last!.frame({ seq: 40, at: now(), type: "report.posted", text: "M1 landed" }));
  expect(await screen.findByText("M1 landed")).toBeInTheDocument();
  expect(modelReads(requests)).toBe(2);
});

test("a patch that lands while the reconnect's read is in flight is kept", async () => {
  let release!: () => void;
  const { requests, queryClient } = renderRoute("/runs/r1", (req, url) => {
    if (url.pathname === "/api/runs/r1/model" && modelReads(requests) > 1) {
      const older = structuredClone(model);
      return new Promise<Response>((resolve) => {
        release = () => resolve(Response.json(older));
      });
    }
    return api(req, url);
  });
  await nodeButton(LANE);
  const first = await openSocket();
  act(() => first.close());
  await waitFor(() => expect(FakeSocket.last).not.toBe(first));
  act(() => FakeSocket.last!.open());
  await waitFor(() => expect(modelReads(requests)).toBe(2));
  const lane = model.nodes.find((n) => n.id === LANE)!;
  const done = { ...lane, status: "done" as const, now: "Done in 4 min", endedAt: now() };
  act(() =>
    FakeSocket.last!.frame({
      kind: "event",
      seq: model.seq + 1,
      at: now(),
      type: "dispatch.ended",
      text: "worker-M1.L1 ended",
      event: {},
      patch: { seq: model.seq + 1, phase: "running", outcome: null, nodes: [done], removed: [], edges: null },
    }),
  );
  model = { ...model, seq: model.seq + 1, nodes: model.nodes.map((n) => (n.id === LANE ? done : n)) };
  act(() => release());
  await waitFor(() =>
    expect(queryClient.isFetching({ queryKey: getRunModelQueryKey({ path: { id: "r1" } }) })).toBe(0),
  );
  expect(await nodeButton(LANE)).toBeInTheDocument();
});

const shellFrame = (dispatchId: string, command: string) => ({
  kind: "transcript",
  dispatchId,
  items: [{ kind: "shell", line: 2, id: `s-${command}`, command, output: null, exit: null }],
  raw: ['{"type":"item.started"}'],
  next: 3,
});

test("the log of a running role streams new lines", async () => {
  renderRoute(`/runs/r1?node=${encodeURIComponent(LANE)}&tab=log`, api);
  const dialog = await screen.findByRole("dialog");
  const ws = await openSocket();
  // once the first page is read, the socket tails the stream from the line after it
  await waitFor(() => expect(ws.sent).toContain(JSON.stringify({ watch: LANE_DISPATCH, from: 2 })));
  act(() => ws.frame(shellFrame(LANE_DISPATCH, "bun test wallet")));
  expect(await within(dialog).findByText("bun test wallet")).toBeInTheDocument();
});

test("a frame for another dispatch is ignored", async () => {
  renderRoute(`/runs/r1?node=${encodeURIComponent(LANE)}&tab=log`, api);
  const dialog = await screen.findByRole("dialog");
  const ws = await openSocket();
  await waitFor(() => expect(ws.sent).toContain(JSON.stringify({ watch: LANE_DISPATCH, from: 2 })));
  act(() => ws.frame(shellFrame("someone-else", "rm stale files")));
  act(() => ws.frame(shellFrame(LANE_DISPATCH, "bun test wallet")));
  expect(await within(dialog).findByText("bun test wallet")).toBeInTheDocument();
  expect(within(dialog).queryByText("rm stale files")).toBeNull();
});

test("a filtered timeline replays from the older of the model and its newest entry, so no event falls between", async () => {
  renderRoute("/runs/r1?types=plan.approved", api);
  await screen.findByRole("list", { name: "Timeline" });
  await waitFor(() => expect(FakeSocket.last).toBeDefined());
  // plan.approved is seq 2 in the fixture timeline, older than the model's seq
  expect(FakeSocket.last!.url).toMatch(new RegExp(`/api/runs/r1/live\\?from=${Math.min(model.seq, 2) + 1}$`));
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

test("a run still planning does not ask for a plan the architect has not written", async () => {
  const planning = (req: Request, url: URL) =>
    url.pathname === "/api/runs/r1"
      ? Response.json(run({ phase: "planning", milestones: [], live: [] }))
      : api(req, url);
  const { requests } = renderRoute("/runs/r1", planning);
  expect(await screen.findByText("No plan yet. The architect writes it first.")).toBeInTheDocument();
  expect(requests.map((r) => decodeURIComponent(describeRequest(r))).filter((r) => r.includes("/docs"))).toEqual([]);
});

test("the header shows server rounds, waiting time and unpriced runs", async () => {
  runBody = run({
    waitingSec: 3600,
    milestones: [
      { id: "M1", title: "First", status: "lanes", round: 7, reviews: 2, commit: null },
      { id: "M2", title: "Second", status: "lanes", round: 7, reviews: 1, commit: null },
    ],
  });
  model = {
    ...model,
    dispatches: [
      { ...model.dispatches[0]!, costUsd: null, tokens: { input: 100, cached: 20, cacheWrite: 30, output: 40 } },
      { ...model.dispatches[1]!, costUsd: 0.5, tokens: null },
    ],
  };
  renderRoute("/runs/r1", api);
  expect(await screen.findByText("waiting on you 1h 00m")).toBeInTheDocument();
  expect(screen.getByText("Rounds").nextElementSibling).toHaveTextContent("3");
  expect(await screen.findByText("1 unpriced")).toBeInTheDocument();
  expect(screen.getByText("Cost").nextElementSibling).toHaveTextContent("$0.50");
  expect(screen.getByText("50 uncached · 20 cache read · 30 cache write · 40 out")).toBeInTheDocument();
});

test("the header shows zero rounds before any review", async () => {
  runBody = run({ milestones: [] });
  renderRoute("/runs/r1", api);
  await screen.findByRole("heading", { name: "wallet split" });
  expect(screen.getByText("Rounds").nextElementSibling).toHaveTextContent("0");
});

test("the step count shows skipped and failed", async () => {
  const nodes = model.nodes.slice(0, 5).map((n, i) => ({
    ...n,
    status: i < 3 ? ("done" as const) : i === 3 ? ("skipped" as const) : ("failed" as const),
  }));
  model = { ...model, nodes, edges: [] };
  renderRoute("/runs/r1", api);
  expect(await screen.findByText("3 done · 1 skipped · 1 failed of 5")).toBeInTheDocument();
});

test("the header does not count an active dispatch as unpriced", async () => {
  model = {
    ...model,
    dispatches: [
      {
        ...model.dispatches[0]!,
        status: "running",
        endedAt: null,
        tokens: null,
        costUsd: null,
      },
    ],
  };
  renderRoute("/runs/r1", api);
  await screen.findByText("1 role run");
  expect(screen.queryByText(/\d+ unpriced/)).not.toBeInTheDocument();
  expect(screen.getByText("Cost").nextElementSibling).toHaveTextContent("—");
});
