import type { RunModel, RunModelPatch } from "../../../../client";
import { applyPatch } from "./apply-patch";
import { CASE_HELPERS } from "./case-helpers.fixture";

const model = CASE_HELPERS as RunModel;
const [first, second] = model.nodes;

test("replaces changed nodes, drops removed ones and keeps the edges when null", () => {
  const changed = { ...first!, status: "running" as const, now: "Working" };
  const added = { ...first!, id: "M9/new", title: "new step", attempts: [] };
  const patch: RunModelPatch = {
    seq: model.seq + 1,
    phase: "running",
    outcome: null,
    nodes: [changed, added],
    removed: [second!.id],
    edges: null,
  };
  const next = applyPatch(model, patch);
  expect(next.seq).toBe(model.seq + 1);
  expect(next.phase).toBe("running");
  expect(next.outcome).toBeNull();
  expect(next.nodes[0]).toBe(changed);
  expect(next.nodes.some((n) => n.id === second!.id)).toBe(false);
  expect(next.nodes.at(-1)).toBe(added);
  expect(next.nodes).toHaveLength(model.nodes.length);
  expect(next.edges).toBe(model.edges);
  expect(applyPatch(model, { ...patch, edges: [] }).edges).toEqual([]);
});

test("an older patch changes nothing", () => {
  const patch: RunModelPatch = {
    seq: model.seq,
    phase: "ended",
    outcome: "failed",
    nodes: [],
    removed: [first!.id],
    edges: [],
  };
  expect(applyPatch(model, patch)).toBe(model);
  expect(applyPatch(model, { ...patch, seq: model.seq - 3 })).toBe(model);
});

test("a patched node's dispatch attempt replaces its entry in the dispatch list", () => {
  const owner = model.nodes.find((n) => n.attempts.some((a) => a.kind === "dispatch"))!;
  const attempt = owner.attempts.find((a) => a.kind === "dispatch")!;
  const moved = { ...attempt, status: "failed" as const };
  const next = applyPatch(model, {
    seq: model.seq + 1,
    phase: model.phase,
    outcome: model.outcome,
    nodes: [{ ...owner, attempts: owner.attempts.map((a) => (a.id === attempt.id ? moved : a)) }],
    removed: [],
    edges: null,
  });
  expect(next.dispatches.find((d) => d.id === attempt.id)).toBe(moved);
  expect(next.dispatches).toHaveLength(model.dispatches.length);
});
