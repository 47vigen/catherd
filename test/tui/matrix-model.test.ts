import { describe, expect, it } from "bun:test";
import { defaultProfile } from "../../src/profile/profile.ts";
import {
  enabledFailoverRungs,
  failoverOptions,
  isTicked,
  nextLock,
  readySet,
  type Row,
  rowId,
  rows,
  ticked,
  toggle,
  type Toggled,
  treatLikeOptions,
} from "../../src/tui/matrix-model.ts";
import { catalogFixture, NOT_READY, READY } from "./helpers.ts";

const c = catalogFixture();
const ready = readySet(READY);
const open = new Set(["role:worker", "model:worker:gpt-6-luna", "model:worker:gpt-6-sol"]);

function find(rs: Row[], id: string): Row {
  const r = rs.find((x) => rowId(x) === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

function profileOf(t: Toggled) {
  if (!("profile" in t)) throw new Error(JSON.stringify(t));
  return t.profile;
}

describe("matrix model", () => {
  it("lists one row per role, then objective, lock, budget, failover and the notify moments", () => {
    expect(rows(defaultProfile(), c, new Set()).map(rowId)).toEqual([
      "role:architect",
      "role:verifier",
      "role:worker",
      "role:reviewer",
      "role:ui-reviewer",
      "role:artist",
      "role:writer",
      "role:researcher",
      "objective",
      "lock",
      "budget:minutes",
      "budget:tokens",
      "budget:usd",
      "failover:gpt-6-luna#high",
      "failover:gpt-6-sol#high",
      "failover:gpt-6-sol#medium",
      "failover:gpt-6-sol#xhigh",
      "notify:milestone",
      "notify:finish",
      "notify:blocked",
    ]);
  });

  it("opens a role into capable models grouped by backend, with the harness toggle under each backend", () => {
    const ids = rows(defaultProfile(), c, new Set(["role:artist", "model:artist:gpt-6-sol"])).map(rowId);
    const i = ids.indexOf("role:artist");
    expect(ids.slice(i, i + 8)).toEqual([
      "role:artist",
      "backend:artist:codex",
      "harness:artist:codex",
      "model:artist:gpt-6-sol",
      "effort:artist:gpt-6-sol#medium",
      "effort:artist:gpt-6-sol#high",
      "effort:artist:gpt-6-sol#xhigh",
      "role:writer",
    ]);
  });

  it("puts no harness toggle under claude, and one under codex and under opencode", () => {
    const ids = rows(defaultProfile(), c, new Set(["role:worker"])).map(rowId);
    expect(ids.filter((id) => id.startsWith("harness:"))).toEqual([
      "harness:worker:codex",
      "harness:worker:opencode",
    ]);
    expect(ids.indexOf("harness:worker:codex")).toBe(ids.indexOf("backend:worker:codex") + 1);
  });

  it("never offers a model the role cannot use", () => {
    const models = rows(defaultProfile(), c, new Set(["role:ui-reviewer"]))
      .filter((r) => r.kind === "model")
      .map(rowId);
    expect(models).toEqual(["model:ui-reviewer:claude-opus-5-5", "model:ui-reviewer:gpt-6-sol"]);
  });

  it("filters models by id, case-insensitively, opening every role while it filters", () => {
    const models = rows(defaultProfile(), c, new Set(), "QWEN")
      .filter((r) => r.kind === "model")
      .map(rowId);
    expect(models).toEqual(
      ["architect", "verifier", "worker", "reviewer", "writer", "researcher"].map(
        (r) => `model:${r}:openrouter/qwen/qwen3-coder`,
      ),
    );
  });

  it("keeps the worker on, and turns any other role off and back on", () => {
    expect(toggle(defaultProfile(), c, { kind: "role", role: "worker" }, ready)).toEqual({
      refused: "The worker is always on.",
    });
    const off = profileOf(toggle(defaultProfile(), c, { kind: "role", role: "writer" }, ready));
    expect(off.roles.writer.enabled).toBe(false);
    expect(profileOf(toggle(off, c, { kind: "role", role: "writer" }, ready)).roles.writer.enabled).toBe(
      true,
    );
  });

  it("unticks an effort, drops the model with its last effort, and leaves the input alone", () => {
    const p = defaultProfile();
    const next = profileOf(toggle(p, c, find(rows(p, c, open), "effort:worker:gpt-6-luna#high"), ready));
    expect(next.roles.worker.models["gpt-6-luna"]).toBeUndefined();
    expect(p.roles.worker.models["gpt-6-luna"]).toEqual(["high"]);
  });

  it("ticks a scored effort back in catalog order", () => {
    const p = defaultProfile();
    const row = find(rows(p, c, open), "effort:worker:gpt-6-sol#high");
    const without = profileOf(toggle(p, c, row, ready));
    expect(without.roles.worker.models["gpt-6-sol"]).toEqual(["medium", "xhigh"]);
    expect(profileOf(toggle(without, c, row, ready)).roles.worker.models["gpt-6-sol"]).toEqual([
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("asks for a treat-like before it ticks an unscored effort, and ticks it once one exists", () => {
    const row = find(rows(defaultProfile(), c, open), "effort:worker:gpt-6-luna#xhigh");
    expect(toggle(defaultProfile(), c, row, ready)).toEqual({ needsTreatLike: "gpt-6-luna#xhigh" });
    const liked = { ...c, treatLike: { "gpt-6-luna#xhigh": "gpt-6-sol#high" } };
    expect(profileOf(toggle(defaultProfile(), liked, row, ready)).roles.worker.models["gpt-6-luna"]).toEqual([
      "high",
      "xhigh",
    ]);
  });

  it("refuses to tick on a backend that is not ready, but still unticks there", () => {
    const notReady = readySet(NOT_READY);
    expect([...notReady]).toEqual(["claude"]);
    const rs = rows(defaultProfile(), c, open);
    expect(toggle(defaultProfile(), c, find(rs, "effort:worker:gpt-6-sol#high"), notReady)).toHaveProperty(
      "profile",
    );
    expect(toggle(defaultProfile(), c, find(rs, "effort:worker:gpt-6-luna#xhigh"), notReady)).toEqual({
      refused: "codex is not ready yet.",
    });
  });

  it("flips a harness between native and isolated for the whole profile", () => {
    const p = defaultProfile();
    expect(p.harness.codex.isolated).toBe(false);
    const iso = profileOf(toggle(p, c, { kind: "harness", role: "worker", backend: "codex" }, ready));
    expect(iso.harness).toEqual({ codex: { isolated: true }, opencode: { isolated: false } });
    expect(isTicked(iso, { kind: "harness", role: "artist", backend: "codex" })).toBe(true);
  });

  it("flips the objective, cycles the lock slots, and toggles notify moments in order", () => {
    const p = defaultProfile();
    expect(profileOf(toggle(p, c, { kind: "objective" }, ready)).objective).toBe("speed");
    expect([nextLock("cpus/2", 4), nextLock(2, 4), nextLock(4, 4)]).toEqual([1, 3, "cpus/2"]);
    const quiet = profileOf(toggle(p, c, { kind: "notify", moment: "milestone" }, ready));
    expect(quiet.notify).toEqual(["finish", "blocked"]);
    expect(profileOf(toggle(quiet, c, { kind: "notify", moment: "milestone" }, ready)).notify).toEqual([
      "milestone",
      "finish",
      "blocked",
    ]);
  });

  it("offers only capable scored rungs as a treat-like", () => {
    expect(treatLikeOptions(c, "artist")).toEqual(["gpt-6-sol#medium", "gpt-6-sol#high", "gpt-6-sol#xhigh"]);
  });

  it("collects one failover row per enabled codex/opencode rung, unique and sorted", () => {
    expect(enabledFailoverRungs(defaultProfile(), c)).toEqual([
      "gpt-6-luna#high",
      "gpt-6-sol#high",
      "gpt-6-sol#medium",
      "gpt-6-sol#xhigh",
    ]);
  });

  it("drops a rung's failover row once no enabled role ticks it any more", () => {
    const p = structuredClone(defaultProfile());
    delete p.roles.writer.models["gpt-6-luna"];
    delete p.roles.researcher.models["gpt-6-luna"];
    p.roles.worker.models["gpt-6-luna"] = [];
    expect(enabledFailoverRungs(p, c)).not.toContain("gpt-6-luna#high");
  });

  it("offers a failover stand-in only from another backend", () => {
    expect(failoverOptions(c, "gpt-6-sol#medium")).toEqual([
      "claude-opus-5-5#high",
      "claude-opus-5-5#low",
      "claude-opus-5-5#medium",
    ]);
  });

  it("offers a treat-like rung as a failover stand-in too", () => {
    const liked = { ...c, treatLike: { "openrouter/qwen/qwen3-coder#high": "gpt-6-sol#medium" } };
    expect(failoverOptions(liked, "gpt-6-sol#medium")).toContain("openrouter/qwen/qwen3-coder#high");
  });

  it("leaves budget and failover rows for the caller's own editor, not toggle", () => {
    const p = defaultProfile();
    expect(toggle(p, c, { kind: "budget", field: "minutes" }, ready)).toEqual({ profile: p });
    expect(toggle(p, c, { kind: "failover", rung: "gpt-6-sol#medium" }, ready)).toEqual({ profile: p });
  });

  it("reports what is ticked", () => {
    const p = defaultProfile();
    expect(ticked(p, "worker")).toEqual([
      "gpt-6-luna#high",
      "gpt-6-sol#medium",
      "gpt-6-sol#high",
      "gpt-6-sol#xhigh",
    ]);
    expect(isTicked(p, { kind: "role", role: "writer" })).toBe(true);
  });
});
