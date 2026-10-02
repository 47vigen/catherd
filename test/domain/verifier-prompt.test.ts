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
      "catherd lock --role verifier -- <command>",
      "Build each commit's images once, and reuse them for the boot check and the acceptance suite.",
      "- One line per gate item: PASS|FAIL, or carried over from <commit>.",
    ])
      expect(text).toContain(s);
    expect(text.split("\n")[0]).toStartWith("You verify work you did not write.");
  });

  it("names the CLI forms as the fallback when no gate tool is listed (spec 1.5 plan 21)", () => {
    const text = rolePrompt("verifier", "1.5.0");
    expect(text).toContain(
      "When neither tool is listed, run the same from your shell: catherd gate check <run>",
    );
    expect(text).toContain("then catherd gate pass <run> --item <item>");
  });

  it("tells each role only the run-file tools it gets (#42 finding 5)", () => {
    const worker = rolePrompt("worker", "1.5.0");
    expect(worker).toContain("Read it only through catherd's read_run_file");
    expect(worker).toContain("catherd run-file read <run> <path>");
    expect(worker).not.toContain("write_run_file");
    for (const role of ["architect", "researcher"] as const) {
      const text = rolePrompt(role, "1.5.0");
      expect(text).toContain("Read and write it only through catherd's read_run_file and write_run_file");
      expect(text).toContain("catherd run-file write <run> <path> with the content on stdin");
    }
  });
});
