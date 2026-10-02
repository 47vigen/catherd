import { CatherdError, isCatherdError } from "../domain/errors.ts";
import { roleScopeFromEnv } from "../domain/role-scope.ts";
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

/**
 * Spec 1.5 plan 21: a role's shell (CATHERD_ROLE, or its scratch TMPDIR) never runs a command that writes the
 * orchestrator's state (pause, runs cancel, profile set, …): E_ROLE_SCOPE, as `catherd run-file` and `catherd gate`
 * refuse an operation the role has not. `command` is the command as typed, like `catherd pause`.
 */
export function refuseInRole(env: Record<string, string | undefined>, command: string): void {
  const scope = roleScopeFromEnv(env);
  if (!scope) return;
  throw new CatherdError(
    "E_ROLE_SCOPE",
    `${command} is the orchestrator's: this process runs ${scope.name} of run ${scope.run}`,
    { fix: "report it in your reply; the orchestrator does it" },
  );
}

export const printJson = (v: unknown): void => console.log(JSON.stringify(v, null, 2));

/** The `--json` flag every read command takes. */
export const JSON_ARG = { json: { type: "boolean", description: "print JSON" } } as const;

/**
 * The glyph for a state, as in `✓ ready`: the dashboard's own (spec §9.3), ASCII with `--plain` only;
 * NO_COLOR drops colour, never glyphs. The caller adds the word.
 */
export const mark = (state: State, plain = false): string => glyph(state, plain);
