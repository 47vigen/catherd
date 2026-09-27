import { replaceSecrets, scrubKeyShapes } from "./secrets.ts";

/** What to strip from a captured stream: exact secret values, and paths to replace with a stable name. */
export interface Scrub {
  secrets: string[];
  paths: { from: string; to: string }[];
}

const EMAIL = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g;

const longestFirst = <T>(xs: T[], len: (x: T) => number) => [...xs].sort((a, b) => len(b) - len(a));

/**
 * Spec §11.8: a capture keeps no secret and no home path. Secrets (8+ chars) and key-shaped strings
 * (domain/secrets.ts) become `<redacted>`, emails `<email>`, and each path its stable name, longest
 * path first so a repo inside the home directory reads `<repo>`, not `~/…`.
 */
export function sanitize(text: string, s: Scrub): string {
  // a captured stream is JSONL: a secret with a quote, a backslash or a control character is escaped there
  const forms = s.secrets.flatMap((x) => [x, JSON.stringify(x).slice(1, -1)]);
  let out = scrubKeyShapes(replaceSecrets(text, forms, "<redacted>"), "<redacted>");
  out = out.replace(EMAIL, "<email>");
  for (const p of longestFirst(
    s.paths.filter((x) => x.from.length > 1),
    (x) => x.from.length,
  ))
    out = out.split(p.from).join(p.to);
  return out;
}
