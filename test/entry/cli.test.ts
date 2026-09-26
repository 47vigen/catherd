import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killGroup } from "../../src/infra/proc.ts";
import { waitFor } from "../services/helpers.ts";
import { bunTooOld, MIN_BUN, runtimeRefusal } from "../../src/domain/runtime.ts";
import { VERSION } from "../../src/infra/version.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { importGraph, SRC } from "../import-graph.ts";

afterEach(snapshotEnv());

const CLI = join(SRC, "cli.ts");
function catherd(args: string[], env: Record<string, string | undefined> = {}) {
  const p = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: { ...process.env, PATH: "/nonexistent", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("the Bun guard (spec §3.1)", () => {
  it("compares versions numerically against 1.4.0", () => {
    expect(MIN_BUN).toBe("1.4.0");
    expect([
      bunTooOld("1.3.11"),
      bunTooOld("1.4.0"),
      bunTooOld("1.4.2"),
      bunTooOld("1.10.0"),
      bunTooOld("2.0.0"),
    ]).toEqual([true, false, false, false, false]);
  });

  it("refuses an old or missing Bun with the upgrade command", () => {
    expect(runtimeRefusal("1.3.11")).toEqual([
      "error E_RUNTIME_TOO_OLD: catherd needs Bun 1.4.0 or newer; this is Bun 1.3.11",
      "fix: bun upgrade (or install Bun: curl -fsSL https://bun.sh/install | bash)",
    ]);
    expect(runtimeRefusal(undefined)?.[0]).toContain("this is not Bun");
    expect(runtimeRefusal(Bun.version)).toBeNull();
  });
});

describe("catherd (spec §8)", () => {
  it("prints its version", () => {
    expect(catherd(["--version"])).toEqual({ code: 0, out: `${VERSION}\n`, err: "" });
  });

  it("exits 2 on a usage error, with one error line and a fix", () => {
    withHome();
    const r = catherd(["nope"], { NO_COLOR: "1" });
    expect([r.code, r.err]).toEqual([
      2,
      "error E_INPUT_INVALID: Unknown command nope\nfix: catherd --help\n",
    ]);
  });

  it("exits 1 on a catherd error, with one error line and a fix", () => {
    withHome();
    const r = catherd(["_supervise", "/nonexistent/spec.json"]);
    expect(r.code).toBe(1);
    expect(r.err).toStartWith("error E_CONFIG_INVALID: /nonexistent/spec.json is not readable JSON");
    expect(r.err).toContain("\nfix: fix or delete /nonexistent/spec.json\n");
  });

  it("hides _supervise from help, and leaves a command's own --help and --verbose after -- alone", () => {
    withHome();
    const help = catherd(["--help"], { NO_COLOR: "1" });
    expect(help.code).toBe(0);
    expect(help.out).toContain("capture-fixtures");
    expect(help.out).not.toContain("_supervise");
    const passed = catherd(
      ["lock", "--slots", "1", "--", "sh", "-c", 'echo "$@"', "sh", "--help", "--verbose"],
      {
        PATH: process.env.PATH,
      },
    );
    expect([passed.code, passed.out]).toEqual([0, "--help --verbose\n"]);
  });

  it("takes --verbose anywhere before --", () => {
    withHome();
    expect(catherd(["--verbose", "--version"])).toEqual({ code: 0, out: `${VERSION}\n`, err: "" });
    expect(catherd(["catalog", "list", "--verbose", "--backend", "codex", "--text", "gpt-6-luna"]).code).toBe(
      0,
    );
  });

  it("exits 130 when interrupted", async () => {
    const home = withHome();
    const p = Bun.spawn([process.execPath, CLI, "mcp"], {
      env: { ...process.env, CATHERD_HOME: home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    // Ctrl-C once the server answers: the command is running, not starting
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    };
    p.stdin.write(`${JSON.stringify(initialize)}\n`);
    p.stdin.flush();
    const reader = p.stdout.getReader();
    let seen = "";
    while (!seen.includes('"id":1')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`catherd mcp exited before it answered: ${seen}`);
      seen += new TextDecoder().decode(chunk.value);
    }
    p.kill("SIGINT");
    expect(await p.exited).toBe(130);
  });

  it("leaves Ctrl-C to lock's command even after a flag, and exits with the command's code", async () => {
    const home = withHome();
    const dir = mkdtempSync(join(tmpdir(), "catherd-int-"));
    const [pidFile, heard] = [join(dir, "pid"), join(dir, "heard")];
    const script = `trap 'echo INT >> ${heard}; exit 5' INT; echo $$ > ${pidFile}; while :; do sleep 0.05; done`;
    const p = Bun.spawn(
      [process.execPath, CLI, "--plain", "lock", "--slots", "1", "--", "sh", "-c", script],
      {
        env: { ...process.env, CATHERD_HOME: home },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    try {
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim());
      p.kill("SIGINT");
      expect(await p.exited).toBe(5);
      expect(readFileSync(heard, "utf8")).toBe("INT\n");
    } finally {
      // a catherd that exited on its own Ctrl-C leaves the command running: stop it
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (pid > 1) killGroup(pid, "SIGKILL");
    }
  });

  it("never loads OpenTUI or React for mcp, lock or _supervise (spec §3.1)", () => {
    for (const entry of ["entry/mcp/command.ts", "entry/lock.ts", "entry/supervise.ts"]) {
      const g = importGraph(join(SRC, entry));
      expect(g.packages.filter((p) => p.startsWith("@opentui") || p === "react")).toEqual([]);
      expect(g.files.filter((f) => f.startsWith("entry/tui/"))).toEqual([]);
    }
  });
});
