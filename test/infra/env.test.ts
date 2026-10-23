import { describe, expect, it } from "bun:test";
import { ROLE_ENV, roleScopeFromEnv, roleScopeOfScratch } from "../../src/domain/role-scope.ts";
import { checkEnv, restoreTmpdir, scrubSecrets, workerEnv } from "../../src/infra/env.ts";
import { DISPATCH_ID_ENV } from "../../src/infra/lock-activity.ts";

describe("workerEnv", () => {
  it("drops catherd's own secrets, keeps the user's backend credentials, and sets PWD", () => {
    const env = workerEnv(
      {
        PATH: "/bin",
        TYPESAFE_API_KEY: "k",
        OPENAI_API_KEY: "mine",
        CATHERD_HOME: "/h",
        HOME: "/home/u",
        X: undefined,
      },
      { CODEX_HOME: "/iso" },
      "/repo",
    );
    expect(env).toEqual({
      PATH: "/bin",
      OPENAI_API_KEY: "mine",
      CATHERD_HOME: "/h",
      HOME: "/home/u",
      CODEX_HOME: "/iso",
      PWD: "/repo",
    });
  });
});

describe("scrubSecrets", () => {
  it("drops catherd's own secrets and unset keys, and keeps everything else", () => {
    expect(
      scrubSecrets({ PATH: "/bin", TYPESAFE_API_KEY: "k", OPENAI_API_KEY: "mine", X: undefined }),
    ).toEqual({
      PATH: "/bin",
      OPENAI_API_KEY: "mine",
    });
  });
});

describe("restoreTmpdir (spec 1.1 §12)", () => {
  it("gives the server the TMPDIR the user had before the launcher pointed it at bunx's cache", () => {
    const env: Record<string, string | undefined> = {
      TMPDIR: "/c/catherd/bunx",
      CATHERD_USER_TMPDIR: "/mine",
    };
    restoreTmpdir(env);
    expect(env).toEqual({ TMPDIR: "/mine" });
  });

  it("unsets TMPDIR when the user had none", () => {
    const env: Record<string, string | undefined> = { TMPDIR: "/c/catherd/bunx", CATHERD_USER_TMPDIR: "" };
    restoreTmpdir(env);
    expect(env).toEqual({});
  });

  it("leaves TMPDIR alone when the launcher did not set it", () => {
    const env: Record<string, string | undefined> = { TMPDIR: "/mine" };
    restoreTmpdir(env);
    expect(env).toEqual({ TMPDIR: "/mine" });
  });
});

describe("checkEnv", () => {
  it("keeps only the allowlisted keys, and sets PWD", () => {
    expect(
      checkEnv(
        {
          PATH: "/bin",
          HOME: "/home/u",
          LANG: "C.UTF-8",
          LC_ALL: "C",
          XDG_CACHE_HOME: "/c",
          CATHERD_HOME: "/h",
          OPENAI_API_KEY: "mine",
          AWS_SECRET_ACCESS_KEY: "aws",
          GH_TOKEN: "gh",
          TYPESAFE_API_KEY: "k",
          CATHERD_TOKEN: "t",
          PWD: "/elsewhere",
          X: undefined,
        },
        "/repo",
      ),
    ).toEqual({
      PATH: "/bin",
      HOME: "/home/u",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      XDG_CACHE_HOME: "/c",
      CATHERD_HOME: "/h",
      PWD: "/repo",
    });
  });

  it("is never a role's: no role identity, and no TMPDIR in a role's scratch", () => {
    const scratch = "/d/runs/20261023-101010-x/scratch/verifier-M1/tmp";
    const env = checkEnv(
      {
        PATH: "/bin",
        [ROLE_ENV]: "20261023-101010-x/verifier-M1",
        [DISPATCH_ID_ENV]: "d-1",
        TMPDIR: scratch,
        GOTMPDIR: scratch,
      },
      "/repo",
    );
    expect(env[ROLE_ENV]).toBeUndefined();
    expect(env[DISPATCH_ID_ENV]).toBeUndefined();
    expect(roleScopeOfScratch(env.TMPDIR)).toBeNull();
    expect(roleScopeFromEnv(env)).toBeNull();
    expect(checkEnv({ TMPDIR: "/tmp/mine" }, "/repo").TMPDIR).toBe("/tmp/mine");
  });
});

it("scrub_every_boundary prevents override identity and preserves native configuration", () => {
  const identity = {
    CODEX_THREAD_ID: "parent",
    CODEX_SESSION_ID: "parent",
    CATHERD_ORCHESTRATION_HOST: "codex",
    CLAUDE_CODE_SESSION_ID: "parent",
    CLAUDE_CODE_MESSAGING_TOKEN: "secret",
  };
  const base = { ...identity, HOME: "/native", CODEX_HOME: "/codex", OPENAI_API_KEY: "credential" };
  for (const clean of [scrubSecrets(base), workerEnv(base, identity, "/repo")]) {
    for (const key of Object.keys(identity)) expect(clean[key]).toBeUndefined();
    expect(clean.CODEX_HOME).toBe("/codex");
    expect(clean.OPENAI_API_KEY).toBe("credential");
  }
  for (const key of Object.keys(identity)) expect(checkEnv(base, "/repo")[key]).toBeUndefined();
});
