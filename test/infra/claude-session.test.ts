import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  claudeConfigDir,
  liveSessionFile,
  readSessionEnv,
  readSessionFiles,
  sessionFileFor,
} from "../../src/infra/claude-session.ts";
import { scrubSecrets } from "../../src/infra/env.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

/** A registry file, as a live Claude Code session writes it. */
function registry(pid: number, over: Record<string, unknown> = {}): void {
  const dir = join(claudeConfigDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: `s-${pid}`,
      cwd: "/repo",
      startedAt: 1,
      version: "2.1.283",
      peerProtocol: 1,
      messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
      name: `session ${pid}`,
      status: "idle",
      ...over,
    }),
  );
}

describe("the Claude Code session (spec §3.3)", () => {
  it("reads the four variables, each optional, and nothing outside Claude Code", () => {
    expect(readSessionEnv({})).toBeNull();
    expect(readSessionEnv({ CLAUDE_CODE_HOST_SESSION_ID: "h" })).toBeNull();
    expect(
      readSessionEnv({
        CLAUDE_CODE_SESSION_ID: "s1",
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
        CLAUDE_CODE_MESSAGING_TOKEN: "t",
      }),
    ).toEqual({ sessionId: "s1", hostSessionId: null, socketPath: "/tmp/cc-socks/1.sock", token: "t" });
  });

  it("finds its session file by the socket, then its parent's pid, then the session id", () => {
    withHome();
    registry(11);
    registry(12, { messagingSocketPath: "/tmp/cc-socks/other.sock" });
    registry(13, { sessionId: "after-clear" });
    const files = readSessionFiles();
    const env = { sessionId: "s-13", hostSessionId: null, socketPath: "/tmp/cc-socks/11.sock", token: null };
    expect(sessionFileFor(env, files, 12)?.pid).toBe(11);
    expect(sessionFileFor({ ...env, socketPath: null }, files, 12)?.pid).toBe(12);
    expect(sessionFileFor({ ...env, socketPath: null, sessionId: "s-11" }, files, 99)?.pid).toBe(11);
    expect(sessionFileFor({ ...env, socketPath: null, sessionId: "gone" }, files, 99)).toBeNull();
  });

  it("skips a torn or foreign file, and names a session live only while its process runs", () => {
    withHome();
    registry(process.pid, { sessionId: "mine" });
    registry(2_147_483_000, { sessionId: "dead" });
    writeFileSync(join(claudeConfigDir(), "sessions", "5.json"), "{ torn");
    writeFileSync(join(claudeConfigDir(), "sessions", `${process.pid}.abc.key`), "k");
    expect(
      readSessionFiles()
        .map((f) => f.sessionId)
        .sort(),
    ).toEqual(["dead", "mine"]);
    expect(liveSessionFile("mine")?.pid).toBe(process.pid);
    expect(liveSessionFile("dead")).toBeNull();
  });

  it("reads Claude Code's config dir from CLAUDE_CONFIG_DIR", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/x" })).toBe("/x");
    expect(claudeConfigDir({})).toMatch(/\.claude$/);
  });

  it("keeps the messaging socket and token from every process catherd starts (spec §3.2)", () => {
    expect(
      scrubSecrets({
        CLAUDE_CODE_SESSION_ID: "s",
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
        CLAUDE_CODE_MESSAGING_TOKEN: "t",
        PATH: "/bin",
      }),
    ).toEqual({ CLAUDE_CODE_SESSION_ID: "s", PATH: "/bin" });
  });

  it("gives every test a Claude config dir of its own and no session", () => {
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = "/tmp/cc-socks/real.sock";
    const home = withHome();
    expect(process.env.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined();
    expect(claudeConfigDir()).toBe(join(home, "claude-config"));
  });
});
