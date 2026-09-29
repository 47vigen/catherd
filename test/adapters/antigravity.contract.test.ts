import { join } from "node:path";
import { antigravityAdapter } from "../../src/adapters/antigravity/index.ts";
import { runAdapterContract } from "./contract.ts";

const fx = (n: string) => join(import.meta.dir, "..", "fixtures", "adapters", "antigravity", n);

// Synthetic but for the logged-out line, from the docs and the 1.2.13 changelog (research §4.4;
// test/fixtures/adapters/antigravity/README.md), until capture-fixtures records real ones.
runAdapterContract(
  antigravityAdapter,
  "antigravity:gemini-3.8-flash#high",
  [
    {
      name: "a SUCCESS result after a read, a write and a command",
      fixture: fx("ok.jsonl"),
      expect: {
        status: "ok",
        thread: "3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c",
        tokens: { input: 25717, cached: 9728, output: 335 },
        reply: "Done.\nSTATUS: complete — wrote src/a.ts",
      },
    },
    {
      name: "a result, then a CLI that lingers until the grace kill (SIGTERM, 143)",
      fixture: fx("ok.jsonl"),
      exitCode: 143,
      expect: { status: "ok", reply: "Done.\nSTATUS: complete — wrote src/a.ts" },
    },
    {
      name: "a resumed conversation",
      fixture: fx("resume.jsonl"),
      expect: {
        status: "ok",
        thread: "7c6b5a49-3928-4716-8a5b-4c3d2e1f0a9b",
        tokens: { input: 14800, cached: 14000, output: 12 },
      },
    },
    {
      name: "an ERROR result with an AGY_ERROR line",
      fixture: fx("error.jsonl"),
      exitCode: 3,
      stderr: 'AGY_ERROR: {"status":"INTERNAL","code":500,"retryable":true,"message":"backend error"}\n',
      expect: { status: "failed", thread: "5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716" },
    },
    {
      name: "a quota stop",
      fixture: fx("error.jsonl"),
      exitCode: 3,
      stderr:
        'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false,"message":"Weekly quota exhausted for Gemini 3.8 Flash."}\n',
      expect: { status: "limit" },
    },
    {
      name: "the sign-in that timed out (logged out)",
      fixture: fx("logged-out.jsonl"),
      stderr:
        "Authentication required. Please visit the URL to log in: https://accounts.google.com/o/oauth2/auth?x\n",
      expect: { status: "failed", thread: null },
    },
    {
      name: "a flag this agy does not know (exit 2)",
      fixture: fx("empty.jsonl"),
      exitCode: 2,
      stderr: "flags provided but not defined: -disable-slash-commands\nUsage of agy:\n",
      expect: { status: "cli-too-old" },
    },
    {
      name: "the partial output of a print timeout (exit 0, no result)",
      fixture: fx("partial.jsonl"),
      exitCode: 0,
      stderr: "warning: print timeout reached; output is partial\n",
      expect: { status: "failed", thread: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" },
    },
  ],
  {
    subcommands: [],
    valueFlags: ["-p", "--output-format", "--model", "--effort", "--conversation"],
    thread: "7c6b5a49-3928-4716-8a5b-4c3d2e1f0a9b",
  },
);
