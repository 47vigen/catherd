import { describe, expect, it } from "bun:test";
import {
  isSecretName,
  replaceSecrets,
  scrubKeyShapes,
  scrubSecretAssignments,
  secretEnvValues,
} from "../../src/domain/secrets.ts";

describe("the env-name rule", () => {
  it("takes any name containing KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL, anywhere and in any case", () => {
    for (const name of [
      "OPENAI_API_KEY",
      "OPENAI_API_KEY_2",
      "GH_TOKEN",
      "GH_TOKEN_FILE",
      "CLIENT_SECRET",
      "DB_PASSWORD",
      "AWS_CREDENTIALS",
      "npm_config_token",
    ])
      expect([name, isSecretName(name)]).toEqual([name, true]);
    for (const name of ["PATH", "HOME", "CATHERD_HOME", "LANG"])
      expect([name, isSecretName(name)]).toEqual([name, false]);
  });

  it("returns those env values of 8+ characters, once each, longest first", () => {
    expect(
      secretEnvValues({
        AWS_CREDENTIALS: "aws-cred-0123",
        GH_TOKEN_FILE: "gh-token-file-0123456",
        OTHER_TOKEN: "aws-cred-0123",
        SOME_KEY: "short",
        PATH: "/usr/local/bin:/usr/bin",
        X: undefined,
      }),
    ).toEqual(["gh-token-file-0123456", "aws-cred-0123"]);
  });

  it("replaces literal secrets of 8+ characters, the longest first", () => {
    expect(
      replaceSecrets(
        "a hunter2-long and hunter2-longer, short",
        ["hunter2-long", "hunter2-longer", "short"],
        "#",
      ),
    ).toBe("a # and #, short");
  });
});

describe("key shapes", () => {
  it("scrubs sk- and sk-ant- keys, GitHub, AWS and Slack tokens, and private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    expect(
      scrubKeyShapes(
        [
          "sk-ant-api03-abcdefghij",
          "sk-proj-abcdefghijklmnop",
          "ghp_abcdefghijklmnopqrst0",
          "github_pat_abcdefghijklmnopqrst0",
          "AKIAABCDEFGHIJKLMNOP",
          "xoxb-0123456789-abc",
          pem,
        ].join(" "),
        "#",
      ),
    ).toBe("# # # # # # #");
  });

  it("scrubs a bearer token and a URL's password, keeping the label and the user", () => {
    expect(scrubKeyShapes("Authorization: Bearer abc.def.ghijklmnop", "#")).toBe("Authorization: Bearer #");
    expect(scrubKeyShapes("authorization: bearer 0123456789abcdefXYZ==", "#")).toBe(
      "authorization: bearer #",
    );
    expect(scrubKeyShapes("postgres://app:hunter22@db:5432/x", "#")).toBe("postgres://app:#@db:5432/x");
  });

  it("leaves ordinary text alone", () => {
    const text = "a task-list, a Bearer of news, https://example.com:8080/path and sk-short";
    expect(scrubKeyShapes(text, "#")).toBe(text);
  });

  it("scrubs a credential-named assignment, keeping its name", () => {
    expect(scrubSecretAssignments("DB_PASSWORD=hunter22 api_key: abcdef12", "#")).toBe(
      "DB_PASSWORD=# api_key=#",
    );
  });
});
