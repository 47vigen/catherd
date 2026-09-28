import { describe, expect, it } from "bun:test";
import { handshakeEnv } from "../../src/entry/mcp/handshake.ts";

describe("doctor's MCP handshake", () => {
  it("starts the server without catherd's own secret, and with the rest of the env (SECURITY.md)", () => {
    const env = handshakeEnv({ TYPESAFE_API_KEY: "tsk_live_0123456789abcdef", PATH: "/usr/bin", HOME: "/h" });
    expect(env.TYPESAFE_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/h");
  });

  it("starts the server with no session identity, so it never takes itself for the doctor's session", () => {
    const env = handshakeEnv({
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CODE_HOST_SESSION_ID: "h",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      PATH: "/usr/bin",
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});
