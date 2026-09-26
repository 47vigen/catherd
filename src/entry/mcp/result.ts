import { type CallToolResult, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { CatherdError, isCatherdError } from "../../domain/errors.ts";

/** A service's value as a tool result; its `hints`, when it has any, pass through as they are. */
export const ok = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});

/** Spec §4.8, §10.1: every failure is a structured tool error `{ code, message, fix }`. */
export function fail(e: unknown): CallToolResult {
  const err = isCatherdError(e)
    ? { fix: "", ...e.toJSON() }
    : {
        code: "E_IO_UNEXPECTED",
        message: e instanceof Error ? e.message : String(e),
        fix: "this is a catherd bug: report it with the message",
      };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(err) }], structuredContent: err };
}

/** Runs one service call and turns its value, or its error, into a tool result. */
export async function handle(f: () => unknown): Promise<CallToolResult> {
  try {
    return ok(await f());
  } catch (e) {
    return fail(e);
  }
}

const UNKNOWN_TOOL = /Tool (\S+) (?:not found|disabled)$/;

/** The tool an SDK error message names ("Tool x not found", "… arguments for tool x: …"), else null. */
export const toolOf = (message: string): string | null =>
  (UNKNOWN_TOOL.exec(message) ?? /for tool (\S+?):/.exec(message))?.[1] ?? null;

/**
 * The SDK's own tool errors, raised before `handle` runs, in catherd's shape (spec §4.8): a call to a tool
 * this server does not have, or input a tool's schema rejects, is E_INPUT_INVALID; anything else is
 * unexpected.
 */
export function sdkToolError(message: string): CallToolResult {
  if (!message.startsWith(`MCP error ${ErrorCode.InvalidParams}:`)) return fail(new Error(message));
  const unknown = UNKNOWN_TOOL.exec(message)?.[1];
  return fail(
    new CatherdError("E_INPUT_INVALID", message, {
      fix: unknown
        ? `call a tool this server lists (tools/list); a skill that needs ${unknown} needs a newer catherd: claude plugin update catherd@catherd`
        : "correct the argument the message names, then call again",
    }),
  );
}
