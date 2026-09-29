import { join } from "node:path";
import { cursorAdapter } from "../../src/adapters/cursor/index.ts";
import { runAdapterContract } from "./contract.ts";

const fx = (n: string) => join(import.meta.dir, "..", "fixtures", "adapters", "cursor", n);

// Synthetic, from the docs and the 2026.09.28 bundle (research §2.3; test/fixtures/adapters/cursor/README.md),
// until capture-fixtures records real ones.
runAdapterContract(
  cursorAdapter,
  "cursor:gpt-6-sol#high",
  [
    {
      name: "a run with a read, a write and a command",
      fixture: fx("ok.jsonl"),
      expect: {
        status: "ok",
        thread: "2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21",
        tokens: { input: 15989, cached: 9728, output: 25 },
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
      name: "a resumed chat",
      fixture: fx("resume.jsonl"),
      expect: {
        status: "ok",
        thread: "5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716",
        tokens: { input: 15500, cached: 14000, output: 12 },
      },
    },
    {
      name: "no result event",
      fixture: fx("no-result.jsonl"),
      expect: { status: "failed", thread: "7d6c5b4a-3928-4716-8a5b-4c3d2e1f0a9b" },
    },
    {
      name: "no login",
      fixture: fx("empty.jsonl"),
      stderr:
        "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n",
      expect: { status: "failed", thread: null },
    },
    {
      name: "a usage limit before any assistant turn",
      fixture: fx("no-result.jsonl"),
      stderr: "ActionRequiredError: You've hit your usage limit (PRO_USER_USAGE_LIMIT)\n",
      expect: { status: "limit", thread: "7d6c5b4a-3928-4716-8a5b-4c3d2e1f0a9b" },
    },
    {
      name: "a team policy, which is no limit",
      fixture: fx("empty.jsonl"),
      stderr: "Error: Your team administrator has disabled headless Cursor CLI usage.\n",
      expect: { status: "failed" },
    },
    {
      name: "a CLI too old for a flag",
      fixture: fx("empty.jsonl"),
      stderr: "error: unknown option '--disable-auto-update'\n",
      expect: { status: "cli-too-old" },
    },
    {
      name: "a client the server calls outdated",
      fixture: fx("empty.jsonl"),
      stderr: "ActionRequiredError: OUTDATED_CLIENT\n",
      expect: { status: "cli-too-old" },
    },
  ],
  {
    subcommands: [],
    valueFlags: ["--output-format", "--workspace", "--model", "--mode", "--sandbox", "--resume"],
    thread: "5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716",
  },
);
