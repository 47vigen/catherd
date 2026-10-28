import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { VERSION } from "../../src/infra/version.ts";
import { SRC } from "../import-graph.ts";

/** `catherd <args> --help` with stdout piped; `env` on top of a colour-capable terminal's. */
function rawHelp(args: string[], env: Record<string, string | undefined> = { NO_COLOR: "1" }): string {
  const base: Record<string, string | undefined> = {
    ...process.env,
    TERM: "xterm-256color",
    ANTHROPIC_API_KEY: "",
  };
  for (const k of ["NO_COLOR", "CI", "TEST"]) delete base[k];
  return Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), ...args, "--help"], {
    env: { ...base, ...env },
    stdout: "pipe",
    stderr: "pipe",
  }).stdout.toString();
}
const help = (...args: string[]) => rawHelp(args).replace(/\s+/g, " ");

describe("--help says how lock and init treat the terminal", () => {
  it("lock runs its command in its own process group and session", () => {
    expect(help("lock")).toContain("own process group and session: it gets no /dev/tty");
  });

  it("init reads piped answers line by line and waits for stdin to close", () => {
    expect(help("init")).toContain(
      "reads the answers from stdin one per line, a line per question even when this machine skips it",
    );
    expect(help("init")).toContain("and waits for stdin to close");
  });
});

describe("--help matches the CLI (audit S5, S6, N3)", () => {
  it("names a subcommand in full, with the version, as the top level does", () => {
    expect(help("runs", "list")).toContain(
      `(catherd runs list v${VERSION}) USAGE catherd runs list [OPTIONS]`,
    );
    expect(help("profile", "set")).toContain("USAGE catherd profile set [OPTIONS] <PATH> <VALUE>");
    expect(help("catalog")).toContain(`(catherd catalog v${VERSION})`);
    expect(help("catalog")).toContain("Use catherd catalog <command> --help");
  });

  it("lists --verbose among every command's options, and not as prose", () => {
    for (const args of [[], ["init"], ["doctor"], ["runs", "show"], ["lock"], ["mcp"]])
      expect(help(...args)).toContain("--verbose log at debug level (CATHERD_LOG=debug)");
    expect(help()).not.toContain("Any command takes --verbose");
  });

  it("shows lock's command after --", () => {
    expect(help("lock")).toContain("USAGE catherd lock [--slots N] -- <command> [args...]");
  });

  it("documents init's --no-input, not an --input that defaults to true", () => {
    const text = help("init");
    expect(text).toContain("--no-input ask nothing: keep what exists, else write the defaults");
    expect(text).not.toMatch(/(^|[^-])--input/);
    expect(text).toContain("--no-global do not install the global catherd command");
    expect(text).not.toMatch(/(^|[^-])--global/);
    expect(text).not.toContain("Default: true");
  });

  it("prints no colour codes when piped, even without NO_COLOR", () => {
    for (const args of [[], ["runs", "list"], ["lock"]]) expect(rawHelp(args, {})).not.toContain("\x1b[");
  });
});
