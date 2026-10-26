import { describe, expect, it } from "bun:test";
import { parseRanLines, parseRunLines, verifierShortfall } from "../../src/domain/ran-lines.ts";

describe("RUN lines of a verifier brief", () => {
  it("lists each RUN command, markers and bold dropped", () => {
    expect(parseRunLines("intro\nRUN: bun test\n- **RUN:** make e2e  \nnot RUN: x")).toEqual([
      "bun test",
      "make e2e",
    ]);
  });
});

describe("RAN lines", () => {
  it("parse with their exit and log", () => {
    expect(parseRanLines("- **RAN:** bun test — exit 0 — /tmp/x/test.log")).toEqual([
      { command: "bun test", exit: 0, log: "/tmp/x/test.log" },
    ]);
    expect(parseRanLines("RAN: make e2e — NOT RUN")).toEqual([
      { command: "make e2e", exit: null, log: null },
    ]);
  });

  it("accept en dash, hyphen and 'exit: n'", () => {
    expect(parseRanLines("RAN: bun test – exit: 1 – logs/t.log\nRAN: a b - exit 2 - /l")).toEqual([
      { command: "bun test", exit: 1, log: "logs/t.log" },
      { command: "a b", exit: 2, log: "/l" },
    ]);
  });
});

describe("verifierShortfall", () => {
  const ok = () => true;
  it("a PASS short of a command is a FAIL", () => {
    expect(verifierShortfall(["bun test"], [], ok)).toEqual(["FAIL bun test: NOT RUN (no RAN line)"]);
    expect(verifierShortfall(["bun test"], [{ command: "bun test", exit: 1, log: "/x" }], ok)).toEqual([
      "FAIL bun test: exit 1",
    ]);
    expect(
      verifierShortfall(["bun test"], [{ command: "bun test", exit: 0, log: "/x" }], () => false),
    ).toEqual(["FAIL bun test: log /x missing or empty"]);
    expect(verifierShortfall(["bun   test"], [{ command: "bun test", exit: 0, log: "/x" }], ok)).toEqual([]);
  });

  it("a NOT RUN line or a missing log path is a shortfall", () => {
    expect(verifierShortfall(["a"], [{ command: "a", exit: null, log: null }], ok)).toEqual([
      "FAIL a: NOT RUN (no RAN line)",
    ]);
    expect(verifierShortfall(["a"], [{ command: "a", exit: 0, log: null }], ok)).toEqual([
      "FAIL a: log missing or empty",
    ]);
  });
});
