import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { client } from "../../../client/client.gen";
import { configureClient } from "../../../lib/api";
import { getSocket, stopWebSocket } from "../../../lib/live-socket";
import { describeRequest, renderRoute } from "../../../test/render-route";

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

beforeEach(() => {
  FakeSocket.last = undefined;
  vi.stubGlobal("WebSocket", FakeSocket);
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
  milestones: [
    { id: "M1", title: "Split the wallet", status: "landed", round: 1, commit: "abcdef1234567" },
    { id: "M2", title: "Move the ids", status: "lanes", round: 0, commit: null },
  ],
  live: [{ name: "worker-M2.L1", role: "worker", rung: "codex:gpt-6-sol#high", unit: "M2.L1", since: now() }],
  parked: [
    {
      run: "r1",
      runTitle: "wallet split",
      unit: "M2.L2",
      question: "Keep the old wallet id?",
      reason: "needs_user",
      at: now(),
      command: "catherd answer r1 M2.L2",
    },
  ],
  holds: [{ quota: "codex", until: "2026-10-21T10:30:00Z" }],
  last: "M1 landed",
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
const entry = (seq: number, text: string) => ({ seq, at: now(), type: "report.posted", text });

function api(_req: Request, url: URL) {
  if (url.pathname === "/api/runs") return Response.json({ items: [card()], total: 1 });
  if (url.pathname === "/api/runs/r1") return Response.json(run());
  if (url.pathname === "/api/runs/r1/timeline")
    return Response.json({
      items: [entry(3, "M2 lanes routed"), entry(2, "plan approved"), entry(1, "run started")],
      total: 3,
    });
}

test("the list query carries the search, the phase and the page", async () => {
  const { requests } = renderRoute("/runs?q=wallet&phase=running&page=2&pageSize=25", api);
  await screen.findByRole("heading", { name: "Runs" });
  await waitFor(() =>
    expect(requests.map(describeRequest)).toContain("GET /api/runs?q=wallet&phase=running&limit=25&offset=25"),
  );
});

test("a row shows the run's status, milestones, live roles and questions, and opens the run", async () => {
  const { router } = renderRoute("/runs", api);
  const title = await screen.findByText("wallet split");
  const row = title.closest<HTMLElement>('[role="row"]')!;
  expect(within(row).getByText("r1")).toBeInTheDocument();
  expect(within(row).getByText("Parked")).toBeInTheDocument();
  expect(within(row).getByText("1/2")).toBeInTheDocument();
  await userEvent.click(row);
  await waitFor(() => expect(router.state.location.pathname).toBe("/runs/r1"));
});

test("an empty list says how a run starts", async () => {
  renderRoute("/runs", (_req, url) =>
    url.pathname === "/api/runs" ? Response.json({ items: [], total: 0 }) : undefined,
  );
  expect(await screen.findByText("No runs yet. Start one from your session with run_start.")).toBeInTheDocument();
});

test("the run page shows milestones, live roles, parked units with an Answer link, holds and the timeline newest first", async () => {
  renderRoute("/runs/r1", api);
  expect(await screen.findByRole("heading", { name: "wallet split" })).toBeInTheDocument();
  expect(screen.getByText("r1 · /work/wallet")).toBeInTheDocument();
  expect(screen.getByText("Split the wallet")).toBeInTheDocument();
  expect(screen.getByText("abcdef1")).toBeInTheDocument();
  expect(screen.getByText("worker-M2.L1")).toBeInTheDocument();
  expect(screen.getByText("Keep the old wallet id?")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Answer" })).toHaveAttribute("href", "/questions?run=r1");
  expect(screen.getByText(/Held until/)).toBeInTheDocument();
  const list = await screen.findByRole("list", { name: "Timeline" });
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual([
    expect.stringContaining("M2 lanes routed"),
    expect.stringContaining("plan approved"),
    expect.stringContaining("run started"),
  ]);
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
  const frame = JSON.stringify({ seq: 9, type: "report.posted", text: "M1 landed" });
  act(() => ws.onmessage?.({ data: frame }));
  act(() => ws.onmessage?.({ data: frame }));
  await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(4));
  expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("M1 landed");
  await waitFor(() =>
    expect(requests.filter((r) => describeRequest(r) === "GET /api/runs/r1").length).toBeGreaterThan(before),
  );
  act(() => router.history.push("/runs/r1?page=2"));
  await waitFor(() => expect(screen.queryByText("M1 landed")).toBeNull());
});

test("a 1.5 run says so and loads no timeline", async () => {
  const { requests } = renderRoute("/runs/r1", (req, url) =>
    url.pathname === "/api/runs/r1"
      ? Response.json(run({ engine: "1.5", phase: null, parked: [], holds: [], live: [] }))
      : api(req, url),
  );
  expect(await screen.findByText(/This run started on catherd 1.5/)).toBeInTheDocument();
  expect(requests.map(describeRequest).some((r) => r.includes("/timeline"))).toBe(false);
  expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
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
