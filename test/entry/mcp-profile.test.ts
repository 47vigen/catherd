import { createRun } from "../../src/services/run-store.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { claudeAgentsDir } from "../../src/infra/paths.ts";
import { activate, createProfile, profileService, patchProfile } from "../../src/services/profile-service.ts";
import { getProfile, profilesDir } from "../../src/services/profile-store.ts";
import { routingService } from "../../src/services/routing-service.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";

afterEach(snapshotEnv());

const HOST = { host: "claude-code", session: null, conflict: null } as const;

describe("the profile tools on the profile service", () => {
  it("the profile tool stores every field spec §4.8 names, and returns the diff and the new sessions", async () => {
    withHome();
    const c = await mcpClient();
    const r = await call(c, "profile", {
      action: "set",
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
      const r = await call(c, "profile", { action: "set", patch });
      expect(r.error?.code).toBe("E_INPUT_INVALID");
    }
    expect((await call(c, "profile", { action: "get" })).data.profiles).toEqual(["default"]);
  });

  it("the profile tool returns errors and saves nothing when the result is invalid; validate adds warnings", async () => {
    withHome();
    const c = await mcpClient();
    const bad = await call(c, "profile", { action: "set", patch: { roles: { worker: { enabled: false } } } });
    expect([bad.data.saved, bad.data.errors[0].message]).toEqual([false, "the worker cannot be disabled"]);
    await call(c, "profile", { action: "set", patch: { roles: { verifier: { access: "read-only" } } } });
    const v = await call(c, "profile", { action: "validate" });
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

  it("the profile tool shows each role's access and its backend's enforcement", async () => {
    withHome();
    const r = await call(await mcpClient(), "profile", { action: "get" });
    expect(r.data.profile.roles.reviewer).toEqual({
      enabled: true,
      access: "read-only",
      rungs: ["codex:gpt-6-sol#high"],
    });
    expect(r.data.enforcement).toMatchObject({ reviewer: "enforced", architect: "advisory" });
    expect(r.data.profile.isolated).toMatchObject({ codex: false, "claude-code": false, opencode: false });
  });

  it("the routing catalog prices rungs with the active profile's billing", () => {
    withHome();
    const profiles = profileService(() => HOST);
    const cost = () =>
      // oxlint-disable-next-line typescript/no-explicit-any
      (
        routingService().catalog(
          { backend: "codex", text: "gpt-6.1-sol", limit: 50 },
          profiles.forRepo(null).billing,
        ).models[0] as any
      ).rungs.find((r: { rung: string }) => r.rung === "codex:gpt-6.1-sol#high").cost;
    expect(cost().mode).toBe("chatgpt-plan");
    profiles.set(undefined, { billing: { codex: "metered" } });
    expect(cost().mode).toBe("metered");
  });
});

describe("the profile tools without a name use the profile the repo runs on", () => {
  it("the profile tool edits and reads the profile bound to `repo`; a path outside a repo is refused", async () => {
    withHome();
    const repo = realpathSync(tempRepo());
    createProfile("fast", undefined, "claude-code");
    activate("fast", repo, "claude-code");
    const c = await mcpClient();
    const set = await call(c, "profile", { action: "set", repo, patch: { budget: { usd: 9 } } });
    expect(set.data.saved).toBe(true);
    expect([
      getProfile("fast", "claude-code").budget.usd,
      getProfile("default", "claude-code").budget.usd,
    ]).toEqual([9, undefined]);
    const got = await call(c, "profile", { action: "get", repo });
    expect([got.data.active, got.data.here, got.data.profile.name, got.data.profile.budget.usd]).toEqual([
      "default",
      "fast",
      "fast",
      9,
    ]);
    expect((await call(c, "profile", { action: "validate", repo })).data.valid).toBe(true);
    // a repo path outside any repository is refused, never taken for the global active profile
    for (const action of ["set", "get", "validate"]) {
      const r = await call(c, "profile", { action, repo: "/", patch: { budget: { usd: 3 } } });
      expect(r.error?.code).toBe("E_IO_PATH");
    }
    expect([
      getProfile("fast", "claude-code").budget.usd,
      getProfile("default", "claude-code").budget.usd,
    ]).toEqual([9, undefined]);
  });

  it("refuses a profile name that does not exist as E_INPUT_INVALID, and set still creates one", async () => {
    withHome();
    const c = await mcpClient();
    for (const action of ["get", "validate"]) {
      const r = await call(c, "profile", { action, name: "nope" });
      expect([r.error?.code, r.error?.message]).toEqual(["E_INPUT_INVALID", 'no profile named "nope"']);
    }
    expect((await call(c, "profile", { action: "set", name: "nope", patch: {} })).data.saved).toBe(true);
    expect((await call(c, "profile", { action: "get", name: "nope" })).data.profile.name).toBe("nope");
  });
});

describe("profileService().agentFor", () => {
  it("names the agent after the profile the repo runs on", () => {
    withHome();
    createProfile("fast", undefined, "claude-code");
    activate("fast", "/r/app", "claude-code");
    const p = profileService(() => ({ host: "claude-code", session: null, conflict: null }));
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
    profileService(() => ({ host: "claude-code", session: null, conflict: null })).set(undefined, {
      failover: { "claude-code:claude-opus-5-5#high": "codex:gpt-6-sol#high" },
    });
    expect(
      profileService(() => ({ host: "claude-code", session: null, conflict: null })).forRepo(null).failover[
        "claude-code:claude-opus-5-5#high"
      ],
    ).toBe("codex:gpt-6-sol#high");
  });
});

it("unknown status reads remain available for newly omitted Codex defaults without ownership", async () => {
  withHome();
  expect(patchProfile("default", { budget: { usd: 8 } }, { host: "codex" }).saved).toBe(true);
  const repo = tempRepo();
  const run = createRun({ repo, title: "codex omitted", aLines: [], version: "test" });
  const c = await mcpClient(undefined, "catherd-unknown");
  const status = await call(c, "status", { run: run.id });
  expect(status.isError).toBe(false);
  expect(status.data.runs[0]).toMatchObject({ id: run.id, engine: "1.5" });
  expect((await call(c, "profile", { action: "get" })).isError).toBe(true);
  expect(run.meta.startedBy ?? null).toBeNull();
});

it("request-local profile callback sees invalid request host rather than initialized connection host", async () => {
  withHome();
  const c = await mcpClient(undefined, "codex-mcp-client");
  expect((await call(c, "profile", { action: "get" })).data.profile.roles.architect.rungs).toEqual([
    "codex:gpt-6.1-sol#high",
  ]);
  const r = await c.callTool({
    name: "profile",
    arguments: { action: "get" },
    _meta: { threadId: "invalid" },
  });
  expect(r.isError).toBe(true);
  expect((r.structuredContent as { message: string }).message).toContain("host");
  expect((await call(c, "profile", { action: "get" })).isError).toBe(false);
});

it("status reports request-scoped unknown/conflicting host without adopting an owner", async () => {
  withHome();
  const repo = tempRepo();
  const run = createRun({ repo, title: "status", aLines: [], version: "test" });
  const c = await mcpClient(undefined, "codex-mcp-client");
  const r = await c.callTool({ name: "status", arguments: { run: run.id }, _meta: { threadId: "invalid" } });
  expect(r.isError).not.toBe(true);
  expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toMatchObject({
    host: { host: "unknown", session: null, conflict: expect.any(String) },
    queue: null,
  });
  const { runOwner } = await import("../../src/services/sessions.ts");
  expect(runOwner(run)).toBeNull();
});
