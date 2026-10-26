import { checkFailLines } from "./fail-lines.ts";
import { findingKey } from "./run-state.ts";

export const FAILURE_CLASSES = ["product", "harness"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** A failure's identity across repairs: `findingKey` of its first fail line, else of the text's first line. */
export const failureSignature = (text: string): string =>
  findingKey(checkFailLines(text)[0] ?? text.split("\n").find((l) => l.trim()) ?? "");

export const HARNESS_NOTE =
  "This failure is the environment's, not the product's: repair what blocks the check (the tool, the service, the path), change no product code, and say what you fixed.";
