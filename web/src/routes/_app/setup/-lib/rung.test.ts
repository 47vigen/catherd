import { dropAt, effortsOf, modelName, moveBy, pairLine, parseRung, providerGroups, withEffort } from "./rung";

test("a rung splits into backend, model and effort", () => {
  expect(parseRung("codex:gpt-6-sol#xhigh")).toEqual({
    backend: "codex",
    model: "gpt-6-sol",
    effort: "xhigh",
  });
  expect(parseRung("opencode:opencode/claude-opus-5-5#high")).toEqual({
    backend: "opencode",
    model: "opencode/claude-opus-5-5",
    effort: "high",
  });
  expect(parseRung("claude:claude-opus-5-5")).toEqual({
    backend: "claude",
    model: "claude-opus-5-5",
    effort: null,
  });
});

test("a pair line shows only what the index knows", () => {
  const pair = {
    rung: "codex:a#high",
    intelligence: 50,
    price: { input: 1.25, output: 10 },
    speed: 80,
    context: null,
    cost: { tier: 0 as const, value: 0, mode: "chatgpt-plan" as const },
    evidence: null,
  };
  expect(pairLine(pair)).toBe("benchmark 50.0 · $1.25/$10 per M · 80 tok/s · plan");
  expect(
    pairLine({
      ...pair,
      price: null,
      speed: null,
      cost: { ...pair.cost, tier: 1 },
    }),
  ).toBe("benchmark 50.0");
});

test("a rung moves one place and stops at the ends", () => {
  expect(moveBy(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
  expect(moveBy(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  expect(moveBy(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
  expect(moveBy(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
});

test("a drop places the dragged rung before or after the target", () => {
  expect(dropAt(["a", "b", "c"], ["a"], "c", "after")).toEqual(["b", "c", "a"]);
  expect(dropAt(["a", "b", "c"], ["c"], "a", "before")).toEqual(["c", "a", "b"]);
  expect(dropAt(["a", "b", "c"], ["a"], "a", "after")).toEqual(["a", "b", "c"]);
});

test("a model id reads the way people say it", () => {
  expect(modelName("claude-opus-5-5")).toBe("Claude Opus 5.5");
  expect(modelName("opencode/claude-sonnet-5")).toBe("Claude Sonnet 5");
  expect(modelName("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
  expect(modelName("opencode-go/gpt-6-luna")).toBe("GPT-6 Luna");
  expect(modelName("gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
  expect(modelName("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5 20251001");
});

test("a rung's efforts are the ones offered for its model, lowest first", () => {
  const offered = ["codex:m#max", "codex:m#low", "codex:n#high", "opencode:m#high"].map((rung) => ({ rung }));
  expect(effortsOf("codex:m#high", offered)).toEqual(["low", "high", "max"]);
  expect(effortsOf("claude:m", offered)).toEqual([]);
  expect(withEffort("codex:m#high", "max")).toBe("codex:m#max");
});

test("pairs group by provider in first-seen order", () => {
  const p = (rung: string) => ({ rung }) as never;
  expect(
    providerGroups([p("codex:a#high"), p("claude-code:b#high"), p("codex:c#low")]).map((g) => [
      g.backend,
      g.pairs.length,
    ]),
  ).toEqual([
    ["codex", 2],
    ["claude-code", 1],
  ]);
});
