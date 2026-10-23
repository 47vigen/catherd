import { describe, expect, it } from "bun:test";
import { replyContract } from "../../src/domain/role-prompts.ts";
import {
  parseReplyDesign,
  parseReplyEnvironment,
  parseReplyExtras,
  parseReplyHead,
  parseReplyRejections,
  parseReplyStatus,
  type RunRecord,
  RunRecordSchema,
  ZERO_TOKENS,
} from "../../src/domain/record.ts";

export const sampleRecord = (over: Partial<RunRecord> = {}): RunRecord => ({
  schema: 1,
  runId: "20260925-120000-demo",
  dispatchId: "01K0000000ABCDEFGHJKMNPQRS",
  name: "worker-M1.L1",
  role: "worker",
  lane: "M1.L1",
  backend: "codex",
  rung: "codex:gpt-6-sol#medium",
  attempt: 1,
  failoverFrom: null,
  thread: "t-1",
  status: "ok",
  startedAt: "2026-09-25T12:00:00.000Z",
  endedAt: "2026-09-25T12:05:00.000Z",
  secs: 300,
  exitCode: 0,
  signal: null,
  cliVersion: "0.157.0",
  tokens: { ...ZERO_TOKENS },
  costUsd: null,
  changedOwned: [],
  violations: [],
  replyStatus: "complete",
  replyWhy: "done",
  threadHeavy: false,
  access: "workspace-write",
  isolated: false,
  images: [],
  error: null,
  replyPath: "/r/roles/worker-M1.L1/x/reply.md",
  ...over,
});

describe("RunRecordSchema", () => {
  it("accepts a full record and keeps unknown fields", () => {
    const r = RunRecordSchema.parse({ ...sampleRecord(), futureField: 7 });
    expect((r as Record<string, unknown>).futureField).toBe(7);
  });

  it("rejects an unknown status", () => {
    expect(RunRecordSchema.safeParse({ ...sampleRecord(), status: "weird" }).success).toBe(false);
  });
});

describe("parseReplyStatus", () => {
  it("reads the last line's STATUS with any dash", () => {
    expect(parseReplyStatus("work\nSTATUS: complete — all green\n")).toEqual({
      status: "complete",
      why: "all green",
    });
    expect(parseReplyStatus("STATUS: refused - no")).toEqual({ status: "refused", why: "no" });
    expect(parseReplyStatus("STATUS: complete — x\nmore text")).toEqual({ status: null, why: null });
    expect(parseReplyStatus("")).toEqual({ status: null, why: null });
    expect(parseReplyStatus("STATUS: flaky — x failed once, passed 3/3 alone")).toEqual({
      status: "flaky",
      why: "x failed once, passed 3/3 alone",
    });
  });

  it("reads an ENV: line outside code fences (plan 23)", () => {
    expect(parseReplyEnvironment("could not run the suite\nENV: vpn  \nSTATUS: blocked — vpn")).toBe("vpn");
    expect(parseReplyEnvironment("no env here\nSTATUS: complete — ok")).toBeNull();
    expect(parseReplyEnvironment("ENV:   \nSTATUS: blocked — x")).toBeNull();
    expect(parseReplyEnvironment("Added:\n```yaml\nENV: production\n```\nSTATUS: complete — ok")).toBeNull();
    expect(parseReplyEnvironment("```\nENV: x\n```\nENV: vpn\nSTATUS: blocked — vpn")).toBe("vpn");
  });
});

describe("ZERO_TOKENS", () => {
  it("is frozen and typed read-only, so a mutation fails to type-check instead of throwing", () => {
    expect(Object.isFrozen(ZERO_TOKENS)).toBe(true);
    const mutate = () => {
      // @ts-expect-error ZERO_TOKENS is Readonly<Tokens>
      ZERO_TOKENS.input += 1;
    };
    expect(mutate).toThrow();
  });
});

describe("parseReplyHead", () => {
  it("reads the last HEAD: line outside code fences, lower-cased", () => {
    expect(
      parseReplyHead("VERDICT: PASS\nHEAD: 0123456789ABCDEF0123456789abcdef01234567\nSTATUS: complete — ok"),
    ).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(parseReplyHead("```\nHEAD: deadbeef\n```\nSTATUS: complete — ok")).toBeNull();
    expect(parseReplyHead("HEAD: main")).toBeNull();
  });
  it("asks every verifier for the HEAD it checked", () =>
    expect(replyContract("verifier")).toContain("HEAD: <the full sha"));
});

describe("parseReplyExtras, parseReplyRejections and parseReplyDesign", () => {
  it("keeps a spaced hyphen in the first field when the line has an em dash", () => {
    expect(parseReplyRejections("REJECTED: BUG src/a.ts:3 - off by one — the loop is guarded\n")).toEqual([
      { finding: "BUG src/a.ts:3 - off by one", why: "the loop is guarded" },
    ]);
    expect(parseReplyExtras("EXTRA: go.sum - a new module")).toEqual([
      { path: "go.sum", why: "a new module" },
    ]);
  });

  it("reads EXTRA:, REJECTED: and DESIGN: lines as loosely as STATUS", () => {
    const reply = [
      "did it",
      "EXTRA: src/a-b.ts — the type moved there",
      "- EXTRA: `go.sum` - a new module",
      "EXTRA: lone.ts",
      "EXTRA:   ",
      "REJECTED: BUG src/a.ts:3 — the caller never passes an empty list – see src/b.ts:9",
      "DESIGN: Task 3 — Post(ctx, s, e) clashes with ledger.Post(ctx, e) — take the store first",
      "STATUS: blocked — needs_user: Task 3's signature clashes",
    ].join("\n");
    expect(parseReplyExtras(reply)).toEqual([
      { path: "src/a-b.ts", why: "the type moved there" },
      { path: "go.sum", why: "a new module" },
      { path: "lone.ts", why: "" },
    ]);
    expect(parseReplyRejections(reply)).toEqual([
      { finding: "BUG src/a.ts:3", why: "the caller never passes an empty list – see src/b.ts:9" },
    ]);
    expect(parseReplyDesign(reply)).toEqual([
      "Task 3 — Post(ctx, s, e) clashes with ledger.Post(ctx, e) — take the store first",
    ]);
    expect(parseReplyExtras("none\nSTATUS: complete — x")).toEqual([]);
  });
});
