import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProfile, patchProfile, profilesDir } from "../../src/services/profile-service.ts";
import {
  defaultProfile,
  loadProfile,
  patchFromV0,
  saveProfile,
  validateProfile,
} from "../../src/tui/profile-shim.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

describe("the 0.x TUI's profile shim", () => {
  it("shows a 1.0 profile in the 0.x shape", () => {
    withHome();
    const p = loadProfile();
    expect(p.roles.worker).toEqual({
      enabled: true,
      models: { "gpt-6-luna": ["high"], "gpt-6-sol": ["medium", "high", "xhigh"] },
      defaultRung: "gpt-6-sol#medium",
    });
    expect(p.failover?.["gpt-6-sol#high"]).toBe("opencode-go/kimi-k3#max");
    expect(p.budget).toBeUndefined();
    expect(defaultProfile().roles.architect.models).toEqual({ "claude-opus-5-5": ["high"] });
  });

  it("saves through the profile service and keeps every 1.0 field the 0.x shape lacks", () => {
    withHome();
    patchProfile("default", {
      roles: { reviewer: { access: "full", rungs: ["claude-code:claude-opus-5-5#high"] } },
      jev: { use: "off" },
      harness: { "claude-code": { isolated: true } },
      timeouts: { idleMin: 7 },
    });
    const p0 = loadProfile();
    saveProfile({
      ...p0,
      objective: "speed",
      roles: { ...p0.roles, writer: { enabled: true, models: { "claude-opus-5-5": ["high"] } } },
    });
    const p = getProfile("default");
    expect(p.objective).toBe("speed");
    expect(p.roles.reviewer).toEqual({
      enabled: true,
      access: "full",
      rungs: ["claude-code:claude-opus-5-5#high"],
    });
    expect(p.roles.architect.rungs).toEqual(["claude:claude-opus-5-5#high"]);
    expect(p.roles.writer.rungs).toEqual(["claude-code:claude-opus-5-5#high"]);
    expect([p.jev.use, p.harness["claude-code"]?.isolated, p.timeouts.idleMin]).toEqual(["off", true, 7]);
    expect(JSON.parse(readFileSync(join(profilesDir(), "default.json"), "utf8")).schema).toBe(1);
  });

  it("keeps an interleaved ladder's order and each rung's backend when the TUI saves it unchanged", () => {
    withHome();
    const worker = ["codex:gpt-6-sol#medium", "codex:gpt-6-luna#high", "codex:gpt-6-sol#high"];
    const verifier = ["claude:claude-opus-5-5#high", "claude-code:claude-opus-5-5#low"];
    expect(
      patchProfile("default", { roles: { worker: { rungs: worker }, verifier: { rungs: verifier } } }).saved,
    ).toBe(true);
    saveProfile(loadProfile());
    const p = getProfile("default");
    expect([p.roles.worker.rungs, p.roles.verifier.rungs]).toEqual([worker, verifier]);
  });

  it("keeps a rung the 0.x shape cannot hold, in place, for validate to report", () => {
    withHome();
    const file = join(profilesDir(), "default.json");
    patchProfile("default", {});
    const doc = JSON.parse(readFileSync(file, "utf8"));
    const worker = ["codex:gpt-6-sol#medium", "not a rung", "codex:gpt-6-sol#high"];
    writeFileSync(
      file,
      JSON.stringify({ ...doc, roles: { ...doc.roles, worker: { ...doc.roles.worker, rungs: worker } } }),
    );
    expect(patchFromV0(loadProfile(), JSON.parse(readFileSync(file, "utf8"))).roles?.worker?.rungs).toEqual(
      worker,
    );
  });

  it("validates with the 1.0 rules, and refuses to save what they refuse", () => {
    withHome();
    const p0 = loadProfile();
    const bad = { ...p0, roles: { ...p0.roles, worker: { ...p0.roles.worker, enabled: false } } };
    expect(validateProfile(bad)).toContain("the worker cannot be disabled");
    expect(() => saveProfile(bad)).toThrow(/the worker cannot be disabled/);
  });
});
