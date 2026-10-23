import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "../../../../../test/dom-shims";
import type { TranscriptItem, TranscriptPage } from "../../../../../client";
import { client } from "../../../../../client/client.gen";
import { TranscriptView } from "./TranscriptView";

const text = (line: number, t: string): TranscriptItem => ({ kind: "text", line, text: t });

/** Serves pages of a fake stream; every request is recorded as its path and query string. */
function fakeStream(page: (from: number, raw: boolean) => Partial<TranscriptPage> | Response) {
  const seen: string[] = [];
  client.setConfig({
    baseUrl: "http://localhost",
    fetch: async (input: RequestInfo | URL) => {
      const url = new URL((input as Request).url);
      seen.push(`${url.pathname}${url.search}`);
      const from = Number(url.searchParams.get("from") ?? 0);
      const got = page(from, url.searchParams.get("raw") === "1");
      if (got instanceof Response) return got;
      return Response.json({ items: [], raw: null, next: from, ended: true, ...got });
    },
  });
  return seen;
}

test("it loads the first page of the stream and draws it", async () => {
  const seen = fakeStream(() => ({ items: [text(0, "Hello from the role")], next: 1 }));
  render(<TranscriptView runId="r 1" dispatchId="d1" live={false} />);
  expect(await screen.findByText("Hello from the role")).toBeInTheDocument();
  expect(seen).toEqual(["/api/runs/r%201/dispatches/d1/stream?from=0&limit=500&raw=0"]);
});

test("a full page offers Load more, which continues from where the last stopped", async () => {
  const seen = fakeStream((from) => ({
    items: [text(from, from === 0 ? "first page" : "second page")],
    next: from === 0 ? 500 : 501,
  }));
  render(<TranscriptView runId="r" dispatchId="d" live={false} />);
  await screen.findByText("first page");
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("second page")).toBeInTheDocument();
  expect(screen.getByText("first page")).toBeInTheDocument();
  expect(seen[1]).toContain("from=500");
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("Raw fetches the lines as written and shows them", async () => {
  const seen = fakeStream((_from, raw) =>
    raw ? { raw: ['{"type":"assistant"}', '{"type":"result"}'], next: 2 } : { items: [text(0, "prose")], next: 1 },
  );
  render(<TranscriptView runId="r" dispatchId="d" live={false} />);
  await screen.findByText("prose");
  await userEvent.click(screen.getByRole("switch", { name: "Raw" }));
  expect(await screen.findByText('{"type":"result"}')).toBeInTheDocument();
  expect(screen.queryByText("prose")).toBeNull();
  expect(seen.some((s) => s.includes("raw=1"))).toBe(true);
});

test("the search box filters the loaded cards", async () => {
  fakeStream(() => ({ items: [text(0, "alpha one"), text(1, "beta two")], next: 2 }));
  render(<TranscriptView runId="r" dispatchId="d" live={false} />);
  await screen.findByText("alpha one");
  await userEvent.type(screen.getByRole("searchbox", { name: "Search the log" }), "beta");
  expect(await screen.findByText("1 of 2 entries match.")).toBeInTheDocument();
  expect(screen.queryByText("alpha one")).toBeNull();
});

test("a failed request says why, and a missing dispatch is not an error page", async () => {
  fakeStream(() =>
    Response.json(
      { error: { message: "No such dispatch.", type: "invalid", code: "E_INPUT_INVALID" } },
      { status: 400 },
    ),
  );
  render(<TranscriptView runId="r" dispatchId="d" live={false} />);
  expect(await screen.findByText("No such dispatch.")).toBeInTheDocument();
});

test("a live log keeps asking for lines after the last one until the dispatch ends", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const seen = fakeStream((from) =>
      from === 0
        ? { items: [text(0, "one")], next: 1, ended: false }
        : { items: [text(1, "two")], next: 2, ended: true },
    );
    render(<TranscriptView runId="r" dispatchId="d" live />);
    await screen.findByText("one");
    expect(screen.getByText("Live")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    await waitFor(() => expect(screen.getByText("two")).toBeInTheDocument());
    expect(seen[1]).toContain("from=1");
    const count = seen.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(seen).toHaveLength(count);
  } finally {
    vi.useRealTimers();
  }
});
