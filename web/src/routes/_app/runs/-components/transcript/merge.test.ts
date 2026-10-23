import type { TranscriptItem } from "../../../../../client";
import { cardText, mergeTranscript, type Card } from "./merge";

const tool = (id: string, line: number, output: string | null = null): TranscriptItem => ({
  kind: "tool",
  line,
  id,
  name: "Read",
  input: '{"path":"a.ts"}',
  output,
  error: false,
});

test("items with one id are one card; an output fills it", () => {
  const cards = mergeTranscript(
    [],
    [
      tool("t1", 0),
      { kind: "text", line: 1, text: "next" },
      { kind: "output", line: 2, id: "t1", text: "file body", error: true },
    ],
  );
  expect(cards.map((c) => c.kind)).toEqual(["tool", "text"]);
  expect(cards[0]).toMatchObject({ id: "t1", output: "file body", error: true });
});

test("a later item replaces the earlier in place", () => {
  const first = mergeTranscript([], [tool("a", 0), tool("b", 1)]);
  const next = mergeTranscript(first, [tool("a", 2, "done")]);
  expect(next.map((c) => (c.kind === "tool" ? [c.id, c.output] : null))).toEqual([
    ["a", "done"],
    ["b", null],
  ]);
  expect(first[0]).toMatchObject({ output: null });
});

test("an output fills a shell card from an earlier page", () => {
  const page1 = mergeTranscript([], [{ kind: "shell", line: 0, id: "s", command: "ls", output: null, exit: null }]);
  const page2 = mergeTranscript(page1, [{ kind: "output", line: 9, id: "s", text: "a\nb", error: false }]);
  expect(page2[0]).toMatchObject({ kind: "shell", output: "a\nb", exit: null });
});

test("a thinking step with no text is left out", () => {
  const cards = mergeTranscript(
    [],
    [
      { kind: "thinking", line: 0, text: "  " },
      { kind: "thinking", line: 1, text: "hmm" },
    ],
  );
  expect(cards).toHaveLength(1);
});

test("an output for no card is dropped", () => {
  expect(mergeTranscript([], [{ kind: "output", line: 0, id: "x", text: "o", error: false }])).toEqual([]);
});

test("cardText gathers what a search should match", () => {
  const file: Card = { kind: "file", line: 0, id: "f", changes: [{ path: "src/a.ts", kind: "update" }], diff: "+x" };
  expect(cardText(file)).toContain("src/a.ts");
  expect(cardText(file)).toContain("+x");
  expect(cardText({ kind: "turn", line: 1, tokens: null, costUsd: null })).toBe("");
});
