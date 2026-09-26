import { join } from "node:path";
import { opencodeAdapter } from "../../src/adapters/opencode/index.ts";
import { runAdapterContract } from "./contract.ts";

const fx = (n: string) => join(import.meta.dir, "..", "fixtures", "adapters", "opencode", n);

runAdapterContract(
  opencodeAdapter,
  "opencode:opencode-go/kimi-k3#max",
  [
    {
      name: "a real one-step run with no step_finish (v2.0.16)",
      fixture: fx("ok-simple.jsonl"),
      expect: {
        status: "ok",
        thread: "ses_f2679cc68ffeAfP2dtLA9zEfTh",
        tokens: { input: 0, cached: 0, output: 0 },
        reply: "hello",
      },
    },
    {
      name: "a real shell run, whose reply is only its last message",
      fixture: fx("shell-ok.jsonl"),
      expect: {
        status: "ok",
        tokens: { input: 6505, cached: 488, output: 41 },
        reply: "The command ran successfully and output `listed`.\n\nDONE",
      },
    },
    {
      name: "a real read-tools run",
      fixture: fx("explore-tools.jsonl"),
      expect: { status: "ok", tokens: { input: 3819, cached: 2126, output: 208 } },
    },
    {
      name: "a real read-only run whose shell writes catherd-ro denied (captured by capture-fixtures)",
      fixture: fx("ro-denied.jsonl"),
      expect: {
        status: "ok",
        thread: "ses_f25cce757ffeuCuTOuMgD5Lyp0",
        tokens: { input: 4271, cached: 2419, output: 170 },
      },
    },
    {
      name: "a real permission rejection",
      fixture: fx("permission-rejected.jsonl"),
      expect: { status: "failed", thread: "ses_f2678655effeAm9kDg83ifWGK3" },
    },
    {
      name: "a real interrupt by another client",
      fixture: fx("interrupted.jsonl"),
      expect: { status: "failed" },
    },
    {
      name: "an unknown variant whose CLI exits 0",
      fixture: fx("variant-unavailable.jsonl"),
      exitCode: 0,
      expect: { status: "failed" },
    },
    { name: "a Go quota", fixture: fx("quota.jsonl"), expect: { status: "limit" } },
    { name: "a rate limit", fixture: fx("rate-limit.jsonl"), expect: { status: "limit" } },
    {
      name: "opencode v1 given a v2 model reference",
      fixture: fx("v1-model-hash-error.jsonl"),
      expect: { status: "cli-too-old" },
    },
  ],
  {
    subcommands: ["run"],
    valueFlags: ["--format", "--agent", "-m", "-s"],
    thread: "ses_f2671cde4ffe4VbeG6dKWzM2vi",
  },
);
