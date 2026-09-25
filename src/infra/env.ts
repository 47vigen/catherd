/** catherd's own secrets; the user's backend credentials (OPENAI_API_KEY, …) stay, workers need them. */
export const SECRET_ENV = new Set(["TYPESAFE_API_KEY"]);

/** `base` without catherd's own secrets and without unset keys; for every process catherd starts. */
export function scrubSecrets(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !SECRET_ENV.has(k)) env[k] = v;
  return env;
}

export function workerEnv(
  base: Record<string, string | undefined>,
  overrides: Record<string, string>,
  cwd: string,
): Record<string, string> {
  return { ...scrubSecrets(base), ...overrides, PWD: cwd };
}

/** What a preflight check may see; everything else, credentials included, stays out (spec §4.7). */
const CHECK_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TERM",
  "TMPDIR",
  "CI",
  "NODE_ENV",
  "CATHERD_HOME",
  "CATHERD_LOCK_SLOTS",
]);
const CHECK_ENV_PATTERN = /^(LC_[A-Z_]+|XDG_[A-Z_]+_(HOME|DIR|DIRS))$/;

/** A strict allowlist of `base` plus PWD, for lane-authored shell text such as preflight checks. */
export function checkEnv(base: Record<string, string | undefined>, cwd: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base))
    if (v !== undefined && (CHECK_ENV.has(k) || CHECK_ENV_PATTERN.test(k))) env[k] = v;
  return { ...env, PWD: cwd };
}
