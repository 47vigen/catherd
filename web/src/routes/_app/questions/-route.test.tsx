import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { client } from "../../../client/client.gen";
import { REASON_TEXT } from "../../../lib/park-reasons";
import { describeRequest, renderRoute } from "../../../test/render-route";

afterEach(() => client.setConfig({ baseUrl: "", fetch: undefined }));

const parked = (over: object = {}) => ({
  run: "r1",
  runTitle: "wallet split",
  unit: "M1.L2",
  question: "Keep the old wallet id?",
  reason: "needs_user",
  at: new Date().toISOString(),
  command: 'catherd answer r1 M1.L2 "<answer>"',
  context: { node: "M1/lane/M1.L2", reply: "I could keep **both** ids.", replyName: "worker", lane: "M1.L2" },
  ...over,
});

const answered = (over: object = {}) => ({
  run: "r1",
  runTitle: "wallet split",
  unit: "M1.L1",
  answer: "use the new id",
  by: "owner",
  at: new Date().toISOString(),
  ...over,
});

const list =
  (items: object[], done: object[] = []) =>
  (_req: Request, url: URL) =>
    url.pathname === "/api/questions"
      ? Response.json({ items, total: items.length })
      : url.pathname === "/api/questions/answered"
        ? Response.json({ items: done })
        : undefined;

test("lists each parked unit with its run, reason, age and question, filtered by run from the URL", async () => {
  const { requests } = renderRoute("/questions?run=r1", list([parked()]));
  expect(await screen.findByText("Keep the old wallet id?")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "wallet split" })).toHaveAttribute("href", "/runs/r1");
  expect(screen.getByText("M1.L2")).toBeInTheDocument();
  expect(screen.getByText(REASON_TEXT.needs_user)).toBeInTheDocument();
  expect(requests.map(describeRequest)).toContain("GET /api/questions?run=r1&limit=25&offset=0");
});

test("sends the trimmed answer for the unit and refreshes the list", async () => {
  const { requests } = renderRoute("/questions", (req, url) =>
    url.pathname === "/api/runs/r1/answers" ? Response.json({ unit: "M1.L2", parked: [] }) : list([parked()])(req, url),
  );
  await userEvent.type(await screen.findByRole("textbox", { name: "Your answer" }), "  keep it  ");
  const before = requests.filter((r) => describeRequest(r).startsWith("GET /api/questions")).length;
  await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
  await waitFor(() => expect(requests.map(describeRequest)).toContain("POST /api/runs/r1/answers"));
  const post = requests.find((r) => describeRequest(r) === "POST /api/runs/r1/answers")!;
  expect(await post.clone().json()).toEqual({ unit: "M1.L2", answer: "keep it" });
  await waitFor(() =>
    expect(requests.filter((r) => describeRequest(r).startsWith("GET /api/questions")).length).toBeGreaterThan(before),
  );
  expect(await screen.findByText("Answer sent. M1.L2 runs again.")).toBeInTheDocument();
});

test("Send answer stays disabled for a blank answer", async () => {
  renderRoute("/questions", list([parked()]));
  const send = await screen.findByRole("button", { name: "Send answer" });
  expect(send).toBeDisabled();
  await userEvent.type(screen.getByRole("textbox", { name: "Your answer" }), "   ");
  expect(send).toBeDisabled();
});

test("a refused answer shows the reason and refreshes", async () => {
  const { requests } = renderRoute("/questions", (req, url) =>
    url.pathname === "/api/runs/r1/answers"
      ? Response.json(
          { error: { message: "M1.L2 has no open question", code: "E_INPUT_INVALID", type: "E_INPUT_INVALID" } },
          { status: 400 },
        )
      : list([parked()])(req, url),
  );
  await userEvent.type(await screen.findByRole("textbox", { name: "Your answer" }), "keep it");
  const before = requests.filter((r) => describeRequest(r).startsWith("GET /api/questions")).length;
  await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
  expect(await screen.findByText("M1.L2 has no open question")).toBeInTheDocument();
  await waitFor(() =>
    expect(requests.filter((r) => describeRequest(r).startsWith("GET /api/questions")).length).toBeGreaterThan(before),
  );
});

test("nothing waiting says so", async () => {
  renderRoute("/questions", list([]));
  expect(await screen.findByText("Nothing is waiting for you.")).toBeInTheDocument();
});

test("each card explains its reason, keeps the reply closed and links its node in the graph", async () => {
  renderRoute("/questions", list([parked()]));
  const summary = await screen.findByText("worker's latest reply");
  const details = summary.closest("details")!;
  expect(details).not.toHaveAttribute("open");
  expect(screen.queryByText("both")).not.toBeInTheDocument();
  await userEvent.click(summary);
  expect(await screen.findByText("both")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open in the graph" })).toHaveAttribute(
    "href",
    "/runs/r1?node=M1%2Flane%2FM1.L2&tab=overview",
  );
  expect(screen.getByRole("link", { name: "Lane" })).toHaveAttribute(
    "href",
    "/runs/r1?node=M1%2Flane%2FM1.L2&tab=prompt",
  );
  expect(screen.getByRole("link", { name: "Plan" })).toHaveAttribute("href", "/runs/r1#plan");
});

test("a question with no reply and no lane shows neither", async () => {
  renderRoute("/questions", list([parked({ context: { node: "start", reply: null, replyName: null, lane: null } })]));
  expect(await screen.findByRole("link", { name: "Open in the graph" })).toBeInTheDocument();
  expect(screen.queryByText(/latest reply/)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Lane" })).not.toBeInTheDocument();
});

test("an approval offers Approve plan and Request changes", async () => {
  const { requests } = renderRoute("/questions", (req, url) =>
    url.pathname === "/api/runs/r1/answers"
      ? Response.json({ unit: "run", parked: [] })
      : list([parked({ unit: "run", reason: "approval" })])(req, url),
  );
  expect(await screen.findByRole("button", { name: "Request changes" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Approve plan" }));
  await waitFor(() => expect(requests.map(describeRequest)).toContain("POST /api/runs/r1/answers"));
  const post = requests.find((r) => describeRequest(r) === "POST /api/runs/r1/answers")!;
  expect(await post.clone().json()).toEqual({ unit: "run", answer: "approve" });
});

test("a budget question links to Setup's budget", async () => {
  renderRoute("/questions", list([parked({ reason: "budget" })]));
  expect(await screen.findByRole("link", { name: "Raise the budget" })).toHaveAttribute(
    "href",
    "/setup?section=budget",
  );
});

test("an answered question moves to Recently answered", async () => {
  let sent = false;
  renderRoute("/questions", (req, url) => {
    if (url.pathname === "/api/runs/r1/answers") {
      sent = true;
      return Response.json({ unit: "M1.L2", parked: [] });
    }
    return sent ? list([], [answered({ unit: "M1.L2", answer: "keep it" })])(req, url) : list([parked()])(req, url);
  });
  await userEvent.type(await screen.findByRole("textbox", { name: "Your answer" }), "keep it");
  await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
  expect(await screen.findByText("Nothing is waiting for you.")).toBeInTheDocument();
  expect(await screen.findByText("Recently answered")).toBeInTheDocument();
  expect(screen.getByText("keep it")).toBeInTheDocument();
  expect(screen.getByText("M1.L2")).toBeInTheDocument();
});

test("Recently answered names who answered and stays out of the way when empty", async () => {
  const view = renderRoute("/questions", list([], [answered({ by: "judge" })]));
  expect(await screen.findByText("use the new id")).toBeInTheDocument();
  expect(screen.getByText("Judge")).toBeInTheDocument();
  view.unmount();
  renderRoute("/questions", list([]));
  expect(await screen.findByText("Nothing is waiting for you.")).toBeInTheDocument();
  expect(screen.queryByText("Recently answered")).not.toBeInTheDocument();
});
