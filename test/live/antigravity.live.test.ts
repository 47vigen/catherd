import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resetReadiness } from "../../src/services/backends.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, runRole, testView } from "../services/helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

// Spec 1.3 §6.6 and docs/dev/live-verification.md §13: agy on PATH, signed in with Google for the native tests
// (catherd refuses a logged-out agy before it can open a browser), GEMINI_API_KEY for the isolated one.
const FLASH = "antigravity:gemini-3.8-flash#low";

function live(access: "read-only" | "workspace-write", isolated = false) {
  const { repo, run } = freshRun("live antigravity");
  const view = testView({ isolated: { antigravity: isolated } });
  view.roles.worker = { enabled: true, access, rungs: [FLASH] };
  return { repo, run, deps: fakeDeps({ view }) };
}

const STATUS = "The last line of your reply is exactly: STATUS: complete — done";

describe.skipIf(!process.env.CATHERD_LIVE)("live agy", () => {
  it("writes in the repo on workspace-write, and resumes the conversation it started (research §4.6)", async () => {
    const { repo, run, deps } = live("workspace-write");
    const first = await runRole(deps, {
      run: run.id,
      role: "worker",
      name: "worker-1",
      rung: FLASH,
      brief: `Create a file named out.txt containing the word hi. ${STATUS}`,
    });
    expect(first.record).toMatchObject({ status: "ok", replyStatus: "complete", backend: "antigravity" });
    expect(first.record.tokens.input).toBeGreaterThan(0);
    expect(existsSync(join(repo, "out.txt"))).toBe(true);
    const again = await runRole(deps, {
      run: run.id,
      role: "worker",
      name: "worker-2",
      rung: FLASH,
      thread: first.record.thread ?? undefined,
      brief: `Which file did you create earlier in this conversation? Name it. ${STATUS}`,
    });
    expect(again.record.thread).toBe(first.record.thread);
    expect(readFileSync(again.record.replyPath, "utf8")).toContain("out.txt");
  }, 600_000);

  it.skipIf(!process.env.GEMINI_API_KEY)(
    "keeps an isolated read-only role from writing: catherd's deny rules (advisory)",
    async () => {
      const { repo, run, deps } = live("read-only", true);
      const { record } = await runRole(deps, {
        run: run.id,
        role: "worker",
        name: "worker-3",
        rung: FLASH,
        brief:
          "Create a file named out.txt containing hi. If you cannot, say why. The last line of your reply is: STATUS: complete|blocked — <why>",
      });
      expect(record).toMatchObject({ status: "ok", isolated: true });
      expect(existsSync(join(repo, "out.txt"))).toBe(false);
    },
    300_000,
  );
});
