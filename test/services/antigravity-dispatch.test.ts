import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedAgyHome } from "../../src/adapters/antigravity/index.ts";
import { replyContract } from "../../src/domain/role-prompts.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, type DispatchInput } from "../../src/services/dispatch-service.ts";
import { snapshotEnv, tempDir } from "../helpers.ts";
import { simPath } from "../sim/scenario.ts";
import { type AgyScenario, withAgyScenario } from "../sim/sim-scenarios.ts";
import { fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "antigravity");
const FLASH = "antigravity:gemini-3.8-flash#high";

function setup(s: AgyScenario, access: "read-only" | "workspace-write" = "workspace-write") {
  const { repo, run } = freshRun();
  process.env.PATH = simPath();
  // the simulator reads HOME's agy settings: never the user's own
  process.env.HOME = tempDir("catherd-agyhome-");
  delete process.env.GEMINI_API_KEY;
  const sim = withAgyScenario({ modelsFile: join(FX, "models.txt"), ...s });
  Object.assign(process.env, sim.env);
  writeLane(run, "M1.L1", ["src/a.ts"]);
  const view = testView();
  view.roles.worker = { enabled: true, access, rungs: [FLASH] };
  return { repo, run, sim, deps: fakeDeps({ view }) };
}

const input = (run: string, over: Partial<DispatchInput> = {}): DispatchInput => ({
  run,
  role: "worker",
  name: "worker-M1.L1",
  brief: "---\nRead lanes/M1.L1.md",
  rung: FLASH,
  lane: "M1.L1",
  ...over,
});

const code = async (p: Promise<unknown>) => ((await p.catch((x: unknown) => x)) as { code?: string }).code;

describe("dispatch on agy (simulator)", () => {
  it("runs in the repo with -p naming the brief file, the effort flag, and the result's reply and tokens", async () => {
    const { repo, run, sim, deps } = setup({
      eventsFile: join(FX, "ok.jsonl"),
      touch: [{ path: "src/a.ts", content: "new" }],
    });
    const { record } = await runRole(deps, input(run.id));
    expect(record).toMatchObject({
      status: "ok",
      backend: "antigravity",
      replyStatus: "complete",
      tokens: { input: 25717, cached: 9728, output: 335 },
      changedOwned: ["src/a.ts"],
      cliVersion: "1.2.13",
      thread: "00000000-0000-4000-8000-0000000a9e1d",
    });
    const seen = sim.recorded();
    const brief = /^Read the brief in (\S+) and follow it\. Your final message is your reply\.$/.exec(
      seen.stdin,
    )?.[1];
    expect(readFileSync(brief as string, "utf8")).toBe(
      `---\nRead lanes/M1.L1.md\n\n${replyContract("worker")}\n`,
    );
    expect(seen.args.slice(2)).toEqual([
      "--output-format",
      "stream-json",
      "--model",
      "gemini-3.8-flash",
      "--effort",
      "high",
      "--disable-slash-commands",
      "--sandbox",
      "--dangerously-skip-permissions",
    ]);
    expect([seen.cwd, seen.vars?.AGY_CLI_DISABLE_AUTO_UPDATE]).toEqual([repo, "true"]);
  });

  it("refuses a logged-out agy before anything runs, and never opens the browser", async () => {
    const browserTo = join(tempDir("catherd-browser-"), "opened");
    const { run, sim, deps } = setup({ loggedIn: false, browserTo, eventsFile: join(FX, "ok.jsonl") });
    expect(await code(dispatch(deps, input(run.id)))).toBe("E_BACKEND_NOT_LOGGED_IN");
    expect([sim.ran(), existsSync(browserTo)]).toEqual([false, false]);
  });

  it("runs isolated on GEMINI_API_KEY alone under catherd's HOME and settings, and refuses a native run then", async () => {
    const browserTo = join(tempDir("catherd-browser-"), "opened");
    const { run, sim, deps } = setup({ loggedIn: false, browserTo, eventsFile: join(FX, "ok.jsonl") });
    process.env.GEMINI_API_KEY = "key-for-test";
    expect(await code(dispatch(deps, input(run.id)))).toBe("E_BACKEND_NOT_LOGGED_IN");
    deps.view.isolated = { antigravity: true };
    const { record } = await runRole(deps, input(run.id, { name: "worker-M1.L1b" }));
    expect(record).toMatchObject({ status: "ok", isolated: true });
    expect(sim.recorded()).toMatchObject({
      home: isolatedAgyHome("workspace-write"),
      settings: { modelProvider: "gemini", permissions: { allow: expect.arrayContaining(["read_url(*)"]) } },
    });
    expect(existsSync(browserTo)).toBe(false);
  });

  it("refuses a read-only role on native agy before anything runs (spec 1.3 §9 Q2)", async () => {
    const { run, sim, deps } = setup({ eventsFile: join(FX, "ok.jsonl") }, "read-only");
    expect(await code(dispatch(deps, input(run.id)))).toBe("E_ADMIT_RUNG");
    expect(sim.ran()).toBe(false);
  });

  it("records a quota stop as a limit, so failover can move the role", async () => {
    const { run, deps } = setup({
      eventsFile: join(FX, "error.jsonl"),
      exitCode: 3,
      stderr: 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"message":"Weekly quota exhausted."}\n',
    });
    const { record } = await runRole(deps, input(run.id));
    expect(record.status).toBe("limit");
  });
});
