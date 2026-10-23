import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { panelHost, panelServer, runPanel } from "../../src/entry/panel-command.ts";
import { panelOrigin } from "../../src/services/notify-service.ts";
import { fakeDeps } from "../services/helpers.ts";
import { configFile } from "../../src/services/profile-store.ts";
import { recordHost } from "../../src/services/profile-service.ts";
import { SRC } from "../import-graph.ts";
import { snapshotEnv, spawnEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const CLI = join(SRC, "cli.ts");
const procs: Bun.Subprocess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
});

function distDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "catherd-dist-"));
  writeFileSync(join(dir, "index.html"), '<!doctype html><div id="root"></div>');
  return dir;
}
function panel(args: string[], dist: string | undefined) {
  const home = withHome();
  const p = Bun.spawn([process.execPath, CLI, "panel", ...args], {
    env: spawnEnv({
      PATH: process.env.PATH,
      CATHERD_HOME: home,
      ...(dist ? { CATHERD_PANEL_DIST: dist } : {}),
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(p);
  return p;
}
async function firstLine(p: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  const reader = p.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.split("\n")[0] as string;
}

describe("catherd panel", () => {
  it("records its served origin and clears it when stopped, even on a wait failure", async () => {
    withHome();
    delete process.env.CATHERD_ROLE;
    process.env.CATHERD_PANEL_DIST = distDir();
    process.env.TMPDIR = ".";
    const original = { ...panelServer };
    const log = console.log;
    console.log = () => {};
    try {
      for (const fails of [false, true]) {
        let stopped = false;
        panelServer.serve = () => ({
          url: "http://127.0.0.1:4321",
          port: 4321,
          stop: async () => {
            stopped = true;
          },
        });
        panelServer.untilStopped = async () => {
          expect(panelOrigin(fakeDeps())).toBe("http://127.0.0.1:4321");
          if (fails) throw new Error("wait failed");
        };
        if (fails) await expect(runPanel({ port: 0, open: false })).rejects.toThrow("wait failed");
        else await runPanel({ port: 0, open: false });
        expect(stopped).toBe(true);
        expect(panelOrigin(fakeDeps())).toBeNull();
      }
    } finally {
      Object.assign(panelServer, original);
      console.log = log;
    }
  });

  it("prints the link with a fresh token and opens nothing with --no-open", async () => {
    const p = panel(["--no-open", "--port", "0"], distDir());
    const line = await firstLine(p as never);
    expect(line).toMatch(/^catherd panel: http:\/\/127\.0\.0\.1:\d+\/login#token=[A-Za-z0-9_-]{43}$/);
    const origin = (line.match(/http:\/\/127\.0\.0\.1:\d+/) as RegExpMatchArray)[0];
    expect((await fetch(`${origin}/login`)).status).toBe(200);
  });

  it("says when the panel is not built", async () => {
    const p = panel(["--no-open"], mkdtempSync(join(tmpdir(), "catherd-empty-")));
    expect(await p.exited).toBe(1);
    const err = await new Response(p.stderr as ReadableStream).text();
    expect(err).toContain("the panel is not built");
    expect(err).toContain("bun run panel:build");
  });

  it("refuses a port in use, naming --port 0", async () => {
    const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    try {
      const p = panel(["--no-open", "--port", String(taken.port)], distDir());
      expect(await p.exited).toBe(2);
      const err = await new Response(p.stderr as ReadableStream).text();
      expect(err).toContain(`port ${taken.port} is in use`);
      expect(err).toContain("catherd panel --port 0");
    } finally {
      await taken.stop(true);
    }
  });

  it("refuses a port that is not a number", async () => {
    const p = panel(["--no-open", "--port", "abc"], distDir());
    expect(await p.exited).toBe(2);
    expect(await new Response(p.stderr as ReadableStream).text()).toContain("--port takes a number");
  });
});

describe("the panel's host", () => {
  const bare = (): void => {
    withHome();
    for (const k of Object.keys(process.env))
      if (/^(CODEX_|CLAUDE|CATHERD_HOST)/.test(k)) delete process.env[k];
  };

  it("is the host catherd init recorded when --host is not given and no session says otherwise", () => {
    bare();
    expect(panelHost(undefined).host).toBe("unknown");
    recordHost("claude-code");
    expect(panelHost(undefined)).toEqual({ host: "claude-code", session: null, conflict: null });
    expect(panelHost("auto").host).toBe("claude-code");
  });

  it("gives way to an explicit --host", () => {
    bare();
    recordHost("claude-code");
    expect(panelHost("codex").host).toBe("codex");
  });

  const writeConfig = (text: string): void => {
    mkdirSync(dirname(configFile()), { recursive: true });
    writeFileSync(configFile(), text);
  };

  it("never reads a broken config.json when --host already names the host", () => {
    bare();
    writeConfig("{ not json");
    expect(panelHost("codex").host).toBe("codex");
  });

  it("stays unknown, and still starts, when the stored host cannot be read", () => {
    bare();
    writeConfig(JSON.stringify({ schema: 2, host: "codex" }));
    expect(panelHost(undefined).host).toBe("unknown");
  });
});
