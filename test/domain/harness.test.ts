import { describe, expect, it } from "bun:test";
import { FAILURE_CLASSES, failureSignature, HARNESS_NOTE } from "../../src/domain/harness.ts";

describe("failure signatures", () => {
  it("a failure's signature ignores line numbers and paths", () => {
    const a = failureSignature("(fail) db > connects [3.1ms]");
    expect(a).toBe(failureSignature("(fail) db > connects [9.0ms]"));
    expect(a).not.toBe(failureSignature("(fail) db > closes [3.1ms]"));
    expect(failureSignature("ok 1\nerror: boom at /tmp/a/b.ts:12")).toBe(
      failureSignature("error: boom at /tmp/x/c.ts:99"),
    );
  });

  it("falls back to the first line when no line names a failure", () => {
    expect(failureSignature("connection refused 127.0.0.1\nmore")).toBe(
      failureSignature("connection refused 127.0.0.1"),
    );
  });

  it("names the classes and the repair note", () => {
    expect(FAILURE_CLASSES).toEqual(["product", "harness"]);
    expect(HARNESS_NOTE).toStartWith("This failure is the environment's");
  });
});
