import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelope } from "../../src/domain/notice.ts";
import { frameText, inboxLimits, sendToInbox } from "../../src/infra/peer-inbox.ts";
import { type FakeInbox, fakeInbox } from "../sim/peer-inbox.ts";

let inbox: FakeInbox | null = null;
afterEach(async () => {
  await inbox?.close();
  inbox = null;
  inboxLimits.connectMs = 2_000;
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("the peer inbox sender (spec §3.4)", () => {
  it("writes the auth line with the child token, then one user frame, and closes", async () => {
    inbox = await fakeInbox();
    const r = await sendToInbox({ socketPath: inbox.path, token: "child-token" }, envelope("hello"), "later");
    expect(r.outcome).toBe("sent");
    const [f] = await inbox.received(1);
    expect(f?.lines).toHaveLength(2);
    expect(f?.auth).toEqual({ type: "auth", token: "child-token" });
    expect(f).toMatchObject({
      msgV: 1,
      type: "user",
      message: {
        role: "user",
        content: '<cross-session-message from-name="catherd">\nhello\n</cross-session-message>',
      },
      priority: "later",
    });
    expect(f?.msg_id).toMatch(UUID);
    expect(f?.msg_id).toBe(r.msgId as string);
    // a stale session id drops the frame at the receiver; a declared mode can hold it
    expect(f?.session_id).toBeUndefined();
    expect(f?.message.content).not.toContain("from-mode");
  });

  it("sends the priority it is given, and no auth line without a token", async () => {
    inbox = await fakeInbox();
    await sendToInbox({ socketPath: inbox.path, token: null }, envelope("x"), "next");
    const [f] = await inbox.received(1);
    expect(f?.auth).toBeNull();
    expect(f?.lines).toHaveLength(1);
    expect(f?.priority).toBe("next");
  });

  it("returns no-session without a socket, or when the socket is gone, and never throws", async () => {
    expect(await sendToInbox({ socketPath: null, token: "t" }, "x", "later")).toEqual({
      outcome: "no-session",
      reason: "no messaging socket in this session's environment",
    });
    const gone = join(mkdtempSync(join(tmpdir(), "cc-socks-")), "9.sock");
    expect(await sendToInbox({ socketPath: gone, token: "t" }, "x", "later")).toMatchObject({
      outcome: "no-session",
    });
  });

  it("returns error, with the reason, when the path is not a socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-socks-"));
    const r = await sendToInbox({ socketPath: dir, token: "t" }, "x", "later");
    expect(["error", "refused"]).toContain(r.outcome);
    expect(r.reason).toBeTruthy();
  });

  it("gives up on a socket that never accepts, within the connect limit", async () => {
    // a listener with a zero backlog that never accepts: some kernels still complete the handshake, so either
    // way the sender must return, never hang
    const path = join(mkdtempSync(join(tmpdir(), "cc-socks-")), "2.sock");
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(path, resolve));
    inboxLimits.connectMs = 200;
    try {
      const r = await sendToInbox({ socketPath: path, token: "t" }, "x", "later");
      expect(["sent", "error"]).toContain(r.outcome);
    } finally {
      server.close();
    }
  });

  it("builds exactly the two lines the protocol names", () => {
    expect(frameText("c", "later", "tok", "00000000-0000-4000-8000-000000000000")).toBe(
      '{"type":"auth","token":"tok"}\n{"msgV":1,"msg_id":"00000000-0000-4000-8000-000000000000","type":"user","message":{"role":"user","content":"c"},"priority":"later"}\n',
    );
  });
});
