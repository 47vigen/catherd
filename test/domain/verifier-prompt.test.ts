import { describe, expect, it } from "bun:test";
import { rolePrompt } from "../../src/domain/role-prompts.ts";

describe("the verifier's prompt (spec 1.1 §7)", () => {
  it("checks the gate ledger before each item, records each pass, and runs items side by side", () => {
    const text = rolePrompt("verifier", "1.1.0");
    for (const s of [
      "mcp__plugin_catherd_catherd__gate_check",
      "mcp__plugin_catherd_catherd__gate_pass",
      "report it as carried over from its commit",
      "Run independent items side by side, each heavy one wrapped in catherd lock",
      "Build each commit's images once, and reuse them for the boot check and the acceptance suite.",
      "- One line per gate item: PASS|FAIL, or carried over from <commit>.",
    ])
      expect(text).toContain(s);
    expect(text.split("\n")[0]).toStartWith("You verify work you did not write.");
  });
});
