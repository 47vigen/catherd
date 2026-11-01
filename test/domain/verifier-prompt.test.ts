import { describe, expect, it } from "bun:test";
import { roleContract, rolePrompt } from "../../src/domain/role-prompts.ts";

describe("the one verifier's prompt (plan 50, spec D8)", () => {
  it("verifies the integrated product once, reads the full check's result and runs what it does not cover", () => {
    const text = rolePrompt("verifier", "1.5.0");
    expect(text.split("\n")[0]).toStartWith("You verify a run's integrated product once, before it lands.");
    for (const s of [
      "The full check is catherd's",
      "Do not run it again.",
      "each heavy command wrapped as your brief says: `bunx catherd-cli@<version> lock -- <command>`",
      "git diff <base>...HEAD",
      "A VERDICT: PASS with no RAN line is read as a FAIL",
      "run it on HEAD and name both exit codes",
    ])
      expect(text).toContain(s);
  });

  it("has no milestone, gate item, gate tool or role lock left", () => {
    const text = rolePrompt("verifier", "1.5.0");
    for (const s of [
      "gate_check",
      "gate_pass",
      "gate_run",
      "catherd gate",
      "--role verifier",
      "milestone",
      "gate item",
    ])
      expect(text).not.toContain(s);
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
    expect(text).toContain("(a submodule pin, a file's contents)");
    expect(text).toContain("every other line needs a RAN line");
  });
});

describe("the verifier runs beside the full check (plan 57, spec D8 amended)", () => {
  it("tells the architect to delegate the verifier with the full check, on the same commit, in both tree modes", () => {
    for (const trees of ["writer", "shared"] as const) {
      const text = roleContract("architect", "1.5.0", trees);
      for (const s of [
        "delegate the verifier in the same turn as the full check",
        "no writer is running",
        "the same commit",
        "the verifier's brief names the check id, its command, the commit and its log path (checks/<id>.log)",
        "land final still needs both",
      ])
        expect(text).toContain(s);
      expect(text).not.toContain("then check scope full and delegate the verifier");
      // a run without a base ends with finish, and gets the same rule
      expect(text).toContain("Before finish done in a run without a base, the same as for land final");
    }
  });

  it("tells the verifier the full check may still be running and never to wait for it", () => {
    const text = rolePrompt("verifier", "1.5.0");
    for (const s of [
      "may still be running",
      "never wait for it",
      "read its log at the path your brief names only if it is already complete",
      "land final requires the full check green on this commit, apart from your verdict",
    ])
      expect(text).toContain(s);
  });
});

describe("plan 45: no walls, and gates judge the product", () => {
  it("the worker works freely and talks to its team (plan 48: no lanes)", () => {
    const worker = rolePrompt("worker", "1.5.0");
    for (const s of [
      "Change only the files you own",
      "Change only the files the findings name",
      "commit messages, trailers or branch history",
      "the files you must not touch",
    ])
      expect(worker).not.toContain(s);
    for (const s of [
      "Change whatever your task needs, anywhere",
      "catherd team read",
      "as `changed <what> in <file>: <why>`",
      "--to architect",
    ])
      expect(worker).toContain(s);
  });

  it("the writer works freely too, with no lane (plan 50), and only the architect's messages may arrive mid-turn", () => {
    const writer = rolePrompt("writer", "1.5.0");
    expect(writer).not.toContain("files you own");
    for (const s of ["lane", "Owns", "milestone"]) expect(writer).not.toContain(s);
    expect(writer).toContain("Change whatever the docs need, anywhere");
    expect(writer).toContain("EXTRA: <path> — <why>");
    const worker = rolePrompt("worker", "1.5.0");
    expect(worker).not.toContain("none interrupts a running worker");
    expect(worker).not.toContain("Owns");
  });

  it("the verifier, architect and reviewer judge the product, not the process", () => {
    const verifier = rolePrompt("verifier", "1.5.0");
    expect(verifier).not.toContain("commit history");
    expect(verifier).toContain("Judge the product, never the process");
    const architect = rolePrompt("architect", "1.5.0");
    expect(architect).not.toContain("what no worker may touch");
    expect(rolePrompt("reviewer", "1.5.0")).toContain("which files it touched: judge the change");
  });

  it("the architect changes the plan mid-run with no approval and no test refusal", () => {
    const architect = rolePrompt("architect", "1.5.0");
    expect(architect).not.toContain("waits for the owner's approval again");
    expect(architect).not.toContain("A task without a test is refused");
  });
});
