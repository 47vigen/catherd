import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ParkedView } from "../../client";
import { client } from "../../client/client.gen";
import "../../test/dom-shims";
import { QuestionAnswer } from "./QuestionAnswer";

afterEach(() => client.setConfig({ baseUrl: "", fetch: undefined }));

const parked = (over: Partial<ParkedView> = {}): ParkedView => ({
  run: "r1",
  runTitle: "wallet split",
  unit: "run",
  question: "Approve the plan?",
  reason: "approval",
  at: new Date().toISOString(),
  command: 'catherd answer r1 run "<answer>"',
  ...over,
});

function setup(q: ParkedView, reply: () => Response = () => Response.json({ unit: q.unit, parked: [] })) {
  const requests: Request[] = [];
  client.setConfig({
    baseUrl: "http://localhost",
    fetch: async (input: RequestInfo | URL) => {
      const req = (input as Request).clone();
      requests.push(req);
      return reply();
    },
  });
  const onAnswered = vi.fn<() => void>();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <QuestionAnswer q={q} onAnswered={onAnswered} />
    </QueryClientProvider>,
  );
  return { requests, onAnswered, invalidate };
}

test("Approve plan sends approve", async () => {
  const { requests, onAnswered, invalidate } = setup(parked());
  await userEvent.click(screen.getByRole("button", { name: "Approve plan" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]!.method).toBe("POST");
  expect(new URL(requests[0]!.url).pathname).toBe("/api/runs/r1/answers");
  expect(await requests[0]!.json()).toEqual({ unit: "run", answer: "approve" });
  await waitFor(() => expect(onAnswered).toHaveBeenCalledTimes(1));
  expect(invalidate).toHaveBeenCalled();
});

test("Request changes needs words first", async () => {
  const { requests } = setup(parked());
  await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
  expect(requests).toHaveLength(0);
  const box = screen.getByRole("textbox", { name: "Your answer" });
  expect(box).toHaveFocus();
  await userEvent.type(box, "  split the wallet first ");
  await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(await requests[0]!.json()).toEqual({ unit: "run", answer: "split the wallet first" });
});

test("the box keeps Send answer, disabled while blank", async () => {
  const { requests } = setup(parked({ reason: "needs_user", unit: "M1.L2" }));
  expect(screen.queryByRole("button", { name: "Approve plan" })).toBeNull();
  const send = screen.getByRole("button", { name: "Send answer" });
  expect(send).toBeDisabled();
  await userEvent.type(screen.getByRole("textbox", { name: "Your answer" }), "keep it");
  await userEvent.click(send);
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(await requests[0]!.json()).toEqual({ unit: "M1.L2", answer: "keep it" });
});

test("a budget question links to the budget setup", () => {
  setup(parked({ reason: "budget" }));
  expect(screen.getByRole("link", { name: "Raise the budget" })).toHaveAttribute("href", "/setup?section=budget");
  expect(screen.getByRole("button", { name: "I raised it" })).toBeInTheDocument();
});

test("a refused answer shows why", async () => {
  setup(parked(), () =>
    Response.json(
      { error: { message: "run has no open question", code: "E_INPUT_INVALID", type: "E_INPUT_INVALID" } },
      { status: 400 },
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Approve plan" }));
  expect(await screen.findByText("run has no open question")).toBeInTheDocument();
});
