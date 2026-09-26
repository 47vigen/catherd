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
      "stand-in claude:claude-opus-5-5#high is a native subagent: the orchestrator must start it, dispatch cannot",
      "codex:gpt-6-astra#high is on no enabled role's ladder, so this never runs",
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
    const worker = [
      "codex:gpt-6-sol#medium",
      "claude-code:claude-opus-5-5#high",
      "claude:claude-opus-5-5#high",
      "claude-code:claude-opus-5-5#max",
    ];
    const v = check({ roles: { worker: { rungs: worker, defaultRung: null } } });
    expect(v.errors).toEqual([]);
    expect(v.warnings.filter((w) => w.path.startsWith("roles."))).toEqual(
      ["claude-code:claude-opus-5-5#high", "claude:claude-opus-5-5#high"].map((rung) => ({
        path: "roles.worker.rungs",
        message: `${rung} clears no routing bar (no honesty score), so a lane starts on it only as the role's default rung and never climbs onto it`,
      })),
    );
    expect(check({ roles: { reviewer: { rungs: ["claude-code:claude-opus-5-5#high"] } } })).toEqual({
      errors: [],
      warnings: [],
    });
  });
});

describe("inferredScores", () => {
  it("marks both of the default profile's Go stand-ins inferred, and Sol not", () => {
    const c = shipped();
    expect(inferredScores(c, rungInfo(c, "opencode:opencode-go/kimi-k3#max"))).toEqual({
      inferred: true,
      via: "gpt-6-sol#medium",
    });
    expect(inferredScores(c, rungInfo(c, "opencode:opencode-go/gpt-6-luna#high"))).toEqual({
      inferred: true,
      via: null,
    });
    expect(inferredScores(c, rungInfo(c, "codex:gpt-6-sol#high")).inferred).toBe(false);
  });
});
