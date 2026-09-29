import { join } from "node:path";
import { grokAdapter, sessionFor } from "../../src/adapters/grok/index.ts";
import { runAdapterContract } from "./contract.ts";

const fx = (n: string) => join(import.meta.dir, "..", "fixtures", "adapters", "grok", n);
const SESSION = "3c9a2f1e-7b4d-4e8a-9f60-1d2c3b4a5e6f";

// Synthetic, from grok 1.0.44's user guide and binary (research §3.3, §3.10; test/fixtures/adapters/grok/README.md),
// until capture-fixtures records real ones.
runAdapterContract(
  grokAdapter,
  "grok:grok-4.6#high",
  [
    {
      name: "end_turn after a read, an edit and a command, on an API key (cost reported)",
      fixture: fx("ok.jsonl"),
      expect: {
        status: "ok",
        thread: SESSION,
        tokens: { input: 48210, cached: 41000, output: 1893 },
        reply: "Done.\nSTATUS: complete — wrote src/a.ts",
      },
    },
    {
      name: "an end, then a CLI draining uploads until the grace kill (SIGTERM, 143)",
      fixture: fx("ok.jsonl"),
      exitCode: 143,
      expect: { status: "ok", reply: "Done.\nSTATUS: complete — wrote src/a.ts" },
    },
    {
      name: "end_turn on a Grok login (no cost)",
      fixture: fx("login-ok.jsonl"),
      expect: { status: "ok", tokens: { input: 812, cached: 0, output: 45 } },
    },
    {
      name: "a resumed session",
      fixture: fx("resume.jsonl"),
      expect: { status: "ok", thread: SESSION, tokens: { input: 32000, cached: 30000, output: 20 } },
    },
    {
      name: "max turns reached",
      fixture: fx("max-turns.jsonl"),
      expect: { status: "failed", thread: "5e1c4f30-9d6f-4a0c-b182-3f4e5d6c7a81" },
    },
    {
      // grok saved a session under catherd's -s id before it failed: the record keeps it to resume
      name: "an error with no end",
      fixture: fx("no-end.jsonl"),
      expect: { status: "failed", thread: sessionFor({ dispatchDir: "/d" }) },
    },
    { name: "not signed in", fixture: fx("not-signed-in.jsonl"), expect: { status: "failed", thread: null } },
    { name: "a plan's rate limit", fixture: fx("rate-limit.jsonl"), expect: { status: "limit" } },
    { name: "the free usage limit", fixture: fx("free-limit.jsonl"), expect: { status: "limit" } },
    {
      name: "no Grok subscription, which is no limit",
      fixture: fx("subscription.jsonl"),
      expect: { status: "failed" },
    },
    {
      name: "a CLI too old for a flag (clap, exit 2)",
      fixture: fx("empty.jsonl"),
      exitCode: 2,
      stderr: "error: unexpected argument '--no-memory' found\n\nUsage: grok [OPTIONS]\n",
      expect: { status: "cli-too-old" },
    },
  ],
  {
    subcommands: [],
    valueFlags: [
      "--prompt-file",
      "--output-format",
      "--cwd",
      "-m",
      "--effort",
      "--sandbox",
      "--tools",
      "-s",
      "-r",
    ],
    thread: SESSION,
  },
);
