import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simPath } from "./scenario.ts";
import { type OpencodeModel, withOpencodeScenario } from "./sim-scenarios.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "opencode");
const MODELS = JSON.parse(readFileSync(join(FX, "models.json"), "utf8")).data as OpencodeModel[];

function opencode(
  args: string[],
  env: Record<string, string>,
  o: { stdin?: string; cwd?: string; pwd?: string } = {},
) {
  let input: "ignore" | ReturnType<typeof Bun.file> = "ignore";
  if (o.stdin !== undefined) {
    const f = join(mkdtempSync(join(tmpdir(), "catherd-stdin-")), "in");
    writeFileSync(f, o.stdin);
    input = Bun.file(f);
  }
  const p = Bun.spawnSync(["opencode", ...args], {
    env: { ...process.env, ...env, PATH: simPath(), ...(o.pwd ? { PWD: o.pwd } : {}) },
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
    cwd: o.cwd,
  });
  return { code: p.exitCode, out: p.stdout.toString("utf8"), err: p.stderr.toString("utf8") };
}

/** An XDG config root holding one catherd agent file, as prepare() leaves it. */
function configWithAgent(name = "catherd-worker"): string {
  const root = mkdtempSync(join(tmpdir(), "catherd-xdg-"));
  mkdirSync(join(root, "opencode", "agents"), { recursive: true });
  writeFileSync(join(root, "opencode", "agents", `${name}.md`), "---\nmode: primary\n---\n");
  return root;
}

describe("opencode simulator", () => {
  it("prints v2 and v1 versions the way each CLI does", () => {
    expect(opencode(["--version"], withOpencodeScenario({}).env).out.trim()).toBe("opencode v2.0.16");
    expect(opencode(["--version"], withOpencodeScenario({ version: "1.18.32" }).env).out.trim()).toBe(
      "1.18.32",
    );
  });

  it("serves auth list, the model list (empty once on warm-up) and the session API", () => {
    const s = withOpencodeScenario({
      auth: [{ id: "opencode-go", connections: [{ type: "api" }] }],
      models: MODELS,
      warmup: true,
      active: { ses_a: { type: "running" } },
      session: { cost: 0.5, tokens: { input: 10, output: 2 }, outcome: "succeeded" },
      interruptsTo: join(mkdtempSync(join(tmpdir(), "catherd-int-")), "ids"),
    });
    expect(JSON.parse(opencode(["auth", "list", "--format", "json"], s.env).out)[0].id).toBe("opencode-go");
    expect(JSON.parse(opencode(["api", "GET", "/api/model"], s.env).out).data).toEqual([]);
    expect(JSON.parse(opencode(["api", "GET", "/api/model"], s.env).out).data).toHaveLength(MODELS.length);
    expect(JSON.parse(opencode(["api", "GET", "/api/session/active"], s.env).out).data).toEqual({
      ses_a: { type: "running" },
    });
    expect(JSON.parse(opencode(["api", "GET", "/api/session/ses_a"], s.env).out).data.cost).toBe(0.5);
    expect(JSON.parse(opencode(["api", "POST", "/api/session/ses_a/interrupt"], s.env).out)).toEqual({
      interrupted: true,
    });
  });

  it("fails every api call when told to, with no output", () => {
    const r = opencode(["api", "GET", "/api/session/active"], withOpencodeScenario({ apiFails: true }).env);
    expect(r).toMatchObject({ code: 1, out: "" });
  });

  it("works in $PWD, not the spawn cwd, reads the brief on stdin and replays the events", () => {
    const repo = mkdtempSync(join(tmpdir(), "catherd-simrepo-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "catherd-elsewhere-"));
    const xdg = configWithAgent();
    const s = withOpencodeScenario({
      models: MODELS,
      eventsFile: join(FX, "shell-ok.jsonl"),
      touch: [{ path: "a.txt", content: "x" }],
    });
    const r = opencode(
      ["run", "--format", "json", "--auto", "--agent", "catherd-worker", "-m", "opencode-go/glm-5.3#high"],
      { ...s.env, XDG_CONFIG_HOME: xdg },
      { stdin: "---\nbrief", cwd: elsewhere, pwd: repo },
    );
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toHaveLength(6);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("x");
    expect(s.recorded()).toMatchObject({ stdin: "---\nbrief", pwd: repo, cwd: elsewhere });
  });

  it("refuses an unknown flag, a missing agent, an unlisted model and an unknown variant like v2 does", () => {
    const xdg = configWithAgent();
    const s = withOpencodeScenario({ models: MODELS });
    const env = { ...s.env, XDG_CONFIG_HOME: xdg };
    const run = (...extra: string[]) => opencode(["run", "--format", "json", ...extra], env);
    expect(run("--dir", "/x").code).toBe(1);
    expect(run("--agent", "catherd-ro", "-m", "opencode/big-pickle").out).toContain(
      "Agent not found: catherd-ro",
    );
    expect(run("--agent", "catherd-worker", "-m", "opencode/nope").out).toContain(
      '"type":"provider.no-route"',
    );
    const bad = run("--agent", "catherd-worker", "-m", "opencode/big-pickle#ultra");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("Variant unavailable for opencode/big-pickle: ultra");
  });

  it("behaves as v1 when told: no --standalone, no api, and a v1 error for model#variant", () => {
    const xdg = configWithAgent();
    const env = { ...withOpencodeScenario({ version: "1.18.32" }).env, XDG_CONFIG_HOME: xdg };
    expect(opencode(["run", "--standalone"], env).code).toBe(1);
    expect(opencode(["api", "GET", "/api/model"], env).code).toBe(1);
    const r = opencode(["run", "--agent", "catherd-worker", "-m", "opencode/big-pickle#high"], env);
    expect(JSON.parse(r.out).error.name).toBe("UnknownError");
  });
});
