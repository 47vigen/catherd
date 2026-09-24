import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const json = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(v, null, 2) }],
});
export const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
