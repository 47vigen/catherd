import { describe, expect, it } from "bun:test";
import { ANTHROPIC_MODELS_URL, listClaudeModels } from "../../src/adapters/claude-code/models-api.ts";
import { fakeFetch } from "../fake-fetch.ts";

const effort = (levels: string[]) =>
  Object.fromEntries([["supported", levels.length > 0], ...levels.map((l) => [l, { supported: true }])]);
const api = (id: string, levels: string[], ctx: number) => ({
  id,
  type: "model",
  display_name: id,
  created_at: "2026-09-22T00:00:00Z",
  max_input_tokens: ctx,
  max_tokens: 128000,
  capabilities: { image_input: { supported: true }, effort: effort(levels) },
});

describe("listClaudeModels", () => {
  it("keeps the shipped list without an API key", async () => {
    const f = fakeFetch({ status: 500, body: {} });
    const ms = await listClaudeModels({ key: null, fetchImpl: f.impl });
    expect(ms.map((m) => m.id)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]);
    expect(f.sent).toHaveLength(0);
  });

  it("refreshes from the Models API page by page, keeping shipped models it does not list", async () => {
    const f = fakeFetch(
      {
        status: 200,
        body: {
          data: [
            api("claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"], 1_000_000),
            api("claude-haiku-4-5", [], 200_000),
          ],
          has_more: true,
          last_id: "claude-haiku-4-5",
        },
      },
      {
        status: 200,
        body: {
          data: [
            api("claude-haiku-4-5-20251001", [], 200_000),
            api("claude-opus-6", ["low", "max"], 2_000_000),
          ],
          has_more: false,
        },
      },
    );
    const ms = await listClaudeModels({ key: "sk-ant", fetchImpl: f.impl });
    expect(ms.map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-6",
      "claude-fable-5-1",
      "claude-sonnet-5",
    ]);
    expect(ms.find((m) => m.id === "claude-opus-6")).toEqual({
      id: "claude-opus-6",
      efforts: ["low", "max"],
      context: 2_000_000,
      imageIn: true,
    });
    expect(ms.find((m) => m.id === "claude-haiku-4-5-20251001")?.efforts).toEqual([]);
    expect(f.sent[0]?.url).toBe(`${ANTHROPIC_MODELS_URL}?limit=1000`);
    expect(f.sent[1]?.url).toBe(`${ANTHROPIC_MODELS_URL}?limit=1000&after_id=claude-haiku-4-5`);
    expect(f.sent[0]?.headers.get("x-api-key")).toBe("sk-ant");
    expect(f.sent[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("keeps the shipped list when the API refuses the key or cannot be reached", async () => {
    for (const reply of [{ status: 401, body: {} }, new TypeError("fetch failed")]) {
      const ms = await listClaudeModels({ key: "bad", fetchImpl: fakeFetch(reply).impl });
      expect(ms).toHaveLength(4);
    }
  });
});
