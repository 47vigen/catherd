import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One frame as the fake inbox parsed it: the auth line (if any) and the user frame of one connection. */
export interface ReceivedFrame {
  auth: { type: string; token?: string } | null;
  msgV: number;
  msg_id: string;
  type: string;
  message: { role: string; content: string };
  priority?: string;
  session_id?: string;
  /** every line of the connection, raw */
  lines: string[];
}

export interface FakeInbox {
  /** the socket path, to hand to the sender as CLAUDE_CODE_MESSAGING_SOCKET */
  path: string;
  frames: ReceivedFrame[];
  /** resolves once `n` frames have arrived (rejects after `ms`) */
  received(n: number, ms?: number): Promise<ReceivedFrame[]>;
  close(): Promise<void>;
}

/**
 * A fake Claude Code peer inbox (spec §15): a Unix socket that reads each connection to its end, as the real one does
 * (`allowHalfOpen`, the tail parsed on `end`), and records the frame. It never answers.
 */
export async function fakeInbox(): Promise<FakeInbox> {
  const dir = mkdtempSync(join(tmpdir(), "cc-socks-"));
  const path = join(dir, "1.sock");
  const frames: ReceivedFrame[] = [];
  const waiters: (() => void)[] = [];
  const server: Server = createServer({ allowHalfOpen: true }, (c) => {
    let text = "";
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      text += d;
    });
    c.on("end", () => {
      const lines = text.split("\n").filter((l) => l.trim());
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const auth = parsed[0]?.type === "auth" ? (parsed[0] as ReceivedFrame["auth"]) : null;
      const user = parsed.find((p) => p.type === "user");
      if (user) frames.push({ ...(user as unknown as ReceivedFrame), auth, lines });
      for (const w of waiters.splice(0)) w();
      c.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    frames,
    async received(n, ms = 10_000) {
      const end = Date.now() + ms;
      while (frames.length < n) {
        if (Date.now() > end) throw new Error(`fake inbox: ${frames.length} of ${n} frames after ${ms} ms`);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 50);
          waiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      return frames.slice(0, n);
    },
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        }),
      ),
  };
}
