import { readFileSync } from "node:fs";

/** The package version; the MCP server reports it and every run folder records it. */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;
