import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addSecret, log, logFile, redact, resetRotation, rotate, secretValues } from "../../src/infra/log.ts";
import { logsDir } from "../../src/infra/paths.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetRotation());

const rows = (now = new Date()) =>
  readFileSync(logFile(now), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("log", () => {
  it("appends one row per event under a schema header, in today's file", () => {
    withHome();
    delete process.env.CATHERD_LOG;
    log("info", "tool", { tool: "status", ms: 3 });
    const [header, row] = rows();
    expect(header).toEqual({ schema: 1, kind: "log" });
    expect(row).toMatchObject({ level: "info", event: "tool", tool: "status", ms: 3, pid: process.pid });
    expect(logFile()).toEndWith(`catherd-${new Date().toISOString().slice(0, 10)}.jsonl`);
  });

  it("keeps rows at or above CATHERD_LOG, info when unset, and nothing when off", () => {
    withHome();
    process.env.CATHERD_LOG = "warn";
    log("info", "a");
    log("warn", "b");
    process.env.CATHERD_LOG = "debug";
    log("debug", "c");
    process.env.CATHERD_LOG = "off";
    log("error", "d");
    expect(
      rows()
        .slice(1)
        .map((r) => r.event),
    ).toEqual(["b", "c"]);
  });

  it("never throws, even when the data dir cannot be written", () => {
    const home = withHome();
    writeFileSync(join(home, "data"), "a file where the data dir should be");
    expect(() => log("error", "x")).not.toThrow();
  });
});

describe("redact", () => {
  it("scrubs every *_KEY and *_TOKEN value and added secrets at any depth, and keeps an env map's keys only", () => {
    const env = { OPENAI_API_KEY: "sk-live-0123456789", GH_TOKEN: "ghp_abcdefghij", HOME: "/home/me" };
    addSecret("tsk-jev-key-000111");
    const secrets = secretValues(env);
    expect(
      redact<unknown>(
        {
          argv: ["codex", "--key", "sk-live-0123456789"],
          note: "token ghp_abcdefghij and tsk-jev-key-000111",
          env,
        },
        secrets,
      ),
    ).toEqual({
      argv: ["codex", "--key", "[redacted]"],
      note: "token [redacted] and [redacted]",
      env: ["GH_TOKEN", "HOME", "OPENAI_API_KEY"],
    });
  });

  it("leaves short values alone, so an ordinary word is never blanked", () => {
    expect(secretValues({ SOME_KEY: "yes" })).not.toContain("yes");
  });
});

describe("rotate", () => {
  it("keeps the last seven days of logs, today included, and nothing else it did not write", () => {
    withHome();
    mkdirSync(logsDir(), { recursive: true });
    const now = new Date("2026-09-25T12:00:00Z");
    for (let d = 0; d < 10; d++) {
      const date = new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10);
      writeFileSync(join(logsDir(), `catherd-${date}.jsonl`), "");
    }
    writeFileSync(join(logsDir(), "notes.txt"), "");
    rotate(now);
    expect(readdirSync(logsDir()).sort()).toEqual([
      "catherd-2026-09-19.jsonl",
      "catherd-2026-09-20.jsonl",
      "catherd-2026-09-21.jsonl",
      "catherd-2026-09-22.jsonl",
      "catherd-2026-09-23.jsonl",
      "catherd-2026-09-24.jsonl",
      "catherd-2026-09-25.jsonl",
      "notes.txt",
    ]);
    expect(existsSync(join(logsDir(), "catherd-2026-09-18.jsonl"))).toBe(false);
  });
});
