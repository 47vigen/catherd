import { parseReplyStatus } from "./record.ts";

/**
 * Plan 22: a final reply never overwrites the report. `finals` are the messages that ended each of the run's
 * turns, in order (a background command's notification can start another turn after the report); `last` is the
 * reply the CLI kept, the last of them. With more than one, the reply is the longest STATUS-bearing message, the
 * later ones after it under `later:`, and the report's STATUS line last, so the record's STATUS is the report's.
 * Otherwise `last` is the reply, unchanged.
 */
export function composeReply(finals: string[], last: string): string {
  if (finals.length < 2) return last;
  let report = -1;
  for (const [i, f] of finals.entries())
    if (
      parseReplyStatus(f).status !== null &&
      (report < 0 || f.trim().length >= finals[report]!.trim().length)
    )
      report = i;
  if (report < 0 || report === finals.length - 1) return last;
  const lines = finals[report]!.trimEnd().split("\n");
  const status = lines.pop() as string;
  const later = finals
    .slice(report + 1)
    .map((f) => f.trim())
    .filter(Boolean);
  if (!later.length) return last;
  const body = lines.join("\n").trimEnd();
  return [...(body ? [body, ""] : []), "later:", later.join("\n\n"), "", status.trim(), ""].join("\n");
}
