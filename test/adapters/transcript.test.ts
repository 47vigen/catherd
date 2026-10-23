import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeTranscript } from "../../src/adapters/claude-code/transcript.ts";
import { codexTranscript } from "../../src/adapters/codex/transcript.ts";
import { TranscriptItemSchema, type TranscriptItem } from "../../src/domain/transcript.ts";

const FX = join(import.meta.dir, "..", "fixtures", "transcript");
const read = (n: string): string => readFileSync(join(FX, n), "utf8");
const all = (n: string, f: (l: string, i: number) => TranscriptItem[]): TranscriptItem[] =>
  read(n)
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l, i) => f(l, i));
const kinds = <K extends TranscriptItem["kind"]>(items: TranscriptItem[], k: K) =>
  items.filter((i): i is Extract<TranscriptItem, { kind: K }> => i.kind === k);
const j = (o: unknown): string => JSON.stringify(o);

describe("codex transcript", () => {
  it("a command, a file change, an MCP call, a message and the turn's tokens", () => {
    const items = all("codex-worker.jsonl", codexTranscript);
    for (const i of items) TranscriptItemSchema.parse(i);
    expect(kinds(items, "shell").some((s) => s.exit === 0 && s.output)).toBe(true);
    expect(kinds(items, "file").some((f) => f.changes.length === 2 && f.diff === null)).toBe(true);
    const tool = kinds(items, "tool").find((t) => t.name === "catherd_role.read_run_file");
    expect(tool?.input).toContain("lanes/M1.L1.md");
    expect(kinds(items, "tool").some((t) => t.output?.includes("M1.L1"))).toBe(true);
    expect(kinds(items, "text").length).toBeGreaterThan(0);
    expect(kinds(items, "turn")[0]?.tokens).toEqual({ input: 1338336, cached: 1269504, output: 10630 });
  });

  it("started and completed items share the id", () => {
    const shells = kinds(all("codex-worker.jsonl", codexTranscript), "shell").filter(
      (s) => s.id === "item_9",
    );
    expect(shells).toHaveLength(2);
    expect(shells[0]?.output).toBeNull();
    expect(shells[1]?.output).toBeTruthy();
  });

  it("an error item and turn.failed are errors", () => {
    const err = codexTranscript(
      j({ type: "item.completed", item: { id: "i", type: "error", message: "boom" } }),
      3,
    );
    expect(err).toEqual([{ kind: "error", line: 3, text: "boom" }]);
    const failed = codexTranscript(j({ type: "turn.failed", error: { message: "usage limit" } }), 4);
    expect(failed).toEqual([{ kind: "error", line: 4, text: "usage limit" }]);
    expect(codexTranscript(j({ type: "error", message: "gone" }), 5)[0]?.kind).toBe("error");
  });

  it("thread and turn starts are left out; reasoning and web search are items", () => {
    expect(codexTranscript(j({ type: "thread.started", thread_id: "t" }), 0)).toEqual([]);
    expect(codexTranscript(j({ type: "turn.started" }), 0)).toEqual([]);
    expect(
      codexTranscript(j({ type: "item.completed", item: { id: "r", type: "reasoning", text: "hmm" } }), 1),
    ).toEqual([{ kind: "thinking", line: 1, text: "hmm" }]);
    expect(
      codexTranscript(j({ type: "item.started", item: { id: "w", type: "web_search", query: "bun" } }), 2),
    ).toEqual([
      { kind: "tool", line: 2, id: "w", name: "web_search", input: "bun", output: null, error: false },
    ]);
  });

  it("a line that is not JSON is raw", () => {
    expect(codexTranscript("plain text", 7)).toEqual([{ kind: "raw", line: 7, text: "plain text" }]);
  });
});

describe("claude transcript", () => {
  it("thinking, a Bash call, its output, text and the run's cost", () => {
    const items = all("claude-architect.jsonl", claudeTranscript);
    for (const i of items) TranscriptItemSchema.parse(i);
    expect(kinds(items, "thinking").length).toBeGreaterThan(0);
    const sh = kinds(items, "shell")[0];
    expect(sh?.command).toContain("catherd run-file read");
    const out = kinds(items, "output").find((o) => o.id === sh?.id);
    expect(out?.text).toContain("Case helpers");
    expect(out?.error).toBe(false);
    expect(kinds(items, "text").length).toBeGreaterThan(0);
    expect(kinds(items, "turn")[0]?.costUsd).toBe(0.6874738000000001);
    const tokens = {
      input: 8 + 75348 + 219089,
      cached: 219089,
      cacheWrite: 75348,
      output: 2042,
    };
    expect(kinds(items, "turn")[0]?.tokens).toEqual(tokens);
    expect(items.some((i) => i.kind === "raw")).toBe(false);
  });

  it("an Edit is a file change with a diff", () => {
    const line = j({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Edit",
            input: { file_path: "a.ts", old_string: "old", new_string: "new" },
          },
        ],
      },
    });
    const [item] = claudeTranscript(line, 9);
    if (item?.kind !== "file") throw new Error("not a file");
    expect(item.id).toBe("t1");
    expect(item.changes).toEqual([{ path: "a.ts", kind: "update" }]);
    expect(item.diff).toContain("--- a/a.ts");
    expect(item.diff).toContain("+++ b/a.ts");
    expect(item.diff).toContain("-old");
    expect(item.diff).toContain("+new");
  });

  it("a Write is every line added, cut at 400 lines", () => {
    const content = Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n");
    const line = j({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: "a.ts", content } }],
      },
    });
    const [item] = claudeTranscript(line, 0);
    if (item?.kind !== "file") throw new Error("not a file");
    expect(item.changes[0]?.kind).toBe("add");
    expect(item.diff?.split("\n").filter((l) => l.startsWith("+l"))).toHaveLength(400);
  });

  it("other tools keep their input; an errored result is an error output", () => {
    const use = j({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "g", name: "Grep", input: { pattern: "x" } }] },
    });
    expect(claudeTranscript(use, 0)).toEqual([
      { kind: "tool", line: 0, id: "g", name: "Grep", input: '{"pattern":"x"}', output: null, error: false },
    ]);
    const res = j({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "g",
            is_error: true,
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
      },
    });
    expect(claudeTranscript(res, 1)).toEqual([
      { kind: "output", line: 1, id: "g", text: "a\nb", error: true },
    ]);
  });

  it("hook and init records are left out, an api_retry is an error", () => {
    for (const subtype of [
      "init",
      "hook_started",
      "hook_response",
      "hook_progress",
      "task_summary",
      "thinking_tokens",
      "informational",
      "post_turn_summary",
    ])
      expect(claudeTranscript(j({ type: "system", subtype }), 0)).toEqual([]);
    expect(claudeTranscript(j({ type: "system", subtype: "api_retry", error: "overloaded" }), 2)).toEqual([
      { kind: "error", line: 2, text: "retrying: overloaded" },
    ]);
    expect(
      claudeTranscript(j({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }), 3),
    ).toEqual([]);
    expect(
      claudeTranscript(j({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }), 3)[0]?.kind,
    ).toBe("error");
  });

  it("an errored result is a turn and an error", () => {
    const items = claudeTranscript(
      j({ type: "result", is_error: true, result: "bad", total_cost_usd: 1, usage: {} }),
      4,
    );
    expect(items.map((i) => i.kind)).toEqual(["turn", "error"]);
  });

  it("a line that is not JSON is raw", () => {
    expect(claudeTranscript("oops", 1)).toEqual([{ kind: "raw", line: 1, text: "oops" }]);
    expect(claudeTranscript(j({ type: "mystery" }), 1)[0]?.kind).toBe("raw");
  });
});

it("the fixtures hold no home path", () => {
  for (const n of ["codex-worker.jsonl", "claude-architect.jsonl"]) expect(read(n)).not.toContain("/Users/");
});
