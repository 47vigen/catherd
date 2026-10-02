import { describe, expect, it } from "bun:test";
import { rungInfo } from "../../src/domain/catalog.ts";
import {
  applyPatch,
  defaultProfileDoc,
  type ProfilePatch,
  resolveProfile,
} from "../../src/domain/profile.ts";
import {
  inferredScores,
  repairs,
  standInsToConfirm,
  validateProfile,
} from "../../src/domain/profile-rules.ts";
import { withStandIns } from "../../src/services/standins.ts";
import { shipped } from "./shipped.ts";

const BACKENDS = ["codex", "claude-code", "opencode", "claude"];
/** The catalog as loadCatalog serves it: the shipped files, with each rung's inferred stand-ins. */
const catalog = (o: Parameters<typeof shipped>[0] = {}) => withStandIns(shipped(o));
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

  it("warns, never errs, on an unscored rung no rung is near enough to stand in for (spec 1.2 §6.1)", () => {
    const rung = "opencode:opencode-go/glm-5.3#high";
    const bad = check({ roles: { reviewer: { rungs: ["codex:gpt-6-sol#high", rung] } } });
    expect(bad.errors).toEqual([]);
    expect(bad.warnings).toContainEqual({
      path: "roles.reviewer.rungs",
      message: `${rung} is unscored and no rung is near enough to stand in for it: routing skips it`,
      fix: `map it with: catherd catalog treat-like ${rung} <a scored rung>; catalog_query lists them`,
    });
    const liked = catalog({
      override: {
        schema: 1,
        treatLike: { "opencode-go/glm-5.3#high": "gpt-6-sol#high" },
        scores: [],
        bars: {},
      },
    });
    const mapped = check({ roles: { reviewer: { rungs: ["codex:gpt-6-sol#high", rung] } } }, liked);
    expect(mapped.errors).toEqual([]);
    expect(messages(mapped.warnings).some((m) => m.includes("unscored"))).toBe(false);
  });

  it("lists a rung that leans on an inferred stand-in as a stand-in to confirm, once, where bars choose", () => {
    // GPT-5.6 Terra has no repo_code, terminal or honesty value: its nearest stand-ins lend them
    const terra = "opencode:opencode/gpt-5.6-terra#high";
    const v = check({
      roles: { worker: { rungs: ["codex:gpt-6-sol#medium", "codex:gpt-5.6-terra#high"] } },
      failover: { "codex:gpt-6-sol#medium": terra },
      billing: { opencode: "subscription" },
    });
    expect(v.errors).toEqual([]);
    const c = catalog();
    const lent = c.inferred["gpt-5.6-terra#high"];
    expect(v.warnings.filter((w) => w.message.startsWith("stand-in to confirm"))).toEqual([
      {
        path: "roles.worker.rungs",
        message: `stand-in to confirm: gpt-5.6-terra#high (codex:gpt-5.6-terra#high, ${terra}) has no repo_code, terminal or honesty value of its own; routing uses ${lent?.repo_code?.like}'s repo_code, ${lent?.terminal?.like}'s terminal, ${lent?.honesty?.like}'s honesty (inferred)`,
        fix: "confirm or replace it: catherd catalog treat-like --suggest codex:gpt-5.6-terra#high, then catherd catalog treat-like codex:gpt-5.6-terra#high <a rung>",
      },
    ]);
    // a role with one rung runs it whatever the bars say: nothing to confirm there
    expect(
      standInsToConfirm(
        resolveProfile(
          applyPatch(defaultProfileDoc(), { roles: { reviewer: { rungs: [terra] } } }),
          "p",
          "claude-code",
        ),
        c,
        BACKENDS,
      ),
    ).toEqual([]);
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
    expect(e).toContain(
      'gpt-6-sol has no effort "turbo" on codex (it has low, medium, high, xhigh, max, ultra)',
    );
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

  it("refuses a stand-in on the same quota, native claude and claude-code counting as one, and warns on an unscored one", () => {
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
      "stand-in codex:gpt-6-luna#high draws on the same quota as codex:gpt-6-sol#high, which is out when codex:gpt-6-sol#high hits its limit",
      "stand-in claude-code:claude-opus-5-5#high draws on the same quota as claude:claude-opus-5-5#high, which is out when claude:claude-opus-5-5#high hits its limit",
    ]);
    expect(messages(v.warnings)).toContain(
      "stand-in opencode:opencode-go/glm-5.3#high is unscored and no rung is near enough to stand in for it",
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
      "downgrade: opencode:opencode-go/kimi-k3#max stands in for codex:gpt-6-astra#high, scoring below it on repo_code, terminal, honesty, agentic, frontend",
      "codex:gpt-6-astra#high is on no enabled role's ladder, so this never runs",
      "stand-in claude:claude-opus-5-5#high is a native subagent: the orchestrator must start it, dispatch cannot",
      // no source publishes a Claude honesty value: Opus uses Sol's, inferred
      "stand-in to confirm: claude-opus-5-5#high has no honesty value of its own; routing uses gpt-6-sol#high's honesty (inferred)",
    ]);
  });

  it("warns when the backend's last listing lacks a model, and when an unlisted model's effort cannot be checked", () => {
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
    const w = check({
      roles: { reviewer: { rungs: ["codex:gpt-6-sol#high", "opencode:opencode-go/kimi-k3#max"] } },
    });
    expect(messages(w.warnings)).toContain(
      "opencode:opencode-go/kimi-k3#max: catherd cannot check its effort until opencode lists its models",
    );
  });

  it("warns on a Claude rung that clears no routing bar on a ladder of several, never on a lone one", () => {
    // Haiku 4.5 has only a WebDev value (frontend 1338, from Epoch): it clears no bar; Opus clears several
    const HAIKU = "claude-code:claude-haiku-4-5-20251001#default";
    const worker = ["codex:gpt-6-sol#medium", HAIKU, "claude-code:claude-opus-5-5#max"];
    const v = check({ roles: { worker: { rungs: worker, defaultRung: null } } });
    expect(v.errors).toEqual([]);
    expect(v.warnings.filter((w) => w.message.includes("clears no routing bar"))).toEqual([
      {
        path: "roles.worker.rungs",
        message: `${HAIKU} clears no routing bar, so a lane starts on it only as the role's default rung and never climbs onto it`,
      },
    ]);
    expect(check({ roles: { reviewer: { rungs: [HAIKU] } } })).toEqual({ errors: [], warnings: [] });
  });
});

describe("validateProfile: failover and ladder warnings (spec 1.1 §11)", () => {
  const XHIGH = "codex:gpt-6-sol#xhigh";
  const LUNA = "codex:gpt-6-luna#high";
  const KIMI = "opencode:opencode-go/kimi-k3#max";
  const GO_LUNA = "opencode:opencode-go/gpt-6-luna#high";
  const OPUS_MAX = "claude-code:claude-opus-5-5#max";

  it("warns, never errs, on a stand-in that scores below its rung on a dim the rung's bars use", () => {
    const v = check({ failover: { [XHIGH]: KIMI } });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([
      {
        path: `failover.${XHIGH}`,
        message: `downgrade: ${KIMI} stands in for ${XHIGH}, scoring below it on repo_code`,
        // Sonnet 5.5 xhigh (scored through its inferred stand-in): the cheapest with no downgrade, on the Claude plan
        fix: `catherd profile set failover.${XHIGH} claude-code:claude-sonnet-5-5#xhigh`,
      },
    ]);
  });

  it("names the best stand-in in a downgrade's fix when there is one", () => {
    const v = check({ failover: { [LUNA]: KIMI } });
    expect(v.warnings).toEqual([
      {
        path: `failover.${LUNA}`,
        message: `downgrade: ${KIMI} stands in for ${LUNA}, scoring below it on repo_code`,
        fix: `catherd profile set failover.${LUNA} ${GO_LUNA}`,
      },
    ]);
  });

  it("warns when a stand-in spends Claude quota while another backend could stand in", () => {
    const v = check({ failover: { [LUNA]: OPUS_MAX } });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([
      {
        path: `failover.${LUNA}`,
        message: `stand-in ${OPUS_MAX} spends Claude quota, while ${GO_LUNA} could stand in on another plan`,
        fix: `catherd profile set failover.${LUNA} ${GO_LUNA}`,
      },
      {
        path: `failover.${LUNA}`,
        message:
          "stand-in to confirm: claude-opus-5-5#max has no honesty value of its own; routing uses gpt-6-sol#max's honesty (inferred)",
        fix: `confirm or replace it: catherd catalog treat-like --suggest ${OPUS_MAX}, then catherd catalog treat-like ${OPUS_MAX} <a rung>`,
      },
    ]);
    // with Go metered, nothing else is paid from a plan: the Claude stand-in is the only one
    const metered = check({ billing: { "opencode-go": "metered" }, failover: { [LUNA]: OPUS_MAX } }).warnings;
    expect(messages(metered).some((m) => m.includes("spends Claude quota"))).toBe(false);
  });

  it("warns where a ladder goes down: a rung scoring below the one before it and above it nowhere", () => {
    const worker = ["codex:gpt-6-sol#medium", XHIGH, LUNA];
    const v = check({ roles: { worker: { rungs: worker, defaultRung: null } } });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toContainEqual({
      path: "roles.worker.rungs",
      message: `the ladder goes down at ${LUNA}: it scores below ${XHIGH} on terminal, honesty, agentic, steer, frontend`,
      fix: "order roles.worker.rungs weakest first",
    });
    // Luna high → Sol medium: lower on repo_code but higher on honesty, so not down (the default ladder)
    expect(check().warnings).toEqual([]);
  });
});

describe("inferredScores", () => {
  it("marks both of the default profile's Go stand-ins inferred, saying what each borrows, and Sol not", () => {
    const c = catalog();
    expect(inferredScores(c, rungInfo(c, "opencode:opencode-go/kimi-k3#max"))).toEqual({
      inferred: true,
      via: "gpt-6-sol#medium",
      note: "scores borrowed from gpt-6-sol#medium",
    });
    // Go Luna high has values of its own; the shipped treat-like lends only what no source publishes
    expect(inferredScores(c, rungInfo(c, "opencode:opencode-go/gpt-6-luna#high"))).toEqual({
      inferred: true,
      via: "gpt-5.6-luna#high",
      note: "agentic, steer borrowed from gpt-5.6-luna#high",
    });
    expect(inferredScores(c, rungInfo(c, "codex:gpt-6-sol#high")).inferred).toBe(false);
    // an inferred stand-in counts as catherd's guess too
    expect(inferredScores(c, rungInfo(c, "codex:gpt-5.6-terra#high"))).toMatchObject({
      inferred: true,
      via: null,
    });
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
  const GO_KIMI = "opencode:opencode-go/kimi-k3#default";
  /** Kimi treated like Sol medium: on its subscription it ties Sol, metered it is never first */
  const c = () =>
    catalog({
      override: {
        schema: 1,
        treatLike: { "opencode-go/kimi-k3#default": "gpt-6-sol#medium" },
        scores: [],
        bars: {},
      },
    });
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
    const v = check(
      {
        billing: { "opencode-go": "metered" },
        roles: { worker: { rungs: [LUNA, SOL, GO_KIMI], defaultRung: SOL } },
      },
      c(),
    );
    expect(v.warnings).toContainEqual({
      path: "roles.worker.rungs",
      message: `opencode-go never starts a worker lane: ${GO_KIMI} runs only on a climb, since another rung starts every lane`,
      fix: "check billing.opencode-go (a metered rung starts only where nothing paid from a plan clears the bar), or order roles.worker.rungs so its rungs come first among equals",
    });
  });

  it("counts a quota that wins a tie on headroom as one that starts", () => {
    const v = check({ roles: { worker: { rungs: [LUNA, SOL, GO_KIMI], defaultRung: SOL } } }, c());
    expect(messages(v.warnings).some((m) => m.includes("never starts"))).toBe(false);
  });

  it("names what an unscored default rung falls back to", () => {
    const nobody = "opencode:opencode-go/nobody-1#default";
    const v = check({ roles: { worker: { rungs: [LUNA, SOL, nobody], defaultRung: nobody } } });
    expect(messages(v.warnings)).toContain(
      `${nobody} is unscored and no rung is near enough to stand in for it: routing skips it; it is the worker's default rung, so routing falls back to ${LUNA}`,
    );
  });

  it("lists, on an explicit validate only, every kind and difficulty no worker rung clears", () => {
    expect(explicit().warnings).toEqual([
      {
        path: "roles.worker.rungs",
        message:
          "no worker rung clears repo_code logic, hard; terminal build, logic, hard; ui logic, hard; prose logic, hard; research logic, hard: those lanes start at the default rung and climb only onto rungs at least as strong (route names the closest)",
      },
    ]);
    // a save, doctor and the TUI validate without it: the default profile stays clean there
    expect(check().warnings).toEqual([]);
    // Astra medium (Terminal-Bench 57.9, agentic 0.1031) reaches every bar but the hard ones of three kinds
    const astra = explicit({
      roles: {
        worker: {
          rungs: [
            "codex:gpt-6-luna#high",
            "codex:gpt-6-sol#medium",
            "codex:gpt-6-sol#high",
            "codex:gpt-6-sol#xhigh",
            "codex:gpt-6-astra#medium",
          ],
        },
      },
    });
    expect(messages(astra.warnings).find((m) => m.startsWith("no worker rung clears"))).toBe(
      "no worker rung clears repo_code hard; terminal hard; ui hard: those lanes start at the default rung and climb only onto rungs at least as strong (route names the closest)",
    );
  });
});
