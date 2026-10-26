import { describe, expect, it } from "bun:test";
import { rolePrompt } from "../../src/domain/role-prompts.ts";

describe("the verifier's prompt (spec 1.1 §7)", () => {
  it("checks the gate ledger before each item, records each pass, and runs items side by side", () => {
    const text = rolePrompt("verifier", "1.1.0");
    for (const s of [
      "`catherd gate check <run> --milestone <M> --item <item> --command <command> --paths <path,…>`",
      "`catherd gate pass <run> --milestone <M> --item <item> --command <command> --paths <path,…> --evidence <evidence>`",
      "report it as carried over from its commit",
      "Run independent items side by side, each heavy one wrapped in catherd lock",
      "catherd lock --role verifier -- <command>",
      "Build each commit's images once, and reuse them for the boot check and the acceptance suite.",
      "- One line per gate item: `PASS <item>`, `FAIL <item> — the decisive output`, or carried over from <commit>.",
    ])
      expect(text).toContain(s);
    expect(text.split("\n")[0]).toStartWith("You verify work you did not write.");
  });

  it("names the CLI forms only, and says a listed tool of the same name does the same (plan 44 D1)", () => {
    const text = rolePrompt("verifier", "1.5.0");
    expect(text).toContain(
      "When your harness lists catherd tools with the same names (gate_check, gate_pass)",
    );
    expect(text).toContain("catherd gate check <run> --milestone <M>` with only the run id");
    expect(text).not.toContain("mcp__");
  });

  it("the prompt names the milestone argument of gate_pass", () => {
    const text = rolePrompt("verifier", "1.5.0");
    expect(text).toContain("the same milestone, item, command and paths");
    expect(text).toContain("gate pass <run> --milestone <M>");
    expect(text).toContain("every top-level `&&` part as its own item");
  });

  it("tells each role only the run-file tools it gets (#42 finding 5)", () => {
    const worker = rolePrompt("worker", "1.5.0");
    expect(worker).toContain("Read it only with `catherd run-file read <run> <path>`");
    expect(worker).not.toContain("run-file write");
    expect(worker).not.toContain("mcp__");
    for (const role of ["architect", "researcher"] as const) {
      const text = rolePrompt(role, "1.5.0");
      expect(text).toContain("Read and write it only with `catherd run-file read <run> <path>`");
      expect(text).toContain("`catherd run-file write <run> <path>` (the content on stdin)");
      expect(text).not.toContain("mcp__");
    }
  });

  it("the verifier is not told to stay in the foreground", () => {
    expect(rolePrompt("verifier", "1.5.0")).not.toContain("Stay in the foreground");
  });

  it("leaves the milestone's Check to catherd, and runs only what its acceptance lines need", () => {
    const text = rolePrompt("verifier", "1.5.0");
    expect(text).toContain("The milestone's Check is catherd's");
    expect(text).toContain(
      "Run only what your acceptance lines need, each heavy command in `catherd lock --role verifier -- <command>`",
    );
  });

  it("the verifier judges a commit-history line from the tree", () => {
    expect(rolePrompt("verifier", "1.5.0")).toContain("judged from the tree");
  });

  it("records HEAD first, puts file:line in FAIL lines and calls a minor issue a NIT", () => {
    const text = rolePrompt("verifier", "1.5.0");
    expect(text).toContain("0. Record git rev-parse HEAD first");
    expect(text).toContain("FAIL file:line — what happens");
    expect(text).toContain("is a NIT line, never a FAIL");
  });

  it("judges from the tree only the lines about the tree, and wants a RAN line for the rest (plan 44 D8)", () => {
    const text = rolePrompt("verifier", "1.5.0");
    expect(text).toContain("a submodule pin, the diff's contents, commit history");
    expect(text).toContain("every other line needs a RAN line");
  });
});
