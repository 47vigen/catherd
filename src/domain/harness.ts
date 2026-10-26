import { checkFailLines } from "./fail-lines.ts";

/** A finding's identity across rounds: its file and its first words, without line numbers (t3herd `findingKey`); run-state.ts re-exports it. */
export const findingKey = (f: string): string =>
  f
    .replace(/^[\W\d]*(BLOCKER|BUG)\**\s*/i, "")
    .replace(/:\d+(-\d+)?/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9/._ ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");

export const FAILURE_CLASSES = ["product", "harness"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** A failure's identity across repairs: `findingKey` of its first fail line, else of the text's first line. */
export const failureSignature = (text: string): string =>
  findingKey(checkFailLines(text)[0] ?? text.split("\n").find((l) => l.trim()) ?? "");

export const HARNESS_NOTE =
  "This failure is the environment's, not the product's: repair what blocks the check (the tool, the service, the path), change no product code, and say what you fixed.";
