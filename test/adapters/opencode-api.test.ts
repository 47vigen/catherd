import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDiscovery, writeDiscovery } from "../../src/adapters/discovery.ts";
import { agentsDir, isolatedConfigRoot, userConfigRoot } from "../../src/adapters/opencode/agents.ts";
import { OPENCODE_INSTALL, opencodeAdapter, opencodeShell } from "../../src/adapters/opencode/index.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import { parseRung } from "../../src/domain/ids.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { simPath } from "../sim/scenario.ts";
import { type OpencodeModel, type OpencodeScenario, withOpencodeScenario } from "../sim/sim-scenarios.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "opencode");
const MODELS = JSON.parse(readFileSync(join(FX, "models.json"), "utf8")).data as OpencodeModel[];

afterEach(snapshotEnv());
beforeEach(() => {
  opencodeShell.timeoutMs = 15_000;
  opencodeShell.retryDelayMs = 0;
});

function onSim(s: OpencodeScenario) {
  withHome();
  process.env.PATH = simPath();
  const sim = withOpencodeScenario(s);
  Object.assign(process.env, sim.env);
  return sim;
}

async function code(p: Promise<unknown> | undefined): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isCatherdError(e) ? e.code : String(e);
  }
  return "ok";
}

const prepare = (rung: string, isolated = false) =>
  opencodeAdapter.prepare?.({ rung: parseRung(rung), access: "workspace-write", isolated });

describe("opencode probe", () => {
  it("accepts v2 and reports a Zen or Go login", async () => {
    onSim({ auth: [{ id: "opencode-go", connections: [{ type: "api" }] }] });
    expect(await opencodeAdapter.probe()).toMatchObject({
      installed: true,
      version: "2.0.16",
      versionOk: true,
      loggedIn: true,
      problems: [],
    });
  });

  it("is ready without a login, since the free Zen models need none", async () => {
    onSim({ auth: [{ id: "github-copilot", connections: [{ type: "env" }] }] });
    expect(await opencodeAdapter.probe()).toMatchObject({ loggedIn: false, problems: [] });
  });

  it("refuses v1 as too old, with the v2 install command", async () => {
    onSim({ version: "1.18.32" });
    const p = await opencodeAdapter.probe();
    expect(p.versionOk).toBe(false);
    expect(p.problems).toEqual([
      {
        code: "E_BACKEND_TOO_OLD",
        message: "opencode 1.18.32 is v1; catherd needs opencode v2 (2.0.16 or newer)",
        fix: "curl -fsSL https://opencode.ai/v2/install | bash",
      },
    ]);
    expect(OPENCODE_INSTALL).toBe("curl -fsSL https://opencode.ai/v2/install | bash");
  });

  it("reports a missing CLI with the install command", async () => {
    withHome();
    process.env.PATH = "/nonexistent";
    expect((await opencodeAdapter.probe()).problems[0]).toMatchObject({ code: "E_BACKEND_MISSING" });
  });
});

describe("opencode discovery", () => {
  it("keeps only Zen and Go models, with their variants as efforts, retrying once on an empty first list", async () => {
    onSim({ models: MODELS, warmup: true });
    const ms = await opencodeAdapter.listModels();
    expect(ms.map((m) => m.id)).toEqual([
      "opencode/space-bunny-free",
      "opencode/big-pickle",
      "opencode/kimi-k3",
      "opencode-go/kimi-k3",
      "opencode-go/qwen3.8-max",
      "opencode/qwen3.8-max",
      "opencode-go/glm-5.3",
    ]);
    expect(ms.find((m) => m.id === "opencode-go/qwen3.8-max")?.efforts).toEqual(["low", "medium", "xhigh"]);
    expect(ms.find((m) => m.id === "opencode/space-bunny-free")).toMatchObject({
      imageIn: true,
      context: 1048576,
    });
  });

  it("gives up after one retry, and on a failing service", async () => {
    onSim({ models: [], warmup: true });
    expect(await opencodeAdapter.listModels()).toEqual([]);
    onSim({ apiFails: true });
    expect(await opencodeAdapter.listModels()).toEqual([]);
  });
});

describe("opencode prepare", () => {
  it("installs the agents where the service reads them, reloads it once, and caches the listing", async () => {
    const reloads = join(mkdtempSync(join(tmpdir(), "catherd-reload-")), "log");
    onSim({ models: MODELS, reloadsTo: reloads });
    expect(await code(prepare("opencode:opencode-go/glm-5.3#high"))).toBe("ok");
    expect(await code(prepare("opencode:opencode-go/glm-5.3#low"))).toBe("ok");
    expect(existsSync(join(agentsDir(userConfigRoot()), "catherd-worker.md"))).toBe(true);
    expect(readFileSync(reloads, "utf8")).toBe("reload\n");
    expect(readDiscovery("opencode")?.models).toHaveLength(7);
  });

  it("installs into catherd's own config root for an isolated run", async () => {
    onSim({ models: MODELS });
    await prepare("opencode:opencode/big-pickle#default", true);
    expect(existsSync(join(agentsDir(isolatedConfigRoot()), "catherd-ro.md"))).toBe(true);
  });

  it("refuses a variant the model lacks, naming the valid ones, and a model opencode does not list", async () => {
    onSim({ models: MODELS });
    const e = await prepare("opencode:opencode/big-pickle#ultra")?.catch((x: unknown) => x);
    expect(isCatherdError(e) && [e.code, e.fix]).toEqual(["E_BACKEND_MODEL_UNKNOWN", "use one of: default"]);
    expect(await code(prepare("opencode:opencode-go/qwen3.8-max#xhigh"))).toBe("ok");
    expect(await code(prepare("opencode:opencode-go/qwen3.8-max#high"))).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(await code(prepare("opencode:opencode-go/nope#default"))).toBe("E_BACKEND_MODEL_UNKNOWN");
  });

  it("does not validate a provider outside Zen and Go, nor block when opencode lists nothing", async () => {
    onSim({ models: [] });
    expect(await code(prepare("opencode:openrouter/some-model#high"))).toBe("ok");
    expect(await code(prepare("opencode:opencode/anything#high"))).toBe("ok");
  });
});

describe("opencode default failover", () => {
  it("stands Go X in with Zen X when Zen lists X with that variant", () => {
    withHome();
    writeDiscovery("opencode", [
      { id: "opencode/kimi-k3", efforts: ["max"], context: null, imageIn: false },
      { id: "opencode/qwen3.8-max", efforts: [], context: null, imageIn: false },
    ]);
    const f = opencodeAdapter.failoverFor;
    expect(f?.(parseRung("opencode:opencode-go/kimi-k3#max"))).toEqual(
      parseRung("opencode:opencode/kimi-k3#max"),
    );
    expect(f?.(parseRung("opencode:opencode-go/qwen3.8-max#xhigh"))).toBeNull();
    expect(f?.(parseRung("opencode:opencode-go/qwen3.8-max#default"))).toEqual(
      parseRung("opencode:opencode/qwen3.8-max#default"),
    );
    expect(f?.(parseRung("opencode:opencode-go/glm-5.3#high"))).toBeNull();
    expect(f?.(parseRung("opencode:opencode/kimi-k3#max"))).toBeNull();
  });
});
