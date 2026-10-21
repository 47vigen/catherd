import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { client } from "../../../client/client.gen";
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
  ...over,
});

const list = (items: object[]) => (_req: Request, url: URL) =>
  url.pathname === "/api/questions" ? Response.json({ items, total: items.length }) : undefined;

test("lists each parked unit with its run, reason, age and question, filtered by run from the URL", async () => {
  const { requests } = renderRoute("/questions?run=r1", list([parked()]));
  expect(await screen.findByText("Keep the old wallet id?")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "wallet split" })).toHaveAttribute("href", "/runs/r1");
  expect(screen.getByText("M1.L2")).toBeInTheDocument();
  expect(screen.getByText("needs_user")).toBeInTheDocument();
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
