import type { TranscriptItem } from "../../domain/transcript.ts";
import { claudeTokens, parseClaudeLine } from "./events.ts";

type Rec = Record<string, any>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const SILENT = new Set(["init", "task_summary", "thinking_tokens", "informational", "post_turn_summary"]);
const WRITE_LINES = 400;

const hunk = (path: string, old: string, next: string): string[] => [
  `--- a/${path}`,
  `+++ b/${path}`,
  ...(old ? old.split("\n").map((l) => `-${l}`) : []),
  ...(next ? next.split("\n").map((l) => `+${l}`) : []),
];

/** A file-editing tool call as a `file` item with its diff; null for a tool that is not one. */
function fileItem(c: Rec, n: number): TranscriptItem | null {
  const input: Rec = c.input ?? {};
  const path = str(input.file_path) || str(input.notebook_path);
  const file = (kind: string, diff: string[]): TranscriptItem => ({
    kind: "file",
    line: n,
    id: str(c.id),
    changes: [{ path, kind }],
    diff: diff.join("\n"),
  });
  switch (c.name) {
    case "Edit":
      return file("update", hunk(path, str(input.old_string), str(input.new_string)));
    case "MultiEdit": {
      const edits: Rec[] = Array.isArray(input.edits) ? input.edits : [];
      const body = edits.flatMap((x) => hunk(path, str(x.old_string), str(x.new_string)).slice(2));
      return file("update", [`--- a/${path}`, `+++ b/${path}`, ...body]);
    }
    case "Write": {
      const lines = str(input.content).split("\n");
      return file("add", [
        `--- /dev/null`,
        `+++ b/${path}`,
        ...lines.slice(0, WRITE_LINES).map((l) => `+${l}`),
      ]);
    }
    case "NotebookEdit":
      return file("update", hunk(path, "", str(input.new_source)));
    default:
      return null;
  }
}

function assistant(e: Rec, n: number): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const c of (Array.isArray(e.message?.content) ? e.message.content : []) as Rec[]) {
    if (c.type === "text") out.push({ kind: "text", line: n, text: str(c.text) });
    else if (c.type === "thinking") out.push({ kind: "thinking", line: n, text: str(c.thinking) });
    else if (c.type === "tool_use") {
      if (c.name === "Bash")
        out.push({
          kind: "shell",
          line: n,
          id: str(c.id),
          command: str(c.input?.command),
          output: null,
          exit: null,
        });
      else
        out.push(
          fileItem(c, n) ?? {
            kind: "tool",
            line: n,
            id: str(c.id),
            name: str(c.name),
            input: JSON.stringify(c.input ?? {}),
            output: null,
            error: false,
          },
        );
    } else out.push({ kind: "raw", line: n, text: JSON.stringify(c) });
  }
  return out;
}

function toolResults(e: Rec, n: number): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const c of (Array.isArray(e.message?.content) ? e.message.content : []) as Rec[]) {
    if (c.type !== "tool_result") continue;
    const text = Array.isArray(c.content)
      ? c.content
          .map((p: Rec) => (p?.type === "text" ? str(p.text) : ""))
          .filter(Boolean)
          .join("\n")
      : str(c.content);
    out.push({ kind: "output", line: n, id: str(c.tool_use_id), text, error: c.is_error === true });
  }
  return out;
}

/** A Claude Code stream-json line as transcript items (none for a record that says nothing). */
export function claudeTranscript(line: string, n: number): TranscriptItem[] {
  const e = parseClaudeLine(line);
  if (!e) return [{ kind: "raw", line: n, text: line }];
  switch (e.type) {
    case "system": {
      const s = str(e.subtype);
      if (s === "api_retry") return [{ kind: "error", line: n, text: `retrying: ${str(e.error)}` }];
      if (SILENT.has(s) || s.startsWith("hook_")) return [];
      return [{ kind: "raw", line: n, text: line }];
    }
    case "assistant":
      return assistant(e, n);
    case "user":
      return toolResults(e, n);
    case "result": {
      const turn: TranscriptItem = {
        kind: "turn",
        line: n,
        tokens: e.usage ? claudeTokens(e.usage) : null,
        costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null,
      };
      return e.is_error === true
        ? [turn, { kind: "error", line: n, text: str(e.result) || "the run failed" }]
        : [turn];
    }
    case "rate_limit_event":
      return e.rate_limit_info?.status === "rejected"
        ? [{ kind: "error", line: n, text: "rate limit reached" }]
        : [];
    default:
      return [{ kind: "raw", line: n, text: line }];
  }
}
