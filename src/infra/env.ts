/**
 * catherd's own secrets; the user's backend credentials (OPENAI_API_KEY, …) stay, workers need them. The Claude Code
 * session's messaging socket and token are the MCP server's alone (spec §3.2: it is the only sender), and so is the
 * session's identity (a child that has it takes itself for that session: the doctor's MCP server would own its
 * runs, a headless claude-code worker would inherit it): no process catherd starts gets them.
 */
const SECRET_ENV = new Set([
  "TYPESAFE_API_KEY",
  // spec 1.2 §9: the user's Artificial Analysis key reads scores for catherd alone
  "ARTIFICIAL_ANALYSIS_API_KEY",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
]);

/** `base` without catherd's own secrets and without unset keys; for every process catherd starts. */
export function scrubSecrets(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !SECRET_ENV.has(k)) env[k] = v;
  return env;
}

/**
 * Spec 1.1 §12: the plugin's launcher runs `bunx` with TMPDIR in catherd's cache, so macOS never half-cleans
 * the package, and passes the user's own TMPDIR in CATHERD_USER_TMPDIR (empty when unset). The server and
 * every worker it starts get the user's TMPDIR back.
 */
export function restoreTmpdir(env: Record<string, string | undefined>): void {
  const mine = env.CATHERD_USER_TMPDIR;
  if (mine === undefined) return;
  if (mine) env.TMPDIR = mine;
  else delete env.TMPDIR;
  delete env.CATHERD_USER_TMPDIR;
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
