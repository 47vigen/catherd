import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { knownSecrets } from "../../src/infra/log.ts";
import { credentialsPath, savedCredential } from "../../src/services/credentials.ts";
import { jevKey, registerSavedSecrets, saveJevKey } from "../../src/services/jev-service.ts";
import { noPosixModes, snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

describe("the Jev key in credentials.json", () => {
  it("comes from TYPESAFE_API_KEY first, else the saved key, else none", () => {
    withHome();
    delete process.env.TYPESAFE_API_KEY;
    expect(jevKey()).toBeNull();
    saveJevKey(" tsk-saved-0123456789 ");
    expect(jevKey()).toBe("tsk-saved-0123456789");
    process.env.TYPESAFE_API_KEY = "tsk-env-0123456789";
    expect(jevKey()).toBe("tsk-env-0123456789");
  });

  it("keeps a key a 1.5 file holds (an Artificial Analysis key is never read, nor dropped on a save)", () => {
    withHome();
    delete process.env.TYPESAFE_API_KEY;
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(
      credentialsPath(),
      JSON.stringify({ schema: 1, artificialAnalysisApiKey: "aa-0123456789" }),
    );
    saveJevKey("tsk-0123456789abcdef");
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toEqual({
      schema: 1,
      typesafeApiKey: "tsk-0123456789abcdef",
      artificialAnalysisApiKey: "aa-0123456789",
    });
    expect(jevKey()).toBe("tsk-0123456789abcdef");
  });

  it.skipIf(noPosixModes)("keeps credentials.json at mode 600", () => {
    withHome();
    saveJevKey("tsk-0123456789abcdef");
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it("reads an unparsable credentials.json as no key, and refuses to overwrite it", () => {
    withHome();
    delete process.env.TYPESAFE_API_KEY;
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), "{not json");
    expect(jevKey()).toBeNull();
    expect(savedCredential("typesafeApiKey").problem?.code).toBe("E_CONFIG_INVALID");
    expect(() => saveJevKey("tsk-0123456789abcdef")).toThrow("is not valid JSON");
  });

  it("is registered with the log redactor", () => {
    withHome();
    delete process.env.TYPESAFE_API_KEY;
    saveJevKey("tsk-redact-0123456789");
    registerSavedSecrets();
    expect(knownSecrets({})).toContain("tsk-redact-0123456789");
  });
});

describe("saving a credential (1.2 minor)", () => {
  it("holds the file's lock, so two concurrent saves leave a valid file and another key intact", async () => {
    withHome();
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), JSON.stringify({ schema: 1, other: "kept" }));
    const module = join(import.meta.dir, "..", "..", "src", "services", "credentials.ts");
    const writer = (key: string) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `const { saveCredential } = await import(${JSON.stringify(module)}); for (let i = 0; i < 25; i++) saveCredential("typesafeApiKey", ${JSON.stringify(key)} + i);`,
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
    const a = writer("tsk-a-");
    const b = writer("tsk-b-");
    expect([await a.exited, await b.exited]).toEqual([0, 0]);
    const saved = JSON.parse(readFileSync(credentialsPath(), "utf8"));
    expect(saved.other).toBe("kept");
    expect(["tsk-a-24", "tsk-b-24"]).toContain(saved.typesafeApiKey);
  });
});
