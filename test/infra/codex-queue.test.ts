import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotEnv, tempDir, withHome } from "../helpers.ts";
import { runCli } from "../../src/adapters/cli.ts";
import type { HostSessionRef } from "../../src/domain/host.ts";
import {
  knownQueueCapability,
  queueCapability,
  queueProbeSettled,
  resetQueueProbe,
  sendToCodexQueue,
} from "../../src/infra/codex-queue.ts";
import { log, logFile } from "../../src/infra/log.ts";
import { simPath, withScenario } from "../sim/scenario.ts";

const thread = "01a0f53b-a47d-7350-83a4-c3430e453404";
const msgId = "01a0f547-7947-7972-90a0-a7ad547170e0";
const target: HostSessionRef = { host: "codex", sessionId: thread, hostSessionId: null, name: null };
const help = {
  ok: true,
  out: "Usage: codex queue --thread <THREAD> --message <MESSAGE>\n  --remote <URL>",
  err: "",
};
const receipt = { ok: true, out: `Queued message ${msgId} for thread ${thread}.\n`, err: "" };

afterEach(snapshotEnv());
afterEach(resetQueueProbe);

function runner(result: Awaited<ReturnType<typeof runCli>>) {
  const calls: Parameters<typeof runCli>[] = [];
  const run: typeof runCli = async (...args) => {
    calls.push(args);
    return args[1].includes("--help") ? help : result;
  };
  return { run, calls };
}

describe("the queue capability peek and status read", () => {
  it("never waits on the CLI: answers unchecked, then the cached probe, refreshed in the background", async () => {
    // the cache is per process: another file's peek may have filled it
    await resetQueueProbe();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let probes = 0;
    const run: typeof runCli = async () => {
      probes++;
      await gate;
      return help;
    };
    expect(knownQueueCapability({}, run, 0)).toMatchObject({ cli: false, server: "unverified" });
    expect(knownQueueCapability({}, run, 1).reason).toContain("being checked");
    expect(probes).toBe(1);
    release();
    await queueProbeSettled();
    expect(knownQueueCapability({}, run, 2)).toMatchObject({ cli: true });
    expect(probes).toBe(1);
    // a stale answer is still returned at once while one fresh probe runs behind it
    expect(knownQueueCapability({}, run, 60_000)).toMatchObject({ cli: true });
    expect(probes).toBe(2);
  });
});

describe("native Codex queue", () => {
  it("queue_payload_logging: delivers literal content without retaining it in debug rows", async () => {
    withHome();
    process.env.CATHERD_LOG = "debug";
    process.env.PATH = simPath();
    const envTo = join(tempDir("catherd-queue-"), "calls.jsonl");
    const s = withScenario({ queue: "accepted", envTo });
    const content = `private-completion-sentinel ' " $(never-run)\nsource and user content`;
    expect(
      await sendToCodexQueue(target, content, { ...s.env, PATH: process.env.PATH, ANTHROPIC_API_KEY: "" }),
    ).toEqual({ outcome: "accepted", msgId });
    const calls = readFileSync(envTo, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls[1].args).toEqual(["queue", "--remote", "unix://", "--thread", thread, "--message", content]);
    const rows = readFileSync(logFile(), "utf8");
    expect(rows).toContain('"argv":["codex","queue","--help"]');
    expect(rows).toContain('"--message"');
    expect(rows).not.toContain("private-completion-sentinel");
    expect(rows).not.toContain("source and user content");
  });

  it("queue_payload_logging: omits completion content from timeout diagnostics", async () => {
    withHome();
    process.env.CATHERD_LOG = "debug";
    const content = "private-timeout-sentinel source and user content";
    let diagnostic = "";
    const run: typeof runCli = async (_bin, args, options) => {
      if (args.includes("--help")) return help;
      const result = await runCli(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], {
        ...options,
        timeoutMs: 100,
        env: { ...options.env, ANTHROPIC_API_KEY: "" },
      });
      diagnostic = result?.err ?? "";
      log("warn", "queue-timeout", { diagnostic });
      return result;
    };
    expect((await sendToCodexQueue(target, content, {}, run)).outcome).toBe("ambiguous");
    expect(diagnostic).toContain("timed out after 100 ms");
    expect(diagnostic).not.toContain(content);
    expect(readFileSync(logFile(), "utf8")).not.toContain("private-timeout-sentinel");
  });

  it("validated_uuid_array: passes text literally and keeps original UUID", async () => {
    const r = runner(receipt);
    const content = `quotes ' " $(touch /tmp/never)\nsecond line`;
    expect(await sendToCodexQueue(target, content, {}, r.run)).toEqual({ outcome: "accepted", msgId });
    expect(r.calls[1]?.slice(0, 2)).toEqual([
      "codex",
      ["queue", "--remote", "unix://", "--thread", thread, "--message", content],
    ]);
    expect(r.calls.every((c) => c[2].timeoutMs > 0 && c[2].timeoutMs <= 10000)).toBe(true);
  });

  it("invalid and non-Codex targets never invoke a process", async () => {
    const r = runner(receipt);
    for (const invalid of [
      { ...target, sessionId: "invalid" },
      { ...target, host: "claude-code" as const },
      { ...target, sessionId: thread + "\n" },
    ])
      expect((await sendToCodexQueue(invalid, "completion", {}, r.run)).outcome).toBe("not-submitted");
    expect(r.calls).toHaveLength(0);
  });

  it("preserves_native_env: scrubs identity after merging the parent environment", async () => {
    const r = runner(receipt);
    const before = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = thread;
    try {
      await sendToCodexQueue(
        target,
        "completion",
        {
          HOME: "/native/home",
          CODEX_HOME: "/native/codex",
          OPENAI_API_KEY: "vendor-test-key",
          CODEX_SESSION_ID: thread,
          CATHERD_ORCHESTRATION_HOST: "codex",
          CLAUDE_CODE_MESSAGING_TOKEN: "never-child",
        },
        r.run,
      );
      const env = r.calls[1]?.[2].env;
      expect(env).toMatchObject({
        HOME: "/native/home",
        CODEX_HOME: "/native/codex",
        OPENAI_API_KEY: "vendor-test-key",
      });
      for (const key of [
        "CODEX_THREAD_ID",
        "CODEX_SESSION_ID",
        "CATHERD_ORCHESTRATION_HOST",
        "CLAUDE_CODE_MESSAGING_TOKEN",
      ])
        expect(env).not.toHaveProperty(key);
    } finally {
      if (before === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = before;
    }
  });

  it("queue_missing: unsupported CLI or remote binding cannot submit", async () => {
    for (const result of [
      null,
      { ok: false, out: "", err: "error: unrecognized subcommand 'queue'" },
      { ok: true, out: "Usage: codex queue --thread --message", err: "" },
    ]) {
      const calls: string[][] = [];
      const run: typeof runCli = async (_bin, args) => {
        calls.push(args);
        return result;
      };
      expect((await queueCapability({}, run)).cli).toBe(false);
      expect((await sendToCodexQueue(target, "completion", {}, run)).outcome).toBe("not-submitted");
      expect(calls.every((args) => args.includes("--help"))).toBe(true);
    }
  });

  it("capability sends no marker and reports absent server enumeration as unverified", async () => {
    const r = runner(receipt);
    expect(await queueCapability({}, r.run)).toMatchObject({ cli: true, server: "unverified" });
    expect(r.calls.map((c) => c[1])).toEqual([["queue", "--help"]]);
  });

  it("server_unsupported: explicit native method refusal proves non-submission", async () => {
    const r = runner({
      ok: false,
      out: "",
      err: "Error: the remote app server does not support thread/queue/add; update or restart the remote app server",
    });
    expect((await sendToCodexQueue(target, "completion", {}, r.run)).outcome).toBe("not-submitted");
  });

  it("native pre-submission parser and connection refusals remain retryable", async () => {
    for (const err of [
      "error: unrecognized subcommand 'queue'\n",
      "error: unexpected argument '--remote' found\n",
      "Error: failed to connect to remote app server at `unix:///native/control.sock`: Connection refused (os error 61)\n",
    ])
      expect(
        (await sendToCodexQueue(target, "completion", {}, runner({ ok: false, out: "", err }).run)).outcome,
      ).toBe("not-submitted");
  });

  it("retains original uppercase UUID but matches native canonical UUID", async () => {
    const r = runner(receipt);
    expect(
      await sendToCodexQueue({ ...target, sessionId: thread.toUpperCase() }, "completion", {}, r.run),
    ).toEqual({ outcome: "accepted", msgId });
    expect(r.calls[1]?.[1][4]).toBe(thread.toUpperCase());
  });

  it("uncertain_receipt: malformed, duplicate, mismatched and failed invocations remain ambiguous", async () => {
    for (const result of [
      { ...receipt, out: "Queued message invalid for thread " + thread + "." },
      { ...receipt, out: receipt.out + receipt.out },
      { ...receipt, out: `Queued message ${msgId} for thread ${msgId}.` },
      { ...receipt, out: "" },
      { ...receipt, out: "prefix " + receipt.out },
      { ...receipt, out: receipt.out.toLowerCase() },
      {
        ok: false,
        out: receipt.out,
        err: "Error: the remote app server does not support thread/queue/add; update or restart the remote app server",
      },
      { ok: false, out: "", err: "timed out after 10000 ms" },
      { ok: false, out: "", err: "unknown delivery failure with token=never-record" },
    ]) {
      const got = await sendToCodexQueue(target, "completion", {}, runner(result).run);
      expect(got.outcome).toBe("ambiguous");
      expect(JSON.stringify(got)).not.toContain("never-record");
    }
    const throwing: typeof runCli = async (_bin, args) => {
      if (args.includes("--help")) return help;
      throw new Error("spawn failed");
    };
    expect((await sendToCodexQueue(target, "completion", {}, throwing)).outcome).toBe("ambiguous");
  });

  it("uses the simulator for literal native argv and malformed output", async () => {
    const envTo = join(tempDir("catherd-queue-"), "calls.jsonl");
    const before = process.env.PATH;
    process.env.PATH = simPath();
    try {
      const content = `completion ' " $(never-run)\nsecond line`;
      for (const [queue, outcome] of [
        ["accepted", "accepted"],
        ["malformed", "ambiguous"],
      ] as const) {
        const s = withScenario({ queue, envTo });
        expect((await sendToCodexQueue(target, content, { ...s.env, PATH: simPath() })).outcome).toBe(
          outcome,
        );
      }
      const calls = readFileSync(envTo, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.map((c) => c.args)).toEqual([
        ["queue", "--help"],
        ["queue", "--remote", "unix://", "--thread", thread, "--message", content],
        ["queue", "--help"],
        ["queue", "--remote", "unix://", "--thread", thread, "--message", content],
      ]);
      expect(calls.every((c) => !c.envKeys.includes("CODEX_THREAD_ID"))).toBe(true);
    } finally {
      if (before === undefined) delete process.env.PATH;
      else process.env.PATH = before;
    }
  });
});
