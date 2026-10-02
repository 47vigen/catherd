import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureGlobal,
  type GlobalInstallDeps,
  installLimits,
  versionLimits,
  realGlobalInstall,
  run,
} from "../../src/services/global-install.ts";
import { snapshotEnv } from "../helpers.ts";

afterEach(snapshotEnv());

/**
 * `global`: what bun's global bin catherd reports before the install; `onPath`: the first non-bunx catherd on
 * PATH before it; `after`: what that PATH catherd reports once the install ran (default: the version).
 */
function deps(
  global: string | null,
  installs: { ok: boolean; output: string } = { ok: true, output: "" },
  after?: string | null,
  onPath: string | null = global,
) {
  const calls: string[] = [];
  let installed: string | null | undefined;
  const d: GlobalInstallDeps = {
    globalVersion: async () => {
      calls.push("global");
      return installed === undefined ? global : installed;
    },
    pathVersion: async () => {
      calls.push("path");
      return installed === undefined ? onPath : installed;
    },
    install: async (v) => {
      calls.push(`install ${v}`);
      if (installs.ok) installed = after === undefined ? v : after;
      return installs;
    },
  };
  return { d, calls };
}

describe("ensureGlobal (spec 1.1 §12)", () => {
  it("does nothing when the catherd in bun's global bin is this version", async () => {
    const { d, calls } = deps("1.1.0");
    const said: string[] = [];
    expect(await ensureGlobal("1.1.0", d, () => said.push("installing"))).toEqual({ state: "current" });
    expect(calls).toEqual(["global", "path"]);
    expect(said).toEqual([]);
  });

  it("says shadowed, installing nothing, when it is current but an older catherd comes first on PATH", async () => {
    const { d, calls } = deps("1.1.0", undefined, undefined, "1.0.0");
    const said: string[] = [];
    expect(await ensureGlobal("1.1.0", d, () => said.push("installing"))).toEqual({
      state: "shadowed",
      onPath: "1.0.0",
    });
    expect([calls, said]).toEqual([["global", "path"], []]);
  });

  it("says it is installing before it resolves anything, installs this version, then checks PATH again", async () => {
    const { d, calls } = deps("1.0.0");
    const order: string[] = [];
    const install = d.install;
    d.install = async (v) => {
      order.push(`install ${v}`);
      return install(v);
    };
    expect(await ensureGlobal("1.1.0", d, () => order.push("installing"))).toEqual({ state: "installed" });
    expect(order).toEqual(["installing", "install 1.1.0"]);
    expect(calls).toEqual(["global", "install 1.1.0", "path"]);
  });

  it("says which catherd PATH still finds when the install is not the one first on PATH", async () => {
    const { d } = deps("1.0.0", undefined, "1.0.0");
    expect(await ensureGlobal("1.1.0", d, () => {})).toEqual({ state: "shadowed", onPath: "1.0.0" });
    const none = deps(null, undefined, null).d;
    expect(await ensureGlobal("1.1.0", none, () => {})).toEqual({ state: "shadowed", onPath: null });
  });

  it("installs when only another catherd (a bunx shim, say) on PATH is this version", async () => {
    const { d, calls } = deps(null, undefined, undefined, "1.1.0");
    expect(await ensureGlobal("1.1.0", d, () => {})).toEqual({ state: "installed" });
    expect(calls).toEqual(["global", "install 1.1.0", "path"]);
  });

  it("installs when no catherd is on PATH, and reports a failed install with its output", async () => {
    const { d } = deps(null, {
      ok: false,
      output: "error: GET https://registry.npmjs.org/catherd-cli - 503\n",
    });
    expect(await ensureGlobal("1.1.0", d, () => {})).toEqual({
      state: "failed",
      reason: "error: GET https://registry.npmjs.org/catherd-cli - 503",
    });
  });

  it("reports an install that throws as failed instead of rejecting", async () => {
    const { d } = deps(null);
    d.install = async () => {
      throw new Error("spawn bun ENOENT");
    };
    expect(await ensureGlobal("1.1.0", d, () => {})).toEqual({ state: "failed", reason: "spawn bun ENOENT" });
  });
});

/** a folder holding a `catherd` shell script with `body` */
function fakeCatherdDir(body: string, dir = mkdtempSync(join(tmpdir(), "catherd-global-"))): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "catherd"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, "catherd"), 0o755);
  return dir;
}

/** the folder `bunx catherd-cli@latest` puts first on PATH: its transient install's node_modules/.bin */
function bunxBin(version: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "catherd-bunx-"));
  return fakeCatherdDir(`echo ${version}`, join(tmp, "bunx-0-catherd-cli@latest", "node_modules", ".bin"));
}

describe("realGlobalInstall.globalVersion (Codex P1: under bunx, PATH finds bunx's own shim)", () => {
  it("asks bun's global bin, not PATH: a bunx shim at this version and an empty global bin install", async () => {
    const globalBin = mkdtempSync(join(tmpdir(), "catherd-global-empty-"));
    process.env.BUN_INSTALL_BIN = globalBin;
    process.env.PATH = `${bunxBin("1.1.0")}:${globalBin}:${join(process.execPath, "..")}:/usr/bin:/bin`;
    expect(await realGlobalInstall.globalVersion()).toBeNull();
    const installed: string[] = [];
    const d: GlobalInstallDeps = {
      ...realGlobalInstall,
      // what `bun add -g` does: the global bin gets this version's catherd (never the registry in a test)
      install: async (v) => {
        installed.push(v);
        fakeCatherdDir(`echo ${v}`, globalBin);
        return { ok: true, output: "" };
      },
    };
    expect(await ensureGlobal("1.1.0", d, () => {})).toEqual({ state: "installed" });
    expect(installed).toEqual(["1.1.0"]);
  });

  it("is current when the catherd in the global bin is this version", async () => {
    process.env.BUN_INSTALL_BIN = fakeCatherdDir("echo 1.1.0");
    process.env.PATH = `${process.env.BUN_INSTALL_BIN}:${join(process.execPath, "..")}:/usr/bin:/bin`;
    expect(await realGlobalInstall.globalVersion()).toBe("1.1.0");
    const d: GlobalInstallDeps = {
      ...realGlobalInstall,
      install: async () => {
        throw new Error("must not install");
      },
    };
    expect(await ensureGlobal("1.1.0", d, () => {})).toEqual({ state: "current" });
  });
});

describe("realGlobalInstall.pathVersion", () => {
  const onPath = (body: string) => {
    process.env.PATH = `${fakeCatherdDir(body)}:/usr/bin:/bin`;
  };

  it("reads only stdout, so a warning on stderr does not hide the version", async () => {
    onPath('echo "warn: something" >&2\necho " 1.1.0 "');
    expect(await realGlobalInstall.pathVersion()).toBe("1.1.0");
  });

  it("is null when the catherd on PATH fails", async () => {
    onPath("echo 1.1.0\nexit 2");
    expect(await realGlobalInstall.pathVersion()).toBeNull();
  });

  it("is null when the catherd on PATH does not answer within the probe's limit (Codex P2)", async () => {
    const was = versionLimits.timeoutMs;
    versionLimits.timeoutMs = 50;
    try {
      onPath("sleep 30\necho 1.1.0");
      expect(await realGlobalInstall.pathVersion()).toBeNull();
    } finally {
      versionLimits.timeoutMs = was;
    }
    expect(versionLimits.timeoutMs).toBe(10_000);
  });

  it("skips bunx's transient bin, so after the install it finds the catherd that stays", async () => {
    process.env.PATH = `${bunxBin("1.1.0")}:${fakeCatherdDir("echo 1.0.0")}:/usr/bin:/bin`;
    expect(await realGlobalInstall.pathVersion()).toBe("1.0.0");
    process.env.PATH = `${bunxBin("1.1.0")}:/usr/bin:/bin`;
    expect(await realGlobalInstall.pathVersion()).toBeNull();
  });
});

describe("the install's time limit (1.1 follow-ups)", () => {
  it("kills a command past its limit and reports it failed, without waiting on its output", async () => {
    const r = await run(["sh", "-c", "sleep 30"], 50);
    expect(r).toEqual({ ok: false, stdout: "", output: "-c sleep 30 timed out after 0 s" });
    expect(await run(["sh", "-c", "echo hi"], 5_000)).toEqual({ ok: true, stdout: "hi\n", output: "hi\n" });
    expect(installLimits.timeoutMs).toBe(120_000);
  });
});
