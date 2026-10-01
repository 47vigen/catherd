import { describe, expect, it } from "bun:test";
import { resolveHost } from "../../src/infra/host-context.ts";

const id = "0199c011-1234-7000-8000-000000000001";
const other = "0199c011-1234-7000-8000-000000000002";

describe("orchestration host evidence", () => {
  it("path_is_not_host: installed binaries and generic clients identify no host", () => {
    expect(resolveHost({ env: { PATH: "/bin/codex:/bin/claude" }, clientName: "catherd-test" })).toEqual({
      host: "unknown",
      session: null,
      conflict: null,
    });
  });
  it("consistent_host: initialized Codex and agreeing validated IDs identify its session", () => {
    expect(
      resolveHost({
        clientName: "codex-mcp-client",
        env: {
          CATHERD_ORCHESTRATION_HOST: "codex",
          CODEX_THREAD_ID: id,
          CODEX_SESSION_ID: id,
        },
      }),
    ).toEqual({
      host: "codex",
      session: {
        host: "codex",
        sessionId: id,
        hostSessionId: null,
        name: null,
      },
      conflict: null,
    });
    expect(resolveHost({ env: { CATHERD_ORCHESTRATION_HOST: "claude-code" } })).toEqual({
      host: "claude-code",
      session: null,
      conflict: null,
    });
  });
  it("conflicting_initialized_host: contradictory host or session evidence cannot own", () => {
    for (const evidence of [
      { clientName: "claude-code", env: { CODEX_THREAD_ID: id } },
      { clientName: "codex-mcp-client", env: { CLAUDE_CODE_SESSION_ID: "claude-session" } },
      { env: { CODEX_THREAD_ID: id, CODEX_SESSION_ID: other } },
      { env: { CODEX_THREAD_ID: "not-a-uuid" } },
      { env: { CODEX_SESSION_ID: " ../session " } },
    ]) {
      const resolved = resolveHost(evidence);
      expect(resolved.host).toBe("unknown");
      expect(resolved.session).toBeNull();
      expect(resolved.conflict).toBeTruthy();
    }
  });
  it("terminal_override_no_owner: setup selection invents no owner and cannot override conflicts", () => {
    expect(resolveHost({ env: {}, terminalHost: "codex" })).toEqual({
      host: "codex",
      session: null,
      conflict: null,
    });
    expect(
      resolveHost({ env: { CODEX_THREAD_ID: id, CLAUDE_CODE_SESSION_ID: "s" }, terminalHost: "codex" })
        .conflict,
    ).toBeTruthy();
    expect(resolveHost({ env: {}, clientName: "codex-mcp-client" }).session).toBeNull();
  });
});
