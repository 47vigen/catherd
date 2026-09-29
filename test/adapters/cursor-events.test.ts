import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cursorActivity,
  cursorTokens,
  eventName,
  foldCursorEvents,
  isAuthFailure,
  isLimit,
  isTooOld,
  parseCursorLine,
} from "../../src/adapters/cursor/events.ts";
import { cursorSlug, parseCursorModels } from "../../src/adapters/cursor/models.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "cursor");
const lines = (n: string) =>
  readFileSync(join(FX, n), "utf8")
    .split("\n")
    .filter((l) => l.trim());

describe("cursor events (spec 1.3 §4.5)", () => {
  it("takes the thread from system/init, the reply after the last tool call, tokens from result", () => {
    const f = foldCursorEvents(lines("ok.jsonl"));
    expect(f.thread).toBe("2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21");
    // result.result runs every segment together; the reply is the text after the last tool call
    expect(f.reply).toBe("Done.\nSTATUS: complete — wrote src/a.ts");
    expect(f.result).toEqual({
      isError: false,
      text: "I'll read the lane file.Done.\nSTATUS: complete — wrote src/a.ts",
      tokens: { input: 15989, cached: 9728, output: 25 },
    });
    expect(f.lastEvent).toBe("result/success");
  });

  it("adds cache reads and writes back into input (inputTokens is uncached only), and reads no usage as zero", () => {
    expect(
      cursorTokens({ inputTokens: 1200, outputTokens: 12, cacheReadTokens: 14000, cacheWriteTokens: 300 }),
    ).toEqual({ input: 15500, cached: 14000, output: 12 });
    expect(cursorTokens(undefined)).toEqual({ input: 0, cached: 0, output: 0 });
  });

  it("names events by type, and tool calls by phase and tool", () => {
    expect(eventName({ type: "tool_call", subtype: "started", tool_call: { writeToolCall: {} } })).toBe(
      "tool_call/started/writeToolCall",
    );
    expect(eventName({ type: "system", subtype: "init" })).toBe("system/init");
    expect(eventName({ type: "retry", subtype: "starting" })).toBe("retry/starting");
  });

  it("says what the worker is doing: a command, a file it reads or edits, its text", () => {
    const at = (i: number) => cursorActivity(parseCursorLine(lines("ok.jsonl")[i] as string) ?? {});
    expect([at(3), at(4), at(6), at(10), at(2)]).toEqual([
      "I'll read the lane file.",
      "read lanes/M1.L1.md",
      "edit src/a.ts",
      "$ bun test",
      undefined,
    ]);
  });

  it("tells a usage limit from a team policy, and reads a CLI too old and a login that is missing", () => {
    expect(isLimit("ActionRequiredError: You've hit your usage limit")).toBe(true);
    expect(isLimit("Error: PRO_USER_USAGE_LIMIT")).toBe(true);
    expect(isLimit("RATE_LIMITED_TOO_MANY_REQUESTS")).toBe(true);
    expect(isLimit("Error: Your team administrator has disabled the 'Run Everything' option.")).toBe(false);
    expect(isLimit("Error: Your team administrator has disabled headless Cursor CLI usage.")).toBe(false);
    expect(isLimit("Model is not available")).toBe(false);
    expect(isTooOld("error: unknown option '--disable-auto-update'")).toBe(true);
    expect(isTooOld("ActionRequiredError: OUTDATED_CLIENT")).toBe(true);
    expect(isAuthFailure("Error: Authentication required. Please run 'agent login' first")).toBe(true);
  });

  it("reads no final result from a run that failed before one", () => {
    const f = foldCursorEvents(lines("no-result.jsonl"));
    expect([f.thread, f.result, f.reply]).toEqual(["7d6c5b4a-3928-4716-8a5b-4c3d2e1f0a9b", null, null]);
  });
});

describe("cursor models (spec 1.3 §4.6)", () => {
  it("folds effort slugs into one model, lists default only for a bare slug, and skips other lines", () => {
    const models = parseCursorModels(readFileSync(join(FX, "models.txt"), "utf8"));
    expect(models.map((m) => [m.id, m.efforts])).toEqual([
      ["auto", ["default"]],
      ["composer-2.5", ["default"]],
      ["composer-2.5-fast", ["default"]],
      ["gpt-6-sol", ["default", "low", "high", "xhigh"]],
      ["gpt-6-luna", ["high"]],
      ["claude-opus-5-5-thinking", ["high"]],
      ["grok-4.7", ["default"]],
      ["gemini-3.8-flash", ["default"]],
    ]);
  });

  it("ignores colour codes, and an account with no models", () => {
    const esc = String.fromCharCode(27);
    expect(
      parseCursorModels(
        `${esc}[2mAvailable models${esc}[0m\n${esc}[1mgpt-6-sol-low - GPT-6 Sol Low${esc}[0m\n`,
      ),
    ).toEqual([{ id: "gpt-6-sol", efforts: ["low"], context: null, imageIn: false }]);
    expect(parseCursorModels("No models available for this account.\n")).toEqual([]);
  });

  it("runs a rung's effort as the model's suffixed slug, and default as the bare slug", () => {
    expect(cursorSlug("gpt-6-sol", "xhigh")).toBe("gpt-6-sol-xhigh");
    expect(cursorSlug("composer-2.5", "default")).toBe("composer-2.5");
  });
});
