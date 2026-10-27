import { describe, expect, it } from "bun:test";
import { applyPatch, defaultProfileDoc, resolveProfile } from "../../src/domain/profile.ts";
import { usedBackends } from "../../src/services/doctor-backends.ts";

describe("usedBackends (spec 1.3 §7.3)", () => {
  it("counts a profile's stand-in as failover use, so a missing one is not an unused skip", () => {
    const SOL = "codex:gpt-6-sol#high";
    const doc = applyPatch(defaultProfileDoc(), {
      roles: { worker: { rungs: [SOL], defaultRung: null } },
      failover: { [SOL]: "opencode:opencode-go/kimi-k3#max" },
    });
    const used = usedBackends([resolveProfile(doc, "p", "claude-code")]);
    expect(used.get("codex")).toBe("role");
    expect(used.get("opencode")).toBe("failover");
  });
});
