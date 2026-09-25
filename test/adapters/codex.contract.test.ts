import { join } from "node:path";
import { codexAdapter } from "../../src/adapters/codex/index.ts";
import { runAdapterContract } from "./contract.ts";

const fx = (n: string) => join(import.meta.dir, "..", "fixtures", "adapters", "codex", n);

runAdapterContract(codexAdapter, "codex:gpt-6-sol#medium", [
  {
    name: "a run with a reconnect",
    fixture: fx("ok-with-reconnect.jsonl"),
    expect: {
      status: "ok",
      thread: "01a0d0d4-d0a6-71a1-983c-82a9169200b4",
      tokens: { input: 898388, cached: 788992, output: 5341 },
    },
  },
  {
    name: "two turns",
    fixture: fx("two-turns.jsonl"),
    expect: { status: "ok", tokens: { input: 300, cached: 190, output: 30 } },
  },
  {
    name: "a failed turn",
    fixture: fx("turn-failed.jsonl"),
    reply: "",
    expect: { status: "failed", thread: "t-failed" },
  },
  {
    name: "a usage limit",
    fixture: fx("limit.jsonl"),
    reply: "",
    expect: { status: "limit", thread: "t-limit" },
  },
]);
