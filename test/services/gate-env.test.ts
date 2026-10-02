import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import { loginEnv, parseEnv, resetLoginEnv } from "../../src/infra/login-env.ts";
import { admit } from "../../src/services/admission.ts";
import {
  gateEnvFile,
  gateEnvLines,
  readGateEnv,
  removeGateEnv,
  resolveGateEnv,
  setGateEnv,
} from "../../src/services/gate-env.ts";
import { snapshotEnv, tempDir } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, freshRun, testView } from "./helpers.ts";

afterEach(snapshotEnv());
afterEach(resetLoginEnv);

describe("the gate environment (plan 23)", () => {
  it("keeps values and references beside knowledge.md, one name each, and removes them", async () => {
    const { repo } = freshRun();
    await setGateEnv(repo, "DOCKER_HOST", { value: "unix:///Users/me/.orbstack/run/docker.sock" });
    await setGateEnv(repo, "HTTPS_PROXY", { value: "http://proxy:3128" });
    await setGateEnv(repo, "GITLAB_TOKEN", { from: "MY_GITLAB_TOKEN" });
    expect(gateEnvLines(await readGateEnv(repo))).toEqual([
      "DOCKER_HOST=unix:///Users/me/.orbstack/run/docker.sock",
      "GITLAB_TOKEN=$MY_GITLAB_TOKEN",
      "HTTPS_PROXY=http://proxy:3128",
    ]);
    expect(statSync(gateEnvFile(repo)).mode & 0o777).toBe(0o600);
    await removeGateEnv(repo, "HTTPS_PROXY");
    expect(Object.keys(await readGateEnv(repo))).toEqual(["DOCKER_HOST", "GITLAB_TOKEN"]);
  });

  it("refuses a secret-looking name by value, a bad name, and removing what is not set", async () => {
    const { repo } = freshRun();
    for (const call of [
      () => setGateEnv(repo, "NPM_TOKEN", { value: "npm_abc" }),
      () => setGateEnv(repo, "1BAD", { value: "x" }),
      () => setGateEnv(repo, "OK", { from: "not a name" }),
      () => removeGateEnv(repo, "NOPE"),
    ]) {
      const e = await call().then(
        () => null,
        (x: unknown) => x,
      );
      expect(isCatherdError(e) && e.code).toBe("E_INPUT_INVALID");
    }
    expect(existsSync(gateEnvFile(repo))).toBe(false);
  });

  it("refuses a name catherd sets itself, and a reference to one of catherd's secrets (plan 23 review I4)", async () => {
    const { repo } = freshRun();
    for (const name of [
      "CATHERD_ROLE",
      "CATHERD_DISPATCH_ID",
      "TESTCONTAINERS_SESSION_ID",
      "TMPDIR",
      "PWD",
      "PATH",
      "HOME",
      "CODEX_HOME",
      "GROK_HOME",
      "CLAUDE_CONFIG_DIR",
      "CURSOR_CONFIG_DIR",
      "XDG_CONFIG_HOME",
      "CATHERD_DATA_DIR",
    ]) {
      for (const entry of [{ value: "x" }, { from: "SOME_VAR" }]) {
        const e = await setGateEnv(repo, name, entry).then(
          () => null,
          (x: unknown) => x,
        );
        expect(isCatherdError(e) && e.code).toBe("E_INPUT_INVALID");
      }
    }
    const e = await setGateEnv(repo, "MY_KEY", { from: "TYPESAFE_API_KEY" }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(isCatherdError(e) && e.code).toBe("E_INPUT_INVALID");
    expect(existsSync(gateEnvFile(repo))).toBe(false);
  });

  it("resolves a reference from the env, else the login env, and names one neither holds", () => {
    const vars = {
      A: { value: "1" },
      B: { from: "SRC_B" },
      C: { from: "SRC_C" },
      D: { from: "SRC_D" },
    };
    expect(resolveGateEnv(vars, { SRC_B: "b" }, () => ({ SRC_C: "c" }))).toEqual({
      env: { A: "1", B: "b", C: "c" },
      missing: ["D"],
    });
  });

  it("puts the gate env into a verifier's spec, a secret by reference only, and none into a worker's", async () => {
    const { repo, run } = freshRun();
    Object.assign(process.env, withScenario({ reply: "VERDICT: PASS" }).env);
    process.env.PATH = simPath();
    await setGateEnv(repo, "DOCKER_HOST", { value: "unix:///tmp/docker.sock" });
    await setGateEnv(repo, "HTTPS_PROXY", { from: "MY_PROXY" });
    const view = testView();
    view.roles.verifier = { enabled: true, access: "full", rungs: ["codex:gpt-6-sol#high"] };
    const deps = fakeDeps({ view });
    const base = { brief: "b", rung: "codex:gpt-6-sol#high", thread: null, lane: null, failoverFrom: null };
    const v = await admit(deps, run, { ...base, role: "verifier", name: "verifier-M1" });
    const spec = JSON.parse(readFileSync(v.specPath, "utf8"));
    expect(spec.env.DOCKER_HOST).toBe("unix:///tmp/docker.sock");
    expect(spec.env.HTTPS_PROXY).toBeUndefined();
    expect(spec.envFrom).toEqual({ HTTPS_PROXY: "MY_PROXY" });
    const w = await admit(deps, run, { ...base, role: "reviewer", name: "reviewer-M1" });
    const plain = JSON.parse(readFileSync(w.specPath, "utf8"));
    expect(plain.env.DOCKER_HOST).toBeUndefined();
    expect(plain.envFrom).toBeUndefined();
  });
});

describe("the login environment (plan 23)", () => {
  it("is what $SHELL -lc env prints, captured once, without catherd's secrets", () => {
    const dir = tempDir("catherd-shell-");
    const shell = join(dir, "fake-shell");
    const count = join(dir, "count");
    writeFileSync(
      shell,
      `#!/bin/sh\necho x >> "${count}"\nprintf 'DOCKER_HOST=unix:///run/user/1000/docker.sock\\0TYPESAFE_API_KEY=tsk\\0MULTI=a\\nb\\0'\n`,
    );
    chmodSync(shell, 0o755);
    process.env.SHELL = shell;
    resetLoginEnv();
    expect(loginEnv()).toEqual({ DOCKER_HOST: "unix:///run/user/1000/docker.sock", MULTI: "a\nb" });
    loginEnv();
    expect(readFileSync(count, "utf8")).toBe("x\n");
  });

  it("is empty when the shell fails, and reads plain env lines too", () => {
    process.env.SHELL = "/nonexistent/shell";
    resetLoginEnv();
    expect(loginEnv()).toEqual({});
    expect(parseEnv("A=1\nB=x=y\n")).toEqual({ A: "1", B: "x=y" });
  });
});
