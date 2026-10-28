import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { BUILTIN_ROLES } from "../../src/domain/profile.ts";
import { defaultDeps } from "../../src/entry/deps.ts";
import { indexPath } from "../../src/infra/paths.ts";
import { setupProbes, setupView, SetupViewSchema } from "../../src/services/panel-setup.ts";
import { probeCache } from "../../src/services/probe-cache.ts";
import { activate } from "../../src/services/profile-service.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

let repo: string;
// a profile without explicit architect rungs resolves only under a host
const deps = defaultDeps({ host: "codex", session: null, conflict: null });
beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  probeCache.clear();
  withHome();
  repo = tempRepo();
  process.env.PATH = "/nonexistent"; // no backend CLI is probed
});

describe("the panel's Setup view", () => {
  it("shows the profile, the catalog row, a row per backend and each role's ladder with the indexed pairs it may pick", async () => {
    const v = SetupViewSchema.parse(await setupView(deps, repo));
    expect([v.profile.name, v.catalog.id]).toEqual(["default", "catalog"]);
    expect(v.backends.map((b) => b.label)).toEqual(
      expect.arrayContaining(["codex", "opencode", "claude-code"]),
    );
    const w = v.roles.find((r) => r.role === "worker")!;
    expect(w.rungs.map((r) => r.rung)).toEqual(BUILTIN_ROLES.worker.rungs);
    expect(w.offered.map((o) => o.rung)).toContain("codex:gpt-6-sol#high");
    expect(w.offered.map((o) => o.rung)).not.toContain("codex:gpt-6-sol#ultra");
    expect(w.offered.map((o) => o.intelligence)).toEqual(
      w.offered.map((o) => o.intelligence).toSorted((a, b) => b - a),
    );
  });

  it("the settings carry landAutoMerge", async () => {
    expect(SetupViewSchema.parse(await setupView(deps, repo)).settings.landAutoMerge).toBe(false);
    deps.profiles.set(undefined, { land: { autoMerge: true } }, repo);
    expect(SetupViewSchema.parse(await setupView(deps, repo)).settings.landAutoMerge).toBe(true);
  });

  it("settings carry neither the decision model nor the bars", async () => {
    const { settings } = SetupViewSchema.parse(await setupView(deps, repo));
    for (const k of ["decision", "objective", "jev", "bars"]) expect(k in settings).toBe(false);
  });

  it("offers older versions too, each naming the newer one that hides it by default", async () => {
    const v = SetupViewSchema.parse(await setupView(deps, repo));
    const newer = (rung: string) =>
      v.roles.find((r) => r.role === "worker")!.offered.find((o) => o.rung === rung)?.newer;
    expect(newer("codex:gpt-6-sol#high")).toBe("GPT-6.1 Sol");
    expect(newer("codex:gpt-5.6-luna#high")).toBe("GPT-6 Luna");
    expect(newer("opencode:opencode/gpt-6-sol#high")).toBeNull();
    expect(newer("codex:gpt-6.1-sol#high")).toBeNull();
  });

  it("names the host, the repos bound, the resolved settings and the stored document", async () => {
    activate("default", repo, "codex");
    const v = SetupViewSchema.parse(await setupView(deps, repo));
    expect(v.host).toBe("codex");
    expect(v.repos).toEqual([{ path: repo, profile: "default" }]);
    expect(v.profile.bindings).toEqual({ [repo]: "default" });
    expect(v.settings.timeouts).toEqual({ idleMin: expect.any(Number), wallMin: expect.any(Number) });
    expect(v.doc).toEqual(deps.profiles.raw?.(undefined, repo) as Record<string, unknown>);
    expect(v.notifyUrl).toBeNull();
    const w = v.roles.find((r) => r.role === "worker")!;
    expect([w.access, w.network, w.timeouts]).toEqual(["workspace-write", true, null]);
    expect(v.probedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("answers without waiting for a probe that outlives the wait, and says a backend is still being checked", async () => {
    const real = setupProbes.probe;
    setupProbes.probe = (a, o) => (a.id === "codex" ? new Promise(() => {}) : real(a, o));
    setupProbes.waitMs = 0;
    try {
      const v = SetupViewSchema.parse(await setupView(deps, repo));
      expect(v.pending).toBe(true);
      expect(v.backends.find((b) => b.label === "codex")).toMatchObject({ state: "info", word: "checking" });
    } finally {
      setupProbes.probe = real;
      setupProbes.waitMs = 1500;
    }
    expect(SetupViewSchema.parse(await setupView(deps, repo)).pending).toBe(false);
  });

  it("does not probe a backend it shows as not required", async () => {
    const real = setupProbes.probe;
    const probed: string[] = [];
    setupProbes.probe = (a, o) => {
      probed.push(a.id);
      return real(a, o);
    };
    try {
      const v = SetupViewSchema.parse(await setupView(deps, repo));
      expect(v.backends.find((b) => b.label === "claude-code")).toMatchObject({ word: "not required" });
      expect(probed).not.toContain("claude-code");
      expect(probed).toContain("codex");
    } finally {
      setupProbes.probe = real;
    }
  });

  it("a second setup read probes no CLI", async () => {
    await setupView(deps, repo);
    const probes = probeCache.probes;
    await setupView(deps, repo);
    expect(probeCache.probes).toBe(probes);
  });

  it("a fresh read probes again", async () => {
    await setupView(deps, repo);
    const probes = probeCache.probes;
    await setupView(deps, repo, { fresh: true });
    expect(probeCache.probes).toBeGreaterThan(probes);
  });

  it("shows the catalog as not fetched, and offers nothing, with no index", async () => {
    rmSync(indexPath());
    const v = await setupView(deps, repo);
    expect(v.catalog.state).toBe("info");
    expect(v.roles.every((r) => r.offered.length === 0)).toBe(true);
  });
});

describe("the panel's Setup view on a host that is not known", () => {
  it("lists every role, showing the architect and verifier as set by the session's host", async () => {
    const bare = defaultDeps({ host: "unknown", session: null, conflict: null });
    const v = SetupViewSchema.parse(await setupView(bare, repo));
    const hostSet = v.roles.filter((r) => r.hostSet).map((r) => r.role);
    expect(hostSet).toEqual(["architect", "verifier"]);
    expect(v.roles.find((r) => r.role === "architect")?.rungs).toEqual([]);
    expect(v.roles.find((r) => r.role === "worker")?.rungs.map((r) => r.rung)).toEqual(
      BUILTIN_ROLES.worker.rungs,
    );
  });

  it("shows no role as set by the host when the host is known", async () => {
    const v = await setupView(deps, repo);
    expect(v.roles.some((r) => r.hostSet)).toBe(false);
  });
});
