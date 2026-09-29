import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  eventName,
  foldGrokEvents,
  grokActivity,
  grokTokens,
  isAuthFailure,
  isLimit,
  isTooOld,
  parseGrokLine,
} from "../../src/adapters/grok/events.ts";
import { parseGrokModels } from "../../src/adapters/grok/models.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "grok");
const text = (n: string) => readFileSync(join(FX, n), "utf8");
const lines = (n: string) =>
  text(n)
    .split("\n")
    .filter((l) => l.trim());

describe("grok events (spec 1.3 §5.5)", () => {
  it("takes the reply from the text after the last tool call, and the totals and cost from end", () => {
    const f = foldGrokEvents(lines("ok.jsonl"));
    expect(f.reply).toBe("Done.\nSTATUS: complete — wrote src/a.ts");
    expect(f.end).toEqual({
      stopReason: "end_turn",
      thread: "3c9a2f1e-7b4d-4e8a-9f60-1d2c3b4a5e6f",
      tokens: { input: 48210, cached: 41000, output: 1893 },
      costUsd: 0.0127,
    });
    expect(f.used).toEqual({ input: 48210, cached: 41000, output: 1893 });
    expect([f.error, f.lastEvent]).toEqual([null, "end"]);
  });

  it("reads no cost as unknown, never as 0 (a subscription login)", () => {
    expect(foldGrokEvents(lines("login-ok.jsonl")).end?.costUsd).toBeNull();
  });

  it("keeps a terminal error with no end, and sums each response's usage when end never came", () => {
    const out = foldGrokEvents(lines("not-signed-in.jsonl"));
    expect(out.end).toBeNull();
    expect(out.error).toStartWith("Not signed in.");
    expect(foldGrokEvents(lines("no-end.jsonl")).used).toEqual({ input: 23100, cached: 20000, output: 900 });
  });

  it("adds the cache reads and writes back into input (input_tokens is uncached only)", () => {
    expect(
      grokTokens({
        input_tokens: 1500,
        output_tokens: 20,
        cache_read_input_tokens: 30000,
        cache_creation_input_tokens: 500,
        reasoning_tokens: 7,
      }),
    ).toEqual({ input: 32000, cached: 30000, output: 20 });
    expect(grokTokens(undefined)).toEqual({ input: 0, cached: 0, output: 0 });
  });

  it("reads every limit text, and a missing subscription or login as no limit", () => {
    for (const f of ["rate-limit.jsonl", "free-limit.jsonl"])
      expect(isLimit(foldGrokEvents(lines(f)).error ?? "")).toBe(true);
    expect(isLimit("Model is temporarily overloaded. Try again in a moment.")).toBe(true);
    expect(isLimit("The service is temporarily at capacity")).toBe(true);
    expect(isLimit(foldGrokEvents(lines("subscription.jsonl")).error ?? "")).toBe(false);
    expect(isLimit(foldGrokEvents(lines("not-signed-in.jsonl")).error ?? "")).toBe(false);
    expect(isAuthFailure(foldGrokEvents(lines("not-signed-in.jsonl")).error ?? "")).toBe(true);
    expect(isTooOld("error: unexpected argument '--no-memory' found")).toBe(true);
    expect(isTooOld("Not signed in.")).toBe(false);
  });

  it("names tool events by tool and status, and says what the worker is doing", () => {
    expect(eventName({ type: "tool_call", toolName: "read_file" })).toBe("tool_call/read_file");
    expect(eventName({ type: "tool_call_update", status: "completed" })).toBe("tool_call_update/completed");
    const at = (i: number) => grokActivity(parseGrokLine(lines("ok.jsonl")[i] as string) ?? {});
    expect([at(2), at(3), at(6), at(8), at(1), at(4)]).toEqual([
      "I'll read the lane file.",
      "read lanes/M1.L1.md",
      "edit src/a.ts",
      "$ bun test",
      undefined,
      undefined,
    ]);
    expect(parseGrokLine("not json")).toBeNull();
    expect(parseGrokLine("[1]")).toBeNull();
  });
});

describe("grok models (spec 1.3 §5.1, §5.6)", () => {
  const shipped = { "grok-4.6": { efforts: ["low", "high"], context: 500_000 } };

  it("reads the login from the first line, the default, and the models with the catalog's efforts", () => {
    expect(parseGrokModels(text("models.txt"), shipped)).toEqual({
      loggedIn: true,
      login: "Grok",
      defaultModel: "grok-4.6",
      models: [
        { id: "grok-4.6", efforts: ["low", "high"], context: 500_000, imageIn: false },
        { id: "grok-4.7", efforts: [], context: null, imageIn: false },
        { id: "grok-4.5", efforts: [], context: null, imageIn: false },
        { id: "grok-build-0.1", efforts: [], context: null, imageIn: false },
      ],
    });
  });

  it("tells an API key, no login and an unreadable answer apart", () => {
    expect(
      parseGrokModels("You are using XAI_API_KEY.\n\nAvailable models:\n  * grok-4.6 (default)\n"),
    ).toMatchObject({
      loggedIn: true,
      login: "API key",
    });
    const out = parseGrokModels(text("models-logged-out.txt"));
    expect(out).toMatchObject({ loggedIn: false, defaultModel: "grok-4.6" });
    expect(out.login).toBeUndefined();
    expect(out.models.map((m) => m.id)).toEqual(["grok-4.6", "grok-4.5"]);
    expect(parseGrokModels("")).toEqual({ loggedIn: null, defaultModel: null, models: [] });
  });
});
