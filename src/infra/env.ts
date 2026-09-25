/** catherd's own secrets; the user's backend credentials (OPENAI_API_KEY, …) stay, workers need them. */
export const SECRET_ENV = new Set(["TYPESAFE_API_KEY"]);

export function workerEnv(
  base: Record<string, string | undefined>,
  overrides: Record<string, string>,
  cwd: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !SECRET_ENV.has(k)) env[k] = v;
  return { ...env, ...overrides, PWD: cwd };
}
