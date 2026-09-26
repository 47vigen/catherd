import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toRung0, toRung1, v0Profiles } from "../../src/bridge/v0.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import { configDir } from "../../src/infra/paths.ts";
import { defaultProfile } from "../../src/profile/profile.ts";
import { loadCatalog } from "../../src/routing/catalog.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const LUNA_LADDER = [
  "codex:gpt-6-luna#high",
  "codex:gpt-6-sol#medium",
  "codex:gpt-6-sol#high",
  "codex:gpt-6-sol#xhigh",
];
describe("v0 bridge: rungs", () => {
  it("names each rung's backend from the catalog, and back", () => {
    withHome();
    const c = loadCatalog();
    expect(toRung1(c, "gpt-6-sol#high")).toBe("codex:gpt-6-sol#high");
    expect(toRung1(c, "claude-opus-5-5#high")).toBe("claude:claude-opus-5-5#high");
    expect(toRung1(c, "someprovider/some-model#default")).toBe("opencode:someprovider/some-model#default");
    expect(toRung0("opencode:opencode-go/kimi-k3#default")).toBe("opencode-go/kimi-k3#default");
  });

  it("names a Claude model's headless backend when asked, and leaves other backends alone", () => {
    withHome();
    const c = loadCatalog();
    expect(toRung1(c, "claude-opus-5-5#high", "claude-code")).toBe("claude-code:claude-opus-5-5#high");
    expect(toRung1(c, "gpt-6-sol#high", "claude-code")).toBe("codex:gpt-6-sol#high");
  });
});

describe("v0 bridge: native or headless Claude (spec D3)", () => {
  it("keeps architect and verifier native, runs any other role's Claude rungs headless, and dispatches stand-ins", () => {
    withHome();
    const p = v0Profiles();
    const saved = p.set(undefined, {
      roles: { reviewer: { rungs: ["codex:gpt-6-sol#high", "claude-code:claude-opus-5-5#high"] } },
      failover: { "codex:gpt-6-sol#medium": "claude:claude-opus-5-5#high" },
    });
    expect(saved.errors).toEqual([]);
    const v = p.forRepo(null);
    expect(v.roles.architect?.rungs).toEqual(["claude:claude-opus-5-5#high"]);
    expect(v.roles.verifier?.rungs.every((r) => r.startsWith("claude:"))).toBe(true);
    expect(v.roles.reviewer?.rungs).toContain("claude-code:claude-opus-5-5#high");
    expect(v.failover).toEqual({ "codex:gpt-6-sol#medium": "claude-code:claude-opus-5-5#high" });
  });
});

describe("v0 bridge: profiles", () => {
  it("views the default profile with 1.0 rungs, access defaults and timeouts", () => {
    withHome();
    const v = v0Profiles().forRepo(null);
    expect(v.name).toBe("default");
    expect(v.objective).toBe("cost");
    expect(v.jev).toEqual({ use: "auto" });
    expect(v.billing).toEqual({});
    expect(v.roles.worker).toEqual({
      enabled: true,
      access: "workspace-write",
      rungs: LUNA_LADDER,
      defaultRung: "codex:gpt-6-sol#medium",
    });
    expect(v.roles.architect?.rungs).toEqual(["claude:claude-opus-5-5#high"]);
    expect(v.roles.verifier?.access).toBe("full");
    expect(v.timeouts).toEqual({ idleMin: 15, wallMin: 90 });
    expect(v.budget).toEqual({});
  });

  it("saves failover and budget from a 1.0 patch, and refuses a same-backend stand-in", () => {
    withHome();
    const p = v0Profiles();
    const bad = p.set(undefined, { failover: { "codex:gpt-6-sol#medium": "codex:gpt-6-sol#high" } });
    expect(bad.saved).toBe(false);
    expect(bad.errors.join()).toContain("same backend");

    const ok = p.set(undefined, {
      budget: { tokens: 5000 },
      roles: {
        worker: {
          rungs: ["codex:gpt-6-sol#medium", "codex:gpt-6-sol#high"],
          defaultRung: "codex:gpt-6-sol#medium",
        },
      },
    });
    expect(ok.saved).toBe(true);
    const file = JSON.parse(readFileSync(join(configDir(), "profiles", "default.json"), "utf8"));
    expect(file.budget).toEqual({ tokens: 5000 });
    expect(file.roles.worker.models).toEqual({ "gpt-6-sol": ["medium", "high"] });
    expect(p.forRepo(null).roles.worker?.rungs).toEqual(["codex:gpt-6-sol#medium", "codex:gpt-6-sol#high"]);
    expect(p.validate().valid).toBe(true);
  });

  it("reads a failover map written to the profile file in 1.0 form", () => {
    withHome();
    mkdirSync(join(configDir(), "profiles"), { recursive: true });
    writeFileSync(
      join(configDir(), "profiles", "default.json"),
      JSON.stringify({ ...defaultProfile(), failover: { "gpt-6-sol#medium": "gpt-6-sol#high" } }),
    );
    expect(v0Profiles().forRepo(null).failover).toEqual({ "codex:gpt-6-sol#medium": "codex:gpt-6-sol#high" });
  });

  it("turns a missing profile into E_CONFIG_INVALID", () => {
    withHome();
    try {
      v0Profiles().get("nope");
      throw new Error("expected a throw");
    } catch (e) {
      expect(isCatherdError(e) && e.code).toBe("E_CONFIG_INVALID");
    }
  });
});

describe("v0 bridge: agents", () => {
  it("names the native agent of a claude rung only", () => {
    const p = v0Profiles();
    expect(p.agentFor("architect", "claude:claude-opus-5-5#high")).toBe(
      "catherd-architect-claude-opus-5-5-high",
    );
    expect(p.agentFor("worker", "codex:gpt-6-sol#high")).toBeNull();
  });
});
