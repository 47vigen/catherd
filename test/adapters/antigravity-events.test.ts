import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agyActivity,
  agyError,
  agyTokens,
  eventName,
  foldAgyEvents,
  isAuthFailure,
  isLimit,
  isTooOld,
  parseAgyLine,
} from "../../src/adapters/antigravity/events.ts";
import { parseAgyModels } from "../../src/adapters/antigravity/models.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "antigravity");
const lines = (n: string) =>
  readFileSync(join(FX, n), "utf8")
    .split("\n")
    .filter((l) => l.trim());

describe("agy events (spec 1.3 §6.5)", () => {
  it("takes the thread and the reply from the result, and its tokens with thinking as output", () => {
    const f = foldAgyEvents(lines("ok.jsonl"));
    expect(f.thread).toBe("3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c");
    // the reply is result.response, never the text deltas run together
    expect(f.result).toEqual({
      status: "SUCCESS",
      response: "Done.\nSTATUS: complete — wrote src/a.ts",
      error: "",
      tokens: { input: 15989, cached: 9728, output: 335 },
    });
    expect(f.lastEvent).toBe("result/SUCCESS");
  });

  it("counts input as reported, unless the cache reads exceed it: then it is uncached and they add back", () => {
    expect(
      agyTokens({ input_tokens: 15989, output_tokens: 25, thinking_tokens: 310, cache_read_tokens: 9728 }),
    ).toEqual({ input: 15989, cached: 9728, output: 335 });
    expect(agyTokens({ input_tokens: 800, output_tokens: 12, cache_read_tokens: 14000 })).toEqual({
      input: 14800,
      cached: 14000,
      output: 12,
    });
    expect(agyTokens(undefined)).toEqual({ input: 0, cached: 0, output: 0 });
  });

  it("names events by kind, step type and state, and reads a payload nested under its event or flat", () => {
    const l = lines("ok.jsonl");
    expect(l.map((x) => eventName(parseAgyLine(x) ?? {})).slice(0, 5)).toEqual([
      "init",
      "step_update/user_input/DONE",
      "step_update/agent_response/ACTIVE",
      "step_update/agent_response/DONE",
      "step_update/tool/ACTIVE",
    ]);
    expect(eventName({ event: "step_update", step_type: "tool", state: "DONE" })).toBe(
      "step_update/tool/DONE",
    );
  });

  it("says what the worker is doing: a command, a file it reads or edits, its text", () => {
    const at = (i: number) => agyActivity(parseAgyLine(lines("ok.jsonl")[i] as string) ?? {});
    expect([at(2), at(4), at(6), at(8), at(5), at(10)]).toEqual([
      "I'll read the lane file.",
      "read lanes/M1.L1.md",
      "edit src/a.ts",
      "$ bun test",
      undefined,
      undefined,
    ]);
  });

  it("reads the AGY_ERROR line, and tells a quota stop, a CLI too old and a login that is missing", () => {
    const stderr =
      'warning: retrying\nAGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false,"error_id":"e-7f3a","message":"Weekly quota exhausted for Gemini 3.8 Flash."}\n';
    expect(agyError(stderr)).toEqual({
      text: '{"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false,"error_id":"e-7f3a","message":"Weekly quota exhausted for Gemini 3.8 Flash."}',
      message: "Weekly quota exhausted for Gemini 3.8 Flash.",
    });
    expect(agyError("AGY_ERROR: not json\n")).toEqual({ text: "not json", message: "not json" });
    expect(agyError("nothing here")).toBeNull();
    expect(isLimit("RESOURCE_EXHAUSTED")).toBe(true);
    expect(isLimit("the daily spend cap of the project was reached")).toBe(true);
    expect(isLimit("You are out of AI credits")).toBe(true);
    expect(isLimit("model request failed")).toBe(false);
    expect(isTooOld("flags provided but not defined: -disable-slash-commands")).toBe(true);
    expect(isAuthFailure("authentication failed or timed out")).toBe(true);
    expect(isAuthFailure("Error: Please sign in to view available models.")).toBe(true);
  });

  it("reads no result from a run that ended before one, and ignores lines that are not events", () => {
    const f = foldAgyEvents(lines("partial.jsonl"));
    expect([f.thread, f.result]).toEqual(["9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", null]);
    expect(parseAgyLine('{"type":"x"}')).toBeNull();
    expect(parseAgyLine("Authentication required")).toBeNull();
  });
});

describe("agy models (spec 1.3 §6.6)", () => {
  it("folds effort slugs, gives a bare-only model every --effort, and skips headers and tips", () => {
    const models = parseAgyModels(readFileSync(join(FX, "models.txt"), "utf8"));
    expect(models.map((m) => [m.id, m.efforts])).toEqual([
      ["gemini-3.8-flash", ["default", "high"]],
      ["gemini-3.7-flash", ["default", "low", "medium", "high", "max"]],
      ["gemini-3.6-flash", ["default", "low", "medium", "high", "max"]],
      ["gemini-3.1-pro", ["low", "high"]],
      ["claude-sonnet-4-6", ["default", "low", "medium", "high", "max"]],
      ["gpt-oss-120b", ["default", "low", "medium", "high", "max"]],
    ]);
  });

  it("reads nothing from a listing that asks for a sign-in", () => {
    expect(
      parseAgyModels(
        "Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n",
      ),
    ).toEqual([]);
  });
});
