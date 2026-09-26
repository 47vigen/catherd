import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch } from "../../src/services/dispatch-service.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, testView } from "../services/helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

// Spec §11.7: the cheapest Codex rung, on the owner's ChatGPT login.
const LUNA_LOW = "codex:gpt-6-luna#low";
// Spec §5.2: Codex's image tool needs the ChatGPT login; the artist runs it (the 0.x spike S3).
const SOL = "codex:gpt-6-sol#medium";

function live() {
  const { repo, run } = freshRun("live codex");
  const view = testView();
  view.roles.researcher = { enabled: true, access: "read-only", rungs: [LUNA_LOW] };
  view.roles.artist = { enabled: true, access: "workspace-write", rungs: [SOL] };
  return { repo, run, deps: fakeDeps({ view }) };
}

describe.skipIf(!process.env.CATHERD_LIVE)("live codex", () => {
  it("answers a tiny brief, then resumes the same thread", async () => {
    const { run, deps } = live();
    const first = await dispatch(deps, {
      run: run.id,
      role: "researcher",
      name: "researcher-1",
      rung: LUNA_LOW,
      brief:
        "Reply with the word hello. The last line of your reply is exactly: STATUS: complete — said hello",
    });
    expect(first.record).toMatchObject({ status: "ok", replyStatus: "complete", backend: "codex" });
    expect(first.record.thread).not.toBeNull();
    const again = await dispatch(deps, {
      run: run.id,
      role: "researcher",
      name: "researcher-1",
      rung: LUNA_LOW,
      thread: first.record.thread ?? undefined,
      brief: "Say hello again. The last line of your reply is exactly: STATUS: complete — again",
    });
    expect(again.record).toMatchObject({ status: "ok", thread: first.record.thread });
  }, 300_000);

  it("returns the images its image tool made (the 0.x spike S3, now through the adapter)", async () => {
    const { run, deps } = live();
    const { record } = await dispatch(deps, {
      run: run.id,
      role: "artist",
      name: "artist-1",
      rung: SOL,
      brief:
        "Generate one 256x256 image of a ginger cat holding a conductor baton with your image tool. Do not write any file yourself. The last line of your reply is exactly: STATUS: complete — made one image",
    });
    expect(record.status).toBe("ok");
    expect(record.images.length).toBeGreaterThan(0);
  }, 600_000);
});
