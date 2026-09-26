import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { claudeAgentsDir } from "../../src/infra/paths.ts";
import {
  activate,
  createProfile,
  getProfile,
  profileService,
  profilesDir,
} from "../../src/services/profile-service.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";

afterEach(snapshotEnv());

describe("the profile tools on the profile service", () => {
  it("profile_set stores every field spec §4.8 names, and returns the diff and the new sessions", async () => {
    withHome();
    const c = await mcpClient();
    const r = await call(c, "profile_set", {
      patch: {
        roles: { verifier: { access: "workspace-write", rungs: ["claude:claude-opus-5-5#medium"] } },
        billing: { opencode: "subscription" },
        jev: { use: "off" },
        harness: { "claude-code": { isolated: true } },
        failover: { "codex:gpt-6-sol#xhigh": null },
        budget: { usd: 20 },
        timeouts: { idleMin: 10, wallMin: 60 },
        preflight: { confirm: true },
      },
    });
    expect(r.isError).toBe(false);
    expect(r.data.saved).toBe(true);
    expect(r.data.newSessionNeededFor).toEqual([
      "catherd-default-architect-claude-opus-5-5-high",
      "catherd-default-verifier-claude-opus-5-5-medium",
    ]);
    expect(r.data.diff).toContainEqual({ path: "budget.usd", before: null, after: 20 });
    const file = JSON.parse(readFileSync(join(profilesDir(), "default.json"), "utf8"));
    expect([
      file.billing.opencode,
      file.jev,
      file.harness["claude-code"],
      file.timeouts,
      file.preflight,
    ]).toEqual([
      "subscription",
      { use: "off" },
      { isolated: true },
      { idleMin: 10, wallMin: 60 },
      { confirm: true },
    ]);
    expect(file.failover["codex:gpt-6-sol#xhigh"]).toBeUndefined();
    expect(
      readFileSync(join(claudeAgentsDir(), "catherd-default-verifier-claude-opus-5-5-medium.md"), "utf8"),
    ).toContain("disallowedTools: Agent");
  });

  it("refuses an unknown key or a flag-shaped rung as E_INPUT_INVALID, and saves nothing", async () => {
    withHome();
    const c = await mcpClient();
    for (const patch of [{ colour: "red" }, { roles: { worker: { rungs: ["codex:--yolo#high"] } } }]) {
      const r = await call(c, "profile_set", { patch });
      expect(r.error?.code).toBe("E_INPUT_INVALID");
    }
    expect((await call(c, "profile_get")).data.profiles).toEqual(["default"]);
  });

  it("profile_set returns errors and saves nothing when the result is invalid; profile_validate adds warnings", async () => {
    withHome();
    const c = await mcpClient();
    const bad = await call(c, "profile_set", { patch: { roles: { worker: { enabled: false } } } });
    expect([bad.data.saved, bad.data.errors[0].message]).toEqual([false, "the worker cannot be disabled"]);
    await call(c, "profile_set", { patch: { roles: { verifier: { access: "read-only" } } } });
    const v = await call(c, "profile_validate");
    expect(v.data).toEqual({
      valid: true,
      errors: [],
      warnings: [
        {
          path: "roles.verifier.access",
          message: "verifier runs read-only; catherd's default for it is full",
        },
      ],
    });
  });

  it("profile_get shows each role's access and its backend's enforcement", async () => {
    withHome();
    const r = await call(await mcpClient(), "profile_get");
    expect(r.data.profile.roles.reviewer).toEqual({
      enabled: true,
      access: "read-only",
      rungs: ["codex:gpt-6-sol#high"],
    });
    expect(r.data.enforcement).toMatchObject({ reviewer: "enforced", architect: "advisory" });
    expect(r.data.profile.isolated).toMatchObject({ codex: false, "claude-code": false, opencode: false });
  });

  it("catalog_query prices rungs with the active profile's billing", async () => {
    withHome();
    const c = await mcpClient();
    const cost = async () =>
      (await call(c, "catalog_query", { backend: "codex", text: "gpt-6-sol" })).data.models[0].rungs.find(
        (r: { rung: string }) => r.rung === "codex:gpt-6-sol#high",
      ).cost;
    expect((await cost()).mode).toBe("chatgpt-plan");
    await call(c, "profile_set", { patch: { billing: { codex: "metered" } } });
    expect((await cost()).mode).toBe("metered");
  });

  it("catalog_query prices rungs with the billing of the profile bound to `repo`", async () => {
    withHome();
    const repo = realpathSync(tempRepo());
    createProfile("metered");
    profileService().set("metered", { billing: { codex: "metered" } });
    activate("metered", repo);
    const c = await mcpClient();
    const cost = async (args: object) =>
      (
        await call(c, "catalog_query", { backend: "codex", text: "gpt-6-sol", ...args })
      ).data.models[0].rungs.find((r: { rung: string }) => r.rung === "codex:gpt-6-sol#high").cost;
    expect([(await cost({ repo })).mode, (await cost({})).mode]).toEqual(["metered", "chatgpt-plan"]);
  });
});

describe("the profile tools without a name use the profile the repo runs on", () => {
  it("profile_set and profile_get edit and read the profile bound to `repo`; outside a repo, the active one", async () => {
    withHome();
    const repo = realpathSync(tempRepo());
    createProfile("fast");
    activate("fast", repo);
    const c = await mcpClient();
    const set = await call(c, "profile_set", { repo, patch: { budget: { usd: 9 } } });
    expect(set.data.saved).toBe(true);
    expect([getProfile("fast").budget.usd, getProfile("default").budget.usd]).toEqual([9, undefined]);
    const got = await call(c, "profile_get", { repo });
    expect([got.data.active, got.data.here, got.data.profile.name, got.data.profile.budget.usd]).toEqual([
      "default",
      "fast",
      "fast",
      9,
    ]);
    expect((await call(c, "profile_validate", { repo })).data.valid).toBe(true);
    await call(c, "profile_set", { repo: "/", patch: { budget: { usd: 3 } } });
    expect([getProfile("fast").budget.usd, getProfile("default").budget.usd]).toEqual([9, 3]);
    const outside = await call(c, "profile_get", { repo: "/" });
    expect([outside.data.here, outside.data.profile.name]).toEqual(["default", "default"]);
  });

  it("refuses a profile name that does not exist as E_INPUT_INVALID, and profile_set still creates one", async () => {
    withHome();
    const c = await mcpClient();
    for (const tool of ["profile_get", "profile_validate"]) {
      const r = await call(c, tool, { name: "nope" });
      expect([r.error?.code, r.error?.message]).toEqual(["E_INPUT_INVALID", 'no profile named "nope"']);
    }
    expect((await call(c, "profile_set", { name: "nope", patch: {} })).data.saved).toBe(true);
    expect((await call(c, "profile_get", { name: "nope" })).data.profile.name).toBe("nope");
  });
});

describe("profileService().agentFor", () => {
  it("names the agent after the profile the repo runs on", () => {
    withHome();
    createProfile("fast");
    activate("fast", "/r/app");
    const p = profileService();
    expect(p.agentFor("/r/app", "architect", "claude:claude-opus-5-5#high")).toBe(
      "catherd-fast-architect-claude-opus-5-5-high",
    );
    expect(p.agentFor(null, "architect", "claude:claude-opus-5-5#high")).toBe(
      "catherd-default-architect-claude-opus-5-5-high",
    );
    expect(p.agentFor(null, "worker", "codex:gpt-6-sol#high")).toBeNull();
  });

  it("serves failover keys exactly as the profile stores them (plan-3 T9)", () => {
    withHome();
    profileService().set(undefined, {
      failover: { "claude-code:claude-opus-5-5#high": "codex:gpt-6-sol#high" },
    });
    expect(profileService().forRepo(null).failover["claude-code:claude-opus-5-5#high"]).toBe(
      "codex:gpt-6-sol#high",
    );
  });
});
