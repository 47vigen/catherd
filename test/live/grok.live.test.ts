import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../../src/adapters/cli.ts";
import { parseGrokModels } from "../../src/adapters/grok/models.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, runRole, testView } from "../services/helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

// Spec 1.3 §5.6 and docs/dev/live-verification.md §12: a signed-in grok (a Grok login, or XAI_API_KEY) on PATH,
// on the default model its listing names, at #low. Native: the owner's login, with catherd's catherd-* tables in
// ~/.grok/sandbox.toml; set XAI_API_KEY to also run isolated.
async function defaultRung(): Promise<string> {
  const r = await runCli("grok", ["models"], { timeoutMs: 30_000, env: { GROK_DISABLE_AUTOUPDATER: "1" } });
  const model = parseGrokModels(r?.out ?? "").defaultModel;
  if (!model) throw new Error(`grok models named no default model: ${r?.out ?? "grok is not on PATH"}`);
  return `grok:${model}#low`;
}

function live(rung: string, access: "read-only" | "workspace-write", isolated = false) {
  const { repo, run } = freshRun("live grok");
  const view = testView({ isolated: { grok: isolated } });
  view.roles.worker = { enabled: true, access, rungs: [rung] };
  return { repo, run, deps: fakeDeps({ view }) };
}

const STATUS = "The last line of your reply is exactly: STATUS: complete — done";

describe.skipIf(!process.env.CATHERD_LIVE)("live grok", () => {
  it("writes in the repo under catherd-ws, and resumes the session it started (research §3.5)", async () => {
    const rung = await defaultRung();
    const { repo, run, deps } = live(rung, "workspace-write");
    const first = await runRole(deps, {
      run: run.id,
      role: "worker",
      name: "worker-1",
      rung,
      brief: `Create a file named out.txt containing the word hi. ${STATUS}`,
    });
    expect(first.record).toMatchObject({ status: "ok", replyStatus: "complete", backend: "grok" });
    expect(first.record.tokens.input).toBeGreaterThan(0);
    expect(existsSync(join(repo, "out.txt"))).toBe(true);
    const again = await runRole(deps, {
      run: run.id,
      role: "worker",
      name: "worker-2",
      rung,
      thread: first.record.thread ?? undefined,
      brief: `Which file did you create earlier in this session? Name it. ${STATUS}`,
    });
    expect(again.record.thread).toBe(first.record.thread);
    expect(readFileSync(again.record.replyPath, "utf8")).toContain("out.txt");
  }, 600_000);

  it("keeps a read-only role from writing: the kernel profile, or the read tools on a symlinked-socket Mac", async () => {
    const rung = await defaultRung();
    const { repo, run, deps } = live(rung, "read-only");
    const { record } = await runRole(deps, {
      run: run.id,
      role: "worker",
      name: "worker-3",
      rung,
      brief:
        "Create a file named out.txt containing hi. If you cannot, say why. The last line of your reply is: STATUS: complete|blocked — <why>",
    });
    expect(record.status).toBe("ok");
    expect(existsSync(join(repo, "out.txt"))).toBe(false);
  }, 300_000);

  it.skipIf(!process.env.XAI_API_KEY)(
    "runs isolated under catherd's own HOME with the API key",
    async () => {
      const rung = await defaultRung();
      const { run, deps } = live(rung, "read-only", true);
      const { record } = await runRole(deps, {
        run: run.id,
        role: "worker",
        name: "worker-4",
        rung,
        brief: `Reply with the word hello. ${STATUS}`,
      });
      expect(record).toMatchObject({ status: "ok", isolated: true });
    },
    300_000,
  );
});
