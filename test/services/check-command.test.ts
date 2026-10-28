import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resetLoginEnv } from "../../src/infra/login-env.ts";
import { checkEnvFor, runCheck } from "../../src/services/check-command.ts";
import { setGateEnv } from "../../src/services/gate-env.ts";
import { snapshotEnv, tempDir } from "../helpers.ts";
import { freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

describe("runCheck (kept from the 2.0 preflight, plan 50)", () => {
  it("stops a check at its timeout", async () => {
    const { repo } = freshRun();
    const started = Date.now();
    const r = await runCheck(repo, "sleep 5", 200);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect([r.code, r.timedOut]).toEqual([null, true]);
  });

  it("returns when the check exits although a process it detached still holds the pipes", async () => {
    const { repo } = freshRun();
    // a process in its own session (setsid is Linux-only; Bun detaches the same way everywhere)
    const detach = `'${process.execPath}' -e 'Bun.spawn(["sleep", "6"], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref()'`;
    const started = Date.now();
    const r = await runCheck(repo, `${detach}; echo started`, 10_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect([r.code, r.tail]).toEqual([0, ["started"]]);
  });

  it("runs checks with an allowlisted env: no backend credentials, but PATH and PWD (spec §4.7)", async () => {
    const { repo } = freshRun();
    Object.assign(process.env, {
      OPENAI_API_KEY: "sk-openai",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GH_TOKEN: "gh-token",
      TYPESAFE_API_KEY: "ts-secret",
    });
    const r = await runCheck(
      repo,
      "env | grep -E '^(PATH|PWD|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|GH_TOKEN|TYPESAFE_API_KEY)='",
      10_000,
    );
    expect(r.tail.map((l) => l.split("=")[0]).sort()).toEqual(["PATH", "PWD"]);
    expect(r.tail).toContain(`PWD=${repo}`);
  });

  it("runs a check in the login env and the repo's gate env (plan 23)", async () => {
    const { repo } = freshRun();
    const dir = tempDir("catherd-shell-");
    const shell = join(dir, "login");
    writeFileSync(shell, `#!/bin/sh\nprintf 'DOCKER_HOST=unix:///login/docker.sock\\0PATH=/login/bin\\0'\n`);
    chmodSync(shell, 0o755);
    process.env.SHELL = shell;
    resetLoginEnv();
    await setGateEnv(repo, "TESTCONTAINERS_RYUK_DISABLED", { value: "true" });
    const r = await runCheck(
      repo,
      'test "$DOCKER_HOST" = unix:///login/docker.sock && test "$TESTCONTAINERS_RYUK_DISABLED" = true && echo "${PATH%%:*}"',
      10_000,
      await checkEnvFor(repo),
    );
    resetLoginEnv();
    expect([r.code, r.tail]).toEqual([0, ["/login/bin"]]);
  });
});
