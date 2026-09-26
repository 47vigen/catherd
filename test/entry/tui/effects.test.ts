import { afterEach, describe, expect, it } from "bun:test";
import { applyPatch, defaultProfileDoc, patchBetween, resolveProfile } from "../../../src/domain/profile.ts";
import { liveEffects, memoRuns, type RunRow, stampOf } from "../../../src/entry/tui/effects.ts";
import { activate, activeName, createProfile, patchProfile } from "../../../src/services/profile-service.ts";
import { appendRoute, type Run } from "../../../src/services/run-store.ts";
import { snapshotEnv, tempRepo, withHome } from "../../helpers.ts";
import { freshRun } from "../../services/helpers.ts";

afterEach(snapshotEnv());

const row = (id: string, live = 0): RunRow => ({
  id,
  title: id,
  repo: "/r",
  createdAt: "2026-09-26T00:00:00.000Z",
  live,
  roleRuns: 0,
  landed: 0,
  budget: null,
});

describe("the run list's memo (spec §9.4: memoised by mtime)", () => {
  it("computes a run again only when its files changed or a role is live", () => {
    const stamps = new Map([
      ["/a", "1"],
      ["/b", "1"],
    ]);
    const computed: string[] = [];
    const live = new Set<string>();
    const rows = memoRuns(
      (r) => {
        computed.push(r.id);
        return row(r.id, live.has(r.id) ? 1 : 0);
      },
      (dir) => stamps.get(dir) as string,
    );
    const runs = [
      { id: "a", dir: "/a" },
      { id: "b", dir: "/b" },
    ] as Run[];
    rows(runs);
    rows(runs);
    expect(computed).toEqual(["a", "b"]);
    // a dispatch starting writes into roles/, so a run that turns live changes its stamp too
    stamps.set("/a", "2");
    stamps.set("/b", "2");
    live.add("b");
    rows(runs);
    rows(runs);
    expect(computed).toEqual(["a", "b", "a", "b", "b"]);
  });
});

describe("the live effects", () => {
  it("lists a run and reads its climbs and route decisions", () => {
    const { run } = freshRun("Jobs screen");
    const at = new Date().toISOString();
    const base = {
      at,
      lane: "M1.L1",
      role: "worker" as const,
      ladder: ["codex:gpt-6-luna#high", "codex:gpt-6-sol#medium"],
      kind: "repo_code" as const,
      difficulty: "build" as const,
    };
    appendRoute(run, {
      ...base,
      rung: "codex:gpt-6-luna#high",
      source: "route",
      decidedBy: "lane",
      from: null,
      reason: null,
    });
    appendRoute(run, {
      ...base,
      rung: "codex:gpt-6-sol#medium",
      source: "climb",
      decidedBy: "lane",
      from: "codex:gpt-6-luna#high",
      reason: "refused",
    });
    const fx = liveEffects();
    const { rows } = fx.runs();
    expect(rows).toEqual([
      expect.objectContaining({ id: run.id, title: "Jobs screen", live: 0, landed: 0, budget: null }),
    ]);
    const d = fx.run(run.id);
    expect(d.climbs).toEqual([
      {
        lane: "M1.L1",
        from: "codex:gpt-6-luna#high",
        to: "codex:gpt-6-sol#medium",
        reason: "refused",
        env: false,
      },
    ]);
    expect(d.decisions).toEqual([
      {
        lane: "M1.L1",
        role: "worker",
        source: "lane",
        kind: "repo_code",
        difficulty: "build",
        rung: "codex:gpt-6-luna#high",
      },
    ]);
  });

  it("saves the staged treat-likes and the patch through the services", async () => {
    withHome();
    const fx = liveEffects();
    const rung = "opencode:opencode-go/gpt-6-luna#xhigh";
    const r = await fx.save(
      "default",
      { roles: { writer: { rungs: [rung] } } },
      { [rung]: "gpt-6-luna#high" },
    );
    expect(r.saved).toBe(true);
    expect(fx.readProfile("default").roles?.writer?.rungs).toEqual([rung]);
    expect(fx.profiles()).toEqual({ names: ["default"], active: "default", here: "default", repo: null });
    const { catalog } = fx.catalog({});
    expect(catalog.treatLike["gpt-6-luna#xhigh"]).toEqual({
      like: "gpt-6-luna#high",
      source: "user",
    });
  });

  it("saves a draft's patch over a profile that changed on disk since, keeping that change", async () => {
    withHome();
    const fx = liveEffects();
    const base = fx.readProfile("default");
    patchProfile("default", { budget: { minutes: 30 } });
    const mine = applyPatch(base, { objective: "speed" });
    expect((await fx.save("default", patchBetween(base, mine), {})).saved).toBe(true);
    expect([fx.readProfile("default").objective, fx.readProfile("default").budget]).toEqual([
      "speed",
      { minutes: 30 },
    ]);
  });

  it("names the harnesses, the native agents and each rung's enforcement", () => {
    withHome();
    const fx = liveEffects();
    expect([...fx.harnesses].sort()).toEqual(["claude-code", "codex", "opencode"]);
    const p = resolveProfile(defaultProfileDoc(), "default");
    expect(fx.agents(p)).toContain("catherd-default-architect-claude-opus-5-5-high");
    expect(fx.enforcement("codex:gpt-6-sol#high", "workspace-write")).toBe("enforced");
    expect(fx.enforcement("opencode:opencode-go/kimi-k3#max", "workspace-write")).toBe("advisory");
  });

  it("inside a repo bound to another profile, names it here and binds the repo on activate", () => {
    withHome();
    const repo = tempRepo();
    createProfile("cheap");
    createProfile("other");
    activate("cheap", repo);
    const fx = liveEffects(repo);
    expect(fx.profiles()).toMatchObject({ active: "default", here: "cheap", repo });
    fx.activate("other");
    expect([activeName(repo), activeName()]).toEqual(["other", "default"]);
    liveEffects(tempRepo()).activate("other");
    expect(activeName()).toBe("other");
  });

  it("stamps a run again when a profile is saved or another profile is made active", () => {
    withHome();
    const { run } = freshRun();
    createProfile("cheap");
    const before = stampOf(run.dir);
    activate("cheap");
    const afterActivate = stampOf(run.dir);
    expect(afterActivate).not.toBe(before);
    patchProfile("cheap", { objective: "speed" });
    expect(stampOf(run.dir)).not.toBe(afterActivate);
  });
});
