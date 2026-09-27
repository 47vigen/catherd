import { describe, expect, it } from "bun:test";
import { handshakeEnv } from "../../src/entry/mcp/handshake.ts";

describe("doctor's MCP handshake", () => {
  it("starts the server without catherd's own secret, and with the rest of the env (SECURITY.md)", () => {
    const env = handshakeEnv({ TYPESAFE_API_KEY: "tsk_live_0123456789abcdef", PATH: "/usr/bin", HOME: "/h" });
    expect(env.TYPESAFE_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/h");
  });
});
