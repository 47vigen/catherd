import { describe, expect, it } from "bun:test";
import {
  agentName,
  applyPatch,
  assertProfileName,
  BUILTIN_ROLES,
  DEFAULT_FAILOVER,
  DEFAULT_MAX_EFFORT,
  defaultProfileDoc,
  diffProfiles,
  LEGACY_DECISION,
  migrateProfileDoc,
  patchAt,
  patchBetween,
  ProfileDocSchema,
  ProfilePatchSchema,
  resolveProfile,
  roleTimeouts,
  unknownValues,
} from "../../src/domain/profile.ts";
import { validateProfile } from "../../src/domain/profile-rules.ts";
import { ROLES } from "../../src/domain/roles.ts";
import legacy from "../fixtures/profiles/legacy-1.5.json";
import { shipped } from "./shipped.ts";

describe("the default profile (spec §7.2)", () => {
  const p = resolveProfile(defaultProfileDoc(), "default", "claude-code");

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
      judge: ["claude-code:claude-opus-5-5#medium"],
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
      judge: "read-only",
    });
  });

  it("fails the worker rungs that have a fitting stand-in over to OpenCode Go, and writes out every field", () => {
    expect(p.failover).toEqual(DEFAULT_FAILOVER);
    for (const from of Object.keys(DEFAULT_FAILOVER)) expect(p.roles.worker.rungs).toContain(from);
    expect(Object.keys(defaultProfileDoc())).toEqual([
      "schema",
      "name",
      "billing",
      "roles",
      "harness",
      "failover",
      "maxEffort",
      "budget",
      "timeouts",
      "preflight",
      "land",
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
    const p = resolveProfile({ schema: 1 }, "bare", "claude-code");
    expect(p.roles).toEqual(BUILTIN_ROLES);
    expect([p.timeouts, p.preflight, p.lock, p.failover]).toEqual([
      { idleMin: 15, wallMin: 90 },
      { confirm: false },
      { heavy: "cpus/2" },
      {},
    ]);
    expect(p.harness["claude-code"]).toEqual({ isolated: false });
  });

  it("takes a partial role's missing fields from the built-in one, but not its default rung", () => {
    const p = resolveProfile(
      {
        schema: 1,
        roles: { verifier: { access: "read-only" }, worker: { rungs: ["codex:gpt-6-sol#high"] } },
      },
      "x",
      "claude-code",
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
    expect(resolveProfile(doc, "x", "claude-code").timeouts).toEqual({ idleMin: 5, wallMin: 90 });
    const after = applyPatch(doc, { timeouts: { wallMin: 60 }, roles: { worker: { access: "full" } } });
    expect(after).toEqual({
      schema: 1,
      theme: "ginger",
      roles: { tester: { enabled: true }, worker: { enabled: true, color: "red", access: "full" } },
      timeouts: { idleMin: 5, graceSec: 3, wallMin: 60 },
    });
  });
});

describe("values a newer catherd wrote (spec §3.4)", () => {
  const newer = ProfileDocSchema.parse({
    schema: 1,
    billing: { codex: "chatgpt-pro", cursor: "cursor-ultra" },
    roles: { worker: { access: "network-off" } },
    notify: ["finish", "every-lane"],
  });

  it("reads each one the cautious way instead of refusing the profile", () => {
    const p = resolveProfile(newer, "x", "claude-code");
    expect(p.billing).toMatchObject({ codex: "chatgpt-plan", cursor: "metered" });
    expect(p.roles.worker.access).toBe("read-only");
    expect(p.notify).toEqual(["finish"]);
  });

  it("names each one with what it is read as, and keeps it through a patch", () => {
    expect(unknownValues(newer)).toEqual([
      { path: "billing.codex", value: "chatgpt-pro", readAs: "chatgpt-plan" },
      { path: "billing.cursor", value: "cursor-ultra", readAs: "metered" },
      { path: "roles.worker.access", value: "network-off", readAs: "read-only" },
      { path: "notify", value: "every-lane", readAs: "skipped" },
    ]);
    expect(unknownValues(defaultProfileDoc())).toEqual([]);
    const after = applyPatch(newer, { budget: { usd: 5 } });
    expect(after).toMatchObject({
      billing: { codex: "chatgpt-pro" },
      notify: ["finish", "every-lane"],
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

describe("land.autoMerge", () => {
  it("land.autoMerge defaults to false", () => {
    expect(resolveProfile({ schema: 1 }, "bare", "claude-code").land).toEqual({ autoMerge: false });
    expect(resolveProfile({ schema: 1, land: {} }, "bare", "claude-code").land).toEqual({ autoMerge: false });
    expect(resolveProfile({ schema: 1, land: { autoMerge: true } }, "t", "claude-code").land).toEqual({
      autoMerge: true,
    });
    expect(ProfilePatchSchema.parse({ land: { autoMerge: true } })).toEqual({ land: { autoMerge: true } });
    expect(ProfilePatchSchema.safeParse({ land: { autoMerge: "yes" } }).success).toBe(false);
    expect(patchAt("land.autoMerge", "true")).toEqual({ land: { autoMerge: true } });
  });
});

describe("engine (plan 48: the switch is gone)", () => {
  it("reads a profile that still names an engine, and offers no engine key to set", () => {
    expect(resolveProfile({ schema: 1, engine: "2.0" }, "t", "claude-code")).not.toHaveProperty("engine");
    expect(unknownValues({ schema: 1, engine: "4.0" })).toEqual([]);
    expect(ProfilePatchSchema.safeParse({ engine: "architect" }).success).toBe(false);
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

  it("sets a role's own timeouts, which win over the profile's and come off with null (plan 23)", () => {
    const patch = patchAt("roles.verifier.timeouts.wallMin", "240");
    expect(patch).toEqual({ roles: { verifier: { timeouts: { wallMin: 240 } } } });
    const doc = applyPatch(defaultProfileDoc(), patch);
    const p = resolveProfile(doc, "default", "claude-code");
    expect(p.roles.verifier.timeouts).toEqual({ wallMin: 240 });
    expect(p.roles.worker.timeouts).toBeUndefined();
    expect(roleTimeouts(p, p.roles.verifier)).toEqual({ idleMin: 15, wallMin: 240 });
    expect(roleTimeouts(p, p.roles.worker)).toEqual({ idleMin: 15, wallMin: 90 });
    const cleared = applyPatch(doc, patchAt("roles.verifier.timeouts", "null"));
    expect(resolveProfile(cleared, "default", "claude-code").roles.verifier.timeouts).toBeUndefined();
    expect(() => patchAt("roles.verifier.timeouts.wallMin", "0")).toThrow("cannot set");
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
    const a = resolveProfile(defaultProfileDoc(), "a", "claude-code");
    const b = resolveProfile(
      applyPatch(defaultProfileDoc(), { budget: { usd: 5 }, roles: { verifier: { access: "read-only" } } }),
      "b",
      "claude-code",
    );
    expect(diffProfiles(a, b)).toEqual([
      { path: "budget.usd", before: null, after: 5 },
      { path: "roles.verifier.access", before: "full", after: "read-only" },
    ]);
  });
});

describe("patchBetween", () => {
  it("is the patch that turns one document into the other, and nothing else", () => {
    const a = { ...defaultProfileDoc(), theme: "ginger" } as ReturnType<typeof defaultProfileDoc>;
    const b = applyPatch(a, {
      budget: { usd: 5 },
      roles: { worker: { rungs: ["codex:gpt-6-sol#high"], defaultRung: null } },
      failover: { "codex:gpt-6-sol#medium": null },
      notify: ["finish"],
    });
    const p = patchBetween(a, b);
    expect(p).toEqual({
      budget: { usd: 5 },
      roles: { worker: { rungs: ["codex:gpt-6-sol#high"], defaultRung: null } },
      failover: { "codex:gpt-6-sol#medium": null },
      notify: ["finish"],
    });
    expect(applyPatch(a, p)).toEqual(b);
    expect(patchBetween(a, a)).toEqual({});
  });

  it("applies over a newer copy without undoing what changed there", () => {
    const base = defaultProfileDoc();
    const mine = applyPatch(base, { land: { autoMerge: true } });
    const theirs = applyPatch(base, { budget: { minutes: 30 } });
    const merged = applyPatch(theirs, patchBetween(base, mine));
    expect([merged.land, merged.budget]).toEqual([{ autoMerge: true }, { minutes: 30 }]);
  });

  it("refuses a change no patch may make", () => {
    const base = defaultProfileDoc();
    const bad = { ...base, roles: { ...base.roles, worker: { enabled: true, rungs: ["not a rung"] } } };
    expect(() => patchBetween(base, bad)).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
  });
});

describe("host defaults", () => {
  it("uses exact native host defaults without materializing rungs", () => {
    const doc = defaultProfileDoc();
    expect(doc.roles?.architect?.rungs).toBeUndefined();
    expect(resolveProfile(doc, "default", "codex").roles.architect.rungs).toEqual(["codex:gpt-6.1-sol#high"]);
    expect(resolveProfile(doc, "default", "codex").roles.verifier.rungs).toEqual(["codex:gpt-6.1-sol#low"]);
    expect(resolveProfile(doc, "default", "claude-code").roles.verifier.rungs).toEqual([
      "claude:claude-opus-5-5#low",
    ]);
    expect(() => resolveProfile(doc, "default", "unknown")).toThrow("host");
  });
});

describe("maxEffort", () => {
  it("sets, resolves and removes a model's maxEffort", () => {
    const set = patchAt("maxEffort.codex:gpt-6-sol", "high");
    expect(set).toEqual({ maxEffort: { "codex:gpt-6-sol": "high" } });
    const doc = applyPatch(defaultProfileDoc(), set);
    expect(resolveProfile(doc, "default", "claude-code").maxEffort).toEqual({
      ...DEFAULT_MAX_EFFORT,
      "codex:gpt-6-sol": "high",
    });
    expect(
      resolveProfile(applyPatch(doc, patchAt("maxEffort.codex:gpt-6-sol", "null")), "default", "claude-code")
        .maxEffort,
    ).toEqual(DEFAULT_MAX_EFFORT);
    expect(
      resolveProfile(
        applyPatch(doc, patchAt("maxEffort.codex:gpt-6.1-sol", "null")),
        "default",
        "claude-code",
      ).maxEffort,
    ).not.toHaveProperty("codex:gpt-6.1-sol");
    expect(() => patchAt("maxEffort.gpt-6-sol", "high")).toThrow("cannot set maxEffort.gpt-6-sol");
    expect(() => patchAt("maxEffort.codex:gpt-6-sol", "turbo")).toThrow("cannot set");
  });

  it("a fresh default profile carries the shipped effort caps", () => {
    expect(DEFAULT_MAX_EFFORT).toEqual({
      "claude:claude-opus-5-5": "high",
      "claude-code:claude-opus-5-5": "high",
      "opencode:opencode/claude-opus-5-5": "high",
      "claude:claude-sonnet-5-5": "high",
      "claude-code:claude-sonnet-5-5": "high",
      "opencode:opencode/claude-sonnet-5-5": "high",
      "codex:gpt-6.1-sol": "xhigh",
    });
    expect(resolveProfile(defaultProfileDoc(), "default", "claude-code").maxEffort).toEqual(
      DEFAULT_MAX_EFFORT,
    );
    expect(resolveProfile(ProfileDocSchema.parse({ schema: 1 }), "x", "claude-code").maxEffort).toEqual({});
  });

  it("reads a ceiling it does not know as no ceiling, and warns", () => {
    const doc = ProfileDocSchema.parse({ schema: 1, maxEffort: { "codex:gpt-6-sol": "turbo" } });
    expect(resolveProfile(doc, "x", "claude-code").maxEffort).toEqual({});
    expect(unknownValues(doc)).toContainEqual({
      path: "maxEffort.codex:gpt-6-sol",
      value: "turbo",
      readAs: "no ceiling",
    });
  });
});

describe("a stored maxEffort entry that is no effort word", () => {
  it("is ignored, keeps the file readable, and warns", () => {
    const doc = ProfileDocSchema.parse({
      schema: 1,
      maxEffort: {
        "claude-code:claude-opus-5-5": { x: 7 },
        "codex:gpt-6-sol": 7,
        "codex:gpt-6.1-sol": "high",
      },
    });
    expect(resolveProfile(doc, "x", "claude-code").maxEffort).toEqual({ "codex:gpt-6.1-sol": "high" });
    expect(unknownValues(doc)).toEqual([
      { path: "maxEffort.claude-code:claude-opus-5-5", value: '{"x":7}', readAs: "no ceiling" },
      { path: "maxEffort.codex:gpt-6-sol", value: "7", readAs: "no ceiling" },
    ]);
  });
});

describe("limits.memory", () => {
  it("sets, validates and removes the memory limits", () => {
    const doc = applyPatch(defaultProfileDoc(), patchAt("limits.memory.reserveMb", "4096"));
    expect(resolveProfile(doc, "x", "claude-code").limits).toEqual({ memory: { reserveMb: 4096 } });
    expect(resolveProfile(defaultProfileDoc(), "x", "claude-code").limits).toEqual({ memory: {} });
    expect(defaultProfileDoc().limits).toBeUndefined();
    const gone = applyPatch(doc, patchAt("limits.memory.reserveMb", "null"));
    expect(resolveProfile(gone, "x", "claude-code").limits.memory).toEqual({});
    for (const bad of ["0", "-1", "1.5"])
      expect(() => patchAt("limits.memory.reserveMb", bad)).toThrow("cannot set limits.memory.reserveMb");
    expect(() => patchAt("limits.memory.swapMb", "5")).toThrow("cannot set");
  });

  it("reads a stored value it cannot use as the default, and warns", () => {
    const doc = ProfileDocSchema.parse({
      schema: 1,
      limits: { memory: { reserveMb: "lots", floorMb: 1024 } },
    });
    expect(resolveProfile(doc, "x", "claude-code").limits.memory).toEqual({ floorMb: 1024 });
    expect(unknownValues(doc)).toContainEqual({
      path: "limits.memory.reserveMb",
      value: '"lots"',
      readAs: "the default",
    });
    const odd = ProfileDocSchema.parse({ schema: 1, limits: "x" });
    expect(resolveProfile(odd, "x", "claude-code").limits.memory).toEqual({});
  });
});

describe("the decision model in the profile (plan 44 D25)", () => {
  const old = ProfileDocSchema.parse(legacy);

  it("a 1.5 profile migrates to the decision model", () => {
    const { doc, notes } = migrateProfileDoc(old, true);
    expect(doc.jev).toBeUndefined();
    expect(doc.bars).toBeUndefined();
    expect(doc.objective).toBeUndefined();
    expect(doc.roles?.worker?.bars).toBeUndefined();
    expect(doc.decision).toEqual(LEGACY_DECISION);
    for (const field of ["jev", "bars", "roles.worker.bars", "objective"])
      expect(notes.some((n) => n.includes(field))).toBe(true);
    expect(old.jev).toBeDefined();
    expect(migrateProfileDoc(doc, true)).toEqual({ doc, notes: [] });
  });

  it("no key, no TypeSafe url", () => {
    expect(migrateProfileDoc(old, false).doc.decision).toBeUndefined();
    const own = { url: "https://decision.test/v1", model: "test-decider" };
    expect(migrateProfileDoc({ ...old, decision: own }, true).doc.decision).toEqual(own);
  });

  it("a profile whose Jev was off does not move to TypeSafe", () => {
    const off = { ...old, jev: { use: "off" } };
    const m = migrateProfileDoc(off, true);
    expect(m.doc.decision).toBeUndefined();
    expect(m.doc.jev).toBeUndefined();
  });

  it("decision.url must be https, or http on loopback", () => {
    for (const url of [
      "https://decision.test/v1",
      "http://127.0.0.1:8080/v1",
      "http://localhost/v1",
      "http://[::1]:1/v1",
    ])
      expect(ProfilePatchSchema.safeParse({ decision: { url } }).success).toBe(true);
    for (const url of [
      "http://decision.test/v1",
      "http://localhost.evil.test/v1",
      "http://127.0.0.1.evil.test/v1",
      "ftp://x/y",
    ])
      expect(ProfilePatchSchema.safeParse({ decision: { url } }).success).toBe(false);
  });

  it("drops a trailing slash from decision.url, and warns about a confidence it cannot use", () => {
    const doc = {
      schema: 1 as const,
      decision: { url: "https://decision.test/v1//", model: "m", minConfidence: 2 },
    };
    const p = resolveProfile(doc, "p", "claude-code");
    expect([p.decision.url, p.decision.minConfidence]).toEqual(["https://decision.test/v1", 0.8]);
    expect(unknownValues(doc)).toContainEqual({ path: "decision.minConfidence", value: "2", readAs: "0.8" });
  });

  it("a stored 1.5 profile still resolves", () => {
    const p = resolveProfile(old, "old", "claude-code");
    for (const field of ["jev", "bars", "objective"]) expect(p).not.toHaveProperty(field);
    expect(p.roles.worker).not.toHaveProperty("bars");
    expect(p.decision.url).toBeNull();
    expect(unknownValues(old)).toEqual([]);
  });

  it("the decision block resolves with its default confidence", () => {
    const doc = { schema: 1 as const, decision: { url: "https://decision.test/v1", model: "test-decider" } };
    expect(resolveProfile(doc, "p", "claude-code").decision).toEqual({ ...doc.decision, minConfidence: 0.8 });
    expect(resolveProfile({ schema: 1 }, "p", "claude-code").decision).toEqual({
      url: null,
      model: null,
      minConfidence: 0.8,
    });
  });

  it("a patch sets the decision model, http(s) urls only", () => {
    const set = patchAt("decision.url", "https://decision.test/v1");
    expect(applyPatch({ schema: 1 }, set).decision?.url).toBe("https://decision.test/v1");
    expect(() => patchAt("decision.url", "ftp://x")).toThrow();
    expect(() => patchAt("decision.minConfidence", "0.2")).toThrow();
  });
});

describe("Cursor retired (plan 45)", () => {
  it("a profile that names Cursor loads with its Cursor rungs and keys dropped, each with a note", () => {
    const old = ProfileDocSchema.parse({
      schema: 1,
      roles: {
        worker: { rungs: ["cursor:auto#default", "codex:gpt-6-sol#high"] },
        reviewer: { rungs: ["cursor:gpt-6#high"] },
      },
      failover: {
        "cursor:auto#default": "codex:gpt-6-sol#high",
        "codex:gpt-6-sol#high": "cursor:gpt-6#high",
      },
      billing: { codex: "plan", cursor: "metered" },
      harness: { cursor: { isolated: false } },
      maxEffort: { "cursor:claude-opus-5-5": "high" },
    });
    const { doc, notes } = migrateProfileDoc(old, false);
    expect(doc.roles?.worker?.rungs).toEqual(["codex:gpt-6-sol#high"]);
    expect(doc.roles?.reviewer).not.toHaveProperty("rungs");
    expect([doc.failover, doc.harness, doc.maxEffort]).toEqual([{}, {}, {}]);
    expect(doc.billing).toEqual({ codex: "plan" });
    expect(notes).toContain("dropped cursor:auto#default from roles.worker.rungs: Cursor is retired");
    expect(notes).toContain(
      "dropped roles.reviewer.rungs: its only rung was Cursor's, so the role takes the default",
    );
    expect(migrateProfileDoc(doc, false).notes).toEqual([]);
  });

  it("a Cursor defaultRung goes with its rung, whether Cursor was the only rung or one of several", () => {
    const old = applyPatch(defaultProfileDoc(), {
      decision: { url: "https://decision.test/v1", model: "test-decider" },
      roles: {
        worker: {
          rungs: [
            "codex:gpt-6-luna#high",
            "cursor:auto#default",
            "codex:gpt-6-sol#medium",
            "codex:gpt-6-sol#high",
            "codex:gpt-6-sol#xhigh",
          ],
          defaultRung: "cursor:auto#default",
        },
        reviewer: { rungs: ["cursor:gpt-6#high"], defaultRung: "cursor:gpt-6#high" },
      },
    });
    const { doc, notes } = migrateProfileDoc(old, false);
    expect(doc.roles?.worker).not.toHaveProperty("defaultRung");
    expect(doc.roles?.reviewer).not.toHaveProperty("defaultRung");
    expect(notes).toContain("dropped roles.worker.defaultRung: Cursor is retired");
    expect(notes).toContain("dropped roles.reviewer.defaultRung: Cursor is retired");
    const p = resolveProfile(doc, "p", "claude-code");
    expect(
      validateProfile(p, shipped(), ["codex", "claude-code", "opencode", "claude"], doc, "claude-code"),
    ).toEqual({
      errors: [],
      warnings: [],
    });
  });
});
