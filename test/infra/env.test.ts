import { describe, expect, it } from "bun:test";
import { checkEnv, scrubSecrets, workerEnv } from "../../src/infra/env.ts";

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
});
