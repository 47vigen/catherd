import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { CatherdError } from "../../src/domain/errors.ts";
import { BUILTIN_ROLES } from "../../src/domain/profile.ts";
import { defaultDeps } from "../../src/entry/deps.ts";
import { indexPath } from "../../src/infra/paths.ts";
import { orderRungs, setRoleRungs, setupView, SetupViewSchema } from "../../src/services/panel-setup.ts";
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
      expect.arrayContaining(["codex", "opencode", "claude-code", "cursor"]),
    );
    const w = v.roles.find((r) => r.role === "worker")!;
    expect(w.rungs.map((r) => r.rung)).toEqual(BUILTIN_ROLES.worker.rungs);
    expect(w.offered.map((o) => o.rung)).toContain("codex:gpt-6-sol#high");
    expect(w.offered.map((o) => o.rung)).not.toContain("codex:gpt-6-sol#ultra");
    expect(w.offered.map((o) => o.intelligence)).toEqual(
      w.offered.map((o) => o.intelligence).toSorted((a, b) => b - a),
    );
  });

  it("names the host, the repos bound, the resolved settings and the stored document", async () => {
    activate("default", repo, "codex");
    const v = SetupViewSchema.parse(await setupView(deps, repo));
    expect(v.host).toBe("codex");
    expect(v.repos).toEqual([{ path: repo, profile: "default" }]);
    expect(v.profile.bindings).toEqual({ [repo]: "default" });
    expect(v.settings.objective).toBe("cost");
    expect(v.settings.bars).toEqual({ copy: 20, build: 45, logic: 60, hard: 65 });
    expect(v.settings.timeouts).toEqual({ idleMin: expect.any(Number), wallMin: expect.any(Number) });
    expect(v.doc).toEqual(deps.profiles.raw?.(undefined, repo) as Record<string, unknown>);
    expect(v.notifyUrl).toBeNull();
    const w = v.roles.find((r) => r.role === "worker")!;
    expect([w.access, w.network, w.timeouts]).toEqual(["workspace-write", true, null]);
    expect(v.probedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
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

  it("orders picked rungs by rising intelligence, ties in the profile's order, then the pick order", () => {
    const intel: Record<string, number | null> = { a: 30, b: 40, c: 40, d: null };
    expect(orderRungs(["d", "c", "b", "a", "a"], ["b", "c"], (r) => intel[r] ?? null)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("saves a role's rungs through the profile service, in ladder order", () => {
    expect(
      setRoleRungs(deps, repo, "reviewer", ["codex:gpt-6-sol#xhigh", "codex:gpt-6-sol#high"]).saved,
    ).toBe(true);
    expect(deps.profiles.get(undefined, repo).profile.roles.reviewer?.rungs).toEqual([
      "codex:gpt-6-sol#high",
      "codex:gpt-6-sol#xhigh",
    ]);
  });

  it("refuses an unindexed pair with the profile service's own error, saving nothing", () => {
    const s = setRoleRungs(deps, repo, "reviewer", ["codex:gpt-6-sol#ultra"]);
    expect([s.saved, s.errors[0]?.message.includes("has no Slopalytics intelligence index")]).toEqual([
      false,
      true,
    ]);
  });

  it("shows the catalog as not fetched, and offers nothing, with no index", async () => {
    rmSync(indexPath());
    const v = await setupView(deps, repo);
    expect(v.catalog.state).toBe("info");
    expect(v.roles.every((r) => r.offered.length === 0)).toBe(true);
  });
});

describe("the panel's Setup view on a host that is not known", () => {
  it("lists every role, showing the architect, verifier and judge as set by the session's host", async () => {
    const bare = defaultDeps({ host: "unknown", session: null, conflict: null });
    const v = SetupViewSchema.parse(await setupView(bare, repo));
    const hostSet = v.roles.filter((r) => r.hostSet).map((r) => r.role);
    expect(hostSet).toEqual(["architect", "verifier", "judge"]);
    expect(v.roles.find((r) => r.role === "architect")?.rungs).toEqual([]);
    expect(v.roles.find((r) => r.role === "worker")?.rungs.map((r) => r.rung)).toEqual(
      BUILTIN_ROLES.worker.rungs,
    );
  });

  it("refuses a save with a fix instead of a validation error, and writes nothing", () => {
    const bare = defaultDeps({ host: "unknown", session: null, conflict: null });
    const err = (() => {
      try {
        setRoleRungs(bare, repo, "worker", ["codex:gpt-6-sol#high"]);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(CatherdError);
    expect((err as CatherdError).code).toBe("E_INPUT_INVALID");
    expect((err as CatherdError).fix).toContain("--host codex|claude-code");
    expect((err as CatherdError).fix).toContain("catherd init");
    expect(bare.profiles.raw?.(undefined, repo).roles?.worker?.rungs).toEqual(BUILTIN_ROLES.worker.rungs);
  });

  it("saves on the host init recorded, as the panel resolves it", () => {
    const stored = defaultDeps({ host: "claude-code", session: null, conflict: null });
    expect(setRoleRungs(stored, repo, "reviewer", ["codex:gpt-6-sol#high"]).saved).toBe(true);
  });

  it("shows no role as set by the host when the host is known", async () => {
    const v = await setupView(deps, repo);
    expect(v.roles.some((r) => r.hostSet)).toBe(false);
  });
});
