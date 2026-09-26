import { join } from "node:path";
import { claudeCodeAdapter } from "../../src/adapters/claude-code/index.ts";
import { runAdapterContract } from "./contract.ts";

const fx = (n: string) => join(import.meta.dir, "..", "fixtures", "adapters", "claude-code", n);

runAdapterContract(
  claudeCodeAdapter,
  "claude-code:claude-sonnet-5#high",
  [
    {
      name: "a real run (claude 2.1.282, Haiku 4.5)",
      fixture: fx("ok.jsonl"),
      expect: {
        status: "ok",
        thread: "6b1f7c1e-2f7d-4a55-9d7e-1c2b3a4d5e6f",
        tokens: { input: 28359, cached: 23469, output: 41 },
        reply: "hello",
      },
    },
    {
      name: "a real read-only run whose write was denied",
      fixture: fx("read-only-write.jsonl"),
      expect: { status: "ok", tokens: { input: 92356, cached: 61157, output: 811 } },
    },
    {
      name: "a real resumed run",
      fixture: fx("resume.jsonl"),
      expect: { status: "ok", thread: "670d1ec2-db2b-471f-a1a5-3cda1416c061", reply: "pong" },
    },
    {
      name: "a real model error whose CLI exits 0",
      fixture: fx("model-error.jsonl"),
      exitCode: 0,
      expect: { status: "failed", thread: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a" },
    },
    {
      name: "a usage limit",
      fixture: fx("limit.jsonl"),
      expect: { status: "limit", thread: "4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d" },
    },
    {
      name: "an API retry, then success",
      fixture: fx("retry.jsonl"),
      expect: { status: "ok", tokens: { input: 20912, cached: 20000, output: 14 } },
    },
    {
      name: "a CLI too old for a flag",
      fixture: fx("too-old.jsonl"),
      stderr: "error: unknown option '--permission-prompts'\n",
      expect: { status: "cli-too-old" },
    },
  ],
  {
    subcommands: [],
    valueFlags: [
      "--output-format",
      "--model",
      "--effort",
      "--session-id",
      "--resume",
      "--permission-prompts",
      "--permission-mode",
      "--allowedTools",
      "--disallowedTools",
    ],
    thread: "670d1ec2-db2b-471f-a1a5-3cda1416c061",
  },
);
