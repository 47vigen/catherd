import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SRC } from "../import-graph.ts";

const help = (cmd: string) =>
  Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), cmd, "--help"], {
    env: { ...process.env, NO_COLOR: "1", ANTHROPIC_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  })
    .stdout.toString()
    .replace(/\s+/g, " ");

describe("--help says how lock and init treat the terminal", () => {
  it("lock runs its command in its own process group and session", () => {
    expect(help("lock")).toContain("own process group and session: it gets no /dev/tty");
  });

  it("init reads piped answers line by line and waits for stdin to close", () => {
    expect(help("init")).toContain("reads the answers from stdin one per line and waits for stdin to close");
  });
});
