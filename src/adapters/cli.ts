export { runCli, type CliResult } from "../infra/cli.ts";

/** The JSON a CLI printed, or null for empty or unreadable output. */
export function jsonOf(out: string | undefined): unknown {
  if (!out?.trim()) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}
