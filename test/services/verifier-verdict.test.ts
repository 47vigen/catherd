import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { endedEvent, NO_COMMAND_RUN } from "../../src/services/run-effects.ts";
import { snapshotEnv, tempDir } from "../helpers.ts";
import { freshRun, makeRecord } from "./helpers.ts";

afterEach(snapshotEnv());

describe("the one verifier's verdict (plan 50, spec D8)", () => {
  const verdict = (reply: string) => {
    const { run } = freshRun();
    const replyPath = "roles/T5/V1/reply.md";
    mkdirSync(dirname(join(run.dir, replyPath)), { recursive: true });
    writeFileSync(join(run.dir, replyPath), reply);
    const record = makeRecord({
      runId: run.id,
      dispatchId: "V1",
      name: "T5",
      role: "verifier",
      lane: null,
      replyPath,
    });
    return endedEvent(run, record, "T5") as { verdict: string | null; findings: { text: string }[] };
  };

  it("reads a PASS that ran no command as a FAIL", () => {
    const e = verdict("VERDICT: PASS\nHEAD: abc1234\nA1 PASS — looked at the tree\nSTATUS: complete — ok\n");
    expect(e.verdict).toBe("fail");
    expect(e.findings.map((f) => f.text)).toEqual([NO_COMMAND_RUN]);
  });

  it("keeps a PASS whose RAN line shows a command run", () => {
    const log = join(tempDir("catherd-log-"), "a1.log");
    writeFileSync(log, "ok\n");
    const e = verdict(
      `VERDICT: PASS\nHEAD: abc1234\nRAN: bun test — exit 0 — ${log}\nSTATUS: complete — ok\n`,
    );
    expect(e.verdict).toBe("pass");
  });
});
