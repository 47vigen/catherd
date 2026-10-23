import { describe, expect, it } from "bun:test";
import { QUESTION_EXCERPT, notifyMessage } from "../../src/domain/notify.ts";

const i = { runId: "20261021-101010-w", runTitle: "wallet", unit: "M1.L2" } as const;

describe("notifyMessage", () => {
  it("a blocked notice carries the reason, a 120-char excerpt and the answer command", () => {
    expect(QUESTION_EXCERPT).toBe(120);
    expect(
      notifyMessage({
        ...i,
        moment: "blocked",
        reason: "environment",
        question: "x".repeat(300),
        panelUrl: "http://127.0.0.1:4317",
      }),
    ).toEqual({
      title: "catherd · environment · wallet",
      message: `${"x".repeat(120)}… — answer: catherd answer ${i.runId} ${i.unit} "<answer>"`,
      tags: ["question"],
      click: "http://127.0.0.1:4317/questions",
      priority: 4,
    });
  });

  it("collapses whitespace and drops code fences, keeping short questions whole", () => {
    const notice = notifyMessage({
      ...i,
      moment: "blocked",
      reason: "approval",
      question: "Choose  one\n```ts\noption\n```",
    });
    expect(notice.message).toBe(`Choose one option — answer: catherd answer ${i.runId} ${i.unit} "<answer>"`);
    expect(notice.title).toBe("catherd · approval · wallet");
    expect(notice.click).toBeUndefined();
    expect(notice.priority).toBeUndefined();
    for (const reason of ["blocker", "land"] as const)
      expect(notifyMessage({ ...i, moment: "blocked", reason }).priority).toBe(4);
  });

  it("a cancelled run's finish notice says cancelled", () => {
    expect(notifyMessage({ ...i, moment: "finish", outcome: "cancelled" }).message).toBe(
      `The run was cancelled: catherd status ${i.runId}`,
    );
    expect(notifyMessage({ ...i, moment: "finish", outcome: "failed" }).message).toContain("The run failed:");
    expect(notifyMessage({ ...i, moment: "finish", outcome: "done" }).message).toContain("The run finished:");
  });

  it("says a milestone landed, and where to read a finished run", () => {
    expect(notifyMessage({ ...i, unit: "M1", moment: "milestone" })).toEqual({
      title: "catherd · wallet",
      message: "M1 landed.",
      tags: ["white_check_mark"],
    });
    expect(notifyMessage({ ...i, unit: "run", moment: "finish" })).toEqual({
      title: "catherd · wallet",
      message: "The run finished: catherd status 20261021-101010-w",
      tags: ["checkered_flag"],
    });
  });
});
