import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resetReadiness } from "../../src/services/backends.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, runRole, testView } from "../services/helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

// Spec 1.3 §4.7 and docs/dev/live-verification.md §11: a signed-in cursor-agent on PATH, `auto` (the cheapest
// model Cursor picks). Native: the owner's login and sandbox.json; set CURSOR_API_KEY to also run isolated.
const AUTO = "cursor:auto#default";

function live(access: "read-only" | "workspace-write", isolated = false) {
  const { repo, run } = freshRun("live cursor");
  const view = testView({ isolated: { cursor: isolated } });
  view.roles.worker = { enabled: true, access, rungs: [AUTO] };
  return { repo, run, deps: fakeDeps({ view }) };
}

const STATUS = "The last line of your reply is exactly: STATUS: complete — done";

describe.skipIf(!process.env.CATHERD_LIVE)("live cursor-agent", () => {
  it("writes in the repo on workspace-write, and resumes the chat it started (research §2.5)", async () => {
    const { repo, run, deps } = live("workspace-write");
    const first = await runRole(deps, {
      run: run.id,
      role: "worker",
      name: "worker-1",
      rung: AUTO,
      brief: `Create a file named out.txt containing the word hi. ${STATUS}`,
    });
    expect(first.record).toMatchObject({ status: "ok", replyStatus: "complete", backend: "cursor" });
    expect(first.record.tokens.input).toBeGreaterThan(0);
    expect(existsSync(join(repo, "out.txt"))).toBe(true);
    const again = await runRole(deps, {
      run: run.id,
      role: "worker",
      name: "worker-2",
      rung: AUTO,
      thread: first.record.thread ?? undefined,
      brief: `Which file did you create earlier in this chat? Name it. ${STATUS}`,
    });
    expect(again.record.thread).toBe(first.record.thread);
    // records store replyPath relative to the run dir (finalize); the test process cwd is the suite's
    expect(readFileSync(join(run.dir, again.record.replyPath), "utf8")).toContain("out.txt");
  }, 600_000);

  it("keeps a read-only role from writing: ask mode (advisory)", async () => {
    const { repo, run, deps } = live("read-only");
    const { record } = await runRole(deps, {
      run: run.id,
      role: "worker",
      name: "worker-3",
      rung: AUTO,
      brief:
        "Create a file named out.txt containing hi. If you cannot, say why. The last line of your reply is: STATUS: complete|blocked — <why>",
    });
    expect(record.status).toBe("ok");
    expect(existsSync(join(repo, "out.txt"))).toBe(false);
  }, 300_000);

  it.skipIf(!process.env.CURSOR_API_KEY)(
    "runs isolated under catherd's own HOME with the API key",
    async () => {
      const { run, deps } = live("read-only", true);
      const { record } = await runRole(deps, {
        run: run.id,
        role: "worker",
        name: "worker-4",
        rung: AUTO,
        brief: `Reply with the word hello. ${STATUS}`,
      });
      expect(record).toMatchObject({ status: "ok", isolated: true });
    },
    300_000,
  );
});
