import { describe, expect, it } from "bun:test";
import { ensureGlobal, type GlobalInstallDeps } from "../../src/services/global-install.ts";

function deps(onPath: string | null, installs: { ok: boolean; output: string } = { ok: true, output: "" }) {
  const calls: string[] = [];
  const d: GlobalInstallDeps = {
    installedVersion: async () => {
      calls.push("version");
      return onPath;
    },
    install: async (v) => {
      calls.push(`install ${v}`);
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

  it("says it is installing before it resolves anything, then installs this version", async () => {
    const { d, calls } = deps("1.0.0");
    const order: string[] = [];
    d.install = async (v) => {
      order.push(`install ${v}`);
      return { ok: true, output: "" };
    };
    expect(await ensureGlobal("1.1.0", d, () => order.push("installing"))).toEqual({ state: "installed" });
    expect(order).toEqual(["installing", "install 1.1.0"]);
    expect(calls).toEqual(["version"]);
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
});
