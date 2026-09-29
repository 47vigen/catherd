import { afterEach, describe, expect, it } from "bun:test";
import { applyPatch, defaultProfileDoc, patchBetween, resolveProfile } from "../../../src/domain/profile.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHANGED_ON_DISK,
  liveEffects,
  memoRuns,
  type RunRow,
  stampOf,
  watchDirs,
} from "../../../src/entry/tui/effects.ts";
import { activate, createProfile, patchProfile } from "../../../src/services/profile-service.ts";
import { activeName } from "../../../src/services/profile-store.ts";
import type { Run } from "../../../src/services/run-store.ts";
import { snapshotEnv, tempRepo, withHome } from "../../helpers.ts";
import { fakeDispatch, freshRun, waitFor } from "../../services/helpers.ts";

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
  session: null,
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
  it("lists a run, and its session, and opens the session and a role (spec §4)", async () => {
    const { run } = freshRun("Jobs screen");
    const d = await fakeDispatch(run, {}, { proc: "self" });
    const fx = liveEffects();
    expect(fx.runs().rows).toEqual([
      expect.objectContaining({
        id: run.id,
        title: "Jobs screen",
        live: 1,
        landed: 0,
        budget: null,
        session: null,
      }),
    ]);
    expect(fx.sessions().rows).toEqual([
      expect.objectContaining({ key: null, name: "earlier runs", liveRoles: 1 }),
    ]);
    const s = fx.session(null);
    expect(s.dirs).toEqual([run.dir]);
    expect(s.runs[0]?.roles.map((r) => [r.name, r.live])).toEqual([["worker-M1.L1", true]]);
    expect(fx.role(run.id, d.admit.dispatchId)).toMatchObject({
      name: "worker-M1.L1",
      brief: "brief",
      record: null,
    });
  });

  it("watches run folders for any change below them, and gathers a burst into one call", async () => {
    const { run } = freshRun();
    let calls = 0;
    // the path the watch is given may pass through a symlink (macOS: /var is /private/var)
    const stop = watchDirs([run.dir], () => calls++);
    expect(stop).not.toBeNull();
    try {
      // the watch may start after watchDirs returns (FSEvents): touch a probe until it reports, once per wait
      const probe = join(run.dir, "probe");
      const end = Date.now() + 20_000;
      for (let i = 0; calls === 0; i++) {
        if (Date.now() > end) throw new Error("the watch never reported a change");
        writeFileSync(probe, String(i));
        await waitFor(() => calls > 0, 500).catch(() => null);
      }
      calls = 0;
      // only changes below the run folder, in a folder made after the watch started
      const nested = join(run.dir, "roles", "w", "2");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "events.jsonl"), "{}\n");
      writeFileSync(join(nested, "events.jsonl"), "{}\n{}\n");
      await waitFor(() => calls > 0, 10_000);
      expect(calls).toBe(1);
    } finally {
      stop?.();
    }
  }, 30_000);

  it("never calls after stop, even for an event already queued", () => {
    let listener: (() => void) | null = null;
    const timers: (() => void)[] = [];
    let calls = 0;
    const stop = watchDirs(["/runs/a"], () => calls++, {
      watch: (_dir, fire) => {
        listener = fire;
        return { on: () => {}, close: () => {} };
      },
      setTimeout: (f) => {
        timers.push(f);
        return timers.length;
      },
      clearTimeout: () => {},
      realpath: (d) => d,
    });
    expect(stop).not.toBeNull();
    listener!();
    listener!();
    expect(timers.length).toBe(1);
    stop?.();
    listener!();
    for (const t of timers) t();
    expect(calls).toBe(0);
    expect(timers.length).toBe(1);
  });

  it("watches the real path of a folder reached through a symlink", () => {
    const seen: string[] = [];
    watchDirs(["/tmp/link"], () => {}, {
      watch: (dir) => {
        seen.push(dir);
        return { on: () => {}, close: () => {} };
      },
      realpath: (d) => (d === "/tmp/link" ? "/private/tmp/real" : d),
    });
    expect(seen).toEqual(["/private/tmp/real"]);
  });

  it("cannot watch a folder that is not there: the screen polls instead", () => {
    expect(watchDirs(["/nonexistent/catherd-run"], () => {})).toBeNull();
  });

  it("saves the staged treat-likes and the patch through the services", async () => {
    withHome();
    const fx = liveEffects();
    const rung = "opencode:opencode/claude-haiku-4-5#high";
    const r = await fx.save(
      "default",
      { roles: { writer: { rungs: [rung] } } },
      { [rung]: "gpt-6-luna#high" },
    );
    expect(r.saved).toBe(true);
    expect(fx.readProfile("default").roles?.writer?.rungs).toEqual([rung]);
    expect(fx.profiles()).toEqual({ names: ["default"], active: "default", here: "default", repo: null });
    const { catalog } = fx.catalog({});
    expect(catalog.treatLike["claude-haiku-4-5#high"]).toEqual({
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

  it("writes no patch over a profile changed on disk since the preview read it (shown)", async () => {
    withHome();
    const fx = liveEffects();
    const shown = fx.readProfile("default");
    // another process, while the save's treat-like waits for the catalog lock
    patchProfile("default", { budget: { minutes: 30 } });
    const rung = "opencode:opencode/claude-haiku-4-5#high";
    const r = await fx.save(
      "default",
      { roles: { writer: { rungs: [rung] } } },
      { [rung]: "gpt-6-luna#high" },
      shown,
    );
    expect([r.saved, r.errors.map((e) => e.path)]).toEqual([false, [CHANGED_ON_DISK]]);
    expect(fx.readProfile("default").roles?.writer?.rungs).not.toEqual([rung]);
    expect(fx.readProfile("default").budget).toEqual({ minutes: 30 });
    const now = fx.readProfile("default");
    expect((await fx.save("default", { roles: { writer: { rungs: [rung] } } }, {}, now)).saved).toBe(true);
  });

  it("names the harnesses, the native agents and each rung's enforcement", () => {
    withHome();
    const fx = liveEffects();
    expect([...fx.harnesses].sort()).toEqual(["claude-code", "codex", "cursor", "grok", "opencode"]);
    const p = resolveProfile(defaultProfileDoc(), "default");
    expect(fx.agents(p)).toContain("catherd-default-architect-claude-opus-5-5-high");
    expect(fx.enforcement("codex:gpt-6-sol#high", "workspace-write")).toBe("enforced");
    expect(fx.enforcement("opencode:opencode-go/kimi-k3#max", "workspace-write")).toBe("advisory");
  });

  it("inside a repo bound to another profile, names it here and activates the scope it is given", () => {
    withHome();
    const repo = tempRepo();
    createProfile("cheap");
    createProfile("other");
    activate("cheap", repo);
    const fx = liveEffects(repo);
    expect(fx.profiles()).toMatchObject({ active: "default", here: "cheap", repo });
    fx.activate("other", repo);
    expect([activeName(repo), activeName()]).toEqual(["other", "default"]);
    // the scope the user confirmed, though this repo is bound: the global profile, the binding kept
    fx.activate("cheap", null);
    expect([activeName(repo), activeName()]).toEqual(["other", "cheap"]);
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
