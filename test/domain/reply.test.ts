import { describe, expect, it } from "bun:test";
import { parseReplyStatus } from "../../src/domain/record.ts";
import { composeReply } from "../../src/domain/reply.ts";

const REPORT = [
  "Done: the kit moved to packages/kit.",
  "Deviations: kept the old export for one release (src/index.ts:12).",
  "STATUS: complete — lane finished, fast check green",
].join("\n");
const SHORT = "The notification is just my wait loop finishing; nothing to do.";

describe("a final reply never overwrites the report (plan 22)", () => {
  it("keeps the report when a later turn ends on a short message, with that message under later:", () => {
    const reply = composeReply([REPORT, SHORT], SHORT);
    expect(reply).toBe(
      [
        "Done: the kit moved to packages/kit.",
        "Deviations: kept the old export for one release (src/index.ts:12).",
        "",
        "later:",
        SHORT,
        "",
        "STATUS: complete — lane finished, fast check green",
        "",
      ].join("\n"),
    );
    // the record's STATUS is the report's
    expect(parseReplyStatus(reply)).toEqual({ status: "complete", why: "lane finished, fast check green" });
  });

  it("takes the longest STATUS-bearing message, and keeps a later STATUS line out of the last line", () => {
    const later = "Rechecked.\nSTATUS: partial — one flake";
    const reply = composeReply(["warming up", REPORT, later], later);
    expect(reply.startsWith("Done: the kit moved")).toBe(true);
    expect(reply).toContain("later:\nRechecked.\nSTATUS: partial — one flake\n\nSTATUS: complete");
    expect(parseReplyStatus(reply).status).toBe("complete");
  });

  it("leaves the reply alone with one final message, when the report is last, or with no STATUS at all", () => {
    expect(composeReply([REPORT], REPORT)).toBe(REPORT);
    expect(composeReply([SHORT, REPORT], REPORT)).toBe(REPORT);
    expect(composeReply(["a", "b"], "b")).toBe("b");
    expect(composeReply([], "cli reply")).toBe("cli reply");
  });
});
