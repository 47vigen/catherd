#!/usr/bin/env bun
/**
 * The catherd 1.1 push spike (plan 10 Task 1, docs/research/2026-09-28-cross-session-messaging.md). Run it from
 * a Claude Code session's Bash tool, on macOS and on Linux:
 *
 *   bun scripts/spike-push.ts            # sends one `later` message to this session and checks it arrived
 *   bun scripts/spike-push.ts --dry-run  # prints what it would send, sends nothing
 *
 * It stands alone (nothing from src/), so it runs before any of plan 10 is built. It never prints the token.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const dry = process.argv.includes("--dry-run");
const env = process.env;
const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const socket = env.CLAUDE_CODE_MESSAGING_SOCKET;
const token = env.CLAUDE_CODE_MESSAGING_TOKEN;

console.log(`os ${platform()} · config dir ${configDir}`);
for (const k of [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
])
  console.log(`env ${k}: ${env[k] ? "set" : "absent"}`);
if (!socket) {
  console.log("verdict: no session (run this from a Claude Code session's Bash tool)");
  process.exit(2);
}

type Entry = {
  pid?: number;
  sessionId?: string;
  name?: string;
  version?: string;
  messagingSocketPath?: string;
};
const sessions = join(configDir, "sessions");
const entries: Entry[] = existsSync(sessions)
  ? readdirSync(sessions)
      .filter((f) => /^\d+\.json$/.test(f))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(sessions, f), "utf8")) as Entry];
        } catch {
          return [];
        }
      })
  : [];
const mine = entries.find((e) => e.messagingSocketPath === socket);
console.log(
  mine
    ? `registry: pid ${mine.pid} · session ${mine.sessionId} · name ${mine.name ?? "-"} · claude ${mine.version ?? "?"}`
    : "registry: no session file names this socket",
);
const sessionId = mine?.sessionId ?? env.CLAUDE_CODE_SESSION_ID;
if (mine?.sessionId && env.CLAUDE_CODE_SESSION_ID && mine.sessionId !== env.CLAUDE_CODE_SESSION_ID)
  console.log("note: the env session id is stale (a /clear or /resume since start); using the registry's");

const nonce = crypto.randomUUID().slice(0, 8);
const text = `catherd spike: push test ${nonce}, no action needed`;
const frame = {
  msgV: 1,
  msg_id: crypto.randomUUID(),
  type: "user",
  message: {
    role: "user",
    content: `<cross-session-message from-name="catherd">\n${text}\n</cross-session-message>`,
  },
  priority: "later",
};
const payload = `${token ? `${JSON.stringify({ type: "auth", token })}\n` : ""}${JSON.stringify(frame)}\n`;
console.log(`frame: auth line ${token ? "yes" : "no (no token in env)"} · ${JSON.stringify(frame)}`);
if (dry) process.exit(0);

const sent = await new Promise<string>((resolve) => {
  const s = createConnection({ path: socket });
  s.setTimeout(5_000, () => {
    s.destroy();
    resolve("error: no connection within 5 s");
  });
  s.on("error", (e: NodeJS.ErrnoException) => resolve(`error: ${e.code ?? e.message}`));
  s.on("connect", () =>
    s.write(payload, () =>
      setTimeout(() => {
        s.end();
        resolve("sent");
      }, 150),
    ),
  );
});
console.log(`send: ${sent}`);
if (sent !== "sent") {
  console.log("verdict: failed (the socket did not take the frame)");
  process.exit(1);
}

/** The transcript: `projects/<slug>/<sessionId>.jsonl`, found by globbing (a worktree logs under its checkout). */
const transcript = (): string | null => {
  const projects = join(configDir, "projects");
  if (!sessionId || !existsSync(projects)) return null;
  for (const d of readdirSync(projects)) {
    const f = join(projects, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
};
const deadline = Date.now() + 10_000;
for (;;) {
  const f = transcript();
  const hit =
    f !== null &&
    readFileSync(f, "utf8")
      .split("\n")
      .some((l) => l.includes('"operation":"enqueue"') && l.includes(nonce));
  if (hit) {
    console.log(`verdict: ok (enqueue line found in ${f})`);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.log(
      f
        ? `verdict: held (no enqueue line in ${f} within 10 s: check crossSessionInbound in your settings)`
        : "verdict: sent, not confirmed (no transcript found for this session)",
    );
    process.exit(1);
  }
  await Bun.sleep(250);
}
