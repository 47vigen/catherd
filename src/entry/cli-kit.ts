import { type CatherdError, isCatherdError } from "../domain/errors.ts";

/** Spec §8: 0 ok, 1 error, 2 usage, 3 not ready (doctor), 130 interrupted. */
export const EXIT = { ok: 0, error: 1, usage: 2, notReady: 3, interrupted: 130 } as const;

// oxlint-disable-next-line no-control-regex -- citty colours its messages; the one-line error must not
const ANSI = /\x1b\[[0-9;]*m/g;

/** Spec §8: one line `error E_CODE: message`, then `fix: …` when there is one. */
export function printError(e: Pick<CatherdError, "code" | "message" | "fix">): void {
  console.error(`error ${e.code}: ${e.message.replace(ANSI, "").split("\n").join(" ")}`);
  if (e.fix) console.error(`fix: ${e.fix}`);
}

/** Bad input from the command line is a usage error; any other catherd error is an error. */
export const exitCodeOf = (e: unknown): number =>
  isCatherdError(e) && e.code === "E_INPUT_INVALID" ? EXIT.usage : EXIT.error;

export const printJson = (v: unknown): void => console.log(JSON.stringify(v, null, 2));

/** Glyph and word for a state, `✓ ready`-style (spec §9.3's words; ASCII with `--plain`). */
export function mark(state: "ok" | "warn" | "fail" | "skip", plain = false): string {
  const g = plain
    ? { ok: "+", warn: "!", fail: "x", skip: "-" }
    : { ok: "✓", warn: "!", fail: "✗", skip: "-" };
  return g[state];
}
