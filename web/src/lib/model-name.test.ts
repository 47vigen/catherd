import { describe, expect, test } from "vitest";

import { modelName } from "./model-name";

describe("modelName", () => {
  test("a provider path reads as the model", () => {
    expect(modelName("openscale/deepseek/deepseek-v4.1-flash")).toBe("DeepSeek V4.1 Flash");
    expect(modelName("opencode-go:moonshot/kimi-k2")).toBe("Kimi K2");
  });

  test("every form the three old copies read", () => {
    expect(modelName("codex:gpt-6-luna#high")).toBe("GPT-6 Luna");
    expect(modelName("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelName("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(modelName("claude-sonnet-4-5-20250929")).toBe("Claude Sonnet 4.5");
    expect(modelName("gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
    expect(modelName("glm-4.6")).toBe("GLM-4.6");
    expect(modelName("other")).toBe("Other");
  });

  test("a colon after a slash belongs to the model", () => {
    expect(modelName("ollama/qwen3:8b")).toBe("Qwen3:8b");
  });
});
