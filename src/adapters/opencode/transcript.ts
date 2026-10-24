import type { TranscriptItem } from "../../domain/transcript.ts";
import { opencodeTokens, parseOpencodeLine } from "./events.ts";

type Rec = Record<string, any>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const WRITE_LINES = 400;

const hunk = (path: string, old: string, next: string): string[] => [
  `--- a/${path}`,
  `+++ b/${path}`,
  ...(old ? old.split("\n").map((l) => `-${l}`) : []),
  ...(next ? next.split("\n").map((l) => `+${l}`) : []),
];

/** The tool_use part as one item; shell, edit and write get their own cards. */
function toolItem(part: Rec, n: number): TranscriptItem {
  const s: Rec = part.state;
  const input: Rec = s.input ?? {};
  const id = str(part.id);
  const errored = s.status === "error";
  const path = str(input.filePath) || str(input.path);
  const output = str(s.output) || (errored ? str(s.error) : "") || null;
  if (part.tool === "bash") {
    const exit = s.metadata?.metadata?.exit;
    return {
      kind: "shell",
      line: n,
      id,
      command: str(input.command),
      output,
      exit: Number.isInteger(exit) ? exit : errored ? 1 : null,
    };
  }
  if (!errored && part.tool === "edit") {
    const patch = str(s.metadata?.metadata?.files?.[0]?.patch);
    return {
      kind: "file",
      line: n,
      id,
      changes: [{ path, kind: "update" }],
      diff: patch ? patch : hunk(path, str(input.oldString), str(input.newString)).join("\n"),
    };
  }
  if (!errored && part.tool === "write") {
    const lines = str(input.content).split("\n").slice(0, WRITE_LINES);
    return {
      kind: "file",
      line: n,
      id,
      changes: [{ path, kind: "add" }],
      diff: ["--- /dev/null", `+++ b/${path}`, ...lines.map((l) => `+${l}`)].join("\n"),
    };
  }
  return {
    kind: "tool",
    line: n,
    id,
    name: str(part.tool),
    input: JSON.stringify(input),
    output,
    error: errored,
  };
}

/** An opencode v2 JSON line as transcript items (none for a step start). */
export function opencodeTranscript(line: string, n: number): TranscriptItem[] {
  const e = parseOpencodeLine(line);
  const raw: TranscriptItem[] = [{ kind: "raw", line: n, text: line }];
  if (!e) return raw;
  const part: Rec = e.part ?? {};
  switch (e.type) {
    case "step_start":
      return [];
    case "text":
      return [{ kind: "text", line: n, text: str(part.text) }];
    case "tool_use":
      return part.state && typeof part.state === "object" ? [toolItem(part, n)] : raw;
    case "step_finish": {
      if (part.reason === "tool-calls") return [];
      const t = opencodeTokens(part.tokens);
      return [
        {
          kind: "turn",
          line: n,
          tokens: { input: t.input, cached: t.cached, output: t.output },
          costUsd: typeof part.cost === "number" && part.cost > 0 ? part.cost : null,
        },
      ];
    }
    case "error":
      return [{ kind: "error", line: n, text: str(e.error?.message) || str(e.error?.type) || "error" }];
    default:
      return raw;
  }
}
