import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CatherdError, isCatherdError } from "../domain/errors.ts";
import { withFileLockSync } from "../infra/filelock.ts";
import { configDir } from "../infra/paths.ts";
import { readVersioned, writeJsonAtomic } from "../infra/store.ts";

// Spec §10.4: `<config>/credentials.json`, mode 600, holds catherd's own key, the decision model's (`decisionKey`). The
// schema is a loose object, so a key one catherd does not know (a 1.5 file's `artificialAnalysisApiKey`)
// survives another's rewrite.

export const credentialsPath = (): string => join(configDir(), "credentials.json");

const CredentialsSchema = z.looseObject({
  schema: z.literal(1).default(1),
  typesafeApiKey: z.string().optional(),
  decisionKey: z.string().optional(),
  /** set when `migrateCredentials` moved a TypeSafe key into `decisionKey`; a later save clears it */
  decisionKeyFrom: z.literal("typesafe").optional(),
});
export type CredentialField = "typesafeApiKey" | "decisionKey";

/** How to repair a credentials file catherd cannot read: `init` alone refuses to overwrite it. */
const credentialsFix = (): string =>
  `delete ${credentialsPath()} and run catherd init, or write it as {"schema": 1, "decisionKey": "<your key>"}`;
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
 * unreadable or newer-schema one is refused (it throws) rather than overwritten. The read and the write hold
 * the file's lock (1.2 minor), so two concurrent `init`s never lose a key.
 */
export function saveCredential(field: CredentialField, key: string): void {
  mkdirSync(configDir(), { recursive: true });
  withFileLockSync(credentialsPath(), () => {
    const cur: z.infer<typeof CredentialsSchema> = existsSync(credentialsPath())
      ? readCredentials()
      : { schema: 1 };
    const next = { ...cur, schema: 1, [field]: key.trim() };
    if (field === "decisionKey") delete next.decisionKeyFrom;
    writeJsonAtomic(credentialsPath(), next, { mode: 0o600 });
  });
}

/** True while a TypeSafe key is on file: not yet moved, or moved and not replaced since. */
export function holdsTypesafeKey(): boolean {
  if (!existsSync(credentialsPath())) return false;
  try {
    const c = readCredentials();
    return !!c.typesafeApiKey?.trim() || (c.decisionKeyFrom === "typesafe" && !!c.decisionKey?.trim());
  } catch {
    return false;
  }
}

/**
 * Plan 44 D26: a 1.5 file's `typesafeApiKey` becomes `decisionKey`, once, under the file's lock; a file that
 * already has a `decisionKey` is left as it is. An unreadable or newer-schema file throws, as a save does.
 */
export function migrateCredentials(): { moved: boolean } {
  if (!existsSync(credentialsPath())) return { moved: false };
  return withFileLockSync(credentialsPath(), () => {
    const { typesafeApiKey, ...rest } = readCredentials();
    if (!typesafeApiKey || rest.decisionKey) return { moved: false };
    writeJsonAtomic(
      credentialsPath(),
      { ...rest, schema: 1, decisionKey: typesafeApiKey.trim(), decisionKeyFrom: "typesafe" },
      { mode: 0o600 },
    );
    return { moved: true };
  });
}
