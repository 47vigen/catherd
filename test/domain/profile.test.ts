import { describe, expect, it } from "bun:test";
import {
  agentName,
  applyPatch,
  assertProfileName,
  BUILTIN_ROLES,
  DEFAULT_FAILOVER,
  defaultProfileDoc,
  diffProfiles,
  patchAt,
  ProfileDocSchema,
  ProfilePatchSchema,
  resolveProfile,
} from "../../src/domain/profile.ts";
import { ROLES } from "../../src/domain/roles.ts";

describe("the default profile (spec §7.2)", () => {
  const p = resolveProfile(defaultProfileDoc(), "default");

  it("places every role as the owner's setup does", () => {
    expect(Object.fromEntries(ROLES.map((r) => [r, p.roles[r].rungs]))).toEqual({
      architect: ["claude:claude-opus-5-5#high"],
      verifier: ["claude:claude-opus-5-5#low"],
      worker: [
        "codex:gpt-6-luna#high",
        "codex:gpt-6-sol#medium",
        "codex:gpt-6-sol#high",
        "codex:gpt-6-sol#xhigh",
      ],
      reviewer: ["codex:gpt-6-sol#high"],
      "ui-reviewer": ["codex:gpt-6-sol#medium"],
      artist: ["codex:gpt-6-sol#medium"],
      writer: ["codex:gpt-6-luna#high"],
      researcher: ["codex:gpt-6-luna#high"],
    });
    expect(p.roles.worker.defaultRung).toBe("codex:gpt-6-sol#medium");
  });

  it("gives each role its default access", () => {
    expect(Object.fromEntries(ROLES.map((r) => [r, p.roles[r].access]))).toEqual({
      architect: "read-only",
      verifier: "full",
      worker: "workspace-write",
      reviewer: "read-only",
      "ui-reviewer": "full",
      artist: "workspace-write",
      writer: "workspace-write",
      researcher: "read-only",
    });
  });

  it("fails every Codex rung over to OpenCode Go, and writes out every field", () => {
    expect(p.failover).toEqual(DEFAULT_FAILOVER);
    expect(Object.keys(DEFAULT_FAILOVER).sort()).toEqual([...new Set(p.roles.worker.rungs)].sort());
    expect(Object.keys(defaultProfileDoc())).toEqual([
      "schema",
      "name",
      "objective",
      "jev",
      "billing",
      "roles",
      "harness",
      "failover",
      "budget",
      "timeouts",
      "preflight",
      "lock",
      "notify",
    ]);
    expect(defaultProfileDoc().billing).toEqual({
      codex: "chatgpt-plan",
      claude: "claude-plan",
      "claude-code": "claude-plan",
      "opencode-go": "subscription",
      opencode: "metered",
    });
  });
});

describe("resolveProfile", () => {
  it("fills a bare document from the built-in roles and the spec defaults", () => {
    const p = resolveProfile({ schema: 1 }, "bare");
    expect(p.roles).toEqual(BUILTIN_ROLES);
    expect([p.objective, p.jev.use, p.timeouts, p.preflight, p.lock, p.failover]).toEqual([
      "cost",
      "auto",
      { idleMin: 15, wallMin: 90 },
      { confirm: false },
      { heavy: "cpus/2" },
      {},
    ]);
    expect(p.harness["claude-code"]).toEqual({ isolated: false });
    expect(p.billing.cursor).toBe("metered");
  });

  it("takes a partial role's missing fields from the built-in one, but not its default rung", () => {
    const p = resolveProfile(
      {
        schema: 1,
        roles: { verifier: { access: "read-only" }, worker: { rungs: ["codex:gpt-6-sol#high"] } },
      },
      "x",
    );
    expect(p.roles.verifier).toEqual({ ...BUILTIN_ROLES.verifier, access: "read-only" });
    expect(p.roles.worker).toEqual({
      enabled: true,
      access: "workspace-write",
      rungs: ["codex:gpt-6-sol#high"],
    });
  });

  it("reads a document with fields and roles it does not know, and keeps them through a patch", () => {
    const doc = ProfileDocSchema.parse({
      schema: 1,
      theme: "ginger",
      roles: { tester: { enabled: true }, worker: { enabled: true, color: "red" } },
      timeouts: { idleMin: 5, graceSec: 3 },
    });
    expect(resolveProfile(doc, "x").timeouts).toEqual({ idleMin: 5, wallMin: 90 });
    const after = applyPatch(doc, { timeouts: { wallMin: 60 }, roles: { worker: { access: "full" } } });
    expect(after).toEqual({
      schema: 1,
      theme: "ginger",
      roles: { tester: { enabled: true }, worker: { enabled: true, color: "red", access: "full" } },
      timeouts: { idleMin: 5, graceSec: 3, wallMin: 60 },
    });
  });
});

describe("applyPatch", () => {
  it("replaces lists, merges maps, and deletes a key patched to null", () => {
    const doc = defaultProfileDoc();
    const after = applyPatch(doc, {
      roles: { worker: { rungs: ["codex:gpt-6-sol#high"], defaultRung: null } },
      failover: {
        "codex:gpt-6-sol#high": null,
        "codex:gpt-6-sol#medium": "claude-code:claude-sonnet-5#high",
      },
      budget: { usd: 5 },
      billing: { opencode: null },
    });
    expect(after.roles?.worker).toEqual({
      enabled: true,
      access: "workspace-write",
      rungs: ["codex:gpt-6-sol#high"],
    });
    expect(after.failover?.["codex:gpt-6-sol#high"]).toBeUndefined();
    expect(after.failover?.["codex:gpt-6-sol#medium"]).toBe("claude-code:claude-sonnet-5#high");
    expect(after.budget).toEqual({ usd: 5 });
    expect(after.billing?.opencode).toBeUndefined();
    expect(doc.budget).toEqual({});
  });
});

describe("ProfilePatchSchema", () => {
  it("refuses unknown keys at every level, and flag-shaped rungs", () => {
    for (const bad of [
      { colour: "red" },
      { roles: { worker: { model: "x" } } },
      { roles: { chef: { enabled: true } } },
      { harness: { codex: { isolated: true, extra: 1 } } },
      { failover: { "codex:gpt-6-sol#high": "codex:--yolo#high" } },
      { budget: { usd: -1 } },
    ])
      expect(ProfilePatchSchema.safeParse(bad).success).toBe(false);
  });

  it("takes every field spec §4.8 names", () => {
    const patch = {
      objective: "speed",
      jev: { use: "off" },
      billing: { codex: "metered" },
      roles: {
        reviewer: { enabled: true, access: "full", rungs: ["codex:gpt-6-sol#high"], defaultRung: null },
      },
      harness: { "claude-code": { isolated: true } },
      failover: { "codex:gpt-6-sol#high": "opencode:opencode-go/kimi-k3#max" },
      budget: { minutes: 30, tokens: null },
      timeouts: { idleMin: 5, wallMin: 60 },
      preflight: { confirm: true },
      lock: { heavy: 2 },
      notify: ["finish"],
    };
    expect(ProfilePatchSchema.parse(patch)).toEqual(patch as never);
  });
});

describe("patchAt", () => {
  it("builds a patch from a path and a JSON or plain value", () => {
    expect(patchAt("roles.verifier.access", "read-only")).toEqual({
      roles: { verifier: { access: "read-only" } },
    });
    expect(patchAt("budget.usd", "5")).toEqual({ budget: { usd: 5 } });
    expect(patchAt("budget.usd", "null")).toEqual({ budget: { usd: null } });
    expect(patchAt("preflight.confirm", "true")).toEqual({ preflight: { confirm: true } });
    expect(patchAt("harness.claude-code.isolated", "true")).toEqual({
      harness: { "claude-code": { isolated: true } },
    });
    expect(patchAt("notify", "finish,blocked")).toEqual({ notify: ["finish", "blocked"] });
  });

  it("keeps a rung key with dots whole, and splits a comma-separated rung list", () => {
    expect(patchAt("failover.codex:gpt-5.6-sol#high", "opencode:opencode-go/gpt-5.6-luna#max")).toEqual({
      failover: { "codex:gpt-5.6-sol#high": "opencode:opencode-go/gpt-5.6-luna#max" },
    });
    expect(patchAt("roles.worker.rungs", "codex:gpt-6-sol#high, codex:gpt-6-sol#xhigh")).toEqual({
      roles: { worker: { rungs: ["codex:gpt-6-sol#high", "codex:gpt-6-sol#xhigh"] } },
    });
  });

  it("refuses an unknown path or a bad value with E_INPUT_INVALID and a fix", () => {
    for (const [path, value] of [
      ["roles.worker.colour", "red"],
      ["timeouts.idleMin", "soon"],
      ["roles..access", "full"],
      ["failover.", "codex:gpt-6-sol#high"],
    ] as const) {
      expect(() => patchAt(path, value)).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
    }
  });
});

describe("names", () => {
  it("names a native agent after the profile, role, model and effort", () => {
    expect(agentName("default", "architect", "claude:claude-opus-5-5#high")).toBe(
      "catherd-default-architect-claude-opus-5-5-high",
    );
    expect(agentName("fast", "verifier", "claude:claude-haiku-4-5-20251001#default")).toBe(
      "catherd-fast-verifier-claude-haiku-4-5-20251001-default",
    );
  });

  it("takes lowercase profile names only, since they become agent names", () => {
    expect(assertProfileName("team-2")).toBe("team-2");
    for (const bad of ["Team", "-x", "a b", "", "x".repeat(33), "a_b"])
      expect(() => assertProfileName(bad)).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
  });
});

describe("diffProfiles", () => {
  it("lists each changed leaf with its before and after", () => {
    const a = resolveProfile(defaultProfileDoc(), "a");
    const b = resolveProfile(
      applyPatch(defaultProfileDoc(), { budget: { usd: 5 }, roles: { verifier: { access: "read-only" } } }),
      "b",
    );
    expect(diffProfiles(a, b)).toEqual([
      { path: "budget.usd", before: null, after: 5 },
      { path: "roles.verifier.access", before: "full", after: "read-only" },
    ]);
  });
});
