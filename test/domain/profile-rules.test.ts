import { describe, expect, it } from "bun:test";
import {
  applyPatch,
  defaultProfileDoc,
  patchAt,
  type ProfilePatch,
  ProfileDocSchema,
  resolveProfile,
} from "../../src/domain/profile.ts";
import { repairs, routingProfileOf, validateProfile } from "../../src/domain/profile-rules.ts";
import { indexOf, shipped } from "./shipped.ts";

const BACKENDS = ["codex", "claude-code", "opencode", "claude"];
const catalog = (o: Parameters<typeof shipped>[0] = {}) => shipped(o);
const check = (patch: ProfilePatch = {}, c = catalog()) =>
  validateProfile(
    resolveProfile(applyPatch(defaultProfileDoc(), patch), "p", "claude-code"),
    c,
    BACKENDS,
    undefined,
    "claude-code",
  );
const messages = (issues: { message: string }[]) => issues.map((i) => i.message);

describe("validateProfile", () => {
  it("reads a stored profile with a Grok rung and harness, and validate names the rung", () => {
    const doc = {
      ...defaultProfileDoc(),
      harness: { grok: { isolated: true } },
      roles: { worker: { rungs: ["grok:grok-4.7#high", "codex:gpt-6-sol#high"] } },
    };
    const p = resolveProfile(ProfileDocSchema.parse(doc), "x", "codex");
    const v = validateProfile(p, catalog(), [...BACKENDS]);
    expect(v.errors.map((e) => e.message)).toContain('"grok:grok-4.7#high" is not a rung');
  });

  it("passes the default profile with no error and no warning", () => {
    expect(check()).toEqual({ errors: [], warnings: [] });
  });

  it("refuses a disabled worker", () => {
    expect(check({ roles: { worker: { enabled: false } } }).errors).toContainEqual({
      path: "roles.worker.enabled",
      message: "the worker cannot be disabled",
      fix: "catherd profile set roles.worker.enabled true",
    });
  });

  it("refuses an enabled role with no usable rung, and ignores a disabled one", () => {
    expect(messages(check({ roles: { writer: { rungs: [] } } }).errors)).toEqual([
      "the writer role has no usable rung",
    ]);
    expect(check({ roles: { writer: { rungs: [], enabled: false } } }).errors).toEqual([]);
  });

  it("rejects a rung with no index and names the pair; doctor's option makes it a warning", () => {
    const rung = "codex:gpt-6-sol#xhigh";
    const c = catalog({
      index: indexOf({
        "gpt-6-sol#high": 42,
        "gpt-6-sol#medium": 40,
        "gpt-6-luna#high": 33,
        "claude-opus-5-5#high": 53,
      }),
      listed: {
        codex: {
          fetchedAt: "2026-10-13T00:00:00Z",
          models: [
            { id: "gpt-6-sol", efforts: ["medium", "high", "xhigh"], context: null, imageIn: true },
            { id: "gpt-6-luna", efforts: ["high"], context: null, imageIn: true },
          ],
        },
      },
    });
    const patch = { roles: { reviewer: { rungs: ["codex:gpt-6-sol#high", rung] } } };
    const p = resolveProfile(applyPatch(defaultProfileDoc(), patch), "p", "claude-code");
    const v = validateProfile(p, c, BACKENDS, undefined, "claude-code");
    const issue = {
      path: "roles.reviewer.rungs",
      message: `${rung} has no Slopalytics intelligence index: routing skips it`,
      fix: "pick an indexed pair: catherd catalog list --role reviewer",
    };
    expect(v.errors).toContainEqual(issue);
    const soft = validateProfile(p, c, BACKENDS, undefined, "claude-code", { unindexed: "warning" });
    expect(soft.errors.some((e) => e.message === issue.message)).toBe(false);
    expect(soft.warnings).toContainEqual(issue);
  });

  it("a role whose rungs are all unindexed has no usable rung: an error, and in doctor's mode a warning", () => {
    const rung = "opencode:opencode-go/mystery-1#high";
    const c = catalog({
      listed: {
        opencode: {
          fetchedAt: "2026-10-13T00:00:00Z",
          models: [{ id: "opencode-go/mystery-1", efforts: ["high"], context: null, imageIn: true }],
        },
      },
    });
    const p = resolveProfile(
      applyPatch(defaultProfileDoc(), { roles: { reviewer: { rungs: [rung] } } }),
      "p",
      "claude-code",
    );
    const none = "the reviewer role has no usable rung";
    const strict = validateProfile(p, c, BACKENDS, undefined, "claude-code");
    expect(messages(strict.errors)).toContain(none);
    const soft = validateProfile(p, c, BACKENDS, undefined, "claude-code", { unindexed: "warning" });
    expect(messages(soft.errors)).not.toContain(none);
    expect(messages(soft.warnings)).toContain(none);
    expect(soft.errors).toEqual([]);
  });

  it("with no index at all, a role of unindexed rungs stays an error even in doctor's mode", () => {
    const p = resolveProfile(applyPatch(defaultProfileDoc(), {}), "p", "claude-code");
    const soft = validateProfile(p, catalog({ index: null }), BACKENDS, undefined, "claude-code", {
      unindexed: "warning",
    });
    expect(messages(soft.errors)).toContain("the worker role has no usable rung");
  });

  it("says to sync when there is no index at all", () => {
    const v = check({}, catalog({ index: null }));
    const unindexed = v.errors.filter((e) => e.message.includes("has no Slopalytics intelligence index"));
    expect(unindexed.length).toBeGreaterThan(0);
    for (const e of unindexed) expect(e.fix).toBe("catherd catalog sync");
  });

  it("rejects a failover stand-in with no index, naming the best stand-in to use instead", () => {
    const MYSTERY = "opencode:opencode-go/mystery-1#high";
    const v = check({ failover: { "codex:gpt-6-sol#xhigh": MYSTERY } });
    const found = v.errors.filter((e) => e.path === "failover.codex:gpt-6-sol#xhigh");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toBe(`${MYSTERY} has no Slopalytics intelligence index: routing skips it`);
    expect(found[0]?.fix).toMatch(/^catherd profile set failover\.codex:gpt-6-sol#xhigh \S+$/);
    // no "downgrade" besides
    expect(messages(v.warnings).some((m) => m.startsWith("downgrade"))).toBe(false);
  });

  it("refuses a rung on a backend catherd cannot run yet, a bad effort, and an incapable model", () => {
    const e = messages(
      check({
        roles: {
          reviewer: { rungs: ["cursor:gpt-6-sol#high", "codex:gpt-6-sol#turbo", "codex:gpt-6-sol#high"] },
          artist: { rungs: ["claude-code:claude-opus-5-5#high", "codex:gpt-6-sol#medium"] },
        },
      }).errors,
    );
    expect(e).toContain("cursor:gpt-6-sol#high: catherd cannot run cursor yet");
    expect(e).toContain("codex:gpt-6-sol#turbo has no Slopalytics intelligence index: routing skips it");
    expect(e).toContain("claude-code:claude-opus-5-5#high cannot fill the artist role (it needs imageGen)");
  });

  it("refuses a default rung that is not on the role's ladder", () => {
    expect(messages(check({ roles: { worker: { defaultRung: "codex:gpt-6-luna#max" } } }).errors)).toEqual([
      "codex:gpt-6-luna#max is not one of the worker's rungs",
    ]);
  });

  it("warns, and never errs, on an access mode other than the role's default", () => {
    const v = check({ roles: { verifier: { access: "read-only" }, worker: { access: "full" } } });
    expect(v.errors).toEqual([]);
    expect(messages(v.warnings)).toEqual([
      "verifier runs read-only; catherd's default for it is full",
      "worker runs full; catherd's default for it is workspace-write",
    ]);
  });

  it("refuses a stand-in on the same quota, native claude and claude-code counting as one, and rejects an unindexed one", () => {
    const v = check({
      failover: {
        "codex:gpt-6-sol#high": "codex:gpt-6-luna#high",
        "codex:gpt-6-sol#medium": "opencode:opencode-go/glm-5.3#high",
        "claude:claude-opus-5-5#high": "claude-code:claude-opus-5-5#high",
      },
      roles: { architect: { rungs: ["claude:claude-opus-5-5#high"] } },
    });
    const e = messages(v.errors);
    expect(e).toEqual([
      "opencode:opencode-go/glm-5.3#high has no Slopalytics intelligence index: routing skips it",
      "stand-in codex:gpt-6-luna#high draws on the same quota as codex:gpt-6-sol#high, which is out when codex:gpt-6-sol#high hits its limit",
      "stand-in claude-code:claude-opus-5-5#high draws on the same quota as claude:claude-opus-5-5#high, which is out when claude:claude-opus-5-5#high hits its limit",
    ]);
    expect(messages(v.errors)).toContain(
      "opencode:opencode-go/glm-5.3#high has no Slopalytics intelligence index: routing skips it",
    );
  });

  it("lets Go and Zen stand in for each other, since they bill apart", () => {
    const v = check({
      failover: { "codex:gpt-6-luna#high": null, "codex:gpt-6-sol#high": "opencode:opencode/gpt-6-sol#high" },
      roles: {},
    });
    expect(v.errors).toEqual([]);
  });

  it("warns on a stand-in that never runs, or that dispatch cannot start", () => {
    const v = check({
      failover: {
        "codex:gpt-6-astra#high": "opencode:opencode-go/kimi-k3#max",
        "codex:gpt-6-sol#high": "claude:claude-opus-5-5#high",
      },
    });
    expect(v.errors).toEqual([]);
    expect(messages(v.warnings)).toEqual([
      "downgrade: opencode:opencode-go/kimi-k3#max stands in for codex:gpt-6-astra#high at intelligence 43.6, below its 50.9",
      "codex:gpt-6-astra#high is on no enabled role's ladder, so this never runs",
      "stand-in claude:claude-opus-5-5#high is a native subagent: the orchestrator must start it, dispatch cannot",
    ]);
  });

  it("warns when the backend's last listing lacks a model", () => {
    const listed = shipped({
      listed: {
        codex: {
          fetchedAt: "2026-09-25T00:00:00Z",
          models: [{ id: "gpt-6-sol", efforts: ["medium", "high", "xhigh"], context: null, imageIn: true }],
        },
      },
    });
    const v = check({}, listed);
    expect(messages(v.warnings)).toContain(
      "codex's last listing does not offer gpt-6-luna; routing skips it",
    );
  });

  it("rejects an effort the backend's listing does not offer, naming what it has", () => {
    const listed = shipped({
      listed: {
        codex: {
          fetchedAt: "2026-09-25T00:00:00Z",
          models: [{ id: "gpt-6-sol", efforts: ["medium", "high", "xhigh"], context: null, imageIn: true }],
        },
      },
    });
    const v = check({ roles: { reviewer: { rungs: ["codex:gpt-6-sol#low"] } } }, listed);
    expect(messages(v.errors)).toContain(
      'gpt-6-sol has no effort "low" on codex (it has medium, high, xhigh)',
    );
  });
});

describe("validateProfile: failover and ladder warnings (spec 1.1 §11)", () => {
  const XHIGH = "codex:gpt-6-sol#xhigh";
  const LUNA = "codex:gpt-6-luna#high";
  const KIMI = "opencode:opencode-go/kimi-k3#max";
  const GO_LUNA = "opencode:opencode-go/gpt-6-luna#high";
  const OPUS_MAX = "claude-code:claude-opus-5-5#max";

  it("warns, never errs, on a stand-in that is less intelligent than its rung", () => {
    const v = check({ failover: { [XHIGH]: KIMI } });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([
      {
        path: `failover.${XHIGH}`,
        message: `downgrade: ${KIMI} stands in for ${XHIGH} at intelligence 43.6, below its 44.2`,
        // Sonnet 5.5 high: the nearest intelligence above Sol xhigh among the backends the profile names
        fix: `catherd profile set failover.${XHIGH} claude-code:claude-sonnet-5-5#high`,
      },
    ]);
  });

  it("names the best stand-in in a downgrade's fix when there is one", () => {
    const LOW = "opencode:opencode-go/gpt-6-luna#low";
    const v = check({ failover: { [LUNA]: LOW } });
    expect(v.warnings).toEqual([
      {
        path: `failover.${LUNA}`,
        message: `downgrade: ${LOW} stands in for ${LUNA} at intelligence 21.5, below its 32.9`,
        fix: `catherd profile set failover.${LUNA} ${GO_LUNA}`,
      },
    ]);
  });

  it("warns when a stand-in spends Claude quota while another backend could stand in", () => {
    // the default profile caps Opus at high; this case is about the quota, not the cap
    const v = check({ failover: { [LUNA]: OPUS_MAX }, maxEffort: { "claude-code:claude-opus-5-5": null } });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([
      {
        path: `failover.${LUNA}`,
        message: `stand-in ${OPUS_MAX} spends Claude quota, while ${GO_LUNA} could stand in on another plan`,
        fix: `catherd profile set failover.${LUNA} ${GO_LUNA}`,
      },
    ]);
    // with Go metered, nothing else is paid from a plan: the Claude stand-in is the only one
    const metered = check({ billing: { "opencode-go": "metered" }, failover: { [LUNA]: OPUS_MAX } }).warnings;
    expect(messages(metered).some((m) => m.includes("spends Claude quota"))).toBe(false);
  });

  it("suggests a stand-in only on a backend the profile already names (1.3 follow-ups)", () => {
    const c = catalog();
    const validate = (patch: ProfilePatch) =>
      validateProfile(
        resolveProfile(applyPatch(defaultProfileDoc(), patch), "p", "claude-code"),
        c,
        [...BACKENDS, "cursor"],
        undefined,
        "claude-code",
      );
    // Sol 5.6 xhigh's nearest stand-in on a plan is a Cursor rung once Cursor bills a subscription; this
    // profile names no Cursor rung, so the fix never sends the user there
    const SOL56 = "codex:gpt-5.6-sol#xhigh";
    const billing = { cursor: "subscription" } as const;
    const fixes = validate({ billing, failover: { [SOL56]: KIMI } })
      .warnings.filter((w) => w.message.startsWith("downgrade:"))
      .map((w) => w.fix);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).not.toContain("cursor:");
    // named once (here as a failover stand-in elsewhere), Cursor's rungs may be suggested
    const named = validate({ billing, failover: { [SOL56]: KIMI, [LUNA]: "cursor:claude-opus-5-5#high" } });
    expect(named.warnings.find((w) => w.path === `failover.${SOL56}`)?.fix).toMatch(
      new RegExp(`^catherd profile set failover\\.${SOL56} cursor:\\S+$`),
    );
  });

  it("warns that network: false does nothing on a read-only or full role (1.1 follow-ups)", () => {
    const v = check({ roles: { reviewer: { network: false }, worker: { network: false } } });
    expect(v.warnings).toContainEqual({
      path: "roles.reviewer.network",
      message:
        "network: false does nothing here: it applies to workspace-write roles, and reviewer runs read-only",
      fix: "catherd profile set roles.reviewer.network null",
    });
    // a workspace-write role's network: false takes its grants: no warning
    expect(v.warnings.some((w) => w.path === "roles.worker.network")).toBe(false);
  });

  it("warns where a ladder goes down: a rung less intelligent than the one before it", () => {
    const worker = ["codex:gpt-6-sol#medium", XHIGH, LUNA];
    const v = check({ roles: { worker: { rungs: worker, defaultRung: null } } });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toContainEqual({
      path: "roles.worker.rungs",
      message: `the ladder goes down at ${LUNA}: intelligence 32.9 below ${XHIGH}'s 44.2`,
      fix: "order roles.worker.rungs weakest first",
    });
    // Luna high → Sol medium: up, the default ladder
    expect(check().warnings).toEqual([]);
  });
});

describe("profile repair (spec 1.2 §6.2)", () => {
  const e = (path: string, message: string) => ({ path, message });
  const two = { errors: [e("a", "one"), e("b", "two")], warnings: [] };

  it("lets a save through that removes one of two errors and adds none", () => {
    expect(repairs(two, { errors: [e("b", "two")], warnings: [] })).toBe(true);
    expect(repairs(two, { errors: [], warnings: [] })).toBe(true);
  });

  it("refuses one that adds an error, even while it removes another, or that removes none", () => {
    expect(repairs(two, { errors: [e("b", "two"), e("c", "three")], warnings: [] })).toBe(false);
    expect(repairs(two, two)).toBe(false);
    // a profile that does not exist yet has no errors to repair
    expect(repairs(null, { errors: [e("a", "one")], warnings: [] })).toBe(false);
  });
});

it("rejects native Claude on Codex including reachable failover without converting backend IDs", () => {
  const rung = "codex:gpt-6-sol#high";
  const doc = applyPatch(defaultProfileDoc(), {
    roles: { reviewer: { rungs: [rung] } },
    failover: { [rung]: "claude:claude-opus-5-5#low" },
  });
  const p = resolveProfile(doc, "default", "codex");
  const v = validateProfile(p, catalog(), BACKENDS, doc, "codex");
  expect(v.errors).toContainEqual({
    path: `failover.${rung}`,
    message: "claude:claude-opus-5-5#low: native Claude subagents require the claude-code orchestration host",
    fix: "use claude-code:claude-opus-5-5#low for headless execution, or --host claude-code",
  });
  expect(p.failover[rung]).toBe("claude:claude-opus-5-5#low");
});

describe("validateProfile: what a role can never start or reach (spec 1.5 plan 24)", () => {
  const LUNA = "codex:gpt-6-luna#high";
  const SOL = "codex:gpt-6-sol#medium";
  const KIMI = "opencode:opencode-go/kimi-k3#max";
  const explicit = (patch: ProfilePatch = {}) =>
    validateProfile(
      resolveProfile(applyPatch(defaultProfileDoc(), patch), "p", "claude-code"),
      catalog(),
      BACKENDS,
      undefined,
      "claude-code",
      { reach: true },
    );

  it("warns about a quota none of whose rungs ever starts a lane", () => {
    const v = check({
      billing: { "opencode-go": "metered" },
      roles: { worker: { rungs: [LUNA, SOL, "codex:gpt-6-sol#xhigh", KIMI], defaultRung: SOL } },
    });
    expect(v.warnings).toContainEqual({
      path: "roles.worker.rungs",
      message: `opencode-go never starts a worker lane: ${KIMI} runs only on a climb, since another rung starts every lane`,
      fix: "check billing.opencode-go (a metered rung starts only where nothing paid from a plan clears the bar), or order roles.worker.rungs so its rungs come first among equals",
    });
  });

  it("does not tell a lane-less role that a quota runs only on a climb (final review Important 4)", () => {
    // a reviewer routes without a lane: no difficulty ever starts it, and it never climbs
    const v = check({
      roles: { reviewer: { rungs: ["codex:gpt-6-sol#xhigh", "claude-code:claude-sonnet-5-5#high"] } },
    });
    expect(messages(v.warnings).filter((m) => m.includes("never starts"))).toEqual([]);
  });

  it("names the billing key, not the quota, in the fix for an idle native Claude rung", () => {
    const sonnet = "claude:claude-sonnet-5#medium";
    const v = check({
      billing: { claude: "metered" },
      roles: { worker: { rungs: [LUNA, SOL, sonnet], defaultRung: SOL } },
    });
    const idle = v.warnings.filter((w) => w.message.includes("never starts"));
    expect(idle.map((w) => w.fix)).toEqual([
      "check billing.claude (a metered rung starts only where nothing paid from a plan clears the bar), or order roles.worker.rungs so its rungs come first among equals",
    ]);
  });

  it("counts a quota that wins a tie on headroom as one that starts", () => {
    // Luna xhigh on Go is the same pair as on Codex: they tie, and Go's turn at the least used quota starts it
    const tie = ["codex:gpt-6-luna#xhigh", "opencode:opencode-go/gpt-6-luna#xhigh"];
    const v = check({ roles: { worker: { rungs: [...tie, SOL], defaultRung: SOL } } });
    expect(messages(v.warnings).some((m) => m.includes("never starts"))).toBe(false);
  });

  it("lists, on an explicit validate only, every difficulty no worker rung clears", () => {
    // the shipped bars (20/45/60/65) put one default worker rung at each difficulty: nothing is unreached
    expect(explicit().warnings).toEqual([]);
    const noXhigh = {
      roles: {
        worker: {
          rungs: ["codex:gpt-6-luna#high", "codex:gpt-6-sol#medium", "codex:gpt-6-sol#high"],
          defaultRung: "codex:gpt-6-sol#medium",
        },
      },
    };
    expect(explicit(noXhigh).warnings).toEqual([
      {
        path: "roles.worker.rungs",
        message:
          "no worker rung clears hard: those lanes start at the default rung and climb only onto rungs at least as intelligent (route names the closest)",
      },
    ]);
    // a save, doctor and the TUI validate without it: the profile stays clean there
    expect(check(noXhigh).warnings).toEqual([]);
    // Astra medium is above the hard bar
    const astra = explicit({
      roles: {
        worker: {
          rungs: [
            "codex:gpt-6-luna#high",
            "codex:gpt-6-sol#medium",
            "codex:gpt-6-sol#high",
            "codex:gpt-6-astra#medium",
          ],
        },
      },
    });
    expect(messages(astra.warnings).some((m) => m.startsWith("no worker rung clears"))).toBe(false);
  });
});

describe("validateProfile: effort ceilings and the coding floor (plan 33)", () => {
  const c = catalog({
    index: indexOf({
      "gpt-6-luna#high": 30,
      "gpt-6-sol#low": 35,
      "gpt-6-sol#medium": 36,
      "gpt-6-sol#high": 42,
      "gpt-6-sol#xhigh": 46,
    }),
  });
  const W = [
    "codex:gpt-6-luna#high",
    "codex:gpt-6-sol#medium",
    "codex:gpt-6-sol#high",
    "codex:gpt-6-sol#xhigh",
  ];

  it("warns about a rung above its model's maxEffort, in the rungs and the failover map", () => {
    const v = check(
      {
        maxEffort: { "codex:gpt-6-sol": "high" },
        roles: { worker: { rungs: W, defaultRung: W[1] as string } },
        failover: { "codex:gpt-6-luna#high": "codex:gpt-6-sol#xhigh" },
      },
      c,
    );
    expect(v.warnings).toContainEqual({
      path: "roles.worker.rungs",
      message: "codex:gpt-6-sol#xhigh is above maxEffort high for codex:gpt-6-sol: routing skips it",
      fix: "catherd profile set maxEffort.codex:gpt-6-sol xhigh, or remove the rung",
    });
    expect(v.warnings).toContainEqual(expect.objectContaining({ path: "failover.codex:gpt-6-luna#high" }));
  });

  it("warns about a worker rung below medium, and not a writer's", () => {
    const v = check(
      {
        roles: {
          worker: { rungs: ["codex:gpt-6-sol#low", ...W], defaultRung: W[1] as string },
          writer: { rungs: ["codex:gpt-6-sol#low"] },
        },
      },
      c,
    );
    expect(v.warnings).toContainEqual({
      path: "roles.worker.rungs",
      message: "codex:gpt-6-sol#low is below medium effort: a coding worker never runs it",
      fix: "pick #medium or above: catherd catalog list --role worker",
    });
    expect(
      v.warnings.filter((w) => w.path === "roles.writer.rungs" && w.message.includes("below medium")),
    ).toEqual([]);
  });
});

describe("validateProfile: bars (plan 33)", () => {
  // the pool is [30, 36, 42, 46]; shipped bars: copy 33.6, build 38.1, logic 40.8, hard 41.7
  const c = catalog({
    index: indexOf({
      "gpt-6-luna#high": 30,
      "gpt-6-sol#medium": 36,
      "gpt-6-sol#high": 42,
      "gpt-6-sol#xhigh": 46,
    }),
  });
  const explicit = (patch: ProfilePatch) =>
    validateProfile(
      resolveProfile(applyPatch(defaultProfileDoc(), patch), "p", "claude-code"),
      c,
      BACKENDS,
      undefined,
      "claude-code",
      { reach: true },
    );

  it("names the difficulties no worker rung clears on the worker's own bars", () => {
    const rungs = ["codex:gpt-6-luna#high", "codex:gpt-6-sol#medium"];
    const roles = { worker: { rungs, defaultRung: rungs[1] as string } };
    // Sol medium (36) clears copy only: build, logic and hard stay unreached
    expect(
      explicit({ roles }).warnings.find((w) => w.message.startsWith("no worker rung clears"))?.message,
    ).toContain("build, logic, hard");
    // every bar at the 10th percentile (31.8) is cleared by Sol medium
    const lowered = explicit({
      roles: { worker: { ...roles.worker, bars: { copy: 10, build: 10, logic: 10, hard: 10 } } },
    });
    expect(lowered.warnings.find((w) => w.message.startsWith("no worker rung clears"))).toBeUndefined();
  });

  it("reports a stored inversion as an error with the fix, for the profile's bars and a role's", () => {
    const inverted = explicit({ bars: { hard: 50 }, roles: { worker: { bars: { build: 90 } } } });
    expect(
      inverted.errors.filter((e) => e.path.endsWith("bars")).map((e) => [e.path, e.message, e.fix]),
    ).toEqual([
      [
        "bars",
        "the hard bar (50) is below the logic bar (60)",
        "catherd profile set bars.hard 60, or lower bars.logic to 50 or less",
      ],
      [
        "roles.worker.bars",
        "the logic bar (60) is below the build bar (90)",
        "catherd profile set roles.worker.bars.logic 90, or lower roles.worker.bars.build to 60 or less",
      ],
      [
        "roles.worker.bars",
        "the hard bar (50) is below the logic bar (60)",
        "catherd profile set roles.worker.bars.hard 60, or lower roles.worker.bars.logic to 50 or less",
      ],
    ]);
  });

  it("a role's bars reach only that role", () => {
    const prof = resolveProfile(
      applyPatch(
        applyPatch(defaultProfileDoc(), patchAt("bars.logic", "55")),
        patchAt("roles.worker.bars.logic", "30"),
      ),
      "x",
      "claude-code",
    );
    expect(routingProfileOf(prof, "worker").bars).toEqual({ logic: 30 });
    expect(routingProfileOf(prof, "reviewer").bars).toEqual({ logic: 55 });
  });
});
