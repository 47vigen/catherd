import { describe, expect, it } from "bun:test";
import { workerEnv } from "../../src/infra/env.ts";

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
