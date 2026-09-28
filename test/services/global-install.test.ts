import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureGlobal,
  type GlobalInstallDeps,
  realGlobalInstall,
} from "../../src/services/global-install.ts";
import { snapshotEnv } from "../helpers.ts";

afterEach(snapshotEnv());

/** `onPath` before the install; `after` is what the catherd on PATH reports once it has run (default: the version). */
function deps(
  onPath: string | null,
  installs: { ok: boolean; output: string } = { ok: true, output: "" },
  after?: string | null,
) {
  const calls: string[] = [];
  let installed: string | null | undefined;
  const d: GlobalInstallDeps = {
    installedVersion: async () => {
      calls.push("version");
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
  it("does nothing when the catherd on PATH is this version", async () => {
    const { d, calls } = deps("1.1.0");
    const said: string[] = [];
    expect(await ensureGlobal("1.1.0", d, () => said.push("installing"))).toEqual({ state: "current" });
    expect(calls).toEqual(["version"]);
    expect(said).toEqual([]);
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
    expect(calls).toEqual(["version", "install 1.1.0", "version"]);
  });

  it("says which catherd PATH still finds when the install is not the one first on PATH", async () => {
    const { d } = deps("1.0.0", undefined, "1.0.0");
    expect(await ensureGlobal("1.1.0", d, () => {})).toEqual({ state: "shadowed", onPath: "1.0.0" });
    const none = deps(null, undefined, null).d;
    expect(await ensureGlobal("1.1.0", none, () => {})).toEqual({ state: "shadowed", onPath: null });
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

describe("realGlobalInstall.installedVersion", () => {
  const fakeCatherd = (body: string) => {
    const bin = mkdtempSync(join(tmpdir(), "catherd-global-"));
    writeFileSync(join(bin, "catherd"), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, "catherd"), 0o755);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
  };

  it("reads only stdout, so a warning on stderr does not hide the version", async () => {
    fakeCatherd('echo "warn: something" >&2\necho " 1.1.0 "');
    expect(await realGlobalInstall.installedVersion()).toBe("1.1.0");
  });

  it("is null when the catherd on PATH fails", async () => {
    fakeCatherd("echo 1.1.0\nexit 2");
    expect(await realGlobalInstall.installedVersion()).toBeNull();
  });
});
