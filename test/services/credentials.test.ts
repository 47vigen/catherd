import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { knownSecrets } from "../../src/infra/log.ts";
import { aaKey, credentialsPath, saveAaKey, savedCredential } from "../../src/services/credentials.ts";
import { jevKey, registerSavedSecrets, saveJevKey } from "../../src/services/jev-service.ts";
import { noPosixModes, snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

describe("the Artificial Analysis key (spec 1.2 §9)", () => {
  it("comes from ARTIFICIAL_ANALYSIS_API_KEY first, else the saved key, else none", () => {
    withHome();
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    expect(aaKey()).toBeNull();
    saveAaKey(" aa-saved-0123456789 ");
    expect(aaKey()).toBe("aa-saved-0123456789");
    process.env.ARTIFICIAL_ANALYSIS_API_KEY = "aa-env-0123456789";
    expect(aaKey()).toBe("aa-env-0123456789");
  });

  it("is saved beside the Jev key in credentials.json, each keeping the other", () => {
    withHome();
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    saveJevKey("tsk-0123456789abcdef");
    saveAaKey("aa-0123456789abcdef");
    saveJevKey("tsk-fedcba9876543210");
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toEqual({
      schema: 1,
      typesafeApiKey: "tsk-fedcba9876543210",
      artificialAnalysisApiKey: "aa-0123456789abcdef",
    });
    expect(jevKey()).toBe("tsk-fedcba9876543210");
  });

  it.skipIf(noPosixModes)("keeps credentials.json at mode 600", () => {
    withHome();
    saveAaKey("aa-0123456789abcdef");
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it("reads an unparsable credentials.json as no key, and refuses to overwrite it", () => {
    withHome();
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), "{not json");
    expect(aaKey()).toBeNull();
    expect(savedCredential("artificialAnalysisApiKey").problem?.code).toBe("E_CONFIG_INVALID");
    expect(() => saveAaKey("aa-0123456789abcdef")).toThrow("is not valid JSON");
  });

  it("is registered with the log redactor with the Jev key", () => {
    withHome();
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    saveAaKey("aa-redact-0123456789");
    registerSavedSecrets();
    expect(knownSecrets({})).toContain("aa-redact-0123456789");
  });
});

describe("saving a credential (1.2 minor)", () => {
  it("holds the file's lock, so two concurrent saves of different keys both survive", async () => {
    withHome();
    const module = join(import.meta.dir, "..", "..", "src", "services", "credentials.ts");
    const writer = (field: string, key: string) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `const { saveCredential } = await import(${JSON.stringify(module)}); for (let i = 0; i < 25; i++) saveCredential(${JSON.stringify(field)}, ${JSON.stringify(key)} + i);`,
        ],
        {
          env: {
            PATH: process.env.PATH ?? "",
            CATHERD_HOME: process.env.CATHERD_HOME ?? "",
            ANTHROPIC_API_KEY: "",
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
    const a = writer("typesafeApiKey", "tsk-");
    const b = writer("artificialAnalysisApiKey", "aa-");
    expect([await a.exited, await b.exited]).toEqual([0, 0]);
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toEqual({
      schema: 1,
      typesafeApiKey: "tsk-24",
      artificialAnalysisApiKey: "aa-24",
    });
  });
});
