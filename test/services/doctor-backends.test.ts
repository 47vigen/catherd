import { describe, expect, it } from "bun:test";
import { tryParseRung } from "../../src/domain/ids.ts";
import { applyPatch, defaultProfileDoc, PAIRED_FAILOVER, resolveProfile } from "../../src/domain/profile.ts";
import { usedBackends } from "../../src/services/doctor-backends.ts";

describe("usedBackends (spec 1.3 §7.3)", () => {
  it("counts an implicit paired stand-in as failover use, so a missing pair is not an unused skip", () => {
    const GROK = "grok:grok-4.6#high";
    const pair = PAIRED_FAILOVER[GROK];
    if (!pair) throw new Error("expected a paired stand-in for grok-4.6#high");
    const doc = applyPatch(defaultProfileDoc(), {
      roles: { worker: { rungs: [GROK], defaultRung: null } },
    });
    const used = usedBackends([resolveProfile(doc, "p", "claude-code")]);
    expect(used.get("grok")).toBe("role");
    expect(used.get(tryParseRung(pair)?.backend ?? "")).toBe("failover");
  });
});
