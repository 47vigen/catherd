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

/**
 * The SDK's own tool errors, such as input a tool's schema rejects before `handle` runs, in catherd's
 * shape (spec §4.8): an InvalidParams error is E_INPUT_INVALID, anything else is unexpected.
 */
export const sdkToolError = (message: string): CallToolResult =>
  fail(
    message.startsWith(`MCP error ${ErrorCode.InvalidParams}:`)
      ? new CatherdError("E_INPUT_INVALID", message, {
          fix: "correct the argument the message names, then call again",
        })
      : new Error(message),
  );
