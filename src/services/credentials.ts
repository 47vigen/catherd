import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CatherdError, isCatherdError } from "../domain/errors.ts";
import { log } from "../infra/log.ts";
import { configDir } from "../infra/paths.ts";
import { readVersioned, writeJsonAtomic } from "../infra/store.ts";

// Spec §10.4 and 1.2 §9: `<config>/credentials.json`, mode 600, holds catherd's own keys: Jev's
// (`typesafeApiKey`) and Artificial Analysis's (`artificialAnalysisApiKey`). The schema is a loose object,
// so a key one catherd does not know survives another's rewrite.

export const credentialsPath = (): string => join(configDir(), "credentials.json");

const CredentialsSchema = z.looseObject({
  schema: z.literal(1).default(1),
  typesafeApiKey: z.string().optional(),
  artificialAnalysisApiKey: z.string().optional(),
});
export type CredentialField = "typesafeApiKey" | "artificialAnalysisApiKey";

/** How to repair a credentials file catherd cannot read: `init` alone refuses to overwrite it. */
const credentialsFix = (): string =>
  `delete ${credentialsPath()} and run catherd init, or write it as {"schema": 1, "typesafeApiKey": "<your key>"}`;
const readCredentials = () =>
  readVersioned(credentialsPath(), CredentialsSchema, 1, { fix: credentialsFix() });

/** A key saved in credentials.json, or why that file cannot be read (unparsable, newer schema). */
export function savedCredential(field: CredentialField): {
  key: string | null;
  problem: CatherdError | null;
} {
  if (!existsSync(credentialsPath())) return { key: null, problem: null };
  try {
    return { key: readCredentials()[field]?.trim() || null, problem: null };
  } catch (e) {
    return {
      key: null,
      problem: isCatherdError(e)
        ? e
        : new CatherdError("E_CONFIG_INVALID", String(e), { fix: credentialsFix() }),
    };
  }
}

/**
 * Keeps every other credential, and the file at mode 600 (spec §10.4). A missing file starts empty; an
 * unreadable or newer-schema one is refused (it throws) rather than overwritten.
 */
export function saveCredential(field: CredentialField, key: string): void {
  const cur: z.infer<typeof CredentialsSchema> = existsSync(credentialsPath())
    ? readCredentials()
    : { schema: 1 };
  writeJsonAtomic(credentialsPath(), { ...cur, schema: 1, [field]: key.trim() }, { mode: 0o600 });
}

/**
 * Spec 1.2 §9: `ARTIFICIAL_ANALYSIS_API_KEY`, else the saved key; null when neither has one. The key is
 * optional, so a credentials file that cannot be read means no key here; it is logged.
 */
export function aaKey(env: Record<string, string | undefined> = process.env): string | null {
  const fromEnv = env.ARTIFICIAL_ANALYSIS_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const { key, problem } = savedCredential("artificialAnalysisApiKey");
  if (problem) log("warn", "sources", { error: `no Artificial Analysis key: ${problem.message}` });
  return key;
}

export const saveAaKey = (key: string): void => saveCredential("artificialAnalysisApiKey", key);
