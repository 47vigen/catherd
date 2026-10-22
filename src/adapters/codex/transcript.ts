import type { TranscriptItem } from "../../domain/transcript.ts";
import { parseCodexLine } from "./events.ts";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The text parts of an MCP result, joined; null when there are none. */
function mcpText(result: any): string | null {
  const parts: unknown[] = Array.isArray(result?.content) ? result.content : [];
  const text = parts
    .map((p: any) => (p?.type === "text" ? str(p.text) : ""))
    .filter(Boolean)
    .join("\n");
  return text || null;
}

/** A codex exec JSON line as transcript items (none for a record that says nothing). */
export function codexTranscript(line: string, n: number): TranscriptItem[] {
  const e = parseCodexLine(line);
  if (!e) return [{ kind: "raw", line: n, text: line }];
  const t = str(e.type);
  if (t === "thread.started" || t === "turn.started") return [];
  if (t === "turn.completed") {
    const u = e.usage;
    return [
      {
        kind: "turn",
        line: n,
        tokens: u
          ? { input: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0, output: u.output_tokens ?? 0 }
          : null,
        costUsd: null,
      },
    ];
  }
  if (t === "turn.failed") return [{ kind: "error", line: n, text: str(e.error?.message) || "turn failed" }];
  if (t === "error") return [{ kind: "error", line: n, text: str(e.message) || "error" }];
  const it = e.item;
  if (!t.startsWith("item.") || !it || typeof it !== "object") return [{ kind: "raw", line: n, text: line }];
  const id = str(it.id);
  switch (it.type) {
    case "agent_message":
      return [{ kind: "text", line: n, text: str(it.text) }];
    case "reasoning":
      return [{ kind: "thinking", line: n, text: str(it.text) }];
    case "command_execution":
      return [
        {
          kind: "shell",
          line: n,
          id,
          command: str(it.command),
          output: str(it.aggregated_output) || null,
          exit: Number.isInteger(it.exit_code) ? it.exit_code : null,
        },
      ];
    case "file_change":
      return [
        {
          kind: "file",
          line: n,
          id,
          changes: (Array.isArray(it.changes) ? it.changes : []).map((c: any) => ({
            path: str(c?.path),
            kind: str(c?.kind),
          })),
          diff: null,
        },
      ];
    case "mcp_tool_call":
      return [
        {
          kind: "tool",
          line: n,
          id,
          name: `${str(it.server)}.${str(it.tool)}`,
          input: JSON.stringify(it.arguments ?? {}),
          output: mcpText(it.result),
          error: !!it.error,
        },
      ];
    case "web_search":
      return [
        { kind: "tool", line: n, id, name: "web_search", input: str(it.query), output: null, error: false },
      ];
    case "error":
      return [{ kind: "error", line: n, text: str(it.message) || "error" }];
    default:
      return [{ kind: "raw", line: n, text: line }];
  }
}
