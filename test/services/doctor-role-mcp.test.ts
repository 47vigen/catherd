import { describe, expect, it } from "bun:test";
import {
  applyPatch,
  defaultProfileDoc,
  type ProfilePatch,
  resolveProfile,
} from "../../src/domain/profile.ts";
import { validateProfile } from "../../src/domain/profile-rules.ts";
import { roleMcpChecks } from "../../src/services/doctor-role-mcp.ts";
import { withStandIns } from "../../src/services/standins.ts";
import { shipped } from "../domain/shipped.ts";

const profile = (patch: ProfilePatch = {}) =>
  resolveProfile(applyPatch(defaultProfileDoc(), patch), "p", "claude-code");
const isolated: ProfilePatch = { harness: { codex: { isolated: true }, "claude-code": { isolated: true } } };
const headless: ProfilePatch = { roles: { verifier: { rungs: ["claude-code:claude-opus-5-5#low"] } } };
const rows = (checks: ReturnType<typeof roleMcpChecks>) => checks.map((c) => [c.id, `${c.state} ${c.word}`]);

describe("doctor's role server rows (spec 1.5 plan 21, #42 findings 6, 8)", () => {
  it("covers only the profile it is given, one row per backend that runs a role server, isolated or not", () => {
    expect(roleMcpChecks(null)).toEqual([]);
    const expected = [
      ["role-mcp:p:codex", "info configured"],
      ["role-mcp:p:claude-code", "info configured"],
    ];
    expect(rows(roleMcpChecks(profile(headless)))).toEqual(expected);
    // isolation used to fail this row, or skip it: the role server goes in either way now
    expect(rows(roleMcpChecks(profile({ ...headless, ...isolated })))).toEqual(expected);
  });

  it("says how long a cold start took, warns past half of Codex's 30 s, and fails a server that does not start", () => {
    const [ok] = roleMcpChecks(profile(), { ok: true, ms: 412.4 });
    expect(ok).toMatchObject({ state: "info", word: "configured" });
    expect(ok?.detail).toEndWith("Starts in 412 ms (limit 30 s).");
    expect(roleMcpChecks(profile(), { ok: true, ms: 16_000 })[0]).toMatchObject({
      state: "warn",
      word: "slow start",
      detail: "the role server took 16000 ms to start; Codex gives it 30 s and stops the role when it misses",
    });
    expect(roleMcpChecks(profile(), { ok: false, error: "no answer in 30000 ms" })[0]).toMatchObject({
      state: "fail",
      word: "no start",
      detail: "the role server did not start: no answer in 30000 ms",
    });
  });

  it("profile validate says nothing about isolation and the role server", () => {
    const check = (patch: ProfilePatch) =>
      validateProfile(
        profile(patch),
        withStandIns(shipped()),
        ["codex", "claude-code", "opencode", "claude"],
        undefined,
        "claude-code",
      );
    expect(check({ ...headless, ...isolated })).toEqual(check(headless));
  });
});
