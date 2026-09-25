/** What to strip from a captured stream: exact secret values, and paths to replace with a stable name. */
export interface Scrub {
  secrets: string[];
  paths: { from: string; to: string }[];
}

const KEYS = [/sk-ant-[\w-]{10,}/g, /\bsk-[\w-]{20,}/g, /\bBearer\s+[\w.~+/=-]{10,}/g];
const EMAIL = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g;

/** The values of env vars whose names say they hold a credential. */
export function secretValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => v !== undefined && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k))
    .map(([, v]) => v as string);
}

const longestFirst = <T>(xs: T[], len: (x: T) => number) => [...xs].sort((a, b) => len(b) - len(a));

/**
 * Spec §11.8: a capture keeps no secret and no home path. Secrets (8+ chars) and key-shaped strings
 * become `<redacted>`, emails `<email>`, and each path its stable name, longest path first so a repo
 * inside the home directory reads `<repo>`, not `~/…`.
 */
export function sanitize(text: string, s: Scrub): string {
  let out = text;
  for (const v of longestFirst(
    s.secrets.filter((x) => x.length >= 8),
    (x) => x.length,
  ))
    out = out.split(v).join("<redacted>");
  for (const re of KEYS) out = out.replace(re, "<redacted>");
  out = out.replace(EMAIL, "<email>");
  for (const p of longestFirst(
    s.paths.filter((x) => x.from.length > 1),
    (x) => x.from.length,
  ))
    out = out.split(p.from).join(p.to);
  return out;
}
