// Spec §10.4 and §11.8: the one rule for what is a secret. The log redactor (infra/log.ts), fixture
// capture (domain/sanitize.ts) and Jev's lane state (domain/jev.ts) all scrub with it; each picks its mark.

/** Env names whose values are credentials: the word may sit anywhere (OPENAI_API_KEY_2, GH_TOKEN_FILE). */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
/** A literal secret shorter than this is never scrubbed: it would blank ordinary words. */
export const MIN_SECRET = 8;

export const isSecretName = (name: string): boolean => SECRET_NAME.test(name);

const longestFirst = (xs: string[]): string[] => [...new Set(xs)].sort((a, b) => b.length - a.length);

/** The values of env vars whose names say they hold a credential: 8+ characters, once each, longest first. */
export function secretEnvValues(env: Record<string, string | undefined>): string[] {
  return longestFirst(
    Object.entries(env)
      .filter(([k, v]) => v !== undefined && v.length >= MIN_SECRET && isSecretName(k))
      .map(([, v]) => v as string),
  );
}

/** `text` with each literal secret of 8+ characters replaced by `mark`, the longest first. */
export function replaceSecrets(text: string, secrets: string[], mark: string): string {
  let out = text;
  for (const s of longestFirst(secrets.filter((x) => x.length >= MIN_SECRET))) out = out.split(s).join(mark);
  return out;
}

/** Strings shaped like a key wherever they appear, and the part kept before the mark ("Bearer ", a URL's user). */
const KEY_SHAPES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, ""],
  [/sk-ant-[\w-]{10,}/g, ""],
  [/\bsk-[\w-]{16,}/g, ""],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, ""],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, ""],
  [/\bAKIA[0-9A-Z]{16}\b/g, ""],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, ""],
  [/\b(Bearer\s+)[\w.~+/=-]{10,}/gi, "$1"],
  [/(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/g, "$1"],
];

/** `text` with every key-shaped string replaced by `mark` (which must not contain `$`). */
export function scrubKeyShapes(text: string, mark: string): string {
  let out = text;
  for (const [re, keep] of KEY_SHAPES) out = out.replace(re, `${keep}${mark}`);
  return out;
}

/**
 * `api_key = value` and the like, keeping the name. Jev's state only: on a captured stream or a log row
 * it would also blank counts such as `max_tokens: 100000`.
 */
const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_]*)\s*[:=]\s*["']?[^\s"']{6,}/gi;

export const scrubSecretAssignments = (text: string, mark: string): string =>
  text.replace(ASSIGNMENT, `$1=${mark}`);
