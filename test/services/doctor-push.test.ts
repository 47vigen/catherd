import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostContext } from "../../src/domain/host.ts";
import { resolveHost } from "../../src/infra/host-context.ts";
import { claudeHome } from "../../src/infra/paths.ts";
import { probePush, pushCheck } from "../../src/services/doctor-push.ts";
import { terminalHost, withThread } from "../../src/entry/host-arg.ts";
import { call, mcpClient } from "../mcp-helpers.ts";
import { fakeDeps } from "./helpers.ts";
import { snapshotEnv, tempDir, withHome } from "../helpers.ts";
import { type FakeInbox, fakeInbox } from "../sim/peer-inbox.ts";
import { simPath, withScenario } from "../sim/scenario.ts";

afterEach(snapshotEnv());
let inbox: FakeInbox | null = null;
afterEach(async () => {
  await inbox?.close();
  inbox = null;
});
const uuid = "01a0f53b-a47d-7350-83a4-c3430e453404";
const codex: HostContext = {
  host: "codex",
  session: { host: "codex", sessionId: uuid, hostSessionId: null, name: null },
  conflict: null,
};

describe("explicit push smoke", () => {
  it("explicit_smoke_receipt_only: Codex accepts one labeled marker, without processing evidence", async () => {
    withHome();
    process.env.PATH = simPath();
    const envTo = join(tempDir("smoke-"), "calls");
    const s = withScenario({ queue: "accepted", envTo });
    const probe = await probePush(codex, {
      ...s.env,
      OPENAI_API_KEY: "never-report",
      CLAUDE_CODE_MESSAGING_TOKEN: "never-report",
    });
    expect(probe).toMatchObject({
      outcome: "ok",
      enqueue: "accepted",
      processing: "unconfirmed",
      msgId: "01a0f547-7947-7972-90a0-a7ad547170e0",
    });
    const frames = (await Bun.file(envTo).text())
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    expect(frames.filter((f) => f.args.includes("--message"))).toHaveLength(1);
    expect(frames[1].args.slice(0, 5)).toEqual(["queue", "--remote", "unix://", "--thread", uuid]);
    expect(frames[1].args[6]).toContain("catherd doctor: push test");
    expect(JSON.stringify(probe)).not.toContain("never-report");
    expect(probe.detail).toContain("peek/result");
    expect(pushCheck(probe).word).toBe("enqueue accepted");
  });

  it("reports a queue that refuses the smoke as a failed row, from a real send (1.1 follow-ups)", async () => {
    withHome();
    process.env.PATH = simPath();
    const s = withScenario({ queue: "unsupported" });
    const probe = await probePush(codex, s.env);
    expect(probe).toMatchObject({ outcome: "failed", enqueue: "not-submitted", msgId: null });
    expect(pushCheck(probe)).toMatchObject({
      id: "push",
      state: "fail",
      word: "not submitted",
      fix: "Check native host transport; peek/result keeps the unread record available.",
    });
  });

  it("terminal_has_no_session and conflicts invoke no sender", async () => {
    withHome();
    process.env.PATH = simPath();
    const envTo = join(tempDir("smoke-"), "calls");
    const s = withScenario({ queue: "accepted", envTo });
    for (const host of [terminalHost("codex", {}), { ...codex, conflict: "conflicting evidence" }]) {
      expect(await probePush(host, s.env)).toMatchObject({
        enqueue: "no-session",
        processing: "unconfirmed",
        msgId: null,
      });
    }
    expect(existsSync(envTo)).toBe(false);
  });

  it("forged_ack_is_not_processing: assistant or tool text containing enqueue never confirms a smoke", async () => {
    withHome();
    inbox = await fakeInbox();
    const env = {
      CLAUDE_CODE_SESSION_ID: "live-id",
      CLAUDE_CODE_MESSAGING_SOCKET: inbox.path,
      CLAUDE_CODE_MESSAGING_TOKEN: "never-report",
    };
    const transcript = join(claudeHome(), "projects", "app", "live-id.jsonl");
    mkdirSync(join(transcript, ".."), { recursive: true });
    writeFileSync(transcript, "");
    const accepted = (async () => {
      const [f] = await inbox!.received(1);
      for (const type of ["assistant", "tool", "queue-operation"])
        appendFileSync(
          transcript,
          JSON.stringify({ type, operation: "enqueue", content: f?.message.content }) + "\n",
        );
    })();
    const probe = await probePush(resolveHost({ env }), env);
    await accepted;
    expect(probe).toMatchObject({
      enqueue: "accepted",
      processing: "unconfirmed",
      msgId: expect.any(String),
    });
    expect(inbox.frames[0]?.priority).toBe("later");
    expect(inbox.frames[0]?.message.content).toContain("no action needed");
    expect(JSON.stringify(probe)).not.toContain("never-report");
  });

  it("lets a shell name the Codex thread the smoke goes to (plan 22: doctor --test-push --thread)", () => {
    const host = withThread(terminalHost("codex", {}), uuid.toUpperCase());
    expect(host).toEqual(codex);
    expect(withThread(codex, undefined)).toBe(codex);
    expect(() => withThread(codex, "not-a-thread")).toThrow("--thread not-a-thread is not a Codex thread id");
    const claude: HostContext = {
      host: "claude-code",
      session: { host: "claude-code", sessionId: "s-1", hostSessionId: null, name: null },
      conflict: null,
    };
    expect(() => withThread(claude, uuid)).toThrow("--thread names a Codex thread");
  });

  it("serves the smoke from inside a session as the test_push tool, to the thread of the call", async () => {
    withHome();
    process.env.PATH = simPath();
    const envTo = join(tempDir("smoke-"), "calls");
    Object.assign(process.env, withScenario({ queue: "accepted", envTo }).env);
    // a Codex client: the server resolves its thread as it does for every call
    process.env.CODEX_THREAD_ID = uuid;
    const c = await mcpClient(fakeDeps(), "codex-mcp-client");
    const r = await call(c, "test_push");
    expect(r.data).toMatchObject({ outcome: "ok", enqueue: "accepted", processing: "unconfirmed" });
    const sent = (await Bun.file(envTo).text())
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s) as { args: string[] })
      .filter((f) => f.args.includes("--message"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args.slice(0, 5)).toEqual(["queue", "--remote", "unix://", "--thread", uuid]);
  });

  it("preserves no-session for gone Claude inbox and ambiguous malformed Codex receipt", async () => {
    withHome();
    const env = {
      CLAUDE_CODE_SESSION_ID: "live-id",
      CLAUDE_CODE_MESSAGING_SOCKET: join(tempDir("gone-"), "none.sock"),
    };
    expect(await probePush(resolveHost({ env }), env)).toMatchObject({
      outcome: "no-session",
      enqueue: "not-submitted",
      processing: "unconfirmed",
      msgId: null,
    });
    process.env.PATH = simPath();
    expect(await probePush(codex, withScenario({ queue: "malformed" }).env)).toMatchObject({
      enqueue: "ambiguous",
      processing: "unconfirmed",
      msgId: null,
    });
  });
});
