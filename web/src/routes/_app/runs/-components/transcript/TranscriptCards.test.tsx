import { render, screen, within } from "@testing-library/react";

import "../../../../../test/dom-shims";
import type { Card } from "./merge";
import { TranscriptCards } from "./TranscriptCards";

const base = { raw: null, showRaw: false, query: "", live: false };

const cards: Card[] = [
  { kind: "text", line: 0, text: "Reading the alpha module first." },
  { kind: "thinking", line: 1, text: "Plan: touch beta only." },
  { kind: "shell", line: 2, id: "s1", command: "bun test", output: "1 failed\n2 passed", exit: 1 },
  { kind: "turn", line: 3, tokens: { input: 1000, cached: 200, output: 234 }, costUsd: 0.0123 },
];

test("a shell card shows the command, output and exit code", () => {
  render(<TranscriptCards {...base} cards={cards} />);
  const shell = screen.getByText("bun test").closest("li") as HTMLElement;
  expect(within(shell).getByText("$")).toBeInTheDocument();
  expect(shell).toHaveTextContent("1 failed");
  expect(within(shell).getByText("Exit 1")).toBeInTheDocument();
});

test("exit codes read success, danger or running", () => {
  const shell = (exit: number | null): Card => ({ kind: "shell", line: 0, id: "x", command: "ls", output: null, exit });
  const { rerender } = render(<TranscriptCards {...base} cards={[shell(0)]} />);
  expect(screen.getByText("Exit 0")).toBeInTheDocument();
  rerender(<TranscriptCards {...base} cards={[shell(null)]} />);
  expect(screen.getByText("Running")).toBeInTheDocument();
});

test("thinking starts closed", () => {
  const { container } = render(<TranscriptCards {...base} cards={cards} />);
  const details = container.querySelector("details");
  expect(details).not.toBeNull();
  expect(details).not.toHaveAttribute("open");
  expect(within(details as HTMLElement).getByText("Thinking")).toBeInTheDocument();
});

test("search keeps the matching cards and counts them", () => {
  render(<TranscriptCards {...base} cards={cards} query="ALPHA" />);
  expect(screen.getByText("Reading the alpha module first.")).toBeInTheDocument();
  expect(screen.queryByText("bun test")).toBeNull();
  expect(screen.getByText("1 of 4 entries match.")).toBeInTheDocument();
});

test("cards are drawn newest first, after the search", () => {
  const kinds = () => [...document.querySelectorAll("li[data-kind]")].map((li) => li.getAttribute("data-kind"));
  const { rerender } = render(<TranscriptCards {...base} cards={cards} />);
  expect(kinds()).toEqual(["turn", "shell", "thinking", "text"]);
  const two: Card[] = [
    { kind: "text", line: 0, text: "match one" },
    { kind: "text", line: 1, text: "other" },
    { kind: "text", line: 2, text: "match two" },
  ];
  rerender(<TranscriptCards {...base} cards={two} query="match" />);
  const items = [...document.querySelectorAll("li[data-kind]")].map((li) => li.textContent);
  expect(items).toEqual(["match two", "match one"]);
});

test("raw lines are drawn newest first", () => {
  render(<TranscriptCards {...base} cards={cards} raw={["first", "second"]} showRaw />);
  const items = [...document.querySelectorAll("li")].map((li) => li.textContent);
  expect(items).toEqual(["second", "first"]);
});

test("an open Thinking block stays open when a newer card arrives", () => {
  const { container, rerender } = render(<TranscriptCards {...base} cards={cards} />);
  const details = container.querySelector("details") as HTMLDetailsElement;
  details.open = true;
  rerender(<TranscriptCards {...base} cards={[...cards, { kind: "text", line: 4, text: "newer" }]} />);
  expect(container.querySelector("details")).toBe(details);
  expect(details.open).toBe(true);
});

test("Raw shows the lines as written", () => {
  const raw = ['{"type":"assistant","n":1}', '{"type":"result"}'];
  render(<TranscriptCards {...base} cards={cards} raw={raw} showRaw />);
  expect(screen.getByText(raw[0] as string)).toBeInTheDocument();
  expect(screen.getByText(raw[1] as string)).toBeInTheDocument();
  expect(screen.queryByText("bun test")).toBeNull();
});

test("an error stands out, a tool shows its input and a failed output, a turn is a muted line", () => {
  const more: Card[] = [
    { kind: "error", line: 0, text: "rate limit reached" },
    { kind: "tool", line: 1, id: "t", name: "Read", input: '{"path":"a.ts"}', output: "ENOENT", error: true },
    ...cards.slice(3),
  ];
  render(<TranscriptCards {...base} cards={more} />);
  const alert = screen.getByText("rate limit reached").closest("[data-slot='alert-root']");
  expect(alert).toHaveClass("alert--danger");
  const tool = screen.getByText("Read").closest("li") as HTMLElement;
  expect(tool).toHaveTextContent("a.ts");
  expect(within(tool).getByText("Failed")).toBeInTheDocument();
  expect(screen.getByText("Turn ended · 1,234 tokens · $0.0123")).toBeInTheDocument();
});

test("a file card lists its paths and diff", () => {
  const file: Card = {
    kind: "file",
    line: 0,
    id: "f",
    changes: [{ path: "src/a.ts", kind: "update" }],
    diff: "-old\n+new",
  };
  render(<TranscriptCards {...base} cards={[file]} />);
  expect(screen.getByText("src/a.ts")).toBeInTheDocument();
  expect(screen.getByText("update")).toBeInTheDocument();
  expect(screen.getByText("+new")).toBeInTheDocument();
});

test("live adds a Live marker, and an empty log says so", () => {
  const { rerender } = render(<TranscriptCards {...base} cards={[]} live />);
  expect(screen.getByText("Live")).toBeInTheDocument();
  expect(screen.getByText("Nothing has been logged yet.")).toBeInTheDocument();
  rerender(<TranscriptCards {...base} cards={[]} />);
  expect(screen.queryByText("Live")).toBeNull();
});
