import { describe, expect, it } from "bun:test";
import { rungInfo } from "../../src/domain/catalog.ts";
import {
  applyPatch,
  defaultProfileDoc,
  type ProfilePatch,
  resolveProfile,
} from "../../src/domain/profile.ts";
import { inferredScores, validateProfile } from "../../src/domain/profile-rules.ts";
import { shipped } from "./shipped.ts";

const BACKENDS = ["codex", "claude-code", "opencode", "claude"];
const check = (patch: ProfilePatch = {}, c = shipped()) =>
  validateProfile(resolveProfile(applyPatch(defaultProfileDoc(), patch), "p"), c, BACKENDS);
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

  it("refuses an unscored rung until a treat-like maps it", () => {
    const rung = "opencode:opencode-go/glm-5.3#high";
    const bad = check({ roles: { reviewer: { rungs: ["codex:gpt-6-sol#high", rung] } } });
    expect(bad.errors).toContainEqual({
      path: "roles.reviewer.rungs",
      message: `${rung} is unscored`,
      fix: `map it with: catherd catalog treat-like ${rung} <a scored rung>; catalog_query lists them`,
    });
    const liked = shipped({
      override: {
        schema: 1,
        treatLike: { "opencode-go/glm-5.3#high": "gpt-6-sol#high" },
        scores: [],
        bars: {},
      },
    });
    expect(check({ roles: { reviewer: { rungs: ["codex:gpt-6-sol#high", rung] } } }, liked).errors).toEqual(
      [],
    );
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

  it("refuses a stand-in that is unscored or on the same quota, native claude and claude-code counting as one", () => {
    const e = messages(
      check({
        failover: {
          "codex:gpt-6-sol#high": "codex:gpt-6-luna#high",
          "codex:gpt-6-sol#medium": "opencode:opencode-go/glm-5.3#high",
          "claude:claude-opus-5-5#high": "claude-code:claude-opus-5-5#high",
        },
        roles: { architect: { rungs: ["claude:claude-opus-5-5#high"] } },
      }).errors,
    );
    expect(e).toEqual([
      "stand-in opencode:opencode-go/glm-5.3#high is unscored",
      "stand-in codex:gpt-6-luna#high draws on the same quota as codex:gpt-6-sol#high, which is out when codex:gpt-6-sol#high hits its limit",
      "stand-in claude-code:claude-opus-5-5#high draws on the same quota as claude:claude-opus-5-5#high, which is out when claude:claude-opus-5-5#high hits its limit",
    ]);
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
        // Opus xhigh (repo_code 74.2 carried from max): the only stand-in with no downgrade, on the Claude plan
        fix: `catherd profile set failover.${XHIGH} claude-code:claude-opus-5-5#xhigh`,
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
    ]);
    // with Go metered, nothing else is paid from a plan: the Claude stand-in is the only one
    expect(check({ billing: { "opencode-go": "metered" }, failover: { [LUNA]: OPUS_MAX } }).warnings).toEqual(
      [],
    );
  });

  it("warns where a ladder goes down: a rung scoring below the one before it and above it nowhere", () => {
    const worker = ["codex:gpt-6-sol#medium", XHIGH, LUNA];
    const v = check({ roles: { worker: { rungs: worker, defaultRung: null } } });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toContainEqual({
      path: "roles.worker.rungs",
      message: `the ladder goes down at ${LUNA}: it scores below ${XHIGH} on terminal, honesty, frontend`,
      fix: "order roles.worker.rungs weakest first",
    });
    // Luna high → Sol medium: lower on repo_code but higher on honesty, so not down (the default ladder)
    expect(check().warnings).toEqual([]);
  });
});

describe("inferredScores", () => {
  it("marks the default profile's Kimi stand-in inferred, and Go Luna and Sol not", () => {
    const c = shipped();
    expect(inferredScores(c, rungInfo(c, "opencode:opencode-go/kimi-k3#max"))).toEqual({
      inferred: true,
      via: "gpt-6-sol#medium",
    });
    // Go Luna high carries Luna max's published values (adjacent): no longer only catherd's guesses
    expect(inferredScores(c, rungInfo(c, "opencode:opencode-go/gpt-6-luna#high"))).toEqual({
      inferred: false,
      via: null,
    });
    expect(inferredScores(c, rungInfo(c, "codex:gpt-6-sol#high")).inferred).toBe(false);
  });
});
