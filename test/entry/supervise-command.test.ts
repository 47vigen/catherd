import { describe, expect, it } from "bun:test";
import { superviseEnv } from "../../src/entry/supervise-command.ts";

describe("the supervised worker's env (plan 23 review I4)", () => {
  it("never lets a gate env reference override what the spec sets (identity, scratch, PWD)", () => {
    const env = superviseEnv(
      {
        env: { CATHERD_ROLE: "run-1/verifier-M1", TMPDIR: "/scratch", DOCKER_HOST: "unix:///d.sock" },
        envFrom: { CATHERD_ROLE: "FORGED", TMPDIR: "FORGED", HTTPS_PROXY: "MY_PROXY" },
        cwd: "/repo",
      },
      { PATH: "/bin", FORGED: "evil", MY_PROXY: "http://p:3128" },
      () => ({}),
    );
    expect(env.CATHERD_ROLE).toBe("run-1/verifier-M1");
    expect(env.TMPDIR).toBe("/scratch");
    expect(env.HTTPS_PROXY).toBe("http://p:3128");
    expect(env.DOCKER_HOST).toBe("unix:///d.sock");
    expect(env.PWD).toBe("/repo");
  });
});
