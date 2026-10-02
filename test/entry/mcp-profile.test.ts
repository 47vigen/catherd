import { fakeDispatch } from "../services/helpers.ts";
import { createRun } from "../../src/services/run-store.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { claudeAgentsDir } from "../../src/infra/paths.ts";
import { activate, createProfile, profileService, patchProfile } from "../../src/services/profile-service.ts";
import { getProfile, profilesDir } from "../../src/services/profile-store.ts";
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
        // spec 1.5 plan 24: an explicit validate also names what no worker rung clears
        {
          path: "roles.worker.rungs",
          message: expect.stringMatching(/^no worker rung clears repo_code logic, hard;/),
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
    createProfile("metered", undefined, "claude-code");
    profileService(() => ({ host: "claude-code", session: null, conflict: null })).set("metered", {
      billing: { codex: "metered" },
    });
    activate("metered", repo, "claude-code");
    const c = await mcpClient();
    const cost = async (args: object) =>
      (
        await call(c, "catalog_query", { backend: "codex", text: "gpt-6-sol", ...args })
      ).data.models[0].rungs.find((r: { rung: string }) => r.rung === "codex:gpt-6-sol#high").cost;
    expect([(await cost({ repo })).mode, (await cost({})).mode]).toEqual(["metered", "chatgpt-plan"]);
  });
});

describe("the profile tools without a name use the profile the repo runs on", () => {
  it("profile_set and profile_get edit and read the profile bound to `repo`; a path outside a repo is refused", async () => {
    withHome();
    const repo = realpathSync(tempRepo());
    createProfile("fast", undefined, "claude-code");
    activate("fast", repo, "claude-code");
    const c = await mcpClient();
    const set = await call(c, "profile_set", { repo, patch: { budget: { usd: 9 } } });
    expect(set.data.saved).toBe(true);
    expect([
      getProfile("fast", "claude-code").budget.usd,
      getProfile("default", "claude-code").budget.usd,
    ]).toEqual([9, undefined]);
    const got = await call(c, "profile_get", { repo });
    expect([got.data.active, got.data.here, got.data.profile.name, got.data.profile.budget.usd]).toEqual([
      "default",
      "fast",
      "fast",
      9,
    ]);
    expect((await call(c, "profile_validate", { repo })).data.valid).toBe(true);
    // a repo path outside any repository is refused, never taken for the global active profile
    for (const tool of ["profile_set", "profile_get", "profile_validate"]) {
      const r = await call(c, tool, { repo: "/", patch: { budget: { usd: 3 } } });
      expect(r.error?.code).toBe("E_IO_PATH");
    }
    expect([
      getProfile("fast", "claude-code").budget.usd,
      getProfile("default", "claude-code").budget.usd,
    ]).toEqual([9, undefined]);
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

it("unknown status/result reads remain available for newly omitted Codex defaults without ownership", async () => {
  withHome();
  expect(patchProfile("default", { budget: { usd: 8 } }, { host: "codex" }).saved).toBe(true);
  const repo = tempRepo();
  const run = createRun({ repo, title: "codex omitted", aLines: [], version: "test" });
  const d = await fakeDispatch(run, {}, { reply: "finished reply" });
  const c = await mcpClient(undefined, "catherd-unknown");
  const status = await call(c, "status", { run: run.id });
  expect(status.isError).toBe(false);
  expect(status.data.runs[0].warnings).toEqual([]);
  expect(status.data.runs[0].budget).not.toBeNull();
  expect((await call(c, "result", { run: run.id, name: d.admit.name })).isError).toBe(false);
  expect((await call(c, "profile_get")).isError).toBe(true);
  expect((await call(c, "profile_get", { raw: true })).data.roles.architect.rungs).toBeUndefined();
  expect(run.meta.startedBy ?? null).toBeNull();
});

it("request-local profile callback sees invalid request host rather than initialized connection host", async () => {
  withHome();
  const c = await mcpClient(undefined, "codex-mcp-client");
  expect((await call(c, "profile_get")).data.profile.roles.architect.rungs).toEqual([
    "codex:gpt-6.1-sol#high",
  ]);
  const r = await c.callTool({ name: "profile_get", arguments: {}, _meta: { threadId: "invalid" } });
  expect(r.isError).toBe(true);
  expect((r.structuredContent as { message: string }).message).toContain("host");
  const raw = await c.callTool({
    name: "profile_get",
    arguments: { raw: true },
    _meta: { threadId: "invalid" },
  });
  expect(raw.isError).not.toBe(true);
  expect((await call(c, "profile_get")).isError).toBe(false);
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
