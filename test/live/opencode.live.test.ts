import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { cancel, dispatch } from "../../src/services/dispatch-service.ts";
import { liveDispatches } from "../../src/services/dispatches.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, testView, waitFor } from "../services/helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

// Spec §6.3: free on Zen, no key needed. Isolated, so the test's own agents reach a standalone server
// and the user's opencode config is never touched.
const BUNNY = "opencode:opencode/space-bunny-free#default";

function live(access: "read-only" | "workspace-write" = "read-only") {
  const { repo, run } = freshRun("live opencode");
  const view = testView({ isolated: { opencode: true } });
  view.roles.researcher = {
    enabled: true,
    access: "read-only",
    rungs: [BUNNY, "opencode:opencode/space-bunny-free#low", "opencode:opencode/space-bunny-free#bogus"],
  };
  view.roles.worker = { enabled: true, access, rungs: [BUNNY] };
  return { repo, run, deps: fakeDeps({ view }) };
}

describe.skipIf(!process.env.CATHERD_LIVE)("live opencode v2", () => {
  it("runs a brief that starts with --- from stdin in the repo, with totals from the API", async () => {
    const { run, deps } = live();
    const { record } = await dispatch(deps, {
      run: run.id,
      role: "researcher",
      name: "researcher-1",
      rung: "opencode:opencode/space-bunny-free#low",
      brief:
        "---\nReply with the word hello. The last line of your reply is exactly: STATUS: complete — said hello",
    });
    expect(record).toMatchObject({ status: "ok", replyStatus: "complete", backend: "opencode" });
    expect(record.thread).toMatch(/^ses_/);
    expect(record.tokens.input).toBeGreaterThan(0);
  }, 300_000);

  it("refuses a variant the model does not list, before running", async () => {
    const { run, deps } = live();
    const e = await dispatch(deps, {
      run: run.id,
      role: "researcher",
      name: "researcher-2",
      rung: "opencode:opencode/space-bunny-free#bogus",
      brief: "hello",
    }).catch((x: unknown) => x);
    expect(isCatherdError(e) && e.code).toBe("E_BACKEND_MODEL_UNKNOWN");
  }, 120_000);

  it("keeps the catherd-ro agent from writing (spec §14)", async () => {
    const { repo, run, deps } = live();
    const { record } = await dispatch(deps, {
      run: run.id,
      role: "researcher",
      name: "researcher-3",
      rung: BUNNY,
      brief:
        "Create a file named out.txt containing hi. If you cannot, say why. The last line of your reply is: STATUS: complete|blocked — <why>",
    });
    expect(record.status).toBe("ok");
    expect(existsSync(join(repo, "out.txt"))).toBe(false);
  }, 300_000);

  it("stops a running shell on cancel: the session is interrupted server-side", async () => {
    const { repo, run, deps } = live("workspace-write");
    const pending = dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-1",
      rung: BUNNY,
      brief: "Run exactly this shell command and nothing else: sleep 40 && echo finished > done.txt",
    });
    await waitFor(() => liveDispatches(run).find((d) => d.state === "running"), 60_000);
    await Bun.sleep(15_000);
    const { record } = await cancel(deps, run.id, "worker-1");
    expect(record.status).toBe("cancelled");
    await pending;
    await Bun.sleep(40_000);
    expect(existsSync(join(repo, "done.txt"))).toBe(false);
  }, 300_000);
});
