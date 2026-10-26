import { describe, expect, it } from "bun:test";
import { headlessRung } from "../../src/domain/ids.ts";
import { JUDGE_CONTRACT, JudgeDecisionSchema, judgeName, parseJudgeReply } from "../../src/domain/judge.ts";
import { BUILTIN_ROLES } from "../../src/domain/profile.ts";
import { replyContract, rolePrompt } from "../../src/domain/role-prompts.ts";
import { ROLES } from "../../src/domain/roles.ts";

describe("the rules review's reply (plan 34)", () => {
  it("reads a rules review's changes, at most five, and none", () => {
    expect(
      parseJudgeReply(
        "DECISION: rules\n1. ADD [worker] run bun test <file> — M1 round 2\n- **REMOVE** use the v1 client — stale since M2\nSTATUS: complete — ok",
        "rules",
      ),
    ).toEqual({
      verb: "rules",
      changes: [
        { op: "add", text: "[worker] run bun test <file>", why: "M1 round 2" },
        { op: "remove", text: "use the v1 client", why: "stale since M2" },
      ],
    });
    expect(parseJudgeReply("DECISION: rules\nSTATUS: complete — nothing to change", "rules")).toEqual({
      verb: "rules",
      changes: [],
    });
    expect(
      (parseJudgeReply(`DECISION: rules\n${"ADD x — y\n".repeat(7)}`, "rules") as { changes: unknown[] })
        .changes,
    ).toHaveLength(5);
    expect(parseJudgeReply("DECISION: retry\nWHY: x", "rules")).toBeNull();
    expect(parseJudgeReply("DECISION: rules\nADD x — y", "triage")).toBeNull();
  });

  it("reads the tagged reason, so a rule may hold an em dash", () => {
    expect(
      parseJudgeReply(
        "DECISION: rules\nADD keep `a — b` aligned — WHY: M1 round 2 — the lint\nREMOVE x — y — WHY: stale\nSTATUS: complete — ok",
        "rules",
      ),
    ).toEqual({
      verb: "rules",
      changes: [
        { op: "add", text: "keep `a — b` aligned", why: "M1 round 2 — the lint" },
        { op: "remove", text: "x — y", why: "stale" },
      ],
    });
    expect(JUDGE_CONTRACT).toContain("— WHY: <the event it comes from>");
  });

  it("reads only the contract's upper-case ADD and REMOVE, not prose that starts with the word", () => {
    expect(
      parseJudgeReply(
        "DECISION: rules\nAdd a note to the report about this.\nRemove the stale lines if you agree.\nADD x — y\nSTATUS: complete — ok",
        "rules",
      ),
    ).toEqual({ verb: "rules", changes: [{ op: "add", text: "x", why: "y" }] });
  });

  it("lists the rules verb in the contract", () => {
    expect(JUDGE_CONTRACT).toContain("- rules: up to five lines, ADD <a one-line rule");
  });
});

describe("the judge's reply", () => {
  it("reads each verb, and refuses a verb its kind does not allow", () => {
    expect(
      parseJudgeReply(
        "DECISION: route\nROUTE 1 -> M1.L2 — owns it\nROUTE 2 -> dismiss — style\nSTATUS: complete — ok",
        "triage",
      ),
    ).toEqual({
      verb: "route",
      routes: [
        { finding: 1, to: "M1.L2", why: "owns it" },
        { finding: 2, to: "dismiss", why: "style" },
      ],
    });
    expect(parseJudgeReply("DECISION: answer\nANSWER: use the v2 client", "question")).toEqual({
      verb: "answer",
      answer: "use the v2 client",
    });
    expect(
      parseJudgeReply("DECISION: ask_owner\nQUESTION: which database?\nSTATUS: complete — ok", "question"),
    ).toEqual({
      verb: "ask_owner",
      question: "which database?",
    });
    expect(parseJudgeReply("DECISION: route\nROUTE 1 -> M1.L2 — x", "question")).toBeNull();
    expect(parseJudgeReply("**DECISION: retry**\nWHY: flaky host", "unexpected")).toEqual({
      verb: "retry",
      why: "flaky host",
    });
    expect(parseJudgeReply("I think we should retry", "unexpected")).toBeNull();
    expect(parseJudgeReply("DECISION: skip\nWHY: out of scope\nSTATUS: complete — ok", "unexpected")).toEqual(
      {
        verb: "skip",
        why: "out of scope",
      },
    );
  });

  it("refuses a route with no line, an answer with no text and an unknown verb", () => {
    expect(parseJudgeReply("DECISION: route\nSTATUS: complete — ok", "triage")).toBeNull();
    expect(parseJudgeReply("DECISION: answer\nSTATUS: complete — ok", "question")).toBeNull();
    expect(parseJudgeReply("DECISION: shrug", "unexpected")).toBeNull();
    expect(parseJudgeReply("", "triage")).toBeNull();
  });

  it("ends a multi-line answer at the STATUS line", () => {
    expect(
      parseJudgeReply("DECISION: answer\nANSWER: line one\nline two\nSTATUS: complete — done", "question"),
    ).toEqual({ verb: "answer", answer: "line one\nline two" });
  });

  it("names the judge dispatch after its id", () => expect(judgeName("42")).toBe("judge-42"));

  it("keeps every decision the parser makes inside the schema", () => {
    const d = parseJudgeReply("DECISION: park\nQUESTION: ship it?", "unexpected");
    expect(JudgeDecisionSchema.parse(d)).toEqual(d as never);
  });
});

describe("the headless twin of a rung", () => {
  it("maps a native Claude rung to its headless twin and leaves the rest", () => {
    expect(headlessRung("claude:claude-opus-5-5#high")).toBe("claude-code:claude-opus-5-5#high");
    expect(headlessRung("claude-code:claude-opus-5-5#high")).toBe("claude-code:claude-opus-5-5#high");
    expect(headlessRung("codex:gpt-6-sol#low")).toBe("codex:gpt-6-sol#low");
  });
});

describe("the judge role", () => {
  it("ships a read-only judge on headless Opus whose reply contract is the judge contract", () => {
    expect(ROLES).toContain("judge");
    expect(BUILTIN_ROLES.judge).toEqual({
      enabled: true,
      access: "read-only",
      rungs: ["claude-code:claude-opus-5-5#medium"],
    });
    expect(replyContract("judge")).toBe(JUDGE_CONTRACT);
    expect(rolePrompt("judge", "2.0.0")).toEndWith(JUDGE_CONTRACT);
    expect(rolePrompt("judge", "2.0.0")).toContain("You never edit files");
  });
});
