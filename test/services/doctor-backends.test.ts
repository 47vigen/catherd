import { describe, expect, it } from "bun:test";
import { applyPatch, defaultProfileDoc, resolveProfile } from "../../src/domain/profile.ts";
import { usedBackends } from "../../src/services/doctor-backends.ts";

describe("usedBackends (spec 1.3 §7.3)", () => {
  it("counts a profile's stand-in as failover use, so a missing one is not an unused skip", () => {
    const CURSOR = "cursor:gpt-6-sol#high";
    const doc = applyPatch(defaultProfileDoc(), {
      roles: { worker: { rungs: [CURSOR], defaultRung: null } },
      failover: { [CURSOR]: "opencode:opencode-go/kimi-k3#max" },
    });
    const used = usedBackends([resolveProfile(doc, "p", "claude-code")]);
    expect(used.get("cursor")).toBe("role");
    expect(used.get("opencode")).toBe("failover");
  });
});
