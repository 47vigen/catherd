import { describe, expect, it } from "bun:test";
import { notifyMessage } from "../../src/domain/notify.ts";

const i = { runId: "20261021-101010-w", runTitle: "wallet", unit: "M1.L2" } as const;

describe("notifyMessage", () => {
  it("names the run, the unit and the answer command, and nothing else", () =>
    expect(notifyMessage({ ...i, moment: "blocked" })).toEqual({
      title: "catherd · wallet",
      message: 'M1.L2 needs your answer. Answer: catherd answer 20261021-101010-w M1.L2 "<your answer>"',
      tags: ["question"],
    }));

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
