import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch } from "../../src/services/dispatch-service.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, testView } from "../services/helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

// Spec §11.7: the cheapest claude-code rung, on the owner's Claude login.
const HAIKU = "claude-code:claude-haiku-4-5-20251001#default";

function live() {
  const { repo, run } = freshRun("live claude-code");
  const view = testView();
  view.roles.researcher = { enabled: true, access: "read-only", rungs: [HAIKU] };
  return { repo, run, deps: fakeDeps({ view }) };
}

describe.skipIf(!process.env.CATHERD_LIVE)("live claude-code", () => {
  it("answers a tiny brief headless, then resumes the same session", async () => {
    const { run, deps } = live();
    const first = await dispatch(deps, {
      run: run.id,
      role: "researcher",
      name: "researcher-1",
      rung: HAIKU,
      brief:
        "---\nReply with the word hello. The last line of your reply is exactly: STATUS: complete — said hello",
    });
    expect(first.record).toMatchObject({ status: "ok", replyStatus: "complete", backend: "claude-code" });
    expect(first.record.tokens.input).toBeGreaterThan(0);
    expect(first.record.costUsd).toBeGreaterThan(0);
    const again = await dispatch(deps, {
      run: run.id,
      role: "researcher",
      name: "researcher-1",
      rung: HAIKU,
      thread: first.record.thread ?? undefined,
      brief: "Say hello again. The last line of your reply is exactly: STATUS: complete — again",
    });
    expect(again.record).toMatchObject({ status: "ok", thread: first.record.thread });
  }, 300_000);

  it("keeps a read-only role from writing", async () => {
    const { repo, run, deps } = live();
    const { record } = await dispatch(deps, {
      run: run.id,
      role: "researcher",
      name: "researcher-2",
      rung: HAIKU,
      brief:
        "Create a file named out.txt containing hi. If you cannot, say why. The last line of your reply is: STATUS: complete|blocked — <why>",
    });
    expect(record.status).toBe("ok");
    expect(existsSync(join(repo, "out.txt"))).toBe(false);
  }, 300_000);
});
