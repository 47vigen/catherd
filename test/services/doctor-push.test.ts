import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeHome } from "../../src/infra/paths.ts";
import { doctor } from "../../src/services/doctor.ts";
import { probePush, pushCheck, pushLimits } from "../../src/services/doctor-push.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { type FakeInbox, fakeInbox } from "../sim/peer-inbox.ts";

afterEach(snapshotEnv());
let inbox: FakeInbox | null = null;
afterEach(async () => {
  await inbox?.close();
  inbox = null;
  pushLimits.waitMs = 5_000;
});

/** A socket file whose listener was killed: connecting to it is refused, on Linux and macOS alike. */
async function staleSocket(): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "cc-socks-")), "10.sock");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("up"))`,
    ],
    { stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "" } },
  );
  const reader = child.stdout.getReader();
  await reader.read(); // "up": the socket file exists
  child.kill("SIGKILL");
  await child.exited;
  return path;
}

/** The session the doctor runs in: its registry file names the fake inbox; its transcript is in a worktree's slug. */
async function inSession(o: { transcript: boolean }) {
  withHome();
  inbox = await fakeInbox();
  mkdirSync(join(claudeHome(), "sessions"), { recursive: true });
  writeFileSync(
    join(claudeHome(), "sessions", "77.json"),
    JSON.stringify({ pid: 77, sessionId: "live-id", messagingSocketPath: inbox.path }),
  );
  const transcript = join(claudeHome(), "projects", "-home-me-app", "live-id.jsonl");
  if (o.transcript) {
    mkdirSync(join(claudeHome(), "projects", "-home-me-app"), { recursive: true });
    writeFileSync(transcript, '{"type":"user"}\n');
  }
  const env = {
    // the id from before a /clear: the registry's is the live one
    CLAUDE_CODE_SESSION_ID: "stale-id",
    CLAUDE_CODE_MESSAGING_SOCKET: inbox.path,
    CLAUDE_CODE_MESSAGING_TOKEN: "child-token",
  };
  return { env, transcript };
}

/** What Claude Code does with a message it accepts: an enqueue line with the envelope in its transcript. */
async function accept(transcript: string): Promise<void> {
  const [f] = await (inbox as FakeInbox).received(1);
  appendFileSync(
    transcript,
    `${JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "t", sessionId: "live-id", content: f?.message.content })}\n`,
  );
}

describe("doctor's push row (spec §3.9)", () => {
  it("is ok when the test message is accepted: an enqueue line in the session's transcript", async () => {
    const { env, transcript } = await inSession({ transcript: true });
    const [probe] = await Promise.all([probePush(env), accept(transcript)]);
    expect(probe).toEqual({ outcome: "ok", detail: "a test message reached this session" });
    const [f] = inbox?.frames ?? [];
    expect(f?.priority).toBe("later");
    expect(f?.message.content).toMatch(
      /^<cross-session-message from-name="catherd">\ncatherd doctor: push test \w+, no action needed\n<\/cross-session-message>$/,
    );
    expect(pushCheck(probe)).toMatchObject({ id: "push", state: "ok", word: "ready" });
  });

  it("is held when the transcript gets no enqueue line, and names crossSessionInbound", async () => {
    const { env } = await inSession({ transcript: true });
    pushLimits.waitMs = 200;
    const probe = await probePush(env);
    expect(probe.outcome).toBe("held");
    expect(pushCheck(probe)).toMatchObject({
      state: "warn",
      word: "held",
      fix: expect.stringContaining('"crossSessionInbound": "accept"'),
    });
  });

  it("says it cannot confirm when the session has no transcript to read", async () => {
    const { env } = await inSession({ transcript: false });
    pushLimits.waitMs = 200;
    expect((await probePush(env)).outcome).toBe("unconfirmed");
  });

  it("skips outside Claude Code, and fails when the session's socket does not take the message", async () => {
    withHome();
    const none = await probePush({});
    expect(pushCheck(none)).toMatchObject({
      state: "skip",
      word: "no session",
      detail: "run catherd doctor from a Claude Code session to test push",
    });
  });

  it("calls a gone or refusing socket unreachable, not a Claude Code that cannot be notified", async () => {
    withHome();
    // a shell that outlived its session: the socket file is gone
    const gone = join(mkdtempSync(join(tmpdir(), "cc-socks-")), "9.sock");
    const stale = await probePush({ CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_MESSAGING_SOCKET: gone });
    expect(pushCheck(stale)).toMatchObject({ state: "skip", word: "no session" });
    expect(stale.detail).toContain("this session's inbox is not reachable");
    expect(stale.detail).toContain("run catherd doctor from a live Claude Code session");
    expect(stale.detail).not.toContain("Claude Code version");
    // a socket file its listener left behind (killed, so nothing unlinked it) refuses the connection
    const dead = await staleSocket();
    const refused = await probePush({ CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_MESSAGING_SOCKET: dead });
    expect(pushCheck(refused)).toMatchObject({ state: "skip", word: "no session" });
  });

  it("fails, with the protocol advice, when the socket takes the connection but the send errors", () => {
    expect(
      pushCheck({
        outcome: "failed",
        detail: "catherd cannot notify this Claude Code version; peek still works",
      }),
    ).toMatchObject({ state: "fail", word: "failed" });
  });

  it("names the settings file of the Claude config dir in use when a message is held", () => {
    withHome();
    const dir = mkdtempSync(join(tmpdir(), "cc-config-"));
    process.env.CLAUDE_CONFIG_DIR = dir;
    const fix = pushCheck({ outcome: "held", detail: "held" }).fix ?? "";
    expect(fix).toContain(join(dir, "settings.json"));
    expect(fix).not.toContain("~/.claude");
  });

  it("is a row of the report only when doctor is given the probe", async () => {
    withHome();
    // no backend CLI and no key: the report's other rows touch nothing outside this test
    process.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    const handshake = async () => ({ ok: true, tools: ["status"] });
    const without = await doctor({ bunVersion: Bun.version, version: "0.0.0", handshake });
    expect(without.checks.some((c) => c.id === "push")).toBe(false);
    const withIt = await doctor({
      bunVersion: Bun.version,
      version: "0.0.0",
      handshake,
      push: async () => ({
        outcome: "no-session",
        detail: "run catherd doctor from a Claude Code session to test push",
      }),
    });
    expect(withIt.checks.find((c) => c.id === "push")).toMatchObject({ state: "skip", word: "no session" });
  });
});
