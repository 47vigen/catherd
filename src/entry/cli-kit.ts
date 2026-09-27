import { type CatherdError, isCatherdError } from "../domain/errors.ts";
import { RUN_NOT_FOUND_FIX } from "../services/run-store.ts";
import { glyph, type State } from "./glyphs.ts";

/** Spec §8: 0 ok, 1 error, 2 usage, 3 not ready (doctor), 130 interrupted. */
export const EXIT = { ok: 0, error: 1, usage: 2, notReady: 3, interrupted: 130 } as const;

// oxlint-disable-next-line no-control-regex -- citty colours its messages; the one-line error must not
const ANSI = /\x1b\[[0-9;]*m/g;

/** `text` without colour codes: for output that is piped, or under NO_COLOR. */
export const stripAnsi = (text: string): string => text.replace(ANSI, "");

/** A service's fix worded for the MCP tools, as the CLI says it. */
const CLI_FIX: Record<string, string> = { [RUN_NOT_FOUND_FIX]: "catherd runs list" };

/** Spec §8: one line `error E_CODE: message`, then `fix: …` when there is one. */
export function printError(e: Pick<CatherdError, "code" | "message" | "fix">): void {
  console.error(`error ${e.code}: ${stripAnsi(e.message).split("\n").join(" ")}`);
  if (e.fix) console.error(`fix: ${CLI_FIX[e.fix] ?? e.fix}`);
}

/** Bad input from the command line is a usage error; any other catherd error is an error. */
export const exitCodeOf = (e: unknown): number =>
  isCatherdError(e) && e.code === "E_INPUT_INVALID" ? EXIT.usage : EXIT.error;

export const printJson = (v: unknown): void => console.log(JSON.stringify(v, null, 2));

/** The `--json` flag every read command takes. */
export const JSON_ARG = { json: { type: "boolean", description: "print JSON" } } as const;

/**
 * The glyph for a state, as in `✓ ready`: the dashboard's own (spec §9.3), ASCII with `--plain` only;
 * NO_COLOR drops colour, never glyphs. The caller adds the word.
 */
export const mark = (state: State, plain = false): string => glyph(state, plain);
